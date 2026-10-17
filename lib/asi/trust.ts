/**
 * ASI Strict Mode — trust tiers.
 *
 * Maps AuthGuardian's continuous 0..1 trust score onto the
 * {@link AgentTrustLevel} tiers used by strict-mode policies.
 *
 * @module AsiTrust
 */

import { AgentTrustLevel } from './types';
import type { AsiStrictConfig, TrustResolver } from './types';
import { getAsiConfig } from './config';

/**
 * Resolve an agent's tier.
 *
 * - `AUDITOR` only when the operator listed the agent in `config.auditors`.
 * - `LOW` when the score is below `config.lowTrustBelow`, or unknown — an
 *   unidentified agent is never treated as trusted.
 * - `HIGH` otherwise.
 */
export function resolveTrustLevel(
  agentId: string | undefined,
  score: number | undefined,
  config: AsiStrictConfig = getAsiConfig(),
): AgentTrustLevel {
  if (agentId && config.auditors.includes(agentId)) return AgentTrustLevel.AUDITOR;
  if (typeof score !== 'number' || Number.isNaN(score)) return AgentTrustLevel.LOW;
  return score < config.lowTrustBelow ? AgentTrustLevel.LOW : AgentTrustLevel.HIGH;
}

/** Anything that reports a numeric trust score per agent (e.g. `AuthGuardian`). */
export interface TrustScoreSource {
  getTrustLevel(agentId: string): number;
}

/**
 * Build a {@link TrustResolver} backed by a trust-score source such as
 * `AuthGuardian`.
 */
export function createTrustResolver(
  source: TrustScoreSource,
  config: AsiStrictConfig = getAsiConfig(),
): TrustResolver {
  return (agentId) => {
    if (!agentId) return AgentTrustLevel.LOW;
    let score: number | undefined;
    try {
      score = source.getTrustLevel(agentId);
    } catch {
      score = undefined;
    }
    return resolveTrustLevel(agentId, score, config);
  };
}
