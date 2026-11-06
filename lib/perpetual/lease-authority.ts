/**
 * Perpetual Runtime — Lease Authority.
 *
 * Issues short-lived signed leases to long-running agent runs and renews them
 * only while the operator-signed {@link RenewalPolicy} allows. It runs in its
 * own process; agents reach it only through the `runner` role.
 *
 * Human control is enforced here, independent of agent cooperation:
 * - `revoke` / `pause` invalidate current leases immediately;
 * - `tighten` and sentry alerts can only narrow or stop renewal;
 * - only the operator can `resume` or install a new signed policy;
 * - a run that stops renewing halts within one lease period (dead-man switch).
 *
 * @module LeaseAuthority
 */

import { createHash, randomBytes, timingSafeEqual, type KeyObject } from 'crypto';
import type { IncomingMessage, ServerResponse, Server } from 'http';
import { isLoopbackHost } from '../http-guards';
import {
  ensureEd25519,
  isHighRiskPolicy,
  keyIdOf,
  policyHash,
  scopeWithin,
  signLease,
  signWith,
  verifyCanonical,
  verifySignedPolicy,
  type Ed25519KeyPair,
  type Signer,
} from './signing';
import { verifyCheckpoint, type SignedCheckpoint } from './checkpoint';
import { checkAttestation, type AttestationVerifier } from './attestation';
import { verifyCapabilityEval, type SignedCapabilityEval } from './capability-eval';
import { nextRunState, recordSpend, tightenError } from './core';
import type {
  AttestationEvidence,
  ControlRole,
  Heartbeat,
  LeaseBudget,
  LeaseClaims,
  LeaseCosignature,
  LeaseDecision,
  LeaseScope,
  RenewalPolicy,
  RunState,
  RunStatus,
  SignedLease,
  SignedPolicy,
} from './types';

/** Alert severities a sentry can report. */
export type AlertLevel = 'info' | 'warning' | 'critical';

/** A stricter-only change to the active policy. */
export interface TightenDelta {
  scope?: LeaseScope;
  budget?: Partial<LeaseBudget>;
  leaseTtlMs?: number;
  /** Only `false` is accepted (turning auto-renew off) */
  autoRenew?: false;
}

/** One authority decision, for the audit trail. */
export interface AuthorityEvent {
  at: number;
  action: 'issue' | 'renew' | 'refuse' | 'revoke' | 'pause' | 'resume' | 'tighten' | 'alert' | 'policy' | 'stop' | 'checkpoint' | 'cosign' | 'capability-eval';
  role: ControlRole;
  runId?: string;
  leaseId?: string;
  reason?: string;
}

/** Result of a co-sign request (k-of-n). */
export interface CosignDecision {
  granted: boolean;
  cosignature?: LeaseCosignature;
  reason?: string;
}

/** Constructor options for {@link LeaseAuthority}. */
export interface LeaseAuthorityOptions {
  /** Operator public key; only policies it signed are accepted */
  operatorPublicKey: KeyObject;
  /** Authority signing key pair, or a `Signer` (HSM/KMS/external program) so the private key stays out of this process */
  authorityKey: Ed25519KeyPair | Signer;
  /** Initial operator-signed policy */
  policy: SignedPolicy;
  /** Clock override (tests) */
  now?: () => number;
  /** Audit callback (wire to `SecureAuditLogger` / `HashChainSink`) */
  onEvent?: (event: AuthorityEvent) => void;
  /** Verifiers for `policy.attestation` (bring-your-own TPM / SEV-SNP / TDX / Nitro) */
  attestationVerifiers?: readonly AttestationVerifier[];
  /**
   * Public keys of the other authorities in `policy.authorityQuorum`. A
   * co-signature is only given for claims signed by their issuing peer, so
   * every lease starts at some authority's full issue/renew checks.
   */
  peerAuthorityKeys?: readonly KeyObject[];
}

/** What one authority knows about a lease. `unknown`: it never granted or co-signed it. */
export type LeaseStatusValue = 'active' | 'inactive' | 'unknown';

/** Bearer secrets for the control API. */
export interface AuthoritySecrets {
  operator?: string;
  /** Shared sentry secret (identity `sentry`); prefer `sentries` so the quorum counts real identities */
  sentry?: string;
  runner?: string;
  /** Per-sentry secrets keyed by sentry id */
  sentries?: Readonly<Record<string, string>>;
}

interface Caller {
  role: ControlRole;
  identity: string;
}

interface RunRecord {
  state: RunState;
  sequence: number;
  currentLeaseId?: string;
  expiresAt?: number;
  spentUsd: number;
  spentTokens: number;
  reason?: string;
  /** Nonce the next renewal's attestation must bind */
  attestationNonce?: string;
}

const ALERT_RANK: Record<AlertLevel, number> = { info: 0, warning: 1, critical: 2 };
/** Authenticated identity of the egress proxy's sentry secret (`sentries.proxy`). */
export const TRIPWIRE_SOURCE = 'sentry:proxy';
const RUN_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_RUNS = 10_000;
const CHALLENGE_TTL_MS = 60_000;

