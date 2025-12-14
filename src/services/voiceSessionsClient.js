/**
 * Voice Sessions Client
 * 
 * HTTP client for communicating with the chatVoice-service.
 * Handles creating, deleting, and listing voice sessions.
 * 
 * Features:
 * - Metrics tracking (success/error counts, latency percentiles)
 * - Structured logging with operation context
 * - Retry logic for read operations
 * - Timeout handling with AbortController
 * - Standardized error codes from voiceErrors catalog
 * - Circuit breaker for graceful degradation
 */

import { voiceServiceConfig } from '../config/voiceServiceConfig.js';
import {
    VoiceError,
    VoiceErrorCode,
    mapHttpStatusToVoiceErrorCode,
    mapServiceErrorToVoiceErrorCode,
    wrapAsVoiceError,
} from '../voice/voiceErrors.js';
import { voiceServiceCircuit } from '../utils/circuitBreaker.js';
import { retryWithBackoff, voiceServiceRetryOptions } from '../utils/retryWithBackoff.js';

// ============================================================================
// METRICS TRACKING
// ============================================================================

/**
 * @typedef {Object} OperationMetrics
 * @property {number} successCount - Number of successful operations
 * @property {number} errorCount - Number of failed operations
 * @property {number[]} latencies - Array of latency samples in ms (capped)
 */

const MAX_LATENCY_SAMPLES = 1000;

/**
 * In-memory metrics store for voice client operations
 * @type {Map<string, OperationMetrics>}
 */
const metricsStore = new Map();

/**
 * Ensures metrics exist for an operation
 * @param {string} operation - Operation name
 * @returns {OperationMetrics}
 */
const ensureMetrics = (operation) => {
    if (!metricsStore.has(operation)) {
        metricsStore.set(operation, {
            successCount: 0,
            errorCount: 0,
            latencies: [],
        });
    }
    return metricsStore.get(operation);
};

/**
 * Records an operation result (success or error)
 * @param {string} operation - Operation name
 * @param {number} latencyMs - Latency in milliseconds
 * @param {boolean} isSuccess - Whether the operation was successful
 */
const recordMetric = (operation, latencyMs, isSuccess) => {
    const metrics = ensureMetrics(operation);
    if (isSuccess) {
        metrics.successCount++;
    } else {
        metrics.errorCount++;
    }
    metrics.latencies.push(latencyMs);
    if (metrics.latencies.length > MAX_LATENCY_SAMPLES) {
        metrics.latencies.shift();
    }
};

/** Shorthand for recording success */
const recordSuccess = (operation, latencyMs) => recordMetric(operation, latencyMs, true);

/** Shorthand for recording error */
const recordError = (operation, latencyMs) => recordMetric(operation, latencyMs, false);

/**
 * Calculates percentile from sorted array
 * @param {number[]} sortedValues - Sorted array of values
 * @param {number} percentile - Percentile (0-100)
 * @returns {number}
 */
const calculatePercentile = (sortedValues, percentile) => {
    if (sortedValues.length === 0) return 0;
    const index = Math.ceil((percentile / 100) * sortedValues.length) - 1;
    return sortedValues[Math.max(0, index)];
};

/**
 * Gets metrics snapshot for an operation
 * @param {string} operation - Operation name
 * @returns {{ successCount: number, errorCount: number, avgLatencyMs: number, p95LatencyMs: number, p99LatencyMs: number } | null}
 */
export function getOperationMetrics(operation) {
    const metrics = metricsStore.get(operation);
    if (!metrics) return null;

    const sortedLatencies = [...metrics.latencies].sort((a, b) => a - b);
    const avgLatencyMs = sortedLatencies.length > 0
        ? sortedLatencies.reduce((a, b) => a + b, 0) / sortedLatencies.length
        : 0;

    return {
        successCount: metrics.successCount,
        errorCount: metrics.errorCount,
        avgLatencyMs: Math.round(avgLatencyMs * 100) / 100,
        p95LatencyMs: calculatePercentile(sortedLatencies, 95),
        p99LatencyMs: calculatePercentile(sortedLatencies, 99),
    };
}

/**
 * Gets all metrics as a snapshot
 * @returns {Record<string, ReturnType<typeof getOperationMetrics>>}
 */
export function getAllMetrics() {
    const snapshot = {};
    for (const operation of metricsStore.keys()) {
        snapshot[operation] = getOperationMetrics(operation);
    }
    return snapshot;
}

