import { RedisService } from './redisService.js';
import { isSafeId } from '../utils/idValidator.js';

const hostCache = new Map();
const HOST_CACHE_TTL_MS = 1000;

const cacheGet = (roomId) => {
    const entry = hostCache.get(roomId);
    if (!entry) {
        return null;
    }
    if (Date.now() > entry.expiresAtMs) {
        hostCache.delete(roomId);
        return null;
    }
    return entry.hostUserId;
};

const cacheSet = (roomId, hostUserId) => {
    hostCache.set(roomId, {
        hostUserId: hostUserId ?? '__NONE__',
        expiresAtMs: Date.now() + HOST_CACHE_TTL_MS,
    });
};

const fetchHostUserId = async (roomId) => {
    const cached = cacheGet(roomId);
    if (cached !== null && cached !== undefined) {
        return cached === '__NONE__' ? null : cached;
    }

    const hostUserId = await RedisService.getRoomHost(roomId);
    cacheSet(roomId, hostUserId);
    return hostUserId || null;
};

export const AuthService = {
    async canControlRoom(userId, roomId) {
        if (!isSafeId(userId) || !isSafeId(roomId)) {
            return false;
        }

        let hostUserId = await fetchHostUserId(roomId);

        if (!hostUserId) {
            await RedisService.setRoomHostIfEmpty(roomId, userId);
            hostUserId = await RedisService.getRoomHost(roomId);
            cacheSet(roomId, hostUserId);
            if (!hostUserId) {
                return true;
            }
        }

        return hostUserId === userId;
    },

    async getHostUserId(roomId) {
        if (!isSafeId(roomId)) {
            return null;
        }
        const hostUserId = await fetchHostUserId(roomId);
        return hostUserId || null;
    },

    async maybeReleaseHost(roomId, userId) {
        if (!isSafeId(roomId) || !isSafeId(userId)) {
            return false;
        }

        const currentHost = await fetchHostUserId(roomId);
        if (!currentHost || currentHost !== userId) {
            return false;
        }

        await RedisService.clearRoomHost(roomId);
        cacheSet(roomId, null);

        return true;
    },
};
