/**
 * Voice Error Codes and Messages
 * 
 * Centralized catalog of voice-related error codes for consistent
 * error handling across sync-service and frontend.
 * 
 * Each error includes:
 * - code: Stable string identifier for programmatic handling
 * - message: Technical message for logs/backend
 * - uiMessage: User-friendly message in Spanish for frontend UI
 * - retryable: Whether the operation can be retried
 * 
 * @module voiceErrors
 */

// ============================================================================
// ERROR CODES ENUM
// ============================================================================

/**
 * Voice error code constants
 * @enum {string}
 */
export const VoiceErrorCode = {
    /** Voice feature is disabled globally (feature flag) */
    VOICE_UNAVAILABLE: 'VOICE_UNAVAILABLE',
    
    /** chatVoice-service is not responding or returned 5xx/timeout */
    VOICE_SERVICE_UNAVAILABLE: 'VOICE_SERVICE_UNAVAILABLE',
    
    /** Failed to emit LiveKit token or connect to LiveKit */
    VOICE_LIVEKIT_UNAVAILABLE: 'VOICE_LIVEKIT_UNAVAILABLE',
    
    /** maxSpeakers limit reached according to room policy */
    VOICE_ROOM_LIMIT_REACHED: 'VOICE_ROOM_LIMIT_REACHED',
    
    /** User lacks permission to speak or moderate */
    VOICE_PERMISSION_DENIED: 'VOICE_PERMISSION_DENIED',
    
    /** Target user is not in the voice channel */
    VOICE_TARGET_NOT_IN_VOICE: 'VOICE_TARGET_NOT_IN_VOICE',
    
    /** User is not in the room socket channel */
    VOICE_NOT_IN_ROOM: 'VOICE_NOT_IN_ROOM',
    
    /** Invalid room ID provided */
    VOICE_INVALID_ROOM_ID: 'VOICE_INVALID_ROOM_ID',
    
    /** Invalid user ID provided */
    VOICE_INVALID_USER_ID: 'VOICE_INVALID_USER_ID',
    
    /** Request timeout to voice service */
    VOICE_SERVICE_TIMEOUT: 'VOICE_SERVICE_TIMEOUT',
    
    /** Any other unexpected error */
    VOICE_INTERNAL_ERROR: 'VOICE_INTERNAL_ERROR',
};

// ============================================================================
// ERROR DEFINITIONS
// ============================================================================

/**
 * @typedef {Object} VoiceErrorDefinition
 * @property {string} code - Stable error code
 * @property {string} message - Technical message for logs/backend
 * @property {string} uiMessage - User-friendly message in Spanish
 * @property {boolean} retryable - Whether the operation can be retried
 */

/**
 * Voice error definitions catalog
 * @type {Record<string, VoiceErrorDefinition>}
 */
export const VoiceErrors = {
    [VoiceErrorCode.VOICE_UNAVAILABLE]: {
        code: VoiceErrorCode.VOICE_UNAVAILABLE,
        message: 'Voice feature is currently disabled',
        uiMessage: 'La función de voz no está disponible en este momento.',
        retryable: false,
    },
    
    [VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE]: {
        code: VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE,
        message: 'Voice service is unavailable',
        uiMessage: 'El servicio de voz no está disponible. Inténtalo de nuevo más tarde.',
        retryable: true,
    },
    
    [VoiceErrorCode.VOICE_LIVEKIT_UNAVAILABLE]: {
        code: VoiceErrorCode.VOICE_LIVEKIT_UNAVAILABLE,
        message: 'LiveKit voice infrastructure is unavailable',
        uiMessage: 'No se pudo conectar al servidor de voz. Inténtalo de nuevo.',
        retryable: true,
    },
    
    [VoiceErrorCode.VOICE_ROOM_LIMIT_REACHED]: {
        code: VoiceErrorCode.VOICE_ROOM_LIMIT_REACHED,
        message: 'Maximum speakers limit reached for this room',
        uiMessage: 'Se ha alcanzado el límite de hablantes en esta sala.',
        retryable: false,
    },
    
    [VoiceErrorCode.VOICE_PERMISSION_DENIED]: {
        code: VoiceErrorCode.VOICE_PERMISSION_DENIED,
        message: 'User does not have permission for this voice action',
        uiMessage: 'No tienes permisos para realizar esta acción.',
        retryable: false,
    },
    
    [VoiceErrorCode.VOICE_TARGET_NOT_IN_VOICE]: {
        code: VoiceErrorCode.VOICE_TARGET_NOT_IN_VOICE,
        message: 'Target user is not in the voice channel',
        uiMessage: 'El usuario no está en el canal de voz.',
        retryable: false,
    },
    
    [VoiceErrorCode.VOICE_NOT_IN_ROOM]: {
        code: VoiceErrorCode.VOICE_NOT_IN_ROOM,
        message: 'User must join the room before joining voice',
        uiMessage: 'Debes unirte a la sala antes de activar el canal de voz.',
        retryable: false,
    },
    
    [VoiceErrorCode.VOICE_INVALID_ROOM_ID]: {
        code: VoiceErrorCode.VOICE_INVALID_ROOM_ID,
        message: 'Invalid room ID provided',
        uiMessage: 'ID de sala inválido.',
        retryable: false,
    },
    
    [VoiceErrorCode.VOICE_INVALID_USER_ID]: {
        code: VoiceErrorCode.VOICE_INVALID_USER_ID,
        message: 'Invalid user ID provided',
        uiMessage: 'ID de usuario inválido.',
        retryable: false,
    },
    
    [VoiceErrorCode.VOICE_SERVICE_TIMEOUT]: {
        code: VoiceErrorCode.VOICE_SERVICE_TIMEOUT,
        message: 'Voice service request timed out',
        uiMessage: 'El servicio de voz tardó demasiado en responder. Inténtalo de nuevo.',
        retryable: true,
    },
    
    [VoiceErrorCode.VOICE_INTERNAL_ERROR]: {
        code: VoiceErrorCode.VOICE_INTERNAL_ERROR,
        message: 'An unexpected error occurred in the voice system',
        uiMessage: 'Ocurrió un error inesperado. Inténtalo de nuevo.',
        retryable: true,
    },
};

