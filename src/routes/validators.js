const isNonEmptyString = (value) =>
    typeof value === 'string' && value.trim().length > 0;

const isNonNegativeNumber = (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;

const normalizePlaybackRate = (value) => {
    if (value === undefined) {
        return { ok: true, value: 1 };
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return { ok: false, error: { field: 'playbackRate', reason: 'invalid' } };
    }
    return { ok: true, value };
};

/**
 * Valida que exista un userId no vacío en el body.
 * Devuelve exactamente el mismo formato de error que las funciones públicas.
 */
const validateUserIdField = (body) => {
    if (!isNonEmptyString(body.userId)) {
        return { ok: false, error: { field: 'userId', reason: 'required' } };
    }
    return { ok: true };
};

/**
 * Lógica común a validatePlayBody y validateTrackBody.
 * Mantiene exactamente la misma estructura de retorno que antes.
 */
const validatePlayOrTrackBody = (body = {}) => {
    const userIdValidation = validateUserIdField(body);
    if (!userIdValidation.ok) {
        return userIdValidation;
    }

    if (!isNonEmptyString(body.trackId)) {
        return { ok: false, error: { field: 'trackId', reason: 'required' } };
    }

    const startPosition =
        body.startPositionMs === undefined ? 0 : body.startPositionMs;

    if (!isNonNegativeNumber(startPosition)) {
        return { ok: false, error: { field: 'startPositionMs', reason: 'invalid' } };
    }

    const playbackRateResult = normalizePlaybackRate(body.playbackRate);
    if (!playbackRateResult.ok) {
        return playbackRateResult;
    }

    return {
        ok: true,
        data: {
            userId: body.userId.trim(),
            trackId: body.trackId.trim(),
            startPositionMs: startPosition,
            playbackRate: playbackRateResult.value,
        },
    };
};

export function validatePlayBody(body = {}) {
    return validatePlayOrTrackBody(body);
}

export function validatePauseBody(body = {}) {
    const userIdValidation = validateUserIdField(body);
    if (!userIdValidation.ok) {
        return userIdValidation;
    }

    return {
        ok: true,
        data: {
            userId: body.userId.trim(),
        },
    };
}

export function validateSeekBody(body = {}) {
    const userIdValidation = validateUserIdField(body);
    if (!userIdValidation.ok) {
        return userIdValidation;
    }

    if (!isNonNegativeNumber(body.positionMs)) {
        return { ok: false, error: { field: 'positionMs', reason: 'invalid' } };
    }

    return {
        ok: true,
        data: {
            userId: body.userId.trim(),
            positionMs: body.positionMs,
        },
    };
}

export function validateTrackBody(body = {}) {
    return validatePlayOrTrackBody(body);
}