/** Issues, renews, and revokes leases under an operator-signed policy. */
export class LeaseAuthority {
  private signed: SignedPolicy;
  private readonly runs = new Map<string, RunRecord>();
  private readonly revoked = new Set<string>();
  private overlay: TightenDelta = {};
  private paused = false;
  private highestAlert: AlertLevel = 'info';
  private alerts: { source: string; at: number }[] = [];
  /** Newest accepted checkpoint covering all runs (issuedAt) */
  private checkpointAll = 0;
  /** Newest accepted per-run checkpoint (issuedAt) */
  private readonly checkpointRun = new Map<string, number>();
  private readonly checkpointNonces = new Set<string>();
  private readonly attestationVerifiers: readonly AttestationVerifier[];
  /** Outstanding issue challenges: runId → nonce and when it was issued */
  private readonly challenges = new Map<string, { nonce: string; at: number }>();
  private capabilityEval: SignedCapabilityEval | null = null;
  private readonly peers = new Map<string, KeyObject>();
  /** Set by a trusted tripwire or a sentry stop that reached quorum; only an operator resume clears it */
  private alertLatch: string | null = null;
  /** Set by `revoke --all`; runs this authority never saw then read as inactive until an operator resume */
  private revokedAll = false;
  private readonly now: () => number;
  private readonly operatorPublicKey: KeyObject;
  private readonly authorityKey: Ed25519KeyPair | Signer;
  private readonly onEvent?: (event: AuthorityEvent) => void;

  constructor(options: LeaseAuthorityOptions) {
    this.operatorPublicKey = options.operatorPublicKey;
    this.authorityKey = options.authorityKey;
    this.now = options.now ?? Date.now;
    this.onEvent = options.onEvent;
    if (keyIdOf(this.authorityKey.publicKey) === keyIdOf(this.operatorPublicKey)) {
      throw new TypeError('LeaseAuthority: authority and operator keys must differ');
    }
    const reason = verifySignedPolicy(options.policy, this.operatorPublicKey);
    if (reason) throw new TypeError(`LeaseAuthority: ${reason}`);
    assertInQuorum(options.policy, keyIdOf(this.authorityKey.publicKey));
    this.attestationVerifiers = options.attestationVerifiers ?? [];
    this.assertAttestationReady(options.policy);
    for (const k of options.peerAuthorityKeys ?? []) {
      ensureEd25519(k, 'public', 'peerAuthorityKeys[]');
      const id = keyIdOf(k);
      if (id !== keyIdOf(this.authorityKey.publicKey)) this.peers.set(id, k);
    }
    this.signed = options.policy;
  }

  /** Public key agents and the egress proxy use to verify leases. */
  get publicKey(): KeyObject {
    return this.authorityKey.publicKey;
  }

  /** The effective policy: the signed policy narrowed by any tightening. */
  effectivePolicy(): RenewalPolicy {
    const p = this.signed.policy;
    const o = this.overlay;
    return {
      ...p,
      leaseTtlMs: o.leaseTtlMs !== undefined ? Math.min(o.leaseTtlMs, p.leaseTtlMs) : p.leaseTtlMs,
      autoRenew: o.autoRenew === false ? false : p.autoRenew,
      scope: o.scope ?? p.scope,
      budget: {
        runCeilingUsd: Math.min(o.budget?.runCeilingUsd ?? Infinity, p.budget.runCeilingUsd),
        runCeilingTokens: Math.min(o.budget?.runCeilingTokens ?? Infinity, p.budget.runCeilingTokens),
      },
    };
  }

  /** Issue the first lease for a run (or a fresh one after an operator resume). */
  issue(runId: string, role: ControlRole = 'runner', attestation?: AttestationEvidence): LeaseDecision {
    if (role !== 'runner' && role !== 'operator') return this.refuse(role, runId, 'role may not issue leases');
    if (typeof runId !== 'string' || !RUN_ID.test(runId)) return this.refuse(role, undefined, 'invalid runId');
    const blocked = this.blockedReason();
    if (blocked) return this.refuse(role, runId, blocked);
    if (this.checkpointOverdue(runId)) return this.refuse(role, runId, 'human checkpoint overdue');
    const gate = this.capabilityGateReason();
    if (gate) return this.refuse(role, runId, gate);
    const req = this.signed.policy.attestation;
    if (req) {
      const challenge = this.challenges.get(runId);
      this.challenges.delete(runId);
      const fresh = challenge && this.now() - challenge.at <= CHALLENGE_TTL_MS ? challenge.nonce : undefined;
      const bad = checkAttestation(req, this.attestationVerifiers, attestation, fresh);
      if (bad) return this.refuse(role, runId, bad);
    }
    let run = this.runs.get(runId);
    if (run && run.state !== 'active') return this.refuse(role, runId, `run is ${run.state}`);
    if (run?.currentLeaseId && !this.revoked.has(run.currentLeaseId) && (run.expiresAt ?? 0) > this.now()) {
      return this.refuse(role, runId, 'run already holds an active lease; renew it instead');
    }
    if (!run) {
      if (this.runs.size >= MAX_RUNS) return this.refuse(role, runId, 'run limit reached');
      run = { state: 'active', sequence: 0, spentUsd: 0, spentTokens: 0 };
      this.runs.set(runId, run);
    }
    return this.grant(run, runId, role, 'issue');
  }

