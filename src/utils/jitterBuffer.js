/**
 * Jitter Buffer and Network Quality Estimation
 * 
 * Provides intelligent buffering and network quality tracking
 * for music synchronization with slow/unstable connections.
 * 
 * Features:
 * - Per-client jitter tracking with exponential moving average
 * - RTT estimation for latency compensation
 * - Connection quality classification
 * - Adaptive sync parameters based on network conditions
 * 
 * @module jitterBuffer
 */

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * @typedef {'excellent' | 'good' | 'fair' | 'poor' | 'critical'} ConnectionQuality
 */

const QUALITY_THRESHOLDS = {
    excellent: { jitterMs: 30, rttMs: 100 },
    good: { jitterMs: 60, rttMs: 200 },
    fair: { jitterMs: 120, rttMs: 400 },
    poor: { jitterMs: 250, rttMs: 800 },
    // Above poor = critical
};

// Exponential moving average smoothing factor (0-1)
// Higher = more weight to recent values
const EMA_ALPHA = 0.3;

// Maximum samples to keep for statistics
const MAX_SAMPLES = 50;

// Minimum samples needed for reliable quality estimation
const MIN_SAMPLES_FOR_ESTIMATION = 3;

// ============================================================================
// CLIENT STATE
// ============================================================================

/**
 * @typedef {Object} ClientNetworkState
 * @property {number[]} jitterSamples - Recent jitter samples
 * @property {number[]} rttSamples - Recent RTT samples
 * @property {number} emaJitter - Exponential moving average of jitter
 * @property {number} emaRtt - Exponential moving average of RTT
 * @property {number} lastUpdateTime - Last update timestamp
 * @property {ConnectionQuality} quality - Current quality classification
 * @property {number} sampleCount - Total samples received
 */

/**
 * Per-client network state
 * @type {Map<string, ClientNetworkState>}
 */
const clientStates = new Map();

/**
 * Creates a new client state
 * @returns {ClientNetworkState}
 */
function createClientState() {
    return {
        jitterSamples: [],
        rttSamples: [],
        emaJitter: 0,
        emaRtt: 0,
        lastUpdateTime: Date.now(),
        quality: 'good',
        sampleCount: 0,
    };
}

// ============================================================================
// CORE FUNCTIONS
// ============================================================================

/**
 * Records a jitter sample for a client
 * 
 * @param {string} clientId - Socket ID or user ID
 * @param {number} jitterMs - Jitter value in milliseconds
 * @param {number} [rttMs] - Optional RTT value in milliseconds
 */
export function recordJitterSample(clientId, jitterMs, rttMs) {
    if (!Number.isFinite(jitterMs) || jitterMs < 0) {
        return;
    }

    let state = clientStates.get(clientId);
    if (!state) {
        state = createClientState();
        clientStates.set(clientId, state);
    }

    const now = Date.now();
    state.lastUpdateTime = now;
    state.sampleCount++;

    // Update jitter samples
    state.jitterSamples.push(jitterMs);
    if (state.jitterSamples.length > MAX_SAMPLES) {
        state.jitterSamples.shift();
    }

    // Update EMA jitter
    if (state.sampleCount === 1) {
        state.emaJitter = jitterMs;
    } else {
        state.emaJitter = EMA_ALPHA * jitterMs + (1 - EMA_ALPHA) * state.emaJitter;
    }

    // Update RTT if provided
    if (Number.isFinite(rttMs) && rttMs >= 0) {
        state.rttSamples.push(rttMs);
        if (state.rttSamples.length > MAX_SAMPLES) {
            state.rttSamples.shift();
        }

        if (state.sampleCount === 1) {
            state.emaRtt = rttMs;
        } else {
            state.emaRtt = EMA_ALPHA * rttMs + (1 - EMA_ALPHA) * state.emaRtt;
        }
    }

    // Recalculate quality
    state.quality = calculateQuality(state.emaJitter, state.emaRtt);
}

/**
 * Records an RTT measurement for a client
 * 
 * @param {string} clientId - Socket ID or user ID
 * @param {number} rttMs - RTT value in milliseconds
 */
