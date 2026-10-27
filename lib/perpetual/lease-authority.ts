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
  keyIdOf,
  policyHash,
  scopeWithin,
  signLease,
  verifySignedPolicy,
  type Ed25519KeyPair,
} from './signing';
import type {
  ControlRole,
  Heartbeat,
  LeaseBudget,
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
  action: 'issue' | 'renew' | 'refuse' | 'revoke' | 'pause' | 'resume' | 'tighten' | 'alert' | 'policy' | 'stop';
  role: ControlRole;
  runId?: string;
  leaseId?: string;
  reason?: string;
}

/** Constructor options for {@link LeaseAuthority}. */
export interface LeaseAuthorityOptions {
  /** Operator public key; only policies it signed are accepted */
  operatorPublicKey: KeyObject;
  /** Authority signing key pair (keep the private key inside this process) */
  authorityKey: Ed25519KeyPair;
  /** Initial operator-signed policy */
  policy: SignedPolicy;
  /** Clock override (tests) */
  now?: () => number;
  /** Audit callback (wire to `SecureAuditLogger` / `HashChainSink`) */
  onEvent?: (event: AuthorityEvent) => void;
}

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
}

const ALERT_RANK: Record<AlertLevel, number> = { info: 0, warning: 1, critical: 2 };
const RUN_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_RUNS = 10_000;

/** Issues, renews, and revokes leases under an operator-signed policy. */
export class LeaseAuthority {
  private signed: SignedPolicy;
  private readonly runs = new Map<string, RunRecord>();
  private readonly revoked = new Set<string>();
  private overlay: TightenDelta = {};
  private paused = false;
  private highestAlert: AlertLevel = 'info';
  private alerts: { source: string; at: number }[] = [];
  private readonly now: () => number;
  private readonly operatorPublicKey: KeyObject;
  private readonly authorityKey: Ed25519KeyPair;
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
  issue(runId: string, role: ControlRole = 'runner'): LeaseDecision {
    if (role !== 'runner' && role !== 'operator') return this.refuse(role, runId, 'role may not issue leases');
    if (typeof runId !== 'string' || !RUN_ID.test(runId)) return this.refuse(role, undefined, 'invalid runId');
    const blocked = this.blockedReason();
    if (blocked) return this.refuse(role, runId, blocked);
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
    if ((run.expiresAt ?? 0) <= now) return this.stop(run, heartbeat.runId, role, 'lease already expired');

    const policy = this.effectivePolicy();
    if (!Number.isFinite(heartbeat.at) || heartbeat.at > now + 5_000 || now - heartbeat.at > policy.heartbeatMaxAgeMs) {
      return this.refuse(role, heartbeat.runId, 'stale or future heartbeat');
    }
    if (!(heartbeat.spentUsd >= 0) || !(heartbeat.spentTokens >= 0)) return this.refuse(role, heartbeat.runId, 'invalid spend report');
    // Spend can only grow; a lower report keeps the higher recorded value.
    run.spentUsd = Math.max(run.spentUsd, heartbeat.spentUsd);
    run.spentTokens = Math.max(run.spentTokens, heartbeat.spentTokens);

    const blocked = this.blockedReason();
    if (blocked) return this.stop(run, heartbeat.runId, role, blocked);
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
    if (this.paused || this.revoked.has(leaseId)) return false;
    for (const run of this.runs.values()) {
      if (run.currentLeaseId === leaseId) return run.state === 'active' && (run.expiresAt ?? 0) > this.now();
    }
    return false;
  }

