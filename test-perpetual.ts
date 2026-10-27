/**
 * test-perpetual.ts — Perpetual Runtime Phase 1: lease authority, lease guard,
 * egress proxy, and their integration hooks.
 *
 * Invariants under test:
 * - I1: an external stop always works without agent cooperation (revoke, pause,
 *   dead-man switch on expiry / unreachable authority, egress cut-off).
 * - Agents cannot mint, extend, or widen their own lease.
 * - Sentries can only tighten or stop; only the operator can resume or loosen.
 *
 * No secrets are hard-coded: keys and role secrets are generated at runtime.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { createPublicKey, randomBytes } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import type { AddressInfo } from 'net';
import {
  BudgetBalancer,
  EgressProxy,
  GuardedPaths,
  HttpLeaseTransport,
  LeaseAuthority,
  LeaseError,
  LeaseGuard,
  ROLE_SECRET_ENV,
  encodeLeaseHeader,
  generateEd25519KeyPair,
  keyIdOf,
  loadRoutes,
  readKeyPair,
  readPublicKey,
  readRoleSecrets,
  signLease,
  signPolicy,
  validatePolicy,
  verifyLease,
  verifySignedPolicy,
  writeKeyPair,
} from './lib/perpetual';
import type { Heartbeat, LeaseDecision, LeaseTransport, RenewalPolicy, SignedBudgetPolicy, SignedGuardedApproval, SignedLease, SignedPolicy } from './lib/perpetual';
import { AgentRuntime } from './lib/agent-runtime';
import { GovernedModelGateway } from './lib/model-gateway';
import { LockedBlackboard } from './lib/locked-blackboard';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];
function pass(label: string) { passed++; process.stdout.write(`  ✓ ${label}\n`); }
function fail(label: string, reason: string) { failed++; failures.push(`${label}: ${reason}`); process.stdout.write(`  ✗ ${label} — ${reason}\n`); }
function assert(cond: boolean, label: string, detail = '') { if (cond) pass(label); else fail(label, detail || 'assertion failed'); }
function section(name: string) { process.stdout.write(`\n${name}\n`); }
function throwsSync(fn: () => unknown, label: string, check?: (e: unknown) => boolean): void {
  try { fn(); fail(label, 'expected throw'); } catch (e) { assert(!check || check(e), label, e instanceof Error ? e.message : String(e)); }
}
async function rejects(fn: () => Promise<unknown>, label: string, check?: (e: unknown) => boolean): Promise<void> {
  try { await fn(); fail(label, 'expected rejection'); } catch (e) { assert(!check || check(e), label, e instanceof Error ? e.message : String(e)); }
}
const secret = () => randomBytes(32).toString('hex');

/** Controllable clocks shared by authority and guard. */
class Clock {
  wall = 1_800_000_000_000;
  mono = 1_000;
  advance(ms: number) { this.wall += ms; this.mono += ms; }
}

function basePolicy(overrides: Partial<RenewalPolicy> = {}, issuedAt = 1_800_000_000_000): RenewalPolicy {
  return {
    v: 'nai-policy-v1',
    policyId: `policy-${issuedAt}`,
    issuedAt,
    leaseTtlMs: 60_000,
    autoRenew: true,
    heartbeatMaxAgeMs: 30_000,
    scope: { tier: 'standard', tools: ['shell_exec', 'file_write', 'model_call', 'blackboard_write'], paths: ['data/work'], destinations: ['llm'] },
    budget: { runCeilingUsd: 10, runCeilingTokens: 1_000_000 },
    stopWhen: { sentryAlertAtOrAbove: 'critical', onCanaryFailure: true, onHealthFailing: true },
    ...overrides,
  };
}

function setup(overrides: Partial<RenewalPolicy> = {}, realTime = false) {
  const clock = new Clock();
  if (realTime) clock.wall = Date.now();
  const operator = generateEd25519KeyPair();
  const authorityKey = generateEd25519KeyPair();
  const events: string[] = [];
  const authority = new LeaseAuthority({
    operatorPublicKey: operator.publicKey,
    authorityKey,
    policy: signPolicy(basePolicy(overrides, clock.wall), operator),
    now: realTime ? Date.now : () => clock.wall,
    onEvent: (e) => { events.push(`${e.action}:${e.role}`); },
  });
  return { clock, operator, authorityKey, authority, events };
}

function hb(lease: SignedLease, at: number, extra: Partial<Heartbeat> = {}): Heartbeat {
  return { leaseId: lease.claims.leaseId, runId: lease.claims.runId, at, spentUsd: 0, spentTokens: 0, health: 'ok', ...extra };
}

/** In-process transport with a switch to simulate an unreachable authority. */
class LocalTransport implements LeaseTransport {
  down = false;
  constructor(private readonly authority: LeaseAuthority) {}
  async issue(runId: string): Promise<LeaseDecision> { if (this.down) throw new Error('down'); return this.authority.issue(runId, 'runner'); }
  async renew(h: Heartbeat): Promise<LeaseDecision> { if (this.down) throw new Error('down'); return this.authority.renew(h, 'runner'); }
  async isActive(id: string): Promise<boolean> { if (this.down) throw new Error('down'); return this.authority.isLeaseActive(id); }
}

// ---------------------------------------------------------------------------
// Signing & policy
// ---------------------------------------------------------------------------

