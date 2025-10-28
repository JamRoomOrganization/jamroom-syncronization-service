const isNonEmptyString = (value) =>
    typeof value === 'string' && value.trim().length > 0;

const isNonNegativeNumber = (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;

const normalizePlaybackRate = (value) => {
    if (value === undefined) {
        return 1;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return { ok: false, error: { field: 'playbackRate', reason: 'invalid' } };
    }
    return { ok: true, value };
};

export function validatePlayBody(body = {}) {
    if (!isNonEmptyString(body.userId)) {
        return { ok: false, error: { field: 'userId', reason: 'required' } };
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
}

export function validatePauseBody(body = {}) {
    if (!isNonEmptyString(body.userId)) {
        return { ok: false, error: { field: 'userId', reason: 'required' } };
    }

    return {
        ok: true,
        data: {
            userId: body.userId.trim(),
        },
    };
}

export function validateSeekBody(body = {}) {
    if (!isNonEmptyString(body.userId)) {
        return { ok: false, error: { field: 'userId', reason: 'required' } };
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
    if (!isNonEmptyString(body.userId)) {
        return { ok: false, error: { field: 'userId', reason: 'required' } };
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
}