  /** Renew a run's lease if the policy and its stop conditions allow. */
  renew(heartbeat: Heartbeat, role: ControlRole = 'runner'): LeaseDecision {
    if (role !== 'runner') return this.refuse(role, heartbeat?.runId, 'only the runner may renew');
    if (!heartbeat || typeof heartbeat.runId !== 'string') return this.refuse(role, undefined, 'malformed heartbeat');
    const run = this.runs.get(heartbeat.runId);
    if (!run) return this.refuse(role, heartbeat.runId, 'unknown run');
    if (run.state !== 'active') return this.refuse(role, heartbeat.runId, `run is ${run.state}`);
    if (heartbeat.leaseId !== run.currentLeaseId || this.revoked.has(heartbeat.leaseId)) {
      return this.refuse(role, heartbeat.runId, 'heartbeat is not for the current lease');
    }
    const now = this.now();
    if (this.checkpointOverdue(heartbeat.runId)) return this.stop(run, heartbeat.runId, role, 'human checkpoint overdue');
    if ((run.expiresAt ?? 0) <= now) return this.stop(run, heartbeat.runId, role, 'lease already expired');

    const policy = this.effectivePolicy();
    if (!Number.isFinite(heartbeat.at) || heartbeat.at > now + 5_000 || now - heartbeat.at > policy.heartbeatMaxAgeMs) {
      return this.refuse(role, heartbeat.runId, 'stale or future heartbeat');
    }
    if (!(heartbeat.spentUsd >= 0) || !(heartbeat.spentTokens >= 0)) return this.refuse(role, heartbeat.runId, 'invalid spend report');
    // Spend can only grow; a lower report keeps the higher recorded value.
    ({ usd: run.spentUsd, tokens: run.spentTokens } = recordSpend({ usd: run.spentUsd, tokens: run.spentTokens }, { usd: heartbeat.spentUsd, tokens: heartbeat.spentTokens }));

    const blocked = this.blockedReason();
    if (blocked) return this.stop(run, heartbeat.runId, role, blocked);
    const gate = this.capabilityGateReason();
    if (gate) return this.stop(run, heartbeat.runId, role, gate);
    if (this.signed.policy.attestation) {
      const bad = checkAttestation(this.signed.policy.attestation, this.attestationVerifiers, heartbeat.attestation, run.attestationNonce);
      if (bad) return this.stop(run, heartbeat.runId, role, bad);
    }
    if (!policy.autoRenew) return this.stop(run, heartbeat.runId, role, 'auto-renew is off');
    if (run.spentUsd >= policy.budget.runCeilingUsd || run.spentTokens >= policy.budget.runCeilingTokens) {
      return this.stop(run, heartbeat.runId, role, 'run budget ceiling reached');
    }
    const stopWhen = policy.stopWhen;
    if (stopWhen.onCanaryFailure && heartbeat.canaryFailed) return this.stop(run, heartbeat.runId, role, 'canary failure reported');
    if (stopWhen.onHealthFailing && heartbeat.health === 'failing') return this.stop(run, heartbeat.runId, role, 'run reported failing health');
    return this.grant(run, heartbeat.runId, role, 'renew');
  }

  /** Whether a lease is currently honoured (signature checks happen in the verifier). */
  isLeaseActive(leaseId: string): boolean {
    return this.leaseStatus(leaseId) === 'active';
  }

  /**
   * Three-valued lease status for k-of-n verifiers: `inactive` when this
   * authority is paused or latched, revoked the lease, or its run is no longer
   * active (also when `runId` names a run this authority stopped); `unknown`
   * when it never granted or co-signed the lease (e.g. it was unreachable).
   */
  leaseStatus(leaseId: string, runId?: string): LeaseStatusValue {
    if (this.paused || this.alertLatch || this.revoked.has(leaseId)) return 'inactive';
    for (const run of this.runs.values()) {
      if (run.currentLeaseId === leaseId) return run.state === 'active' && (run.expiresAt ?? 0) > this.now() ? 'active' : 'inactive';
    }
    if (runId !== undefined) {
      const run = this.runs.get(runId);
      if (run && run.state !== 'active') return 'inactive';
      // After `revoke --all`, a run this authority never saw may predate the revoke: treat it as revoked.
      if (!run && this.revokedAll) return 'inactive';
    }
    return 'unknown';
  }

  /**
   * Revoke one run, or every run. Takes effect immediately. A run this
   * authority has never seen (it missed the co-sign) is recorded as revoked,
   * so k-of-n verifiers see `inactive` here rather than `unknown`.
   */
  revoke(target: { runId: string } | { all: true }, role: ControlRole, reason = 'revoked'): void {
    this.assertRole(role, ['operator', 'sentry'], 'revoke');
    this.assertSentryMayActAlone(role, 'revoke');
    if ('all' in target) {
      this.revokedAll = true;
    } else {
      if (typeof target.runId !== 'string' || !RUN_ID.test(target.runId)) throw new TypeError('invalid runId');
      // Tombstone: a stop must never be a no-op, even past MAX_RUNS.
      if (!this.runs.has(target.runId)) this.runs.set(target.runId, { state: 'revoked', sequence: Number.MAX_SAFE_INTEGER, spentUsd: 0, spentTokens: 0, reason });
    }
    const ids = 'all' in target ? [...this.runs.keys()] : [target.runId];
    for (const id of ids) {
      const run = this.runs.get(id);
      if (!run) continue;
      if (run.currentLeaseId) this.revoked.add(run.currentLeaseId);
      run.state = nextRunState(run.state, 'revoke');
      run.reason = reason;
      this.emit({ action: 'revoke', role, runId: id, leaseId: run.currentLeaseId, reason });
    }
  }

  /** Pause everything: current leases stop being honoured and nothing is issued or renewed. */
  pause(role: ControlRole, reason = 'paused'): void {
    this.assertRole(role, ['operator', 'sentry'], 'pause');
    this.assertSentryMayActAlone(role, 'pause');
    this.paused = true;
    for (const run of this.runs.values()) {
      if (run.state === 'active') {
        if (run.currentLeaseId) this.revoked.add(run.currentLeaseId);
        run.state = nextRunState(run.state, 'pause');
        run.reason = reason;
      }
    }
    this.emit({ action: 'pause', role, reason });
  }

  /** Resume after a pause or an alert latch. Operator only; runs must request a fresh lease. */
  resume(role: ControlRole): void {
    this.assertRole(role, ['operator'], 'resume');
    this.paused = false;
    this.alertLatch = null;
    this.revokedAll = false;
    for (const run of this.runs.values()) {
      if (run.state === 'paused') {
        run.state = nextRunState(run.state, 'resume');
        run.reason = undefined;
        run.currentLeaseId = undefined;
        run.expiresAt = undefined;
      }
    }
    this.emit({ action: 'resume', role });
  }

