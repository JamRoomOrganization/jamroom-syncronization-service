/**
 * Retry with Exponential Backoff Utility
 * 
 * Provides intelligent retry logic with exponential backoff,
 * jitter, and configurable retry policies.
 * 
 * @module retryWithBackoff
 */

// ============================================================================
// TYPES AND CONSTANTS
// ============================================================================

/**
 * @typedef {Object} RetryOptions
 * @property {number} [maxRetries=3] - Maximum number of retry attempts
 * @property {number} [baseDelayMs=100] - Base delay in milliseconds
 * @property {number} [maxDelayMs=10000] - Maximum delay cap
 * @property {number} [jitterFactor=0.3] - Jitter factor (0-1) to add randomness
 * @property {(error: Error) => boolean} [shouldRetry] - Custom retry predicate
 * @property {(attempt: number, error: Error, nextDelayMs: number) => void} [onRetry] - Callback before retry
 * @property {AbortSignal} [signal] - AbortSignal for cancellation
 */

const DEFAULT_OPTIONS = {
    maxRetries: 3,
    baseDelayMs: 100,
    maxDelayMs: 10000,
    jitterFactor: 0.3,
};

// ============================================================================
// RETRY PREDICATES
// ============================================================================

/**
 * Default retry predicate - retries on network and timeout errors
 * @param {Error} error
 * @returns {boolean}
 */
export function defaultShouldRetry(error) {
    // Network errors
    if (error.code === 'ECONNREFUSED' || 
        error.code === 'ETIMEDOUT' || 
        error.code === 'ENOTFOUND' ||
        error.code === 'ENETUNREACH' ||
        error.code === 'ECONNRESET') {
        return true;
    }

    // Abort/timeout errors
    if (error.name === 'AbortError') {
        return true;
    }

    // HTTP status codes that should be retried
    if (error.status) {
        // Retry on 429 (rate limited), 502, 503, 504 (server errors)
        return [429, 502, 503, 504].includes(error.status);
    }

    // VoiceError with retryable flag
    if ('retryable' in error) {
        return error.retryable === true;
    }

    return false;
}

/**
 * Creates a predicate that retries on specific HTTP status codes
 * @param {number[]} statusCodes - Status codes to retry on
 * @returns {(error: Error) => boolean}
 */
export function retryOnStatusCodes(statusCodes) {
    return (error) => {
        if (error.status && statusCodes.includes(error.status)) {
            return true;
        }
        return defaultShouldRetry(error);
    };
}

/**
 * Creates a predicate that never retries on 4xx client errors
 * @returns {(error: Error) => boolean}
 */
export function noRetryOnClientErrors() {
    return (error) => {
        // Don't retry on 4xx client errors (except 429)
        if (error.status && error.status >= 400 && error.status < 500 && error.status !== 429) {
            return false;
        }
        return defaultShouldRetry(error);
    };
}

// ============================================================================
// DELAY CALCULATION
// ============================================================================

/**
 * Calculates delay with exponential backoff and jitter
 * @param {number} attempt - Current attempt number (0-indexed)
 * @param {number} baseDelayMs - Base delay in ms
 * @param {number} maxDelayMs - Maximum delay cap
 * @param {number} jitterFactor - Jitter factor (0-1)
 * @returns {number} Delay in milliseconds
 */
export function calculateBackoffDelay(attempt, baseDelayMs, maxDelayMs, jitterFactor) {
    // Exponential backoff: baseDelay * 2^attempt
    const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
    
    // Cap at maximum delay
    const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
    
    // Add jitter: random value between -jitterFactor and +jitterFactor
    const jitter = 1 + (Math.random() * 2 - 1) * jitterFactor;
    const delayWithJitter = cappedDelay * jitter;
    
    return Math.round(Math.max(0, delayWithJitter));
}

/**
 * Creates a delay function for linear backoff
 * @param {number} increment - Ms to add per attempt
 * @returns {(attempt: number, baseDelayMs: number, maxDelayMs: number) => number}
 */
export function linearBackoff(increment) {
    return (attempt, baseDelayMs, maxDelayMs) => {
        const delay = baseDelayMs + (attempt * increment);
        return Math.min(delay, maxDelayMs);
    };
}

// ============================================================================
// MAIN RETRY FUNCTION
// ============================================================================

