import axios from 'axios';

// Timeout duro en ms para no colgar el sync-service si Railway se demora
const DEFAULT_TIMEOUT_MS = 3000;

const QUEUE_BASE_URL =
    process.env.QUEUE_SERVICE_URL ||
    'https://jamroom-queue-service-production.up.railway.app';

/**
 * Obtiene la membresía del usuario autenticado (via accessToken / jr_token)
 * en una sala dada: GET /api/rooms/:roomId/members/me
 *
 * Retorna el JSON de membership si status 2xx.
 * Si status no es 2xx → lanza Error con err.response para que AuthService lo mapee.
 */
async function getMyMembership({ roomId, accessToken }) {
    if (!roomId || typeof roomId !== 'string' || !roomId.trim()) {
        const err = new Error('Invalid roomId');
        err.code = 'INVALID_ROOM_ID';
        throw err;
    }

    if (!accessToken) {
        const err = new Error('Missing access token');
        err.code = 'MISSING_ACCESS_TOKEN';
        throw err;
    }

    const url = `${QUEUE_BASE_URL}/api/rooms/${encodeURIComponent(
        roomId,
    )}/members/me`;

    try {
        const res = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
            timeout: DEFAULT_TIMEOUT_MS,
        });

        return res.data;
    } catch (error) {
        if (error.response) {
            console.warn('[queueMembershipClient] getMyMembership non-2xx', {
                roomId,
                status: error.response.status,
                data: error.response.data,
            });
        } else {
            console.warn('[queueMembershipClient] getMyMembership error', {
                roomId,
                message: error.message,
            });
        }

        // Dejamos que AuthService haga el mapping
        throw error;
    }
}

/**
 * Opcional: asegura que el usuario autenticado tenga fila en room_members
 * vía POST /api/rooms/:roomId/members/ensure
 *
 * Ahora mismo no lo estás usando en AuthService, pero queda listo para el futuro.
 */
async function ensureMyMembership({ roomId, accessToken }) {
    if (!roomId || typeof roomId !== 'string' || !roomId.trim()) {
        const err = new Error('Invalid roomId');
        err.code = 'INVALID_ROOM_ID';
        throw err;
    }

    if (!accessToken) {
        const err = new Error('Missing access token');
        err.code = 'MISSING_ACCESS_TOKEN';
        throw err;
    }

    const url = `${QUEUE_BASE_URL}/api/rooms/${encodeURIComponent(
        roomId,
    )}/members/ensure`;

    try {
        const res = await axios.post(
            url,
            {},
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
                timeout: DEFAULT_TIMEOUT_MS,
            },
        );

        return res.data;
    } catch (error) {
        if (error.response) {
            console.warn('[queueMembershipClient] ensureMyMembership non-2xx', {
                roomId,
                status: error.response.status,
                data: error.response.data,
            });
        } else {
            console.warn('[queueMembershipClient] ensureMyMembership error', {
                roomId,
                message: error.message,
            });
        }

        throw error;
    }
}

export const queueMembershipClient = {
    getMyMembership,
    ensureMyMembership,
};