  /** Narrow the policy for future leases. Anything looser throws. */
  tighten(delta: TightenDelta, role: ControlRole): RenewalPolicy {
    this.assertRole(role, ['operator', 'sentry'], 'tighten');
    const current = this.effectivePolicy();
    const loosens = tightenError(current, delta);
    if (loosens) throw new Error(loosens);
    this.overlay = {
      scope: delta.scope ?? this.overlay.scope,
      leaseTtlMs: delta.leaseTtlMs ?? this.overlay.leaseTtlMs,
      autoRenew: delta.autoRenew ?? this.overlay.autoRenew,
      budget: { ...this.overlay.budget, ...delta.budget },
    };
    this.emit({ action: 'tighten', role });
    return this.effectivePolicy();
  }

  /**
   * Record an alert. At or above the policy threshold, renewal stops for every
   * run once `sentryQuorum` distinct sentries have alerted within the window.
   * An operator alert always meets the quorum.
   *
   * @param source  Sentry identity; over HTTP this is the authenticated sentry id, never a client claim.
   */
  reportAlert(level: AlertLevel, source: string, role: ControlRole, kind?: 'tripwire'): void {
    this.assertRole(role, ['operator', 'sentry'], 'alert');
    if (!(level in ALERT_RANK)) throw new TypeError('invalid alert level');
    if (kind !== undefined && kind !== 'tripwire') throw new TypeError('invalid alert kind');
    if (ALERT_RANK[level] > ALERT_RANK[this.highestAlert]) this.highestAlert = level;
    const src = String(source).slice(0, 128);
    this.emit({ action: 'alert', role, reason: `${level}${kind ? ` ${kind}` : ''} from ${src}` });
    const stopWhen = this.signed.policy.stopWhen;
    // The egress proxy is a trusted process: its tripwire alone revokes every run (no quorum needed)
    // and latches the authority, so a compromised agent cannot simply start a new run.
    if (kind === 'tripwire' && stopWhen.tripwire === true && (role === 'operator' || src === TRIPWIRE_SOURCE)) {
      this.alertLatch = `tripwire reported by ${src}`;
      for (const [id, run] of this.runs) {
        if (run.state !== 'active') continue;
        if (run.currentLeaseId) this.revoked.add(run.currentLeaseId);
        run.state = nextRunState(run.state, 'revoke');
        run.reason = `tripwire reported by ${src}`;
        this.emit({ action: 'revoke', role, runId: id, leaseId: run.currentLeaseId, reason: run.reason });
      }
      return;
    }
    const threshold = stopWhen.sentryAlertAtOrAbove;
    if (!threshold || ALERT_RANK[level] < ALERT_RANK[threshold]) return;
    const now = this.now();
    const windowMs = stopWhen.sentryWindowMs ?? 300_000;
    this.alerts = this.alerts.filter((a) => now - a.at < windowMs).slice(-1023);
    this.alerts.push({ source: role === 'operator' ? '\0operator' : src, at: now });
    const distinct = new Set(this.alerts.map((a) => a.source)).size;
    if (role !== 'operator' && distinct < (stopWhen.sentryQuorum ?? 1)) return;
    const reason = `sentry alert: ${level}${role === 'operator' ? ' (operator)' : ` (${distinct} sentries)`}`;
    // Latch: no new runs or leases until an operator resumes.
    this.alertLatch = reason;
    for (const [id, run] of this.runs) {
      if (run.state === 'active') this.stop(run, id, role, reason);
    }
  }

  /** Install a newer operator-signed policy. Clears tightening, alert, and checkpoint state. */
  installPolicy(signed: SignedPolicy, role: ControlRole): void {
    this.assertRole(role, ['operator'], 'install a policy');
    const reason = verifySignedPolicy(signed, this.operatorPublicKey);
    if (reason) throw new Error(`installPolicy: ${reason}`);
    if (signed.policy.issuedAt <= this.signed.policy.issuedAt) throw new Error('installPolicy: policy is not newer than the active one');
    assertInQuorum(signed, keyIdOf(this.authorityKey.publicKey));
    this.assertAttestationReady(signed);
    this.signed = signed;
    this.overlay = {};
    this.highestAlert = 'info';
    this.alerts = [];
    // Checkpoints are bound to the reviewed policy; the new policy's issuedAt is the new baseline.
    this.checkpointAll = 0;
    this.checkpointRun.clear();
    this.emit({ action: 'policy', role, reason: signed.policy.policyId });
  }

  /**
   * Accept an operator-signed human checkpoint. Operator only. Rejects
   * forged, expired, foreign-policy, replayed, and older checkpoints.
   */
  checkpoint(signed: SignedCheckpoint, role: ControlRole): { deadline: number | null } {
    this.assertRole(role, ['operator'], 'checkpoint');
    const now = this.now();
    const reason = verifyCheckpoint(signed, this.operatorPublicKey, policyHash(this.signed), now);
    if (reason) throw new Error(`checkpoint: ${reason}`);
    const c = signed.checkpoint;
    if (this.checkpointNonces.has(c.nonce)) throw new Error('checkpoint: replayed');
    const runId = 'runId' in c.scope ? c.scope.runId : undefined;
    const previous = runId !== undefined ? (this.checkpointRun.get(runId) ?? 0) : this.checkpointAll;
    if (c.issuedAt <= previous) throw new Error('checkpoint: not newer than the last accepted checkpoint');
    if (runId !== undefined && !this.checkpointRun.has(runId) && this.checkpointRun.size >= MAX_RUNS) throw new Error('checkpoint: run limit reached');
    if (this.checkpointNonces.size >= 4 * MAX_RUNS) this.checkpointNonces.clear();
    this.checkpointNonces.add(c.nonce);
    if (runId !== undefined) this.checkpointRun.set(runId, c.issuedAt);
    else this.checkpointAll = c.issuedAt;
    this.emit({ action: 'checkpoint', role, runId, reason: runId === undefined ? 'all runs' : undefined });
    return { deadline: this.checkpointDeadline(runId ?? '') };
  }

