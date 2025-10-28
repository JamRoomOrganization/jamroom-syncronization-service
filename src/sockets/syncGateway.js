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

const CONTROL_CHANNEL_PATTERN = 'room:*:control';
const roomChannel = (roomId) => `room:${roomId}`;

const isValidRoomId = (roomId) => typeof roomId === 'string' && roomId.trim().length > 0;

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
        const allowed = await enforceRoomRateLimit(roomId, action, limits.max, limits.windowMs);
        if (!allowed) {
            emitControlError(socket, action, roomId, 'rate_limited');
            return;
        }
    }

    const canControl = await AuthService.canControlRoom(socket.userId, roomId);
    if (!canControl) {
        emitControlError(socket, action, roomId, 'forbidden');
        return;
    }

    try {
        const result = await domainCall();
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
            userId: socket.userId,
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
    const io = new SocketIOServer(httpServer, { cors });
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
            // TODO: In clustered deployments query adapter state (e.g., allRooms) to confirm emptiness.
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
            } catch (error) {
                console.error(`Failed to emit syncPacket for room ${roomId}`, error);
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
        // TODO production auth:
        // - Extraer token JWT de socket.handshake.auth.token (o headers).
        // - Verificar firma y expiración.
        // - Derivar userId real del JWT.
        // - Si es inválido -> socket.disconnect(true) y return.
        const resolvedUserId =
            socket.handshake.auth?.userId ||
            socket.handshake.query?.userId ||
            `u-${socket.id}`;

        socket.userId = resolvedUserId;
        socket.data.userId = resolvedUserId;
        socket.joinedRooms = new Set();

        socket.on('joinRoom', ({ roomId } = {}) => {
            if (!isValidRoomId(roomId)) {
                return;
            }

            const channel = roomChannel(roomId);
            socket.join(channel);
            socket.joinedRooms.add(roomId);

            ensureRoomActive(roomId);
            Metrics.userJoin(roomId, socket.userId);

            io.to(channel).emit('roomUserJoin', {
                roomId,
                userId: socket.userId,
            });
        });

        socket.on('leaveRoom', ({ roomId } = {}) => {
            if (!isValidRoomId(roomId)) {
                return;
            }

            const channel = roomChannel(roomId);

            socket.leave(channel);
            socket.joinedRooms.delete(roomId);

            Metrics.userLeave(roomId, socket.userId);
            io.to(channel).emit('roomUserLeave', {
                roomId,
                userId: socket.userId,
            });

            cleanupRoomIfEmpty(roomId);
        });

        socket.on('heartbeat', ({ roomId } = {}) => {
            if (!isValidRoomId(roomId)) {
                return;
            }

            ensureRoomActive(roomId);
            socket.emit('heartbeatAck', {
                roomId,
                serverTimeMs: Date.now(),
            });
        });

        socket.on('driftReport', (payload = {}) => {
            handleDriftReport(socket, payload).catch((error) => {
                console.error('Failed to process drift report', error);
            });
        });

        // Only the room host (first controller) may emit control events.
        socket.on('play', async ({ roomId, trackId, startPositionMs } = {}) => {
            await handleControlCommand({
                action: 'play',
                socket,
                roomId,
                payloadValidator: () => (
                    isValidRoomId(roomId) && typeof trackId === 'string' && trackId.trim().length > 0
                ),
                domainCall: () =>
                    SyncDomainService.play({
                        roomId,
                        userId: socket.userId,
                        trackId: trackId.trim(),
                        startPositionMs: typeof startPositionMs === 'number' ? startPositionMs : 0,
                    }),
            });
        });

        socket.on('pause', async ({ roomId } = {}) => {
            await handleControlCommand({
                action: 'pause',
                socket,
                roomId,
                payloadValidator: () => isValidRoomId(roomId),
                domainCall: () =>
                    SyncDomainService.pause({
                        roomId,
                        userId: socket.userId,
                    }),
            });
        });

        socket.on('seek', async ({ roomId, positionMs } = {}) => {
            await handleControlCommand({
                action: 'seek',
                socket,
                roomId,
                payloadValidator: () =>
                    isValidRoomId(roomId) &&
                    typeof positionMs === 'number' &&
                    Number.isFinite(positionMs) &&
                    positionMs >= 0,
                domainCall: () =>
                    SyncDomainService.seek({
                        roomId,
                        userId: socket.userId,
                        positionMs,
                    }),
            });
        });

        socket.on('changeTrack', async ({ roomId, trackId, startPositionMs } = {}) => {
            await handleControlCommand({
                action: 'changeTrack',
                socket,
                roomId,
                payloadValidator: () =>
                    isValidRoomId(roomId) && typeof trackId === 'string' && trackId.trim().length > 0,
                domainCall: () =>
                    SyncDomainService.changeTrack({
                        roomId,
                        userId: socket.userId,
                        trackId: trackId.trim(),
                        startPositionMs: typeof startPositionMs === 'number' ? startPositionMs : 0,
                    }),
            });
        });

        socket.on('disconnect', async () => {
            const rooms = Array.from(socket.joinedRooms);

            for (const roomId of rooms) {
                Metrics.userLeave(roomId, socket.userId);
                io.to(roomChannel(roomId)).emit('roomUserLeave', {
                    roomId,
                    userId: socket.userId,
                });
                const localSize = getLocalRoomSize(io, roomId);
                if (!localSize) {
                    cleanupRoomIfEmpty(roomId);
                    try {
                        await AuthService.maybeReleaseHost(roomId, socket.userId);
                    } catch (err) {
                        console.warn('[disconnect] failed to maybeReleaseHost', {
                            roomId,
                            userId: socket.userId,
                            err,
                        });
                    }
                }
            }

            socket.joinedRooms.clear();
        });
    };

    const initialize = async () => {
        await Promise.all([
            pubClient.isOpen ? Promise.resolve() : pubClient.connect(),
            subClient.isOpen ? Promise.resolve() : subClient.connect(),
        ]);

        io.adapter(createAdapter(pubClient, subClient));

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
                console.warn('Failed to unsubscribe control listener', error);
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
