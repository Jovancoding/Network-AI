/**
 * Perpetual Runtime — budget auto-balancer (invariant I3).
 *
 * Spreads work across operator-approved funding and compute sources and
 * throttles effort as money runs low — always inside ceilings set in an
 * operator-signed {@link BudgetPolicy}. Agents may lower ceilings, never raise
 * them, and can never add a source; both need a newer signed policy. Hard
 * enforcement lives outside the agent: the lease authority stops renewal at
 * the run ceiling (fed by {@link BudgetBalancer.spend}), and the egress proxy
 * caps financial requests per call and per run.
 *
 * @module BudgetBalancer
 */

import type { KeyObject } from 'crypto';
import { ensureEd25519, keyIdOf, signCanonical, verifyCanonical, type Ed25519KeyPair } from './signing';

/** An operator-approved place to spend. */
export interface FundingSource {
  id: string;
  kind: 'model-provider' | 'compute' | 'wallet';
  /** Price per million tokens (USD), used to prefer cheaper sources */
  costPerMTokUsd?: number;
  /** Most this source may be charged over the policy's life (USD) */
  maxUsd?: number;
}

/** Operator-authored budget policy. */
export interface BudgetPolicy {
  v: 'nai-budget-v1';
  policyId: string;
  issuedAt: number;
  ceilingUsd: number;
  ceilingTokens: number;
  sources: readonly FundingSource[];
  /** Effort drops to `reduced` / `minimal` below these remaining fractions (defaults 0.25 / 0.1) */
  throttle?: { reducedBelow?: number; minimalBelow?: number };
}

/** A {@link BudgetPolicy} signed by the operator key. */
export interface SignedBudgetPolicy {
  policy: BudgetPolicy;
  alg: 'ed25519';
  keyId: string;
  signature: string;
}

/** How hard agents should work given the money left. */
export type EffortLevel = 'full' | 'reduced' | 'minimal' | 'stopped';

/** Result of {@link BudgetBalancer.authorize}. */
export interface SpendDecision {
  allowed: boolean;
  reason?: string;
  effort: EffortLevel;
}

const NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
const KINDS = ['model-provider', 'compute', 'wallet'];

/** Validate a budget policy. Throws `TypeError` on any problem. */
export function validateBudgetPolicy(p: BudgetPolicy): void {
  if (!p || p.v !== 'nai-budget-v1') throw new TypeError('budget policy v must be "nai-budget-v1"');
  if (typeof p.policyId !== 'string' || !NAME.test(p.policyId)) throw new TypeError('budget policy policyId is invalid');
  if (!Number.isFinite(p.issuedAt)) throw new TypeError('budget policy issuedAt must be epoch ms');
  for (const k of ['ceilingUsd', 'ceilingTokens'] as const) {
    if (!(Number.isFinite(p[k]) && p[k] >= 0)) throw new TypeError(`budget policy ${k} must be a finite non-negative number`);
  }
  if (!Array.isArray(p.sources) || p.sources.length > 64) throw new TypeError('budget policy sources must be an array of at most 64');
  const ids = new Set<string>();
  for (const s of p.sources) {
    if (!s || !NAME.test(s.id) || ids.has(s.id)) throw new TypeError('budget policy has an invalid or duplicate source id');
    if (!KINDS.includes(s.kind)) throw new TypeError(`source ${s.id} has an invalid kind`);
    if (s.costPerMTokUsd !== undefined && !(Number.isFinite(s.costPerMTokUsd) && s.costPerMTokUsd >= 0)) throw new TypeError(`source ${s.id} costPerMTokUsd is invalid`);
    if (s.maxUsd !== undefined && !(Number.isFinite(s.maxUsd) && s.maxUsd >= 0)) throw new TypeError(`source ${s.id} maxUsd is invalid`);
    ids.add(s.id);
  }
  const t = p.throttle ?? {};
  const reduced = t.reducedBelow ?? 0.25;
  const minimal = t.minimalBelow ?? 0.1;
  if (!(reduced >= 0 && reduced <= 1 && minimal >= 0 && minimal <= reduced)) throw new TypeError('budget policy throttle must satisfy 0 <= minimalBelow <= reducedBelow <= 1');
}

