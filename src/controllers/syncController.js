import { RedisService } from '../services/redisService.js';
import { SyncDomainService } from '../services/syncDomainService.js';
import { redisClient, pubClient, subClient } from '../config/redis.js';
import { getRequestId } from '../utils/requestLogger.js';

// Helpers de validación reutilizables
const isNonEmptyString = (value) =>
    typeof value === 'string' && value.trim().length > 0;

const isNonNegativeNumber = (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;

const sendInvalidBody = (res, field) =>
    res.status(400).json({ error: 'invalid_body', field });

const validateUserId = (userId, res) => {
    if (!isNonEmptyString(userId)) {
        sendInvalidBody(res, 'userId');
        return false;
    }
    return true;
};

const validateTrackId = (trackId, res) => {
    if (!isNonEmptyString(trackId)) {
        sendInvalidBody(res, 'trackId');
        return false;
    }
    return true;
};

const validateStartPositionMs = (startPositionMs, res) => {
    if (!isNonNegativeNumber(startPositionMs)) {
        sendInvalidBody(res, 'startPositionMs');
        return false;
    }
    return true;
};

const validatePositionMs = (positionMs, res) => {
    if (!isNonNegativeNumber(positionMs)) {
        sendInvalidBody(res, 'positionMs');
        return false;
    }
    return true;
};

// Helper para el health check de Redis, evita duplicar try/catch
const pingRedisClient = async (label, client) => {
    try {
        await client.ping();
        return true;
    } catch (err) {
        console.error(
            `[health] Redis ${label} client unhealthy`,
            err && err.message ? err.message : err
        );
        return false;
    }
};

export function registerSyncRoutes(app) {
    // NOTE: Health check endpoint for load balancers and monitoring
    // Returns 200 OK if all Redis clients are healthy
    // Returns 503 Service Unavailable if any Redis client is down
    app.get('/health', async (req, res) => {
        const checks = {
            redis: await pingRedisClient('main', redisClient),
            redisPub: await pingRedisClient('pub', pubClient),
            redisSub: await pingRedisClient('sub', subClient),
        };

        const healthy = checks.redis && checks.redisPub && checks.redisSub;

        res.status(healthy ? 200 : 503).json({
            status: healthy ? 'ok' : 'degraded',
            checks,
            uptime: Math.floor(process.uptime()),
            timestamp: Date.now(),
        });
    });

    app.get('/v1/tracks/:trackId/streamUrl', async (req, res) => {
        const { trackId } = req.params;
        if (!trackId) {
            return res.status(400).json({ error: 'invalid_trackId' });
        }
        // TODO: mapear trackId lógico -> URL Audius firmada
        return res.json({
            trackId,
            streamUrl: trackId,
        });
    });

    app.get('/v1/rooms/:roomId/state', async (req, res) => {
        const requestId = getRequestId();
        const { roomId } = req.params;

        // NOTE: Prevent caching of room state - always fetch fresh from Redis
        res.set('Cache-Control', 'no-store');

        try {
            const roomState = await RedisService.getRoomState(roomId);

            if (!roomState) {
                console.warn(`[${requestId}] room ${roomId} not found`);
                return res.status(404).json({ error: 'room_not_found' });
            }

            const nowServerMs = Date.now();
            const effectivePositionMs =
                RedisService.computeCurrentPosition(roomState, nowServerMs);

            return res.json({
                roomId,
                trackId: roomState.trackId,
                playbackState: roomState.playbackState,
                effectivePositionMs,
                serverTimeMs: nowServerMs,
                version: roomState.version,
            });
        } catch (err) {
            console.error(
                `[${requestId}] GET /v1/rooms/${roomId}/state error`,
                err
            );
            return res.status(500).json({ error: 'internal_error' });
        }
    });

    app.post('/v1/rooms/:roomId/play', async (req, res) => {
        const requestId = getRequestId();
        const { roomId } = req.params;
        const { userId, trackId, startPositionMs = 0 } = req.body || {};

        // Validaciones equivalentes, ahora reutilizando helpers
        if (!validateUserId(userId, res)) {
            return;
        }
        if (!validateTrackId(trackId, res)) {
            return;
        }
        if (!validateStartPositionMs(startPositionMs, res)) {
            return;
        }

        try {
            const result = await SyncDomainService.play({
                roomId,
                userId,
                trackId,
                startPositionMs,
            });

            console.log(
                `[${requestId}] PLAY room=${roomId} by user=${userId} track=${trackId}`
            );
            return res.json(result);
        } catch (err) {
            if (err && err.message === 'room_not_found') {
                console.warn(
                    `[${requestId}] room ${roomId} not found for play`
                );
                return res.status(404).json({ error: 'room_not_found' });
            }
            console.error(`[${requestId}] PLAY error`, err);
            return res.status(500).json({ error: 'internal_error' });
        }
    });

    app.post('/v1/rooms/:roomId/pause', async (req, res) => {
        const requestId = getRequestId();
        const { roomId } = req.params;
        const { userId } = req.body || {};

        if (!validateUserId(userId, res)) {
            return;
        }

        try {
            const result = await SyncDomainService.pause({
                roomId,
                userId,
            });

            console.log(
                `[${requestId}] PAUSE room=${roomId} by user=${userId}`
            );
            return res.json(result);
        } catch (err) {
            if (err && err.message === 'room_not_found') {
                console.warn(
                    `[${requestId}] room ${roomId} not found for pause`
                );
                return res.status(404).json({ error: 'room_not_found' });
            }
            console.error(`[${requestId}] PAUSE error`, err);
            return res.status(500).json({ error: 'internal_error' });
        }
    });

    app.post('/v1/rooms/:roomId/seek', async (req, res) => {
        const requestId = getRequestId();
        const { roomId } = req.params;
        const { userId, positionMs } = req.body || {};

        if (!validateUserId(userId, res)) {
            return;
        }
        if (!validatePositionMs(positionMs, res)) {
            return;
        }

        try {
            const result = await SyncDomainService.seek({
                roomId,
                userId,
                positionMs,
            });

            console.log(
                `[${requestId}] SEEK room=${roomId} by user=${userId} -> positionMs=${positionMs}`
            );
            return res.json(result);
        } catch (err) {
            if (err && err.message === 'room_not_found') {
                console.warn(
                    `[${requestId}] room ${roomId} not found for seek`
                );
                return res.status(404).json({ error: 'room_not_found' });
            }
            console.error(`[${requestId}] SEEK error`, err);
            return res.status(500).json({ error: 'internal_error' });
        }
    });

    app.post('/v1/rooms/:roomId/track', async (req, res) => {
        const requestId = getRequestId();
        const { roomId } = req.params;
        const { userId, trackId, startPositionMs = 0 } = req.body || {};

        if (!validateUserId(userId, res)) {
            return;
        }
        if (!validateTrackId(trackId, res)) {
            return;
        }
        if (!validateStartPositionMs(startPositionMs, res)) {
            return;
        }

        try {
            const result = await SyncDomainService.changeTrack({
                roomId,
                userId,
                trackId,
                startPositionMs,
            });

            console.log(
                `[${requestId}] TRACK CHANGE room=${roomId} by user=${userId} -> trackId=${trackId}`
            );
            return res.json(result);
        } catch (err) {
            console.error(
                `[${requestId}] TRACK CHANGE error`,
                err
            );
            return res.status(500).json({ error: 'internal_error' });
        }
    });

    app.get('/debug/state/:roomId', async (req, res) => {
        const { roomId } = req.params;
        try {
            const roomState = await RedisService.getRoomState(roomId);
            const version = await RedisService.getVersion?.(roomId);
            return res.json({
                exists: !!(roomState && Object.keys(roomState).length),
                roomState,
                version: version ?? null,
            });
        } catch (err) {
            console.error('[debug/state] error', err);
            return res.status(500).json({ error: 'internal_debug_error' });
        }
    });
}
