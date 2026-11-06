/**
 * Perpetual Runtime — pure decision core (Phase 5c.3).
 *
 * I/O-free functions for the decisions every invariant depends on. The
 * authority, guards, and proxy call these; property tests exercise them over
 * random inputs, and `references/formal/PerpetualCore.lean` models the same
 * definitions with machine-checked proofs:
 * - revoked and stopped run states are absorbing;
 * - recorded spend never decreases;
 * - tightening never widens scope, TTL, auto-renew, or budget;
 * - granting needs k distinct allowed signers; stopping needs any one party.
 *
 * Proofs cover this model, not every agent action. Controls stay in place.
 *
 * @module PerpetualCore
 */

import type { LeaseBudget, LeaseScope, RunState } from '../types';

/** Events that change a run's state. */
export type RunEvent = 'grant' | 'stop' | 'revoke' | 'pause' | 'resume';

/**
 * Run state machine. `revoked` and `stopped` are absorbing; `paused` only
 * leaves through an operator `resume` (or a further stop/revoke); a grant never
 * reactivates a run that is not active.
 */
export function nextRunState(state: RunState, event: RunEvent): RunState {
  if (state === 'revoked' || state === 'stopped') return state;
  switch (event) {
    case 'revoke': return 'revoked';
    case 'stop': return 'stopped';
    case 'pause': return 'paused';
    case 'resume': return state === 'paused' ? 'active' : state;
    case 'grant': return state;
  }
}

/** Spend after a report: never lower than before; invalid reports are ignored. */
export function recordSpend(prev: { usd: number; tokens: number }, reported: { usd: unknown; tokens: unknown }): { usd: number; tokens: number } {
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  return {
    usd: ok(reported.usd) ? Math.max(prev.usd, reported.usd) : prev.usd,
    tokens: ok(reported.tokens) ? Math.max(prev.tokens, reported.tokens) : prev.tokens,
  };
}

const TIERS = ['observe', 'standard', 'elevated'] as const;

/** Whether `inner` grants nothing beyond `outer`. */
export function scopeWithinCore(inner: LeaseScope, outer: LeaseScope): boolean {
  if (!inner || !outer || !TIERS.includes(inner.tier) || TIERS.indexOf(inner.tier) > TIERS.indexOf(outer.tier)) return false;
  const subset = (a: unknown, b: readonly string[] | undefined): boolean =>
    a === undefined || (Array.isArray(a) && a.every((x) => typeof x === 'string' && (b ?? []).includes(x)));
  return Array.isArray(inner.tools) && subset(inner.tools, outer.tools) && subset(inner.paths, outer.paths) && subset(inner.destinations, outer.destinations);
}

/** The policy parts tightening may change. */
export interface TightenablePolicy {
  scope: LeaseScope;
  leaseTtlMs: number;
  autoRenew: boolean;
  budget: LeaseBudget;
}

/** A requested tightening. */
export interface TightenRequest {
  scope?: LeaseScope;
  budget?: Partial<LeaseBudget>;
  leaseTtlMs?: number;
  autoRenew?: false;
}

/** Why a tighten request would loosen something, or `null` when it only narrows. */
export function tightenError(current: TightenablePolicy, delta: TightenRequest): string | null {
  if (!delta || typeof delta !== 'object') return 'tighten: delta must be an object';
  if (delta.scope !== undefined && !scopeWithinCore(delta.scope, current.scope)) return 'tighten: scope would widen';
  if (delta.leaseTtlMs !== undefined && !(Number.isFinite(delta.leaseTtlMs) && delta.leaseTtlMs >= 10_000 && delta.leaseTtlMs <= current.leaseTtlMs)) {
    return 'tighten: leaseTtlMs may only shrink (minimum 10000)';
  }
  if (delta.autoRenew !== undefined && delta.autoRenew !== false) return 'tighten: autoRenew may only be turned off';
  for (const key of ['runCeilingUsd', 'runCeilingTokens'] as const) {
    const v = delta.budget?.[key];
    if (v !== undefined && !(typeof v === 'number' && v >= 0 && v <= current.budget[key])) return `tighten: budget.${key} may only shrink`;
  }
  return null;
}

/** Apply a tightening. Anything that would loosen leaves `current` unchanged. */
export function applyTighten(current: TightenablePolicy, delta: TightenRequest): TightenablePolicy {
  if (tightenError(current, delta)) return current;
  return {
    scope: delta.scope ?? current.scope,
    leaseTtlMs: Math.min(delta.leaseTtlMs ?? current.leaseTtlMs, current.leaseTtlMs),
    autoRenew: delta.autoRenew === false ? false : current.autoRenew,
    budget: {
      runCeilingUsd: Math.min(delta.budget?.runCeilingUsd ?? current.budget.runCeilingUsd, current.budget.runCeilingUsd),
      runCeilingTokens: Math.min(delta.budget?.runCeilingTokens ?? current.budget.runCeilingTokens, current.budget.runCeilingTokens),
    },
  };
}

/** Whether `validSigners` contains at least `k` distinct allowed signer ids. */
export function quorumGrant(validSigners: readonly string[], allowed: readonly string[], k: number): boolean {
  if (!Number.isInteger(k) || k < 1) return false;
  const distinct = new Set(validSigners.filter((s) => allowed.includes(s)));
  return distinct.size >= k;
}

/** Status reported by one authority for a lease. */
export type AuthorityStatus = 'active' | 'inactive' | 'unknown';

/** Stopping needs one: any `inactive` wins; all `unknown` stays unknown. */
export function quorumActive(statuses: readonly AuthorityStatus[]): AuthorityStatus {
  if (statuses.includes('inactive')) return 'inactive';
  if (statuses.length === 0 || statuses.every((s) => s === 'unknown')) return 'unknown';
  return 'active';
}
