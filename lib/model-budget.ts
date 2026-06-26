/**
 * ModelBudget — cross-model cost accounting with fallback-credit repricing.
 *
 * Where {@link ../lib/federated-budget!FederatedBudget} tracks raw token counts
 * against a shared ceiling, `ModelBudget` tracks **money**. It prices each
 * attempt with a per-model rate card, distinguishes cache-read from cache-write
 * input tokens, and — critically for a refusal → fallback flow — reprices a
 * redeemed fallback credit so the retry is billed as a cache read (≈10% of the
 * base input rate) instead of a cache write (1.25×–2×).
 *
 * It satisfies the `BudgetSink` contract consumed by
 * {@link ../lib/model-gateway!GovernedModelGateway}, and can optionally forward
 * token totals into a `FederatedBudget` for unified swarm-wide ceilings.
 *
 * @module ModelBudget
 * @version 1.0.0
 * @license MIT
 */

// ============================================================================
// TYPES
// ============================================================================

/** Per-model rate card. Multipliers are applied to the input rate. */
export interface ModelPricing {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
  /** Multiplier on the input rate for cache-read tokens. Default `0.1`. */
  cacheReadMultiplier?: number;
  /** Multiplier on the input rate for cache-creation (write) tokens. Default `1.25`. */
  cacheWriteMultiplier?: number;
}

/** Token usage for a single attempt. Matches the gateway's `ModelUsage`. */
export interface UsageLike {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/** Minimal token-budget contract (a `FederatedBudget` satisfies this). */
export interface TokenBudgetLike {
  spend(agentId: string, tokens: number): { allowed: boolean };
}

/** Construction options for {@link ModelBudget}. */
export interface ModelBudgetOptions {
  /** Total USD ceiling across all models. Must be positive and finite. */
  ceilingUsd: number;
  /** Per-model rate cards keyed by model id. */
  pricing: Record<string, ModelPricing>;
  /** Rate card used for models absent from `pricing`. */
  defaultPricing?: ModelPricing;
  /** Optional token budget to also debit (e.g. a `FederatedBudget`). */
  tokenBudget?: TokenBudgetLike;
}

/** One raw per-attempt usage record (mirrors a `usage.iterations[]` entry). */
export interface UsageIteration {
  /** `'fallback_message'` is the served attempt; `'message'` is a declined hop. */
  type: 'message' | 'fallback_message' | string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

// ============================================================================
// PURE COST FUNCTION
// ============================================================================

/**
 * Compute the USD cost of one attempt.
 *
 * `inputTokens` is treated as *uncached* input; `cacheReadInputTokens` and
 * `cacheCreationInputTokens` are billed separately via their multipliers. When
 * `creditRedeemed` is set, cache-creation tokens are repriced at the cache-read
 * multiplier — the fallback-credit refund.
 *
 * @param usage    Token usage for the attempt.
 * @param pricing  The model's rate card.
 * @param opts     `creditRedeemed` reprices cache-write as cache-read.
 * @returns        Cost in USD.
 */
export function costOfUsage(
  usage: UsageLike,
  pricing: ModelPricing,
  opts?: { creditRedeemed?: boolean },
): number {
  const inRate = pricing.inputPerMTok / 1_000_000;
  const outRate = pricing.outputPerMTok / 1_000_000;
  const readMult = pricing.cacheReadMultiplier ?? 0.1;
  const writeMult = pricing.cacheWriteMultiplier ?? 1.25;

  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheWrite = usage.cacheCreationInputTokens ?? 0;
  const writeEffectiveMult = opts?.creditRedeemed ? readMult : writeMult;

  return (
    usage.inputTokens * inRate +
    cacheRead * inRate * readMult +
    cacheWrite * inRate * writeEffectiveMult +
    usage.outputTokens * outRate
  );
}

// ============================================================================
// MODEL BUDGET
// ============================================================================

/**
 * USD budget tracker priced per model, with fallback-credit awareness.
 *
 * @example
 * ```typescript
 * const budget = new ModelBudget({
 *   ceilingUsd: 5,
 *   pricing: {
 *     'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
 *     'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
 *   },
 * });
 *
 * budget.recordAttempt('claude-opus-4-8', { inputTokens: 1000, outputTokens: 500 });
 * budget.remainingUsd();
 * ```
 */
export class ModelBudget {
  private readonly _ceilingUsd: number;
  private readonly _pricing: Record<string, ModelPricing>;
  private readonly _defaultPricing: ModelPricing | undefined;
  private readonly _tokenBudget: TokenBudgetLike | undefined;
  private _spentUsd = 0;
  private readonly _perModelUsd: Map<string, number> = new Map();