/** Sign a budget policy with the operator key. */
export function signBudgetPolicy(policy: BudgetPolicy, operator: Pick<Ed25519KeyPair, 'privateKey'>): SignedBudgetPolicy {
  validateBudgetPolicy(policy);
  ensureEd25519(operator.privateKey, 'private', 'operator.privateKey');
  return { policy, alg: 'ed25519', keyId: keyIdOf(operator.privateKey), signature: signCanonical(policy, operator.privateKey) };
}

function verifyBudgetPolicy(signed: SignedBudgetPolicy, operatorPublicKey: KeyObject): string | null {
  if (!signed || signed.alg !== 'ed25519') return 'budget policy is not Ed25519-signed';
  if (signed.keyId !== keyIdOf(operatorPublicKey)) return 'budget policy signed by an unknown key';
  if (!verifyCanonical(signed.policy, signed.signature, operatorPublicKey)) return 'budget policy signature invalid';
  try { validateBudgetPolicy(signed.policy); } catch (err) { return err instanceof Error ? err.message : 'budget policy invalid'; }
  return null;
}

/** Options for {@link BudgetBalancer}. */
export interface BudgetBalancerOptions {
  operatorPublicKey: KeyObject;
  policy: SignedBudgetPolicy;
  /** External meters (e.g. `ModelBudget.getTotalUsd`, `FederatedBudget.getTotalSpent`); the higher reading wins */
  track?: { usd?: () => number; tokens?: () => number };
  onEvent?: (event: { at: number; action: string; sourceId?: string; reason?: string }) => void;
  now?: () => number;
}