  /** Revoke one run, or every run. Takes effect immediately. */
  revoke(target: { runId: string } | { all: true }, role: ControlRole, reason = 'revoked'): void {
    this.assertRole(role, ['operator', 'sentry'], 'revoke');
    this.assertSentryMayActAlone(role, 'revoke');
    const ids = 'all' in target ? [...this.runs.keys()] : [target.runId];
    for (const id of ids) {
      const run = this.runs.get(id);
      if (!run) continue;
      if (run.currentLeaseId) this.revoked.add(run.currentLeaseId);
      run.state = 'revoked';
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
        run.state = 'paused';
        run.reason = reason;
      }
    }
    this.emit({ action: 'pause', role, reason });
  }

  /** Resume after a pause. Operator only; runs must request a fresh lease. */
  resume(role: ControlRole): void {
    this.assertRole(role, ['operator'], 'resume');
    this.paused = false;
    for (const run of this.runs.values()) {
      if (run.state === 'paused') {
        run.state = 'active';
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
    if (delta.scope && !scopeWithin(delta.scope, current.scope)) throw new Error('tighten: scope would widen');
    if (delta.leaseTtlMs !== undefined && !(delta.leaseTtlMs >= 10_000 && delta.leaseTtlMs <= current.leaseTtlMs)) {
      throw new Error('tighten: leaseTtlMs may only shrink (minimum 10000)');
    }
    if (delta.autoRenew !== undefined && delta.autoRenew !== false) throw new Error('tighten: autoRenew may only be turned off');
    for (const key of ['runCeilingUsd', 'runCeilingTokens'] as const) {
      const v = delta.budget?.[key];
      if (v !== undefined && !(v >= 0 && v <= current.budget[key])) throw new Error(`tighten: budget.${key} may only shrink`);
    }
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
  reportAlert(level: AlertLevel, source: string, role: ControlRole): void {
    this.assertRole(role, ['operator', 'sentry'], 'alert');
    if (!(level in ALERT_RANK)) throw new TypeError('invalid alert level');
    if (ALERT_RANK[level] > ALERT_RANK[this.highestAlert]) this.highestAlert = level;
    const src = String(source).slice(0, 128);
    this.emit({ action: 'alert', role, reason: `${level} from ${src}` });
    const stopWhen = this.signed.policy.stopWhen;
    const threshold = stopWhen.sentryAlertAtOrAbove;
    if (!threshold || ALERT_RANK[level] < ALERT_RANK[threshold]) return;
    const now = this.now();
    const windowMs = stopWhen.sentryWindowMs ?? 300_000;
    this.alerts = this.alerts.filter((a) => now - a.at < windowMs).slice(-1023);
    this.alerts.push({ source: role === 'operator' ? '\0operator' : src, at: now });
    const distinct = new Set(this.alerts.map((a) => a.source)).size;
    if (role !== 'operator' && distinct < (stopWhen.sentryQuorum ?? 1)) return;
    for (const [id, run] of this.runs) {
      if (run.state === 'active') this.stop(run, id, role, `sentry alert: ${level}${role === 'operator' ? ' (operator)' : ` (${distinct} sentries)`}`);
    }
  }

  /** Install a newer operator-signed policy. Clears tightening and alert state. */
  installPolicy(signed: SignedPolicy, role: ControlRole): void {
    this.assertRole(role, ['operator'], 'install a policy');
    const reason = verifySignedPolicy(signed, this.operatorPublicKey);
    if (reason) throw new Error(`installPolicy: ${reason}`);
    if (signed.policy.issuedAt <= this.signed.policy.issuedAt) throw new Error('installPolicy: policy is not newer than the active one');
    this.signed = signed;
    this.overlay = {};
    this.highestAlert = 'info';
    this.alerts = [];
    this.emit({ action: 'policy', role, reason: signed.policy.policyId });
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
      if (req.method === 'POST' && p === '/v1/leases/issue') return void send(res, 200, this.issue(str(body, 'runId'), role));
      if (req.method === 'POST' && p === '/v1/leases/renew') return void send(res, 200, this.renew(body as unknown as Heartbeat, role));
      if (req.method === 'GET' && p.startsWith('/v1/leases/') && p.endsWith('/status')) {
        const leaseId = decodeURIComponent(p.slice('/v1/leases/'.length, -'/status'.length));
        return void send(res, 200, { leaseId, active: this.isLeaseActive(leaseId) });
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
        this.reportAlert(str(body, 'level') as AlertLevel, caller.identity, role);
        return void send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/v1/policy') { this.installPolicy(body as unknown as SignedPolicy, role); return void send(res, 200, { ok: true }); }
      send(res, 404, { error: 'not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'bad request';
      send(res, message.startsWith('role ') ? 403 : 400, { error: message });
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private blockedReason(): string | null {
    if (this.paused) return 'authority is paused';
    const until = this.signed.policy.renewUntil;
    if (until !== undefined && this.now() >= until) return 'policy end date reached';
    return null;
  }

  private grant(run: RunRecord, runId: string, role: ControlRole, action: 'issue' | 'renew'): LeaseDecision {
    const policy = this.effectivePolicy();
    const now = this.now();
    const until = policy.renewUntil;
    const expiresAt = Math.min(now + policy.leaseTtlMs, until ?? Infinity);
    if (run.currentLeaseId) this.revoked.add(run.currentLeaseId);
    run.sequence += 1;
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
      },
      this.authorityKey,
    );
    run.currentLeaseId = lease.claims.leaseId;
    run.expiresAt = expiresAt;
    this.emit({ action, role, runId, leaseId: lease.claims.leaseId });
    return { granted: true, lease };
  }

  private refuse(role: ControlRole, runId: string | undefined, reason: string): LeaseDecision {
    this.emit({ action: 'refuse', role, runId, reason });
    return { granted: false, reason };
  }

  private stop(run: RunRecord, runId: string, role: ControlRole, reason: string): LeaseDecision {
    if (run.state === 'active') {
      run.state = 'stopped';
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

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
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
