import axios from 'axios';


const RAW_BASE_URL = process.env.QUEUE_SERVICE_URL || 'http://localhost:3000';
const BASE_URL = RAW_BASE_URL.replace(/\/+$/, '');

// Timeout duro en ms para no colgar el sync-service si Railway se demora
const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Pequeño wrapper para hacer requests al queue-service
 * con Authorization: Bearer <accessToken>.
 *
 * NO lanza por status HTTP (usa validateStatus), pero
 * SÍ lanza si hay error de red / timeout.
 */
async function queueRequest({ method, path, accessToken, data }) {
    const url = `${BASE_URL}${path}`;
    const headers = {};

    if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`;
    }

    try {
        const res = await axios({
            method,
            url,
            headers,
            data,
            timeout: DEFAULT_TIMEOUT_MS,
            // Dejamos que el caller decida si status es "éxito" o no
            validateStatus: () => true,
        });

        return res;
    } catch (err) {
        // Errores de red / timeout / DNS
        // Importante: preservar err.code para que AuthService lo pueda mapear.
        console.error('[queueMembershipClient] network error', {
            url,
            method,
            code: err.code,
            message: err.message,
        });
        throw err;
    }
}

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

    const res = await queueRequest({
        method: 'get',
        path,
        accessToken,
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

    const res = await queueRequest({
        method: 'post',
        path,
        accessToken,
        data: {}, // body vacío
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