/** Allocates spend across approved sources inside operator-signed ceilings. */
export class BudgetBalancer {
  private signed: SignedBudgetPolicy;
  private lowered: { usd?: number; tokens?: number } = {};
  private spentUsd = 0;
  private spentTokens = 0;
  private readonly perSource = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly options: BudgetBalancerOptions) {
    ensureEd25519(options.operatorPublicKey, 'public', 'operatorPublicKey');
    const reason = verifyBudgetPolicy(options.policy, options.operatorPublicKey);
    if (reason) throw new TypeError(`BudgetBalancer: ${reason}`);
    this.signed = options.policy;
    this.now = options.now ?? Date.now;
  }

  /** Effective USD ceiling (signed ceiling, possibly lowered). */
  get ceilingUsd(): number {
    return Math.min(this.signed.policy.ceilingUsd, this.lowered.usd ?? Infinity);
  }

  /** Effective token ceiling. */
  get ceilingTokens(): number {
    return Math.min(this.signed.policy.ceilingTokens, this.lowered.tokens ?? Infinity);
  }

  /** Cumulative spend, for `LeaseGuard`'s `spend` heartbeat option. */
  spend(): { usd: number; tokens: number } {
    const usd = Math.max(this.spentUsd, safe(this.options.track?.usd));
    const tokens = Math.max(this.spentTokens, safe(this.options.track?.tokens));
    return { usd, tokens };
  }

  /** Current effort level from the remaining fraction of the tighter ceiling. */
  effort(): EffortLevel {
    const { usd, tokens } = this.spend();
    const fracUsd = this.ceilingUsd > 0 ? 1 - usd / this.ceilingUsd : 0;
    const fracTok = this.ceilingTokens > 0 ? 1 - tokens / this.ceilingTokens : 0;
    const remaining = Math.min(fracUsd, fracTok);
    const t = this.signed.policy.throttle ?? {};
    if (remaining <= 0) return 'stopped';
    if (remaining < (t.minimalBelow ?? 0.1)) return 'minimal';
    if (remaining < (t.reducedBelow ?? 0.25)) return 'reduced';
    return 'full';
  }

  /** Whether a planned spend on a source is allowed. Unknown sources are always refused. */
  authorize(sourceId: string, estimate: { usd: number; tokens?: number }): SpendDecision {
    const source = this.signed.policy.sources.find((s) => s.id === sourceId);
    const refuse = (reason: string): SpendDecision => {
      this.emit('refuse', sourceId, reason);
      return { allowed: false, reason, effort: this.effort() };
    };
    if (!source) return refuse('source is not approved by the operator');
    if (!(estimate && Number.isFinite(estimate.usd) && estimate.usd >= 0)) return refuse('invalid estimate');
    const tokens = estimate.tokens ?? 0;
    if (!(Number.isFinite(tokens) && tokens >= 0)) return refuse('invalid estimate');
    const { usd, tokens: spentTokens } = this.spend();
    if (usd + estimate.usd > this.ceilingUsd) return refuse('would exceed the USD ceiling');
    if (spentTokens + tokens > this.ceilingTokens) return refuse('would exceed the token ceiling');
    if (source.maxUsd !== undefined && (this.perSource.get(sourceId) ?? 0) + estimate.usd > source.maxUsd) return refuse('would exceed the source limit');
    return { allowed: true, effort: this.effort() };
  }

  /** Record spend that happened. Spend on an unapproved source is still counted, and reported. */
  record(sourceId: string, actual: { usd: number; tokens?: number }): EffortLevel {
    const usd = Number.isFinite(actual?.usd) && actual.usd > 0 ? actual.usd : 0;
    const tokens = Number.isFinite(actual?.tokens) && (actual.tokens ?? 0) > 0 ? actual.tokens! : 0;
    this.spentUsd += usd;
    this.spentTokens += tokens;
    this.perSource.set(sourceId, (this.perSource.get(sourceId) ?? 0) + usd);
    if (!this.signed.policy.sources.some((s) => s.id === sourceId)) this.emit('unapproved-spend', sourceId, `${usd} USD`);
    return this.effort();
  }

  /**
   * The cheapest approved source (by `costPerMTokUsd`) of the given kind with
   * headroom for `estimateUsd`, or `null` when none fits.
   */
  chooseSource(estimateUsd: number, kind: FundingSource['kind'] = 'model-provider'): FundingSource | null {
    const candidates = this.signed.policy.sources
      .filter((s) => s.kind === kind)
      .sort((a, b) => (a.costPerMTokUsd ?? Infinity) - (b.costPerMTokUsd ?? Infinity));
    for (const s of candidates) if (this.authorize(s.id, { usd: estimateUsd }).allowed) return s;
    return null;
  }

  /** Lower the effective ceilings. Anything higher than the current value throws. */
  lowerCeiling(limits: { usd?: number; tokens?: number }): void {
    if (limits.usd !== undefined) {
      if (!(limits.usd >= 0 && limits.usd <= this.ceilingUsd)) throw new Error('lowerCeiling: the USD ceiling may only go down');
      this.lowered.usd = limits.usd;
    }
    if (limits.tokens !== undefined) {
      if (!(limits.tokens >= 0 && limits.tokens <= this.ceilingTokens)) throw new Error('lowerCeiling: the token ceiling may only go down');
      this.lowered.tokens = limits.tokens;
    }
    this.emit('lower', undefined, JSON.stringify(limits));
  }

  /** Agents cannot add funding sources; this always throws. */
  addSource(_source: FundingSource): never {
    this.emit('refuse', _source?.id, 'new sources need an operator-signed policy');
    throw new Error('addSource: new funding sources require a newer operator-signed budget policy');
  }

  /** Install a newer operator-signed policy (the only way to raise ceilings or add sources). */
  installPolicy(signed: SignedBudgetPolicy): void {
    const reason = verifyBudgetPolicy(signed, this.options.operatorPublicKey);
    if (reason) throw new Error(`installPolicy: ${reason}`);
    if (signed.policy.issuedAt <= this.signed.policy.issuedAt) throw new Error('installPolicy: policy is not newer than the active one');
    this.signed = signed;
    this.lowered = {};
    this.emit('policy', undefined, signed.policy.policyId);
  }

  /** Snapshot for dashboards and audits. */
  status(): { policyId: string; ceilingUsd: number; ceilingTokens: number; spentUsd: number; spentTokens: number; effort: EffortLevel; perSourceUsd: Record<string, number> } {
    const { usd, tokens } = this.spend();
    return {
      policyId: this.signed.policy.policyId, ceilingUsd: this.ceilingUsd, ceilingTokens: this.ceilingTokens,
      spentUsd: usd, spentTokens: tokens, effort: this.effort(), perSourceUsd: Object.fromEntries(this.perSource),
    };
  }

  private emit(action: string, sourceId?: string, reason?: string): void {
    try { this.options.onEvent?.({ at: this.now(), action, sourceId, reason }); } catch { /* audit only */ }
  }
}

function safe(read: (() => number) | undefined): number {
  if (!read) return 0;
  try {
    const v = read();
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}