  /**
   * Fresh nonce the first lease's attestation must bind (policy with
   * `attestation` only). Single use, valid for 60 s. Runner only.
   */
  attestationChallenge(runId: string, role: ControlRole = 'runner'): { nonce: string } {
    this.assertRole(role, ['runner', 'operator'], 'request an attestation challenge');
    if (!this.signed.policy.attestation) throw new Error('attestation is not required by the policy');
    if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new TypeError('invalid runId');
    if (!this.challenges.has(runId) && this.challenges.size >= MAX_RUNS) throw new Error('too many outstanding challenges');
    const nonce = randomBytes(16).toString('hex');
    this.challenges.set(runId, { nonce, at: this.now() });
    return { nonce };
  }

  /**
   * Install a signed capability evaluation (operator). It must satisfy the
   * policy's `requires.capabilityEval`; it is re-checked for age on every grant.
   */
  submitCapabilityEval(signed: SignedCapabilityEval, role: ControlRole): { accepted: true; evaluatedAt: number } {
    this.assertRole(role, ['operator'], 'submit a capability evaluation');
    const req = this.signed.policy.requires?.capabilityEval;
    if (!req) throw new Error('capability evaluation is not required by the policy');
    const reason = verifyCapabilityEval(signed, req, this.now());
    if (reason) throw new Error(`capability evaluation rejected: ${reason}`);
    if (this.capabilityEval && signed.eval.evaluatedAt < this.capabilityEval.eval.evaluatedAt) throw new Error('capability evaluation is older than the current one');
    this.capabilityEval = signed;
    this.emit({ action: 'capability-eval', role, reason: `${signed.eval.suite} ${signed.eval.evalId}` });
    return { accepted: true, evaluatedAt: signed.eval.evaluatedAt };
  }

  /** When renewal stops without a new checkpoint (`null` when checkpoints are not required). */
  checkpointDeadline(runId: string): number | null {
    const every = this.signed.policy.humanCheckpointEveryMs;
    if (every === undefined) return null;
    const last = Math.max(this.signed.policy.issuedAt, this.checkpointAll, this.checkpointRun.get(runId) ?? 0);
    return last + every;
  }