/**
 * Resets all metrics (useful for testing)
 */
export function resetMetrics() {
    metricsStore.clear();
}

// ============================================================================
// CUSTOM ERROR (LEGACY - for backwards compatibility)
// ============================================================================

/**
 * Custom error for voice service failures
 * @deprecated Use VoiceError from voiceErrors.js instead
 * 
 * This class is kept for backwards compatibility with existing code.
 * Internally it maps to the new VoiceError codes.
 */
class VoiceServiceError extends Error {
    /**
     * @param {string} message - Error message
     * @param {string} code - Error code (e.g., 'VOICE_SERVICE_ERROR', 'VOICE_SERVICE_UNAVAILABLE')
     * @param {number} [status] - HTTP status code
     * @param {string} [details] - Additional error details
     */
    constructor(message, code, status, details) {
        super(message);
        this.name = 'VoiceServiceError';
        this.code = code;
        this.status = status;
        this.details = details;
        
        // Add VoiceError-compatible properties for easier migration
        this.retryable = code === 'VOICE_SERVICE_ERROR' || code === 'VOICE_SERVICE_TIMEOUT';
        this.uiMessage = this._getUiMessage(code);
    }
    
    /**
     * Gets UI message based on error code
     * @private
     */
    _getUiMessage(code) {
        const messages = {
            'VOICE_SERVICE_UNAVAILABLE': 'El servicio de voz no está disponible.',
            'VOICE_SERVICE_ERROR': 'Error en el servicio de voz. Inténtalo de nuevo.',
            'VOICE_SERVICE_TIMEOUT': 'El servicio de voz tardó demasiado. Inténtalo de nuevo.',
        };
        return messages[code] || 'Ocurrió un error inesperado.';
    }
    
    /**
     * Converts to VoiceError for unified handling
     * @returns {VoiceError}
     */
    toVoiceError() {
        const codeMapping = {
            'VOICE_SERVICE_UNAVAILABLE': VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE,
            'VOICE_SERVICE_ERROR': VoiceErrorCode.VOICE_INTERNAL_ERROR,
            'VOICE_SERVICE_TIMEOUT': VoiceErrorCode.VOICE_SERVICE_TIMEOUT,
        };
        
        return new VoiceError(codeMapping[this.code] || VoiceErrorCode.VOICE_INTERNAL_ERROR, {
            message: this.message,
            cause: this,
            context: { status: this.status, details: this.details },
        });
    }
    
    /**
     * Creates a payload for socket emission (VoiceError compatible)
     * @returns {Object}
     */
    toSocketPayload() {
        return {
            code: this.code,
            message: this.message,
            uiMessage: this.uiMessage,
            retryable: this.retryable,
        };
    }
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/**
 * Parses error response from chatVoice-service
 * @param {string} errorText - Raw error text from response
 * @returns {{ code?: string, message?: string }}
 */
const parseServiceError = (errorText) => {
    try {
        const parsed = JSON.parse(errorText);
        return {
            code: parsed.error?.code || parsed.code,
            message: parsed.error?.message || parsed.message,
        };
    } catch {
        return { message: errorText };
    }
};

/**
 * Creates a VoiceError from HTTP response
 * @param {number} status - HTTP status code
 * @param {string} errorText - Raw error text
 * @param {Object} context - Additional context
 * @returns {VoiceError}
 */
const createVoiceErrorFromResponse = (status, errorText, context = {}) => {
    const parsed = parseServiceError(errorText);
    
    // First try to map service error code
    let errorCode;
    if (parsed.code) {
        errorCode = mapServiceErrorToVoiceErrorCode(parsed.code);
    } else {
        errorCode = mapHttpStatusToVoiceErrorCode(status);
    }
    
    return new VoiceError(errorCode, {
        message: parsed.message || `HTTP ${status}`,
        context: {
            ...context,
            status,
            serviceCode: parsed.code,
        },
    });
};

/**
 * Validates that the voice service is available
 * @throws {VoiceError} If the voice service is not configured
 */
const ensureServiceAvailable = () => {
    if (!voiceServiceConfig.isAvailable) {
        throw new VoiceError(VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE, {
            message: 'Voice service is not configured',
        });
    }
};

/**
 * Gets common headers for all voice service requests
 * Includes x-internal-api-key for service-to-service authentication
 * @param {Object} [additionalHeaders] - Additional headers to merge
 * @returns {Record<string, string>}
 */
const getCommonHeaders = (additionalHeaders = {}) => {
    const headers = { ...additionalHeaders };
    
    // Add internal API key for service-to-service auth
    if (voiceServiceConfig.internalApiKey) {
        headers['x-internal-api-key'] = voiceServiceConfig.internalApiKey;
    }
    
    return headers;
};

/**
 * Creates a fetch request with timeout using AbortController
 * @param {string} url - The URL to fetch
 * @param {RequestInit} options - Fetch options
 * @param {number} [timeoutMs] - Optional custom timeout
 * @returns {Promise<Response>}
 */
const fetchWithTimeout = async (url, options = {}, timeoutMs = voiceServiceConfig.timeoutMs) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal,
        });
        return response;
    } finally {
        clearTimeout(timeoutId);
    }
};

