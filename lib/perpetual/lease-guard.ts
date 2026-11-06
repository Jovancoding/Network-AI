/**
 * Perpetual Runtime — Lease Guard (runs inside the agent process).
 *
 * Holds the run's current signed lease, renews it before expiry, polls the
 * authority for revocation, and vetoes every guarded action that is not
 * covered by a valid, in-scope lease. When the lease cannot be renewed —
 * revoked, paused, stopped by policy, or the authority is unreachable — the
 * guard fires the kill switch (dead-man switch). It holds only the authority's
 * public key, so the agent cannot mint or extend its own lease.
 *
 * @module LeaseGuard
 */

import { performance } from 'perf_hooks';
import { resolve as resolvePath, relative, isAbsolute, sep } from 'path';
import type { KeyObject } from 'crypto';
import { LeaseError, verifyLease, verifyLeaseQuorum } from './signing';
import { quorumActive } from './core';
import type { AttestationEvidence, Heartbeat, LeaseAction, LeaseCheck, LeaseClaims, LeaseCosignature, LeaseDecision, SignedLease } from './types';

/** How the guard reaches the authority (HTTP in production). */
export interface LeaseTransport {
  issue(runId: string, attestation?: AttestationEvidence): Promise<LeaseDecision>;
  renew(heartbeat: Heartbeat): Promise<LeaseDecision>;
  isActive(leaseId: string, runId?: string): Promise<boolean>;
  /** Three-valued status (`unknown`: this authority never saw the lease); used by k-of-n verifiers */
  leaseStatus?(leaseId: string, runId?: string): Promise<'active' | 'inactive' | 'unknown'>;
  /** Fresh attestation nonce for the first lease (policies with `attestation`) */
  attestationNonce?(runId: string): Promise<string>;
}

/** A co-signing authority (k-of-n). */
export interface CosignTransport {
  cosign(claims: LeaseClaims, heartbeat: Heartbeat | undefined, issuerSignature: LeaseCosignature): Promise<{ granted: boolean; cosignature?: LeaseCosignature; reason?: string }>;
  isActive(leaseId: string, runId?: string): Promise<boolean>;
  leaseStatus?(leaseId: string, runId?: string): Promise<'active' | 'inactive' | 'unknown'>;
}

/** Status of a lease at one authority, using the three-valued call when available. */
async function statusAt(t: LeaseTransport | CosignTransport, leaseId: string, runId?: string): Promise<'active' | 'inactive' | 'unknown'> {
  if (t.leaseStatus) return t.leaseStatus(leaseId, runId);
  return (await t.isActive(leaseId, runId)) ? 'active' : 'inactive';
}

/**
 * Lease transport over k-of-n authorities. The primary issues or renews; every
 * co-signer then decides independently. A lease is returned only with at
 * least `threshold` signatures in total. Stopping is an OR: if any reachable
 * authority reports the lease inactive, `isActive` is `false`.
 */
export class QuorumLeaseTransport implements LeaseTransport {
  constructor(
    private readonly primary: LeaseTransport,
    private readonly cosigners: readonly CosignTransport[],
    private readonly threshold: number,
  ) {
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > cosigners.length + 1) {
      throw new TypeError('QuorumLeaseTransport: threshold must be between 1 and the number of authorities');
    }
  }

  async issue(runId: string, attestation?: AttestationEvidence): Promise<LeaseDecision> {
    return this.collect(await this.primary.issue(runId, attestation));
  }

  attestationNonce(runId: string): Promise<string> {
    if (!this.primary.attestationNonce) return Promise.reject(new Error('primary transport does not support attestation'));
    return this.primary.attestationNonce(runId);
  }

  async renew(heartbeat: Heartbeat): Promise<LeaseDecision> {
    return this.collect(await this.primary.renew(heartbeat), heartbeat);
  }

  async isActive(leaseId: string, runId?: string): Promise<boolean> {
    const all: (LeaseTransport | CosignTransport)[] = [this.primary, ...this.cosigners];
    const results = await Promise.allSettled(all.map((a) => statusAt(a, leaseId, runId)));
    const verdict = quorumActive(results.map((r) => (r.status === 'fulfilled' ? r.value : 'unknown')));
    // No authority knows the lease or none is reachable: unknown, let the guard fail closed at expiry.
    if (verdict === 'unknown') throw new Error('no authority vouches for the lease');
    return verdict === 'active';
  }

  async leaseStatus(leaseId: string, runId?: string): Promise<'active' | 'inactive' | 'unknown'> {
    try {
      return (await this.isActive(leaseId, runId)) ? 'active' : 'inactive';
    } catch {
      return 'unknown';
    }
  }

  private async collect(decision: LeaseDecision, heartbeat?: Heartbeat): Promise<LeaseDecision> {
    if (!decision?.granted || !decision.lease) return decision;
    let lease = decision.lease;
    const issuerSignature = { keyId: lease.keyId, signature: lease.signature };
    const results = await Promise.allSettled(this.cosigners.map((c) => c.cosign(lease.claims, heartbeat, issuerSignature)));
    const reasons: string[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value?.granted && r.value.cosignature) {
        const cos = r.value.cosignature;
        if (cos.keyId !== lease.keyId && !(lease.cosignatures ?? []).some((c) => c.keyId === cos.keyId)) {
          lease = { ...lease, cosignatures: [...(lease.cosignatures ?? []), { keyId: cos.keyId, signature: cos.signature }] };
        }
      } else {
        reasons.push(r.status === 'fulfilled' ? (r.value?.reason ?? 'refused') : 'unreachable');
      }
    }
    if (1 + (lease.cosignatures ?? []).length < this.threshold) {
      return { granted: false, reason: `authority quorum not reached (${1 + (lease.cosignatures ?? []).length}/${this.threshold}): ${reasons.join('; ')}` };
    }
    return { granted: true, lease };
  }
}

