/**
 * RetryBudget — per-request retry accounting.
 *
 * Frontier models can refuse independently on the same turn (an orchestrator
 * agent and each of its sub-agents), so retries must be budgeted **per request,
 * not per session**. `RetryBudget` enforces a maximum number of retries for
 * each distinct key (a request id, task id, or sub-agent id) and never shares
 * the allowance across keys — one runaway request cannot starve the others.
 *
 * @module RetryBudget
 * @version 1.0.0
 * @license MIT
 */

/** Construction options for {@link RetryBudget}. */
export interface RetryBudgetOptions {
  /** Maximum retries allowed per key. Must be a non-negative integer. */
  maxPerKey: number;
}

/**
 * Per-key retry allowance.
 *
 * @example
 * ```typescript
 * const budget = new RetryBudget({ maxPerKey: 2 });
 * while (budget.tryConsume(requestId)) {
 *   const r = await attempt();
 *   if (r.ok) break;
 * }
 * ```
 */
export class RetryBudget {
  private readonly max: number;
  private readonly consumed: Map<string, number> = new Map();

  constructor(options: RetryBudgetOptions) {
    if (typeof options.maxPerKey !== 'number' || options.maxPerKey < 0 || !Number.isInteger(options.maxPerKey)) {
      throw new RangeError('RetryBudget: maxPerKey must be a non-negative integer');
    }
    this.max = options.maxPerKey;
  }

  /**
   * Consume one retry for `key`. Returns `false` (without consuming) once the
   * per-key budget is exhausted.
   *
   * @param key  Request/task/sub-agent identifier. Must be a non-empty string.
   */
  tryConsume(key: string): boolean {
    if (!key || typeof key !== 'string') {
      throw new TypeError('RetryBudget.tryConsume: key must be a non-empty string');
    }
    const used = this.consumed.get(key) ?? 0;
    if (used >= this.max) return false;
    this.consumed.set(key, used + 1);
    return true;
  }

  /** Retries already consumed for `key`. */
  used(key: string): number {
    return this.consumed.get(key) ?? 0;
  }

  /** Retries still available for `key`. */
  remaining(key: string): number {
    return Math.max(0, this.max - (this.consumed.get(key) ?? 0));
  }

  /** The configured per-key maximum. */
  getMax(): number {
    return this.max;
  }

  /** Reset one key, or all keys when `key` is omitted. */
  reset(key?: string): void {
    if (key === undefined) this.consumed.clear();
    else this.consumed.delete(key);
  }
}
