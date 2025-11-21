import { redisClient } from '../config/redis.js';

const buildKey = (roomId, actionKey) => `ratelimit:room:${roomId}:${actionKey}`;

export async function enforceRoomRateLimit(roomId, actionKey, maxPerWindow, windowMs) {
    if (!roomId || !actionKey || !Number.isFinite(maxPerWindow) || maxPerWindow <= 0) {
        return true;
    }

    const ttlSeconds = Math.max(1, Math.ceil(windowMs / 1000));
    const key = buildKey(roomId, actionKey);

    try {
        const count = await redisClient.incr(key);

        if (count === 1) {
            await redisClient.expire(key, ttlSeconds);
        }

        return count <= maxPerWindow;
    } catch (error) {
        console.error('Rate limiter failed', { roomId, actionKey, error });
        return true;
    }
}
