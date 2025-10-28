import { redisClient, pubClient, subClient, redlock } from '../config/redis.js';

const ROOM_PREFIX = 'room:';
const ROOM_TTL_SECONDS = 60 * 30; // 30 min

const roomStateKey = (roomId) => `${ROOM_PREFIX}${roomId}:state`;
const roomVersionKey = (roomId) => `${ROOM_PREFIX}${roomId}:version`;
const roomHostKey = (roomId) => `${ROOM_PREFIX}${roomId}:hostUserId`;
const lockKey = (roomId) => `lock:room:${roomId}`;

const toNumber = (value, fallback = 0) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
};

export const RedisService = {
    async getRoomState(roomId) {
        const raw = await redisClient.hGetAll(roomStateKey(roomId));
        if (!raw || Object.keys(raw).length === 0) {
            return null;
        }

        // Normaliza el campo de "quién actualizó"
        const updatedBy = raw.updatedBy ?? raw.updatedByUserId ?? null;

        return {
            roomId,
            trackId: raw.trackId || null,
            playbackState: raw.playbackState || 'paused',

            basePositionMs: toNumber(raw.basePositionMs, 0),
            baseServerTimeMs: toNumber(raw.baseServerTimeMs, 0),

            playbackRate: toNumber(raw.playbackRate, 1),

            updatedBy,
            updatedAt: toNumber(raw.updatedAt, 0),

            version: toNumber(raw.version, 0),

            lastSyncMs: toNumber(raw.lastSyncMs, 0),
        };
    },

    async setRoomState(roomId, state) {
        const key = roomStateKey(roomId);
        const payload = {};

        for (const [field, value] of Object.entries(state)) {
            if (value !== undefined && value !== null) {
                payload[field] = String(value);
            }
        }

        // guardamos siempre el roomId en Redis
        if (!payload.roomId) {
            payload.roomId = String(roomId);
        }

        if (Object.keys(payload).length > 0) {
            await redisClient.hSet(key, payload);
        }

        // TTL efímero
        await redisClient.expire(key, ROOM_TTL_SECONDS);
    },

    async getVersion(roomId) {
        const value = await redisClient.get(roomVersionKey(roomId));
        return value ? Number(value) : 0;
    },

    async nextVersion(roomId) {
        const value = await redisClient.incr(roomVersionKey(roomId));
        // TTL también sobre el contador de versión
        await redisClient.expire(roomVersionKey(roomId), ROOM_TTL_SECONDS);
        return value;
    },

    async getRoomHost(roomId) {
        const host = await redisClient.get(roomHostKey(roomId));
        return host || null;
    },

    async setRoomHostIfEmpty(roomId, userId) {
        if (!userId) {
            return false;
        }
        const key = roomHostKey(roomId);

        const wasSet = await redisClient.setNX(key, userId);
        if (wasSet) {
            await redisClient.expire(key, ROOM_TTL_SECONDS);
        }
        return wasSet;
    },

    async clearRoomHost(roomId) {
        await redisClient.del(roomHostKey(roomId));
    },

    async lockRoom(roomId, ttlMs = 2000) {
        // Intentar lock distribuido real primero
        try {
            return await redlock.acquire([lockKey(roomId)], ttlMs);
        } catch (err) {
            console.warn('[lockRoom] redlock.acquire fallback for room', roomId, err?.message);
            // fallback "fake lock" local para desarrollo single-node
            return {
                async release() {
                    return;
                },
            };
        }
    },

    async publish(channel, message) {
        await pubClient.publish(channel, JSON.stringify(message));
    },

    async subscribe(pattern, handler) {
        await subClient.pSubscribe(pattern, (message, channel) => {
            try {
                handler(JSON.parse(message), channel);
            } catch (error) {
                console.error('Redis subscribe handler error', error);
            }
        });

        // devolvemos una función para que el gateway pueda hacer cleanup en shutdown()
        return async () => {
            try {
                await subClient.pUnsubscribe(pattern);
            } catch (err) {
                console.warn('Failed to pUnsubscribe pattern', { pattern, err });
            }
        };
    },

    computeCurrentPosition(state, nowMs = Date.now()) {
        if (!state) {
            return 0;
        }

        const playbackRate = toNumber(state.playbackRate, 1);
        const basePositionMs = toNumber(state.basePositionMs, 0);
        const baseServerTimeMs = toNumber(state.baseServerTimeMs, nowMs);

        if (state.playbackState === 'playing') {
            const delta = nowMs - baseServerTimeMs;
            return basePositionMs + delta * playbackRate;
        }

        return basePositionMs;
    },
};
