/**
 * Voice Service Configuration Module
 * 
 * Centralizes configuration for communicating with the chatVoice-service.
 * If baseUrl is not defined, the voice service integration will be treated
 * as "unavailable" and functionality will gracefully degrade.
 * 
 * DO NOT use process.env directly outside of this module for voice service config.
 */

const baseUrl = process.env.VOICE_SERVICE_BASE_URL || undefined;
const timeoutMs = Number(process.env.VOICE_SERVICE_TIMEOUT_MS ?? '4000');

/**
 * Internal API key for service-to-service authentication
 * Used in x-internal-api-key header when calling chatVoice-service
 */
const internalApiKey = process.env.INTERNAL_API_KEY || undefined;

/**
 * LiveKit configuration for WebRTC voice connections
 */
const livekit = {
    apiKey: process.env.LIVEKIT_API_KEY || undefined,
    apiSecret: process.env.LIVEKIT_API_SECRET || undefined,
    wsUrl: process.env.LIVEKIT_WS_URL || undefined,
    tokenTtlSeconds: Number(process.env.LIVEKIT_TOKEN_TTL_SECONDS ?? '3600'),
};

/**
 * @typedef {Object} VoiceServiceConfig
 * @property {string|undefined} baseUrl - Base URL for the voice service (e.g., http://localhost:3002)
 * @property {number} timeoutMs - Timeout in milliseconds for HTTP requests
 * @property {boolean} isAvailable - Whether the voice service is configured and available
 * @property {string|undefined} internalApiKey - Internal API key for service-to-service auth
 * @property {Object} livekit - LiveKit configuration
 */

/**
 * Voice service configuration object
 * @type {VoiceServiceConfig}
 */
export const voiceServiceConfig = {
    baseUrl,
    timeoutMs,
    internalApiKey,
    /**
     * Returns true if the voice service is properly configured
     * @returns {boolean}
     */
    get isAvailable() {
        return typeof baseUrl === 'string' && baseUrl.trim().length > 0;
    },
    livekit,
};
