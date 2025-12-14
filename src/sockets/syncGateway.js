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
import { VoiceState } from '../voice/voiceState.js';
import { voiceServiceConfig } from '../config/voiceServiceConfig.js';
import {
    createOrUpdateVoiceSession,
    deleteVoiceSession,
    serverMuteUser,
    serverUnmuteUser,
    kickUserFromVoice,
    getRoomPolicy,
    VoiceError,
    VoiceErrorCode,
} from '../services/voiceSessionsClient.js';
import {
    VoiceErrors,
    wrapAsVoiceError,
} from '../voice/voiceErrors.js';
import {
    recordModerationEventReceived,
    recordModerationSuccess,
    recordModerationError,
    logModeration,
} from '../utils/voiceModerationMetrics.js';
import {
    recordJitterSample,
    recordRttSample,
    getEstimatedJitter,
    getEstimatedRtt,
    getConnectionQuality,
    removeClient,
} from '../utils/jitterBuffer.js';
import {
    emitVoiceStateThrottled,
    cleanupRoomThrottle,
    getAdaptiveThrottle,
} from '../utils/voiceStateThrottle.js';
import {
    markDisconnected as markVoiceDisconnected,
    handleReconnection as handleVoiceReconnection,
} from '../utils/voiceReconnectionHandler.js';
import { voiceServiceCircuit } from '../utils/circuitBreaker.js';

const CONTROL_CHANNEL_PATTERN = 'room:*:control';
const roomChannel = (roomId) => `room:${roomId}`;

const isValidRoomId = (roomId) =>
    typeof roomId === 'string' && roomId.trim().length > 0;

const AUTH_BYPASS = process.env.AUTH_BYPASS === 'true';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const ENABLE_PREBUFFER = process.env.ENABLE_PREBUFFER === 'true';
const ALLOW_SINGLE_NODE = process.env.ALLOW_SINGLE_NODE === 'true';
const ENABLE_VOICE = process.env.JAMROOM_ENABLE_VOICE === 'true';
const ENABLE_VOICE_MEDIA = ENABLE_VOICE && process.env.JAMROOM_ENABLE_VOICE_MEDIA === 'true';

console.log('[syncGateway] Configuración de voz cargada:', {
    JAMROOM_ENABLE_VOICE: process.env.JAMROOM_ENABLE_VOICE,
    JAMROOM_ENABLE_VOICE_MEDIA: process.env.JAMROOM_ENABLE_VOICE_MEDIA,
    CHATVOICE_SERVICE_URL: process.env.CHATVOICE_SERVICE_URL || process.env.VOICE_SERVICE_BASE_URL,
    INTERNAL_API_KEY: process.env.INTERNAL_API_KEY ? 'SET' : 'NOT SET',
    NODE_ENV: process.env.NODE_ENV
});

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

/**
 * Emits a standardized voice:error event with VoiceError codes
 * 
 * @param {Socket} socket - Socket.IO socket
 * @param {string} errorCode - Error code from VoiceErrorCode
 * @param {Object} [options] - Additional options
 * @param {string} [options.action] - Action that triggered the error (join, leave, mute, etc.)
 * @param {string} [options.roomId] - Associated room ID
 * @param {string} [options.targetUserId] - Target user ID (for moderation actions)
 * @param {Record<string, unknown>} [options.context] - Additional context
 */
const emitVoiceError = (socket, errorCode, options = {}) => {
    const errorDef = VoiceErrors[errorCode] || VoiceErrors[VoiceErrorCode.VOICE_INTERNAL_ERROR];
    
    socket.emit('voice:error', {
        code: errorDef.code,
        message: errorDef.message,
        uiMessage: errorDef.uiMessage,
        retryable: errorDef.retryable,
        action: options.action,
        roomId: options.roomId,
        ...(options.targetUserId && { targetUserId: options.targetUserId }),
        ...(options.context && { context: options.context }),
    });
};

/**
 * Emits a voice:error from a caught VoiceError or wraps unknown errors
 * 
 * @param {Socket} socket - Socket.IO socket
 * @param {Error} err - The error that was caught
 * @param {Object} [options] - Additional options (action, roomId, etc.)
 */
