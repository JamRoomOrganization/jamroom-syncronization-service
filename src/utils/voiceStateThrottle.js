/**
 * Voice State Throttle Utility
 * 
 * Provides throttling for voice:state broadcasts to prevent
 * excessive network traffic and client-side rendering.
 * 
 * Features:
 * - Per-room throttling with configurable interval
 * - Coalescing of multiple state changes
 * - Immediate emission for critical changes (kick, join)
 * - Metrics tracking for throttled events
 * 
 * @module voiceStateThrottle
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const DEFAULT_THROTTLE_MS = 100; // Default throttle interval
const MIN_THROTTLE_MS = 50;
const MAX_THROTTLE_MS = 1000;

// ============================================================================
// THROTTLE STATE
// ============================================================================

/**
 * @typedef {Object} RoomThrottleState
 * @property {NodeJS.Timeout|null} timer - Pending timer
 * @property {Object|null} pendingState - State to emit
 * @property {number} lastEmitTime - Last emission timestamp
 * @property {number} pendingCount - Number of coalesced updates
 */

/**
 * Per-room throttle state
 * @type {Map<string, RoomThrottleState>}
 */
const roomThrottles = new Map();

/**
 * Global metrics for voice state throttling
 */
const throttleMetrics = {
    totalEmits: 0,
    throttledEmits: 0,
    immediateEmits: 0,
    coalescedUpdates: 0,
};

// ============================================================================
// THROTTLE IMPLEMENTATION
// ============================================================================

/**
 * Gets or creates throttle state for a room
 * @param {string} roomId
 * @returns {RoomThrottleState}
 */
function getThrottleState(roomId) {
    if (!roomThrottles.has(roomId)) {
        roomThrottles.set(roomId, {
            timer: null,
            pendingState: null,
            lastEmitTime: 0,
            pendingCount: 0,
        });
    }
    return roomThrottles.get(roomId);
}

/**
 * Emits voice:state with throttling
 * 
 * @param {Object} io - Socket.IO server instance
 * @param {string} roomId - Room identifier
 * @param {Object} voiceState - Voice state to emit
 * @param {Object} [options] - Throttle options
 * @param {boolean} [options.immediate=false] - Skip throttling (for critical events)
 * @param {number} [options.throttleMs] - Custom throttle interval
 * @param {string} [options.trigger] - What triggered this update (for logging)
 */
export function emitVoiceStateThrottled(io, roomId, voiceState, options = {}) {
    const {
        immediate = false,
        throttleMs = DEFAULT_THROTTLE_MS,
        trigger = 'unknown',
    } = options;

    const roomChannel = `room:${roomId}`;
    const throttleState = getThrottleState(roomId);
    const now = Date.now();

    // Immediate emission for critical events
    if (immediate) {
        flushThrottledState(io, roomId, throttleState);
        
        io.to(roomChannel).emit('voice:state', voiceState);
        throttleState.lastEmitTime = now;
        
        throttleMetrics.totalEmits++;
        throttleMetrics.immediateEmits++;
        
        return;
    }

    // Calculate effective throttle interval
    const effectiveThrottle = Math.min(
        MAX_THROTTLE_MS,
        Math.max(MIN_THROTTLE_MS, throttleMs)
    );

    // Check if we can emit immediately (enough time has passed)
    const timeSinceLastEmit = now - throttleState.lastEmitTime;
    
    if (timeSinceLastEmit >= effectiveThrottle && !throttleState.timer) {
        // Emit immediately
        io.to(roomChannel).emit('voice:state', voiceState);
        throttleState.lastEmitTime = now;
        throttleState.pendingState = null;
        throttleState.pendingCount = 0;
        
        throttleMetrics.totalEmits++;
        
        return;
    }

    // Coalesce with pending state
    throttleState.pendingState = voiceState;
    throttleState.pendingCount++;
    throttleMetrics.coalescedUpdates++;

    // Schedule emission if not already scheduled
    if (!throttleState.timer) {
        const delay = effectiveThrottle - timeSinceLastEmit;
        
        throttleState.timer = setTimeout(() => {
            flushThrottledState(io, roomId, throttleState);
        }, Math.max(0, delay));
        
        throttleMetrics.throttledEmits++;
    }
}

/**
 * Flushes any pending throttled state
 * @param {Object} io - Socket.IO server instance
 * @param {string} roomId - Room identifier
 * @param {RoomThrottleState} throttleState - Current throttle state
 */
