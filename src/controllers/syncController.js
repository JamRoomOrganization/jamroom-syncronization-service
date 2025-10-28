import { RedisService } from '../services/redisService.js';
import { SyncDomainService } from '../services/syncDomainService.js';

function getRequestId(req) {
    return req.headers['x-request-id'] || `req-${Date.now()}`;
}

export function registerSyncRoutes(app) {


    app.get('/health', async (req, res) => {
        res.json({ status: 'ok', service: 'sync-service' });
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
        const requestId = getRequestId(req);
        const { roomId } = req.params;

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
        const requestId = getRequestId(req);
        const { roomId } = req.params;
        const { userId, trackId, startPositionMs = 0 } = req.body || {};

        if (!userId || !trackId) {
            return res.status(400).json({ error: 'invalid_body' });
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
        const requestId = getRequestId(req);
        const { roomId } = req.params;
        const { userId } = req.body || {};

        if (!userId) {
            return res.status(400).json({ error: 'invalid_body' });
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
        const requestId = getRequestId(req);
        const { roomId } = req.params;
        const { userId, positionMs } = req.body || {};

        if (!userId || typeof positionMs !== 'number') {
            return res.status(400).json({ error: 'invalid_body' });
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
        const requestId = getRequestId(req);
        const { roomId } = req.params;
        const { userId, trackId, startPositionMs = 0 } = req.body || {};

        if (!userId || !trackId) {
            return res.status(400).json({ error: 'invalid_body' });
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
