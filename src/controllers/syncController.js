import { RedisService } from '../services/redisService.js';
import { SyncDomainService } from '../services/syncDomainService.js';
import { redisClient, pubClient, subClient } from '../config/redis.js';
import { getRequestId } from '../utils/requestLogger.js';

export function registerSyncRoutes(app) {

    // NOTE: Health check endpoint for load balancers and monitoring
    // Returns 200 OK if all Redis clients are healthy
    // Returns 503 Service Unavailable if any Redis client is down
    app.get('/health', async (req, res) => {
        const checks = {
            redis: false,
            redisPub: false,
            redisSub: false,
        };

        // Check main Redis client
        try {
            await redisClient.ping();
            checks.redis = true;
        } catch (err) {
            console.error('[health] Redis main client unhealthy', err.message);
        }

        // Check pub client
        try {
            await pubClient.ping();
            checks.redisPub = true;
        } catch (err) {
            console.error('[health] Redis pub client unhealthy', err.message);
        }

        // Check sub client
        try {
            await subClient.ping();
            checks.redisSub = true;
        } catch (err) {
            console.error('[health] Redis sub client unhealthy', err.message);
        }

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

        // TODO: mapear trackId l�gico -> URL Audius firmada
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
                version: roomState.version
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

        // NOTE: Validate required fields and types
        if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
            return res.status(400).json({ error: 'invalid_body', field: 'userId' });
        }
        if (!trackId || typeof trackId !== 'string' || trackId.trim().length === 0) {
            return res.status(400).json({ error: 'invalid_body', field: 'trackId' });
        }
        if (typeof startPositionMs !== 'number' || !Number.isFinite(startPositionMs) || startPositionMs < 0) {
            return res.status(400).json({ error: 'invalid_body', field: 'startPositionMs' });
        }

        try {
            const result = await SyncDomainService.play({
                roomId,
                userId,
                trackId,
                startPositionMs
            });

            console.log(
                `[${requestId}] PLAY room=${roomId} by user=${userId} track=${trackId}`
            );
            return res.json(result);
        } catch (err) {
            if (err.message === 'room_not_found') {
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

        if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
            return res.status(400).json({ error: 'invalid_body', field: 'userId' });
        }

        try {
            const result = await SyncDomainService.pause({
                roomId,
                userId
            });

            console.log(
                `[${requestId}] PAUSE room=${roomId} by user=${userId}`
            );
            return res.json(result);
        } catch (err) {
            if (err.message === 'room_not_found') {
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

        if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
            return res.status(400).json({ error: 'invalid_body', field: 'userId' });
        }
        if (typeof positionMs !== 'number' || !Number.isFinite(positionMs) || positionMs < 0) {
            return res.status(400).json({ error: 'invalid_body', field: 'positionMs' });
        }

        try {
            const result = await SyncDomainService.seek({
                roomId,
                userId,
                positionMs
            });

            console.log(
                `[${requestId}] SEEK room=${roomId} by user=${userId} -> positionMs=${positionMs}`
            );
            return res.json(result);
        } catch (err) {
            if (err.message === 'room_not_found') {
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

        if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
            return res.status(400).json({ error: 'invalid_body', field: 'userId' });
        }
        if (!trackId || typeof trackId !== 'string' || trackId.trim().length === 0) {
            return res.status(400).json({ error: 'invalid_body', field: 'trackId' });
        }
        if (typeof startPositionMs !== 'number' || !Number.isFinite(startPositionMs) || startPositionMs < 0) {
            return res.status(400).json({ error: 'invalid_body', field: 'startPositionMs' });
        }

        try {
            const result = await SyncDomainService.changeTrack({
                roomId,
                userId,
                trackId,
                startPositionMs
            });

            console.log(
                `[${requestId}] TRACK CHANGE room=${roomId} by user=${userId} -> trackId=${trackId}`
            );
            return res.json(result);
        } catch (err) {
            console.error(`[${requestId}] TRACK CHANGE error`, err);
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