  /**
   * Co-sign lease claims produced by another authority (k-of-n). The claims
   * must carry a valid signature from their issuing peer (`claims.issuer`,
   * one of `authorityQuorum.keyIds`, never this authority), so every lease
   * starts at some authority's full issue/renew checks — the runner cannot
   * assemble claims itself. The decision is then independent: this authority
   * applies its own copy of the operator policy, its own run state,
   * revocations, checkpoints, stop conditions, and attestation. Renewals
   * (sequence > 1) need the heartbeat for the previous lease this authority
   * co-signed. Runner only.
   */
  cosign(claims: LeaseClaims, heartbeat: Heartbeat | undefined, role: ControlRole = 'runner', issuerSignature?: LeaseCosignature): CosignDecision {
    if (role !== 'runner') return this.refuseCosign(role, undefined, 'only the runner may request a co-signature');
    if (!claims || typeof claims !== 'object' || claims.v !== 'nai-lease-v1') return this.refuseCosign(role, undefined, 'malformed claims');
    const runId = claims.runId;
    if (typeof runId !== 'string' || !RUN_ID.test(runId)) return this.refuseCosign(role, undefined, 'invalid runId');
    if (typeof claims.leaseId !== 'string' || !/^lease_[0-9a-f]{24}$/.test(claims.leaseId)) return this.refuseCosign(role, runId, 'invalid leaseId');
    if (!Number.isInteger(claims.sequence) || claims.sequence < 1) return this.refuseCosign(role, runId, 'invalid sequence');
    if (claims.policyHash !== policyHash(this.signed)) return this.refuseCosign(role, runId, 'claims are for a different policy');
    const quorum = this.signed.policy.authorityQuorum;
    if (!quorum) return this.refuseCosign(role, runId, 'policy has no authority quorum');
    const ownId = keyIdOf(this.authorityKey.publicKey);
    const issuerKey = typeof claims.issuer === 'string' ? this.peers.get(claims.issuer) : undefined;
    if (!issuerKey || claims.issuer === ownId || !quorum.keyIds.includes(claims.issuer as string)
      || !issuerSignature || issuerSignature.keyId !== claims.issuer || !verifyCanonical(claims, issuerSignature.signature, issuerKey)) {
      return this.refuseCosign(role, runId, 'claims are not signed by their issuing authority');
    }
    const blocked = this.blockedReason();
    if (blocked) return this.refuseCosign(role, runId, blocked);
    if (this.checkpointOverdue(runId)) return this.refuseCosign(role, runId, 'human checkpoint overdue');
    const gate = this.capabilityGateReason();
    if (gate) return this.refuseCosign(role, runId, gate);
    const attReq = this.signed.policy.attestation;
    if (attReq && (typeof claims.attestationNonce !== 'string' || !/^[0-9a-f]{32}$/.test(claims.attestationNonce))) {
      return this.refuseCosign(role, runId, 'claims lack an attestation nonce');
    }

    const now = this.now();
    const policy = this.effectivePolicy();
    if (!Number.isFinite(claims.issuedAt) || Math.abs(claims.issuedAt - now) > 30_000) return this.refuseCosign(role, runId, 'claims issuedAt outside the allowed skew');
    const maxExpiry = Math.min(now + policy.leaseTtlMs + 30_000, policy.renewUntil ?? Infinity, this.checkpointDeadline(runId) ?? Infinity);
    if (!Number.isFinite(claims.expiresAt) || claims.expiresAt <= claims.issuedAt || claims.expiresAt > maxExpiry) {
      return this.refuseCosign(role, runId, 'claims expiry exceeds this authority\'s policy');
    }
    let scopeOk = false;
    try {
      scopeOk = scopeWithin(claims.scope, policy.scope) && ['observe', 'standard', 'elevated'].includes(claims.scope.tier);
    } catch {
      scopeOk = false;
    }
    if (!scopeOk) return this.refuseCosign(role, runId, 'claims scope exceeds this authority\'s policy');
    const b = claims.budget;
    if (!b || !(b.runCeilingUsd <= policy.budget.runCeilingUsd) || !(b.runCeilingTokens <= policy.budget.runCeilingTokens) || !(b.runCeilingUsd >= 0) || !(b.runCeilingTokens >= 0)) {
      return this.refuseCosign(role, runId, 'claims budget exceeds this authority\'s policy');
    }

    let run = this.runs.get(runId);
    if (run && run.state !== 'active') return this.refuseCosign(role, runId, `run is ${run.state}`);
    if (run && claims.sequence <= run.sequence) return this.refuseCosign(role, runId, 'sequence did not advance (replay or split-brain)');
    if (claims.sequence === 1) {
      if (run?.currentLeaseId && !this.revoked.has(run.currentLeaseId) && (run.expiresAt ?? 0) > now) {
        return this.refuseCosign(role, runId, 'run already holds an active co-signed lease');
      }
    } else {
      if (!run) return this.refuseCosign(role, runId, 'unknown run');
      if (!heartbeat || heartbeat.runId !== runId || heartbeat.leaseId !== run.currentLeaseId || this.revoked.has(heartbeat.leaseId)) {
        return this.refuseCosign(role, runId, 'renewal needs the heartbeat for the current co-signed lease');
      }
      if ((run.expiresAt ?? 0) <= now) return this.stopCosign(run, runId, role, 'lease already expired');
      if (!Number.isFinite(heartbeat.at) || heartbeat.at > now + 5_000 || now - heartbeat.at > policy.heartbeatMaxAgeMs) {
        return this.refuseCosign(role, runId, 'stale or future heartbeat');
      }
      if (!(heartbeat.spentUsd >= 0) || !(heartbeat.spentTokens >= 0)) return this.refuseCosign(role, runId, 'invalid spend report');
      ({ usd: run.spentUsd, tokens: run.spentTokens } = recordSpend({ usd: run.spentUsd, tokens: run.spentTokens }, { usd: heartbeat.spentUsd, tokens: heartbeat.spentTokens }));
      if (!policy.autoRenew) return this.stopCosign(run, runId, role, 'auto-renew is off');
      if (run.spentUsd >= policy.budget.runCeilingUsd || run.spentTokens >= policy.budget.runCeilingTokens) return this.stopCosign(run, runId, role, 'run budget ceiling reached');
      if (policy.stopWhen.onCanaryFailure && heartbeat.canaryFailed) return this.stopCosign(run, runId, role, 'canary failure reported');
      if (policy.stopWhen.onHealthFailing && heartbeat.health === 'failing') return this.stopCosign(run, runId, role, 'run reported failing health');
      if (attReq) {
        const bad = checkAttestation(attReq, this.attestationVerifiers, heartbeat.attestation, run.attestationNonce);
        if (bad) return this.stopCosign(run, runId, role, bad);
      }
    }
    if (!run) {
      if (this.runs.size >= MAX_RUNS) return this.refuseCosign(role, runId, 'run limit reached');
      run = { state: 'active', sequence: 0, spentUsd: 0, spentTokens: 0 };
      this.runs.set(runId, run);
    }
    if (run.currentLeaseId) this.revoked.add(run.currentLeaseId);
    run.sequence = claims.sequence;
    run.currentLeaseId = claims.leaseId;
    run.expiresAt = claims.expiresAt;
    run.attestationNonce = claims.attestationNonce;
    const { keyId, signature } = signWith(claims, this.authorityKey, 'authority');
    this.emit({ action: 'cosign', role, runId, leaseId: claims.leaseId });
    return { granted: true, cosignature: { keyId, signature } };
  }

  /** Status of one run, or all runs. */
  status(runId?: string): RunStatus[] {
    const entries = runId !== undefined ? [[runId, this.runs.get(runId)] as const] : [...this.runs.entries()];
    return entries
      .filter((e): e is readonly [string, RunRecord] => e[1] !== undefined)
      .map(([id, r]) => ({
        runId: id,
        state: r.state,
        currentLeaseId: r.currentLeaseId,
        expiresAt: r.expiresAt,
        sequence: r.sequence,
        spentUsd: r.spentUsd,
        spentTokens: r.spentTokens,
        reason: r.reason,
        ...(this.signed.policy.humanCheckpointEveryMs !== undefined ? { checkpointDeadline: this.checkpointDeadline(id) ?? undefined } : {}),
      }));
  }

  // ── HTTP control API ────────────────────────────────────────────────────────

