/**
 * Circuit Breaker Pattern Implementation
 * 
 * Provides graceful degradation when external services fail.
 * States: CLOSED (normal), OPEN (failing), HALF_OPEN (testing recovery)
 * 
 * @module circuitBreaker
 */

// ============================================================================
// TYPES AND CONSTANTS
// ============================================================================

/**
 * @typedef {'CLOSED' | 'OPEN' | 'HALF_OPEN'} CircuitState
 */

/**
 * @typedef {Object} CircuitBreakerOptions
 * @property {number} [failureThreshold=5] - Number of failures before opening
 * @property {number} [successThreshold=2] - Successes needed to close from half-open
 * @property {number} [timeout=30000] - Time in ms before attempting recovery
 * @property {number} [resetTimeout=60000] - Time in ms to fully reset failure count
 * @property {Function} [onStateChange] - Callback when state changes
 * @property {Function} [fallback] - Fallback function when circuit is open
 */

const DEFAULT_OPTIONS = {
    failureThreshold: 5,
    successThreshold: 2,
    timeout: 30000,
    resetTimeout: 60000,
};

// ============================================================================
// CIRCUIT BREAKER CLASS
// ============================================================================

/**
 * Circuit breaker implementation for protecting against cascading failures
 */
export class CircuitBreaker {
    /**
     * @param {string} name - Identifier for this circuit
     * @param {CircuitBreakerOptions} [options]
     */
    constructor(name, options = {}) {
        this.name = name;
        this.options = { ...DEFAULT_OPTIONS, ...options };
        
        /** @type {CircuitState} */
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.successCount = 0;
        this.lastFailureTime = null;
        this.lastStateChange = Date.now();
        
        // Metrics
        this.metrics = {
            totalCalls: 0,
            successfulCalls: 0,
            failedCalls: 0,
            rejectedCalls: 0,
            fallbackCalls: 0,
            stateChanges: [],
        };
    }

    /**
     * Executes a function with circuit breaker protection
     * 
     * @template T
     * @param {() => Promise<T>} fn - Function to execute
     * @param {Object} [context] - Additional context for logging
     * @returns {Promise<T>}
     */
    async execute(fn, context = {}) {
        this.metrics.totalCalls++;

        // Check if circuit is open
        if (this.state === 'OPEN') {
            if (this._shouldAttemptReset()) {
                this._transitionTo('HALF_OPEN');
            } else {
                this.metrics.rejectedCalls++;
                return this._handleRejection(context);
            }
        }

        try {
            const result = await fn();
            this._onSuccess();
            return result;
        } catch (error) {
            this._onFailure(error);
            throw error;
        }
    }

    /**
     * Wraps a function with circuit breaker protection
     * Returns a function that can be called directly
     * 
     * @template T
     * @param {(...args: any[]) => Promise<T>} fn - Function to wrap
     * @returns {(...args: any[]) => Promise<T>}
     */
    wrap(fn) {
        return async (...args) => {
            return this.execute(() => fn(...args), { args });
        };
    }

    /**
     * Gets the current state of the circuit
     * @returns {{ state: CircuitState; failureCount: number; successCount: number }}
     */
    getState() {
        return {
            state: this.state,
            failureCount: this.failureCount,
            successCount: this.successCount,
            lastFailureTime: this.lastFailureTime,
            lastStateChange: this.lastStateChange,
        };
    }

    /**
     * Gets metrics snapshot
     */
    getMetrics() {
        return {
            ...this.metrics,
            currentState: this.state,
            failureCount: this.failureCount,
            successRate: this.metrics.totalCalls > 0
                ? (this.metrics.successfulCalls / this.metrics.totalCalls) * 100
                : 100,
        };
    }

    /**
     * Manually resets the circuit breaker
     */
    reset() {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.successCount = 0;
        this.lastFailureTime = null;
        this.lastStateChange = Date.now();
    }

    // ============================================================================
    // PRIVATE METHODS
    // ============================================================================

    _shouldAttemptReset() {
        if (!this.lastFailureTime) return false;
        return Date.now() - this.lastFailureTime >= this.options.timeout;
    }

    _onSuccess() {
        this.metrics.successfulCalls++;

        if (this.state === 'HALF_OPEN') {
            this.successCount++;
            if (this.successCount >= this.options.successThreshold) {
                this._transitionTo('CLOSED');
            }
        } else if (this.state === 'CLOSED') {
            // Reset failure count on success (with time decay)
            if (this.lastFailureTime && 
                Date.now() - this.lastFailureTime >= this.options.resetTimeout) {
                this.failureCount = 0;
            }
        }
    }