const emitVoiceErrorFromException = (socket, err, options = {}) => {
    // If it's already a VoiceError, use its payload
    if (err instanceof VoiceError) {
        socket.emit('voice:error', {
            ...err.toSocketPayload(),
            action: options.action,
            ...(options.targetUserId && { targetUserId: options.targetUserId }),
        });
        return;
    }
    
    // Wrap unknown errors and emit
    const wrapped = wrapAsVoiceError(err, { roomId: options.roomId });
    socket.emit('voice:error', {
        ...wrapped.toSocketPayload(),
        action: options.action,
        ...(options.targetUserId && { targetUserId: options.targetUserId }),
    });
};

/**
 * Validates moderation handler common parameters and permission
 * Returns null if validation fails (error already emitted), or an object with validated data
 * 
 * @param {Object} params - Validation parameters
 * @param {Socket} params.socket - Socket.IO socket
 * @param {string} params.roomId - Room ID
 * @param {string} params.targetUserId - Target user ID
 * @param {string} params.action - Action name for error messages
 * @param {string} params.eventType - Event type for metrics
 * @param {string} params.correlationId - Request correlation ID
 * @returns {Promise<{moderatorUserId: string, targetParticipant: Object}|null>}
 */
const validateModerationRequest = async ({
    socket,
    roomId,
    targetUserId,
    action,
    eventType,
    correlationId,
}) => {
    if (!isValidRoomId(roomId)) {
        socket.emit('voice:error', {
            action,
            error: 'invalid_room_id',
        });
        return null;
    }
    
    if (!targetUserId || typeof targetUserId !== 'string') {
        socket.emit('voice:error', {
            action,
            roomId,
            error: 'invalid_target_user_id',
        });
        return null;
    }
    
    // Validate the target user is in voice
    const targetParticipant = VoiceState.getParticipant(roomId, targetUserId);
    if (!targetParticipant) {
        recordModerationError(eventType, 'target_not_in_voice');
        logModeration('warn', {
            type: eventType,
            result: 'target_not_in_voice',
            roomId,
            targetUserId,
            moderatorUserId: socket.userId,
            requestId: correlationId,
            socketId: socket.id,
        });
        socket.emit('voice:error', {
            action,
            roomId,
            error: 'target_not_in_voice',
        });
        return null;
    }
    
    // Check host/cohost permission
    let moderatorUserId = socket.userId;
    if (!AUTH_BYPASS) {
        try {
            const membership = await AuthService.ensureCanControlPlayback({
                accessToken: socket.data?.accessToken,
                roomId,
            });
            moderatorUserId = membership.user_id || membership.userId || socket.userId;
        } catch (err) {
            recordModerationError(eventType, 'permission_denied');
            logModeration('warn', {
                type: eventType,
                result: 'permission_denied',
                roomId,
                targetUserId,
                moderatorUserId: socket.userId,
                requestId: correlationId,
                socketId: socket.id,
                error: err.message,
            });
            // Use emitVoiceError for host-mute, simple emit for others (backwards compatibility)
            if (action === 'host-mute') {
                emitVoiceError(socket, VoiceErrorCode.VOICE_PERMISSION_DENIED, {
                    action,
                    roomId,
                    targetUserId,
                });
            } else {
                socket.emit('voice:error', {
                    action,
                    roomId,
                    error: mapAuthErrorCodeToClientError(err.code),
                });
            }
            return null;
        }
    }
    
    return { moderatorUserId, targetParticipant };
};

/**
 * Handles voice service errors for moderation actions
 * 
 * @param {Object} params - Error handling parameters
 */
const handleModerationServiceError = ({
    socket,
    action,
    eventType,
    roomId,
    targetUserId,
    moderatorUserId,
    correlationId,
    startTime,
    err,
}) => {
    recordModerationError(eventType, 'voice_service_error');
    logModeration('error', {
        type: eventType,
        result: 'voice_service_error',
        roomId,
        targetUserId,
        moderatorUserId,
        requestId: correlationId,
        socketId: socket.id,
        latencyMs: Date.now() - startTime,
        error: err.message,
    });
    
    // Use emitVoiceErrorFromException for host-mute, simple emit for others
    if (action === 'host-mute') {
        emitVoiceErrorFromException(socket, err, {
            action,
            roomId,
            targetUserId,
        });
    } else {
        socket.emit('voice:error', {
            action,
            roomId,
            error: 'voice_service_error',
        });
    }
};

/**
 * Logs and broadcasts successful moderation action
 * 
 * @param {Object} params - Success handling parameters
 */
