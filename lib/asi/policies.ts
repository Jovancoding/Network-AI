/**
 * ASI Strict Mode — trust-tiered context and cognitive-bandwidth policies.
 *
 * Pure helpers consumed by `ContextComposer`, `EffortPolicy`,
 * `ThinkingBlockManager`, and `GovernedModelGateway`. With strict mode off
 * they return their input unchanged.
 *
 * @module AsiPolicies
 */

import { getAsiConfig, isAsiActive } from './config';
import { AgentTrustLevel } from './types';
import type { AsiStrictConfig, CognitiveBudget, TrustContextPolicy } from './types';

/** Minimal context-source shape (structurally `ContextSource`). */
export interface TieredContextSource {
  key: string;
  sourceAgent?: string;
  /** Pinned items (the caller's own instructions) are exempt from the scope filter */
  pinned?: boolean;
}

/** Minimal compose-options shape (structurally `ComposeOptions`). */
export interface TieredComposeOptions {
  budgetTokens: number;
  minScore?: number;
  maxItems?: number;
}

/** The context policy for `tier`, or `undefined` when none applies. */
export function contextPolicyFor(tier: AgentTrustLevel | undefined, config: AsiStrictConfig = getAsiConfig()): TrustContextPolicy | undefined {
  if (!isAsiActive(config) || !config.context) return undefined;
  return config.context[tier ?? AgentTrustLevel.LOW];
}

/**
 * Narrow sources and tighten options for a trust tier: smaller budget, higher
 * score floor, fewer items, allowed scopes only, excluded producers dropped.
 */
export function applyContextPolicy<S extends TieredContextSource, O extends TieredComposeOptions>(
  sources: readonly S[],
  options: O,
  policy: TrustContextPolicy,
): { sources: S[]; options: O; removed: string[] } {
  const removed: string[] = [];
  const allowed = policy.allowedScopeTags?.map((t) => t.toLowerCase());
  const kept = sources.filter((s) => {
    const key = (s.key ?? '').toLowerCase();
    const scopeOk = !allowed || s.pinned === true || allowed.some((t) => key.includes(t));
    const producerOk = !(s.sourceAgent && policy.excludeSourceAgents?.includes(s.sourceAgent));
    if (!scopeOk || !producerOk) removed.push(s.key);
    return scopeOk && producerOk;
  });
  const tightened: O = {
    ...options,
    budgetTokens: Math.min(options.budgetTokens, policy.maxBudgetTokens),
    minScore: Math.max(options.minScore ?? 0.05, policy.minScore ?? 0),
    maxItems: policy.maxItems === undefined
      ? options.maxItems
      : options.maxItems && options.maxItems > 0 ? Math.min(options.maxItems, policy.maxItems) : policy.maxItems,
  };
  return { sources: kept, options: tightened, removed };
}

/** The cognitive budget for `tier`, or `undefined` when none applies. */
export function cognitiveBudgetFor(tier: AgentTrustLevel | undefined, config: AsiStrictConfig = getAsiConfig()): CognitiveBudget | undefined {
  if (!isAsiActive(config) || !config.cognitive) return undefined;
  return config.cognitive[tier ?? AgentTrustLevel.LOW];
}

/** Cap a requested thinking budget; with no budget the request passes through. */
export function capThinkingBudget(requested: number | undefined, budget: CognitiveBudget | undefined): number | undefined {
  if (!budget) return requested;
  if (requested === undefined || !Number.isFinite(requested)) return budget.maxThinkingTokens;
  return Math.max(0, Math.min(requested, budget.maxThinkingTokens));
}