/**
 * Structured log helper for voice client operations
 * @param {'info' | 'warn' | 'error'} level - Log level
 * @param {Object} params - Log parameters
 */
const log = (level, { op, status, roomId, userId, sessionId, latencyMs, error, requestId, socketId }) => {
    const parts = ['[voice-client]'];
    
    parts.push(`op=${op}`);
    parts.push(`status=${status}`);
    
    if (roomId) parts.push(`room=${roomId}`);
    if (userId) parts.push(`user=${userId}`);
    if (sessionId) parts.push(`session=${sessionId}`);
    if (latencyMs !== undefined) parts.push(`latency_ms=${latencyMs}`);
    if (requestId) parts.push(`request_id=${requestId}`);
    if (socketId) parts.push(`socket_id=${socketId}`);
    if (error) parts.push(`error=${error}`);
    
    const message = parts.join(' ');
    
    if (level === 'error') {
        console.error(message);
    } else if (level === 'warn') {
        console.warn(message);
    } else {
        console.log(message);
    }
};

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_CONFIG = {
    maxRetries: 1,
    retryDelayMs: 100,
};

/**
 * Checks if an error is retryable
 * @param {Error} err - Error to check
 * @returns {boolean}
 */
const isRetryable = (err) => {
    // VoiceError has retryable property, but also check HTTP context
    if (err instanceof VoiceError) {
        // Don't retry if the original HTTP error was a 4xx client error
        const httpStatus = err.context?.status;
        if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
            return false;
        }
        return err.retryable;
    }
    
    // VoiceServiceError (legacy) - don't retry on 4xx or service unavailable
    if (err instanceof VoiceServiceError) {
        if (err.code === 'VOICE_SERVICE_UNAVAILABLE') return false;
        if (err.status && err.status >= 400 && err.status < 500) return false;
        return true;
    }
    
    // Network errors are usually retryable
    if (err.name === 'AbortError' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
        return true;
    }
    
    return false;
};

/**
 * Executes a function with retry logic (for read operations only)
 * @template T
 * @param {() => Promise<T>} fn - Function to execute
 * @param {Object} [config] - Retry configuration
 * @param {number} [config.maxRetries=1] - Maximum number of retries
 * @param {number} [config.retryDelayMs=100] - Delay between retries in ms
 * @returns {Promise<T>}
 */
const withRetry = async (fn, config = DEFAULT_RETRY_CONFIG) => {
    const { maxRetries, retryDelayMs } = config;
    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            
            // Check if we should retry
            if (!isRetryable(err)) {
                throw err;
            }
            
            // If we have retries left, wait and try again
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            }
        }
    }
    
    throw lastError;
};

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * @typedef {Object} LiveKitInfo
 * @property {string} token - LiveKit access token
 * @property {string} wsUrl - LiveKit WebSocket URL
 */

