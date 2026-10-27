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
import { LeaseError, verifyLease } from './signing';
import type { Heartbeat, LeaseAction, LeaseCheck, LeaseDecision, SignedLease } from './types';

/** How the guard reaches the authority (HTTP in production). */
export interface LeaseTransport {
  issue(runId: string): Promise<LeaseDecision>;
  renew(heartbeat: Heartbeat): Promise<LeaseDecision>;
  isActive(leaseId: string): Promise<boolean>;
}

/** Something the guard can stop when the lease is lost (`HaltCoordinator` satisfies this). */
export interface HaltTrigger {
  trigger(source: string): unknown;
}

/** Constructor options for {@link LeaseGuard}. */
export interface LeaseGuardOptions {
  runId: string;
  /** Public key of the lease authority */
  authorityPublicKey: KeyObject;
  transport: LeaseTransport;
  /** Kill switch fired when the lease is lost */
  halt?: HaltTrigger;
  /** Reports cumulative spend for heartbeats */
  spend?: () => { usd: number; tokens: number };
  /** Reports health and canary state for heartbeats */
  health?: () => { health: Heartbeat['health']; canaryFailed?: boolean };
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
    if (!options.runId || !options.transport || !options.authorityPublicKey) {
      throw new TypeError('LeaseGuard: runId, transport, and authorityPublicKey are required');
    }
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
    const decision = await this.safeCall(() => this.options.transport.issue(this.options.runId));
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
        const active = await this.safeCall(() => this.options.transport.isActive(lease.claims.leaseId));
        if (active === false) return this.lose('lease revoked or paused by the authority');
        // An unreachable authority is tolerated until expiry; renewal below then fails closed.
      }

      const ttl = lease.claims.expiresAt - lease.claims.issuedAt;
      const margin = this.options.renewMarginMs ?? Math.min(Math.floor(ttl / 3), 60_000);
      if (lease.claims.expiresAt - now > margin) return;

      const spend = this.options.spend?.() ?? { usd: 0, tokens: 0 };
      const health = this.options.health?.() ?? { health: 'ok' as const };
      const decision = await this.safeCall(() => this.options.transport.renew({
        leaseId: lease.claims.leaseId,
        runId: this.options.runId,
        at: this.now(),
        spentUsd: spend.usd,
        spentTokens: spend.tokens,
        health: health.health,
        canaryFailed: health.canaryFailed,
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
    const reason = verifyLease(lease, this.options.authorityPublicKey, this.now());
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

/** HTTP transport to a remote `LeaseAuthority` using the `runner` role secret. */
export class HttpLeaseTransport implements LeaseTransport {
  constructor(private readonly baseUrl: string, private readonly runnerSecret: string, private readonly timeoutMs = 5_000) {
    if (!/^https?:\/\//.test(baseUrl)) throw new TypeError('HttpLeaseTransport: baseUrl must be http(s)');
    if (!runnerSecret || runnerSecret.length < 32) throw new TypeError('HttpLeaseTransport: runner secret must be at least 32 characters');
  }

  issue(runId: string): Promise<LeaseDecision> {
    return this.call<LeaseDecision>('POST', '/v1/leases/issue', { runId });
  }

  renew(heartbeat: Heartbeat): Promise<LeaseDecision> {
    return this.call<LeaseDecision>('POST', '/v1/leases/renew', heartbeat);
  }

  async isActive(leaseId: string): Promise<boolean> {
    const r = await this.call<{ active?: unknown }>('GET', `/v1/leases/${encodeURIComponent(leaseId)}/status`);
    return r.active === true;
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
