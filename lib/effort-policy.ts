/**
 * EffortPolicy — governed control over the model `effort` lever.
 *
 * On frontier models, `effort` (low → max) is the primary dial on per-token
 * spend: it affects text, tool calls, and thinking. `EffortPolicy` turns that
 * dial into a policy object — a global ceiling, optional per-agent ceilings, and
 * an optional justification requirement for the most expensive tiers — so an
 * orchestrator can cap sub-agents at `low` and require a reason to spend `max`.
 *
 * It satisfies the `EffortSink` contract consumed by
 * {@link ../lib/model-gateway!GovernedModelGateway}, which calls
 * {@link EffortPolicy.resolve} to clamp each request's effort.
 *
 * @module EffortPolicy
 * @version 1.0.0
 * @license MIT
 */

import type { EffortLevel } from './model-gateway';

/** Effort tiers, lowest to highest. */
const ORDER: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Rank of an effort level (0 = `low`). */
function rank(level: EffortLevel): number {
  const i = ORDER.indexOf(level);
  return i < 0 ? ORDER.indexOf('high') : i;
}

/** The lower of two effort levels. */
function minLevel(a: EffortLevel, b: EffortLevel): EffortLevel {
  return rank(a) <= rank(b) ? a : b;
}

/** Construction options for {@link EffortPolicy}. */
export interface EffortPolicyOptions {
  /** Maximum effort any request may use (default: `'max'`). */
  ceiling?: EffortLevel;
  /** Effort applied when a request omits one (default: `'high'`). */
  default?: EffortLevel;
  /** Per-agent ceilings that override the global ceiling for specific agents. */
  perAgent?: Record<string, EffortLevel>;
  /** Effort at or above this tier requires a non-empty justification. */
  requireJustificationAtOrAbove?: EffortLevel;
}

/** Outcome of {@link EffortPolicy.gate}. */
export interface EffortDecision {
  /** The granted effort level after applying ceilings and justification rules. */
  granted: EffortLevel;
  /** Whether the granted level is below what was requested. */
  downgraded: boolean;
  /** Why the request was downgraded, if it was. */
  reason?: 'agent_ceiling' | 'global_ceiling' | 'justification_required';
}

/**
 * Governs the `effort` lever.
 *
 * @example
 * ```typescript
 * const policy = new EffortPolicy({
 *   ceiling: 'high',
 *   perAgent: { 'subagent-*': 'low' },
 *   requireJustificationAtOrAbove: 'xhigh',
 * });
 *
 * policy.resolve('max', { agentId: 'analyst' });        // → 'high' (global ceiling)
 * policy.gate('xhigh', { agentId: 'analyst' }).reason;  // → 'justification_required'
 * ```
 */
export class EffortPolicy {
  private readonly ceiling: EffortLevel;
  private readonly defaultLevel: EffortLevel;
  private readonly perAgent: Record<string, EffortLevel>;
  private readonly justificationThreshold: EffortLevel | undefined;

  constructor(options: EffortPolicyOptions = {}) {
    this.ceiling = options.ceiling ?? 'max';
    this.defaultLevel = options.default ?? 'high';
    this.perAgent = options.perAgent ?? {};
    this.justificationThreshold = options.requireJustificationAtOrAbove;
  }

  /**
   * Clamp a requested effort to what policy permits. Satisfies `EffortSink`.
   *
   * Applies the per-agent (or global) ceiling. Justification rules are not
   * applied here — use {@link gate} when you have a justification to evaluate.
   *
   * @param requested  The requested level (falls back to the policy default).
   * @param ctx        `agentId` selects a per-agent ceiling.
   * @returns          The granted effort level.
   */
  resolve(requested: EffortLevel | undefined, ctx: { agentId?: string } = {}): EffortLevel {
    const want = requested ?? this.defaultLevel;
    const cap = this.ceilingFor(ctx.agentId);
    return minLevel(want, cap);
  }

  /**
   * Resolve effort and report whether (and why) it was downgraded — including
   * the justification requirement for high tiers.
   *
   * @param requested  The requested level (falls back to the policy default).
   * @param ctx        `agentId` selects a per-agent ceiling; `justification`
   *                   unlocks tiers at or above the configured threshold.
   */
  gate(
    requested: EffortLevel | undefined,
    ctx: { agentId?: string; justification?: string } = {},
  ): EffortDecision {
    const want = requested ?? this.defaultLevel;
    const cap = this.ceilingFor(ctx.agentId);
    let granted = minLevel(want, cap);
    let reason: EffortDecision['reason'] | undefined;

    if (rank(granted) < rank(want)) {
      reason = cap === this.perAgent[ctx.agentId ?? ''] ? 'agent_ceiling' : 'global_ceiling';
    }

    if (
      this.justificationThreshold &&
      rank(granted) >= rank(this.justificationThreshold) &&
      !(ctx.justification && ctx.justification.trim().length > 0)
    ) {
      // Clamp to the highest tier below the justification threshold.
      const belowIdx = Math.max(0, rank(this.justificationThreshold) - 1);
      granted = ORDER[belowIdx];
      reason = 'justification_required';
    }

    return { granted, downgraded: rank(granted) < rank(want), reason };
  }

  /** The effort ceiling that applies to `agentId` (per-agent, else global). */
  private ceilingFor(agentId?: string): EffortLevel {
    if (agentId && this.perAgent[agentId]) return this.perAgent[agentId];
    return this.ceiling;
  }
}
