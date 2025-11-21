import { RedisService } from './redisService.js';
import { queueMembershipClient } from './queueMembershipClient.js';
import { isSafeId } from '../utils/idValidator.js';

// Cache en memoria de quién es host por roomId (para no ir a Redis en cada request)
const hostCache = new Map();
const HOST_CACHE_TTL_MS = 1000; // 1 segundo

class AuthError extends Error {
    constructor(message, code, status) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

// ---- utilidades de cache de host (modo actual Redis) ----

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

// ---- API pública ----

export const AuthService = {
    /**
     * MODO ACTUAL (lo que ya tienes funcionando):
     *
     * Primer usuario que manda play/pause/seek/changeTrack en esa room
     * se convierte en host (se guarda en Redis). Luego sólo ese userId
     * puede controlar la sala.
     *
     * Esto es lo que hoy usa syncGateway:
     *   const canControl = await AuthService.canControlRoom(socket.userId, roomId);
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
     *
     *
     * Verifica que el usuario (a través de su accessToken) tenga permiso
     * para controlar la reproducción en una sala según `room_members` en
     * el queue-service.
     *
     * Regla:
     *  - Si roles incluye 'host'  -> OK
     *  - O si can_control_playback = true -> OK
     *
     * Retorna el registro de membership.
     * Lanza AuthError con .code y .status para que el caller lo mapee.
     *
     * NOTA: Por ahora esto NO lo está usando syncGateway,
     * pero ya queda listo para integrarlo cuando pases el JWT
     * en el handshake del socket.
     */
    async ensureCanControlPlayback({ accessToken, roomId }) {
        if (!isSafeId(roomId)) {
            throw new AuthError('Invalid roomId', 'INVALID_ROOM_ID', 400);
        }

        if (!accessToken) {
            throw new AuthError('Missing access token', 'UNAUTHORIZED', 401);
        }

        let membership;
        try {
            membership = await queueMembershipClient.getMyMembership({
                roomId,
                accessToken,
            });
        } catch (err) {
            // Mapeamos errores HTTP del queue-service
            if (err.response) {
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
                    data?.message || 'Queue service error',
                    'QUEUE_SERVICE_ERROR',
                    status,
                );
            }

            if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
                throw new AuthError(
                    'Queue service unavailable',
                    'QUEUE_SERVICE_UNAVAILABLE',
                    503,
                );
            }

            throw new AuthError(
                err.message || 'Unknown auth error',
                'AUTH_UNKNOWN_ERROR',
                500,
            );
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