// ============================================================================
// VOICE ERROR CLASS
// ============================================================================

/**
 * Custom error class for voice-related errors
 * Extends Error with structured properties for consistent handling
 */
export class VoiceError extends Error {
    /**
     * @param {string} code - Error code from VoiceErrorCode
     * @param {Object} [options] - Additional options
     * @param {string} [options.message] - Override default message
     * @param {string} [options.uiMessage] - Override default UI message
     * @param {boolean} [options.retryable] - Override default retryable
     * @param {string} [options.roomId] - Associated room ID
     * @param {string} [options.userId] - Associated user ID
     * @param {Record<string, unknown>} [options.context] - Additional context
     * @param {Error} [options.cause] - Original error that caused this
     */
    constructor(code, options = {}) {
        const definition = VoiceErrors[code] || VoiceErrors[VoiceErrorCode.VOICE_INTERNAL_ERROR];
        
        const message = options.message || definition.message;
        super(message);
        
        this.name = 'VoiceError';
        this.code = code;
        this.uiMessage = options.uiMessage || definition.uiMessage;
        this.retryable = options.retryable ?? definition.retryable;
        this.roomId = options.roomId;
        this.userId = options.userId;
        this.context = options.context;
        this.cause = options.cause;
        
        // Capture stack trace
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, VoiceError);
        }
    }
    
    /**
     * Converts the error to a payload suitable for socket emission
     * @returns {Object} Error payload for voice:error event
     */
    toSocketPayload() {
        return {
            code: this.code,
            message: this.message,
            uiMessage: this.uiMessage,
            retryable: this.retryable,
            roomId: this.roomId,
            ...(this.context && { context: this.context }),
        };
    }
    
    /**
     * Converts the error to a loggable object
     * @returns {Object} Error object for logging
     */
    toLogObject() {
        return {
            name: this.name,
            code: this.code,
            message: this.message,
            retryable: this.retryable,
            roomId: this.roomId,
            userId: this.userId,
            context: this.context,
            cause: this.cause?.message,
            stack: this.stack,
        };
    }
}

// ============================================================================
// ERROR FACTORY FUNCTIONS
// ============================================================================

/**
 * Creates a VoiceError for when voice feature is disabled
 * @param {Object} [options] - Additional options
 * @returns {VoiceError}
 */
export function voiceUnavailableError(options = {}) {
    return new VoiceError(VoiceErrorCode.VOICE_UNAVAILABLE, options);
}

/**
 * Creates a VoiceError for when voice service is unavailable
 * @param {Object} [options] - Additional options
 * @returns {VoiceError}
 */
export function voiceServiceUnavailableError(options = {}) {
    return new VoiceError(VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE, options);
}

/**
 * Creates a VoiceError for when LiveKit is unavailable
 * @param {Object} [options] - Additional options
 * @returns {VoiceError}
 */
export function voiceLiveKitUnavailableError(options = {}) {
    return new VoiceError(VoiceErrorCode.VOICE_LIVEKIT_UNAVAILABLE, options);
}

/**
 * Creates a VoiceError for when room speaker limit is reached
 * @param {Object} [options] - Additional options
 * @returns {VoiceError}
 */
export function voiceRoomLimitReachedError(options = {}) {
    return new VoiceError(VoiceErrorCode.VOICE_ROOM_LIMIT_REACHED, options);
}

/**
 * Creates a VoiceError for permission denied
 * @param {Object} [options] - Additional options
 * @returns {VoiceError}
 */
export function voicePermissionDeniedError(options = {}) {
    return new VoiceError(VoiceErrorCode.VOICE_PERMISSION_DENIED, options);
}