  constructor(options: ModelBudgetOptions) {
    if (typeof options.ceilingUsd !== 'number' || options.ceilingUsd <= 0 || !Number.isFinite(options.ceilingUsd)) {
      throw new RangeError('ModelBudget: ceilingUsd must be a positive finite number');
    }
    if (!options.pricing || typeof options.pricing !== 'object') {
      throw new TypeError('ModelBudget: pricing must be an object of model → rate card');
    }
    this._ceilingUsd = options.ceilingUsd;
    this._pricing = options.pricing;
    this._defaultPricing = options.defaultPricing;
    this._tokenBudget = options.tokenBudget;
  }

  /**
   * Record one attempt's usage and return its cost plus remaining budget.
   *
   * @param model  The model that ran the attempt.
   * @param usage  Token usage for the attempt.
   * @param opts   `creditRedeemed` reprices cache-write as cache-read; `agentId`
   *               attributes the spend on the optional token budget.
   * @returns      `{ costUsd, remainingUsd, allowed }`. `allowed` is `false`
   *               once the ceiling is breached, signalling callers to stop.
   */
  recordAttempt(
    model: string,
    usage: UsageLike,
    opts?: { creditRedeemed?: boolean; agentId?: string },
  ): { costUsd: number; remainingUsd: number; allowed: boolean } {
    const pricing = this._pricing[model] ?? this._defaultPricing;
    const costUsd = pricing ? costOfUsage(usage, pricing, opts) : 0;

    this._spentUsd += costUsd;
    this._perModelUsd.set(model, (this._perModelUsd.get(model) ?? 0) + costUsd);

    if (this._tokenBudget) {
      const tokens = Math.max(0, Math.round(usage.inputTokens + usage.outputTokens));
      if (tokens > 0) {
        this._tokenBudget.spend(opts?.agentId ?? model, tokens);
      }
    }

    return {
      costUsd,
      remainingUsd: this.remainingUsd(),
      allowed: this._spentUsd <= this._ceilingUsd,
    };
  }

  /**
   * Account an entire `usage.iterations` array from a server-side fallback
   * response. The `fallback_message` hop is repriced as a cache read, matching
   * the API's automatic billing change.
   *
   * @param iterations  The per-attempt usage records.
   * @param agentId     Optional attribution for the token budget.
   * @returns           Total USD across all iterations.
   */
  accountIterations(iterations: UsageIteration[], agentId?: string): number {
    let total = 0;
    for (const it of iterations) {
      const creditRedeemed = it.type === 'fallback_message';
      const { costUsd } = this.recordAttempt(
        it.model,
        {
          inputTokens: it.inputTokens,
          outputTokens: it.outputTokens,
          cacheReadInputTokens: it.cacheReadInputTokens,
          cacheCreationInputTokens: it.cacheCreationInputTokens,
        },
        { creditRedeemed, agentId },
      );
      total += costUsd;
    }
    return total;
  }

  /** Remaining USD in the pool (never negative). */
  remainingUsd(): number {
    return Math.max(0, this._ceilingUsd - this._spentUsd);
  }

  /** Total USD spent across all models. */
  getTotalUsd(): number {
    return this._spentUsd;
  }

  /** Per-model USD totals as a plain object. */
  getPerModelUsd(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [model, usd] of this._perModelUsd) out[model] = usd;
    return out;
  }

  /** The configured USD ceiling. */
  getCeilingUsd(): number {
    return this._ceilingUsd;
  }

  /** Reset all spend counters. */
  reset(): void {
    this._spentUsd = 0;
    this._perModelUsd.clear();
  }
}
