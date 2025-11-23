import queueClient from '../lib/queueClient.js';

// Timeout duro en ms para no colgar el sync-service si Railway se demora
const DEFAULT_TIMEOUT_MS = 3000;


/**
 * Obtiene la membresía del usuario autenticado (via accessToken)
 * en una sala dada: /api/rooms/:roomId/members/me
 *
 * Retorna el JSON de membership si 2xx.
 * Si status no es 2xx → lanza Error con .response (para que AuthService lo mapee).
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

    const path = `/api/rooms/${encodeURIComponent(roomId)}/members/me`;

    const res = await queueClient.get(path, {
        accessToken,
        timeout: DEFAULT_TIMEOUT_MS,
    });

    if (res.status >= 200 && res.status < 300) {
        return res.data;
    }

    // Construimos un error con contexto, pero MUY importante:
    // adjuntar res en error.response para que AuthService pueda leer status y body.
    const error = new Error(
        `queueService getMyMembership failed with status ${res.status}`,
    );
    error.response = res;
    error.code = 'QUEUE_SERVICE_HTTP_ERROR';

    console.warn('[queueMembershipClient] getMyMembership non-2xx', {
        roomId,
        status: res.status,
        data: res.data,
    });

    throw error;
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

    const path = `/api/rooms/${encodeURIComponent(roomId)}/members/ensure`;

    const res = await queueClient.post(path, {}, {
        accessToken,
        timeout: DEFAULT_TIMEOUT_MS,
    });

    if (res.status >= 200 && res.status < 300) {
        return res.data;
    }

    const error = new Error(
        `queueService ensureMyMembership failed with status ${res.status}`,
    );
    error.response = res;
    error.code = 'QUEUE_SERVICE_HTTP_ERROR';

    console.warn('[queueMembershipClient] ensureMyMembership non-2xx', {
        roomId,
        status: res.status,
        data: res.data,
    });

    throw error;
}

export const queueMembershipClient = {
    getMyMembership,
    ensureMyMembership,
};
