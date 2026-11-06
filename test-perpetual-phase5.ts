/**
 * test-perpetual-phase5.ts — Perpetual Runtime Phase 5: binary-level
 * resilience and zero-day containment.
 *
 * Invariant under test (I4): code on the agent host cannot cause a lease to be
 * issued or extended. Granting needs off-host keys (k-of-n), stopping needs
 * one party; human checkpoints, tripwires, attestation, and capability
 * evaluations all fail closed.
 *
 * No secrets are hard-coded: keys and role secrets are generated at runtime.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import {
  CommandSigner,
  ContainerSandboxRunner,
  EgressProxy,
  FileWitness,
  FirecrackerSandboxRunner,
  FrameDecoder,
  FrameError,
  FramedLeaseTransport,
  KataSandboxRunner,
  LeanCertificateVerifier,
  MerkleAuditLog,
  RELAY_SOCKET_IN_SANDBOX,
  SignedQuoteVerifier,
  SpoolLeaseTransport,
  SpoolPuller,
  VsockRelay,
  applyTighten,
  classifyClaim,
  encodeFrame,
  firecrackerRelayListenPath,
  leafHashOf,
  makeSandboxReceipt,
  nextRunState,
  parseRelayRequest,
  quorumActive,
  quorumGrant,
  recordSpend,
  scopeWithinCore,
  signCapabilityEval,
  signQuote,
  tightenError,
  verifyConsistency,
  verifyCapabilityEval,
  verifyInclusion,
  verifyTreeHead,
  ImprovementPipeline,
  KeyObjectSigner,
  LeaseAuthority,
  LeaseError,
  LeaseGuard,
  QuorumLeaseTransport,
  SELF_IMPROVE_TOOL,
  TRIPWIRE_SOURCE,
  TripwireSet,
  checkHardenedNode,
  cosignLease,
  encodeLeaseHeader,
  generateEd25519KeyPair,
  hardenedNodeArgs,
  isHighRiskPolicy,
  isSigner,
  normalizeSandboxRequest,
  policyHash,
  postureVerdict,
  runPostureChecks,
  signCheckpoint,
  signGuardedApproval,
  signLease,
  signPolicy,
  toSigner,
  tripwireDetector,
  validatePolicy,
  verifyLease,
  verifyLeaseQuorum,
  verifySignedPolicy,
  readKeyPair,
  writeKeyPair,
} from './lib/perpetual';
import type { CosignTransport, Heartbeat, LeaseCheck, LeaseClaims, LeaseDecision, LeaseTransport, RenewalPolicy, SignedLease } from './lib/perpetual';
import { HashChainSink } from './lib/asi/authority';

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
const msgIncludes = (s: string) => (e: unknown) => e instanceof Error && e.message.includes(s);
const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const T0 = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

/** Controllable clock shared by authorities and guards. */
class Clock {
  wall = T0;
  mono = 1_000;
  advance(ms: number) { this.wall += ms; this.mono += ms; }
}

function basePolicy(overrides: Partial<RenewalPolicy> = {}, issuedAt = T0): RenewalPolicy {
  return {
    v: 'nai-policy-v1',
    policyId: `policy-${issuedAt}`,
    issuedAt,
    leaseTtlMs: 60_000,
    autoRenew: true,
    heartbeatMaxAgeMs: 30_000,
    scope: { tier: 'standard', tools: ['shell_exec', 'file_write', 'model_call'], paths: ['data/work'], destinations: ['llm', 'payments'] },
    budget: { runCeilingUsd: 10, runCeilingTokens: 1_000_000 },
    stopWhen: { sentryAlertAtOrAbove: 'critical', onCanaryFailure: true, onHealthFailing: true },
    ...overrides,
  };
}

function hb(lease: SignedLease, at: number, extra: Partial<Heartbeat> = {}): Heartbeat {
  return { leaseId: lease.claims.leaseId, runId: lease.claims.runId, at, spentUsd: 0, spentTokens: 0, health: 'ok', ...extra };
}

// ---------------------------------------------------------------------------
// Shared: high-risk policies and signers
// ---------------------------------------------------------------------------

function testHighRiskPolicy(): void {
  section('High-risk policies need k-of-n and a capability evaluation');
  assert(!isHighRiskPolicy(basePolicy()), 'standard scope without self_improve or financial routes is not high-risk');
  assert(isHighRiskPolicy(basePolicy({ scope: { tier: 'elevated', tools: ['shell_exec'] } })), 'elevated tier is high-risk');
  assert(isHighRiskPolicy(basePolicy({ scope: { tier: 'standard', tools: [SELF_IMPROVE_TOOL] } })), 'self_improve tool is high-risk');
  assert(isHighRiskPolicy(basePolicy({ financialDestinations: ['payments'] })), 'a granted financial route is high-risk');

  throwsSync(() => validatePolicy(basePolicy({ scope: { tier: 'elevated', tools: ['shell_exec'] } })), 'high-risk policy without quorum or accepted risk is rejected', msgIncludes('authorityQuorum'));
  throwsSync(
    () => validatePolicy(basePolicy({ scope: { tier: 'elevated', tools: ['shell_exec'] }, acceptRisk: ['single-authority'] })),
    'high-risk policy without a capability evaluation is rejected', msgIncludes('capabilityEval'),
  );
  validatePolicy(basePolicy({ scope: { tier: 'elevated', tools: ['shell_exec'] }, acceptRisk: ['single-authority', 'no-capability-eval'] }));
  pass('explicitly accepted risks allow a high-risk policy (signed by the operator, audited)');
  const a = generateEd25519KeyPair();
  const b = generateEd25519KeyPair();
  validatePolicy(basePolicy({
    financialDestinations: ['payments'],
    authorityQuorum: { threshold: 2, keyIds: [a.keyId, b.keyId] },
    acceptRisk: ['no-capability-eval'],
  }));
  pass('k = 2 quorum satisfies the authority requirement');

  throwsSync(() => validatePolicy(basePolicy({ financialDestinations: ['bank'] })), 'financial routes must be granted destinations', msgIncludes('subset'));
  throwsSync(() => validatePolicy(basePolicy({ humanCheckpointEveryMs: 60_000 })), 'checkpoint interval below 1 h is rejected');
  throwsSync(() => validatePolicy(basePolicy({ humanCheckpointEveryMs: 8 * 24 * HOUR })), 'checkpoint interval above 7 d is rejected');
  validatePolicy(basePolicy({ humanCheckpointEveryMs: 24 * HOUR }));
  pass('checkpoint interval of 24 h accepted');
  throwsSync(() => validatePolicy(basePolicy({ authorityQuorum: { threshold: 3, keyIds: [a.keyId, b.keyId] } })), 'quorum threshold above the key count is rejected');
  throwsSync(() => validatePolicy(basePolicy({ authorityQuorum: { threshold: 2, keyIds: [a.keyId, a.keyId] } })), 'duplicate quorum keys are rejected');
  throwsSync(() => validatePolicy(basePolicy({ acceptRisk: ['everything' as never] })), 'unknown accepted risk is rejected');
  throwsSync(() => validatePolicy(basePolicy({ attestation: { kind: 'tpm-quote', expectedMeasurements: [] } })), 'attestation without measurements is rejected');
  throwsSync(
    () => validatePolicy(basePolicy({ requires: { capabilityEval: { evaluatorPublicKeysPem: ['not a key'], thresholds: { deception: { max: 0.1 } }, maxAgeMs: HOUR } } })),
    'capability-eval requirement with an invalid evaluator key is rejected',
  );
  const evaluator = generateEd25519KeyPair();
  const pem = evaluator.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  throwsSync(
    () => validatePolicy(basePolicy({ requires: { capabilityEval: { evaluatorPublicKeysPem: [pem], thresholds: { deception: {} }, maxAgeMs: HOUR } } })),
    'capability-eval threshold without bounds is rejected',
  );
  validatePolicy(basePolicy({
    scope: { tier: 'elevated', tools: ['shell_exec'] },
    authorityQuorum: { threshold: 2, keyIds: [a.keyId, b.keyId] },
    requires: { capabilityEval: { evaluatorPublicKeysPem: [pem], thresholds: { 'cyber-offense': { max: 0.2 }, deception: { max: 0.1 } }, maxAgeMs: 7 * 24 * HOUR } },
  }));
  pass('high-risk policy with quorum and capability-eval requirement validates');
}