/**
 * @typedef {Object} VoiceSession
 * @property {string} sessionId - Unique session identifier
 * @property {string} roomId - Room identifier
 * @property {string} userId - User identifier
 * @property {string} [username] - User's display name
 * @property {boolean} canPublishAudio - Whether user can publish audio
 * @property {boolean} canSubscribe - Whether user can subscribe to others
 * @property {LiveKitInfo} livekit - LiveKit connection info
 * @property {string} createdAt - ISO timestamp
 * @property {string} updatedAt - ISO timestamp
 */

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Creates or updates a voice session in the chatVoice-service
 * 
 * NOTE: This operation is NOT retried by default to avoid duplicate side effects.
 * 
 * @param {Object} params - Session parameters
 * @param {string} params.roomId - Room identifier
 * @param {string} params.userId - User identifier
 * @param {string} [params.username] - User's display name
 * @param {boolean} [params.canPublishAudio=true] - Whether user can publish audio
 * @param {boolean} [params.canSubscribe=true] - Whether user can subscribe to others
 * @param {string} [params.requestId] - Optional request ID for correlation
 * @returns {Promise<VoiceSession>} The created or updated voice session
 * @throws {VoiceServiceError} If the service is unavailable or request fails
 */
export async function createOrUpdateVoiceSession({
    roomId,
    userId,
    username,
    canPublishAudio = true,
    canSubscribe = true,
    requestId,
}) {
    const OP = 'create_or_update';
    const startTime = Date.now();
    
    ensureServiceAvailable();
    
    const url = `${voiceServiceConfig.baseUrl}/api/v1/voice/sessions`;
    
    try {
        const response = await fetchWithTimeout(url, {
            method: 'POST',
            headers: getCommonHeaders({
                'Content-Type': 'application/json',
            }),
            body: JSON.stringify({
                roomId,
                userId,
                username,
                canPublishAudio,
                canSubscribe,
            }),
        });
        
        const latencyMs = Date.now() - startTime;
        
        if (response.ok) {
            const body = await response.json();
            const session = body.data;
            
            recordSuccess(OP, latencyMs);
            log('info', {
                op: OP,
                status: 'success',
                roomId,
                userId,
                sessionId: session?.sessionId,
                latencyMs,
                requestId,
            });
            
            return session;
        }
        
        // Handle error responses
        const errorText = await response.text();
        
        recordError(OP, latencyMs);
        log('error', {
            op: OP,
            status: 'error',
            roomId,
            userId,
            latencyMs,
            error: `HTTP ${response.status}: ${errorText}`,
            requestId,
        });
        
        // Use new VoiceError with proper code mapping
        const voiceError = createVoiceErrorFromResponse(response.status, errorText, { roomId, userId });
        throw voiceError;
    } catch (err) {
        const latencyMs = Date.now() - startTime;
        
        // Already a VoiceError or VoiceServiceError, just rethrow
        if (err instanceof VoiceError || err instanceof VoiceServiceError) {
            throw err;
        }
        
        // Handle timeout/network errors with wrapped VoiceError
        recordError(OP, latencyMs);
        log('error', {
            op: OP,
            status: 'error',
            roomId,
            userId,
            latencyMs,
            error: err.name === 'AbortError' ? 'timeout' : err.message,
            requestId,
        });
        
        throw wrapAsVoiceError(err, { roomId, userId });
    }
}

/**
 * Deletes a voice session from the chatVoice-service
 * 
 * NOTE: This operation is NOT retried by default to avoid duplicate side effects.
 * Returns false on errors instead of throwing (best-effort cleanup).
 * 
 * @param {string} sessionId - The session ID to delete
 * @param {Object} [options] - Optional parameters
 * @param {string} [options.requestId] - Optional request ID for correlation
 * @returns {Promise<boolean>} true if deleted, false if not found or error
 */
export async function deleteVoiceSession(sessionId, { requestId } = {}) {
    const OP = 'delete';
    const startTime = Date.now();
    
    if (!voiceServiceConfig.isAvailable) {
        log('warn', {
            op: OP,
            status: 'skipped',
            sessionId,
            error: 'service_not_configured',
            requestId,
        });
        return false;
    }
    
    const url = `${voiceServiceConfig.baseUrl}/api/v1/voice/sessions/${encodeURIComponent(sessionId)}`;
    
    try {
        const response = await fetchWithTimeout(url, {
            method: 'DELETE',
            headers: getCommonHeaders(),
        });
        
        const latencyMs = Date.now() - startTime;
        
        if (response.status === 204) {
            recordSuccess(OP, latencyMs);
            log('info', {
                op: OP,
                status: 'success',
                sessionId,
                latencyMs,
                requestId,
            });
            return true;
        }
        
        if (response.status === 404) {
            recordSuccess(OP, latencyMs); // 404 is expected in some cases
            log('info', {
                op: OP,
                status: 'not_found',
                sessionId,
                latencyMs,
                requestId,
            });
            return false;
        }
        
        // Log other errors but don't throw - allow caller to continue cleanup
        const errorText = await response.text();
        
        recordError(OP, latencyMs);
        log('error', {
            op: OP,
            status: 'error',
            sessionId,
            latencyMs,
            error: `HTTP ${response.status}: ${errorText}`,
            requestId,
        });
        
        return false;
    } catch (err) {
        const latencyMs = Date.now() - startTime;
        
        recordError(OP, latencyMs);
        
        if (err.name === 'AbortError') {
            log('error', {
                op: OP,
                status: 'error',
                sessionId,
                latencyMs,
                error: 'timeout',
                requestId,
            });
        } else {
            log('error', {
                op: OP,
                status: 'error',
                sessionId,
                latencyMs,
                error: err.message,
                requestId,
            });
        }
        
        return false;
    }
}