export function recordRttSample(clientId, rttMs) {
    if (!Number.isFinite(rttMs) || rttMs < 0) {
        return;
    }

    let state = clientStates.get(clientId);
    if (!state) {
        state = createClientState();
        clientStates.set(clientId, state);
    }

    state.rttSamples.push(rttMs);
    if (state.rttSamples.length > MAX_SAMPLES) {
        state.rttSamples.shift();
    }

    if (state.rttSamples.length === 1) {
        state.emaRtt = rttMs;
    } else {
        state.emaRtt = EMA_ALPHA * rttMs + (1 - EMA_ALPHA) * state.emaRtt;
    }

    state.lastUpdateTime = Date.now();
    state.quality = calculateQuality(state.emaJitter, state.emaRtt);
}

/**
 * Gets the network state for a client
 * 
 * @param {string} clientId
 * @returns {ClientNetworkState | null}
 */
export function getClientNetworkState(clientId) {
    return clientStates.get(clientId) || null;
}

/**
 * Gets the connection quality for a client
 * 
 * @param {string} clientId
 * @returns {ConnectionQuality}
 */
export function getConnectionQuality(clientId) {
    const state = clientStates.get(clientId);
    return state?.quality || 'good';
}

/**
 * Gets the estimated jitter for a client
 * 
 * @param {string} clientId
 * @returns {number} Estimated jitter in ms (0 if unknown)
 */
export function getEstimatedJitter(clientId) {
    const state = clientStates.get(clientId);
    if (!state || state.sampleCount < MIN_SAMPLES_FOR_ESTIMATION) {
        return 0;
    }
    return Math.round(state.emaJitter);
}

/**
 * Gets the estimated RTT for a client
 * 
 * @param {string} clientId
 * @returns {number} Estimated RTT in ms (0 if unknown)
 */
export function getEstimatedRtt(clientId) {
    const state = clientStates.get(clientId);
    if (!state || state.rttSamples.length < MIN_SAMPLES_FOR_ESTIMATION) {
        return 0;
    }
    return Math.round(state.emaRtt);
}

/**
 * Removes network state for a client
 * 
 * @param {string} clientId
 */
export function removeClient(clientId) {
    clientStates.delete(clientId);
}

// ============================================================================
// QUALITY CALCULATION
// ============================================================================

/**
 * Calculates connection quality from jitter and RTT
 * 
 * @param {number} jitterMs
 * @param {number} rttMs
 * @returns {ConnectionQuality}
 */
function calculateQuality(jitterMs, rttMs) {
    // Score based on both metrics
    const jitterScore = getJitterScore(jitterMs);
    const rttScore = getRttScore(rttMs);
    
    // Use the worse of the two scores
    const combinedScore = Math.min(jitterScore, rttScore);
    
    if (combinedScore >= 4) return 'excellent';
    if (combinedScore >= 3) return 'good';
    if (combinedScore >= 2) return 'fair';
    if (combinedScore >= 1) return 'poor';
    return 'critical';
}

function getJitterScore(jitterMs) {
    if (jitterMs <= QUALITY_THRESHOLDS.excellent.jitterMs) return 4;
    if (jitterMs <= QUALITY_THRESHOLDS.good.jitterMs) return 3;
    if (jitterMs <= QUALITY_THRESHOLDS.fair.jitterMs) return 2;
    if (jitterMs <= QUALITY_THRESHOLDS.poor.jitterMs) return 1;
    return 0;
}

function getRttScore(rttMs) {
    if (rttMs <= QUALITY_THRESHOLDS.excellent.rttMs) return 4;
    if (rttMs <= QUALITY_THRESHOLDS.good.rttMs) return 3;
    if (rttMs <= QUALITY_THRESHOLDS.fair.rttMs) return 2;
    if (rttMs <= QUALITY_THRESHOLDS.poor.rttMs) return 1;
    return 0;
}

// ============================================================================
// ADAPTIVE SYNC PARAMETERS
// ============================================================================

/**
 * @typedef {Object} SyncParameters
 * @property {number} ignoreThresholdMs - Drift to ignore
 * @property {number} rateThresholdMs - Drift for rate adjustment
 * @property {number} seekThresholdMs - Drift requiring hard seek
 * @property {number} syncIntervalMs - Recommended sync interval
 * @property {boolean} useAggressiveSeek - Whether to prefer seeks over rate
 */

/**
 * Gets recommended sync parameters based on client's connection quality
 * 
 * @param {string} clientId
 * @returns {SyncParameters}
 */