function flushThrottledState(io, roomId, throttleState) {
    if (throttleState.timer) {
        clearTimeout(throttleState.timer);
        throttleState.timer = null;
    }

    if (throttleState.pendingState) {
        const roomChannel = `room:${roomId}`;
        io.to(roomChannel).emit('voice:state', throttleState.pendingState);
        
        throttleState.lastEmitTime = Date.now();
        throttleState.pendingState = null;
        throttleState.pendingCount = 0;
        
        throttleMetrics.totalEmits++;
    }
}

/**
 * Cleans up throttle state for a room
 * @param {string} roomId
 */
export function cleanupRoomThrottle(roomId) {
    const throttleState = roomThrottles.get(roomId);
    
    if (throttleState) {
        if (throttleState.timer) {
            clearTimeout(throttleState.timer);
        }
        roomThrottles.delete(roomId);
    }
}

/**
 * Gets throttle metrics
 * @returns {Object}
 */
export function getThrottleMetrics() {
    return {
        ...throttleMetrics,
        activeRooms: roomThrottles.size,
        throttleRate: throttleMetrics.totalEmits > 0
            ? ((throttleMetrics.throttledEmits / throttleMetrics.totalEmits) * 100).toFixed(2) + '%'
            : '0%',
        avgCoalescedPerThrottle: throttleMetrics.throttledEmits > 0
            ? (throttleMetrics.coalescedUpdates / throttleMetrics.throttledEmits).toFixed(2)
            : 0,
    };
}

/**
 * Resets throttle metrics (for testing)
 */
export function resetThrottleMetrics() {
    throttleMetrics.totalEmits = 0;
    throttleMetrics.throttledEmits = 0;
    throttleMetrics.immediateEmits = 0;
    throttleMetrics.coalescedUpdates = 0;
}

/**
 * Clears all throttle state (for testing)
 */
export function clearAllThrottleState() {
    for (const [roomId] of roomThrottles) {
        cleanupRoomThrottle(roomId);
    }
    roomThrottles.clear();
}

// ============================================================================
// ADAPTIVE THROTTLE
// ============================================================================

/**
 * @typedef {Object} AdaptiveThrottleConfig
 * @property {number} minThrottleMs - Minimum throttle interval
 * @property {number} maxThrottleMs - Maximum throttle interval
 * @property {number} targetUpdatesPerSecond - Target update rate
 */

/**
 * Adaptive throttle state per room
 * @type {Map<string, { recentUpdates: number[]; currentThrottleMs: number }>}
 */
const adaptiveState = new Map();

/**
 * Calculates adaptive throttle based on recent activity
 * Higher activity = longer throttle to prevent flooding
 * 
 * @param {string} roomId
 * @param {AdaptiveThrottleConfig} [config]
 * @returns {number} Recommended throttle in ms
 */
export function getAdaptiveThrottle(roomId, config = {}) {
    const {
        minThrottleMs = 50,
        maxThrottleMs = 500,
        targetUpdatesPerSecond = 5,
    } = config;

    let state = adaptiveState.get(roomId);
    if (!state) {
        state = { recentUpdates: [], currentThrottleMs: minThrottleMs };
        adaptiveState.set(roomId, state);
    }

    const now = Date.now();
    
    // Record this update
    state.recentUpdates.push(now);
    
    // Keep only updates from last second
    const oneSecondAgo = now - 1000;
    state.recentUpdates = state.recentUpdates.filter(t => t > oneSecondAgo);
    
    // Calculate current update rate
    const currentRate = state.recentUpdates.length;
    
    // Adjust throttle based on rate
    if (currentRate > targetUpdatesPerSecond * 2) {
        // Way over target, increase throttle significantly
        state.currentThrottleMs = Math.min(
            maxThrottleMs,
            state.currentThrottleMs * 1.5
        );
    } else if (currentRate > targetUpdatesPerSecond) {
        // Over target, increase throttle slightly
        state.currentThrottleMs = Math.min(
            maxThrottleMs,
            state.currentThrottleMs * 1.2
        );
    } else if (currentRate < targetUpdatesPerSecond / 2) {
        // Under target, decrease throttle
        state.currentThrottleMs = Math.max(
            minThrottleMs,
            state.currentThrottleMs * 0.8
        );
    }
    
    return Math.round(state.currentThrottleMs);
}

/**
 * Clears adaptive throttle state for a room
 * @param {string} roomId
 */
export function clearAdaptiveThrottle(roomId) {
    adaptiveState.delete(roomId);
}