function testSigning(): void {
  section('Signing & policy');
  const operator = generateEd25519KeyPair();
  const other = generateEd25519KeyPair();
  const signed = signPolicy(basePolicy(), operator);
  assert(verifySignedPolicy(signed, operator.publicKey) === null, 'operator-signed policy verifies');
  assert(verifySignedPolicy(signed, other.publicKey) !== null, 'policy rejected under a different operator key');
  const tampered = { ...signed, policy: { ...signed.policy, budget: { runCeilingUsd: 1e9, runCeilingTokens: 1e12 } } };
  assert(verifySignedPolicy(tampered, operator.publicKey) !== null, 'tampered policy rejected');
  throwsSync(() => validatePolicy(basePolicy({ leaseTtlMs: 1_000 })), 'lease TTL below 10 s rejected');
  throwsSync(() => validatePolicy(basePolicy({ leaseTtlMs: 7 * 24 * 3600 * 1000 })), 'lease TTL above 24 h rejected');
  throwsSync(() => validatePolicy(basePolicy({ scope: { tier: 'standard', tools: ['x'], paths: ['../etc'] } })), 'path scope with .. rejected');
  throwsSync(() => validatePolicy(basePolicy({ scope: { tier: 'root' as never, tools: [] } })), 'unknown tier rejected');
  throwsSync(() => validatePolicy(basePolicy({ budget: { runCeilingUsd: -1, runCeilingTokens: 0 } })), 'negative budget rejected');
}

// ---------------------------------------------------------------------------
// Lease authority
// ---------------------------------------------------------------------------