/** Something the guard can stop when the lease is lost (`HaltCoordinator` satisfies this). */
export interface HaltTrigger {
  trigger(source: string): unknown;
}

/** Constructor options for {@link LeaseGuard}. */
export interface LeaseGuardOptions {
  runId: string;
  /** Public key of the lease authority (single-authority mode) */
  authorityPublicKey?: KeyObject;
  /** Public keys of the k-of-n authorities; use with `authorityThreshold` */
  authorityPublicKeys?: readonly KeyObject[];
  /** Signatures required on every lease (k). Default 1. */
  authorityThreshold?: number;
  transport: LeaseTransport;
  /** Kill switch fired when the lease is lost */
  halt?: HaltTrigger;
  /** Reports cumulative spend for heartbeats */
  spend?: () => { usd: number; tokens: number };
  /** Reports health and canary state for heartbeats */
  health?: () => { health: Heartbeat['health']; canaryFailed?: boolean };
  /**
   * Produce attestation evidence bound to `nonce` (policies with
   * `attestation`). Wire to the TPM/TEE quoting service, never to code the
   * agent controls.
   */
  attest?: (nonce: string) => AttestationEvidence | Promise<AttestationEvidence>;
  /** Renew this long before expiry (default: a third of the lease TTL, max 60 s) */
  renewMarginMs?: number;
  /** How often to poll the authority for revocation (default 5 s) */
  statusPollMs?: number;
  /** Root that `LeaseAction.path` and `scope.paths` are relative to (default: cwd) */
  projectRoot?: string;
  /** Clock overrides (tests) */
  now?: () => number;
  monotonic?: () => number;
}

/** Enforces a valid, in-scope lease for every guarded action. */
export class LeaseGuard implements LeaseCheck {
  /** Last renewal refusal, if the authority declined to renew. */
  renewalRefused: string | null = null;
  private lease: SignedLease | null = null;
  private receivedMono = 0;
  private lostReason: string | null = null;
  private halted = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPoll = 0;
  private busy = false;
  private readonly now: () => number;
  private readonly mono: () => number;
  private readonly root: string;

  constructor(private readonly options: LeaseGuardOptions) {
    if (!options.runId || !options.transport || (!options.authorityPublicKey && !(options.authorityPublicKeys?.length))) {
      throw new TypeError('LeaseGuard: runId, transport, and authorityPublicKey(s) are required');
    }
    const k = options.authorityThreshold ?? 1;
    if (!Number.isInteger(k) || k < 1 || k > 16) throw new TypeError('LeaseGuard: authorityThreshold must be between 1 and 16');
    if (k > 1 && (options.authorityPublicKeys?.length ?? 0) < k) throw new TypeError('LeaseGuard: authorityThreshold exceeds the number of authority keys');
    this.now = options.now ?? Date.now;
    this.mono = options.monotonic ?? (() => performance.now());
    this.root = resolvePath(options.projectRoot ?? process.cwd());
  }

  /** The current lease, if any. */
  get currentLease(): SignedLease | null {
    return this.lease;
  }

  /** Why the guard stopped honouring actions, or `null` while healthy. */
  get lossReason(): string | null {
    return this.lostReason;
  }

