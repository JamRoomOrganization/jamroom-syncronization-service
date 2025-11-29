
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
import { resolveStreamUrl } from '../utils/streamUrlCache.js';
import { pubClient, subClient } from '../config/redis.js';
import { enforceRoomRateLimit } from '../utils/rateLimiter.js';
import { withWsRequestId, getRequestId } from '../utils/requestLogger.js';
import { toArray } from '../utils/toArray.js';

const CONTROL_CHANNEL_PATTERN = 'room:*:control';
const roomChannel = (roomId) => `room:${roomId}`;

const isValidRoomId = (roomId) =>
    typeof roomId === 'string' && roomId.trim().length > 0;

const AUTH_BYPASS = process.env.AUTH_BYPASS === 'true';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const ENABLE_PREBUFFER = process.env.ENABLE_PREBUFFER === 'true';
const ALLOW_SINGLE_NODE = process.env.ALLOW_SINGLE_NODE === 'true';

const CONTROL_LIMITS = {
    play: { max: 10, windowMs: 3000 },
    pause: { max: 10, windowMs: 3000 },
    seek: { max: 20, windowMs: 5000 },
    changeTrack: { max: 10, windowMs: 10000 },
};

// Intervalo base de sincronización (precalculado)
const SYNC_INTERVAL_MS = Number.parseInt(
    process.env.SYNC_INTERVAL_MS || '1000',
    10,
);

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

const mapAuthErrorCodeToClientError = (code) => {
    switch (code) {
        case 'MEMBERSHIP_NOT_FOUND':
            return 'membership_not_found';
        case 'ROOM_CONTROL_FORBIDDEN':
        case 'FORBIDDEN':
            return 'forbidden';
        case 'UNAUTHORIZED':
            return 'unauthorized';
        case 'QUEUE_SERVICE_UNAVAILABLE':
            return 'upstream_unavailable';
        default:
            return 'internal_error';
    }
};

const handleControlAuthError = ({ socket, action, roomId, err, startTime }) => {
    console.warn('[handleControlCommand] permission denied/error', {
        action,
        roomId,
        socketId: socket.id,
        error: err.message,
        code: err.code,
        latencyMs: Date.now() - startTime,
    });

    const clientError = mapAuthErrorCodeToClientError(err.code);
    emitControlError(socket, action, roomId, clientError);
};

const getEffectiveUserIdForControl = async ({
                                                socket,
                                                roomId,
                                                action,
                                                startTime,
                                            }) => {
    let effectiveUserId = socket.userId;

    if (!socket.data?.accessToken && AUTH_BYPASS) {
        console.warn(
            '[handleControlCommand] AUTH_BYPASS enabled, skipping permission check',
            {
                action,
                roomId,
                socketId: socket.id,
                userId: socket.userId,
            },
        );
        return effectiveUserId;
    }

    try {
        const membership = await AuthService.ensureCanControlPlayback({
            accessToken: socket.data?.accessToken,
            roomId,
        });

        return membership.user_id || membership.userId || socket.userId;
    } catch (err) {
        handleControlAuthError({ socket, action, roomId, err, startTime });
        return null;
    }
};

const handleControlDomainError = ({
                                      socket,
                                      action,
                                      roomId,
                                      error,
                                      effectiveUserId,
                                      startTime,
                                  }) => {
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
        latencyMs: Date.now() - startTime,
    });
    emitControlError(socket, action, roomId, 'internal_error');
};