/**
 * Creates a VoiceError for target not in voice
 * @param {Object} [options] - Additional options
 * @returns {VoiceError}
 */
export function voiceTargetNotInVoiceError(options = {}) {
    return new VoiceError(VoiceErrorCode.VOICE_TARGET_NOT_IN_VOICE, options);
}

/**
 * Creates a VoiceError for not in room
 * @param {Object} [options] - Additional options
 * @returns {VoiceError}
 */
export function voiceNotInRoomError(options = {}) {
    return new VoiceError(VoiceErrorCode.VOICE_NOT_IN_ROOM, options);
}

/**
 * Creates a VoiceError for service timeout
 * @param {Object} [options] - Additional options
 * @returns {VoiceError}
 */
export function voiceServiceTimeoutError(options = {}) {
    return new VoiceError(VoiceErrorCode.VOICE_SERVICE_TIMEOUT, options);
}

/**
 * Creates a VoiceError for internal errors
 * @param {Object} [options] - Additional options
 * @returns {VoiceError}
 */
export function voiceInternalError(options = {}) {
    return new VoiceError(VoiceErrorCode.VOICE_INTERNAL_ERROR, options);
}

// ============================================================================
// ERROR MAPPING UTILITIES
// ============================================================================

/**
 * Maps HTTP status codes to appropriate VoiceError codes
 * @param {number} status - HTTP status code
 * @returns {string} VoiceErrorCode
 */
export function mapHttpStatusToVoiceErrorCode(status) {
    if (status === 503) {
        return VoiceErrorCode.VOICE_LIVEKIT_UNAVAILABLE;
    }
    if (status >= 500) {
        return VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE;
    }
    if (status === 403) {
        return VoiceErrorCode.VOICE_PERMISSION_DENIED;
    }
    if (status === 404) {
        return VoiceErrorCode.VOICE_TARGET_NOT_IN_VOICE;
    }
    if (status === 429) {
        return VoiceErrorCode.VOICE_ROOM_LIMIT_REACHED;
    }
    return VoiceErrorCode.VOICE_INTERNAL_ERROR;
}

/**
 * Maps chatVoice-service error codes to VoiceErrorCode
 * @param {string} serviceErrorCode - Error code from chatVoice-service
 * @returns {string} VoiceErrorCode
 */
export function mapServiceErrorToVoiceErrorCode(serviceErrorCode) {
    const mapping = {
        'DEPENDENCY_UNAVAILABLE': VoiceErrorCode.VOICE_LIVEKIT_UNAVAILABLE,
        'LIVEKIT_ERROR': VoiceErrorCode.VOICE_LIVEKIT_UNAVAILABLE,
        'TOKEN_GENERATION_FAILED': VoiceErrorCode.VOICE_LIVEKIT_UNAVAILABLE,
        'SERVICE_UNAVAILABLE': VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE,
        'SESSION_NOT_FOUND': VoiceErrorCode.VOICE_TARGET_NOT_IN_VOICE,
        'ROOM_NOT_FOUND': VoiceErrorCode.VOICE_INVALID_ROOM_ID,
        'USER_NOT_FOUND': VoiceErrorCode.VOICE_INVALID_USER_ID,
        'PERMISSION_DENIED': VoiceErrorCode.VOICE_PERMISSION_DENIED,
        'MAX_SPEAKERS_REACHED': VoiceErrorCode.VOICE_ROOM_LIMIT_REACHED,
    };
    
    return mapping[serviceErrorCode] || VoiceErrorCode.VOICE_INTERNAL_ERROR;
}

/**
 * Creates a VoiceError from a generic error
 * Useful for wrapping unknown errors with proper structure
 * @param {Error} err - Original error
 * @param {Object} [options] - Additional options
 * @returns {VoiceError}
 */
export function wrapAsVoiceError(err, options = {}) {
    // Already a VoiceError, just return it
    if (err instanceof VoiceError) {
        return err;
    }
    
    // Network/timeout errors
    if (err.name === 'AbortError' || err.code === 'ABORT_ERR') {
        return new VoiceError(VoiceErrorCode.VOICE_SERVICE_TIMEOUT, {
            ...options,
            cause: err,
        });
    }
    
    // Connection errors
    if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') {
        return new VoiceError(VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE, {
            ...options,
            cause: err,
        });
    }
    
    // Default to internal error
    return new VoiceError(VoiceErrorCode.VOICE_INTERNAL_ERROR, {
        ...options,
        message: err.message,
        cause: err,
    });
}

/**
 * Checks if an error is a retryable voice error
 * @param {Error} err - Error to check
 * @returns {boolean}
 */
export function isRetryableVoiceError(err) {
    if (err instanceof VoiceError) {
        return err.retryable;
    }
    
    // Network errors are usually retryable
    if (err.name === 'AbortError' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
        return true;
    }
    
    return false;
}
