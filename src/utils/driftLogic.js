const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export const RATE_DURATION_MS = 2000;
const MIN_PLAYBACK_RATE = 0.98;
const MAX_PLAYBACK_RATE = 1.02;

const BASE_THRESHOLDS = {
    ignore: 60,
    rate: 150,
    seek: 150,
};

const MID_JITTER_THRESHOLDS = {
    ignore: 100,
    rate: 200,
    seek: 250,
};

const HIGH_JITTER_THRESHOLDS = {
    ignore: 150,
    rate: 250,
    seek: 400,
};

const selectThresholds = (jitterMs) => {
    if (jitterMs > 250) {
        return HIGH_JITTER_THRESHOLDS;
    }
    if (jitterMs > 100) {
        return MID_JITTER_THRESHOLDS;
    }
    return BASE_THRESHOLDS;
};

const isValidNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const buildRateDecision = ({ driftMs, jitterMs, serverExpectedNow }) => {
    const playbackRate = clamp(
        1 + (-driftMs / RATE_DURATION_MS),
        MIN_PLAYBACK_RATE,
        MAX_PLAYBACK_RATE,
    );

    return {
        action: 'rate',
        driftMs,
        serverExpectedNow,
        payload: {
            playbackRate,
            durationMs: RATE_DURATION_MS,
            reason: `drift ${Math.round(driftMs)}ms (jitter ${Math.round(jitterMs)}ms)`,
        },
    };
};

/**
 * Decide how to correct drift for a client.
 * The more jitter we observe, the less aggressive we are with hard seeks, preferring rate adjustments.
 */
export const decideCorrection = ({
    localPositionMs,
    observedServerPositionMs,
    observedServerTimeMs,
    nowServerMs,
    jitterMs = 0,
    clientLagMs = 0, // currently unused but kept for future policies
}) => {
    if (
        !isValidNumber(localPositionMs) ||
        !isValidNumber(observedServerPositionMs) ||
        !isValidNumber(nowServerMs) ||
        !isValidNumber(observedServerTimeMs)
    ) {
        return { action: 'ignore', driftMs: null, serverExpectedNow: null, payload: null };
    }

    const safeJitter = Math.max(0, Number.isFinite(jitterMs) ? jitterMs : 0);
    const thresholds = selectThresholds(safeJitter);

    const serverExpectedNow =
        observedServerPositionMs + (nowServerMs - observedServerTimeMs);
    const driftMs = localPositionMs - serverExpectedNow;
    const absDrift = Math.abs(driftMs);

    if (absDrift <= thresholds.ignore) {
        return {
            action: 'ignore',
            driftMs,
            serverExpectedNow,
            payload: null,
        };
    }

    if (absDrift <= thresholds.rate) {
        return buildRateDecision({ driftMs, jitterMs: safeJitter, serverExpectedNow });
    }

    if (absDrift <= thresholds.seek) {
        return buildRateDecision({ driftMs, jitterMs: safeJitter, serverExpectedNow });
    }

    const positionMs = Math.max(0, Math.round(serverExpectedNow));

    return {
        action: 'seek',
        driftMs,
        serverExpectedNow,
        payload: {
            positionMs,
            serverTimeMs: nowServerMs,
        },
    };
};