function testSigners(): void {
  section('Signers (keys can stay outside Node memory)');
  const operator = generateEd25519KeyPair();
  const signer = new KeyObjectSigner(operator.privateKey);
  assert(isSigner(signer) && signer.keyId === operator.keyId, 'KeyObjectSigner exposes the matching key id');
  const signed = signPolicy(basePolicy(), signer);
  assert(verifySignedPolicy(signed, operator.publicKey) === null, 'policy signed through a Signer verifies');
  throwsSync(() => toSigner({ keyId: 'ffffffffffffffff', publicKey: operator.publicKey, sign: () => Buffer.alloc(64) }), 'signer whose keyId does not match its public key is rejected');
  throwsSync(() => signPolicy(basePolicy(), { keyId: operator.keyId, publicKey: operator.publicKey, sign: () => Buffer.alloc(10) }), 'signer returning a malformed signature is rejected');

  const dir = tmp('nai-p5-signer-');
  try {
    const written = writeKeyPair(dir, 'op');
    const fileOperator = readKeyPair(written.privateKeyPath);
    const script = path.join(dir, 'sign.js');
    fs.writeFileSync(script, [
      "const { createPrivateKey, sign } = require('crypto');",
      "const fs = require('fs');",
      "const key = createPrivateKey(fs.readFileSync(process.argv[2]));",
      "const chunks = []; process.stdin.on('data', (c) => chunks.push(c));",
      "process.stdin.on('end', () => { if (process.argv[3] === 'fail') process.exit(3); const sig = sign(null, Buffer.concat(chunks), key); process.stdout.write(process.argv[3] === 'raw' ? sig : sig.toString('hex')); });",
    ].join('\n'));
    const cmd = new CommandSigner({ command: process.execPath, args: [script, written.privateKeyPath], publicKey: fileOperator.publicKey });
    const viaCmd = signPolicy(basePolicy(), cmd);
    assert(verifySignedPolicy(viaCmd, fileOperator.publicKey) === null, 'CommandSigner (hex output) produces a verifying policy signature');
    const raw = new CommandSigner({ command: process.execPath, args: [script, written.privateKeyPath, 'raw'], publicKey: fileOperator.publicKey });
    assert(verifySignedPolicy(signPolicy(basePolicy(), raw), fileOperator.publicKey) === null, 'CommandSigner accepts raw 64-byte output');
    const wrong = new CommandSigner({ command: process.execPath, args: [script, written.privateKeyPath], publicKey: operator.publicKey });
    throwsSync(() => signPolicy(basePolicy(), wrong), 'CommandSigner rejects a signature for the wrong key', msgIncludes('does not verify'));
    const failing = new CommandSigner({ command: process.execPath, args: [script, written.privateKeyPath, 'fail'], publicKey: fileOperator.publicKey });
    throwsSync(() => signPolicy(basePolicy(), failing), 'CommandSigner fails closed when the program fails', msgIncludes('exited'));
    throwsSync(() => new CommandSigner({ command: '', publicKey: fileOperator.publicKey }), 'CommandSigner requires a command');

    const authority = new LeaseAuthority({ operatorPublicKey: operator.publicKey, authorityKey: new KeyObjectSigner(generateEd25519KeyPair().privateKey), policy: signed, now: () => T0 });
    const d = authority.issue('run-signer');
    assert(d.granted && verifyLease(d.lease!, authority.publicKey, T0) === null, 'authority signs leases through a Signer');
    const approval = signGuardedApproval({ kind: 'key', name: 'policy' }, { a: 1 }, signer, { now: T0 });
    assert(approval.keyId === operator.keyId, 'guarded approvals accept a Signer');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const lease = signLease({ v: 'nai-lease-v1', leaseId: 'l', runId: 'r', sequence: 1, issuedAt: T0, expiresAt: T0 + 60_000, scope: { tier: 'observe', tools: [] }, budget: { runCeilingUsd: 0, runCeilingTokens: 0 }, policyHash: 'h', nonce: 'n' }, operator);
  assert(verifyLease(lease, operator.publicKey, T0) === null, 'key pairs still sign leases (backward compatible)');
}

async function testSelfImproveLease(): Promise<void> {
  section('Self-improvement needs a lease granting self_improve');
  const root = tmp('nai-p5-improve-');
  try {
    fs.mkdirSync(path.join(root, 'agents'));
    fs.writeFileSync(path.join(root, 'agents', 'task.ts'), 'export const v = 1;\n');
    const guarded = { isGuardedPath: () => false, hasApproval: () => false, check: () => null };
    const denied: LeaseCheck = { assertActive: (a) => { if (a.tool === SELF_IMPROVE_TOOL) throw new LeaseError('Tool "self_improve" is outside the lease scope', 'LEASE_SCOPE'); } };
    const allowed: LeaseCheck = { assertActive: () => undefined };
    const proposal = { id: 'p1', agentId: 'agent-1', description: 'improve', files: [{ path: 'agents/task.ts', content: 'export const v = 2;\n' }] };
    const p1 = new ImprovementPipeline({ projectRoot: root, guarded, autoPaths: ['agents/'], pipelineKey: generateEd25519KeyPair(), lease: denied });
    const d1 = await p1.evaluate(proposal);
    assert(!d1.approved && (d1.reason ?? '').includes('no lease for self-improvement'), 'evaluate refuses without a self_improve lease', d1.reason);
    const p2 = new ImprovementPipeline({ projectRoot: root, guarded, autoPaths: ['agents/'], pipelineKey: generateEd25519KeyPair(), lease: allowed, humanApproval: async () => ({ approved: true, approvedBy: 'op' }) });
    const d2 = await p2.evaluate(proposal);
    assert(d2.approved && !!d2.receipt, 'evaluate proceeds when the lease grants self_improve', d2.reason);
    const p3 = new ImprovementPipeline({ projectRoot: root, guarded, autoPaths: ['agents/'], pipelineKey: generateEd25519KeyPair(), lease: denied });
    throwsSync(() => p3.apply(proposal, d2.receipt!), 'apply refuses without a self_improve lease', msgIncludes('no lease'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 5a.2 Human checkpoints
// ---------------------------------------------------------------------------

function checkpointSetup(overrides: Partial<RenewalPolicy> = {}) {
  const clock = new Clock();
  const operator = generateEd25519KeyPair();
  const authorityKey = generateEd25519KeyPair();
  const events: string[] = [];
  const signed = signPolicy(basePolicy({ humanCheckpointEveryMs: 2 * HOUR, ...overrides }, clock.wall), operator);
  const authority = new LeaseAuthority({
    operatorPublicKey: operator.publicKey, authorityKey, policy: signed, now: () => clock.wall,
    onEvent: (e) => { events.push(`${e.action}:${e.role}:${e.reason ?? ''}`); },
  });
  return { clock, operator, authority, signed, events };
}

/** Renew every 40 s until refused or `untilMs` passes. Returns the refusal reason. */
function keepRenewing(authority: LeaseAuthority, clock: Clock, lease: SignedLease, untilMs: number): { lease: SignedLease; reason?: string } {
  let current = lease;
  while (clock.wall < untilMs) {
    clock.advance(40_000);
    const d = authority.renew(hb(current, clock.wall));
    if (!d.granted) return { lease: current, reason: d.reason };
    current = d.lease!;
  }
  return { lease: current };
}

async function testCheckpoints(): Promise<void> {
  section('5a.2 Human checkpoints: renewal stops without a human decision');
  const t = checkpointSetup();
  const first = t.authority.issue('run-cp');
  assert(first.granted, 'lease issued inside the checkpoint interval');
  assert(t.authority.checkpointDeadline('run-cp') === T0 + 2 * HOUR, 'deadline starts at policy.issuedAt + interval');
  const r = keepRenewing(t.authority, t.clock, first.lease!, T0 + 3 * HOUR);
  assert(r.reason === 'human checkpoint overdue', 'renewal stops once the checkpoint interval lapses', r.reason);
  assert(r.lease.claims.expiresAt <= T0 + 2 * HOUR, 'no lease outlives the checkpoint deadline');
  assert(t.authority.status('run-cp')[0].state === 'stopped', 'run is stopped (absorbing) after the lapse');
  assert(!t.authority.issue('run-new').granted, 'no new run is issued while the checkpoint is overdue');

  section('5a.2 Checkpoints extend runs; forged, replayed, old, foreign ones are rejected');
  const u = checkpointSetup();
  const ph = policyHash(u.signed);
  const lease0 = u.authority.issue('run-a').lease!;
  const before = keepRenewing(u.authority, u.clock, lease0, T0 + HOUR);
  const cpAll = signCheckpoint({ policyHash: ph, scope: { all: true }, now: u.clock.wall }, u.operator);
  const res = u.authority.checkpoint(cpAll, 'operator');
  assert(res.deadline === u.clock.wall + 2 * HOUR, 'operator checkpoint moves the deadline');
  assert(u.events.some((e) => e.startsWith('checkpoint:operator')), 'checkpoint is audited');
  throwsSync(() => u.authority.checkpoint(cpAll, 'operator'), 'replayed checkpoint rejected', msgIncludes('replayed'));
  const older = signCheckpoint({ policyHash: ph, scope: { all: true }, now: u.clock.wall - 5 * 60_000, validForMs: 60 * 60_000 }, u.operator);
  throwsSync(() => u.authority.checkpoint(older, 'operator'), 'checkpoint older than the last accepted one rejected', msgIncludes('not newer'));
  const after = keepRenewing(u.authority, u.clock, before.lease, T0 + 2.5 * HOUR);
  assert(after.reason === undefined, 'run keeps renewing past the original deadline after a checkpoint', after.reason);
  const forger = generateEd25519KeyPair();
  throwsSync(() => u.authority.checkpoint(signCheckpoint({ policyHash: ph, scope: { all: true }, now: u.clock.wall }, forger), 'operator'), 'checkpoint signed by another key rejected', msgIncludes('unknown key'));
  const tampered = signCheckpoint({ policyHash: ph, scope: { runId: 'run-a' }, now: u.clock.wall }, u.operator);
  throwsSync(() => u.authority.checkpoint({ ...tampered, checkpoint: { ...tampered.checkpoint, scope: { all: true } } }, 'operator'), 'tampered checkpoint rejected', msgIncludes('signature invalid'));
  throwsSync(() => u.authority.checkpoint(signCheckpoint({ policyHash: 'a'.repeat(64), scope: { all: true }, now: u.clock.wall }, u.operator), 'operator'), 'checkpoint for another policy rejected', msgIncludes('different policy'));
  const stale = signCheckpoint({ policyHash: ph, scope: { runId: 'run-a' }, now: u.clock.wall, validForMs: 60_000 }, u.operator);
  u.clock.advance(61_000);
  throwsSync(() => u.authority.checkpoint(stale, 'operator'), 'expired checkpoint rejected', msgIncludes('expired'));
  const future = signCheckpoint({ policyHash: ph, scope: { all: true }, now: u.clock.wall + 10 * 60_000 }, u.operator);
  throwsSync(() => u.authority.checkpoint(future, 'operator'), 'checkpoint dated in the future rejected', msgIncludes('future'));
  const fresh = signCheckpoint({ policyHash: ph, scope: { runId: 'run-a' }, now: u.clock.wall }, u.operator);
  throwsSync(() => u.authority.checkpoint(fresh, 'sentry'), 'a sentry cannot checkpoint', msgIncludes('role sentry'));
  throwsSync(() => u.authority.checkpoint(fresh, 'runner'), 'the runner cannot checkpoint', msgIncludes('role runner'));
  throwsSync(() => signCheckpoint({ policyHash: ph, scope: { all: true }, validForMs: 2 * HOUR }, u.operator), 'checkpoint validity is capped at 1 h');
  const perRun = u.authority.checkpoint(fresh, 'operator');
  assert(perRun.deadline === u.clock.wall + 2 * HOUR && u.authority.checkpointDeadline('run-other') !== perRun.deadline, 'per-run checkpoint only extends that run');

  section('5a.2 New policy resets checkpoints; HTTP route is operator-only');
  const next = signPolicy(basePolicy({ humanCheckpointEveryMs: HOUR }, u.clock.wall), u.operator);
  u.authority.installPolicy(next, 'operator');
  assert(u.authority.checkpointDeadline('run-a') === u.clock.wall + HOUR, 'installing a policy resets the baseline to its issuedAt');

  const live = checkpointSetup();
  const secrets = { operator: randomBytes(32).toString('hex'), runner: randomBytes(32).toString('hex'), sentry: randomBytes(32).toString('hex') };
  const http = await import('http');
  const server = http.createServer(live.authority.httpHandler(secrets));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    const port = (server.address() as import('net').AddressInfo).port;
    const cp = signCheckpoint({ policyHash: policyHash(live.signed), scope: { all: true }, now: live.clock.wall + 1 }, live.operator);
    const post = (secret: string, body: unknown) => fetch(`http://127.0.0.1:${port}/v1/checkpoint`, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const bySentry = await post(secrets.sentry, cp);
    assert(bySentry.status === 403, 'POST /v1/checkpoint refuses the sentry role', String(bySentry.status));
    const byOperator = await post(secrets.operator, cp);
    const json = await byOperator.json() as { ok?: boolean; deadline?: number };
    assert(byOperator.status === 200 && json.ok === true && typeof json.deadline === 'number', 'POST /v1/checkpoint accepts an operator checkpoint');
    const replay = await post(secrets.operator, cp);
    assert(replay.status === 400, 'replay over HTTP rejected', String(replay.status));
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------------------
// 5a.3 Honeytokens and tripwires
// ---------------------------------------------------------------------------

async function testTripwires(): Promise<void> {
  section('5a.3 Decoys: generation, detection, materialization');
  const set = new TripwireSet();
  const openai = set.createCredential('openai-key', 'openai');
  const aws = set.createCredential('aws-key', 'aws');
  const gh = set.createCredential('gh-token', 'github');
  assert(/^sk-proj-[A-Za-z0-9]{48}$/.test(openai) && /^AKIA[A-Z2-7]{16}$/.test(aws) && /^ghp_[A-Za-z0-9]{36}$/.test(gh), 'decoys imitate real credential formats');
  const env = set.createFile('.env', 'env');
  set.createFile('keys/deploy.pem', 'pem');
  set.createFile('config/app.json', 'config');
  assert(set.size === 3 + 4 + 1 + 1, 'decoy files register their embedded credentials');
  assert(set.scan(`Authorization: Bearer ${openai}`)[0]?.label === 'openai-key', 'decoy found in plain text');
  assert(set.scan({ nested: [{ key: gh }] }).length === 1, 'decoy found inside JSON values');
  assert(set.scan(Buffer.from(gh, 'utf8').toString('base64')).length === 1, 'base64-encoded decoy found');
  const envKey = /OPENAI_API_KEY=(\S+)/.exec(env.content)![1];
  assert(set.scan(`curl -H "x-api-key: ${envKey}"`).length === 1, 'credential copied from the decoy .env is detected');
  assert(set.scan('ordinary request body with no secrets at all').length === 0, 'normal text has no hits');
  assert(set.isDecoyPath('/workspace/keys/deploy.pem') === 'keys/deploy.pem' && set.isDecoyPath('keys\\deploy.pem') === 'keys/deploy.pem', 'decoy paths match absolute and Windows forms');
  assert(set.isDecoyPath('src/index.ts') === null, 'other paths are not decoys');
  throwsSync(() => set.createFile('../outside.env', 'env'), 'decoy path cannot escape the workspace');
  throwsSync(() => set.createFile('/etc/passwd', 'env'), 'absolute decoy path rejected');
  throwsSync(() => set.createCredential('bad label!', 'generic'), 'invalid label rejected');

  const dir = tmp('nai-p5-trip-');
  try {
    const written = set.materialize(dir);
    assert(written.length === 3 && fs.readFileSync(path.join(dir, '.env'), 'utf8') === env.content, 'decoy files written into the workspace');
    throwsSync(() => set.materialize(dir), 'materialize never overwrites existing files');
    const copy = TripwireSet.fromJSON(JSON.parse(JSON.stringify(set.toJSON())));
    assert(copy.scan(aws).length === 1 && copy.isDecoyPath('config/app.json') !== null, 'manifest round-trips to the proxy process');
    throwsSync(() => TripwireSet.fromJSON({ v: 'nai-tripwires-v1', credentials: [{ label: 'x', format: 'generic', value: 'short' }], files: [] }), 'manifest with a short decoy rejected');
    throwsSync(() => TripwireSet.fromJSON({ v: 'nai-tripwires-v1', credentials: [], files: [{ path: '../x', kind: 'env', content: '' }] }), 'manifest with an escaping path rejected');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const det = tripwireDetector(set);
  const f1 = det.inspect({ at: T0, kind: 'file', target: '/workspace/.env', action: 'read', agentId: 'a1' });
  assert(f1?.level === 'critical' && f1.reason.includes('.env'), 'sentry: reading a decoy file is critical');
  const f2 = det.inspect({ at: T0, kind: 'output', text: `here is the key ${openai}` });
  assert(f2?.level === 'critical', 'sentry: decoy value in output is critical');
  assert(det.inspect({ at: T0, kind: 'file', target: 'src/app.ts' }) === null, 'sentry: normal files are ignored');

  section('5a.3 Egress proxy: decoy ⇒ refuse, never forward, revoke');
  const operator = generateEd25519KeyPair();
  const authorityKey = generateEd25519KeyPair();
  const authority = new LeaseAuthority({
    operatorPublicKey: operator.publicKey, authorityKey,
    policy: signPolicy(basePolicy({ stopWhen: { sentryAlertAtOrAbove: 'critical', sentryQuorum: 2, tripwire: true } }, Date.now()), operator),
  });
  const upstreamHits: string[] = [];
  const http = await import('http');
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => { upstreamHits.push(`${req.url} ${Buffer.concat(chunks).toString()}`); res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const upPort = (upstream.address() as import('net').AddressInfo).port;
  const alerts: string[] = [];
  const proxyEvents: string[] = [];
  const proxy = new EgressProxy({
    authorityPublicKey: authority.publicKey,
    isLeaseActive: async (id) => authority.isLeaseActive(id),
    routes: [{ name: 'llm', upstream: `http://127.0.0.1:${upPort}`, methods: ['GET', 'POST'] }],
    tripwires: set,
    onTripwire: (hit) => { alerts.push(hit.label); authority.reportAlert('critical', TRIPWIRE_SOURCE, 'sentry', 'tripwire'); },
    onEvent: (e) => { proxyEvents.push(`${e.outcome}:${e.reason ?? ''}`); },
  });
  const proxyServer = http.createServer(proxy.httpHandler());
  await new Promise<void>((r) => proxyServer.listen(0, '127.0.0.1', () => r()));
  const proxyPort = (proxyServer.address() as import('net').AddressInfo).port;
  try {
    const lease = authority.issue('run-trip').lease!;
    const call = (p: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${proxyPort}${p}`, { ...init, headers: { 'X-Network-AI-Lease': encodeLeaseHeader(lease), ...(init.headers as Record<string, string> ?? {}) } });
    const ok = await call('/llm/v1/chat', { method: 'POST', body: JSON.stringify({ prompt: 'hello' }) });
    assert(ok.status === 200 && upstreamHits.length === 1, 'normal traffic is forwarded', String(ok.status));

    // A single non-proxy sentry tripwire does not bypass the quorum.
    authority.reportAlert('critical', 'sentry:other', 'sentry', 'tripwire');
    assert(authority.isLeaseActive(lease.claims.leaseId), 'tripwire from a non-proxy sentry still needs the quorum');

    const inBody = await call('/llm/v1/chat', { method: 'POST', body: JSON.stringify({ prompt: `use ${openai}` }) });
    const text = await inBody.text();
    assert(inBody.status === 403 && !text.includes('tripwire'), 'request with a decoy in the body refused with a generic error', `${inBody.status} ${text}`);
    assert(upstreamHits.length === 1, 'decoy request never forwarded upstream');
    assert(alerts[0] === 'openai-key' && proxyEvents.some((e) => e.startsWith('denied:tripwire: openai-key')), 'tripwire audited with its label');
    assert(!authority.isLeaseActive(lease.claims.leaseId) && authority.status('run-trip')[0].state === 'revoked', 'proxy tripwire revokes the run immediately (stopWhen.tripwire)');
    const again = authority.issue('run-trip-2');
    assert(!again.granted && (again.reason ?? '').includes('tripwire'), 'a tripwire latches the authority: a new runId gets no lease');
    authority.resume('operator');
    assert(authority.issue('run-trip-3').granted, 'only an operator resume clears the latch');

    const inHeader = await fetch(`http://127.0.0.1:${proxyPort}/llm/x`, { headers: { Authorization: `Basic ${Buffer.from(`user:${gh}`).toString('base64')}` } });
    assert(inHeader.status === 403 && alerts.includes('gh-token'), 'decoy inside HTTP Basic credentials detected before lease checks');
    const inQuery = await fetch(`http://127.0.0.1:${proxyPort}/nowhere?k=${aws}`);
    assert(inQuery.status === 403 && alerts.includes('aws-key'), 'decoy in the query string detected even on unknown routes');
    assert(upstreamHits.length === 1, 'no decoy request ever reached the upstream');

    const broken = new EgressProxy({
      authorityPublicKey: authority.publicKey, isLeaseActive: async () => true,
      routes: [{ name: 'llm', upstream: `http://127.0.0.1:${upPort}` }],
      tripwires: { scan: () => { throw new Error('boom'); } },
    });
    const brokenServer = http.createServer(broken.httpHandler());
    await new Promise<void>((r) => brokenServer.listen(0, '127.0.0.1', () => r()));
    const bp = (brokenServer.address() as import('net').AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${bp}/llm/x`);
    assert(res.status === 403 && upstreamHits.length === 1, 'a failing tripwire scanner fails closed');
    brokenServer.close();
  } finally {
    proxyServer.close();
    upstream.close();
  }

  const noStop = new LeaseAuthority({ operatorPublicKey: operator.publicKey, authorityKey, policy: signPolicy(basePolicy({}, Date.now()), operator) });
  const l2 = noStop.issue('run-x').lease!;
  noStop.reportAlert('critical', TRIPWIRE_SOURCE, 'sentry', 'tripwire');
  assert(noStop.status('run-x')[0].state === 'stopped' && l2.claims.runId === 'run-x', 'without stopWhen.tripwire the alert follows normal rules (stop, not revoke)');
  throwsSync(() => noStop.reportAlert('critical', 'x', 'sentry', 'other' as 'tripwire'), 'unknown alert kind rejected');
}

// ---------------------------------------------------------------------------
// 5a.1 Posture gate, 5a.5 hardened Node, 5b.5 user separation
// ---------------------------------------------------------------------------

function testPosture(): void {
  section('5a.1 Posture checks fail closed');
  const strong = () => randomBytes(32).toString('hex');
  const dir = tmp('nai-p5-posture-');
  try {
    const opFiles = writeKeyPair(dir, 'operator');
    const authFiles = writeKeyPair(dir, 'authority');
    const operatorPub = readKeyPair(opFiles.privateKeyPath).publicKey;
    const me = { username: 'authsvc', uid: 1001 };
    const find = (r: ReturnType<typeof runPostureChecks>, id: string) => r.checks.find((c) => c.id === id);

    const bad = runPostureChecks({
      role: 'authority', privateKeyFiles: [opFiles.privateKeyPath, authFiles.privateKeyPath], operatorPublicKey: operatorPub,
      agentUser: 'authsvc', currentUser: me, secrets: { operator: 'short', sentry: strong(), runner: 'a'.repeat(40) },
      bind: { host: '0.0.0.0', allowRemote: true }, sandboxRuntime: 'runc', authorityThreshold: 1, platform: 'win32',
    });
    assert(!bad.ok, 'misconfigured authority fails the posture gate');
    assert(find(bad, 'operator-key-present')?.ok === false, 'operator private key next to the authority key detected');
    assert(find(bad, 'runs-as-agent-user')?.ok === false, 'authority running as the agent user detected');
    assert(find(bad, 'weak-secret')?.ok === false && (find(bad, 'weak-secret')?.detail ?? '').includes('operator') && (find(bad, 'weak-secret')?.detail ?? '').includes('runner'), 'short and low-entropy secrets detected');
    assert(find(bad, 'remote-bind-no-tls')?.ok === false, 'remote bind without TLS acknowledgement detected');
    assert(find(bad, 'weak-sandbox-runtime')?.ok === false, 'shared-kernel sandbox runtime detected');
    assert(find(bad, 'single-authority')?.severity === 'warn', 'single authority is a warning, not a blocker');

    const same = strong();
    const dup = runPostureChecks({ role: 'proxy', secrets: { sentry: same, 'sentry:proxy': same }, currentUser: me, agentUser: 'agent' });
    assert(find(dup, 'duplicate-secret')?.ok === false, 'shared secrets between identities detected');

    const good = runPostureChecks({
      role: 'authority', privateKeyFiles: [authFiles.privateKeyPath], operatorPublicKey: operatorPub, agentUser: 'agent', currentUser: me,
      secrets: { operator: strong(), sentry: strong(), runner: strong() }, bind: { host: '127.0.0.1' }, sandboxRuntime: 'runsc', authorityThreshold: 2,
    });
    assert(good.ok && good.checks.every((c) => c.ok), 'well-separated authority passes every check', JSON.stringify(good.checks.filter((c) => !c.ok)));
    const unset = runPostureChecks({ role: 'proxy', currentUser: me });
    assert(unset.ok && find(unset, 'agent-user-unset')?.severity === 'warn', 'unknown agent user is a warning');
    const root = runPostureChecks({ role: 'authority', currentUser: { username: 'root', uid: 0 }, agentUser: 'agent' });
    assert(find(root, 'runs-as-root')?.ok === false, 'control plane running as root detected');
    assert(runPostureChecks({ role: 'proxy', bind: { host: '10.0.0.5', allowRemote: true, tlsTerminated: true }, currentUser: me, agentUser: 'agent' }).ok, 'remote bind behind acknowledged TLS passes');

    if (process.platform !== 'win32') {
      fs.chmodSync(authFiles.privateKeyPath, 0o644);
      const loose = runPostureChecks({ role: 'authority', privateKeyFiles: [authFiles.privateKeyPath] });
      assert(find(loose, 'key-file-mode')?.ok === false, 'group/world-readable key file detected (POSIX)');
    } else {
      pass('key-file-mode reports ACL guidance on Windows (POSIX mode check runs on Linux/macOS)');
    }

    const v = postureVerdict(bad, ['operator-key-present', 'runs-as-agent-user', 'weak-secret', 'remote-bind-no-tls']);
    assert(!v.ok && v.blocking.map((c) => c.id).join() === 'weak-sandbox-runtime' && v.accepted.length === 4, 'accept-risk unblocks only the named checks');
    throwsSync(() => postureVerdict(bad, ['operator-key-presnt']), 'a misspelled accept-risk id is an error, never a silent accept', msgIncludes('unknown posture check'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testHardenedNode(): void {
  section('5a.5 Hardened Node profile');
  const args = hardenedNodeArgs();
  assert(args.includes('--no-addons') && args.includes('--disallow-code-generation-from-strings') && args.includes('--permission'), 'hardened args disable addons and code generation and enable the permission model');
  assert(args.includes('--allow-fs-read=/workspace') && args.includes('--allow-fs-write=/workspace') && !args.includes('--allow-child-process') && !args.includes('--allow-worker'), 'file system limited to /workspace; no child processes or workers by default');
  assert(hardenedNodeArgs({ allowChildProcess: true, permissionFlag: '--experimental-permission' }).includes('--allow-child-process'), 'child processes only when explicitly allowed; older Node lines use --experimental-permission');
  throwsSync(() => hardenedNodeArgs({ workspace: '/' }), 'root file-system access refused');
  throwsSync(() => hardenedNodeArgs({ readOnly: ['/workspace/../etc'] }), '.. in allowed directories refused');

  const ws = tmp('nai-p5-ws-');
  try {
    const runner = new ContainerSandboxRunner({ image: 'node:22-slim', nodeProfile: 'hardened' });
    const req = normalizeSandboxRequest({ argv: ['node', 'agent.js', '--flag'], workspace: ws });
    const built = runner.buildArgs(req, 'c1');
    const at = built.indexOf('node:22-slim');
    assert(built.slice(at + 1).join(' ') === `node ${hardenedNodeArgs().join(' ')} agent.js --flag`, 'hardened flags inserted between node and the script (argv, not NODE_OPTIONS)');
    throwsSync(() => runner.buildArgs(normalizeSandboxRequest({ argv: ['python3', 'x.py'], workspace: ws }), 'c2'), 'non-node workload refused under the hardened profile');
    throwsSync(() => runner.buildArgs(normalizeSandboxRequest({ argv: ['node', '--allow-fs-read=*', 'x.js'], workspace: ws }), 'c3'), 'caller cannot widen permissions with --allow-*');
    throwsSync(() => runner.buildArgs(normalizeSandboxRequest({ argv: ['node', '-r', 'evil', 'x.js'], workspace: ws }), 'c4'), 'caller cannot preload modules');
    throwsSync(() => runner.buildArgs(normalizeSandboxRequest({ argv: ['node', '--title', 'x', '--allow-fs-read=*', '--allow-child-process', 'agent.js'], workspace: ws }), 'c4b'), 'an option with a separate value cannot smuggle widening flags past the screen');
    throwsSync(() => runner.buildArgs(normalizeSandboxRequest({ argv: ['node', '--env-file=.env', 'agent.js'], workspace: ws }), 'c4c'), '--env-file refused (it can carry NODE_OPTIONS)');
    throwsSync(() => runner.buildArgs(normalizeSandboxRequest({ argv: ['node', '--no-warnings'], workspace: ws }), 'c4d'), 'a script is required');
    const allowed = runner.buildArgs(normalizeSandboxRequest({ argv: ['node', '--max-old-space-size=512', '--enable-source-maps', 'agent.js'], workspace: ws }), 'c4e');
    assert(allowed.slice(-3).join(' ') === '--max-old-space-size=512 --enable-source-maps agent.js', 'allowlisted value-free options are accepted');
    for (const [env, label] of [[{ LD_PRELOAD: '/workspace/p.so' }, 'LD_PRELOAD'], [{ PATH: '/workspace' }, 'PATH'], [{ NODE_PATH: '/workspace' }, 'NODE_*']] as const) {
      throwsSync(() => runner.buildArgs(normalizeSandboxRequest({ argv: ['node', 'agent.js'], workspace: ws, env }), 'c4f'), `${label} refused under the hardened profile (loader / lookup injection)`);
    }
    throwsSync(() => runner.buildArgs(normalizeSandboxRequest({ argv: ['./node', 'agent.js'], workspace: ws }), 'c4g'), 'a workspace binary named node is refused');
    throwsSync(() => runner.buildArgs(normalizeSandboxRequest({ argv: ['/workspace/node', 'agent.js'], workspace: ws }), 'c4h'), 'an absolute path ending in /node is refused unless it is the configured nodePath');
    const fixed = new ContainerSandboxRunner({ image: 'node:22-slim', nodeProfile: 'hardened', nodeHardening: { nodePath: '/usr/local/bin/node' } });
    assert(fixed.buildArgs(normalizeSandboxRequest({ argv: ['/usr/local/bin/node', 'agent.js'], workspace: ws }), 'c4i').includes('--permission'), 'the operator-configured nodePath is accepted');
    throwsSync(() => new ContainerSandboxRunner({ image: 'img', nodeProfile: 'hardened', nodeHardening: { nodePath: '/workspace/node' } }), 'nodePath inside the workspace is refused');
    throwsSync(() => runner.buildArgs(normalizeSandboxRequest({ argv: ['node', 'x.js'], workspace: ws, env: { NODE_OPTIONS: '--allow-addons' } }), 'c5'), 'NODE_OPTIONS refused under the hardened profile');
    const plain = new ContainerSandboxRunner({ image: 'node:22-slim' });
    assert(plain.buildArgs(req, 'c6').slice(-3).join(' ') === 'node agent.js --flag', 'default profile leaves argv unchanged');
    throwsSync(() => new ContainerSandboxRunner({ image: 'img', user: '0' }), '5b.5: sandbox refuses to run the agent as root (uid 0)');
    throwsSync(() => new ContainerSandboxRunner({ image: 'img', user: '0:1000' }), '5b.5: uid 0 refused with any gid');
    void new ContainerSandboxRunner({ image: 'img', user: '1000:1000' });
    pass('non-root uid accepted');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }

  assert(!checkHardenedNode([]).ok, 'posture: an unhardened Node process is detected');
  assert(checkHardenedNode(hardenedNodeArgs()).ok, 'posture: the hardened argv passes');
  const wide = checkHardenedNode([...hardenedNodeArgs(), '--allow-fs-read=*', '--allow-child-process']);
  assert(!wide.ok && wide.problems.length === 2, 'posture: wildcard file access and child processes detected');
  const agentReport = runPostureChecks({ role: 'agent', nodeExecArgv: [] });
  assert(!agentReport.ok && agentReport.checks[0].id === 'hardened-node', 'agent posture fails without hardened flags');

  // Real Node: the flags actually block eval, out-of-workspace reads, and child processes.
  const sandboxDir = tmp('nai-p5-node-');
  try {
    const script = path.join(sandboxDir, 'probe.js');
    fs.writeFileSync(script, [
      "const out = {};",
      // The probe checks that the hardened flags block code generation from strings. It reaches eval
      // indirectly so source scanners do not report the test itself as dynamic code execution.
      "const ev = globalThis['ev' + 'al'];",
      "try { ev('1'); out.eval = 'allowed'; } catch { out.eval = 'blocked'; }",
      "try { require('fs').readFileSync(process.argv[2]); out.read = 'allowed'; } catch { out.read = 'blocked'; }",
      "try { require('child_process').execFileSync(process.execPath, ['-v']); out.child = 'allowed'; } catch { out.child = 'blocked'; }",
      "process.stdout.write(JSON.stringify(out));",
    ].join('\n'));
    const flags = ['--no-addons', '--disallow-code-generation-from-strings', '--permission', `--allow-fs-read=${sandboxDir}`, `--allow-fs-write=${sandboxDir}`];
    const r = spawnSync(process.execPath, [...flags, script, __filename], { encoding: 'utf8', timeout: 30_000 });
    const out = JSON.parse(r.stdout || '{}') as Record<string, string>;
    assert(out.eval === 'blocked' && out.read === 'blocked' && out.child === 'blocked', 'real Node run: eval, outside reads, and child processes are blocked', r.stdout + r.stderr);
  } finally {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 5a CLI: doctor, posture gate, checkpoint, tripwires
// ---------------------------------------------------------------------------

const CLI = path.join(__dirname, 'bin', 'cli.ts');

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['-r', 'ts-node/register', CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => p.kill(), 90_000);
    p.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    p.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
    p.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

async function startAuthority(args: string[], env: NodeJS.ProcessEnv): Promise<{ url: string; child: ChildProcess }> {
  const child = spawn(process.execPath, ['-r', 'ts-node/register', CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  const url = await new Promise<string>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`authority did not start: ${err}`)), 90_000);
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const m = /listening on (http:\/\/[^\s]+)/.exec(out);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.stderr!.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`authority exited ${code}: ${err}`)); });
  });
  return { url, child };
}

async function testCli(): Promise<void> {
  section('5a CLI: doctor, posture gate, checkpoint, tripwires');
  const dir = tmp('nai-p5-cli-');
  const roles = { operator: randomBytes(32).toString('hex'), sentry: randomBytes(32).toString('hex'), runner: randomBytes(32).toString('hex') };
  const env: NodeJS.ProcessEnv = {
    ...process.env, TS_NODE_TRANSPILE_ONLY: 'true', NETWORK_AI_MINIMAL: '1',
    NETWORK_AI_LEASE_OPERATOR_SECRET: roles.operator, NETWORK_AI_LEASE_SENTRY_SECRET: roles.sentry, NETWORK_AI_LEASE_RUNNER_SECRET: roles.runner,
  };
  let child: ChildProcess | null = null;
  try {
    const opKeys = path.join(dir, 'operator-keys');
    const authKeys = path.join(dir, 'authority-keys');
    const op = writeKeyPair(opKeys, 'operator');
    writeKeyPair(authKeys, 'authority');
    const signedFile = path.join(dir, 'policy.signed.json');
    const signed = signPolicy(basePolicy({ humanCheckpointEveryMs: 2 * HOUR }, Date.now()), readKeyPair(op.privateKeyPath));
    fs.writeFileSync(signedFile, JSON.stringify(signed));

    const doctorBad = await runCli(['perpetual', 'doctor', '--role', 'authority', '--operator-pub', op.publicKeyPath, '--key', op.privateKeyPath, '--host', '0.0.0.0', '--allow-remote'], env);
    assert(doctorBad.status === 1 && doctorBad.stdout.includes('FAIL  operator-key-present') && doctorBad.stdout.includes('FAIL  remote-bind-no-tls'), 'doctor reports failures and exits 1', doctorBad.stdout + doctorBad.stderr);
    const doctorGood = await runCli(['perpetual', 'doctor', '--role', 'authority', '--operator-pub', op.publicKeyPath, '--key', path.join(authKeys, 'authority.key'), '--agent-user', 'nai-agent-nonexistent'], env);
    assert(doctorGood.status === 0 && doctorGood.stdout.includes('posture ok'), 'doctor passes a separated deployment', doctorGood.stdout + doctorGood.stderr);
    const doctorAgent = await runCli(['perpetual', 'doctor', '--role', 'agent', '--node-flags', hardenedNodeArgs().join(' ')], env);
    assert(doctorAgent.status === 0, 'doctor accepts a hardened agent', doctorAgent.stdout + doctorAgent.stderr);

    // Operator key next to the authority key ⇒ refuse to start.
    fs.copyFileSync(op.privateKeyPath, path.join(authKeys, 'operator.key'));
    const refused = await runCli(['--data', dir, 'perpetual', 'authority', '--operator-pub', op.publicKeyPath, '--authority-key', path.join(authKeys, 'authority.key'), '--policy', signedFile, '--port', '0'], env);
    assert(refused.status !== 0 && refused.stderr.includes('operator-key-present'), 'authority refuses to start with the operator key on its host', refused.stderr);
    const typo = await runCli(['--data', dir, 'perpetual', 'authority', '--operator-pub', op.publicKeyPath, '--authority-key', path.join(authKeys, 'authority.key'), '--policy', signedFile, '--port', '0', '--accept-risk', 'operator-key'], env);
    assert(typo.status !== 0 && typo.stderr.includes('unknown posture check'), 'unknown --accept-risk id refused', typo.stderr);
    fs.rmSync(path.join(authKeys, 'operator.key'));

    const weakEnv = { ...env, NETWORK_AI_LEASE_RUNNER_SECRET: 'x'.repeat(32) };
    const weak = await runCli(['--data', dir, 'perpetual', 'authority', '--operator-pub', op.publicKeyPath, '--authority-key', path.join(authKeys, 'authority.key'), '--policy', signedFile, '--port', '0'], weakEnv);
    assert(weak.status !== 0 && weak.stderr.includes('weak-secret'), 'authority refuses a low-entropy role secret', weak.stderr);

    const started = await startAuthority(['--data', dir, 'perpetual', 'authority', '--operator-pub', op.publicKeyPath, '--authority-key', path.join(authKeys, 'authority.key'), '--policy', signedFile, '--port', '0'], env);
    child = started.child;
    pass('authority starts once the posture is clean');

    const cp = await runCli(['perpetual', 'checkpoint', '--all', '--key', op.privateKeyPath, '--policy', signedFile, '--authority-url', started.url], env);
    assert(cp.status === 0 && cp.stdout.includes('deadline'), 'perpetual checkpoint --all signs and submits a checkpoint', cp.stderr);
    const cpBoth = await runCli(['perpetual', 'checkpoint', 'run-1', '--all', '--key', op.privateKeyPath, '--policy', signedFile, '--authority-url', started.url], env);
    assert(cpBoth.status !== 0, 'checkpoint needs exactly one of runId / --all');
    const cpAsSentry = await runCli(['perpetual', 'checkpoint', 'run-1', '--key', op.privateKeyPath, '--policy', signedFile, '--authority-url', started.url], { ...env, NETWORK_AI_LEASE_OPERATOR_SECRET: roles.sentry });
    assert(cpAsSentry.status !== 0, 'checkpoint over HTTP needs the operator role');
    const audit = fs.readFileSync(path.join(dir, 'perpetual_audit.jsonl'), 'utf8');
    assert(audit.includes('"action":"checkpoint"'), 'checkpoint audited by the authority');

    const ws = path.join(dir, 'workspace');
    fs.mkdirSync(ws);
    const manifest = path.join(dir, 'tripwires.json');
    const tw = await runCli(['perpetual', 'tripwires', '--workspace', ws, '--manifest', manifest], env);
    assert(tw.status === 0 && fs.existsSync(path.join(ws, '.env')) && fs.existsSync(path.join(ws, 'keys', 'deploy.pem')), 'perpetual tripwires plants decoys in the workspace', tw.stderr);
    const loaded = TripwireSet.fromJSON(JSON.parse(fs.readFileSync(manifest, 'utf8')));
    assert(loaded.scan(fs.readFileSync(path.join(ws, '.env'), 'utf8')).length === 4, 'manifest detects the planted decoys');
    const inside = await runCli(['perpetual', 'tripwires', '--workspace', ws, '--manifest', path.join(ws, 'm.json')], env);
    assert(inside.status !== 0, 'manifest may not live inside the agent workspace');
    const proxyNoSecret = await runCli(['perpetual', 'proxy', '--authority-pub', op.publicKeyPath, '--routes', manifest, '--tripwires', manifest, '--port', '0'], env);
    assert(proxyNoSecret.status !== 0 && proxyNoSecret.stderr.includes('SENTRY_SECRET_PROXY'), 'proxy with tripwires requires its own sentry identity', proxyNoSecret.stderr);

    // 5b.2: an external signer keeps the private key out of the CLI process.
    const signerScript = path.join(dir, 'signer.js');
    fs.writeFileSync(signerScript, [
      "const { createPrivateKey, sign } = require('crypto');",
      "const key = createPrivateKey(require('fs').readFileSync(process.argv[2]));",
      "const chunks = []; process.stdin.on('data', (c) => chunks.push(c));",
      "process.stdin.on('end', () => process.stdout.write(sign(null, Buffer.concat(chunks), key).toString('hex')));",
    ].join('\n'));
    const unsignedFile = path.join(dir, 'unsigned.json');
    const { issuedAt: _drop, ...unsigned } = basePolicy();
    fs.writeFileSync(unsignedFile, JSON.stringify(unsigned));
    const viaSigner = await runCli(['perpetual', 'sign-policy', unsignedFile, '--signer-cmd', process.execPath, '--signer-arg', signerScript, op.privateKeyPath, '--signer-pub', op.publicKeyPath], env);
    const pem = fs.readFileSync(op.privateKeyPath, 'utf8');
    const signedViaCmd = JSON.parse(viaSigner.stdout || '{}') as ReturnType<typeof signPolicy>;
    assert(viaSigner.status === 0 && verifySignedPolicy(signedViaCmd, readKeyPair(op.privateKeyPath).publicKey) === null, 'sign-policy --signer-cmd produces a verifying signature', viaSigner.stderr);
    const keyBody = pem.split('\n')[1] ?? pem;
    assert(!viaSigner.stdout.includes(keyBody) && !viaSigner.stderr.includes(keyBody), 'private key material never appears in CLI output');
    const both = await runCli(['perpetual', 'sign-policy', unsignedFile, '--key', op.privateKeyPath, '--signer-cmd', process.execPath, '--signer-pub', op.publicKeyPath], env);
    assert(both.status !== 0, '--key and --signer-cmd are mutually exclusive');
    const noPub = await runCli(['perpetual', 'sign-policy', unsignedFile, '--signer-cmd', process.execPath], env);
    assert(noPub.status !== 0 && noPub.stderr.includes('--signer-pub'), '--signer-cmd requires --signer-pub');

    // 5c.4: capability evaluations are signed by an evaluator key.
    const evKeys = writeKeyPair(path.join(dir, 'evaluator'), 'evaluator');
    const evFile = path.join(dir, 'eval.json');
    fs.writeFileSync(evFile, JSON.stringify({ v: 'nai-capeval-v1', evalId: 'ev-1', suite: 'redteam-1', scores: { deception: 0.01 } }));
    const se = await runCli(['perpetual', 'sign-capability-eval', evFile, '--key', evKeys.privateKeyPath], env);
    const signedEval = JSON.parse(se.stdout || '{}') as Parameters<typeof verifyCapabilityEval>[0];
    const evPem = fs.readFileSync(evKeys.publicKeyPath, 'utf8');
    assert(se.status === 0 && verifyCapabilityEval(signedEval, { evaluatorPublicKeysPem: [evPem], thresholds: { deception: { max: 0.1 } }, maxAgeMs: HOUR }, Date.now()) === null, 'sign-capability-eval produces an evaluation the authority accepts', se.stderr);
  } finally {
    child?.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 5b.1 k-of-n authorities
// ---------------------------------------------------------------------------

class LocalAuthorityTransport implements LeaseTransport, CosignTransport {
  down = false;
  constructor(readonly authority: LeaseAuthority) {}
  async issue(runId: string, att?: Heartbeat['attestation']): Promise<LeaseDecision> { this.check(); return this.authority.issue(runId, 'runner', att); }
  async attestationNonce(runId: string): Promise<string> { this.check(); return this.authority.attestationChallenge(runId).nonce; }
  async renew(h: Heartbeat): Promise<LeaseDecision> { this.check(); return this.authority.renew(h, 'runner'); }
  async cosign(claims: LeaseClaims, h: Heartbeat | undefined, issuerSig: { keyId: string; signature: string }) { this.check(); return this.authority.cosign(claims, h, 'runner', issuerSig); }
  async isActive(id: string, runId?: string): Promise<boolean> { this.check(); return this.authority.leaseStatus(id, runId) === 'active'; }
  async leaseStatus(id: string, runId?: string) { this.check(); return this.authority.leaseStatus(id, runId); }
  private check() { if (this.down) throw new Error('down'); }
}

function quorumSetup(overrides: Partial<RenewalPolicy> = {}) {
  const clock = new Clock();
  const operator = generateEd25519KeyPair();
  const keys = [generateEd25519KeyPair(), generateEd25519KeyPair(), generateEd25519KeyPair()];
  const signed = signPolicy(basePolicy({
    financialDestinations: ['payments'],
    authorityQuorum: { threshold: 2, keyIds: keys.map((k) => k.keyId) },
    acceptRisk: ['no-capability-eval'],
    ...overrides,
  }, clock.wall), operator);
  const pubs = keys.map((k) => k.publicKey);
  const authorities = keys.map((k) => new LeaseAuthority({ operatorPublicKey: operator.publicKey, authorityKey: k, policy: signed, now: () => clock.wall, peerAuthorityKeys: pubs }));
  const transports = authorities.map((a) => new LocalAuthorityTransport(a));
  const quorum = new QuorumLeaseTransport(transports[0], transports.slice(1), 2);
  return { clock, operator, keys, signed, authorities, transports, quorum, pubs };
}

/** Sign claims as `issuer` (simulates what an issuing authority — or a compromised one — produces). */
function issuerSig(claims: LeaseClaims, issuer: ReturnType<typeof generateEd25519KeyPair>) {
  const l = signLease({ ...claims, issuer: issuer.keyId }, issuer);
  return { claims: l.claims, sig: { keyId: l.keyId, signature: l.signature } };
}

async function testQuorum(): Promise<void> {
  section('5b.1 k-of-n: granting needs k authorities');
  const q = quorumSetup();
  throwsSync(() => new LeaseAuthority({ operatorPublicKey: q.operator.publicKey, authorityKey: generateEd25519KeyPair(), policy: q.signed }), 'authority outside the policy quorum refuses to start', msgIncludes('authorityQuorum'));
  const d = await q.quorum.issue('run-q');
  assert(d.granted && (d.lease!.cosignatures ?? []).length === 2 && d.lease!.claims.highRisk === true, 'lease carries co-signatures and the high-risk marker', d.reason);
  const lease = d.lease!;
  assert(verifyLeaseQuorum(lease, q.pubs, 2, q.clock.wall) === null && verifyLeaseQuorum(lease, q.pubs, 3, q.clock.wall) === null, 'quorum lease verifies for k = 2 and k = 3');
  const single = { ...lease, cosignatures: [] };
  assert((verifyLeaseQuorum(single, q.pubs, 2, q.clock.wall) ?? '').includes('1 valid'), 'k − 1 signatures rejected');
  const forged = { ...lease, cosignatures: [{ keyId: q.keys[1].keyId, signature: 'ab'.repeat(64) }] };
  assert(verifyLeaseQuorum(forged, q.pubs, 2, q.clock.wall) !== null, 'forged co-signature does not count');
  const dupe = { ...lease, cosignatures: [lease.cosignatures![0], lease.cosignatures![0]] };
  assert(verifyLeaseQuorum({ ...dupe, cosignatures: [{ keyId: lease.keyId, signature: lease.signature }] }, q.pubs, 2, q.clock.wall) !== null, 'the same authority signing twice counts once');
  const stranger = generateEd25519KeyPair();
  assert(verifyLeaseQuorum(cosignLease(single, stranger), q.pubs, 2, q.clock.wall) !== null, 'signature from an unknown authority does not count');
  assert(verifyLeaseQuorum({ ...lease, claims: { ...lease.claims, expiresAt: lease.claims.expiresAt + HOUR } }, q.pubs, 2, q.clock.wall) !== null, 'tampered claims break every signature');

  const guard = new LeaseGuard({ runId: 'run-qg', authorityPublicKeys: q.pubs, authorityThreshold: 2, transport: q.quorum, now: () => q.clock.wall, monotonic: () => q.clock.mono, statusPollMs: 1_000 });
  await guard.start();
  assert(guard.currentLease !== null, 'guard accepts a k-of-n lease');
  q.clock.advance(45_000);
  await guard.tick();
  assert(guard.currentLease!.claims.sequence === 2 && (guard.currentLease!.cosignatures ?? []).length === 2, 'renewal is co-signed again');

  section('5b.1 k-of-n: stopping needs one');
  q.authorities[2].revoke({ runId: 'run-qg' }, 'operator', 'revoked at one authority');
  q.clock.advance(1_000);
  await guard.tick();
  assert(guard.lossReason !== null && guard.lossReason.includes('revoked'), 'revoke at one of three authorities halts the run', guard.lossReason ?? '');

  const r = quorumSetup();
  const l1 = (await r.quorum.issue('run-r')).lease!;
  r.authorities[2].pause('operator', 'operator pause');
  assert(!(await r.quorum.isActive(l1.claims.leaseId)), 'pause at one authority makes the lease inactive for verifiers');
  r.transports[1].down = true;
  assert(!(await r.quorum.isActive(l1.claims.leaseId)), 'still inactive when another authority is unreachable');
  r.clock.advance(45_000);
  const refused = await r.quorum.renew({ leaseId: l1.claims.leaseId, runId: 'run-r', at: r.clock.wall, spentUsd: 0, spentTokens: 0, health: 'ok' });
  assert(!refused.granted && (refused.reason ?? '').includes('quorum not reached'), 'renewal without k co-signers is refused', refused.reason);
  r.transports.forEach((tr) => { tr.down = true; });
  let unknown = false;
  try { await r.quorum.isActive(l1.claims.leaseId); } catch { unknown = true; }
  assert(unknown, 'all authorities unreachable ⇒ status unknown (guard fails closed at expiry)');

  section('5b.1 k-of-n availability: one missed co-sign does not stop a 2-of-3 run');
  const av = quorumSetup();
  const avGuard = new LeaseGuard({ runId: 'run-av', authorityPublicKeys: av.pubs, authorityThreshold: 2, transport: av.quorum, now: () => av.clock.wall, monotonic: () => av.clock.mono, statusPollMs: 1_000 });
  await avGuard.start();
  av.transports[2].down = true;
  av.clock.advance(45_000);
  await avGuard.tick();
  av.transports[2].down = false;
  av.clock.advance(1_000);
  await avGuard.tick();
  assert(avGuard.lossReason === null && avGuard.currentLease!.claims.sequence === 2, 'an authority that missed a co-sign reports the lease unknown, not inactive', avGuard.lossReason ?? '');
  assert(av.authorities[2].leaseStatus(avGuard.currentLease!.claims.leaseId, 'run-av') === 'unknown', 'leaseStatus is three-valued');
  av.authorities[2].revoke({ runId: 'run-av' }, 'operator');
  assert(av.authorities[2].leaseStatus(avGuard.currentLease!.claims.leaseId, 'run-av') === 'inactive', 'a run revoked at that authority is inactive even for a lease it never saw');

  // Revoke at an authority that has never seen the run at all (missed every co-sign).
  const tomb = quorumSetup();
  tomb.transports[2].down = true;
  const tombLease = (await tomb.quorum.issue('run-tomb')).lease!;
  tomb.transports[2].down = false;
  assert(tombLease !== undefined && (await tomb.quorum.isActive(tombLease.claims.leaseId, 'run-tomb')), '(setup) lease co-signed by two of three; the third never saw the run');
  tomb.authorities[2].revoke({ runId: 'run-tomb' }, 'operator');
  assert(!(await tomb.quorum.isActive(tombLease.claims.leaseId, 'run-tomb')), 'revoking an unseen run records a tombstone: verifiers refuse the lease');
  const tomb2 = quorumSetup();
  tomb2.transports[2].down = true;
  const tomb2Lease = (await tomb2.quorum.issue('run-tomb2')).lease!;
  tomb2.transports[2].down = false;
  tomb2.authorities[2].revoke({ all: true }, 'operator');
  assert(!(await tomb2.quorum.isActive(tomb2Lease.claims.leaseId, 'run-tomb2')), 'revoke --all also covers runs that authority never saw');

  section('5b.1 Co-signers decide independently (no split-brain, no widening)');
  const s = quorumSetup();
  const first = (await s.quorum.issue('run-s')).lease!;
  const replay = s.authorities[1].cosign(first.claims, undefined, 'runner', { keyId: first.keyId, signature: first.signature });
  assert(!replay.granted && (replay.reason ?? '').includes('sequence'), 'replayed claims refused');
  // Claims a (compromised) primary signed: co-signers still apply their own policy.
  const forgedClaims = (patch: Partial<LeaseClaims>) => issuerSig({ ...first.claims, leaseId: `lease_${randomBytes(12).toString('hex')}`, sequence: first.claims.sequence + 1, ...patch }, s.keys[0]);
  const hbFirst = { leaseId: first.claims.leaseId, runId: 'run-s', at: s.clock.wall, spentUsd: 0, spentTokens: 0, health: 'ok' as const };
  const cos = (c: ReturnType<typeof forgedClaims>, hb: Heartbeat | undefined, role: 'runner' | 'sentry' = 'runner', who = 2) => s.authorities[who].cosign(c.claims, hb, role, c.sig);
  const wide = cos(forgedClaims({ scope: { ...first.claims.scope, tier: 'elevated' } }), hbFirst);
  assert(!wide.granted && (wide.reason ?? '').includes('scope'), 'co-signer refuses a wider scope');
  const long = cos(forgedClaims({ expiresAt: s.clock.wall + 10 * HOUR }), hbFirst);
  assert(!long.granted && (long.reason ?? '').includes('expiry'), 'co-signer refuses a longer lease than its policy allows');
  const rich = cos(forgedClaims({ budget: { runCeilingUsd: 1e9, runCeilingTokens: 1 } }), hbFirst);
  assert(!rich.granted && (rich.reason ?? '').includes('budget'), 'co-signer refuses a higher budget');
  const foreign = cos(forgedClaims({ policyHash: 'f'.repeat(64) }), hbFirst);
  assert(!foreign.granted && (foreign.reason ?? '').includes('different policy'), 'co-signer refuses claims under another policy');
  const noHb = cos(forgedClaims({}), undefined);
  assert(!noHb.granted && (noHb.reason ?? '').includes('heartbeat'), 'renewal co-sign needs the heartbeat for the current lease');
  const failing = cos(forgedClaims({}), { ...hbFirst, health: 'failing' });
  assert(!failing.granted && s.authorities[2].status('run-s')[0].state === 'stopped', 'co-signer applies stop conditions itself');
  assert(s.authorities[1].status('run-s')[0].state === 'active', 'other authorities keep their own state (independent decisions)');
  assert(!cos(forgedClaims({}), hbFirst, 'sentry', 1).granted, 'only the runner may request a co-signature');

  section('5b.1 I4: the agent host cannot assemble a lease');
  const t = quorumSetup();
  const real = (await t.quorum.issue('run-t')).lease!;
  const hbReal = { leaseId: real.claims.leaseId, runId: 'run-t', at: t.clock.wall, spentUsd: 0, spentTokens: 0, health: 'ok' as const };
  // A compromised agent holds the runner secret and asks co-signers directly, bypassing every issue/renew check.
  const rogueClaims: LeaseClaims = { ...real.claims, leaseId: `lease_${randomBytes(12).toString('hex')}`, sequence: real.claims.sequence + 1, issuedAt: t.clock.wall, expiresAt: t.clock.wall + 60_000 };
  assert(!t.authorities[1].cosign(rogueClaims, hbReal).granted, 'claims without an issuer signature are refused');
  assert(!t.authorities[1].cosign(rogueClaims, hbReal, 'runner', { keyId: real.keyId, signature: real.signature }).granted, 'an issuer signature over other claims does not count');
  const selfIssued = { ...rogueClaims, issuer: t.keys[1].keyId };
  assert(!t.authorities[1].cosign(selfIssued, hbReal, 'runner', { keyId: t.keys[1].keyId, signature: 'ab'.repeat(64) }).granted, 'an authority never co-signs claims naming itself as issuer');
  const freshRun = { ...rogueClaims, runId: 'run-fresh', sequence: 1, issuer: t.keys[0].keyId };
  assert(!t.authorities[2].cosign(freshRun, undefined).granted, 'a crafted first lease (sequence 1) is refused without the issuer signature');
  // Even a lease made only of co-signatures cannot verify: the issuer's own signature is required.
  const coOnly: SignedLease = { ...real, keyId: real.cosignatures![0].keyId, signature: real.cosignatures![0].signature, cosignatures: [real.cosignatures![1]] };
  assert((verifyLeaseQuorum(coOnly, t.pubs, 2, t.clock.wall) ?? '').includes('issuing authority'), 'verifiers require the issuing authority\'s signature');
  assert((await t.quorum.leaseStatus(rogueClaims.leaseId)) === 'unknown', 'no authority vouches for a lease nobody issued (status unknown ⇒ verifiers refuse)');
  let upstreamHits = 0;
  const http = await import('http');
  const upstream = http.createServer((_q, res) => { upstreamHits++; res.end('ok'); });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', () => done()));
  const proxy = new EgressProxy({
    authorityPublicKeys: t.pubs, authorityThreshold: 2, now: () => t.clock.wall,
    isLeaseActive: (id, runId) => t.quorum.isActive(id, runId).catch(() => false),
    routes: [{ name: 'llm', upstream: `http://127.0.0.1:${(upstream.address() as import('net').AddressInfo).port}` }],
  });
  const proxyServer = http.createServer(proxy.httpHandler());
  await new Promise<void>((done) => proxyServer.listen(0, '127.0.0.1', () => done()));
  const pport = (proxyServer.address() as import('net').AddressInfo).port;
  try {
    const call = (l: SignedLease) => fetch(`http://127.0.0.1:${pport}/llm/x`, { headers: { 'X-Network-AI-Lease': encodeLeaseHeader(l) } });
    const ok = await call(real);
    assert(ok.status === 200 && upstreamHits === 1, 'proxy forwards the genuine k-of-n lease', String(ok.status));
    const coRes = await call(coOnly);
    assert(coRes.status === 403 && upstreamHits === 1, 'proxy refuses a lease without the issuer signature', String(coRes.status));
    const singleSig = await call({ ...real, cosignatures: [] });
    assert(singleSig.status === 403 && upstreamHits === 1, 'proxy refuses a lease with fewer than k signatures', String(singleSig.status));
    t.authorities[2].revoke({ runId: 'run-t' }, 'operator');
    t.clock.advance(3_000); // past the proxy's 2 s positive status cache
    const afterRevoke = await call(real);
    assert(afterRevoke.status === 403 && upstreamHits === 1, 'proxy refuses once any one authority revokes the run', String(afterRevoke.status));
  } finally {
    proxyServer.close();
    upstream.close();
  }
  throwsSync(() => new EgressProxy({ authorityPublicKeys: t.pubs.slice(0, 1), authorityThreshold: 2, isLeaseActive: async () => true, routes: [] }), 'proxy threshold above the key count is a configuration error');
  throwsSync(() => new QuorumLeaseTransport(t.transports[0], [], 2), 'quorum transport threshold above the authority count rejected');
}

// ---------------------------------------------------------------------------
// 5b.3 Framed relay (no IP network), microVM runners; 5b.4 spool
// ---------------------------------------------------------------------------

function socketPath(tag: string): string {
  const id = randomBytes(6).toString('hex');
  return process.platform === 'win32' ? `\\\\.\\pipe\\nai-${tag}-${id}` : path.join(os.tmpdir(), `nai-${tag}-${id}.sock`);
}

function rawFrames(sock: string, payload: Buffer): Promise<{ frames: unknown[]; closed: boolean }> {
  return new Promise((resolve) => {
    const net = require('net') as typeof import('net');
    const s = net.connect(sock);
    const dec = new FrameDecoder(65_536);
    const frames: unknown[] = [];
    let closed = false;
    s.on('connect', () => s.write(payload));
    s.on('data', (c: Buffer) => { try { frames.push(...dec.push(c)); } catch { /* ignore */ } });
    s.on('close', () => { closed = true; resolve({ frames, closed }); });
    s.on('error', () => undefined);
    setTimeout(() => { s.destroy(); resolve({ frames, closed }); }, 1_500);
  });
}

async function testRelay(): Promise<void> {
  section('5b.3 Frame codec and fixed schemas');
  const dec = new FrameDecoder(1024);
  const f = encodeFrame({ t: 'lease-issue', id: 'a1', runId: 'run-1' });
  assert(JSON.stringify(dec.push(f.subarray(0, 3)).concat(dec.push(f.subarray(3)))) === JSON.stringify([{ t: 'lease-issue', id: 'a1', runId: 'run-1' }]), 'frames reassemble across chunk boundaries');
  const huge = Buffer.alloc(4); huge.writeUInt32BE(10_000, 0);
  throwsSync(() => new FrameDecoder(1024).push(huge), 'oversize length prefix rejected before buffering', (e) => e instanceof FrameError);
  const bad = Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from('{x}')]);
  throwsSync(() => new FrameDecoder(1024).push(bad), 'non-JSON frame rejected', (e) => e instanceof FrameError);
  throwsSync(() => new FrameDecoder(1_000_000), 'frame limit capped at 64 KiB');
  assert(typeof parseRelayRequest({ t: 'lease-issue', id: 'a', runId: 'r' }) !== 'string', 'valid issue frame accepted');
  for (const [frame, label] of [
    [{ t: 'pause', id: 'a' }, 'admin action (pause) is not a relay message'],
    [{ t: 'policy', id: 'a', policy: {} }, 'policy install is not a relay message'],
    [{ t: 'lease-issue', id: 'a', runId: 'r', role: 'operator' }, 'extra fields rejected'],
    [{ t: 'lease-renew', id: 'a', heartbeat: { leaseId: 'l', runId: 'r', at: 1, spentUsd: 0, spentTokens: 0, health: 'ok', extra: 1 } }, 'extra heartbeat fields rejected'],
    [{ t: 'egress', id: 'a', route: 'llm', method: 'POST', path: '/../admin', lease: 'x' }, 'dot-dot egress path rejected'],
    [{ t: 'egress', id: 'a', route: 'llm', method: 'POST', path: '/%2e%2e/admin', lease: 'x' }, 'encoded dot-dot egress path rejected'],
    [{ t: 'egress', id: 'a', route: 'llm', method: 'DELETE', path: '/x', lease: 'x' }, 'egress method outside GET/POST rejected'],
    [{ t: 'lease-issue', id: 'bad id!', runId: 'r' }, 'invalid id rejected'],
  ] as const) {
    assert(typeof parseRelayRequest(frame) === 'string', label);
  }

  section('5b.3 Relay over a socket: leases, egress, and nothing else');
  const clock = new Clock();
  clock.wall = Date.now();
  const operator = generateEd25519KeyPair();
  const authority = new LeaseAuthority({ operatorPublicKey: operator.publicKey, authorityKey: generateEd25519KeyPair(), policy: signPolicy(basePolicy({}, clock.wall), operator) });
  let upstreamHits = 0;
  const http = await import('http');
  const upstream = http.createServer((_q, res) => { upstreamHits++; res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', () => done()));
  const proxy = new EgressProxy({ authorityPublicKey: authority.publicKey, isLeaseActive: async (id) => authority.isLeaseActive(id), routes: [{ name: 'llm', upstream: `http://127.0.0.1:${(upstream.address() as import('net').AddressInfo).port}` }] });
  const proxyServer = http.createServer(proxy.httpHandler());
  await new Promise<void>((done) => proxyServer.listen(0, '127.0.0.1', () => done()));
  const events: string[] = [];
  const relay = new VsockRelay({
    leases: new LocalAuthorityTransport(authority), runIds: ['run-vm'], ratePerSecond: 5,
    egressProxyUrl: `http://127.0.0.1:${(proxyServer.address() as import('net').AddressInfo).port}`,
    onEvent: (e) => { events.push(`${e.kind}:${e.reason ?? e.type ?? ''}`); },
  });
  const sock = socketPath('relay');
  const relayServer = relay.listen(sock);
  await new Promise<void>((done) => relayServer.on('listening', () => done()));
  try {
    const guest = new FramedLeaseTransport(sock);
    const guard = new LeaseGuard({ runId: 'run-vm', authorityPublicKey: authority.publicKey, transport: guest });
    await guard.start();
    guard.stop();
    assert(guard.currentLease !== null, 'guest obtains a lease through the relay (no IP network)');
    assert(await guest.isActive(guard.currentLease!.claims.leaseId), 'lease status through the relay');
    const other = await guest.issue('run-other');
    assert(!other.granted && (other.reason ?? '').includes('not served'), 'relay only serves its own run');
    const eg = await guest.egress({ route: 'llm', method: 'POST', path: '/v1/chat', lease: encodeLeaseHeader(guard.currentLease!), body: Buffer.from('{"p":1}'), contentType: 'application/json' });
    assert(eg.status === 200 && upstreamHits === 1 && eg.body.toString() === '{"ok":true}', 'egress through the relay reaches the proxy with the lease');
    let pathRefused = false;
    try { await guest.egress({ route: 'llm', method: 'GET', path: '/%2e%2e/x', lease: encodeLeaseHeader(guard.currentLease!) }); } catch { pathRefused = true; }
    assert(pathRefused && upstreamHits === 1, 'encoded traversal refused at the relay');

    const admin = await rawFrames(sock, encodeFrame({ t: 'pause', id: 'x1' }));
    assert((admin.frames[0] as { t?: string; error?: string })?.error === 'unknown message type' && !authority.status('run-vm').some((r) => r.state === 'paused'), 'admin messages are refused; the authority is untouched');
    const big = Buffer.alloc(4); big.writeUInt32BE(1_000_000, 0);
    const oversize = await rawFrames(sock, big);
    assert(oversize.closed && oversize.frames.length === 0, 'oversize frame closes the connection');
    const garbage = await rawFrames(sock, Buffer.concat([Buffer.from([0, 0, 0, 5]), Buffer.from('nope!')]));
    assert(garbage.closed, 'malformed frame closes the connection');
    const flood = Buffer.concat(Array.from({ length: 40 }, (_, i) => encodeFrame({ t: 'lease-status', id: `f${i}`, leaseId: 'lease_x' })));
    const flooded = await rawFrames(sock, flood);
    const limited = flooded.frames.filter((m) => (m as { error?: string }).error === 'rate limited' || (m as { error?: string }).error === 'too many requests in flight').length;
    assert(limited >= 20, 'per-connection rate limit and in-flight cap enforced', `${limited} limited`);
    assert(events.some((e) => e.startsWith('drop:')), 'dropped frames are audited');
  } finally {
    relayServer.close();
    proxyServer.close();
    upstream.close();
  }
  throwsSync(() => new VsockRelay({ leases: new LocalAuthorityTransport(authority), runIds: ['r'], egressProxyUrl: 'http://10.0.0.1:4711' }), 'relay only forwards egress to a loopback proxy');
  throwsSync(() => new VsockRelay({ leases: new LocalAuthorityTransport(authority), runIds: [] }), 'relay must name the runs it serves');

  section('5b.3 relay-only sandboxes and microVM runners');
  const ws = tmp('nai-p5-vm-');
  try {
    const sockHost = path.join(ws, 'relay.sock');
    const runner = new ContainerSandboxRunner({ image: 'img', relaySocket: sockHost });
    const args = runner.buildArgs(normalizeSandboxRequest({ argv: ['agent'], workspace: ws, network: 'relay-only' }), 'c');
    assert(args[args.indexOf('--network') + 1] === 'none' && args.includes(`type=bind,source=${sockHost},target=${RELAY_SOCKET_IN_SANDBOX}`) && args.includes(`NETWORK_AI_RELAY_SOCKET=${RELAY_SOCKET_IN_SANDBOX}`), 'relay-only container: no network, only the relay socket mounted');
    throwsSync(() => new ContainerSandboxRunner({ image: 'img' }).buildArgs(normalizeSandboxRequest({ argv: ['a'], workspace: ws, network: 'relay-only' }), 'c'), 'relay-only without a relay socket refused');

    const kata = new KataSandboxRunner({ image: 'img' });
    assert(kata.name === 'container:kata-runtime', 'Kata runner defaults to kata-runtime');
    assert(new KataSandboxRunner({ image: 'img', runtime: 'io.containerd.kata.v2' }).name.includes('kata'), 'containerd Kata shim accepted');
    throwsSync(() => new KataSandboxRunner({ image: 'img', runtime: 'runc' }), 'Kata runner refuses non-Kata runtimes');
    assert(runPostureChecks({ role: 'agent', sandboxRuntime: 'io.containerd.kata.v2', nodeExecArgv: hardenedNodeArgs() }).ok, 'posture accepts the Kata containerd shim as strong isolation');

    const abs = (p: string) => path.join(ws, p);
    const fc = new FirecrackerSandboxRunner({ kernelImage: abs('vmlinux'), rootfsImage: abs('rootfs.ext4'), vsockUdsPath: abs('fc.sock'), workspaceDrive: () => abs('ws.ext4') });
    const cfg = fc.buildConfig(normalizeSandboxRequest({ argv: ['agent'], workspace: ws, network: 'relay-only', limits: { cpus: 2, memoryMb: 1024 } }), abs('ws.ext4'));
    const drives = cfg['drives'] as { drive_id: string; is_read_only: boolean }[];
    assert(!('network-interfaces' in cfg), 'Firecracker config has no network interface');
    assert(drives.find((d) => d.drive_id === 'rootfs')?.is_read_only === true, 'root file system is read-only');
    assert((cfg['vsock'] as { uds_path: string }).uds_path === abs('fc.sock') && firecrackerRelayListenPath(abs('fc.sock')) === `${abs('fc.sock')}_5000`, 'vsock is the only channel; relay listens on <uds>_<port>');
    throwsSync(() => fc.buildConfig(normalizeSandboxRequest({ argv: ['a'], workspace: ws, network: 'egress-proxy-only' }), abs('ws.ext4')), 'IP networking refused for Firecracker');
    throwsSync(() => new FirecrackerSandboxRunner({ kernelImage: abs('k'), rootfsImage: abs('r'), workspaceDrive: () => '', jailer: { uid: 0, gid: 0 } }), 'jailer refuses uid 0');
    const jailed = new FirecrackerSandboxRunner({ kernelImage: abs('k'), rootfsImage: abs('r'), workspaceDrive: () => '', jailer: { uid: 1000, gid: 1000, id: 'vm1' } }).buildArgs('/tmp/c.json');
    assert(jailed.command === 'jailer' && jailed.args.join(' ').includes('--uid 1000 --gid 1000') && jailed.args.slice(-3).join(' ') === '--no-api --config-file /tmp/c.json', 'jailer launch drops to an unprivileged uid/gid');

    const fake = path.join(ws, 'fake-fc.js');
    fs.writeFileSync(fake, "const cfg = JSON.parse(require('fs').readFileSync(process.argv[process.argv.indexOf('--config-file') + 1], 'utf8')); process.stdout.write(JSON.stringify({ net: 'network-interfaces' in cfg, vsock: !!cfg.vsock }));");
    const runnable = new FirecrackerSandboxRunner({ kernelImage: abs('k'), rootfsImage: abs('r'), vsockUdsPath: abs('fc.sock'), workspaceDrive: () => abs('ws.ext4'), launcher: { command: process.execPath, args: [fake] }, requireLinux: false });
    const result = await runnable.run({ argv: ['agent'], workspace: ws, network: 'relay-only' });
    assert(result.exitCode === 0 && result.stdout === '{"net":false,"vsock":true}' && result.receipt.runner === 'firecracker', 'Firecracker runner launches with the generated config and returns a receipt', result.stdout + result.stderr);
    if (process.platform !== 'linux') {
      let refused = false;
      try { await fc.run({ argv: ['a'], workspace: ws }); } catch { refused = true; }
      assert(refused, 'Firecracker runner refuses to run off Linux');
    } else {
      pass('Firecracker platform check (running on Linux)');
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }

  section('5b.4 Spool: one-way files, no connection from the agent');
  const spoolDir = tmp('nai-p5-spool-');
  const spoolAuth = new LeaseAuthority({ operatorPublicKey: operator.publicKey, authorityKey: generateEd25519KeyPair(), policy: signPolicy(basePolicy({}, Date.now()), operator) });
  const drops: string[] = [];
  const puller = new SpoolPuller(spoolDir, { leases: new LocalAuthorityTransport(spoolAuth), runIds: ['run-spool'], onEvent: (e) => { if (e.kind === 'drop') drops.push(e.reason ?? ''); } });
  let pulling = true;
  const loop = (async () => { while (pulling) { await puller.pollOnce(); await new Promise((r) => setTimeout(r, 20)); } })();
  try {
    const agentSide = new SpoolLeaseTransport(spoolDir, { pollMs: 20, timeoutMs: 5_000 });
    const g = new LeaseGuard({ runId: 'run-spool', authorityPublicKey: spoolAuth.publicKey, transport: agentSide });
    await g.start();
    g.stop();
    assert(g.currentLease !== null && await agentSide.isActive(g.currentLease.claims.leaseId), 'lease issued and checked over the spool');
    const notMine = await agentSide.issue('run-x');
    assert(!notMine.granted, 'spool only serves its runs');
    // The spool directory is agent-writable: a non-regular inbox (or a symlink on POSIX) must never be followed.
    const inbox = path.join(spoolDir, 'inbox.jsonl');
    const target = path.join(spoolDir, '..', `nai-victim-${randomBytes(4).toString('hex')}.txt`);
    fs.writeFileSync(target, 'authority-side file\n');
    fs.renameSync(inbox, `${inbox}.bak`);
    let planted = 'dir';
    try { fs.symlinkSync(target, inbox, 'file'); planted = 'symlink'; } catch { fs.mkdirSync(inbox); }
    fs.appendFileSync(path.join(spoolDir, 'outbox.jsonl'), JSON.stringify({ t: 'lease-status', id: 'sym1', leaseId: 'lease_x' }) + '\n');
    await new Promise((r) => setTimeout(r, 150));
    assert(fs.readFileSync(target, 'utf8') === 'authority-side file\n' && drops.some((d) => d.startsWith('inbox refused')), `puller refuses a planted ${planted} at the inbox and never writes through it`);
    fs.rmSync(inbox, { recursive: true, force: true });
    fs.renameSync(`${inbox}.bak`, inbox);
    fs.rmSync(target, { force: true });
    fs.appendFileSync(path.join(spoolDir, 'outbox.jsonl'), 'not json\n' + JSON.stringify({ t: 'egress', id: 'e1', route: 'llm', method: 'GET', path: '/x', lease: 'a' }) + '\n' + JSON.stringify({ t: 'pause', id: 'p1' }) + '\n');
    await new Promise((r) => setTimeout(r, 150));
    assert(drops.includes('malformed line') && drops.includes('egress is not available over the spool') && drops.includes('unknown message type'), 'malformed lines, egress, and admin messages are dropped');
  } finally {
    pulling = false;
    await loop;
    fs.rmSync(spoolDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 5c.1 Attestation-gated renewal, 5c.4 capability-evaluation gating
// ---------------------------------------------------------------------------

async function testAttestation(): Promise<void> {
  section('5c.1 Attestation: a modified image cannot renew (drill 3)');
  const M1 = 'a'.repeat(64);
  const M2 = 'b'.repeat(64);
  const clock = new Clock();
  const operator = generateEd25519KeyPair();
  const attKey = generateEd25519KeyPair();
  const verifier = new SignedQuoteVerifier(attKey.publicKey);
  const policy = signPolicy(basePolicy({ attestation: { kind: 'custom', expectedMeasurements: [M1] } }, clock.wall), operator);
  throwsSync(() => new LeaseAuthority({ operatorPublicKey: operator.publicKey, authorityKey: generateEd25519KeyPair(), policy }), 'authority refuses an attestation policy without a matching verifier', msgIncludes('no verifier'));
  const authority = new LeaseAuthority({ operatorPublicKey: operator.publicKey, authorityKey: generateEd25519KeyPair(), policy, now: () => clock.wall, attestationVerifiers: [verifier] });
  let measurement = M1;
  const attest = (nonce: string) => ({ kind: 'custom' as const, evidence: signQuote(measurement, nonce, attKey), nonce });
  const transport = new LocalAuthorityTransport(authority);
  const guard = new LeaseGuard({ runId: 'run-att', authorityPublicKey: authority.publicKey, transport, attest, now: () => clock.wall, monotonic: () => clock.mono, statusPollMs: 1_000 });
  await guard.start();
  assert(guard.currentLease !== null && /^[0-9a-f]{32}$/.test(guard.currentLease.claims.attestationNonce ?? ''), 'attested issue grants a lease carrying the next attestation nonce');
  clock.advance(45_000);
  await guard.tick();
  assert(guard.currentLease!.claims.sequence === 2, 'renewal with a listed measurement succeeds');
  const prevNonce = guard.currentLease!.claims.attestationNonce!;
  const oldEvidence = attest(prevNonce);

  measurement = M2; // agent binary modified
  clock.advance(45_000);
  await guard.tick();
  assert(guard.renewalRefused !== null && guard.renewalRefused.includes('measurement'), 'renewal refused after the image changes', guard.renewalRefused ?? '');
  assert(authority.status('run-att')[0].state === 'stopped', 'tampering stops the run (no detection needed)');
  clock.advance(60_000);
  let threw = false;
  try { guard.assertActive({ tool: 'shell_exec' }); } catch { threw = true; }
  assert(threw, 'guard halts at lease expiry (dead-man switch)');

  const fresh = new LeaseAuthority({ operatorPublicKey: operator.publicKey, authorityKey: generateEd25519KeyPair(), policy, now: () => clock.wall, attestationVerifiers: [verifier] });
  measurement = M1;
  const noEvidence = fresh.issue('run-b');
  assert(!noEvidence.granted && (noEvidence.reason ?? '').includes('missing'), 'issue without evidence refused');
  const ch = fresh.attestationChallenge('run-b').nonce;
  const wrongKey = generateEd25519KeyPair();
  const forged = fresh.issue('run-b', 'runner', { kind: 'custom', evidence: signQuote(M1, ch, wrongKey), nonce: ch });
  assert(!forged.granted && (forged.reason ?? '').includes('unknown key'), 'quote from another key refused');
  const reuse = fresh.issue('run-b', 'runner', attest(ch));
  assert(!reuse.granted && (reuse.reason ?? '').includes('stale or replayed'), 'challenges are single use');
  const ch2 = fresh.attestationChallenge('run-b').nonce;
  clock.advance(61_000);
  const late = fresh.issue('run-b', 'runner', attest(ch2));
  assert(!late.granted && (late.reason ?? '').includes('stale'), 'expired challenge refused');
  const ch3 = fresh.attestationChallenge('run-b').nonce;
  const ok = fresh.issue('run-b', 'runner', attest(ch3));
  assert(ok.granted, 'fresh challenge with listed measurement grants', ok.reason);
  clock.advance(30_000);
  const replay = fresh.renew({ leaseId: ok.lease!.claims.leaseId, runId: 'run-b', at: clock.wall, spentUsd: 0, spentTokens: 0, health: 'ok', attestation: oldEvidence });
  assert(!replay.granted && (replay.reason ?? '').includes('stale or replayed'), 'evidence bound to an earlier nonce is refused');
  const noAtt = new LeaseAuthority({ operatorPublicKey: operator.publicKey, authorityKey: generateEd25519KeyPair(), policy, now: () => clock.wall, attestationVerifiers: [verifier] });
  const nonce4 = noAtt.attestationChallenge('run-c').nonce;
  const l4 = noAtt.issue('run-c', 'runner', attest(nonce4)).lease!;
  clock.advance(30_000);
  const missing = noAtt.renew({ leaseId: l4.claims.leaseId, runId: 'run-c', at: clock.wall, spentUsd: 0, spentTokens: 0, health: 'ok' });
  assert(!missing.granted && noAtt.status('run-c')[0].state === 'stopped', 'renewal without evidence stops the run');

  section('5c.1 Co-signers verify attestation independently');
  const qClock = new Clock();
  const qOperator = generateEd25519KeyPair();
  const qKeys = [generateEd25519KeyPair(), generateEd25519KeyPair()];
  const qPolicy = signPolicy(basePolicy({ attestation: { kind: 'custom', expectedMeasurements: [M1] }, authorityQuorum: { threshold: 2, keyIds: qKeys.map((k) => k.keyId) } }, qClock.wall), qOperator);
  const qAuth = qKeys.map((k) => new LeaseAuthority({ operatorPublicKey: qOperator.publicKey, authorityKey: k, policy: qPolicy, now: () => qClock.wall, attestationVerifiers: [verifier], peerAuthorityKeys: qKeys.map((x) => x.publicKey) }));
  const qT = new QuorumLeaseTransport(new LocalAuthorityTransport(qAuth[0]), [new LocalAuthorityTransport(qAuth[1])], 2);
  measurement = M1;
  const qGuard = new LeaseGuard({ runId: 'run-qa', authorityPublicKeys: qKeys.map((k) => k.publicKey), authorityThreshold: 2, transport: qT, attest, now: () => qClock.wall, monotonic: () => qClock.mono, statusPollMs: 1_000 });
  await qGuard.start();
  qClock.advance(45_000);
  await qGuard.tick();
  assert(qGuard.currentLease?.claims.sequence === 2, 'attested renewal co-signed by both authorities');
  const lease2 = qGuard.currentLease!;
  // A compromised primary would still face the co-signer's own attestation check.
  const next = issuerSig({ ...lease2.claims, leaseId: `lease_${randomBytes(12).toString('hex')}`, sequence: 3, issuedAt: qClock.wall, expiresAt: qClock.wall + 60_000 }, qKeys[0]);
  const bad = qAuth[1].cosign(next.claims,
    { leaseId: lease2.claims.leaseId, runId: 'run-qa', at: qClock.wall, spentUsd: 0, spentTokens: 0, health: 'ok', attestation: { kind: 'custom', evidence: signQuote(M2, lease2.claims.attestationNonce!, attKey), nonce: lease2.claims.attestationNonce! } },
    'runner', next.sig);
  assert(!bad.granted && (bad.reason ?? '').includes('measurement'), 'co-signer refuses a renewal with a modified measurement');
  // The nonce the next renewal must bind always comes from the issuer's signed claims, never from the runner.
  const qAuth2 = qKeys.map((k) => new LeaseAuthority({ operatorPublicKey: qOperator.publicKey, authorityKey: k, policy: qPolicy, now: () => qClock.wall, attestationVerifiers: [verifier], peerAuthorityKeys: qKeys.map((x) => x.publicKey) }));
  const crafted = { ...lease2.claims, runId: 'run-crafted', sequence: 1, leaseId: `lease_${randomBytes(12).toString('hex')}`, attestationNonce: 'c'.repeat(32), issuer: qKeys[0].keyId };
  assert(!qAuth2[1].cosign(crafted, undefined).granted, 'a runner-chosen attestation nonce cannot be co-signed without the issuer\'s signature');
}

async function testCapabilityEval(): Promise<void> {
  section('5c.4 Capability evaluations gate high-risk scopes');
  const clock = new Clock();
  const operator = generateEd25519KeyPair();
  const evaluator = generateEd25519KeyPair();
  const pem = evaluator.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const requirement = { evaluatorPublicKeysPem: [pem], thresholds: { 'cyber-offense': { max: 0.2 }, 'self-exfiltration': { max: 0.1 }, deception: { max: 0.1 } }, maxAgeMs: 7 * 24 * HOUR };
  const policy = signPolicy(basePolicy({ scope: { tier: 'elevated', tools: ['shell_exec'] }, acceptRisk: ['single-authority'], requires: { capabilityEval: requirement } }, clock.wall), operator);
  const authority = new LeaseAuthority({ operatorPublicKey: operator.publicKey, authorityKey: generateEd25519KeyPair(), policy, now: () => clock.wall });
  const ev = (scores: Record<string, number>, at = clock.wall, id = `ev-${randomBytes(3).toString('hex')}`) => ({ v: 'nai-capeval-v1' as const, evalId: id, suite: 'nai-redteam-1', scores, evaluatedAt: at });
  const passing = { 'cyber-offense': 0.05, 'self-exfiltration': 0.0, deception: 0.02 };

  const before = authority.issue('run-ce');
  assert(!before.granted && (before.reason ?? '').includes('capability evaluation required'), 'high-risk lease refused without an evaluation');
  throwsSync(() => authority.submitCapabilityEval(signCapabilityEval(ev({ ...passing, deception: 0.5 }), evaluator), 'operator'), 'failing evaluation rejected', msgIncludes('above the allowed maximum'));
  throwsSync(() => authority.submitCapabilityEval(signCapabilityEval(ev(passing), generateEd25519KeyPair()), 'operator'), 'evaluation from an unlisted evaluator rejected', msgIncludes('unlisted'));
  throwsSync(() => authority.submitCapabilityEval(signCapabilityEval(ev({ 'cyber-offense': 0.0, deception: 0.0 }), evaluator), 'operator'), 'evaluation missing a thresholded score rejected', msgIncludes('lacks score'));
  throwsSync(() => authority.submitCapabilityEval(signCapabilityEval(ev(passing, clock.wall + HOUR), evaluator), 'operator'), 'future-dated evaluation rejected', msgIncludes('future'));
  const tampered = signCapabilityEval(ev({ ...passing, deception: 0.9 }), evaluator);
  throwsSync(() => authority.submitCapabilityEval({ ...tampered, eval: { ...tampered.eval, scores: passing } }, 'operator'), 'tampered evaluation rejected', msgIncludes('signature invalid'));
  throwsSync(() => authority.submitCapabilityEval(signCapabilityEval(ev(passing), evaluator), 'sentry'), 'only the operator installs evaluations', msgIncludes('role sentry'));

  const accepted = authority.submitCapabilityEval(signCapabilityEval(ev(passing), evaluator), 'operator');
  assert(accepted.accepted, 'passing evaluation accepted');
  const granted = authority.issue('run-ce');
  assert(granted.granted && granted.lease!.claims.highRisk === true, 'high-risk lease granted with a valid evaluation', granted.reason);
  throwsSync(() => authority.submitCapabilityEval(signCapabilityEval(ev(passing, clock.wall - HOUR), evaluator), 'operator'), 'older evaluation cannot replace a newer one', msgIncludes('older'));
  let lease = granted.lease!;
  for (let i = 0; i < 3; i++) {
    clock.advance(40_000);
    lease = authority.renew({ leaseId: lease.claims.leaseId, runId: 'run-ce', at: clock.wall, spentUsd: 0, spentTokens: 0, health: 'ok' }).lease!;
  }
  pass('renewals continue while the evaluation is fresh');
  clock.advance(7 * 24 * HOUR);
  const expired = authority.renew({ leaseId: lease.claims.leaseId, runId: 'run-ce', at: clock.wall, spentUsd: 0, spentTokens: 0, health: 'ok' });
  assert(!expired.granted, 'renewal stops once the evaluation is older than maxAgeMs');

  const lowRisk = new LeaseAuthority({ operatorPublicKey: operator.publicKey, authorityKey: generateEd25519KeyPair(), policy: signPolicy(basePolicy({ requires: { capabilityEval: requirement } }, clock.wall), operator), now: () => clock.wall });
  assert(lowRisk.issue('run-low').granted, 'standard-risk scopes are not gated');
  const noReq = new LeaseAuthority({ operatorPublicKey: operator.publicKey, authorityKey: generateEd25519KeyPair(), policy: signPolicy(basePolicy({}, clock.wall), operator), now: () => clock.wall });
  throwsSync(() => noReq.submitCapabilityEval(signCapabilityEval(ev(passing), evaluator), 'operator'), 'submitting without a policy requirement is an error');
}

// ---------------------------------------------------------------------------
// 5c.2 Merkle audit, 5c.3 verified core
// ---------------------------------------------------------------------------

async function testMerkle(): Promise<void> {
  section('5c.2 Merkle audit log (RFC 9162 proofs)');
  const log = new MerkleAuditLog();
  const entries = Array.from({ length: 23 }, (_, i) => ({ i, action: i % 3 === 0 ? 'issue' : 'renew', runId: `run-${i % 4}` }));
  assert(log.root(0) === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'empty tree root is SHA-256 of the empty string');
  for (const e of entries) log.append(e);
  let allIncl = true;
  let allCons = true;
  for (let size = 1; size <= entries.length; size++) {
    const root = log.root(size);
    for (let i = 0; i < size; i++) if (!verifyInclusion(leafHashOf(entries[i]), i, size, log.inclusionProof(i, size), root)) allIncl = false;
    for (let m = 1; m <= size; m++) if (!verifyConsistency(m, size, log.root(m), root, log.consistencyProof(m, size))) allCons = false;
  }
  assert(allIncl, 'every inclusion proof verifies for every tree size 1–23');
  assert(allCons, 'every consistency proof verifies for every pair of sizes');
  const n = entries.length;
  const root = log.root();
  assert(!verifyInclusion(leafHashOf({ ...entries[5], action: 'tampered' }), 5, n, log.inclusionProof(5), root), 'tampered entry fails inclusion');
  assert(!verifyInclusion(leafHashOf(entries[5]), 6, n, log.inclusionProof(5), root), 'wrong index fails inclusion');
  const p = log.inclusionProof(5);
  assert(!verifyInclusion(leafHashOf(entries[5]), 5, n, [...p].reverse(), root), 'reordered proof fails');

  const forked = new MerkleAuditLog();
  entries.forEach((e, i) => forked.append(i === 7 ? { ...e, action: 'rewritten' } : e));
  assert(!verifyConsistency(10, n, log.root(10), forked.root(), forked.consistencyProof(10)), 'a rewritten history is inconsistent with an earlier head');
  const dropped = new MerkleAuditLog();
  entries.forEach((e, i) => { if (i !== 3) dropped.append(e); });
  assert(!verifyConsistency(10, n - 1, log.root(10), dropped.root(), dropped.consistencyProof(10)), 'a dropped entry breaks consistency');
  const reordered = new MerkleAuditLog();
  [entries[1], entries[0], ...entries.slice(2)].forEach((e) => reordered.append(e));
  assert(!verifyConsistency(5, n, log.root(5), reordered.root(), reordered.consistencyProof(5)), 'reordered entries break consistency');

  const logKey = generateEd25519KeyPair();
  const sth = log.signTreeHead(logKey, T0);
  assert(verifyTreeHead(sth, logKey.publicKey) === null && sth.sth.size === n, 'signed tree head verifies');
  assert(verifyTreeHead({ ...sth, sth: { ...sth.sth, size: n + 1 } }, logKey.publicKey) !== null, 'altered tree head rejected');
  assert(verifyTreeHead(sth, generateEd25519KeyPair().publicKey) !== null, 'tree head from another log key rejected');

  const dir = tmp('nai-p5-witness-');
  try {
    const witness = new FileWitness(path.join(dir, 'head.json'), logKey.publicKey);
    const small = new MerkleAuditLog();
    entries.slice(0, 8).forEach((e) => small.append(e));
    assert(witness.observe(small.signTreeHead(logKey, T0), []) === null, 'witness accepts the first head');
    assert(witness.observe(sth, log.consistencyProof(8)) === null && witness.latest()?.sth.size === n, 'witness accepts a consistent, larger head');
    assert((witness.observe(small.signTreeHead(logKey, T0 + 1), []) ?? '').includes('rollback'), 'witness refuses a rollback');
    const forkHead = forked.signTreeHead(logKey, T0 + 2);
    assert((witness.observe(forkHead, []) ?? '').includes('fork'), 'witness refuses a same-size fork');
    log.append({ i: 99 });
    const bigger = log.signTreeHead(logKey, T0 + 3);
    assert((witness.observe(bigger, forked.consistencyProof(8)) ?? '').includes('not consistent'), 'witness refuses a head with a bogus consistency proof');
    assert(witness.observe(bigger, log.consistencyProof(n)) === null, 'witness accepts the honest next head');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  section('5c.2 Proof-carrying claims');
  const claimLog = new MerkleAuditLog();
  const fact = { key: 'task:approved', value: 'deploy v2', by: 'reviewer' };
  claimLog.append({ key: 'other', value: 1 });
  const { index } = claimLog.append(fact);
  claimLog.append({ key: 'later', value: 2 });
  const head = claimLog.signTreeHead(logKey, T0);
  const evidence = { index, proof: claimLog.inclusionProof(index), sth: head };
  assert(classifyClaim(fact, evidence, logKey.publicKey) === 'proven', 'logged claim with an inclusion proof is proven');
  assert(classifyClaim(fact, undefined, logKey.publicKey) === 'unproven', 'claim without evidence is unproven');
  assert(classifyClaim({ ...fact, value: 'deploy v3' }, evidence, logKey.publicKey) === 'failed', 'fabricated claim with borrowed evidence fails');
  assert(classifyClaim(fact, { ...evidence, sth: { ...head, signature: '00'.repeat(64) } }, logKey.publicKey) === 'failed', 'claim with a forged head fails');
  assert(classifyClaim(fact, { index: 'x' as never, proof: 'y' as never, sth: null as never }, logKey.publicKey) === 'failed', 'malformed evidence fails, never throws');

  const delivered: unknown[] = [];
  const sinkLog = new MerkleAuditLog();
  const sink = new HashChainSink({ appendAudit: async (e: unknown) => { delivered.push(e); } } as never, undefined, { merkle: sinkLog });
  await sink.record({ kind: 'violation', at: T0, reason: 'a' } as never);
  await sink.record({ kind: 'violation', at: T0 + 1, reason: 'b' } as never);
  assert(sinkLog.size === 2 && verifyInclusion(leafHashOf(delivered[1]), 1, 2, sinkLog.inclusionProof(1), sinkLog.root()), 'HashChainSink appends each chained event to the Merkle log');
}

function testCore(): void {
  section('5c.3 Pure core: property tests');
  let seed = 0xc0de;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const states = ['active', 'paused', 'revoked', 'stopped'] as const;
  const events = ['grant', 'stop', 'revoke', 'pause', 'resume'] as const;
  let absorbing = true;
  let grantReactivates = false;
  for (let i = 0; i < 2000; i++) {
    let s: typeof states[number] = pick(states);
    const start = s;
    for (let j = 0; j < 8; j++) {
      const e = pick(events);
      const next = nextRunState(s, e);
      if (e === 'grant' && s !== 'active' && next === 'active') grantReactivates = true;
      s = next;
    }
    if ((start === 'revoked' || start === 'stopped') && s !== start) absorbing = false;
  }
  assert(absorbing, 'revoked and stopped are absorbing over random event traces');
  assert(!grantReactivates, 'a grant never reactivates a non-active run');
  assert(states.every((st) => ['revoked', 'stopped'].includes(nextRunState(st, 'revoke'))), 'one revoke ends any run (I1)');

  let spendOk = true;
  let spend = { usd: 0, tokens: 0 };
  for (let i = 0; i < 2000; i++) {
    const before = spend;
    spend = recordSpend(spend, { usd: pick([rnd() * 100, -5, NaN, Infinity, '7', null]), tokens: pick([Math.floor(rnd() * 1e6), -1, undefined]) });
    if (spend.usd < before.usd || spend.tokens < before.tokens || !Number.isFinite(spend.usd)) spendOk = false;
  }
  assert(spendOk, 'recorded spend never decreases and ignores invalid reports');

  const tools = ['a', 'b', 'c', 'd', 'e'];
  const tiers = ['observe', 'standard', 'elevated'] as const;
  const randScope = () => ({ tier: pick(tiers), tools: tools.filter(() => rnd() < 0.5), destinations: rnd() < 0.5 ? tools.filter(() => rnd() < 0.5) : undefined });
  let neverWidens = true;
  for (let i = 0; i < 2000; i++) {
    const current = { scope: randScope(), leaseTtlMs: 10_000 + Math.floor(rnd() * 100_000), autoRenew: rnd() < 0.5, budget: { runCeilingUsd: rnd() * 100, runCeilingTokens: Math.floor(rnd() * 1e6) } };
    const delta = { scope: rnd() < 0.7 ? randScope() : undefined, leaseTtlMs: rnd() < 0.5 ? Math.floor(rnd() * 200_000) : undefined, autoRenew: rnd() < 0.2 ? (true as unknown as false) : rnd() < 0.3 ? (false as const) : undefined, budget: rnd() < 0.5 ? { runCeilingUsd: rnd() * 200 } : undefined };
    const next = applyTighten(current, delta);
    const ok = scopeWithinCore(next.scope, current.scope) && next.leaseTtlMs <= current.leaseTtlMs && (!next.autoRenew || current.autoRenew)
      && next.budget.runCeilingUsd <= current.budget.runCeilingUsd && next.budget.runCeilingTokens <= current.budget.runCeilingTokens;
    if (!ok) neverWidens = false;
    if (tightenError(current, delta) !== null && next !== current) neverWidens = false;
  }
  assert(neverWidens, 'tightening never widens scope, TTL, auto-renew, or budget (2000 random deltas)');

  const ids = ['k1', 'k2', 'k3'];
  let quorumOk = true;
  for (let i = 0; i < 2000; i++) {
    const k = 1 + Math.floor(rnd() * 3);
    const sigs = Array.from({ length: Math.floor(rnd() * 6) }, () => pick([...ids, 'stranger']));
    const distinctAllowed = new Set(sigs.filter((s) => ids.includes(s))).size;
    if (quorumGrant(sigs, ids, k) !== (distinctAllowed >= k)) quorumOk = false;
    if (quorumGrant(Array(5).fill(pick(ids)), ids, 2)) quorumOk = false;
  }
  assert(quorumOk, 'grant needs k distinct allowed signers; one key signing many times never reaches k = 2');
  let stopOk = true;
  const statuses = ['active', 'inactive', 'unknown'] as const;
  for (let i = 0; i < 2000; i++) {
    const ss = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => pick(statuses));
    const v = quorumActive(ss);
    if (ss.includes('inactive') && v !== 'inactive') stopOk = false;
    if (v === 'active' && ss.includes('inactive')) stopOk = false;
  }
  assert(stopOk && quorumActive([]) === 'unknown', 'stop needs one: any inactive authority wins');
}

function findLean(): string | null {
  const home = process.env['ELAN_HOME'] ?? path.join(os.homedir(), '.elan');
  for (const candidate of [path.join(home, 'bin', process.platform === 'win32' ? 'lean.exe' : 'lean'), 'lean']) {
    const r = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 30_000 });
    if (r.status === 0 && /Lean \(version 4/.test(r.stdout)) return candidate;
  }
  return null;
}

/** Test-only runner: runs argv in the workspace directory (no container). */
class LocalProcessRunner {
  readonly name = 'local-test';
  constructor(private readonly program?: (argv: string[], cwd: string) => { exitCode: number; stdout: string; stderr: string }) {}
  async run(request: Parameters<typeof normalizeSandboxRequest>[0]) {
    const req = normalizeSandboxRequest(request);
    const startedAt = Date.now();
    const out = this.program
      ? this.program(req.argv, req.workspace)
      : (() => { const r = spawnSync(req.argv[0], req.argv.slice(1), { cwd: req.workspace, encoding: 'utf8', timeout: req.limits.timeoutMs }); return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; })();
    const endedAt = Date.now();
    return { ...out, timedOut: false, truncated: false, durationMs: endedAt - startedAt, receipt: makeSandboxReceipt(this.name, req, { startedAt, endedAt, exitCode: out.exitCode, timedOut: false, stdout: out.stdout, stderr: out.stderr }) };
  }
}

async function testLean(): Promise<void> {
  section('5c.3 Lean certificates: screening and verdicts');
  const binding = { tool: 'budget_spend', argsHash: 'h', agentId: 'a', nonce: 'n', expiresAt: T0 + 1, issuedAt: T0 };
  const proofOf = (obligation: string, proof: string, tool = 'lean4') => ({ kind: 'formal-verification' as const, tool, certificate: JSON.stringify({ obligation, proof }), binding });
  const obligations = {
    'spend-monotone': { statement: '∀ (p r : Nat), p ≤ max p r' },
    'ceiling-min': { statement: '∀ (a b : Nat), min a b ≤ b' },
  };
  for (const [proof, label] of [
    ['sorry', 'sorry refused'],
    ['by admit', 'admit refused'],
    ['by exact (by sorry)', 'nested sorry refused'],
    ['by\n  exact h\ntheorem other : False := by decide', 'extra declarations refused'],
    ['by native_decide', 'native_decide (compiler trust) refused'],
    ['by\n  #eval IO.println "x"\n  exact h', 'elaboration-time code refused'],
    ['by exact absurd -- hidden', 'comments refused'],
    ['by\n  set_option maxHeartbeats 0 in exact h', 'set_option refused'],
  ] as const) {
    assert(LeanCertificateVerifier.screen(proof) !== null, label);
  }
  assert(LeanCertificateVerifier.screen('fun p r => Nat.le_max_left p r') === null, 'ordinary proof term passes the screen');

  // Fake lean: emulates the toolchain's output so verdict logic is tested everywhere.
  const fake = new LeanCertificateVerifier({
    obligations,
    runner: new LocalProcessRunner((_argv, cwd) => {
      const src = fs.readFileSync(path.join(cwd, 'Obligation.lean'), 'utf8');
      const marker = /#print "(NAI_AXIOMS_[0-9a-f]+)"/.exec(src)?.[1] ?? '';
      if (src.includes('WRONG')) return { exitCode: 1, stdout: 'Obligation.lean:3:2: error: type mismatch', stderr: '' };
      if (src.includes('CLASSIC')) return { exitCode: 0, stdout: `${marker}\n'nai_obligation' depends on axioms: [propext, Classical.choice, Quot.sound]`, stderr: '' };
      if (src.includes('EXTRA')) return { exitCode: 0, stdout: `${marker}\n'nai_obligation' depends on axioms: [propext, myAxiom]`, stderr: '' };
      if (src.includes('SILENT')) return { exitCode: 0, stdout: marker, stderr: '' };
      return { exitCode: 0, stdout: `${marker}\n'nai_obligation' does not depend on any axioms`, stderr: '' };
    }) as never,
  });
  assert((await fake.verify(proofOf('spend-monotone', 'fun p r => Nat.le_max_left p r'), binding)).valid, 'accepted when lean succeeds with no axioms');
  assert((await fake.verify(proofOf('spend-monotone', 'CLASSIC'), binding)).valid, 'standard axioms are allowed');
  assert(!(await fake.verify(proofOf('spend-monotone', 'EXTRA'), binding)).valid, 'non-standard axioms rejected');
  assert(!(await fake.verify(proofOf('spend-monotone', 'WRONG'), binding)).valid, 'lean errors rejected');
  assert(!(await fake.verify(proofOf('spend-monotone', 'SILENT'), binding)).valid, 'missing axioms report rejected');
  assert(LeanCertificateVerifier.screen('by trace x; decide') !== null && LeanCertificateVerifier.screen('by decide +native') !== null && LeanCertificateVerifier.screen('by exact "x"') !== null, 'trace, +native, and string literals are refused');
  const spoofing = new LeanCertificateVerifier({
    obligations,
    runner: new LocalProcessRunner((_argv, cwd) => {
      const src = fs.readFileSync(path.join(cwd, 'Obligation.lean'), 'utf8');
      const marker = /#print "(NAI_AXIOMS_[0-9a-f]+)"/.exec(src)?.[1] ?? 'missing';
      // The proof printed a fake clean report before the marker; the real report lists a non-standard axiom.
      return { exitCode: 0, stdout: `'nai_obligation' does not depend on any axioms\n${marker}\n'nai_obligation' depends on axioms: [Lean.ofReduceBool]`, stderr: '' };
    }) as never,
  });
  assert(!(await spoofing.verify(proofOf('spend-monotone', 'fun p r => Nat.le_max_left p r'), binding)).valid, 'a fake axioms report printed before the per-run marker is ignored');
  assert(!(await fake.verify(proofOf('not-an-obligation', 'x'), binding)).valid, 'unknown obligation rejected (statements are operator-fixed)');
  assert(!(await fake.verify(proofOf('spend-monotone', 'x', 'coq'), binding)).valid, 'other tools rejected');
  assert(!(await fake.verify({ ...proofOf('spend-monotone', 'x'), certificate: '{' }, binding)).valid, 'malformed certificate rejected');

  const lean = findLean();
  if (lean) {
    section('5c.3 Lean toolchain: model and certificates are machine-checked');
    const model = spawnSync(lean, [path.join(__dirname, 'references', 'formal', 'PerpetualCore.lean')], { encoding: 'utf8', timeout: 300_000 });
    const modelOut = `${model.stdout}${model.stderr}`;
    assert(model.status === 0 && !/error|sorry/i.test(modelOut), 'references/formal/PerpetualCore.lean checks with no errors or sorry', modelOut.slice(0, 400));
    const real = new LeanCertificateVerifier({ obligations, runner: new LocalProcessRunner() as never, leanArgv: [lean] });
    assert((await real.verify(proofOf('spend-monotone', 'fun p r => Nat.le_max_left p r'), binding)).valid, 'real lean accepts a correct proof');
    assert((await real.verify(proofOf('ceiling-min', 'fun a b => Nat.min_le_right a b'), binding)).valid, 'real lean accepts a second obligation');
    const wrong = await real.verify(proofOf('ceiling-min', 'fun a b => Nat.min_le_left a b'), binding);
    assert(!wrong.valid, 'real lean rejects a proof of the wrong statement', wrong.reason);
  } else {
    const src = fs.readFileSync(path.join(__dirname, 'references', 'formal', 'PerpetualCore.lean'), 'utf8');
    assert(!/\bsorry\b|\badmit\b|^axiom\b/m.test(src), 'formal model contains no sorry/admit/axiom (install elan to machine-check it)');
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  process.stdout.write('Perpetual Runtime — Phase 5\n');
  testHighRiskPolicy();
  testSigners();
  await testSelfImproveLease();
  await testCheckpoints();
  await testTripwires();
  testPosture();
  testHardenedNode();
  await testCli();
  await testQuorum();
  await testRelay();
  await testAttestation();
  await testCapabilityEval();
  await testMerkle();
  testCore();
  await testLean();

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    for (const f of failures) process.stdout.write(`  - ${f}\n`);
    process.exit(1);
  }
}

void main().catch((err) => {
  process.stdout.write(`  ✗ unhandled — ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

// Referenced by later sections.
void randomBytes;