function testAuthority(): void {
  section('Lease authority');
  const { clock, operator, authorityKey, authority, events } = setup();

  throwsSync(() => new LeaseAuthority({ operatorPublicKey: operator.publicKey, authorityKey: operator, policy: signPolicy(basePolicy(), operator) }), 'authority key must differ from operator key');
  const forgedPolicy = signPolicy(basePolicy(), generateEd25519KeyPair());
  throwsSync(() => new LeaseAuthority({ operatorPublicKey: operator.publicKey, authorityKey, policy: forgedPolicy }), 'policy not signed by the operator rejected');

  const first = authority.issue('run-1');
  assert(first.granted && !!first.lease, 'first lease issued');
  const lease1 = first.lease!;
  assert(verifyLease(lease1, authority.publicKey, clock.wall) === null, 'lease verifies with the authority public key');
  assert(verifyLease(lease1, operator.publicKey, clock.wall) !== null, 'lease does not verify with the operator key');
  const forgedClaims = { ...lease1.claims, expiresAt: lease1.claims.expiresAt + 3_600_000 };
  assert(verifyLease({ ...lease1, claims: forgedClaims }, authority.publicKey, clock.wall) !== null, 'extended (tampered) lease rejected');
  assert(verifyLease(signLease(forgedClaims, generateEd25519KeyPair()), authority.publicKey, clock.wall) !== null, 'self-signed lease rejected');
  assert(!authority.issue('run-1').granted, 'second issue while a lease is active refused');
  assert(!authority.issue('../bad').granted, 'invalid runId refused');

  clock.advance(45_000);
  const r1 = authority.renew(hb(lease1, clock.wall, { spentUsd: 1, spentTokens: 1000 }));
  assert(r1.granted && r1.lease!.claims.sequence === 2, 'renewal grants the next sequence');
  assert(!authority.isLeaseActive(lease1.claims.leaseId) && authority.isLeaseActive(r1.lease!.claims.leaseId), 'previous lease superseded on renewal');
  assert(!authority.renew(hb(lease1, clock.wall)).granted, 'renewal with a superseded lease refused');
  assert(!authority.renew(hb(r1.lease!, clock.wall - 40_000)).granted, 'stale heartbeat refused');
  assert(!authority.renew(hb(r1.lease!, clock.wall), 'sentry').granted, 'only the runner role can renew');
  const r2 = authority.renew(hb(r1.lease!, clock.wall, { spentUsd: 0.5 }));
  assert(r2.granted && authority.status('run-1')[0].spentUsd === 1, 'reported spend never decreases');

  const canary = authority.renew(hb(r2.lease!, clock.wall, { canaryFailed: true }));
  assert(!canary.granted && authority.status('run-1')[0].state === 'stopped', 'canary failure stops renewal');
  clock.advance(61_000);
  assert(!authority.isLeaseActive(r2.lease!.claims.leaseId), 'stopped run lease expires (dead-man)');

  // Budget ceiling
  const b = setup({ budget: { runCeilingUsd: 2, runCeilingTokens: 1_000_000 } });
  const bl = b.authority.issue('run-b').lease!;
  b.clock.advance(1_000);
  assert(!b.authority.renew(hb(bl, b.clock.wall, { spentUsd: 2.5 })).granted, 'renewal refused past the run budget ceiling');

  // Auto-renew off and end date
  const n = setup({ autoRenew: false });
  const nl = n.authority.issue('run-n').lease!;
  assert(!n.authority.renew(hb(nl, n.clock.wall)).granted, 'no renewal when the policy turns auto-renew off');
  const e = setup({ renewUntil: 1_800_000_030_000 });
  const el = e.authority.issue('run-e').lease!;
  assert(el.claims.expiresAt <= 1_800_000_030_000, 'lease never outlives the policy end date');
  e.clock.advance(31_000);
  assert(!e.authority.issue('run-e2').granted, 'no new leases after the policy end date');

  // Revoke / pause / resume / roles
  const c = setup();
  const cl = c.authority.issue('run-c').lease!;
  throwsSync(() => c.authority.revoke({ runId: 'run-c' }, 'runner'), 'runner cannot revoke');
  c.authority.revoke({ runId: 'run-c' }, 'sentry', 'anomaly');
  assert(!c.authority.isLeaseActive(cl.claims.leaseId), 'revoked lease is inactive immediately');
  assert(!c.authority.renew(hb(cl, c.clock.wall)).granted && !c.authority.issue('run-c').granted, 'revoked run gets no lease');

  const p = setup();
  const pl = p.authority.issue('run-p').lease!;
  p.authority.pause('sentry');
  assert(!p.authority.isLeaseActive(pl.claims.leaseId), 'pause invalidates current leases');
  assert(!p.authority.issue('run-q').granted, 'nothing issued while paused');
  throwsSync(() => p.authority.resume('sentry'), 'sentry cannot resume');
  p.authority.resume('operator');
  assert(p.authority.issue('run-p').granted, 'operator resume allows a fresh lease');

  // Tighten-only
  const t = setup();
  t.authority.tighten({ leaseTtlMs: 20_000, budget: { runCeilingUsd: 5 } }, 'sentry');
  const tl = t.authority.issue('run-t').lease!;
  assert(tl.claims.expiresAt - tl.claims.issuedAt === 20_000 && tl.claims.budget.runCeilingUsd === 5, 'tightened TTL and budget apply to new leases');
  throwsSync(() => t.authority.tighten({ leaseTtlMs: 50_000 }, 'sentry'), 'TTL cannot be raised by tighten');
  throwsSync(() => t.authority.tighten({ budget: { runCeilingUsd: 100 } }, 'operator'), 'budget cannot be raised by tighten');
  throwsSync(() => t.authority.tighten({ scope: { tier: 'elevated', tools: ['shell_exec'] } }, 'sentry'), 'tier cannot be raised by tighten');
  throwsSync(() => t.authority.tighten({ scope: { tier: 'standard', tools: ['shell_exec', 'trade'] } }, 'sentry'), 'tools cannot be added by tighten');
  throwsSync(() => t.authority.tighten({ autoRenew: true as never }, 'sentry'), 'auto-renew cannot be turned on by tighten');
  t.authority.tighten({ scope: { tier: 'observe', tools: ['model_call'] } }, 'sentry');
  t.authority.revoke({ runId: 'run-t' }, 'operator');
  const narrowed = setup();
  narrowed.authority.tighten({ scope: { tier: 'observe', tools: ['model_call'] } }, 'sentry');
  assert(narrowed.authority.issue('run-x').lease!.claims.scope.tools.join() === 'model_call', 'narrowed scope applies to new leases');

  // Alerts and policy installation
  const a = setup();
  const al = a.authority.issue('run-a').lease!;
  a.authority.reportAlert('warning', 'sentry-1', 'sentry');
  a.clock.advance(1_000);
  assert(a.authority.renew(hb(al, a.clock.wall)).granted, 'below-threshold alert does not stop renewal');
  a.authority.reportAlert('critical', 'sentry-1', 'sentry');
  assert(a.authority.status('run-a')[0].state === 'stopped', 'critical alert stops renewal for every run');
  throwsSync(() => a.authority.installPolicy(signPolicy(basePolicy({}, a.clock.wall + 10), a.operator), 'sentry'), 'sentry cannot install a policy');
  throwsSync(() => a.authority.installPolicy(signPolicy(basePolicy({}, a.clock.wall - 10_000), a.operator), 'operator'), 'older policy cannot be replayed');
  throwsSync(() => a.authority.installPolicy(signPolicy(basePolicy({}, a.clock.wall + 10), generateEd25519KeyPair()), 'operator'), 'policy from another key rejected');
  a.authority.installPolicy(signPolicy(basePolicy({ leaseTtlMs: 30_000 }, a.clock.wall + 10), a.operator), 'operator');
  assert(a.authority.effectivePolicy().leaseTtlMs === 30_000, 'operator can install a newer signed policy');
  assert(events.includes('issue:runner') && events.includes('renew:runner') && events.includes('stop:runner'), 'decisions are emitted for the audit trail');
}

// ---------------------------------------------------------------------------
// Lease guard
// ---------------------------------------------------------------------------