export function getAdaptiveSyncParameters(clientId) {
    const quality = getConnectionQuality(clientId);
    const jitter = getEstimatedJitter(clientId);
    
    // Base parameters (for excellent/good connections)
    const baseParams = {
        ignoreThresholdMs: 60,
        rateThresholdMs: 150,
        seekThresholdMs: 300,
        syncIntervalMs: 1000,
        useAggressiveSeek: false,
    };
    
    switch (quality) {
        case 'excellent':
            return {
                ...baseParams,
                ignoreThresholdMs: 50,
                rateThresholdMs: 120,
                seekThresholdMs: 200,
            };
            
        case 'good':
            return baseParams;
            
        case 'fair':
            return {
                ...baseParams,
                ignoreThresholdMs: 100,
                rateThresholdMs: 200,
                seekThresholdMs: 400,
                syncIntervalMs: 1500,
            };
            
        case 'poor':
            return {
                ignoreThresholdMs: 150,
                rateThresholdMs: 300,
                seekThresholdMs: 600,
                syncIntervalMs: 2000,
                useAggressiveSeek: false, // Rate adjustments more gradual
            };
            
        case 'critical':
            return {
                ignoreThresholdMs: 200,
                rateThresholdMs: 400,
                seekThresholdMs: 1000,
                syncIntervalMs: 3000,
                useAggressiveSeek: true, // Just seek, don't fight it
            };
            
        default:
            return baseParams;
    }
}

/**
 * Calculates the prebuffer time recommendation based on connection quality
 * 
 * @param {string} clientId
 * @returns {number} Recommended prebuffer in ms
 */
export function getRecommendedPrebuffer(clientId) {
    const quality = getConnectionQuality(clientId);
    const jitter = getEstimatedJitter(clientId);
    const rtt = getEstimatedRtt(clientId);
    
    // Base prebuffer on quality
    const qualityBuffer = {
        excellent: 500,
        good: 1000,
        fair: 2000,
        poor: 4000,
        critical: 6000,
    };
    
    // Add jitter-based buffer (2x jitter)
    const jitterBuffer = jitter * 2;
    
    // Add RTT-based buffer
    const rttBuffer = rtt;
    
    const totalBuffer = qualityBuffer[quality] + jitterBuffer + rttBuffer;
    
    // Cap between 500ms and 10s
    return Math.min(10000, Math.max(500, Math.round(totalBuffer)));
}

// ============================================================================
// METRICS AND CLEANUP
// ============================================================================

/**
 * Gets aggregate metrics for all clients
 */
export function getNetworkMetrics() {
    const metrics = {
        totalClients: clientStates.size,
        byQuality: {
            excellent: 0,
            good: 0,
            fair: 0,
            poor: 0,
            critical: 0,
        },
        avgJitter: 0,
        avgRtt: 0,
        maxJitter: 0,
        maxRtt: 0,
    };
    
    let totalJitter = 0;
    let totalRtt = 0;
    let jitterCount = 0;
    let rttCount = 0;
    
    for (const state of clientStates.values()) {
        metrics.byQuality[state.quality]++;
        
        if (state.emaJitter > 0) {
            totalJitter += state.emaJitter;
            jitterCount++;
            metrics.maxJitter = Math.max(metrics.maxJitter, state.emaJitter);
        }
        
        if (state.emaRtt > 0) {
            totalRtt += state.emaRtt;
            rttCount++;
            metrics.maxRtt = Math.max(metrics.maxRtt, state.emaRtt);
        }
    }
    
    metrics.avgJitter = jitterCount > 0 ? Math.round(totalJitter / jitterCount) : 0;
    metrics.avgRtt = rttCount > 0 ? Math.round(totalRtt / rttCount) : 0;
    
    return metrics;
}

/**
 * Cleans up stale client states (older than maxAgeMs)
 * 
 * @param {number} [maxAgeMs=300000] - Maximum age in ms (default 5 min)
 * @returns {number} Number of removed clients
 */
export function cleanupStaleClients(maxAgeMs = 300000) {
    const now = Date.now();
    let removedCount = 0;
    
    for (const [clientId, state] of clientStates) {
        if (now - state.lastUpdateTime > maxAgeMs) {
            clientStates.delete(clientId);
            removedCount++;
        }
    }
    
    return removedCount;
}

/**
 * Clears all client states (for testing)
 */
export function clearAllClientStates() {
    clientStates.clear();
}