/**
 * Lists all voice sessions for a room
 * 
 * NOTE: This is a READ operation and will be retried once on transient failures.
 * 
 * @param {string} roomId - The room identifier
 * @param {Object} [options] - Optional parameters
 * @param {string} [options.requestId] - Optional request ID for correlation
 * @param {boolean} [options.noRetry=false] - Disable retry logic
 * @returns {Promise<VoiceSession[]>} Array of voice sessions
 */
export async function listVoiceSessionsByRoom(roomId, { requestId, noRetry = false } = {}) {
    const OP = 'list';
    
    if (!voiceServiceConfig.isAvailable) {
        log('warn', {
            op: OP,
            status: 'skipped',
            roomId,
            error: 'service_not_configured',
            requestId,
        });
        return [];
    }
    
    const doFetch = async () => {
        const startTime = Date.now();
        const url = `${voiceServiceConfig.baseUrl}/api/v1/voice/rooms/${encodeURIComponent(roomId)}/sessions`;
        
        try {
            const response = await fetchWithTimeout(url, {
                method: 'GET',
                headers: getCommonHeaders({
                    'Accept': 'application/json',
                }),
            });
            
            const latencyMs = Date.now() - startTime;
            
            if (response.ok) {
                const body = await response.json();
                const sessions = body.data || [];
                
                recordSuccess(OP, latencyMs);
                log('info', {
                    op: OP,
                    status: 'success',
                    roomId,
                    latencyMs,
                    requestId,
                });
                
                return sessions;
            }
            
            if (response.status === 404) {
                recordSuccess(OP, latencyMs); // 404 means no sessions, which is valid
                log('info', {
                    op: OP,
                    status: 'not_found',
                    roomId,
                    latencyMs,
                    requestId,
                });
                return [];
            }
            
            // Log other errors
            const errorText = await response.text();
            
            recordError(OP, latencyMs);
            log('error', {
                op: OP,
                status: 'error',
                roomId,
                latencyMs,
                error: `HTTP ${response.status}: ${errorText}`,
                requestId,
            });
            
            throw createVoiceErrorFromResponse(response.status, errorText, { roomId });
        } catch (err) {
            const latencyMs = Date.now() - startTime;
            
            if (err instanceof VoiceError || err instanceof VoiceServiceError) {
                throw err;
            }
            
            recordError(OP, latencyMs);
            log('error', {
                op: OP,
                status: 'error',
                roomId,
                latencyMs,
                error: err.name === 'AbortError' ? 'timeout' : err.message,
                requestId,
            });
            
            throw wrapAsVoiceError(err, { roomId });
        }
    };
    
    // Use retry logic for read operations (unless disabled)
    if (noRetry) {
        return doFetch();
    }
    
    return withRetry(doFetch, DEFAULT_RETRY_CONFIG);
}

// ============================================================================
// MODERATION API
// ============================================================================

/**
 * @typedef {Object} ModerationResult
 * @property {boolean} success - Whether the operation succeeded
 * @property {string} [message] - Optional message
 */

/**
 * @typedef {Object} RoomPolicy
 * @property {boolean} hostOnlyMode - Whether only hosts can speak
 * @property {number|null} maxSpeakers - Maximum number of speakers (null = unlimited)
 */