async function testGuard(): Promise<void> {
  section('Lease guard (dead-man switch)');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-perp-'));
  try {
    const { clock, authority } = setup();
    const transport = new LocalTransport(authority);
    const halts: string[] = [];
    const guard = new LeaseGuard({
      runId: 'run-g', authorityPublicKey: authority.publicKey, transport, projectRoot: root,
      halt: { trigger: (s: string) => { halts.push(s); } },
      now: () => clock.wall, monotonic: () => clock.mono, statusPollMs: 1_000,
    });
    throwsSync(() => guard.assertActive({ tool: 'shell_exec' }), 'no lease before start', (e) => e instanceof LeaseError);
    await guard.start();
    guard.stop();
    guard.assertActive({ tool: 'shell_exec' });
    pass('in-scope tool allowed');
    throwsSync(() => guard.assertActive({ tool: 'trade' }), 'tool outside scope refused');
    guard.assertActive({ tool: 'file_write', path: 'data/work/out.txt' });
    pass('in-scope path allowed');
    throwsSync(() => guard.assertActive({ tool: 'file_write', path: 'src/index.ts' }), 'path outside scope refused');
    throwsSync(() => guard.assertActive({ tool: 'file_write', path: 'data/work/../../secrets' }), 'traversal out of scope refused');
    throwsSync(() => guard.assertActive({ tool: 'file_write', path: 'data/workspace/x' }), 'sibling-prefix path refused');
    throwsSync(() => guard.assertActive({ tool: 'model_call', destination: 'payments' }), 'destination outside scope refused');

    clock.advance(45_000);
    await guard.tick();
    assert(guard.currentLease!.claims.sequence === 2 && halts.length === 0, 'guard renews before expiry');

    transport.down = true;
    clock.advance(45_000);
    await guard.tick();
    assert(halts.length === 0, 'unreachable authority tolerated while the lease is still valid');
    clock.advance(20_000);
    await guard.tick();
    assert(halts.length === 1 && !!guard.lossReason, 'dead-man: lease expires without renewal → halt');
    throwsSync(() => guard.assertActive({ tool: 'shell_exec' }), 'every action refused after the lease is lost');

    // Revocation reaches the guard on the next poll
    const s2 = setup();
    const t2 = new LocalTransport(s2.authority);
    const h2: string[] = [];
    const g2 = new LeaseGuard({ runId: 'run-r', authorityPublicKey: s2.authority.publicKey, transport: t2, halt: { trigger: (s: string) => { h2.push(s); } }, now: () => s2.clock.wall, monotonic: () => s2.clock.mono, statusPollMs: 1_000 });
    await g2.start();
    g2.stop();
    s2.authority.revoke({ runId: 'run-r' }, 'operator');
    s2.clock.advance(1_500);
    await g2.tick();
    assert(h2.length === 1, 'operator revoke halts the run on the next poll, without agent cooperation');

    // Monotonic clock guards against wall-clock rollback
    const s3 = setup();
    const g3 = new LeaseGuard({ runId: 'run-m', authorityPublicKey: s3.authority.publicKey, transport: new LocalTransport(s3.authority), now: () => s3.clock.wall, monotonic: () => s3.clock.mono });
    await g3.start();
    g3.stop();
    s3.clock.mono += 61_000;
    throwsSync(() => g3.assertActive({ tool: 'shell_exec' }), 'rolling back the wall clock does not extend the lease');

    // Forged or replayed leases from a compromised transport
    const s4 = setup();
    const h4: string[] = [];
    let forged: SignedLease | null = null;
    const evil: LeaseTransport = {
      issue: async (runId) => s4.authority.issue(runId),
      renew: async () => ({ granted: true, lease: forged! }),
      isActive: async () => true,
    };
    const g4 = new LeaseGuard({ runId: 'run-f', authorityPublicKey: s4.authority.publicKey, transport: evil, halt: { trigger: (s: string) => { h4.push(s); } }, now: () => s4.clock.wall, monotonic: () => s4.clock.mono });
    await g4.start();
    g4.stop();
    forged = signLease({ ...g4.currentLease!.claims, sequence: 2, expiresAt: s4.clock.wall + 3_600_000 }, generateEd25519KeyPair());
    s4.clock.advance(45_000);
    await g4.tick();
    assert(h4.length === 1, 'self-signed renewal rejected and the run halts');

    const s5 = setup();
    const h5: string[] = [];
    let replay: SignedLease | null = null;
    const replayer: LeaseTransport = {
      issue: async (runId) => s5.authority.issue(runId),
      renew: async () => ({ granted: true, lease: replay! }),
      isActive: async () => true,
    };
    const g5 = new LeaseGuard({ runId: 'run-s', authorityPublicKey: s5.authority.publicKey, transport: replayer, halt: { trigger: (s: string) => { h5.push(s); } }, now: () => s5.clock.wall, monotonic: () => s5.clock.mono });
    await g5.start();
    g5.stop();
    replay = g5.currentLease;
    s5.clock.advance(45_000);
    await g5.tick();
    assert(h5.length === 1, 'replayed (non-advancing) lease rejected and the run halts');

    const s6 = setup();
    s6.authority.pause('operator');
    const g6 = new LeaseGuard({ runId: 'run-z', authorityPublicKey: s6.authority.publicKey, transport: new LocalTransport(s6.authority) });
    await rejects(() => g6.start(), 'guard refuses to start without an issued lease', (e) => e instanceof LeaseError);

    // Integration hooks
    section('Integration hooks');
    const noLease = new LeaseGuard({ runId: 'run-none', authorityPublicKey: s6.authority.publicKey, transport: new LocalTransport(s6.authority) });
    const rt = new AgentRuntime({ policy: { basePath: root, allowedCommands: ['node *'] }, autoApproveAll: true, lease: noLease });
    await rejects(() => rt.exec('node --version', 'a'), 'AgentRuntime.exec refused without a lease', (e) => e instanceof LeaseError);
    const w = await rt.writeFile('data/work/x.txt', 'x', 'a');
    assert(!w.success, 'AgentRuntime.writeFile refused without a lease');
    const gw = new GovernedModelGateway({ caller: async (r) => ({ model: r.model, content: [], stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }), primaryModel: 'm', lease: noLease });
    await rejects(() => gw.send({ messages: [{ role: 'user', content: 'hi' }] }), 'GovernedModelGateway.send refused without a lease', (e) => e instanceof LeaseError);
    const bb = new LockedBlackboard(fs.mkdtempSync(path.join(os.tmpdir(), 'nai-perp-bb-')), { disableWal: true, lease: noLease });
    throwsSync(() => bb.propose('k', 1, 'a'), 'LockedBlackboard.propose refused without a lease', (e) => e instanceof LeaseError);

    const s7 = setup();
    const g7 = new LeaseGuard({ runId: 'run-ok', authorityPublicKey: s7.authority.publicKey, transport: new LocalTransport(s7.authority), projectRoot: root, now: () => s7.clock.wall, monotonic: () => s7.clock.mono });
    await g7.start();
    g7.stop();
    const rt2 = new AgentRuntime({ policy: { basePath: root, allowedCommands: ['node *'] }, autoApproveAll: true, lease: g7 });
    const out = await rt2.exec('node --version', 'a');
    assert(out.exitCode === 0, 'AgentRuntime.exec allowed with a valid lease');
    const bb2 = new LockedBlackboard(fs.mkdtempSync(path.join(os.tmpdir(), 'nai-perp-bb-')), { disableWal: true, lease: g7 });
    const id = bb2.propose('k', 1, 'a');
    bb2.validate(id, 'v');
    assert(bb2.commit(id).success, 'LockedBlackboard commit allowed with a valid lease');
    const plain = new LockedBlackboard(fs.mkdtempSync(path.join(os.tmpdir(), 'nai-perp-bb-')), { disableWal: true });
    const pid = plain.propose('k', 1, 'a');
    plain.validate(pid, 'v');
    assert(plain.commit(pid).success, 'no lease option: behaviour unchanged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// HTTP control API
// ---------------------------------------------------------------------------

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function testHttp(): Promise<void> {
  section('Authority HTTP control API');
  const { authority } = setup({}, true);
  const roles = { operator: secret(), sentry: secret(), runner: secret() };
  throwsSync(() => authority.httpHandler({ runner: roles.runner }), 'operator secret required');
  throwsSync(() => authority.httpHandler({ operator: 'short' }), 'short secrets rejected');
  throwsSync(() => authority.httpHandler({ operator: roles.operator, sentry: roles.operator }), 'role secrets must be distinct');
  throwsSync(() => authority.startServer(0, roles, { host: '0.0.0.0' }), 'non-loopback bind refused without allowRemote');

  const server = http.createServer(authority.httpHandler(roles));
  const base = await listen(server);
  const call = async (method: string, p: string, token?: string, body?: unknown) => {
    const res = await fetch(base + p, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  try {
    const pk = await call('GET', '/v1/public-key');
    assert(pk.status === 200 && typeof pk.json['publicKeyPem'] === 'string', 'public key endpoint is open');
    assert((await call('POST', '/v1/leases/issue', undefined, { runId: 'r' })).status === 401, 'unauthenticated issue refused');
    assert((await call('POST', '/v1/leases/issue', secret(), { runId: 'r' })).status === 401, 'wrong secret refused');

    const transport = new HttpLeaseTransport(base, roles.runner);
    const guard = new LeaseGuard({ runId: 'run-http', authorityPublicKey: authority.publicKey, transport });
    await guard.start();
    guard.stop();
    assert(guard.currentLease !== null, 'guard obtains a lease over HTTP');
    assert(await transport.isActive(guard.currentLease!.claims.leaseId), 'lease status visible over HTTP');

    assert((await call('POST', '/v1/control/revoke', roles.runner, { runId: 'run-http' })).status === 403, 'runner cannot revoke over HTTP');
    assert((await call('POST', '/v1/control/resume', roles.sentry)).status === 403, 'sentry cannot resume over HTTP');
    assert((await call('POST', '/v1/control/tighten', roles.sentry, { leaseTtlMs: 999_999_999 })).status === 400, 'loosening tighten rejected over HTTP');
    assert((await call('POST', '/v1/control/revoke', roles.sentry, { runId: 'run-http' })).status === 200, 'sentry can revoke over HTTP');
    assert(!(await transport.isActive(guard.currentLease!.claims.leaseId)), 'revocation visible to the runner');
    assert((await call('GET', '/v1/runs', roles.runner)).status === 403, 'runner cannot list every run');

    for (let i = 0; i < 10; i++) await call('POST', '/v1/control/pause', secret());
    assert((await call('POST', '/v1/control/pause', roles.operator)).status === 429, 'brute force rate-limited');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

// ---------------------------------------------------------------------------
// Egress proxy
// ---------------------------------------------------------------------------

async function testProxy(): Promise<void> {
  section('Egress proxy');
  const apiKey = `sk-${randomBytes(24).toString('hex')}`;
  const upstream = http.createServer((req, res) => {
    const auth = req.headers['authorization'] ?? '';
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'session=abc', 'X-Echo-Auth': String(auth) });
    res.end(JSON.stringify({ path: req.url, method: req.method, sawAuth: auth, sawLease: req.headers['x-network-ai-lease'] ?? null, sawCookie: req.headers['cookie'] ?? null }));
  });
  const upstreamBase = await listen(upstream);

  const { clock, authority } = setup();
  const events: string[] = [];
  const proxy = new EgressProxy({
    authorityPublicKey: authority.publicKey,
    isLeaseActive: async (id) => authority.isLeaseActive(id),
    routes: [
      { name: 'llm', upstream: `${upstreamBase}/api`, credential: { header: 'Authorization', prefix: 'Bearer ', value: () => apiKey }, pathPrefixes: ['/api/v1'] },
      { name: 'payments', upstream: upstreamBase },
    ],
    now: () => clock.wall,
    ratePerMinute: 5,
    statusCacheMs: 0,
    onEvent: (e) => { events.push(e.outcome); },
  });
  const server = http.createServer(proxy.httpHandler());
  const base = await listen(server);
  const lease = authority.issue('run-px').lease!;
  const req = (p: string, l?: SignedLease, init: RequestInit = {}) =>
    fetch(base + p, { ...init, headers: { ...(l ? { 'X-Network-AI-Lease': encodeLeaseHeader(l) } : {}), Cookie: 'agent=1', Authorization: 'Bearer agent-supplied', ...(init.headers as Record<string, string> | undefined) } });
  try {
    const ok = await req('/llm/v1/chat?x=1', lease, { method: 'POST', body: '{}' });
    const body = (await ok.json()) as Record<string, unknown>;
    const text = JSON.stringify(body) + JSON.stringify([...ok.headers]);
    assert(ok.status === 200 && body['path'] === '/api/v1/chat?x=1', 'request forwarded to the route upstream');
    assert(body['sawAuth'] === 'Bearer [REDACTED]' && !text.includes(apiKey), 'credential injected upstream and scrubbed from the response');
    assert(body['sawLease'] === null && body['sawCookie'] === null, 'lease and agent cookies are not forwarded upstream');
    assert(!ok.headers.has('set-cookie'), 'Set-Cookie dropped from the response');

    assert((await req('/llm/v1/chat')).status === 401, 'request without a lease refused');
    assert((await req('/payments/charge', lease)).status === 403, 'route outside the lease scope refused');
    assert((await req('/nowhere/x', lease)).status === 404, 'unknown route refused');
    assert((await req('/llm/other', lease)).status === 403, 'upstream path outside the allowed prefixes refused');
    assert((await req('/llm/v1/%2e%2e/admin', lease)).status === 400 || (await req('/llm/v1/..%2Fadmin', lease)).status === 400, 'encoded traversal refused');
    const forged = signLease({ ...lease.claims, scope: { ...lease.claims.scope, destinations: ['llm', 'payments'] } }, generateEd25519KeyPair());
    assert((await req('/payments/charge', forged)).status === 403, 'self-widened lease refused');
    assert((await req('/llm/v1/chat', lease, { method: 'DELETE' })).status === 405, 'disallowed method refused');
    assert((await req('/llm/v1/chat', lease)).status === 429, 'per-lease rate limit enforced');

    const lease2 = (() => { authority.revoke({ runId: 'run-px' }, 'operator'); return authority.issue('run-py').lease!; })();
    assert((await req('/llm/v1/chat', lease)).status === 403, 'revoked lease cut off from the network');
    clock.advance(61_000);
    assert((await req('/llm/v1/chat', lease2)).status === 403, 'expired lease cut off from the network');
    assert(events.includes('forwarded') && events.includes('denied'), 'proxy decisions are emitted for the audit trail');
    throwsSync(() => proxy.startServer(0, { host: '0.0.0.0' }), 'non-loopback proxy bind refused without allowRemote');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
}

// ---------------------------------------------------------------------------
// Key / policy / route files and the CLI
// ---------------------------------------------------------------------------

function testFiles(): void {
  section('Key, policy, and route files');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-perp-files-'));
  try {
    const op = writeKeyPair(dir, 'operator');
    assert(fs.existsSync(op.privateKeyPath) && fs.existsSync(op.publicKeyPath), 'key pair written');
    if (process.platform !== 'win32') assert((fs.statSync(op.privateKeyPath).mode & 0o777) === 0o600, 'private key is 0600');
    throwsSync(() => writeKeyPair(dir, 'operator'), 'existing key files are never overwritten');
    throwsSync(() => writeKeyPair(dir, '../escape'), 'key name with path separators rejected');
    const pair = readKeyPair(op.privateKeyPath);
    assert(pair.keyId === op.keyId && keyIdOf(readPublicKey(op.publicKeyPath)) === op.keyId, 'keys read back with the same key id');
    const signed = signPolicy(basePolicy(), pair);
    assert(verifySignedPolicy(signed, readPublicKey(op.publicKeyPath)) === null, 'policy signed with a key from disk verifies');
    throwsSync(() => readPublicKey(op.privateKeyPath.replace(/\.key$/, '.missing')), 'missing key file rejected');

    const routesFile = path.join(dir, 'routes.json');
    const env = { NAI_TEST_UPSTREAM_KEY: 'k-123' } as NodeJS.ProcessEnv;
    fs.writeFileSync(routesFile, JSON.stringify([{ name: 'llm', upstream: 'https://api.example.com', credential: { header: 'Authorization', prefix: 'Bearer ', env: 'NAI_TEST_UPSTREAM_KEY' } }]));
    const routes = loadRoutes(routesFile, env);
    assert(routes.length === 1 && routes[0].credential!.value() === 'k-123', 'route credential resolved from the environment');
    fs.writeFileSync(routesFile, JSON.stringify([{ name: 'llm', upstream: 'https://api.example.com', credential: { header: 'Authorization', value: 'sk-inline' } }]));
    throwsSync(() => loadRoutes(routesFile, env), 'inline credential values in route files rejected');
    fs.writeFileSync(routesFile, JSON.stringify([{ name: 'llm', upstream: 'https://api.example.com', credential: { header: 'Authorization', env: 'NAI_TEST_UNSET_KEY' } }]));
    throwsSync(() => loadRoutes(routesFile, env), 'unset credential variable rejected at startup');
    fs.writeFileSync(routesFile, '{}');
    throwsSync(() => loadRoutes(routesFile, env), 'routes file must be an array');

    const secrets = readRoleSecrets({ [ROLE_SECRET_ENV.operator]: 'o'.repeat(40), [ROLE_SECRET_ENV.runner]: 'r'.repeat(40) } as NodeJS.ProcessEnv);
    assert(secrets.operator === 'o'.repeat(40) && secrets.runner === 'r'.repeat(40) && secrets.sentry === undefined, 'role secrets read from the environment; unset roles absent');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const CLI = path.join(__dirname, 'bin', 'cli.ts');

function cliEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true', NETWORK_AI_MINIMAL: '1', ...extra };
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['-r', 'ts-node/register', CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => p.kill(), 60_000);
    p.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    p.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
    p.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

async function testCli(): Promise<void> {
  section('CLI: out-of-process authority and operator controls');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-perp-cli-'));
  const roles = { operator: secret(), sentry: secret(), runner: secret() };
  const env = cliEnv({
    [ROLE_SECRET_ENV.operator]: roles.operator,
    [ROLE_SECRET_ENV.sentry]: roles.sentry,
    [ROLE_SECRET_ENV.runner]: roles.runner,
  });
  let child: ChildProcess | null = null;
  let childErr = '';
  try {
    const keys = path.join(dir, 'keys');
    assert((await runCli(['--data', dir, 'perpetual', 'keygen', 'operator', '--out', keys], env)).status === 0, 'keygen operator');
    assert((await runCli(['--data', dir, 'perpetual', 'keygen', 'authority', '--out', keys], env)).status === 0, 'keygen authority');
    assert((await runCli(['perpetual', 'keygen', 'operator', '--out', keys], env)).status !== 0, 'keygen refuses to overwrite');

    const policyFile = path.join(dir, 'policy.json');
    const { issuedAt: _omit, ...unsigned } = basePolicy();
    fs.writeFileSync(policyFile, JSON.stringify(unsigned));
    const signedFile = path.join(dir, 'policy.signed.json');
    const sp = await runCli(['perpetual', 'sign-policy', policyFile, '--key', path.join(keys, 'operator.key'), '--out', signedFile], env);
    assert(sp.status === 0 && fs.existsSync(signedFile), 'sign-policy writes a signed policy', sp.stderr);
    const signed = JSON.parse(fs.readFileSync(signedFile, 'utf8')) as SignedPolicy;
    assert(verifySignedPolicy(signed, readPublicKey(path.join(keys, 'operator.pub'))) === null && signed.policy.issuedAt > 0, 'signed policy verifies and gets issuedAt');
    const wrongKey = await runCli(['perpetual', 'sign-policy', policyFile, '--key', path.join(keys, 'operator.pub')], env);
    assert(wrongKey.status !== 0, 'sign-policy rejects a public key as the signing key');

    child = spawn(process.execPath, ['-r', 'ts-node/register', CLI, '--data', dir, 'perpetual', 'authority',
      '--operator-pub', path.join(keys, 'operator.pub'), '--authority-key', path.join(keys, 'authority.key'),
      '--policy', signedFile, '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const url = await new Promise<string>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`authority did not start: ${childErr}`)), 60_000);
      child!.stdout!.on('data', (d: Buffer) => {
        out += d.toString();
        const m = /listening on (http:\/\/[^\s]+)/.exec(out);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
      child!.stderr!.on('data', (d: Buffer) => { childErr += d.toString(); });
      child!.on('exit', (code) => { clearTimeout(timer); childErr += `\n[exit ${code}]`; reject(new Error(`authority exited ${code}: ${childErr}`)); });
    });
    pass('authority runs as a separate process on loopback');

    const authorityPub = (await (await fetch(`${url}/v1/public-key`)).json()) as { publicKeyPem: string };
    const guard = new LeaseGuard({ runId: 'run-cli', authorityPublicKey: createPublicKey(authorityPub.publicKeyPem), transport: new HttpLeaseTransport(url, roles.runner) });
    await guard.start();
    guard.stop();
    assert(guard.currentLease !== null, 'runner obtains a lease from the CLI authority');

    const st = await runCli(['perpetual', 'status', '--authority-url', url], env);
    assert(st.status === 0 && st.stdout.includes('run-cli'), 'operator status lists the run', st.stderr);
    const noSecret = await runCli(['perpetual', 'pause', '--authority-url', url], cliEnv({ [ROLE_SECRET_ENV.operator]: '' }));
    assert(noSecret.status !== 0, 'operator commands require the operator secret');
    const asRunner = await runCli(['perpetual', 'resume', '--authority-url', url], cliEnv({ [ROLE_SECRET_ENV.operator]: roles.runner }));
    assert(asRunner.status !== 0, 'runner secret cannot drive operator commands');

    assert((await runCli(['perpetual', 'pause', '--authority-url', url], env)).status === 0, 'operator pause via CLI');
    const transport = new HttpLeaseTransport(url, roles.runner);
    assert(!(await transport.isActive(guard.currentLease!.claims.leaseId)), 'pause from the CLI invalidates the running lease');
    assert((await runCli(['perpetual', 'resume', '--authority-url', url], env)).status === 0, 'operator resume via CLI');
    const revoke = await runCli(['perpetual', 'revoke', 'run-cli', '--authority-url', url], env);
    assert(revoke.status === 0, 'operator revoke via CLI', revoke.stderr);
    assert(!(await transport.issue('run-cli')).granted, 'revoked run cannot obtain a new lease');

    const audit = fs.readFileSync(path.join(dir, 'perpetual_audit.jsonl'), 'utf8');
    assert(audit.includes('"action":"pause"') && audit.includes('"action":"revoke"') && !audit.includes(roles.operator), 'authority decisions audited without secrets');

    const contentFile = path.join(dir, 'new-config.ts');
    fs.writeFileSync(contentFile, 'export const mode = "enforce";\n');
    const approvalFile = path.join(dir, 'approval.json');
    const sg = await runCli(['perpetual', 'sign-guarded', '--key', path.join(keys, 'operator.key'), '--kind', 'path', '--name', 'lib/asi/config.ts', '--content-file', contentFile, '--out', approvalFile], env);
    const guardedPaths = new GuardedPaths({ operatorPublicKey: readPublicKey(path.join(keys, 'operator.pub')) });
    guardedPaths.approve(JSON.parse(fs.readFileSync(approvalFile, 'utf8')) as SignedGuardedApproval);
    assert(sg.status === 0 && guardedPaths.check({ kind: 'path', name: 'lib/asi/config.ts' }, fs.readFileSync(contentFile, 'utf8')) === null, 'sign-guarded produces an approval the guard accepts', sg.stderr);
    const sgBad = await runCli(['perpetual', 'sign-guarded', '--key', path.join(keys, 'operator.key'), '--kind', 'path', '--name', 'x', '--delete', '--content-file', contentFile], env);
    assert(sgBad.status !== 0, 'sign-guarded needs exactly one content source');

    const budgetFile = path.join(dir, 'budget.json');
    fs.writeFileSync(budgetFile, JSON.stringify({ v: 'nai-budget-v1', policyId: 'b1', ceilingUsd: 50, ceilingTokens: 1000, sources: [{ id: 'llm', kind: 'model-provider' }] }));
    const sb = await runCli(['perpetual', 'sign-budget', budgetFile, '--key', path.join(keys, 'operator.key'), '--out', path.join(dir, 'budget.signed.json')], env);
    const signedBudget = JSON.parse(fs.readFileSync(path.join(dir, 'budget.signed.json'), 'utf8')) as SignedBudgetPolicy;
    const bal = new BudgetBalancer({ operatorPublicKey: readPublicKey(path.join(keys, 'operator.pub')), policy: signedBudget });
    assert(sb.status === 0 && bal.ceilingUsd === 50, 'sign-budget produces a policy the balancer accepts', sb.stderr);

    const snapEnv = cliEnv({ NETWORK_AI_SNAPSHOT_SECRET: secret() });
    const board = new LockedBlackboard(dir, { disableWal: true });
    board.write('task:x', 'good', 'agent');
    const snapOut = await runCli(['--data', dir, '--json', 'perpetual', 'snapshot', '--label', 'cli'], snapEnv);
    assert(snapOut.status === 0 && /snap_[0-9a-f]{24}/.test(snapOut.stdout), 'snapshot via CLI', snapOut.stderr);
    new LockedBlackboard(dir, { disableWal: true }).write('task:x', 'bad', 'agent');
    const rb = await runCli(['--data', dir, 'perpetual', 'rollback'], snapEnv);
    assert(rb.status === 0 && new LockedBlackboard(dir, { disableWal: true }).read('task:x')?.value === 'good', 'rollback via CLI restores the verified snapshot', rb.stderr);
    const rbWrong = await runCli(['--data', dir, 'perpetual', 'rollback'], cliEnv({ NETWORK_AI_SNAPSHOT_SECRET: secret() }));
    assert(rbWrong.status !== 0, 'rollback refuses snapshots signed with a different secret');
  } finally {
    if (childErr) process.stdout.write(`  (authority stderr: ${childErr.trim().slice(0, 2000)})\n`);
    if (child && child.exitCode === null) child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  process.stdout.write('PERPETUAL RUNTIME (PHASE 1) TESTS\n');
  testSigning();
  testAuthority();
  await testGuard();
  await testHttp();
  await testProxy();
  testFiles();
  await testCli();

  process.stdout.write(`\n${passed + failed} checks — ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.stdout.write(failures.map((f) => `  FAIL: ${f}`).join('\n') + '\n');
    process.exit(1);
  }
  process.stdout.write('ALL PERPETUAL RUNTIME TESTS PASSED ✓\n');
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
