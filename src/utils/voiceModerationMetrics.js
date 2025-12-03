/**
 * Voice Moderation Metrics Module
 * 
 * Lightweight metrics tracking for voice moderation events:
 * - voice:host-mute, voice:host-unmute, voice:host-kick event counts
 * - chatVoice-service call results (success/error)
 * 
 * @module voiceModerationMetrics
 */

// ============================================================================
// METRICS STORAGE
// ============================================================================

/**
 * @typedef {Object} ModerationEventMetrics
 * @property {number} received - Number of events received
 * @property {number} success - Number of successful operations
 * @property {number} error - Number of failed operations
 * @property {number} permissionDenied - Number of permission denied errors
 * @property {number} targetNotInVoice - Number of target not in voice errors
 * @property {number} voiceServiceError - Number of chatVoice-service errors
 */

/**
 * In-memory metrics store for moderation events
 * @type {Map<string, ModerationEventMetrics>}
 */
const moderationMetrics = new Map();

/**
 * Ensures metrics exist for an event type
 * @param {string} eventType - Event type (e.g., 'host-mute', 'host-unmute', 'host-kick')
 * @returns {ModerationEventMetrics}
 */
const ensureMetrics = (eventType) => {
    if (!moderationMetrics.has(eventType)) {
        moderationMetrics.set(eventType, {
            received: 0,
            success: 0,
            error: 0,
            permissionDenied: 0,
            targetNotInVoice: 0,
            voiceServiceError: 0,
        });
    }
    return moderationMetrics.get(eventType);
};

// ============================================================================
// METRICS RECORDING
// ============================================================================

/**
 * Records a moderation event received
 * @param {'host-mute' | 'host-unmute' | 'host-kick'} eventType - Event type
 */
export function recordModerationEventReceived(eventType) {
    const metrics = ensureMetrics(eventType);
    metrics.received++;
}

/**
 * Records a successful moderation operation
 * @param {'host-mute' | 'host-unmute' | 'host-kick'} eventType - Event type
 */
export function recordModerationSuccess(eventType) {
    const metrics = ensureMetrics(eventType);
    metrics.success++;
}

/**
 * Records a failed moderation operation
 * @param {'host-mute' | 'host-unmute' | 'host-kick'} eventType - Event type
 * @param {'permission_denied' | 'target_not_in_voice' | 'voice_service_error' | 'other'} errorType - Error type
 */
export function recordModerationError(eventType, errorType) {
    const metrics = ensureMetrics(eventType);
    metrics.error++;
    
    switch (errorType) {
        case 'permission_denied':
            metrics.permissionDenied++;
            break;
        case 'target_not_in_voice':
            metrics.targetNotInVoice++;
            break;
        case 'voice_service_error':
            metrics.voiceServiceError++;
            break;
        default:
            // Generic error, already counted in metrics.error
            break;
    }
}

// ============================================================================
// METRICS RETRIEVAL
// ============================================================================

/**
 * Gets metrics for a specific moderation event type
 * @param {'host-mute' | 'host-unmute' | 'host-kick'} eventType - Event type
 * @returns {ModerationEventMetrics | null}
 */
export function getModerationMetrics(eventType) {
    return moderationMetrics.get(eventType) || null;
}

/**
 * Gets all moderation metrics
 * @returns {Record<string, ModerationEventMetrics>}
 */
export function getAllModerationMetrics() {
    const result = {};
    for (const [key, value] of moderationMetrics) {
        result[key] = { ...value };
    }
    return result;
}

/**
 * Gets a summary of all moderation metrics
 * @returns {{ totalReceived: number, totalSuccess: number, totalError: number, byType: Record<string, ModerationEventMetrics> }}
 */
export function getModerationMetricsSummary() {
    let totalReceived = 0;
    let totalSuccess = 0;
    let totalError = 0;
    
    const byType = {};
    
    for (const [key, value] of moderationMetrics) {
        totalReceived += value.received;
        totalSuccess += value.success;
        totalError += value.error;
        byType[key] = { ...value };
    }
    
    return {
        totalReceived,
        totalSuccess,
        totalError,
        successRate: totalReceived > 0 ? (totalSuccess / totalReceived * 100).toFixed(2) + '%' : 'N/A',
        byType,
    };
}

/**
 * Resets all moderation metrics (useful for testing)
 */
export function resetModerationMetrics() {
    moderationMetrics.clear();
}

// ============================================================================
// STRUCTURED LOGGING
// ============================================================================

/**
 * Structured log helper for voice moderation operations
 * Format: [voice-moderation] type=<type> result=<result> room=<roomId> target=<targetUserId> moderator=<moderatorUserId> ...
 * 
 * @param {'info' | 'warn' | 'error'} level - Log level
 * @param {Object} params - Log parameters
 * @param {'host-mute' | 'host-unmute' | 'host-kick'} params.type - Moderation type
 * @param {'success' | 'error' | 'permission_denied' | 'target_not_in_voice' | 'voice_service_error'} params.result - Result of the operation
 * @param {string} params.roomId - Room identifier
 * @param {string} [params.targetUserId] - Target user identifier
 * @param {string} [params.moderatorUserId] - Moderator user identifier
 * @param {string} [params.requestId] - Request/correlation ID
 * @param {string} [params.socketId] - Socket ID
 * @param {number} [params.latencyMs] - Operation latency in ms
 * @param {string} [params.error] - Error message
 * @param {string} [params.reason] - Moderation reason
 */
export function logModeration(level, {
    type,
    result,
    roomId,
    targetUserId,
    moderatorUserId,
    requestId,
    socketId,
    latencyMs,
    error,
    reason,
}) {
    const parts = ['[voice-moderation]'];
    
    parts.push(`type=${type}`);
    parts.push(`result=${result}`);
    
    if (roomId) parts.push(`room=${roomId}`);
    if (targetUserId) parts.push(`target=${targetUserId}`);
    if (moderatorUserId) parts.push(`moderator=${moderatorUserId}`);
    if (requestId) parts.push(`request_id=${requestId}`);
    if (socketId) parts.push(`socket_id=${socketId}`);
    if (latencyMs !== undefined) parts.push(`latency_ms=${latencyMs}`);
    if (reason) parts.push(`reason=${reason}`);
    if (error) parts.push(`error=${error}`);
    
    const message = parts.join(' ');
    
    if (level === 'error') {
        console.error(message);
    } else if (level === 'warn') {
        console.warn(message);
    } else {
        console.log(message);
    }
}

// ============================================================================
// EXPORTS
// ============================================================================

export const voiceModerationMetrics = {
    recordModerationEventReceived,
    recordModerationSuccess,
    recordModerationError,
    getModerationMetrics,
    getAllModerationMetrics,
    getModerationMetricsSummary,
    resetModerationMetrics,
    logModeration,
};