  /** Obtain the first lease and start the renewal / revocation loop. */
  async start(): Promise<void> {
    const decision = await this.safeCall(async () => {
      const attest = this.options.attest;
      if (!attest) return this.options.transport.issue(this.options.runId);
      if (!this.options.transport.attestationNonce) throw new Error('transport cannot fetch an attestation challenge');
      const nonce = await this.options.transport.attestationNonce(this.options.runId);
      return this.options.transport.issue(this.options.runId, await attest(nonce));
    });
    if (!decision?.granted || !decision.lease) {
      this.lose(`lease not issued: ${decision?.reason ?? 'authority unreachable'}`);
      throw new LeaseError(`LeaseGuard: ${this.lostReason}`, 'LEASE_NOT_ISSUED');
    }
    this.accept(decision.lease);
    const interval = Math.max(250, Math.min(this.options.statusPollMs ?? 5_000, 1_000));
    this.timer = setInterval(() => { void this.tick(); }, interval);
    this.timer.unref?.();
  }

  /** Stop the background loop without halting (normal shutdown). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Kill-switch hook: stop renewing and refuse every further action. */
  halt(reason: string): number {
    this.stop();
    this.halted = true;
    this.lostReason ??= `halted: ${reason}`;
    return 0;
  }

  /**
   * Throw {@link LeaseError} unless a valid lease covers `action`.
   * Synchronous and local: no network call on the hot path.
   */
  assertActive(action: LeaseAction): void {
    if (this.halted || this.lostReason) throw new LeaseError(`No valid lease: ${this.lostReason ?? 'halted'}`, 'LEASE_LOST');
    const lease = this.lease;
    if (!lease) throw new LeaseError('No lease held', 'LEASE_MISSING');
    if (!this.withinLifetime(lease)) {
      this.lose('lease expired');
      throw new LeaseError('Lease expired', 'LEASE_EXPIRED');
    }
    const scope = lease.claims.scope;
    if (!scope.tools.includes(action.tool)) throw new LeaseError(`Tool "${action.tool}" is outside the lease scope`, 'LEASE_SCOPE');
    if (action.path !== undefined && !this.pathAllowed(action.path, scope.paths ?? [])) {
      throw new LeaseError('Path is outside the lease scope', 'LEASE_SCOPE');
    }
    if (action.destination !== undefined && !(scope.destinations ?? []).includes(action.destination)) {
      throw new LeaseError(`Destination "${action.destination}" is outside the lease scope`, 'LEASE_SCOPE');
    }
  }

  /** One loop iteration: renew near expiry, poll for revocation. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.busy || this.halted || this.lostReason || !this.lease) return;
    this.busy = true;
    try {
      const lease = this.lease;
      if (!this.withinLifetime(lease)) return this.lose('lease expired before renewal');

      const now = this.now();
      if (now - this.lastPoll >= (this.options.statusPollMs ?? 5_000)) {
        this.lastPoll = now;
        const active = await this.safeCall(() => this.options.transport.isActive(lease.claims.leaseId, this.options.runId));
        if (active === false) return this.lose('lease revoked or paused by the authority');
        // An unreachable authority is tolerated until expiry; renewal below then fails closed.
      }

      const ttl = lease.claims.expiresAt - lease.claims.issuedAt;
      const margin = this.options.renewMarginMs ?? Math.min(Math.floor(ttl / 3), 60_000);
      if (lease.claims.expiresAt - now > margin) return;

      const spend = this.options.spend?.() ?? { usd: 0, tokens: 0 };
      const health = this.options.health?.() ?? { health: 'ok' as const };
      const attNonce = lease.claims.attestationNonce;
      const attestation = attNonce && this.options.attest ? await this.safeCall(async () => this.options.attest!(attNonce)) : undefined;
      const decision = await this.safeCall(() => this.options.transport.renew({
        leaseId: lease.claims.leaseId,
        runId: this.options.runId,
        at: this.now(),
        spentUsd: spend.usd,
        spentTokens: spend.tokens,
        health: health.health,
        canaryFailed: health.canaryFailed,
        ...(attestation ? { attestation } : {}),
      }));
      if (decision?.granted && decision.lease) {
        this.accept(decision.lease);
      } else if (decision) {
        // Refused: keep the current lease until it expires, then halt (no renewal will come).
        this.renewalRefused = decision.reason ?? 'renewal refused';
      }
    } finally {
      this.busy = false;
    }
  }

  private accept(lease: SignedLease): void {
    const reason = verifyLeaseWith(lease, this.options, this.now());
    if (reason) return this.lose(`authority returned an invalid lease: ${reason}`);
    if (lease.claims.runId !== this.options.runId) return this.lose('authority returned a lease for another run');
    if (this.lease && lease.claims.sequence <= this.lease.claims.sequence) return this.lose('lease sequence did not advance');
    this.lease = lease;
    this.receivedMono = this.mono();
    this.renewalRefused = null;
  }

  /** Valid only while both the wall clock and local elapsed time are within the lease TTL. */
  private withinLifetime(lease: SignedLease): boolean {
    const { issuedAt, expiresAt } = lease.claims;
    return this.now() < expiresAt && this.mono() - this.receivedMono < expiresAt - issuedAt;
  }