/**
 * Generic helper for moderation POST operations
 * Handles common patterns: service availability, fetch, success/error logging, metrics
 * 
 * @param {Object} params - Operation parameters
 * @param {string} params.operationName - Operation name for metrics (e.g., 'server_mute')
 * @param {string} params.endpoint - API endpoint path (e.g., '/api/v1/voice/moderation/server-mute')
 * @param {Object} params.body - Request body to send
 * @param {Object} params.context - Context for logging and errors (roomId, targetUserId, action)
 * @param {string} [params.requestId] - Optional request ID for correlation
 * @returns {Promise<ModerationResult>}
 * @throws {VoiceError} If the service is unavailable or request fails
 */
async function executeModerationOperation({ operationName, endpoint, body, context, requestId }) {
    const startTime = Date.now();
    
    ensureServiceAvailable();
    
    const url = `${voiceServiceConfig.baseUrl}${endpoint}`;
    const { roomId, targetUserId, action } = context;
    
    try {
        const response = await fetchWithTimeout(url, {
            method: 'POST',
            headers: getCommonHeaders({
                'Content-Type': 'application/json',
            }),
            body: JSON.stringify(body),
        });
        
        const latencyMs = Date.now() - startTime;
        
        if (response.ok) {
            const responseBody = await response.json();
            
            recordSuccess(operationName, latencyMs);
            log('info', {
                op: operationName,
                status: 'success',
                roomId,
                userId: targetUserId,
                latencyMs,
                requestId,
            });
            
            return responseBody.data || { success: true };
        }
        
        const errorText = await response.text();
        
        recordError(operationName, latencyMs);
        log('error', {
            op: operationName,
            status: 'error',
            roomId,
            userId: targetUserId,
            latencyMs,
            error: `HTTP ${response.status}: ${errorText}`,
            requestId,
        });
        
        throw createVoiceErrorFromResponse(response.status, errorText, { roomId, userId: targetUserId, action });
    } catch (err) {
        const latencyMs = Date.now() - startTime;
        
        if (err instanceof VoiceError || err instanceof VoiceServiceError) {
            throw err;
        }
        
        recordError(operationName, latencyMs);
        log('error', {
            op: operationName,
            status: 'error',
            roomId,
            userId: targetUserId,
            latencyMs,
            error: err.name === 'AbortError' ? 'timeout' : err.message,
            requestId,
        });
        
        throw wrapAsVoiceError(err, { roomId, userId: targetUserId, action });
    }
}

/**
 * Server-mutes a user in a voice room (moderation action)
 * 
 * @param {Object} params - Moderation parameters
 * @param {string} params.roomId - Room identifier
 * @param {string} params.targetUserId - User to server-mute
 * @param {string} params.moderatorUserId - User performing the moderation
 * @param {string} [params.reason] - Reason for the moderation action
 * @param {string} [params.requestId] - Optional request ID for correlation
 * @returns {Promise<ModerationResult>}
 * @throws {VoiceServiceError} If the service is unavailable or request fails
 */
export async function serverMuteUser({
    roomId,
    targetUserId,
    moderatorUserId,
    reason,
    requestId,
}) {
    return executeModerationOperation({
        operationName: 'server_mute',
        endpoint: '/api/v1/voice/moderation/server-mute',
        body: { roomId, targetUserId, moderatorUserId, reason },
        context: { roomId, targetUserId, action: 'serverMute' },
        requestId,
    });
}

/**
 * Server-unmutes a user in a voice room (moderation action)
 * 
 * @param {Object} params - Moderation parameters
 * @param {string} params.roomId - Room identifier
 * @param {string} params.targetUserId - User to server-unmute
 * @param {string} params.moderatorUserId - User performing the moderation
 * @param {string} [params.requestId] - Optional request ID for correlation
 * @returns {Promise<ModerationResult>}
 * @throws {VoiceError} If the service is unavailable or request fails
 */
export async function serverUnmuteUser({
    roomId,
    targetUserId,
    moderatorUserId,
    requestId,
}) {
    return executeModerationOperation({
        operationName: 'server_unmute',
        endpoint: '/api/v1/voice/moderation/server-unmute',
        body: { roomId, targetUserId, moderatorUserId },
        context: { roomId, targetUserId, action: 'serverUnmute' },
        requestId,
    });
}

/**
 * Kicks a user from a voice room (moderation action)
 * 
 * @param {Object} params - Moderation parameters
 * @param {string} params.roomId - Room identifier
 * @param {string} params.targetUserId - User to kick
 * @param {string} params.moderatorUserId - User performing the moderation
 * @param {string} [params.reason] - Reason for the kick
 * @param {string} [params.requestId] - Optional request ID for correlation
 * @returns {Promise<ModerationResult>}
 * @throws {VoiceError} If the service is unavailable or request fails
 */
