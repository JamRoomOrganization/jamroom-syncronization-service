const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export const RATE_DURATION_MS = 2000;
const MIN_PLAYBACK_RATE = 0.98;
const MAX_PLAYBACK_RATE = 1.02;

// Minimum rate for slow connections (more aggressive correction)
const SLOW_MIN_PLAYBACK_RATE = 0.95;
const SLOW_MAX_PLAYBACK_RATE = 1.05;

const BASE_THRESHOLDS = {
    ignore: 60,
    rate: 150,
    seek: 300,
};

const MID_JITTER_THRESHOLDS = {
    ignore: 100,
    rate: 200,
    seek: 400,
};

const HIGH_JITTER_THRESHOLDS = {
    ignore: 150,
    rate: 300,
    seek: 600,
};

// Critical jitter (very unstable connection)
const CRITICAL_JITTER_THRESHOLDS = {
    ignore: 200,
    rate: 400,
    seek: 1000,
};

/**
 * Selects appropriate thresholds based on jitter level
 * Higher jitter = more tolerance to avoid constant corrections
 * @param {number} jitterMs 
 * @returns {Object}
 */
const selectThresholds = (jitterMs) => {
    if (jitterMs > 400) {
        return CRITICAL_JITTER_THRESHOLDS;
    }
    if (jitterMs > 250) {
        return HIGH_JITTER_THRESHOLDS;
    }
    if (jitterMs > 100) {
        return MID_JITTER_THRESHOLDS;
    }
    return BASE_THRESHOLDS;
};

const isValidNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Determines if connection is "slow" based on combined jitter and lag
 * @param {number} jitterMs 
 * @param {number} clientLagMs 
 * @returns {boolean}
 */
const isSlowConnection = (jitterMs, clientLagMs) => {
    return jitterMs > 200 || clientLagMs > 400;
};

/**
 * Builds a rate adjustment decision with adaptive rate limits
 * @param {Object} params
 * @returns {Object}
 */
const buildRateDecision = ({ driftMs, jitterMs, serverExpectedNow, isSlowClient = false }) => {
    // Use wider rate range for slow connections
    const minRate = isSlowClient ? SLOW_MIN_PLAYBACK_RATE : MIN_PLAYBACK_RATE;
    const maxRate = isSlowClient ? SLOW_MAX_PLAYBACK_RATE : MAX_PLAYBACK_RATE;
    
    // Calculate correction rate
    // For slow clients, apply more gradual correction over longer duration
    const correctionFactor = isSlowClient ? 0.7 : 1.0;
    const effectiveDurationMs = isSlowClient ? RATE_DURATION_MS * 1.5 : RATE_DURATION_MS;
    
    const playbackRate = clamp(
        1 + (-driftMs * correctionFactor / effectiveDurationMs),
        minRate,
        maxRate,
    );

    return {
        action: 'rate',
        driftMs,
        serverExpectedNow,
        payload: {
            playbackRate,
            durationMs: Math.round(effectiveDurationMs),
            reason: `drift ${Math.round(driftMs)}ms (jitter ${Math.round(jitterMs)}ms)${isSlowClient ? ' [slow]' : ''}`,
        },
    };
};

/**
 * Decide how to correct drift for a client.
 * The more jitter we observe, the less aggressive we are with hard seeks, preferring rate adjustments.
 * For slow connections, we use more tolerant thresholds and gentler corrections.
 * 
 * @param {Object} params
 * @param {number} params.localPositionMs - Client's reported position
 * @param {number} params.observedServerPositionMs - Server position at last sync
 * @param {number} params.observedServerTimeMs - Server time at last sync
 * @param {number} params.nowServerMs - Current server time
 * @param {number} [params.jitterMs=0] - Estimated jitter in ms
 * @param {number} [params.clientLagMs=0] - Estimated RTT/lag in ms
 * @returns {Object} Correction decision
 */
export const decideCorrection = ({
    localPositionMs,
    observedServerPositionMs,
    observedServerTimeMs,
    nowServerMs,
    jitterMs = 0,
    clientLagMs = 0,
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
    const safeLag = Math.max(0, Number.isFinite(clientLagMs) ? clientLagMs : 0);
    const thresholds = selectThresholds(safeJitter);
    const slowClient = isSlowConnection(safeJitter, safeLag);

    // Calculate expected server position accounting for lag
    // For slow clients, add half the lag as tolerance
    const lagCompensation = slowClient ? safeLag / 2 : 0;
    
    const serverExpectedNow =
        observedServerPositionMs + (nowServerMs - observedServerTimeMs);
    const driftMs = localPositionMs - serverExpectedNow;
    const compensatedDrift = Math.abs(driftMs) - lagCompensation;
    const absDrift = Math.max(0, compensatedDrift);

    if (absDrift <= thresholds.ignore) {
        return {
            action: 'ignore',
            driftMs,
            serverExpectedNow,
            payload: null,
        };
    }

    // For moderate drift, prefer rate adjustment
    if (absDrift <= thresholds.rate) {
        return buildRateDecision({ 
            driftMs, 
            jitterMs: safeJitter, 
            serverExpectedNow,
            isSlowClient: slowClient,
        });
    }

    // Between rate and seek threshold - still try rate for slow clients
    if (absDrift <= thresholds.seek) {
        if (slowClient) {
            // Slow clients get more rate adjustments before seeking
            return buildRateDecision({ 
                driftMs, 
                jitterMs: safeJitter, 
                serverExpectedNow,
                isSlowClient: true,
            });
        }
        return buildRateDecision({ 
            driftMs, 
            jitterMs: safeJitter, 
            serverExpectedNow,
            isSlowClient: false,
        });
    }

    // Large drift - must seek
    const positionMs = Math.max(0, Math.round(serverExpectedNow));

    return {
        action: 'seek',
        driftMs,
        serverExpectedNow,
        payload: {
            positionMs,
            serverTimeMs: nowServerMs,
            reason: slowClient 
                ? `large drift ${Math.round(driftMs)}ms [slow connection]`
                : undefined,
        },
    };
};
