// src/sockets/syncGateway.js
import { Server as SocketIOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { RedisService } from '../services/redisService.js';
import { AuthService } from '../services/authService.js';
import {
    RoomNotFoundError,
    SyncDomainService,
} from '../services/syncDomainService.js';
import { decideCorrection } from '../utils/driftLogic.js';
import { Metrics } from '../utils/metrics.js';
import { pubClient, subClient } from '../config/redis.js';
import { enforceRoomRateLimit } from '../utils/rateLimiter.js';
import { withWsRequestId, getRequestId } from '../utils/requestLogger.js';
import { toArray } from '../utils/toArray.js';

const CONTROL_CHANNEL_PATTERN = 'room:*:control';
const roomChannel = (roomId) => `room:${roomId}`;

const isValidRoomId = (roomId) =>
    typeof roomId === 'string' && roomId.trim().length > 0;

const AUTH_BYPASS = process.env.AUTH_BYPASS === 'true';

const CONTROL_LIMITS = {
    play: { max: 3, windowMs: 1000 },
    pause: { max: 5, windowMs: 1000 },
    seek: { max: 8, windowMs: 1000 },
    changeTrack: { max: 3, windowMs: 1000 },
};

const extractRoomIdFromChannel = (channel) => {
    if (!channel) {
        return null;
    }
    const parts = channel.split(':');
    if (parts.length < 3) {
        return null;
    }
    return parts.slice(1, -1).join(':');
};

const getLocalRoomSize = (io, roomId) =>
    io.sockets.adapter.rooms.get(roomChannel(roomId))?.size || 0;

const emitControlError = (socket, action, roomId, error) => {
    socket.emit('controlError', {
        action,
        roomId,
        error,
    });
};

/**
 * Maneja un comando de control (play, pause, seek, changeTrack)
 * - Valida payload
 * - Aplica rate limit por sala
 * - Verifica permisos contra queue-service (AuthService.ensureCanControlPlayback)
 * - Ejecuta la operación de dominio
 */
const handleControlCommand = async ({
                                        action,
                                        socket,
                                        roomId,
                                        payloadValidator,
                                        domainCall,
                                    }) => {
    if (!payloadValidator()) {
        emitControlError(socket, action, roomId, 'invalid_param');
        return;
    }

    const limits = CONTROL_LIMITS[action];
    if (limits) {
        const allowed = await enforceRoomRateLimit(
            roomId,
            action,
            limits.max,
            limits.windowMs,
        );
        if (!allowed) {
            emitControlError(socket, action, roomId, 'rate_limited');
            return;
        }
    }

    // 🔐 Resolución de permisos: queue-service vía AuthService
    let effectiveUserId = socket.userId;

    if (!socket.data?.accessToken && AUTH_BYPASS) {
        // Modo DEV: dejamos pasar, pero avisamos en logs
        console.warn(
            '[handleControlCommand] AUTH_BYPASS enabled, skipping permission check',
            {
                action,
                roomId,
                socketId: socket.id,
                userId: socket.userId,
            },
        );
    } else {
        try {
            const membership = await AuthService.ensureCanControlPlayback({
                accessToken: socket.data?.accessToken,
                roomId,
            });

            // Tomamos el user_id real de room_members como userId efectivo
            effectiveUserId =
                membership.user_id || membership.userId || socket.userId;
        } catch (err) {
            console.warn('[handleControlCommand] permission denied/error', {
                action,
                roomId,
                socketId: socket.id,
                error: err.message,
                code: err.code,
            });

            // Mapeo de códigos de error → mensajes simples para el cliente
            switch (err.code) {
                case 'MEMBERSHIP_NOT_FOUND':
                    emitControlError(
                        socket,
                        action,
                        roomId,
                        'membership_not_found',
                    );
                    return;
                case 'ROOM_CONTROL_FORBIDDEN':
                case 'FORBIDDEN':
                    emitControlError(socket, action, roomId, 'forbidden');
                    return;
                case 'UNAUTHORIZED':
                    emitControlError(socket, action, roomId, 'unauthorized');
                    return;
                case 'QUEUE_SERVICE_UNAVAILABLE':
                    emitControlError(
                        socket,
                        action,
                        roomId,
                        'upstream_unavailable',
                    );
                    return;
                default:
                    emitControlError(socket, action, roomId, 'internal_error');
                    return;
            }
        }
    }

    try {
        const result = await domainCall(effectiveUserId);
        socket.emit('controlAck', {
            action,
            roomId,
            version: result?.version ?? null,
        });
    } catch (error) {
        if (error instanceof RoomNotFoundError) {
            emitControlError(socket, action, roomId, 'room_not_found');
            return;
        }
        if (error?.message === 'invalid_track') {
            emitControlError(socket, action, roomId, 'invalid_track');
            return;
        }

        console.error(`Failed to process control action ${action}`, {
            roomId,
            userId: effectiveUserId,
            error,
        });
        emitControlError(socket, action, roomId, 'internal_error');
    }
};

export async function handleDriftReport(socket, payload = {}) {
    const {
        roomId,
        localPositionMs,
        observedServerPositionMs,
        observedServerTimeMs,
        jitterMs = 0,
        clientLagMs = 0,
    } = payload;

    if (!isValidRoomId(roomId)) {
        return;
    }

    const nowServerMs = Date.now();

    const decision = decideCorrection({
        localPositionMs,
        observedServerPositionMs,
        observedServerTimeMs,
        nowServerMs,
        jitterMs,
        clientLagMs,
    });

    if (Number.isFinite(decision.driftMs)) {
        Metrics.recordDrift(roomId, decision.driftMs);
    }

    if (decision.action === 'ignore') {
        return;
    }

    if (decision.action === 'rate') {
        Metrics.recordRateAdjust(roomId);
        socket.emit('rateAdjust', {
            ...decision.payload,
            driftMs: decision.driftMs,
            serverTimeMs: nowServerMs,
        });
        return;
    }

    if (decision.action === 'seek') {
        const state = await RedisService.getRoomState(roomId);
        Metrics.recordSeek(roomId);
        socket.emit('seek', {
            ...decision.payload,
            version: state?.version ?? (await RedisService.getVersion(roomId)),
            driftMs: decision.driftMs,
        });
    }
}

export function initSyncGateway(httpServer, { cors } = {}) {
    // ✅ CORS por defecto para Socket.IO
    const defaultCors = {
        origin: toArray(process.env.CORS_ORIGIN) || '*',
        methods: ['GET', 'POST'],
        credentials: false, // clave: no usamos cookies en el socket
    };

    const finalCors = {
        ...defaultCors,
        ...(cors || {}),
        credentials: false,
    };

    const io = new SocketIOServer(httpServer, { cors: finalCors });
    const activeRooms = new Set();

    let controlUnsubscribe = null;
    let syncInterval = null;
    let handlersRegistered = false;

    const ensureRoomActive = (roomId) => {
        if (isValidRoomId(roomId)) {
            activeRooms.add(roomId);
        }
    };

    const cleanupRoomIfEmpty = (roomId) => {
        if (!isValidRoomId(roomId)) {
            return;
        }

        const localSize = getLocalRoomSize(io, roomId);
        if (localSize === 0) {
            activeRooms.delete(roomId);
        }
    };

    const emitSyncPackets = async () => {
        if (!activeRooms.size) {
            return;
        }

        const now = Date.now();
        for (const roomId of Array.from(activeRooms)) {
            const localSize = getLocalRoomSize(io, roomId);
            if (!localSize) {
                cleanupRoomIfEmpty(roomId);
                continue;
            }

            try {
                const state = await RedisService.getRoomState(roomId);
                if (!state) {
                    activeRooms.delete(roomId);
                    continue;
                }

                const positionMs = Math.floor(
                    RedisService.computeCurrentPosition(state, now),
                );

                io.to(roomChannel(roomId)).emit('syncPacket', {
                    roomId,
                    serverTimeMs: now,
                    playbackState: state.playbackState || 'paused',
                    positionMs,
                    trackId: state.trackId ?? null,
                    version: state.version ?? 0,
                });

                if (state.version % 30 === 0 || state.version < 3) {
                    console.log('[syncGateway] syncPacket', {
                        roomId,
                        users: localSize,
                        state: state.playbackState,
                        version: state.version,
                    });
                }
            } catch (error) {
                console.error(
                    `Failed to emit syncPacket for room ${roomId}`,
                    error,
                );
            }
        }
    };

    const startSyncLoop = () => {
        if (syncInterval) {
            clearInterval(syncInterval);
        }
        syncInterval = setInterval(() => {
            emitSyncPackets().catch((error) => {
                console.error('Error running sync loop', error);
            });
        }, 1000);
    };

    const stopSyncLoop = () => {
        if (syncInterval) {
            clearInterval(syncInterval);
            syncInterval = null;
        }
    };

    const forwardControlMessage = async (message = {}, channel) => {
        const roomId = message?.roomId || extractRoomIdFromChannel(channel);
        if (!isValidRoomId(roomId)) {
            return;
        }

        ensureRoomActive(roomId);

        const eventName = message?.type || message?.event || 'control';
        const payload = message?.payload ?? {};

        io.to(roomChannel(roomId)).emit(eventName, {
            roomId,
            ...payload,
        });
    };

    const registerSocketHandlers = (socket) => {
        // 🔐 Nuevo flujo de auth:
        // - Tomamos accessToken del handshake (socket.handshake.auth.token / accessToken)
        // - Lo usamos en AuthService.ensureCanControlPlayback (queue-service + Cognito)
        const rawAuth = socket.handshake.auth || {};
        const accessToken =
            rawAuth.token || rawAuth.accessToken || null;

        if (!accessToken && !AUTH_BYPASS) {
            console.warn('[syncGateway] missing token, disconnecting socket', {
                socketId: socket.id,
            });
            socket.emit('authError', { error: 'missing_token' });
            socket.disconnect(true);
            return;
        }

        socket.data.accessToken = accessToken;

        // userId lógico solo para logs / métricas.
        // En las operaciones de control usamos el user_id real devuelto por queue-service.
        const resolvedUserId =
            rawAuth.userId ||
            socket.handshake.query?.userId ||
            `u-${socket.id}`;

        socket.userId = resolvedUserId;
        socket.data.userId = resolvedUserId;
        socket.joinedRooms = new Set();

        socket.on(
            'joinRoom',
            withWsRequestId(({ roomId } = {}) => {
                if (!isValidRoomId(roomId)) {
                    return;
                }

                const channel = roomChannel(roomId);
                socket.join(channel);
                socket.joinedRooms.add(roomId);

                ensureRoomActive(roomId);
                Metrics.userJoin(roomId, socket.userId);

                const roomSize = getLocalRoomSize(io, roomId);
                console.log('[syncGateway] user_joined_room', {
                    requestId: getRequestId(),
                    socketId: socket.id,
                    roomId,
                    userId: socket.userId,
                    roomSize,
                });

                try {
                    io.to(channel).emit('roomUserJoin', {
                        roomId,
                        userId: socket.userId,
                    });
                } catch (emitError) {
                    console.warn(
                        '[syncGateway] failed to emit roomUserJoin',
                        {
                            requestId: getRequestId(),
                            roomId,
                            userId: socket.userId,
                            error: emitError.message,
                        },
                    );

                    socket.emit('roomUserJoin', {
                        roomId,
                        userId: socket.userId,
                    });
                }
            }),
        );

        socket.on(
            'leaveRoom',
            withWsRequestId(({ roomId } = {}) => {
                if (!isValidRoomId(roomId)) {
                    return;
                }

                const channel = roomChannel(roomId);

                socket.leave(channel);
                socket.joinedRooms.delete(roomId);

                Metrics.userLeave(roomId, socket.userId);

                const roomSize = getLocalRoomSize(io, roomId);
                console.log('[syncGateway] user_left_room', {
                    requestId: getRequestId(),
                    socketId: socket.id,
                    roomId,
                    userId: socket.userId,
                    roomSize,
                });

                try {
                    io.to(channel).emit('roomUserLeave', {
                        roomId,
                        userId: socket.userId,
                    });
                } catch (emitError) {
                    console.warn(
                        '[syncGateway] failed to emit roomUserLeave',
                        {
                            requestId: getRequestId(),
                            roomId,
                            userId: socket.userId,
                            error: emitError.message,
                        },
                    );
                }

                cleanupRoomIfEmpty(roomId);
            }),
        );

        socket.on(
            'heartbeat',
            withWsRequestId(({ roomId } = {}) => {
                if (!isValidRoomId(roomId)) {
                    return;
                }

                ensureRoomActive(roomId);
                socket.emit('heartbeatAck', {
                    roomId,
                    serverTimeMs: Date.now(),
                });
            }),
        );

        socket.on(
            'driftReport',
            withWsRequestId((payload = {}) => {
                handleDriftReport(socket, payload).catch((error) => {
                    console.error('[syncGateway] drift_report_error', {
                        requestId: getRequestId(),
                        socketId: socket.id,
                        userId: socket.userId,
                        error: error.message,
                    });
                });
            }),
        );

        // PLAY
        socket.on(
            'play',
            withWsRequestId(
                async ({ roomId, trackId, startPositionMs } = {}) => {
                    await handleControlCommand({
                        action: 'play',
                        socket,
                        roomId,
                        payloadValidator: () =>
                            isValidRoomId(roomId) &&
                            typeof trackId === 'string' &&
                            trackId.trim().length > 0,
                        domainCall: (userId) =>
                            SyncDomainService.play({
                                roomId,
                                userId,
                                trackId: trackId.trim(),
                                startPositionMs:
                                    typeof startPositionMs === 'number'
                                        ? startPositionMs
                                        : 0,
                            }),
                    });
                },
            ),
        );

        // PAUSE
        socket.on(
            'pause',
            withWsRequestId(async ({ roomId } = {}) => {
                await handleControlCommand({
                    action: 'pause',
                    socket,
                    roomId,
                    payloadValidator: () => isValidRoomId(roomId),
                    domainCall: (userId) =>
                        SyncDomainService.pause({
                            roomId,
                            userId,
                        }),
                });
            }),
        );

        // SEEK
        socket.on(
            'seek',
            withWsRequestId(async ({ roomId, positionMs } = {}) => {
                await handleControlCommand({
                    action: 'seek',
                    socket,
                    roomId,
                    payloadValidator: () =>
                        isValidRoomId(roomId) &&
                        typeof positionMs === 'number' &&
                        Number.isFinite(positionMs) &&
                        positionMs >= 0,
                    domainCall: (userId) =>
                        SyncDomainService.seek({
                            roomId,
                            userId,
                            positionMs,
                        }),
                });
            }),
        );

        // CHANGE TRACK
        socket.on(
            'changeTrack',
            withWsRequestId(
                async ({ roomId, trackId, startPositionMs } = {}) => {
                    await handleControlCommand({
                        action: 'changeTrack',
                        socket,
                        roomId,
                        payloadValidator: () =>
                            isValidRoomId(roomId) &&
                            typeof trackId === 'string' &&
                            trackId.trim().length > 0,
                        domainCall: (userId) =>
                            SyncDomainService.changeTrack({
                                roomId,
                                userId,
                                trackId: trackId.trim(),
                                startPositionMs:
                                    typeof startPositionMs === 'number'
                                        ? startPositionMs
                                        : 0,
                            }),
                    });
                },
            ),
        );

        socket.on(
            'disconnect',
            withWsRequestId(async () => {
                const rooms = Array.from(socket.joinedRooms);

                console.log('[syncGateway] user_disconnected', {
                    requestId: getRequestId(),
                    socketId: socket.id,
                    userId: socket.userId,
                    roomCount: rooms.length,
                });

                for (const roomId of rooms) {
                    Metrics.userLeave(roomId, socket.userId);

                    try {
                        io.to(roomChannel(roomId)).emit('roomUserLeave', {
                            roomId,
                            userId: socket.userId,
                        });
                    } catch (emitError) {
                        console.warn(
                            '[syncGateway] failed to emit roomUserLeave on disconnect',
                            {
                                requestId: getRequestId(),
                                roomId,
                                userId: socket.userId,
                                error: emitError.message,
                            },
                        );
                    }

                    const localSize = getLocalRoomSize(io, roomId);
                    if (!localSize) {
                        cleanupRoomIfEmpty(roomId);
                    }
                }

                socket.joinedRooms.clear();
            }),
        );
    };

    const initialize = async () => {
        try {
            await Promise.race([
                Promise.all([
                    pubClient.isOpen ? Promise.resolve() : pubClient.connect(),
                    subClient.isOpen ? Promise.resolve() : subClient.connect(),
                ]),
                new Promise((_, reject) =>
                    setTimeout(
                        () =>
                            reject(
                                new Error('Redis connection timeout (10s)'),
                            ),
                        10000,
                    ),
                ),
            ]);

            io.adapter(createAdapter(pubClient, subClient));
            console.log(
                '[syncGateway] Redis adapter initialized for multi-instance deployment',
            );
        } catch (error) {
            console.error(
                '[syncGateway] Redis adapter initialization failed',
                {
                    error: error.message,
                },
            );

            if (process.env.ALLOW_SINGLE_NODE === 'true') {
                console.warn(
                    '[syncGateway] Running in SINGLE-NODE mode (no Redis adapter)',
                );
                console.warn(
                    '[syncGateway] Multi-instance deployment will NOT work correctly',
                );
            } else {
                throw error;
            }
        }

        if (!handlersRegistered) {
            io.on('connection', registerSocketHandlers);
            handlersRegistered = true;
        }

        controlUnsubscribe = await RedisService.subscribe(
            CONTROL_CHANNEL_PATTERN,
            (message, channel) => {
                forwardControlMessage(message, channel).catch((error) => {
                    console.error('Failed to forward control message', error);
                });
            },
        );

        startSyncLoop();
    };

    const shutdown = async () => {
        stopSyncLoop();

        if (controlUnsubscribe) {
            await controlUnsubscribe().catch((error) => {
                console.warn(
                    'Failed to unsubscribe control listener',
                    error,
                );
            });
            controlUnsubscribe = null;
        }

        await new Promise((resolve) => io.close(resolve));
        activeRooms.clear();
    };

    return {
        io,
        activeRooms,
        initialize,
        shutdown,
    };
}