  /**
   * HTTP handler for the authority's control API. Every route except the
   * public-key endpoint requires `Authorization: Bearer <secret>`.
   *
   * @param secrets  One distinct secret (≥ 32 chars) per role that may connect;
   *                 `sentries` gives each sentry its own secret and identity, which
   *                 is what the alert quorum counts.
   */
  httpHandler(secrets: AuthoritySecrets): (req: IncomingMessage, res: ServerResponse) => void {
    const digests: { role: ControlRole; identity: string; digest: Buffer }[] = [];
    const seen = new Set<string>();
    const add = (role: ControlRole, identity: string, secret: unknown): void => {
      if (typeof secret !== 'string' || secret.length < 32) throw new TypeError(`LeaseAuthority: ${identity} secret must be at least 32 characters`);
      if (seen.has(secret)) throw new TypeError('LeaseAuthority: role secrets must be distinct');
      seen.add(secret);
      digests.push({ role, identity, digest: sha256(secret) });
    };
    for (const role of ['operator', 'sentry', 'runner'] as const) {
      if (secrets[role] !== undefined) add(role, role, secrets[role]);
    }
    for (const [id, secret] of Object.entries(secrets.sentries ?? {})) {
      if (!RUN_ID.test(id)) throw new TypeError(`LeaseAuthority: invalid sentry id "${id}"`);
      add('sentry', `sentry:${id}`, secret);
    }
    if (!digests.some((d) => d.role === 'operator')) throw new TypeError('LeaseAuthority: an operator secret is required');
    const failures = new Map<string, number[]>();

    const roleOf = (req: IncomingMessage): Caller | null => {
      const header = req.headers.authorization;
      if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
      const provided = sha256(header.slice(7));
      let found: Caller | null = null;
      for (const d of digests) if (timingSafeEqual(provided, d.digest) && !found) found = { role: d.role, identity: d.identity };
      return found;
    };

    return (req, res) => {
      void this.route(req, res, roleOf, failures).catch(() => send(res, 500, { error: 'internal error' }));
    };
  }

  /**
   * Start the control API on loopback. Binding a non-loopback host requires
   * `allowRemote: true` and should sit behind TLS termination.
   */
  startServer(port: number, secrets: AuthoritySecrets, opts: { host?: string; allowRemote?: boolean } = {}): Server {
    const host = opts.host ?? '127.0.0.1';
    if (!isLoopbackHost(host) && opts.allowRemote !== true) {
      throw new Error('LeaseAuthority: refusing to bind a non-loopback host without allowRemote: true');
    }
    const http = require('http') as typeof import('http');
    const server = http.createServer(this.httpHandler(secrets));
    server.listen(port, host);
    return server;
  }

