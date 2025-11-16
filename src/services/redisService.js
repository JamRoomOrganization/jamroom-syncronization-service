import { redisClient, pubClient, subClient, redlock, REDLOCK_CONFIG } from '../config/redis.js';
import { getRequestId } from '../utils/requestLogger.js';

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
        // NOTE: Store room state in Redis hash with automatic TTL refresh
        // All values converted to strings to ensure Redis compatibility
        const key = roomStateKey(roomId);
        const payload = {};

        for (const [field, value] of Object.entries(state)) {
            if (value !== undefined && value !== null) {
                // Convert numbers to strings to prevent precision issues
                payload[field] = typeof value === 'number' ? String(value) : String(value);
            }
        }

        // Always store roomId for consistency
        if (!payload.roomId) {
            payload.roomId = String(roomId);
        }

        if (Object.keys(payload).length > 0) {
            await redisClient.hSet(key, payload);
        }

        // Refresh TTL on every update to keep active rooms alive
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

    async lockRoom(roomId, ttlMs = REDLOCK_CONFIG.LOCK_TTL_MS) {


        const requestId = getRequestId();
        const key = lockKey(roomId);
        const token = `${requestId}-${Date.now()}-${Math.random()
            .toString(16)
            .slice(2)}`;
        const effectiveTtl = Number(ttlMs) > 0 ? Number(ttlMs) : 5000;

        try {
            // node-redis v4: set(key, value, { PX, NX })
            const result = await redisClient.set(key, token, {
                PX: effectiveTtl,
                NX: true,
            });

            if (result !== 'OK') {
                // No se pudo adquirir el lock (ya había otro).
                console.warn('[lockRoom] lock NOT acquired (already locked)', {
                    requestId,
                    roomId,
                    key,
                    ttlMs: effectiveTtl,
                });

                // Importante: NO lanzamos error, devolvemos un lock "no-op"
                return {
                    async release() {
                        // nada que hacer
                    },
                };
            }

            // Lock adquirido correctamente
            console.debug('[lockRoom] lock acquired', {
                requestId,
                roomId,
                key,
                ttlMs: effectiveTtl,
            });

            // Devolvemos un objeto con release(), similar a Redlock
            return {
                async release() {
                    try {
                        const current = await redisClient.get(key);
                        if (current === token) {
                            await redisClient.del(key);
                            console.debug('[lockRoom] lock released', {
                                requestId,
                                roomId,
                                key,
                            });
                        } else {
                            // Otro proceso renovó/cambió el lock: no lo tocamos
                            console.debug(
                                '[lockRoom] lock token changed, not deleting',
                                { requestId, roomId, key }
                            );
                        }
                    } catch (err) {
                        console.warn('[lockRoom] release failed (ignored)', {
                            requestId,
                            roomId,
                            key,
                            error: err.message,
                        });
                    }
                },
            };
        } catch (err) {
            // Cualquier fallo de Redis en dev/EC2: no tumbar la operación
            console.error('[lockRoom] error while trying to lock (fallback no-op)', {
                requestId,
                roomId,
                key,
                ttlMs: effectiveTtl,
                error: err.message,
            });

            // Fallback no-op: NO lanzamos error, para que play/pause sigan funcionando
            return {
                async release() {
                    // no-op
                },
            };
        }
    },


    async publish(channel, message) {
        const messageWithMeta = {
            ...message,
            _meta: {
                requestId: getRequestId(),
                timestamp: Date.now(),
            },
        };
        await pubClient.publish(channel, JSON.stringify(messageWithMeta));
    },

    async subscribe(pattern, handler) {
        // NOTE: Subscribe to Redis pub/sub with pattern matching
        // Returns unsubscribe function for clean shutdown
        await subClient.pSubscribe(pattern, (message, channel) => {
            try {
                const parsed = JSON.parse(message);
                handler(parsed, channel);
            } catch (error) {
                console.error('[subscribe] Handler error', {
                    requestId: parsed?._meta?.requestId || getRequestId(),
                    pattern,
                    channel,
                    error: error.message,
                });
            }
        });

        // Return unsubscribe function for cleanup
        return async () => {
            try {
                await subClient.pUnsubscribe(pattern);
            } catch (err) {
                console.warn('[subscribe] Failed to pUnsubscribe', {
                    pattern,
                    error: err.message,
                });
            }
        };
    },

    computeCurrentPosition(state, nowMs = Date.now()) {
        // NOTE: Defensive computation to prevent NaN, negative values, or infinity
        if (!state) {
            return 0;
        }

        const playbackRate = toNumber(state.playbackRate, 1);
        const basePositionMs = toNumber(state.basePositionMs, 0);
        const baseServerTimeMs = toNumber(state.baseServerTimeMs, nowMs);

        // Clamp playbackRate to sane values
        const clampedRate = Math.max(0, Math.min(playbackRate, 10));

        if (state.playbackState === 'playing') {
            const delta = nowMs - baseServerTimeMs;
            const position = basePositionMs + delta * clampedRate;

            // Ensure we never return negative position or NaN
            if (!Number.isFinite(position)) {
                return Math.max(0, basePositionMs);
            }

            return Math.max(0, position);
        }

        // Paused: return base position (no advancement)
        return Math.max(0, basePositionMs);
    },
};
