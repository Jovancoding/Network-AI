/**
 * Circuit Breaker — fail-fast wrapper for adapter execution.
 *
 * Implements the classic three-state machine:
 *   CLOSED    → normal pass-through; failure counter increments on every throw
 *   OPEN      → fast-fail with `CircuitOpenError`; no downstream calls made
 *   HALF_OPEN → probe phase after `recoveryTimeoutMs`; a single success closes
 *               the circuit, a single failure re-opens it
 *
 * Usage:
 * ```typescript
 * const breaker = new CircuitBreaker('my-adapter', { failureThreshold: 5 });
 * const result = await breaker.execute(() => adapter.executeAgent(...));
 * ```
 */

// ============================================================================
// TYPES
// ============================================================================

/** States a circuit breaker can be in. */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** Configuration for `CircuitBreaker`. */
export interface CircuitBreakerConfig {
  /**
   * Number of consecutive failures that trips the circuit to OPEN.
   * @default 3
   */
  failureThreshold?: number;
  /**
   * Milliseconds to wait in OPEN state before transitioning to HALF_OPEN.
   * @default 30_000
   */
  recoveryTimeoutMs?: number;
  /**
   * Consecutive successes in HALF_OPEN needed to close the circuit.
   * @default 1
   */
  successThreshold?: number;
  /**
   * Called whenever the circuit changes state.
   * Must not throw — exceptions are silently swallowed.
   */
  onStateChange?: (from: CircuitState, to: CircuitState, adapterName: string) => void;
}

// ============================================================================
// ERROR
// ============================================================================

/**
 * Thrown by `CircuitBreaker.execute()` when the circuit is OPEN.
 * Callers can catch this to implement fallback logic without masking real errors.
 */
export class CircuitOpenError extends Error {
  constructor(public readonly adapterName: string) {
    super(
      `Circuit OPEN for adapter "${adapterName}" — fast-failing to protect downstream resources`
    );
    this.name = 'CircuitOpenError';
  }
}

// ============================================================================
// CIRCUIT BREAKER
// ============================================================================

/**
 * Generic circuit breaker.  Thread-safe within a single Node.js event loop.
 *
 * @typeParam — no explicit type param; use `execute<T>()` per call.
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private successes = 0;
  private openedAt: number | null = null;

  private readonly failureThreshold: number;
  private readonly recoveryTimeoutMs: number;
  private readonly successThreshold: number;
  private readonly onStateChangeCb?: CircuitBreakerConfig['onStateChange'];

  /**
   * @param adapterName Identifies this breaker in events and error messages.
   * @param config      Optional tuning parameters.
   */
  constructor(
    public readonly adapterName: string,
    config: CircuitBreakerConfig = {}
  ) {
    this.failureThreshold = config.failureThreshold ?? 3;
    this.recoveryTimeoutMs = config.recoveryTimeoutMs ?? 30_000;
    this.successThreshold = config.successThreshold ?? 1;
    this.onStateChangeCb = config.onStateChange;
  }

  // --------------------------------------------------------------------------
  // PUBLIC API
  // --------------------------------------------------------------------------

  /**
   * Execute `fn` through the circuit breaker.
   *
   * - CLOSED: calls `fn` and tracks successes / failures.
   * - OPEN:   throws `CircuitOpenError` immediately (no call to `fn`).
   * - HALF_OPEN: calls `fn`; success closes, failure re-opens.
   *
   * @throws `CircuitOpenError` when circuit is OPEN.
   * @throws Whatever `fn` throws when circuit is CLOSED or HALF_OPEN.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.getState();
    if (state === 'OPEN') {
      throw new CircuitOpenError(this.adapterName);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      // Don't record a failure for our own fast-fail error
      if (err instanceof CircuitOpenError) throw err;
      this.onFailure();
      throw err;
    }
  }

  /** Return current state, promoting OPEN → HALF_OPEN after recovery timeout. */
  getState(): CircuitState {
    if (this.state === 'OPEN' && this.openedAt !== null) {
      if (Date.now() - this.openedAt >= this.recoveryTimeoutMs) {
        this.transition('HALF_OPEN');
      }
    }
    return this.state;
  }

  /**
   * Force the circuit to OPEN (useful for testing or manual intervention).
   * Resets the opened-at timer so recovery timeout begins from now.
   */
  trip(): void {
    this.openedAt = Date.now();
    this.transition('OPEN');
  }

  /** Force the circuit back to CLOSED and reset counters. */
  reset(): void {
    this.failures = 0;
    this.successes = 0;
    this.openedAt = null;
    this.transition('CLOSED');
  }

  // --------------------------------------------------------------------------
  // PRIVATE HELPERS
  // --------------------------------------------------------------------------

  private onSuccess(): void {
    this.failures = 0;
    if (this.state === 'HALF_OPEN') {
      this.successes++;
      if (this.successes >= this.successThreshold) {
        this.successes = 0;
        this.transition('CLOSED');
      }
    }
  }

  private onFailure(): void {
    this.successes = 0;
    if (this.state === 'HALF_OPEN') {
      // Single failure in HALF_OPEN → immediately re-open
      this.openedAt = Date.now();
      this.transition('OPEN');
      return;
    }
    this.failures++;
    if (this.failures >= this.failureThreshold) {
      this.openedAt = Date.now();
      this.transition('OPEN');
    }
  }

  private transition(to: CircuitState): void {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    if (to === 'CLOSED') {
      this.failures = 0;
      this.successes = 0;
    }
    try {
      this.onStateChangeCb?.(from, to, this.adapterName);
    } catch {
      // State-change callbacks must never break execution
    }
  }
}