  private async route(
    req: IncomingMessage,
    res: ServerResponse,
    roleOf: (req: IncomingMessage) => Caller | null,
    failures: Map<string, number[]>,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://authority.local');
    if (req.method === 'GET' && url.pathname === '/v1/public-key') {
      send(res, 200, { keyId: this.authorityKey.keyId, publicKeyPem: this.publicKey.export({ type: 'spki', format: 'pem' }) });
      return;
    }
    const addr = req.socket?.remoteAddress ?? 'unknown';
    const now = Date.now();
    const recent = (failures.get(addr) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= 10) return void send(res, 429, { error: 'too many failed attempts' });
    const caller = roleOf(req);
    if (!caller) {
      recent.push(now);
      failures.set(addr, recent);
      return void send(res, 401, { error: 'unauthorized' });
    }
    const role = caller.role;

    try {
      const body = req.method === 'POST' ? await readJson(req, 64 * 1024) : {};
      const p = url.pathname;
      if (req.method === 'POST' && p === '/v1/leases/issue') {
        const att = (body as { attestation?: AttestationEvidence }).attestation;
        return void send(res, 200, this.issue(str(body, 'runId'), role, att));
      }
      if (req.method === 'GET' && p === '/v1/attestation/nonce') {
        return void send(res, 200, this.attestationChallenge(url.searchParams.get('runId') ?? '', role));
      }
      if (req.method === 'POST' && p === '/v1/capability-eval') return void send(res, 200, this.submitCapabilityEval(body as unknown as SignedCapabilityEval, role));
      if (req.method === 'POST' && p === '/v1/leases/renew') return void send(res, 200, this.renew(body as unknown as Heartbeat, role));
      if (req.method === 'POST' && p === '/v1/leases/cosign') {
        const b = body as { claims?: LeaseClaims; heartbeat?: Heartbeat; issuerSignature?: LeaseCosignature };
        return void send(res, 200, this.cosign(b.claims as LeaseClaims, b.heartbeat, role, b.issuerSignature));
      }
      if (req.method === 'GET' && p.startsWith('/v1/leases/') && p.endsWith('/status')) {
        const leaseId = decodeURIComponent(p.slice('/v1/leases/'.length, -'/status'.length));
        const status = this.leaseStatus(leaseId, url.searchParams.get('runId') ?? undefined);
        return void send(res, 200, { leaseId, active: status === 'active', status });
      }
      if (req.method === 'GET' && p === '/v1/runs') {
        const runId = url.searchParams.get('runId') ?? undefined;
        if (role === 'runner' && runId === undefined) return void send(res, 403, { error: 'runner must name its run' });
        return void send(res, 200, { runs: this.status(runId) });
      }
      if (req.method === 'POST' && p === '/v1/control/revoke') {
        const all = (body as Record<string, unknown>)['all'] === true;
        this.revoke(all ? { all: true } : { runId: str(body, 'runId') }, role, optStr(body, 'reason') ?? 'revoked');
        return void send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/v1/control/pause') { this.pause(role, optStr(body, 'reason') ?? 'paused'); return void send(res, 200, { ok: true }); }
      if (req.method === 'POST' && p === '/v1/control/resume') { this.resume(role); return void send(res, 200, { ok: true }); }
      if (req.method === 'POST' && p === '/v1/control/tighten') return void send(res, 200, { policy: this.tighten(body as TightenDelta, role) });
      if (req.method === 'POST' && p === '/v1/control/alert') {
        const kind = optStr(body, 'kind');
        this.reportAlert(str(body, 'level') as AlertLevel, caller.identity, role, kind as 'tripwire' | undefined);
        return void send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/v1/policy') { this.installPolicy(body as unknown as SignedPolicy, role); return void send(res, 200, { ok: true }); }
      if (req.method === 'POST' && p === '/v1/checkpoint') return void send(res, 200, { ok: true, ...this.checkpoint(body as unknown as SignedCheckpoint, role) });
      send(res, 404, { error: 'not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'bad request';
      send(res, message.startsWith('role ') ? 403 : 400, { error: message });
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private blockedReason(): string | null {
    if (this.paused) return 'authority is paused';
    if (this.alertLatch) return `authority halted: ${this.alertLatch}`;
    const until = this.signed.policy.renewUntil;
    if (until !== undefined && this.now() >= until) return 'policy end date reached';
    return null;
  }

  private checkpointOverdue(runId: string): boolean {
    const deadline = this.checkpointDeadline(runId);
    return deadline !== null && this.now() >= deadline;
  }

  /** High-risk scopes need a valid, unexpired, passing evaluation when the policy requires one. */
  private capabilityGateReason(): string | null {
    const req = this.signed.policy.requires?.capabilityEval;
    if (!req || !isHighRiskPolicy(this.effectivePolicy())) return null;
    if (!this.capabilityEval) return 'capability evaluation required for this high-risk scope';
    const reason = verifyCapabilityEval(this.capabilityEval, req, this.now());
    return reason ? `capability evaluation required: ${reason}` : null;
  }

  private assertAttestationReady(signed: SignedPolicy): void {
    const req = signed.policy.attestation;
    if (req && !this.attestationVerifiers.some((v) => v.kind === req.kind)) {
      throw new TypeError(`LeaseAuthority: policy requires ${req.kind} attestation but no verifier for it is configured`);
    }
  }

  private grant(run: RunRecord, runId: string, role: ControlRole, action: 'issue' | 'renew'): LeaseDecision {
    const policy = this.effectivePolicy();
    const now = this.now();
    const until = policy.renewUntil;
    const expiresAt = Math.min(now + policy.leaseTtlMs, until ?? Infinity, this.checkpointDeadline(runId) ?? Infinity);
    if (run.currentLeaseId) this.revoked.add(run.currentLeaseId);
    run.sequence += 1;
    const attestationNonce = this.signed.policy.attestation ? randomBytes(16).toString('hex') : undefined;
    const lease: SignedLease = signLease(
      {
        v: 'nai-lease-v1',
        leaseId: `lease_${randomBytes(12).toString('hex')}`,
        runId,
        sequence: run.sequence,
        issuedAt: now,
        expiresAt,
        scope: policy.scope,
        budget: policy.budget,
        policyHash: policyHash(this.signed),
        nonce: randomBytes(16).toString('hex'),
        issuer: keyIdOf(this.authorityKey.publicKey),
        ...(isHighRiskPolicy(policy) ? { highRisk: true as const } : {}),
        ...(attestationNonce ? { attestationNonce } : {}),
      },
      this.authorityKey,
    );
    run.attestationNonce = attestationNonce;
    run.currentLeaseId = lease.claims.leaseId;
    run.expiresAt = expiresAt;
    this.emit({ action, role, runId, leaseId: lease.claims.leaseId });
    return { granted: true, lease };
  }

  private refuse(role: ControlRole, runId: string | undefined, reason: string): LeaseDecision {
    this.emit({ action: 'refuse', role, runId, reason });
    return { granted: false, reason };
  }

  private refuseCosign(role: ControlRole, runId: string | undefined, reason: string): CosignDecision {
    this.emit({ action: 'refuse', role, runId, reason: `cosign: ${reason}` });
    return { granted: false, reason };
  }

  private stopCosign(run: RunRecord, runId: string, role: ControlRole, reason: string): CosignDecision {
    this.stop(run, runId, role, reason);
    return { granted: false, reason };
  }

  private stop(run: RunRecord, runId: string, role: ControlRole, reason: string): LeaseDecision {
    if (run.state === 'active') {
      run.state = nextRunState(run.state, 'stop');
      run.reason = reason;
      this.emit({ action: 'stop', role, runId, leaseId: run.currentLeaseId, reason });
    }
    return { granted: false, reason };
  }

  private assertRole(role: ControlRole, allowed: readonly ControlRole[], what: string): void {
    if (!allowed.includes(role)) throw new Error(`role ${role} may not ${what}`);
  }

  /** With a sentry quorum configured, a single sentry may only alert and tighten. */
  private assertSentryMayActAlone(role: ControlRole, what: string): void {
    if (role === 'sentry' && (this.signed.policy.stopWhen.sentryQuorum ?? 1) > 1) {
      throw new Error(`role sentry may not ${what} alone when a sentry quorum is configured; report an alert`);
    }
  }

  private emit(event: Omit<AuthorityEvent, 'at'>): void {
    try {
      this.onEvent?.({ ...event, at: this.now() });
    } catch {
      // Audit delivery must never break a control decision.
    }
  }
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** With an authority quorum configured, this authority's key must be one of the listed keys. */
function assertInQuorum(signed: SignedPolicy, ownKeyId: string): void {
  const q = signed.policy.authorityQuorum;
  if (q && !q.keyIds.includes(ownKeyId)) throw new TypeError(`LeaseAuthority: key ${ownKeyId} is not in the policy's authorityQuorum.keyIds`);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  // Responding before the request body was read: close the connection so a keep-alive client cannot hit a reset.
  const early = res.req !== undefined && !res.req.complete;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(early ? { Connection: 'close' } : {}) }).end(JSON.stringify(body));
}

function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const parsed: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object');
        resolve(parsed as Record<string, unknown>);
      } catch (err) {
        reject(err instanceof Error ? err : new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || v.length === 0 || v.length > 256) throw new Error(`${key} is required`);
  return v;
}

function optStr(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === 'string' && v.length > 0 ? v.slice(0, 256) : undefined;
}