    _onFailure(error) {
        this.metrics.failedCalls++;
        this.lastFailureTime = Date.now();

        if (this.state === 'HALF_OPEN') {
            // Any failure in half-open immediately opens the circuit
            this._transitionTo('OPEN');
        } else if (this.state === 'CLOSED') {
            this.failureCount++;
            if (this.failureCount >= this.options.failureThreshold) {
                this._transitionTo('OPEN');
            }
        }
    }

    _transitionTo(newState) {
        const oldState = this.state;
        this.state = newState;
        this.lastStateChange = Date.now();

        // Reset counters based on new state
        if (newState === 'CLOSED') {
            this.failureCount = 0;
            this.successCount = 0;
        } else if (newState === 'HALF_OPEN') {
            this.successCount = 0;
        }

        // Track state change
        this.metrics.stateChanges.push({
            from: oldState,
            to: newState,
            timestamp: this.lastStateChange,
        });

        // Keep only last 10 state changes
        if (this.metrics.stateChanges.length > 10) {
            this.metrics.stateChanges.shift();
        }

        // Invoke callback if provided
        if (this.options.onStateChange) {
            try {
                this.options.onStateChange(oldState, newState, this.name);
            } catch (err) {
                console.error(`[circuit-breaker] onStateChange callback error: ${err.message}`);
            }
        }

        console.log(`[circuit-breaker] ${this.name}: ${oldState} -> ${newState}`, {
            failureCount: this.failureCount,
        });
    }

    async _handleRejection(context) {
        // Try fallback if provided
        if (this.options.fallback) {
            this.metrics.fallbackCalls++;
            try {
                return await this.options.fallback(context);
            } catch (fallbackError) {
                console.error(`[circuit-breaker] ${this.name}: fallback failed`, {
                    error: fallbackError.message,
                });
            }
        }

        const error = new Error(`Circuit breaker ${this.name} is OPEN`);
        error.code = 'CIRCUIT_BREAKER_OPEN';
        error.circuitName = this.name;
        throw error;
    }
}

// ============================================================================
// CIRCUIT BREAKER REGISTRY
// ============================================================================

/**
 * Global registry for circuit breakers
 * @type {Map<string, CircuitBreaker>}
 */
const circuitRegistry = new Map();

/**
 * Gets or creates a circuit breaker by name
 * 
 * @param {string} name - Circuit name
 * @param {CircuitBreakerOptions} [options] - Options (only used if creating new)
 * @returns {CircuitBreaker}
 */
export function getCircuitBreaker(name, options = {}) {
    if (!circuitRegistry.has(name)) {
        circuitRegistry.set(name, new CircuitBreaker(name, options));
    }
    return circuitRegistry.get(name);
}

/**
 * Gets all registered circuit breakers
 * @returns {Map<string, CircuitBreaker>}
 */
export function getAllCircuitBreakers() {
    return circuitRegistry;
}

/**
 * Gets metrics for all circuit breakers
 * @returns {Record<string, object>}
 */
export function getAllCircuitMetrics() {
    const metrics = {};
    for (const [name, breaker] of circuitRegistry) {
        metrics[name] = breaker.getMetrics();
    }
    return metrics;
}

/**
 * Resets all circuit breakers (useful for testing)
 */
export function resetAllCircuitBreakers() {
    for (const breaker of circuitRegistry.values()) {
        breaker.reset();
    }
}

/**
 * Clears all circuit breakers from registry (useful for testing)
 */
export function clearCircuitBreakerRegistry() {
    circuitRegistry.clear();
}

// ============================================================================
// PRE-CONFIGURED CIRCUIT BREAKERS FOR SERVICES
// ============================================================================

/**
 * Circuit breaker for chatVoice-service calls
 */
export const voiceServiceCircuit = getCircuitBreaker('voice-service', {
    failureThreshold: 5,
    successThreshold: 2,
    timeout: 30000,
    resetTimeout: 60000,
    onStateChange: (from, to, name) => {
        if (to === 'OPEN') {
            console.warn(`[circuit-breaker] ${name} circuit OPENED - voice service calls will be rejected`);
        } else if (to === 'CLOSED') {
            console.log(`[circuit-breaker] ${name} circuit CLOSED - voice service restored`);
        }
    },
});

/**
 * Circuit breaker for queue-service calls
 */
export const queueServiceCircuit = getCircuitBreaker('queue-service', {
    failureThreshold: 5,
    successThreshold: 2,
    timeout: 30000,
    resetTimeout: 60000,
    onStateChange: (from, to, name) => {
        if (to === 'OPEN') {
            console.warn(`[circuit-breaker] ${name} circuit OPENED - queue service calls will be rejected`);
        } else if (to === 'CLOSED') {
            console.log(`[circuit-breaker] ${name} circuit CLOSED - queue service restored`);
        }
    },
});