/**
 * Executes a function with retry logic and exponential backoff
 * 
 * @template T
 * @param {() => Promise<T>} fn - Async function to execute
 * @param {RetryOptions} [options] - Retry configuration
 * @returns {Promise<T>}
 * @throws {Error} Last error if all retries exhausted
 */
export async function retryWithBackoff(fn, options = {}) {
    const config = { ...DEFAULT_OPTIONS, ...options };
    const {
        maxRetries,
        baseDelayMs,
        maxDelayMs,
        jitterFactor,
        shouldRetry = defaultShouldRetry,
        onRetry,
        signal,
    } = config;

    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // Check for cancellation
        if (signal?.aborted) {
            const abortError = new Error('Operation cancelled');
            abortError.name = 'AbortError';
            throw abortError;
        }

        try {
            return await fn();
        } catch (error) {
            lastError = error;

            // Check if we should retry
            const isLastAttempt = attempt >= maxRetries;
            const canRetry = !isLastAttempt && shouldRetry(error);

            if (!canRetry) {
                throw error;
            }

            // Calculate delay
            const delay = calculateBackoffDelay(attempt, baseDelayMs, maxDelayMs, jitterFactor);

            // Call onRetry callback if provided
            if (onRetry) {
                try {
                    onRetry(attempt + 1, error, delay);
                } catch (callbackError) {
                    console.error('[retryWithBackoff] onRetry callback error:', callbackError.message);
                }
            }

            // Wait before retrying
            await sleep(delay, signal);
        }
    }

    throw lastError;
}

/**
 * Creates a wrapped function with retry logic
 * 
 * @template T
 * @param {(...args: any[]) => Promise<T>} fn - Function to wrap
 * @param {RetryOptions} options - Retry configuration
 * @returns {(...args: any[]) => Promise<T>}
 */
export function withRetry(fn, options = {}) {
    return async (...args) => {
        return retryWithBackoff(() => fn(...args), options);
    };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Sleep for a given duration with optional AbortSignal support
 * @param {number} ms - Duration in milliseconds
 * @param {AbortSignal} [signal] - Optional abort signal
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(resolve, ms);

        if (signal) {
            if (signal.aborted) {
                clearTimeout(timeoutId);
                const abortError = new Error('Operation cancelled');
                abortError.name = 'AbortError';
                reject(abortError);
                return;
            }

            const abortHandler = () => {
                clearTimeout(timeoutId);
                const abortError = new Error('Operation cancelled');
                abortError.name = 'AbortError';
                reject(abortError);
            };

            signal.addEventListener('abort', abortHandler, { once: true });
        }
    });
}

// ============================================================================
// SPECIALIZED RETRY FACTORIES
// ============================================================================

/**
 * Creates retry options optimized for voice service calls
 * @param {Partial<RetryOptions>} [overrides] - Custom overrides
 * @returns {RetryOptions}
 */
export function voiceServiceRetryOptions(overrides = {}) {
    return {
        maxRetries: 2,
        baseDelayMs: 100,
        maxDelayMs: 2000,
        jitterFactor: 0.2,
        shouldRetry: noRetryOnClientErrors(),
        onRetry: (attempt, error, delayMs) => {
            console.warn(`[voice-client] retry attempt ${attempt} after ${delayMs}ms`, {
                error: error.message,
                code: error.code,
            });
        },
        ...overrides,
    };
}

/**
 * Creates retry options optimized for queue service calls
 * @param {Partial<RetryOptions>} [overrides] - Custom overrides
 * @returns {RetryOptions}
 */
export function queueServiceRetryOptions(overrides = {}) {
    return {
        maxRetries: 2,
        baseDelayMs: 150,
        maxDelayMs: 3000,
        jitterFactor: 0.25,
        shouldRetry: noRetryOnClientErrors(),
        onRetry: (attempt, error, delayMs) => {
            console.warn(`[queue-client] retry attempt ${attempt} after ${delayMs}ms`, {
                error: error.message,
                code: error.code,
            });
        },
        ...overrides,
    };
}

/**
 * Creates retry options for idempotent read operations
 * @param {Partial<RetryOptions>} [overrides] - Custom overrides
 * @returns {RetryOptions}
 */
export function readOperationRetryOptions(overrides = {}) {
    return {
        maxRetries: 3,
        baseDelayMs: 50,
        maxDelayMs: 1000,
        jitterFactor: 0.2,
        shouldRetry: defaultShouldRetry,
        ...overrides,
    };
}