export async function kickUserFromVoice({
    roomId,
    targetUserId,
    moderatorUserId,
    reason,
    requestId,
}) {
    return executeModerationOperation({
        operationName: 'kick',
        endpoint: '/api/v1/voice/moderation/kick',
        body: { roomId, targetUserId, moderatorUserId, reason },
        context: { roomId, targetUserId, action: 'kick' },
        requestId,
    });
}

/**
 * Gets the room policy for voice (maxSpeakers, hostOnlyMode)
 * 
 * NOTE: This is a READ operation and will be retried once on transient failures.
 * 
 * @param {string} roomId - Room identifier
 * @param {Object} [options] - Optional parameters
 * @param {string} [options.requestId] - Optional request ID for correlation
 * @returns {Promise<RoomPolicy>}
 */
export async function getRoomPolicy(roomId, { requestId } = {}) {
    const OP = 'get_policy';
    
    // Default policy when service is unavailable
    const defaultPolicy = {
        hostOnlyMode: false,
        maxSpeakers: null,
    };
    
    if (!voiceServiceConfig.isAvailable) {
        log('warn', {
            op: OP,
            status: 'skipped',
            roomId,
            error: 'service_not_configured',
            requestId,
        });
        return defaultPolicy;
    }
    
    const doFetch = async () => {
        const startTime = Date.now();
        const url = `${voiceServiceConfig.baseUrl}/api/v1/voice/moderation/policy?roomId=${encodeURIComponent(roomId)}`;
        
        try {
            const response = await fetchWithTimeout(url, {
                method: 'GET',
                headers: getCommonHeaders({
                    'Accept': 'application/json',
                }),
            });
            
            const latencyMs = Date.now() - startTime;
            
            if (response.ok) {
                const body = await response.json();
                const policy = body.data || defaultPolicy;
                
                recordSuccess(OP, latencyMs);
                log('info', {
                    op: OP,
                    status: 'success',
                    roomId,
                    latencyMs,
                    requestId,
                });
                
                return {
                    hostOnlyMode: policy.hostOnlyMode ?? false,
                    maxSpeakers: policy.maxSpeakers ?? null,
                };
            }
            
            if (response.status === 404) {
                // Room policy not found, use defaults
                recordSuccess(OP, latencyMs);
                log('info', {
                    op: OP,
                    status: 'not_found',
                    roomId,
                    latencyMs,
                    requestId,
                });
                return defaultPolicy;
            }
            
            const errorText = await response.text();
            
            recordError(OP, latencyMs);
            log('error', {
                op: OP,
                status: 'error',
                roomId,
                latencyMs,
                error: `HTTP ${response.status}: ${errorText}`,
                requestId,
            });
            
            // Return default policy on error instead of throwing
            return defaultPolicy;
        } catch (err) {
            const latencyMs = Date.now() - startTime;
            
            recordError(OP, latencyMs);
            
            if (err.name === 'AbortError') {
                log('error', {
                    op: OP,
                    status: 'error',
                    roomId,
                    latencyMs,
                    error: 'timeout',
                    requestId,
                });
            } else {
                log('error', {
                    op: OP,
                    status: 'error',
                    roomId,
                    latencyMs,
                    error: err.message,
                    requestId,
                });
            }
            
            // Return default policy on error
            return defaultPolicy;
        }
    };
    
    return withRetry(doFetch, DEFAULT_RETRY_CONFIG);
}

// ============================================================================
// EXPORTS
// ============================================================================

// Re-export VoiceError and codes from voiceErrors.js for convenience
export { VoiceError, VoiceErrorCode } from '../voice/voiceErrors.js';

export const voiceSessionsClient = {
    // Session management
    createOrUpdateVoiceSession,
    deleteVoiceSession,
    listVoiceSessionsByRoom,
    // Moderation
    serverMuteUser,
    serverUnmuteUser,
    kickUserFromVoice,
    getRoomPolicy,
    // Metrics
    getOperationMetrics,
    getAllMetrics,
    resetMetrics,
    // Error classes (legacy + new)
    VoiceServiceError,
    // Note: VoiceError is exported directly above
};