  private pathAllowed(target: string, prefixes: readonly string[]): boolean {
    if (typeof target !== 'string' || target.includes('\0')) return false;
    const abs = isAbsolute(target) ? resolvePath(target) : resolvePath(this.root, target);
    return prefixes.some((prefix) => {
      const base = resolvePath(this.root, prefix);
      const rel = relative(base, abs);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'));
    });
  }

  private lose(reason: string): void {
    if (this.lostReason) return;
    this.lostReason = reason;
    this.stop();
    try {
      this.options.halt?.trigger(`lease-lost: ${reason}`);
    } catch {
      // The guard already refuses every action; a failing halt target must not mask that.
    }
  }

  private async safeCall<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch {
      return undefined;
    }
  }
}

/**
 * Verify a lease against a single authority key or a k-of-n key set.
 * Used by `LeaseGuard` and `EgressProxy`.
 */
export function verifyLeaseWith(
  lease: SignedLease,
  keys: { authorityPublicKey?: KeyObject; authorityPublicKeys?: readonly KeyObject[]; authorityThreshold?: number },
  now: number,
): string | null {
  const k = keys.authorityThreshold ?? 1;
  if (keys.authorityPublicKeys && keys.authorityPublicKeys.length > 0) {
    return verifyLeaseQuorum(lease, keys.authorityPublicKeys, k, now);
  }
  if (!keys.authorityPublicKey) return 'no authority key configured';
  return verifyLease(lease, keys.authorityPublicKey, now);
}

/** HTTP transport to a remote `LeaseAuthority` using the `runner` role secret. Also a {@link CosignTransport}. */
export class HttpLeaseTransport implements LeaseTransport, CosignTransport {
  constructor(private readonly baseUrl: string, private readonly runnerSecret: string, private readonly timeoutMs = 5_000) {
    if (!/^https?:\/\//.test(baseUrl)) throw new TypeError('HttpLeaseTransport: baseUrl must be http(s)');
    if (!runnerSecret || runnerSecret.length < 32) throw new TypeError('HttpLeaseTransport: runner secret must be at least 32 characters');
  }

  issue(runId: string, attestation?: AttestationEvidence): Promise<LeaseDecision> {
    return this.call<LeaseDecision>('POST', '/v1/leases/issue', { runId, ...(attestation ? { attestation } : {}) });
  }

  async attestationNonce(runId: string): Promise<string> {
    const r = await this.call<{ nonce?: unknown }>('GET', `/v1/attestation/nonce?runId=${encodeURIComponent(runId)}`);
    if (typeof r.nonce !== 'string') throw new Error('authority returned no nonce');
    return r.nonce;
  }

  renew(heartbeat: Heartbeat): Promise<LeaseDecision> {
    return this.call<LeaseDecision>('POST', '/v1/leases/renew', heartbeat);
  }

  cosign(claims: LeaseClaims, heartbeat: Heartbeat | undefined, issuerSignature: LeaseCosignature): Promise<{ granted: boolean; cosignature?: LeaseCosignature; reason?: string }> {
    return this.call('POST', '/v1/leases/cosign', { claims, heartbeat, issuerSignature });
  }

  async isActive(leaseId: string, runId?: string): Promise<boolean> {
    return (await this.leaseStatus(leaseId, runId)) === 'active';
  }

  async leaseStatus(leaseId: string, runId?: string): Promise<'active' | 'inactive' | 'unknown'> {
    const q = runId !== undefined ? `?runId=${encodeURIComponent(runId)}` : '';
    const r = await this.call<{ active?: unknown; status?: unknown }>('GET', `/v1/leases/${encodeURIComponent(leaseId)}/status${q}`);
    if (r.status === 'active' || r.status === 'inactive' || r.status === 'unknown') return r.status;
    return r.active === true ? 'active' : 'inactive';
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: { Authorization: `Bearer ${this.runnerSecret}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`authority responded ${res.status}`);
    return (await res.json()) as T;
  }
}