const finalizeModerationSuccess = ({
    io,
    socket,
    action,
    eventType,
    roomId,
    targetUserId,
    moderatorUserId,
    correlationId,
    startTime,
    reason,
    moderationAction, // 'server-muted', 'server-unmuted', 'kicked'
}) => {
    const voiceState = VoiceState.getVoiceState(roomId);
    const latencyMs = Date.now() - startTime;
    
    recordModerationSuccess(eventType);
    logModeration('info', {
        type: eventType,
        result: 'success',
        roomId,
        targetUserId,
        moderatorUserId,
        requestId: correlationId,
        socketId: socket.id,
        latencyMs,
        ...(reason && { reason }),
    });
    
    // Emit updated voice state to all users in the room (immediate for moderation)
    emitVoiceStateThrottled(io, roomId, voiceState, {
        immediate: true,
        trigger: action,
    });
    
    // Emit moderation event to the affected user
    io.to(roomChannel(roomId)).emit('voice:moderation', {
        action: moderationAction,
        roomId,
        targetUserId,
        moderatorUserId,
        ...(reason && { reason }),
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
    const clientId = socket.id;

    // Record jitter and RTT samples for adaptive sync
    if (Number.isFinite(jitterMs) && jitterMs >= 0) {
        recordJitterSample(clientId, jitterMs, clientLagMs);
    }

    // Use estimated values from jitter buffer for more stable corrections
    const estimatedJitter = getEstimatedJitter(clientId) || jitterMs;
    const estimatedLag = getEstimatedRtt(clientId) || clientLagMs;

    const decision = decideCorrection({
        localPositionMs,
        observedServerPositionMs,
        observedServerTimeMs,
        nowServerMs,
        jitterMs: estimatedJitter,
        clientLagMs: estimatedLag,
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

                // Record RTT sample for adaptive sync
                if (Number.isFinite(rtt) && rtt >= 0) {
                    recordRttSample(socket.id, rtt);
                }

                socket.emit('latencyResponse', {
                    clientTimestamp,
                    serverTimestamp,
                    connectionQuality: getConnectionQuality(socket.id),
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
                        connectionQuality: getConnectionQuality(socket.id),
                    });
                }
            }),
        );

        // *********** fastCommand corregido: permisos + rate limit ***********
        socket.on(
            'fastCommand',
            withWsRequestId(
                async ({
                           type,
                           roomId,
                           positionMs,
                           clientTimestamp,
                           trackId,
                       } = {}) => {
                    const serverReceiveTime = Date.now();
                    const networkLatency =
                        typeof clientTimestamp === 'number'
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

                    // Rate limit por acción (igual que handleControlCommand)
                    const limits = CONTROL_LIMITS[type];
                    if (limits) {
                        const allowed = await enforceRoomRateLimit(
                            roomId,
                            type,
                            limits.max,
                            limits.windowMs,
                        );
                        if (!allowed) {
                            emitControlError(socket, type, roomId, 'rate_limited');
                            return;
                        }
                    }

                    // Comprobación de permisos (ensureCanControlPlayback)
                    const effectiveUserId = await getEffectiveUserIdForControl({
                        socket,
                        roomId,
                        action: type,
                        startTime: serverReceiveTime,
                    });

                    if (!effectiveUserId) {
                        // Ya se notificó el error de auth al cliente
                        return;
                    }

                    let result;

                    try {
                        if (type === 'play') {
                            result = await SyncDomainService.play({
                                roomId,
                                userId: effectiveUserId,
                                trackId: trackId || '',
                                startPositionMs:
                                    typeof positionMs === 'number'
                                        ? positionMs
                                        : 0,
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
                                positionMs:
                                    typeof positionMs === 'number'
                                        ? positionMs
                                        : 0,
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
                            positionMs: typeof positionMs === 'number' ? positionMs : 0,
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
                        handleControlDomainError({
                            socket,
                            action: type,
                            roomId,
                            error,
                            effectiveUserId,
                            startTime: serverReceiveTime,
                        });
                    }
                },
            ),
        );
        // *********** fin fastCommand corregido ***********

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
                const correlationId = getRequestId();

                console.log('[syncGateway] user_disconnected', {
                    requestId: correlationId,
                    socketId: socket.id,
                    userId: socket.userId,
                    roomCount: rooms.length,
                });

                // Clean up jitter buffer state for this client
                removeClient(socket.id);

                // Handle voice cleanup on disconnect (if voice is enabled)
                if (ENABLE_VOICE) {
                    // Get all voice sessions for this user (includes sessionIds)
                    const voiceSessions = VoiceState.getSessionsForUser(socket.userId);
                    
                    if (voiceSessions.length > 0) {
                        console.log('[voice] disconnect: cleaning up voice sessions', {
                            requestId: correlationId,
                            socketId: socket.id,
                            userId: socket.userId,
                            rooms: voiceSessions.map(s => s.roomId),
                        });
                    }
                    
                    for (const { roomId, sessionId } of voiceSessions) {
                        // Mark as disconnected for potential reconnection handling
                        markVoiceDisconnected(roomId, socket.userId, {
                            sessionId,
                            requestId: correlationId,
                        });

                        // Delete session from chatVoice-service (best-effort, ignore errors)
                        if (sessionId) {
                            deleteVoiceSession(sessionId, { requestId: correlationId }).catch((err) => {
                                console.error('[voice] disconnect: failed to delete voice session', {
                                    requestId: correlationId,
                                    socketId: socket.id,
                                    sessionId,
                                    error: err.message,
                                });
                            });
                        }
                        
                        const leaveResult = VoiceState.leaveVoice(roomId, socket.userId);
                        if (leaveResult.success) {
                            console.log('[voice] leave (disconnect)', {
                                requestId: correlationId,
                                socketId: socket.id,
                                roomId,
                                userId: socket.userId,
                                reason: 'disconnect',
                            });
                            // Use throttled emission for voice:state
                            const voiceState = VoiceState.getVoiceState(roomId);
                            emitVoiceStateThrottled(io, roomId, voiceState, {
                                immediate: true, // Immediate for leave events
                                trigger: 'disconnect',
                            });
                        }
                    }
                    
                    // Also check for any rooms without sessions (backwards compatibility)
                    const voiceRoomsWithoutSessions = VoiceState.getRoomsForUser(socket.userId);
                    for (const roomId of voiceRoomsWithoutSessions) {
                        const leaveResult = VoiceState.leaveVoice(roomId, socket.userId);
                        if (leaveResult.success) {
                            console.log('[voice] leave (disconnect, no session)', {
                                requestId: correlationId,
                                socketId: socket.id,
                                roomId,
                                userId: socket.userId,
                                reason: 'disconnect',
                            });
                            const voiceState = VoiceState.getVoiceState(roomId);
                            emitVoiceStateThrottled(io, roomId, voiceState, {
                                immediate: true,
                                trigger: 'disconnect',
                            });
                        }
                    }
                }

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

        // *********** Voice state handlers (feature flag gated) ***********
        if (ENABLE_VOICE) {
            socket.on(
                'voice:join',
                withWsRequestId(async ({ roomId, userId: payloadUserId } = {}) => {
                    const correlationId = getRequestId();
                    
                    if (!isValidRoomId(roomId)) {
                        emitVoiceError(socket, VoiceErrorCode.VOICE_INVALID_ROOM_ID, {
                            action: 'join',
                        });
                        return;
                    }

                    // Validate user is in the room
                    if (!socket.joinedRooms.has(roomId)) {
                        emitVoiceError(socket, VoiceErrorCode.VOICE_NOT_IN_ROOM, {
                            action: 'join',
                            roomId,
                        });
                        return;
                    }

                    const effectiveUserId = payloadUserId || socket.userId;
                    
                    // Check if voice service is available for LiveKit integration
                    if (!voiceServiceConfig.isAvailable) {
                        console.warn('[voice] join: voice service unavailable', {
                            requestId: correlationId,
                            socketId: socket.id,
                            roomId,
                            userId: effectiveUserId,
                        });
                        emitVoiceError(socket, VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE, {
                            action: 'join',
                            roomId,
                        });
                        return;
                    }
                    
                    // Determine user's role (for policy checks)
                    let userRole = 'listener';
                    let isHostOrCohost = false;
                    
                    if (!AUTH_BYPASS) {
                        try {
                            const membership = await AuthService.ensureCanControlPlayback({
                                accessToken: socket.data?.accessToken,
                                roomId,
                            });
                            // User has host/cohost permissions
                            isHostOrCohost = true;
                            userRole = membership.roles?.includes('host') ? 'host' : 'cohost';
                        } catch (err) {
                            // User doesn't have host/cohost permissions - that's OK for joining
                            // They'll be a regular speaker/listener
                            isHostOrCohost = false;
                            userRole = 'speaker';
                        }
                    } else {
                        // AUTH_BYPASS: assume speaker role
                        userRole = 'speaker';
                    }
                    
                    // Fetch room policy (maxSpeakers, hostOnlyMode)
                    const roomPolicy = await getRoomPolicy(roomId, { requestId: correlationId });
                    
                    // Check hostOnlyMode - only hosts/cohosts can speak
                    let canPublishAudio = true;
                    
                    if (roomPolicy.hostOnlyMode && !isHostOrCohost) {
                        // In hostOnlyMode, non-hosts join as listeners (can't speak)
                        canPublishAudio = false;
                        userRole = 'listener';
                        
                        console.log('[voice] join: hostOnlyMode active, user joining as listener', {
                            requestId: correlationId,
                            socketId: socket.id,
                            roomId,
                            userId: effectiveUserId,
                        });
                    }
                    
                    // Check maxSpeakers limit
                    if (canPublishAudio && roomPolicy.maxSpeakers !== null) {
                        const currentSpeakers = VoiceState.countSpeakers(roomId);
                        
                        if (currentSpeakers >= roomPolicy.maxSpeakers) {
                            // Max speakers reached, user joins as listener
                            canPublishAudio = false;
                            userRole = 'listener';
                            
                            console.log('[voice] join: maxSpeakers limit reached, user joining as listener', {
                                requestId: correlationId,
                                socketId: socket.id,
                                roomId,
                                userId: effectiveUserId,
                                currentSpeakers,
                                maxSpeakers: roomPolicy.maxSpeakers,
                            });
                        }
                    }

                    // Call chatVoice-service to create/update voice session
                    let voiceSession;
                    try {
                        const username = socket.data?.user?.username || undefined;
                        voiceSession = await createOrUpdateVoiceSession({
                            roomId,
                            userId: effectiveUserId,
                            username,
                            canPublishAudio,
                            canSubscribe: true,
                            requestId: correlationId,
                        });
                    } catch (err) {
                        console.error('[voice] join: failed to create voice session', {
                            requestId: correlationId,
                            socketId: socket.id,
                            roomId,
                            userId: effectiveUserId,
                            error: err.message,
                            code: err.code,
                        });
                        emitVoiceErrorFromException(socket, err, {
                            action: 'join',
                            roomId,
                        });
                        return;
                    }

                    // Join voice locally with role and canPublishAudio
                    const result = VoiceState.joinVoice(roomId, effectiveUserId, {
                        role: userRole,
                        canPublishAudio,
                    });

                    if (!result.success) {
                        emitVoiceError(socket, VoiceErrorCode.VOICE_INTERNAL_ERROR, {
                            action: 'join',
                            roomId,
                            context: { error: result.error },
                        });
                        return;
                    }

                    // Attach session ID to the participant
                    if (voiceSession?.sessionId) {
                        VoiceState.attachSession(roomId, effectiveUserId, voiceSession.sessionId);
                    }

                    const voiceState = VoiceState.getVoiceState(roomId);

                    console.log('[voice] join: success', {
                        requestId: correlationId,
                        socketId: socket.id,
                        roomId,
                        userId: effectiveUserId,
                        sessionId: voiceSession?.sessionId,
                        role: userRole,
                        canPublishAudio,
                    });

                    // Emit to all users in the room (immediate for join events)
                    emitVoiceStateThrottled(io, roomId, voiceState, {
                        immediate: true,
                        trigger: 'join',
                    });

                    // Emit voice:session only to the joining user (for LiveKit connection)
                    if (voiceSession) {
                        socket.emit('voice:session', {
                            sessionId: voiceSession.sessionId,
                            roomId: voiceSession.roomId,
                            userId: voiceSession.userId,
                            livekit: voiceSession.livekit,
                            role: userRole,
                            canPublishAudio,
                        });
                    }
                }),
            );

            socket.on(
                'voice:leave',
                withWsRequestId(async ({ roomId, userId: payloadUserId } = {}) => {
                    if (!isValidRoomId(roomId)) {
                        socket.emit('voice:error', {
                            action: 'leave',
                            error: 'invalid_room_id',
                        });
                        return;
                    }

                    const effectiveUserId = payloadUserId || socket.userId;
                    const correlationId = getRequestId();
                    
                    // Get session ID before leaving voice
                    const sessionId = VoiceState.getSessionId(roomId, effectiveUserId);
                    
                    // Delete session from chatVoice-service (best-effort)
                    if (sessionId) {
                        try {
                            await deleteVoiceSession(sessionId, { requestId: correlationId });
                            console.log('[voice] leave: deleted voice session', {
                                requestId: correlationId,
                                socketId: socket.id,
                                sessionId,
                            });
                        } catch (err) {
                            // Log but don't abort - continue with local cleanup
                            console.error('[voice] leave: failed to delete voice session', {
                                requestId: correlationId,
                                socketId: socket.id,
                                sessionId,
                                error: err.message,
                            });
                        }
                    }
                    
                    const result = VoiceState.leaveVoice(roomId, effectiveUserId);

                    if (!result.success) {
                        socket.emit('voice:error', {
                            action: 'leave',
                            roomId,
                            error: result.error,
                        });
                        return;
                    }

                    const voiceState = VoiceState.getVoiceState(roomId);

                    console.log('[voice] leave: success', {
                        requestId: correlationId,
                        socketId: socket.id,
                        roomId,
                        userId: effectiveUserId,
                    });

                    // Emit to all users in the room (immediate for leave events)
                    emitVoiceStateThrottled(io, roomId, voiceState, {
                        immediate: true,
                        trigger: 'leave',
                    });
                }),
            );

            socket.on(
                'voice:mute',
                withWsRequestId(async ({ roomId, userId: payloadUserId, muted } = {}) => {
                    if (!isValidRoomId(roomId)) {
                        socket.emit('voice:error', {
                            action: 'mute',
                            error: 'invalid_room_id',
                        });
                        return;
                    }

                    if (typeof muted !== 'boolean') {
                        socket.emit('voice:error', {
                            action: 'mute',
                            roomId,
                            error: 'invalid_muted_value',
                        });
                        return;
                    }

                    const effectiveUserId = payloadUserId || socket.userId;
                    const result = VoiceState.setMute(roomId, effectiveUserId, muted);

                    if (!result.success) {
                        socket.emit('voice:error', {
                            action: 'mute',
                            roomId,
                            error: result.error,
                        });
                        return;
                    }

                    const voiceState = VoiceState.getVoiceState(roomId);

                    console.log('[voice] mute: success', {
                        requestId: getRequestId(),
                        socketId: socket.id,
                        roomId,
                        userId: effectiveUserId,
                        muted,
                    });

                    // Emit to all users in the room (throttled for mute changes)
                    const throttleMs = getAdaptiveThrottle(roomId);
                    emitVoiceStateThrottled(io, roomId, voiceState, {
                        throttleMs,
                        trigger: 'mute',
                    });
                }),
            );

            // *********** Voice moderation handlers ***********
            
            /**
             * voice:host-mute - Host/cohost server-mutes a user
             * Requires host/cohost permissions via AuthService.ensureCanControlPlayback
             */
            socket.on(
                'voice:host-mute',
                withWsRequestId(async ({ roomId, targetUserId, reason } = {}) => {
                    const correlationId = getRequestId();
                    const startTime = Date.now();
                    const eventType = 'host-mute';
                    const action = 'host-mute';
                    
                    recordModerationEventReceived(eventType);
                    
                    const validation = await validateModerationRequest({
                        socket,
                        roomId,
                        targetUserId,
                        action,
                        eventType,
                        correlationId,
                    });
                    
                    if (!validation) return;
                    
                    const { moderatorUserId } = validation;
                    
                    // Call chatVoice-service to server-mute
                    try {
                        await serverMuteUser({
                            roomId,
                            targetUserId,
                            moderatorUserId,
                            reason,
                            requestId: correlationId,
                        });
                    } catch (err) {
                        handleModerationServiceError({
                            socket,
                            action,
                            eventType,
                            roomId,
                            targetUserId,
                            moderatorUserId,
                            correlationId,
                            startTime,
                            err,
                        });
                        return;
                    }
                    
                    // Update local voice state
                    const result = VoiceState.setServerMuted(roomId, targetUserId, true);
                    
                    if (!result.success) {
                        emitVoiceError(socket, VoiceErrorCode.VOICE_TARGET_NOT_IN_VOICE, {
                            action,
                            roomId,
                            targetUserId,
                        });
                        return;
                    }
                    
                    finalizeModerationSuccess({
                        io,
                        socket,
                        action,
                        eventType,
                        roomId,
                        targetUserId,
                        moderatorUserId,
                        correlationId,
                        startTime,
                        reason,
                        moderationAction: 'server-muted',
                    });
                }),
            );
            
            /**
             * voice:host-unmute - Host/cohost removes server-mute from a user
             * Requires host/cohost permissions via AuthService.ensureCanControlPlayback
             */
            socket.on(
                'voice:host-unmute',
                withWsRequestId(async ({ roomId, targetUserId } = {}) => {
                    const correlationId = getRequestId();
                    const startTime = Date.now();
                    const eventType = 'host-unmute';
                    const action = 'host-unmute';
                    
                    recordModerationEventReceived(eventType);
                    
                    const validation = await validateModerationRequest({
                        socket,
                        roomId,
                        targetUserId,
                        action,
                        eventType,
                        correlationId,
                    });
                    
                    if (!validation) return;
                    
                    const { moderatorUserId } = validation;
                    
                    // Call chatVoice-service to server-unmute
                    try {
                        await serverUnmuteUser({
                            roomId,
                            targetUserId,
                            moderatorUserId,
                            requestId: correlationId,
                        });
                    } catch (err) {
                        handleModerationServiceError({
                            socket,
                            action,
                            eventType,
                            roomId,
                            targetUserId,
                            moderatorUserId,
                            correlationId,
                            startTime,
                            err,
                        });
                        return;
                    }
                    
                    // Update local voice state
                    const result = VoiceState.setServerMuted(roomId, targetUserId, false);
                    
                    if (!result.success) {
                        socket.emit('voice:error', {
                            action,
                            roomId,
                            error: result.error,
                        });
                        return;
                    }
                    
                    finalizeModerationSuccess({
                        io,
                        socket,
                        action,
                        eventType,
                        roomId,
                        targetUserId,
                        moderatorUserId,
                        correlationId,
                        startTime,
                        moderationAction: 'server-unmuted',
                    });
                }),
            );
            
            /**
             * voice:host-kick - Host/cohost kicks a user from voice
             * Requires host/cohost permissions via AuthService.ensureCanControlPlayback
             */
            socket.on(
                'voice:host-kick',
                withWsRequestId(async ({ roomId, targetUserId, reason } = {}) => {
                    const correlationId = getRequestId();
                    const startTime = Date.now();
                    const eventType = 'host-kick';
                    const action = 'host-kick';
                    
                    // Record event received
                    recordModerationEventReceived(eventType);
                    
                    // Validate input
                    const validation = validateModerationInput({ socket, roomId, targetUserId, eventType, correlationId });
                    if (!validation.valid) return;
                    
                    // Check permission
                    const permission = await getModerationPermission({ socket, roomId, targetUserId, eventType, correlationId });
                    if (!permission.allowed) return;
                    const moderatorUserId = permission.moderatorUserId;
                    
                    // Call chatVoice-service to kick user
                    try {
                        await kickUserFromVoice({
                            roomId,
                            targetUserId,
                            moderatorUserId,
                            reason,
                            requestId: correlationId,
                        });
                    } catch (err) {
                        recordModerationError(eventType, 'voice_service_error');
                        logModeration('error', {
                            type: eventType,
                            result: 'voice_service_error',
                            roomId,
                            targetUserId,
                            moderatorUserId,
                            requestId: correlationId,
                            socketId: socket.id,
                            latencyMs: Date.now() - startTime,
                            error: err.message,
                        });
                        socket.emit('voice:error', {
                            action,
                            roomId,
                            error: 'voice_service_error',
                        });
                        return;
                    }
                    
                    // Remove from local voice state
                    const result = VoiceState.leaveVoice(roomId, targetUserId);
                    
                    if (!result.success) {
                        socket.emit('voice:error', {
                            action,
                            roomId,
                            error: result.error,
                        });
                        return;
                    }
                    
                    // Handle success
                    handleModerationSuccess({
                        io,
                        socket,
                        roomId,
                        targetUserId,
                        moderatorUserId,
                        eventType,
                        correlationId,
                        startTime,
                        reason,
                        moderationAction: 'kicked',
                    });
                }),
            );
            
            // *********** end voice moderation handlers ***********
        }
        // *********** end voice state handlers ***********
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