const handleControlCommand = async ({
                                        action,
                                        socket,
                                        roomId,
                                        payloadValidator,
                                        domainCall,
                                    }) => {
    const startTime = Date.now();

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

    const effectiveUserId = await getEffectiveUserIdForControl({
        socket,
        roomId,
        action,
        startTime,
    });

    if (!effectiveUserId) {
        return;
    }

    try {
        const result = await domainCall(effectiveUserId);
        const totalLatencyMs = Date.now() - startTime;

        socket.emit('controlAck', {
            action,
            roomId,
            version: result?.version ?? null,
            serverLatencyMs: totalLatencyMs,
        });

        if (totalLatencyMs > 100) {
            console.warn('[handleControlCommand] slow_operation', {
                action,
                roomId,
                userId: effectiveUserId,
                latencyMs: totalLatencyMs,
            });
        }
    } catch (error) {
        handleControlDomainError({
            socket,
            action,
            roomId,
            error,
            effectiveUserId,
            startTime,
        });
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

const checkAndPrebufferNextTrack = async (io, roomId, state) => {
    if (!state || state.playbackState !== 'playing') {
        return;
    }

    const currentPositionMs = RedisService.computeCurrentPosition(
        state,
        Date.now(),
    );

    const estimatedDurationMs = state.durationMs || null;

    if (!estimatedDurationMs) {
        return;
    }

    const remainingMs = estimatedDurationMs - currentPositionMs;
    const PREBUFFER_THRESHOLD_MS = 10000;

    if (!(remainingMs > 0 && remainingMs <= PREBUFFER_THRESHOLD_MS)) {
        return;
    }

    // Lógica de prebuffer pendiente de implementar cuando se integre con queue-service.
};

const sendFastSyncWithStreamUrl = async ({
                                             socket,
                                             roomId,
                                             state,
                                             initialServerTimeMs,
                                             joinLatency,
                                         }) => {
    try {
        const streamUrl = await resolveStreamUrl(state.trackId);

        if (streamUrl) {
            const updatedNow = Date.now();
            const updatedPositionMs = Math.floor(
                RedisService.computeCurrentPosition(state, updatedNow),
            );

            const fastSyncLatency = updatedNow - initialServerTimeMs;

            socket.emit('fastSync', {
                trackId: state.trackId,
                streamUrl,
                positionMs: updatedPositionMs,
                playbackState: state.playbackState || 'paused',
                serverTimeMs: updatedNow,
                networkLatency: joinLatency,
                serverProcessingMs: fastSyncLatency,
                version: state.version ?? 0,
            });

            if (LOG_LEVEL === 'debug') {
                console.log('[syncGateway] fastSync enviado con streamUrl', {
                    requestId: getRequestId(),
                    roomId,
                    userId: socket.userId,
                    trackId: state.trackId,
                    totalLatencyMs: fastSyncLatency,
                });
            }
        } else {
            console.warn('[syncGateway] No se pudo resolver streamUrl', {
                roomId,
                trackId: state.trackId,
            });
        }
    } catch (error) {
        console.error('[syncGateway] Error resolviendo streamUrl', {
            roomId,
            trackId: state.trackId,
            error: error.message,
        });
    }
};

const shouldSkipSyncForRoom = (roomId, now, recentSeeks) => {
    const lastSeek = recentSeeks.get(roomId);
    if (!lastSeek) {
        return false;
    }

    const timeSinceSeek = now - lastSeek;

    if (timeSinceSeek >= 2000) {
        return false;
    }

    if (LOG_LEVEL === 'debug') {
        console.log('[syncGateway] syncPacket_skipped', {
            roomId,
            reason: 'recent_seek',
            timeSinceSeek,
        });
    }

    return true;
};

const getSyncDecision = (state, now) => {
    const lastSync = state.lastSyncMs || 0;
    const timeSinceLastSync = now - lastSync;

    const shouldSync =
        state.playbackState === 'playing' ||
        timeSinceLastSync >= SYNC_INTERVAL_MS * 5 ||
        state.version <= 3;

    return { shouldSync, timeSinceLastSync };
};

const emitRoomSyncPacket = async ({
                                      io,
                                      roomId,
                                      state,
                                      now,
                                      localSize,
                                      timeSinceLastSync,
                                  }) => {
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

    await RedisService.setRoomState(roomId, {
        ...state,
        lastSyncMs: now,
    });

    if (ENABLE_PREBUFFER) {
        await checkAndPrebufferNextTrack(io, roomId, state);
    }

    if (state.version % 30 === 0 || state.version < 3) {
        console.log('[syncGateway] syncPacket', {
            roomId,
            users: localSize,
            state: state.playbackState,
            version: state.version,
            timeSinceLastSync,
        });
    }
};

export function initSyncGateway(httpServer, options) {
    const { cors = {} } = options || {};

    const defaultCors = {
        origin: toArray(process.env.CORS_ORIGIN) || '*',
        methods: ['GET', 'POST'],
        credentials: false,
    };

    const finalCors = {
        ...defaultCors,
        ...cors,
        credentials: false,
    };

    const io = new SocketIOServer(httpServer, { cors: finalCors });
    const activeRooms = new Set();
    const recentSeeks = new Map();

    let controlUnsubscribe = null;
    let syncLoopRunning = false;
    let syncLoopStopped = false;

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
        const roomsSnapshot = Array.from(activeRooms);

        const tasks = roomsSnapshot.map(async (roomId) => {
            const localSize = getLocalRoomSize(io, roomId);
            if (!localSize) {
                cleanupRoomIfEmpty(roomId);
                return;
            }

            if (shouldSkipSyncForRoom(roomId, now, recentSeeks)) {
                return;
            }

            try {
                const state = await RedisService.getRoomState(roomId);
                if (!state) {
                    activeRooms.delete(roomId);
                    return;
                }

                const { shouldSync, timeSinceLastSync } = getSyncDecision(
                    state,
                    now,
                );

                if (!shouldSync) {
                    return;
                }

                await emitRoomSyncPacket({
                    io,
                    roomId,
                    state,
                    now,
                    localSize,
                    timeSinceLastSync,
                });
            } catch (error) {
                console.error(
                    `Failed to emit syncPacket for room ${roomId}`,
                    error,
                );
            }
        });

        await Promise.all(tasks);
    };

    const scheduleNextSync = () => {
        if (syncLoopStopped) {
            syncLoopRunning = false;
            return;
        }

        setTimeout(async () => {
            try {
                await emitSyncPackets();
            } catch (error) {
                console.error('Error running sync loop', error);
            } finally {
                scheduleNextSync();
            }
        }, SYNC_INTERVAL_MS);
    };

    const startSyncLoop = () => {
        if (syncLoopRunning) {
            return;
        }
        syncLoopRunning = true;
        syncLoopStopped = false;
        scheduleNextSync();
    };

    const stopSyncLoop = () => {
        syncLoopStopped = true;
    };

    const forwardControlMessage = async (message, channel) => {
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
        const rawAuth = socket.handshake?.auth ?? {};
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

        const resolvedUserId =
            rawAuth.userId ||
            socket.handshake.query?.userId ||
            `u-${socket.id}`;

        socket.userId = resolvedUserId;
        socket.data.userId = resolvedUserId;
        socket.joinedRooms = new Set();

        socket.on(
            'joinRoom',
            withWsRequestId(async ({ roomId, clientJoinTimestamp } = {}) => {
                if (!isValidRoomId(roomId)) {
                    return;
                }

                const channel = roomChannel(roomId);
                socket.join(channel);
                socket.joinedRooms.add(roomId);

                ensureRoomActive(roomId);
                Metrics.userJoin(roomId, socket.userId);

                const roomSize = getLocalRoomSize(io, roomId);
                const serverJoinTimestamp = Date.now();
                const joinLatency =
                    typeof clientJoinTimestamp === 'number'
                        ? serverJoinTimestamp - clientJoinTimestamp
                        : undefined;

                console.log('[syncGateway] user_joined_room', {
                    requestId: getRequestId(),
                    socketId: socket.id,
                    roomId,
                    userId: socket.userId,
                    roomSize,
                    clientJoinTimestamp,
                    serverJoinTimestamp,
                });

                try {
                    const state = await RedisService.getRoomState(roomId);

                    if (state?.trackId) {
                        const positionMs = Math.floor(
                            RedisService.computeCurrentPosition(
                                state,
                                serverJoinTimestamp,
                            ),
                        );

                        socket.emit('initialSync', {
                            roomId,
                            serverTimeMs: serverJoinTimestamp,
                            playbackState: state.playbackState || 'paused',
                            positionMs,
                            trackId: state.trackId,
                            version: state.version ?? 0,
                        });

                        console.log('[syncGateway] initialSync enviado', {
                            requestId: getRequestId(),
                            roomId,
                            userId: socket.userId,
                            trackId: state.trackId,
                            positionMs,
                            playbackState: state.playbackState,
                        });

                        sendFastSyncWithStreamUrl({
                            socket,
                            roomId,
                            state,
                            initialServerTimeMs: serverJoinTimestamp,
                            joinLatency,
                        });
                    }
                } catch (error) {
                    console.error('[syncGateway] error enviando initialSync', {
                        requestId: getRequestId(),
                        roomId,
                        userId: socket.userId,
                        error: error.message,
                    });
                }

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
            'measureLatency',
            withWsRequestId(({ clientTimestamp } = {}) => {
                const serverTimestamp = Date.now();
                const rtt = serverTimestamp - clientTimestamp;

                socket.emit('latencyResponse', {
                    clientTimestamp,
                    serverTimestamp,
                });

                if (LOG_LEVEL === 'debug' || rtt > 500) {
                    const logLevel = rtt > 500 ? 'warn' : 'log';
                    console[logLevel]('[syncGateway] latency_measurement', {
                        requestId: getRequestId(),
                        socketId: socket.id,
                        userId: socket.userId,
                        clientTimestamp,
                        serverTimestamp,
                        rttMs: rtt,
                        isHighLatency: rtt > 500,
                    });
                }
            }),
        );

        socket.on(
            'fastCommand',
            withWsRequestId(
                async ({
                           type,
                           roomId,
                           positionMs,
                           clientTimestamp,
                           trackId,
                           userId,
                       } = {}) => {
                    const serverReceiveTime = Date.now();
                    const networkLatency = clientTimestamp
                        ? serverReceiveTime - clientTimestamp
                        : null;

                    if (!isValidRoomId(roomId) || !type) {
                        return;
                    }

                    if (LOG_LEVEL === 'debug') {
                        console.log('[syncGateway] fastCommand recibido', {
                            requestId: getRequestId(),
                            type,
                            roomId,
                            userId: socket.userId,
                            networkLatencyMs: networkLatency,
                        });
                    }

                    try {
                        let result;
                        const effectiveUserId = socket.userId;

                        if (type === 'play') {
                            result = await SyncDomainService.play({
                                roomId,
                                userId: effectiveUserId,
                                trackId: trackId || '',
                                startPositionMs: positionMs || 0,
                            });
                        } else if (type === 'pause') {
                            result = await SyncDomainService.pause({
                                roomId,
                                userId: effectiveUserId,
                            });
                        } else if (type === 'seek') {
                            result = await SyncDomainService.seek({
                                roomId,
                                userId: effectiveUserId,
                                positionMs: positionMs || 0,
                            });
                        } else {
                            console.warn(
                                '[syncGateway] fastCommand tipo desconocido:',
                                type,
                            );
                            return;
                        }

                        const totalLatency = Date.now() - serverReceiveTime;

                        io.to(roomChannel(roomId)).emit('fastSync', {
                            type,
                            positionMs: positionMs || 0,
                            trackId: trackId || null,
                            serverTimeMs: Date.now(),
                            originalClientTimestamp: clientTimestamp,
                            version: result?.version ?? null,
                        });

                        socket.emit('controlAck', {
                            action: type,
                            roomId,
                            version: result?.version ?? null,
                            serverLatencyMs: totalLatency,
                        });

                        if (LOG_LEVEL === 'debug' || totalLatency > 100) {
                            const logLevel = totalLatency > 100 ? 'warn' : 'log';
                            console[logLevel](
                                '[syncGateway] fastCommand procesado',
                                {
                                    requestId: getRequestId(),
                                    type,
                                    roomId,
                                    userId: socket.userId,
                                    totalLatencyMs: totalLatency,
                                    networkLatencyMs: networkLatency,
                                },
                            );
                        }
                    } catch (error) {
                        const totalLatency = Date.now() - serverReceiveTime;

                        console.error(
                            '[syncGateway] error en fastCommand',
                            {
                                requestId: getRequestId(),
                                type,
                                roomId,
                                userId: socket.userId,
                                error: error.message,
                                latencyMs: totalLatency,
                            },
                        );

                        socket.emit('controlError', {
                            action: type,
                            roomId,
                            error: 'internal_error',
                        });
                    }
                },
            ),
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
                    domainCall: async (userId) => {
                        const now = Date.now();
                        recentSeeks.set(roomId, now);

                        setTimeout(() => {
                            recentSeeks.delete(roomId);
                        }, 2000);

                        return SyncDomainService.seek({
                            roomId,
                            userId,
                            positionMs,
                        });
                    },
                });
            }),
        );

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

            if (ALLOW_SINGLE_NODE) {
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

        io.on('connection', registerSocketHandlers);

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
