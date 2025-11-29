// src/services/authService.js
import { RedisService } from './redisService.js';
import { queueMembershipClient } from './queueMembershipClient.js';
import { isSafeId } from '../utils/idValidator.js';

// Cache en memoria de quién es host por roomId (modo legacy basado en Redis)
const hostCache = new Map();
const HOST_CACHE_TTL_MS = 1000; // 1 segundo

class AuthError extends Error {
    constructor(message, code, status) {
        super(message);
        this.code = code;
        this.status = status;
    }
}


const cacheGet = (roomId) => {
    const entry = hostCache.get(roomId);
    if (!entry) return null;

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


function validatePlaybackControlParams(roomId, accessToken) {
    if (!isSafeId(roomId)) {
        throw new AuthError('Invalid roomId', 'INVALID_ROOM_ID', 400);
    }

    if (!accessToken) {
        throw new AuthError('Missing access token', 'UNAUTHORIZED', 401);
    }
}

function mapQueueMembershipClientError(err) {
    if (err && err.response) {
        const { status, data } = err.response;

        if (status === 404) {
            throw new AuthError(
                'Membership not found',
                'MEMBERSHIP_NOT_FOUND',
                404,
            );
        }

        if (status === 401) {
            throw new AuthError('Unauthorized', 'UNAUTHORIZED', 401);
        }

        if (status === 403) {
            throw new AuthError('Forbidden', 'FORBIDDEN', 403);
        }

        throw new AuthError(
            (data && data.message) || 'Queue service error',
            'QUEUE_SERVICE_ERROR',
            status,
        );
    }

    if (err && (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT')) {
        throw new AuthError(
            'Queue service unavailable',
            'QUEUE_SERVICE_UNAVAILABLE',
            503,
        );
    }

    throw new AuthError(
        (err && err.message) || 'Unknown auth error',
        'AUTH_UNKNOWN_ERROR',
        500,
    );
}


export const AuthService = {
    /**
     * MODO LEGACY (basado en Redis):
     *
     * Primer usuario que manda play/pause/seek/changeTrack en esa room
     * se convierte en host (se guarda en Redis). Luego sólo ese userId
     * puede controlar la sala.
     *
     * Esto se mantiene por compatibilidad, pero el flujo nuevo usa
     * room_members + JWT vía ensureCanControlPlayback.
     */
    async canControlRoom(userId, roomId) {
        if (!isSafeId(userId) || !isSafeId(roomId)) {
            return false;
        }

        let hostUserId = await fetchHostUserId(roomId);

        // Si aún no hay host, intenta fijar este user como host
        if (!hostUserId) {
            await RedisService.setRoomHostIfEmpty(roomId, userId);
            hostUserId = await RedisService.getRoomHost(roomId);
            cacheSet(roomId, hostUserId);

            // Si por lo que sea sigue sin host, dejamos pasar a este usuario
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

    /**
     * Se llama cuando un socket se desconecta y esa instancia podría liberar el host.
     * (Sólo aplica al modo legacy basado en Redis).
     */
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

    /**
     * Flujo nuevo (el que nos interesa ahora):
     *
     * Verifica que el usuario (a través de su accessToken / jr_token) tenga permiso
     * para controlar la reproducción en una sala según `room_members` en
     * el queue-service.
     *
     * Regla:
     *  - Si roles incluye 'host'  -> OK
     *  - O si can_control_playback = true -> OK
     *
     * Retorna el registro de membership.
     * Lanza AuthError con .code y .status para que el caller lo mapee.
     */
    async ensureCanControlPlayback({ accessToken, roomId }) {
        // Validación de parámetros extraída a helper
        validatePlaybackControlParams(roomId, accessToken);

        let membership;
        try {
            membership = await queueMembershipClient.getMyMembership({
                roomId,
                accessToken,
            });
        } catch (err) {
            // Lógica de mapeo de errores extraída a helper
            mapQueueMembershipClientError(err);
        }

        const roles = membership.roles || [];
        const isHost = Array.isArray(roles) && roles.includes('host');
        const canControl = isHost || !!membership.can_control_playback;

        if (!canControl) {
            throw new AuthError(
                'User cannot control playback in this room',
                'ROOM_CONTROL_FORBIDDEN',
                403,
            );
        }

        return membership;
    },
};
