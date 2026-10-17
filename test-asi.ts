/**
 * test-asi.ts — ASI Strict Mode (opt-in, `ASI_STRICT_MODE=audit|enforce`).
 *
 * Covers: config (fail-closed parsing, tighten-only), trust tiers, proof-gated
 * actions (HMAC + Ed25519 capabilities, replay, binding, expiry, external
 * authority), BFT consensus (geometric median, Byzantine minority, quorum,
 * model-family diversity, signed ballots), blackboard auditor receipts,
 * Password-Activated Shutdown (input-stream, HTTP, resume), canaries,
 * hash-chained event export, trust-tiered context, cognitive caps, and the
 * GovernedModelGateway / AgentRuntime / MCP bridge integrations — plus
 * unchanged behaviour when strict mode is off.
 *
 * No secrets are hard-coded: every key and token is generated at runtime.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { randomBytes, generateKeyPairSync } from 'crypto';
import type { AddressInfo } from 'net';
import {
  AgentTrustLevel,
  AsiHaltedError,
  AsiPolicyError,
  BallotSigner,
  CanaryRegistry,
  CapabilityIssuer,
  ConsensusEngine,
  HaltCoordinator,
  HashChainSink,
  ProofGate,
  ReceiptSigner,
  SignedAttestationVerifier,
  canonicalJson,
  claimVerifierCheck,
  createAsiConfig,
  createAuditorValidator,
  createTrustResolver,
  generateShutdownToken,
  geometricMedian,
  getAsiConfig,
  hashShutdownToken,
  parseStrictMode,
  resolveTrustLevel,
  tightenAsiConfig,
  verifyEventChain,
} from './lib/asi';
import type {
  AsiEvent,
  AsiStrictConfig,
  AsiStrictConfigInput,
  ChainedAsiEvent,
  ConsensusBallot,
  ConsensusEvaluator,
  ProofGatePolicy,
} from './lib/asi';
import { LockedBlackboard } from './lib/locked-blackboard';
import { ContextComposer } from './lib/context-composer';
import type { ContextSource } from './lib/context-composer';
import { EffortPolicy } from './lib/effort-policy';
import { ThinkingBlockManager } from './lib/thinking-blocks';
import { GovernedModelGateway } from './lib/model-gateway';
import type { ModelRequest, ModelResponse } from './lib/model-gateway';
import { AgentRuntime } from './lib/agent-runtime';
import { McpCombinedBridge } from './lib/mcp-transport-sse';
import type { McpToolProvider } from './lib/mcp-transport-sse';
import type { MCPToolDefinition } from './lib/mcp-blackboard-tools';

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
async function rejects(fn: () => Promise<unknown>, check: (e: unknown) => boolean, label: string): Promise<void> {
  try {
    await fn();
    fail(label, 'expected rejection');
  } catch (e) {
    assert(check(e), label, `unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
function throwsSync(fn: () => unknown, label: string): void {
  try { fn(); fail(label, 'expected throw'); } catch { pass(label); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A config plus the events it emitted. */
function cfg(input: AsiStrictConfigInput = {}): { config: AsiStrictConfig; events: AsiEvent[] } {
  const events: AsiEvent[] = [];
  const config = createAsiConfig({ sink: { record: (e) => { events.push(e); } }, ...input });
  return { config, events };
}

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-asi-'));
  tmpDirs.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// Config & trust
// ---------------------------------------------------------------------------

function testConfig(): void {
  section('Config');
  assert(parseStrictMode(undefined) === 'off', 'unset → off');
  assert(parseStrictMode('false') === 'off' && parseStrictMode('0') === 'off', 'false/0 → off');
  assert(parseStrictMode('audit') === 'audit' && parseStrictMode('dry-run') === 'audit', 'audit/dry-run → audit');
  assert(parseStrictMode('true') === 'enforce' && parseStrictMode('enforce') === 'enforce', 'true/enforce → enforce');
  assert(parseStrictMode('typo-value') === 'enforce', 'unknown value fails closed to enforce');
  assert(getAsiConfig().mode === 'off', 'process default is off when ASI_STRICT_MODE is unset');

  const { config } = cfg({ mode: 'enforce', auditors: ['aud'] });
  assert(Object.isFrozen(config) && Object.isFrozen(config.auditors), 'config is deep-frozen');
  throwsSync(() => { (config.auditors as string[]).push('x'); }, 'cannot mutate auditors');
  throwsSync(() => createAsiConfig({ lowTrustBelow: 2 }), 'invalid lowTrustBelow rejected');
  throwsSync(() => createAsiConfig({ consensus: { protocol: 'cp-wbft', maxFaulty: -1 } }), 'invalid maxFaulty rejected');
}

function testTrust(): void {
  section('Trust tiers');
  const { config } = cfg({ mode: 'enforce', auditors: ['aud'] });
  assert(resolveTrustLevel('a', 0.2, config) === AgentTrustLevel.LOW, 'score below 0.4 → LOW');
  assert(resolveTrustLevel('a', 0.9, config) === AgentTrustLevel.HIGH, 'high score → HIGH');
  assert(resolveTrustLevel('a', undefined, config) === AgentTrustLevel.LOW, 'unknown score → LOW');
  assert(resolveTrustLevel('a', 1, config) !== AgentTrustLevel.AUDITOR, 'score alone never yields AUDITOR');
  assert(resolveTrustLevel('aud', 0, config) === AgentTrustLevel.AUDITOR, 'operator-designated auditor → AUDITOR');
  const resolver = createTrustResolver({ getTrustLevel: (id) => { if (id === 'boom') throw new Error('x'); return id === 'good' ? 0.8 : 0.1; } }, config);
  assert(resolver('good') === AgentTrustLevel.HIGH && resolver('bad') === AgentTrustLevel.LOW, 'resolver maps AuthGuardian-style scores');
  assert(resolver('boom') === AgentTrustLevel.LOW && resolver(undefined) === AgentTrustLevel.LOW, 'resolver fails closed to LOW');
  assert(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }) === canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }), 'canonical JSON ignores key order');
}

// ---------------------------------------------------------------------------
// Proof gate
// ---------------------------------------------------------------------------

async function testProofGate(): Promise<void> {
  section('Proof-carrying actions');
  const secret = randomBytes(32);
  const issuer = new CapabilityIssuer('ops', { alg: 'hmac-sha256', secret });
  const verifier = new SignedAttestationVerifier([{ name: 'ops', alg: 'hmac-sha256', key: secret }]);
  const policy: ProofGatePolicy = { gatedTools: ['shell_exec'], verifiers: [verifier] };
  const { config, events } = cfg({ mode: 'enforce' });
  const gate = new ProofGate(policy, config);
  const args = { command: 'node --version' };

  const proof = issuer.issue('shell_exec', args, 'agent-1');
  let d = await gate.check({ tool: 'shell_exec', args, agentId: 'agent-1', proof });
  assert(d.allowed && d.gated, 'valid HMAC capability allowed');
  d = await gate.check({ tool: 'shell_exec', args, agentId: 'agent-1', proof });
  assert(!d.allowed, 'replayed capability rejected', d.violation);

  const p2 = issuer.issue('shell_exec', args, 'agent-1');
  d = await gate.check({ tool: 'shell_exec', args: { command: 'node -e 1' }, agentId: 'agent-1', proof: p2 });
  assert(!d.allowed, 'capability for different args rejected');
  const p3 = issuer.issue('shell_exec', args, 'agent-1');
  d = await gate.check({ tool: 'shell_exec', args, agentId: 'agent-2', proof: p3 });
  assert(!d.allowed, 'capability for a different agent rejected');
  const p4 = issuer.issue('file_write', args, 'agent-1');
  d = await gate.check({ tool: 'shell_exec', args, agentId: 'agent-1', proof: p4 });
  assert(!d.allowed, 'capability for a different tool rejected');

  const expiring = issuer.issue('shell_exec', args, 'agent-1', 1);
  await sleep(10);
  d = await gate.check({ tool: 'shell_exec', args, agentId: 'agent-1', proof: expiring });
  assert(!d.allowed, 'expired capability rejected');

  d = await gate.check({ tool: 'shell_exec', args, agentId: 'agent-1' });
  assert(!d.allowed, 'missing proof rejected');

  const forged = new CapabilityIssuer('ops', { alg: 'hmac-sha256', secret: randomBytes(32) }).issue('shell_exec', args, 'agent-1');
  d = await gate.check({ tool: 'shell_exec', args, agentId: 'agent-1', proof: forged });
  assert(!d.allowed, 'capability signed with the wrong key rejected');
  const untrusted = new CapabilityIssuer('mallory', { alg: 'hmac-sha256', secret }).issue('shell_exec', args, 'agent-1');
  d = await gate.check({ tool: 'shell_exec', args, agentId: 'agent-1', proof: untrusted });
  assert(!d.allowed, 'capability from an untrusted signer rejected');

  d = await gate.check({ tool: 'blackboard_read', args: {}, agentId: 'agent-1' });
  assert(d.allowed && !d.gated, 'ungated tool passes without proof');
  assert(events.some((e) => e.kind === 'proof' && e.outcome === 'denied'), 'denials emitted to the event sink');

  // Ed25519
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const edIssuer = new CapabilityIssuer('hsm', { alg: 'ed25519', privateKey });
  const edGate = new ProofGate({ gatedTools: ['shell_exec'], verifiers: [new SignedAttestationVerifier([{ name: 'hsm', alg: 'ed25519', key: publicKey }])] }, config);
  d = await edGate.check({ tool: 'shell_exec', args, agentId: 'a', proof: edIssuer.issue('shell_exec', args, 'a') });
  assert(d.allowed, 'valid Ed25519 capability allowed');
  const otherKey = generateKeyPairSync('ed25519').privateKey;
  d = await edGate.check({ tool: 'shell_exec', args, agentId: 'a', proof: new CapabilityIssuer('hsm', { alg: 'ed25519', privateKey: otherKey }).issue('shell_exec', args, 'a') });
  assert(!d.allowed, 'Ed25519 capability from the wrong key rejected');

  // External authority co-sign
  const authGate = new ProofGate({ ...policy, authority: { authorize: async () => ({ approved: false, reason: 'quorum said no' }) } }, config);
  d = await authGate.check({ tool: 'shell_exec', args, agentId: 'agent-1', proof: issuer.issue('shell_exec', args, 'agent-1') });
  assert(!d.allowed, 'external authority veto blocks a valid proof');
  const okGate = new ProofGate({ ...policy, authority: { authorize: async () => ({ approved: true }) } }, config);
  d = await okGate.check({ tool: 'shell_exec', args, agentId: 'agent-1', proof: issuer.issue('shell_exec', args, 'agent-1') });
  assert(d.allowed, 'external authority approval allows a valid proof');

  // Audit and off modes
  const audit = cfg({ mode: 'audit' });
  const auditGate = new ProofGate(policy, audit.config);
  d = await auditGate.check({ tool: 'shell_exec', args, agentId: 'agent-1' });
  assert(d.allowed && d.violation !== undefined, 'audit mode allows but reports the violation');
  assert(audit.events.some((e) => e.outcome === 'would-deny'), 'audit mode emits would-deny');
  const offGate = new ProofGate(policy, createAsiConfig({ mode: 'off' }));
  assert(!offGate.requiresProof('shell_exec'), 'off mode requires no proofs');
  throwsSync(() => new CapabilityIssuer('x', { alg: 'hmac-sha256', secret: randomBytes(8) }), 'short HMAC key rejected');
}

// ---------------------------------------------------------------------------
// Consensus
// ---------------------------------------------------------------------------

function ballot(id: string, family: string, scores: number[], decision: ConsensusBallot['decision'] = 'approve', confidence = 0.9): ConsensusBallot {
  return { evaluatorId: id, modelFamily: family, scores, confidence, decision };
}

async function testConsensus(): Promise<void> {
  section('BFT consensus');
  const med = geometricMedian([[0], [0.1], [0], [100]]);
  assert(Math.abs(med[0]) < 0.2, 'geometric median resists an extreme outlier', String(med[0]));

  const { config } = cfg({ mode: 'enforce' });
  const engine = new ConsensusEngine({ protocol: 'cp-wbft', maxFaulty: 1 }, { config });
  assert(engine.quorum === 4, 'quorum is 3f+1');
  const honest = [ballot('e1', 'claude', [0.9, 0.8]), ballot('e2', 'gpt', [0.85, 0.82]), ballot('e3', 'gemini', [0.88, 0.79])];

  let r = engine.aggregate([...honest, ballot('e4', 'llama', [0.9, 0.81])]);
  assert(r.accepted && r.outliers.length === 0, 'unanimous honest evaluators accept', r.reason);
  r = engine.aggregate([...honest, ballot('evil', 'llama', [0, 0], 'reject', 1)]);
  assert(r.accepted && r.outliers.includes('evil'), 'single Byzantine evaluator is outvoted and flagged', r.reason);
  r = engine.aggregate([honest[0], honest[1], ballot('x1', 'a', [0, 0], 'reject'), ballot('x2', 'b', [0.05, 0], 'reject')]);
  assert(!r.accepted, 'two faulty out of four (f=1) does not reach consensus');
  r = engine.aggregate(honest);
  assert(!r.accepted && /quorum/.test(r.reason ?? ''), 'below quorum rejected');
  r = engine.aggregate([...honest, { ...honest[0] }]);
  assert(!r.accepted, 'duplicate evaluator ballots counted once');
  r = engine.aggregate([...honest, ballot('bad', 'x', [Number.NaN, 1])]);
  assert(!r.accepted, 'malformed ballots dropped');

  const diverse = new ConsensusEngine({ protocol: 'geometric-median', maxFaulty: 1, minModelFamilies: 3 }, { config });
  r = diverse.aggregate([ballot('a', 'claude', [1]), ballot('b', 'claude', [1]), ballot('c', 'claude', [1]), ballot('d', 'gpt', [1])]);
  assert(!r.accepted && /famil/.test(r.reason ?? ''), 'model-family diversity enforced');

  const signer = new BallotSigner(randomBytes(32));
  const signed = new ConsensusEngine({ protocol: 'cp-wbft', maxFaulty: 1 }, { config, verifyBallot: (b) => signer.verify(b) });
  const good = [...honest, ballot('e4', 'llama', [0.9, 0.81])].map((b) => signer.sign(b));
  assert(signed.aggregate(good).accepted, 'signed ballots accepted');
  const tampered = good.map((b, i) => (i === 0 ? { ...b, decision: 'reject' as const } : b));
  assert(!signed.aggregate(tampered).accepted, 'tampered ballot dropped (quorum lost)');

  const evaluators: ConsensusEvaluator[] = ['claude', 'gpt', 'gemini', 'llama'].map((family, i) => ({
    id: `ev${i}`,
    modelFamily: family,
    evaluate: async () => ballot('impersonated', 'same', [0.9, 0.8]),
  }));
  r = await engine.decide({ proposal: 'deploy' }, evaluators);
  assert(r.accepted && new Set(r.ballots.map((b) => b.evaluatorId)).size === 4, 'evaluators cannot impersonate each other');
  const slow = new ConsensusEngine({ protocol: 'cp-wbft', maxFaulty: 1 }, { config, evaluatorTimeoutMs: 50 });
  r = await slow.decide({ proposal: 'deploy' }, [...evaluators, { id: 'hang', modelFamily: 'x', evaluate: () => new Promise<ConsensusBallot>(() => undefined) }]);
  assert(r.accepted && r.ballots.length === 4, 'hung evaluator times out without blocking consensus');
}

// ---------------------------------------------------------------------------
// Blackboard receipts
// ---------------------------------------------------------------------------

async function testReceipts(): Promise<void> {
  section('Blackboard auditor receipts');
  const signer = new ReceiptSigner(randomBytes(32));
  const { config, events } = cfg({ mode: 'enforce', auditors: ['auditor-1'] });
  const trustOf = (id: string | undefined) => (id === 'high-agent' ? AgentTrustLevel.HIGH : AgentTrustLevel.LOW);
  const bb = new LockedBlackboard(tmpDir(), { disableWal: true, asi: { trustOf, receipts: signer, config } });
  const auditor = createAuditorValidator({ auditorId: 'auditor-1', signer, check: () => true });

  let id = bb.propose('plan', { step: 1 }, 'low-agent');
  bb.validate(id, 'peer');
  let c = bb.commit(id);
  assert(!c.success && /ASI/.test(c.message), 'LOW-trust commit without receipt blocked', c.message);
  assert(events.some((e) => e.kind === 'blackboard' && e.outcome === 'denied'), 'blocked commit emitted');

  id = bb.propose('plan', { step: 2 }, 'low-agent');
  const v = await bb.validateWithAuditor(id, auditor);
  assert(v.validated && v.receipt?.verdict === 'approved', 'auditor validation issues an approving receipt');
  c = bb.commit(id, v.receipt);
  assert(c.success, 'LOW-trust commit with auditor receipt succeeds', c.message);

  const a = bb.propose('k2', 'value-a', 'low-agent');
  const b = bb.propose('k3', 'value-b', 'low-agent');
  const ra = await bb.validateWithAuditor(a, auditor);
  await bb.validateWithAuditor(b, auditor);
  c = bb.commit(b, ra.receipt);
  assert(!c.success, 'receipt for another change rejected');
  const forgedReceipt = { ...ra.receipt!, valueHash: '0'.repeat(64) };
  c = bb.commit(a, forgedReceipt);
  assert(!c.success, 'tampered receipt rejected');
  c = bb.commit(a, ra.receipt);
  assert(c.success, 'original receipt still valid for its change');

  const rogue = createAuditorValidator({ auditorId: 'rogue', signer, check: () => true });
  id = bb.propose('k4', 1, 'low-agent');
  const rr = await bb.validateWithAuditor(id, rogue);
  c = bb.commit(id, rr.receipt);
  assert(!c.success && /auditor/.test(c.message), 'receipt from a non-designated auditor rejected', c.message);

  const rejecting = createAuditorValidator({ auditorId: 'auditor-1', signer, check: () => false });
  id = bb.propose('k5', 1, 'low-agent');
  const rj = await bb.validateWithAuditor(id, rejecting);
  assert(!rj.validated && rj.receipt?.verdict === 'rejected', 'auditor rejection leaves change unvalidated');

  const shortSigner = new ReceiptSigner(randomBytes(32), 1);
  const bb2 = new LockedBlackboard(tmpDir(), { disableWal: true, asi: { trustOf, receipts: shortSigner, config } });
  id = bb2.propose('k', 1, 'low-agent');
  const er = await bb2.validateWithAuditor(id, createAuditorValidator({ auditorId: 'auditor-1', signer: shortSigner, check: () => true }));
  await sleep(10);
  c = bb2.commit(id, er.receipt);
  assert(!c.success && /expired/.test(c.message), 'expired receipt rejected', c.message);

  id = bb.propose('k6', 1, 'high-agent');
  bb.validate(id, 'peer');
  assert(bb.commit(id).success, 'HIGH-trust commit needs no receipt');

  const audit = cfg({ mode: 'audit', auditors: ['auditor-1'] });
  const bbAudit = new LockedBlackboard(tmpDir(), { disableWal: true, asi: { trustOf, receipts: signer, config: audit.config } });
  id = bbAudit.propose('k', 1, 'low-agent');
  bbAudit.validate(id, 'peer');
  assert(bbAudit.commit(id).success, 'audit mode commits without receipt');
  assert(audit.events.some((e) => e.outcome === 'would-deny'), 'audit mode reports would-deny');

  const bbOff = new LockedBlackboard(tmpDir(), { disableWal: true, asi: { trustOf, receipts: signer, config: createAsiConfig({ mode: 'off' }) } });
  id = bbOff.propose('k', 1, 'low-agent');
  bbOff.validate(id, 'peer');
  assert(bbOff.commit(id).success, 'off mode leaves commits unchanged');

  const bbPlain = new LockedBlackboard(tmpDir(), { disableWal: true });
  id = bbPlain.propose('k', 1, 'any');
  bbPlain.validate(id, 'peer');
  assert(bbPlain.commit(id).success, 'blackboard without asi options unchanged');

  // ClaimVerifier-backed check
  const verifierOk = { verify: () => ({ unsupportedCount: 0, undisclosedActions: [] as unknown[] }) };
  const verifierBad = { verify: () => ({ unsupportedCount: 1, undisclosedActions: [] as unknown[] }) };
  const subject = { change_id: 'c', key: 'k', value: 1, previous_hash: null, source_agent: 'a' };
  assert(claimVerifierCheck(verifierOk, () => [])(subject) === true, 'ClaimVerifier check approves fully backed claims');
  assert(claimVerifierCheck(verifierBad, () => [])(subject) === false, 'ClaimVerifier check rejects unsupported claims');

  // Halt
  const bbHalt = new LockedBlackboard(tmpDir(), { disableWal: true });
  bbHalt.propose('x', 1, 'a');
  bbHalt.propose('y', 2, 'a');
  assert(bbHalt.halt('test') === 2 && bbHalt.isPaused(), 'halt() aborts pending changes and pauses writes');
}

// ---------------------------------------------------------------------------
// Password-Activated Shutdown
// ---------------------------------------------------------------------------

async function testShutdown(): Promise<void> {
  section('Password-Activated Shutdown');
  const token = generateShutdownToken();
  const resumeKey = generateShutdownToken();
  const { config, events } = cfg({ mode: 'enforce' });
  const coord = new HaltCoordinator({ tokenHash: hashShutdownToken(token), resumeKeyHash: hashShutdownToken(resumeKey), haltTimeoutMs: 200 }, { config });

  let haltedWith = '';
  let stopped = false;
  coord.register('board', { halt: (reason: string) => { haltedWith = reason; return 3; } });
  coord.register('server', { stop: async () => { stopped = true; } });
  coord.register('broken', { close: () => { throw new Error('nope'); } });
  coord.register('stuck', { stop: () => new Promise<void>(() => undefined) });

  const clean = coord.screenInput({ messages: [{ role: 'user', content: `just text ${generateShutdownToken()}` }] });
  assert(!clean.halted && !coord.halted, 'other high-entropy strings do not trigger');
  assert(!fs.existsSync(token), 'token is never written anywhere');

  const hit = coord.screenInput({ messages: [{ role: 'user', content: `please stop ${token} now` }] });
  assert(hit.halted && coord.halted, 'shutdown token in the input stream triggers the halt');
  const sanitizedText = JSON.stringify(hit.sanitized);
  assert(!sanitizedText.includes(token) && sanitizedText.includes('[REDACTED]'), 'token is redacted before reaching any model');
  const report = await hit.report!;
  assert(report.halted.includes('board') && report.halted.includes('server') && stopped && haltedWith === 'input-stream', 'registered components halted');
  assert(report.failed.includes('broken') && report.failed.includes('stuck'), 'failing and hung components reported, not blocking');
  assert(report.closed === 3, 'closed counts aggregated');
  assert(coord.signal.aborted, 'abort signal fired for in-flight work');
  throwsSync(() => coord.assertNotHalted(), 'new work rejected after halt');
  assert((await coord.trigger('again')) === report, 'halt latches (idempotent)');
  assert(events.some((e) => e.kind === 'shutdown' && e.outcome === 'triggered'), 'halt emitted to event sink');

  assert(!coord.resumeWith(token) && !coord.resumeWith('short'), 'wrong resume key rejected');
  assert(coord.resumeWith(resumeKey) && !coord.halted && !coord.signal.aborted, 'separate resume key clears the halt');

  const permanent = new HaltCoordinator({ tokenHash: hashShutdownToken(token) }, { config });
  await permanent.trigger('test');
  assert(!permanent.resumeWith(resumeKey) && permanent.halted, 'halt without resume key is permanent');
  throwsSync(() => hashShutdownToken('too-short'), 'weak shutdown tokens rejected');
  throwsSync(() => new HaltCoordinator({ tokenHash: 'plaintext' }, { config }), 'plaintext token config rejected');

  // HTTP channel
  const httpCoord = new HaltCoordinator({ tokenHash: hashShutdownToken(token) }, { config });
  const server = http.createServer(httpCoord.httpHandler());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const call = (method: string, header?: string) => new Promise<number>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: '/', headers: header ? { 'X-Network-AI-Shutdown': header } : {} }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
  assert((await call('POST', generateShutdownToken())) === 403, 'HTTP: wrong token → 403');
  assert((await call('GET', token)) === 403, 'HTTP: GET rejected');
  assert(!httpCoord.halted, 'HTTP: not halted by bad requests');
  assert((await call('POST', token)) === 202 && httpCoord.halted, 'HTTP: correct token → 202 and halt');
  for (let i = 0; i < 4; i++) await call('POST', 'x');
  assert((await call('POST', token)) === 429, 'HTTP: brute force rate-limited');
  await new Promise<void>((r) => server.close(() => r()));
}

// ---------------------------------------------------------------------------
// Canaries & event chain
// ---------------------------------------------------------------------------

async function testCanaryAndChain(): Promise<void> {
  section('Canaries & tamper-evident export');
  const { config, events } = cfg({ mode: 'enforce' });
  const canaries = new CanaryRegistry(config);
  const c = canaries.create('billing-db-password');
  assert(canaries.scan('nothing to see').length === 0, 'no false positive on clean text');
  assert(canaries.scan(`leak: ${c}`)[0]?.label === 'billing-db-password', 'canary detected in text');
  assert(canaries.scan({ nested: [{ v: c }] }).length === 1, 'canary detected in nested objects');
  assert(canaries.check(`x ${c}`, 'agent-1') && events.some((e) => e.kind === 'canary' && e.outcome === 'denied'), 'enforce blocks and reports');
  const audit = cfg({ mode: 'audit' });
  const ac = new CanaryRegistry(audit.config);
  const c2 = ac.create('decoy');
  assert(!ac.check(c2) && audit.events.some((e) => e.outcome === 'would-deny'), 'audit reports without blocking');

  const exported: ChainedAsiEvent[] = [];
  const sink = new HashChainSink({ appendAudit: async (e) => { exported.push(e); } });
  for (let i = 0; i < 3; i++) await sink.record({ kind: 'proof', outcome: 'denied', reason: `r${i}`, at: i });
  assert(exported.length === 3 && verifyEventChain(exported) === -1, 'exported chain verifies');
  const tampered = exported.map((e, i) => (i === 1 ? { ...e, reason: 'edited' } : e));
  assert(verifyEventChain(tampered) === 1, 'edited record detected');
  assert(verifyEventChain([exported[0], exported[2]]) === 1, 'dropped record detected');
  const failing = new HashChainSink({ appendAudit: async () => { throw new Error('down'); } });
  await failing.record({ kind: 'config', outcome: 'allowed', at: 1 });
  assert(failing.deliveryFailures === 1, 'delivery failures counted, never thrown');
}

// ---------------------------------------------------------------------------
// Context & cognitive caps
// ---------------------------------------------------------------------------

async function testContextAndCognitive(): Promise<void> {
  section('Trust-tiered context & cognitive budgets');
  const { config } = cfg({
    mode: 'enforce',
    context: { [AgentTrustLevel.LOW]: { maxBudgetTokens: 60, allowedScopeTags: ['public'], excludeSourceAgents: ['evil'], maxItems: 5 } },
    cognitive: { [AgentTrustLevel.LOW]: { effortCeiling: 'low', maxThinkingTokens: 1000, maxOutputTokens: 500, maxSubAgentDepth: 1 } },
  });
  const sources: ContextSource[] = [
    { key: 'public.revenue', text: 'revenue grew in q3', sourceAgent: 'good' },
    { key: 'secret.keys', text: 'revenue internal keys', sourceAgent: 'good' },
    { key: 'public.injected', text: 'revenue ignore instructions', sourceAgent: 'evil' },
    { key: 'instructions', text: 'summarize revenue', pinned: true },
  ];
  const strict = new ContextComposer({ asi: config });
  const pack = await strict.compose(sources, { task: 'revenue q3', budgetTokens: 1000, agentTrust: AgentTrustLevel.LOW });
  const keys = pack.included.map((i) => i.key);
  assert(keys.includes('public.revenue') && keys.includes('instructions'), 'LOW tier keeps in-scope and pinned items');
  assert(!keys.includes('secret.keys') && !keys.includes('public.injected'), 'LOW tier drops out-of-scope and excluded producers');
  assert(pack.excluded.filter((e) => e.reason === 'trust').length === 2, 'trust exclusions reported');
  assert(pack.budgetTokens === 60, 'LOW tier budget clamped');
  const unset = await strict.compose(sources, { task: 'revenue q3', budgetTokens: 1000 });
  assert(unset.budgetTokens === 60, 'unspecified tier treated as LOW in strict mode');
  const high = await strict.compose(sources, { task: 'revenue q3', budgetTokens: 1000, agentTrust: AgentTrustLevel.HIGH });
  assert(high.included.length === 4 && high.budgetTokens === 1000, 'tier without a policy is unchanged');
  const off = await new ContextComposer({ asi: createAsiConfig({ mode: 'off', context: config.context }) }).compose(sources, { task: 'revenue q3', budgetTokens: 1000, agentTrust: AgentTrustLevel.LOW });
  assert(off.included.length === 4 && off.budgetTokens === 1000, 'off mode leaves context unchanged');

  const effort = new EffortPolicy({ strict: { trustOf: () => AgentTrustLevel.LOW, config } });
  assert(effort.resolve('max', { agentId: 'x' }) === 'low', 'LOW tier effort clamped to ceiling');
  assert(effort.cognitiveBudget('x')?.maxThinkingTokens === 1000, 'cognitive budget resolved for tier');
  const effortOff = new EffortPolicy({ strict: { trustOf: () => AgentTrustLevel.LOW, config: createAsiConfig({ mode: 'off', cognitive: config.cognitive }) } });
  assert(effortOff.resolve('max', { agentId: 'x' }) === 'max' && effortOff.cognitiveBudget('x') === undefined, 'off mode leaves effort unchanged');
  const tbm = new ThinkingBlockManager();
  const budget = effort.cognitiveBudget('x');
  assert(tbm.capThinkingBudget(5000, budget) === 1000 && tbm.capThinkingBudget(200, budget) === 200, 'thinking budget capped');
  assert(tbm.capThinkingBudget(undefined, budget) === 1000 && tbm.capThinkingBudget(5000, undefined) === 5000, 'thinking budget default and passthrough');
}

// ---------------------------------------------------------------------------
// Gateway integration
// ---------------------------------------------------------------------------

function recordingCaller(text: () => string): { caller: (r: ModelRequest) => Promise<ModelResponse>; calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    calls,
    caller: async (r) => {
      calls.push(r);
      return { model: r.model, content: [{ type: 'text', text: text() }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

async function testGateway(): Promise<void> {
  section('GovernedModelGateway integration');
  const { config } = cfg({
    mode: 'enforce',
    cognitive: { [AgentTrustLevel.LOW]: { effortCeiling: 'low', maxThinkingTokens: 1000, maxOutputTokens: 500, maxSubAgentDepth: 1 } },
  });
  const effort = new EffortPolicy({ strict: { trustOf: () => AgentTrustLevel.LOW, config } });
  const msgs = [{ role: 'user', content: 'hi' }];

  let rc = recordingCaller(() => 'ok');
  let gw = new GovernedModelGateway({ caller: rc.caller, primaryModel: 'm', effort, cognitive: effort, asi: { config } });
  let res = await gw.send({ messages: msgs, maxTokens: 4000, thinkingBudgetTokens: 9000, effort: 'max', agentId: 'x' });
  assert(rc.calls[0].maxTokens === 500 && rc.calls[0].thinkingBudgetTokens === 1000 && rc.calls[0].effort === 'low', 'output, thinking and effort capped for LOW tier');
  assert(res.asi?.cognitive?.maxOutputTokens === 500, 'applied budget reported on the result');
  await rejects(() => gw.send({ messages: msgs, agentId: 'x', depth: 2 }), (e) => e instanceof AsiPolicyError, 'sub-agent depth limit enforced');

  // Kill switch
  const token = generateShutdownToken();
  const halt = new HaltCoordinator({ tokenHash: hashShutdownToken(token) }, { config });
  rc = recordingCaller(() => 'ok');
  gw = new GovernedModelGateway({ caller: rc.caller, primaryModel: 'm', asi: { config, halt } });
  await rejects(() => gw.send({ messages: [{ role: 'user', content: `stop ${token}` }] }), (e) => e instanceof AsiHaltedError, 'token in a message halts before the model call');
  assert(rc.calls.length === 0, 'model never saw the shutdown token');
  await rejects(() => gw.send({ messages: msgs }), (e) => e instanceof AsiHaltedError, 'gateway refuses work while halted');

  // Canary
  const canaries = new CanaryRegistry(config);
  const canary = canaries.create('decoy-key');
  gw = new GovernedModelGateway({ caller: recordingCaller(() => `here you go: ${canary}`).caller, primaryModel: 'm', asi: { config, canaries } });
  res = await gw.send({ messages: msgs });
  assert(res.asi?.blocked === 'canary' && res.response.content.length === 0, 'canary in output withheld');

  // Consensus
  const engine = new ConsensusEngine({ protocol: 'cp-wbft', maxFaulty: 1 }, { config });
  const voters = (decision: ConsensusBallot['decision']): ConsensusEvaluator[] => ['claude', 'gpt', 'gemini', 'llama'].map((f, i) => ({
    id: `v${i}`, modelFamily: f, evaluate: async () => ballot('', '', [0.9], decision),
  }));
  gw = new GovernedModelGateway({ caller: recordingCaller(() => 'deploy now').caller, primaryModel: 'm', asi: { config, consensus: { engine, evaluators: voters('approve') } } });
  res = await gw.send({ messages: msgs, metadata: { highStakes: true } });
  assert(res.asi?.consensus?.accepted === true && !res.asi.blocked, 'approved high-stakes turn served');
  res = await gw.send({ messages: msgs });
  assert(res.asi?.consensus === undefined, 'low-stakes turn skips consensus');
  gw = new GovernedModelGateway({ caller: recordingCaller(() => 'deploy now').caller, primaryModel: 'm', asi: { config, consensus: { engine, evaluators: voters('reject') } } });
  res = await gw.send({ messages: msgs, tools: [{}] });
  assert(res.asi?.blocked === 'consensus' && res.response.content.length === 0, 'rejected tool-use turn withheld');
  const audit = cfg({ mode: 'audit' });
  const auditEngine = new ConsensusEngine({ protocol: 'cp-wbft', maxFaulty: 1 }, { config: audit.config });
  gw = new GovernedModelGateway({ caller: recordingCaller(() => 'deploy now').caller, primaryModel: 'm', asi: { config: audit.config, consensus: { engine: auditEngine, evaluators: voters('reject') } } });
  res = await gw.send({ messages: msgs, metadata: { highStakes: true } });
  assert(!res.asi?.blocked && res.asi?.consensus?.accepted === false && res.response.content.length === 1, 'audit mode serves but records the failed consensus');

  // Off
  const offCfg = createAsiConfig({ mode: 'off', cognitive: config.cognitive });
  const offEffort = new EffortPolicy({ strict: { trustOf: () => AgentTrustLevel.LOW, config: offCfg } });
  rc = recordingCaller(() => `text ${canary}`);
  gw = new GovernedModelGateway({ caller: rc.caller, primaryModel: 'm', effort: offEffort, cognitive: offEffort, asi: { config: offCfg, canaries, halt, consensus: { engine, evaluators: voters('reject') } } });
  res = await gw.send({ messages: [{ role: 'user', content: `x ${token}` }], maxTokens: 4000, effort: 'max', depth: 9, metadata: { highStakes: true } });
  assert(res.asi === undefined && rc.calls[0].maxTokens === 4000 && rc.calls[0].effort === 'max' && res.response.content.length === 1, 'off mode: gateway behaviour unchanged');
}

// ---------------------------------------------------------------------------
// AgentRuntime integration
// ---------------------------------------------------------------------------

async function testRuntime(): Promise<void> {
  section('AgentRuntime integration');
  const secret = randomBytes(32);
  const issuer = new CapabilityIssuer('ops', { alg: 'hmac-sha256', secret });
  const { config } = cfg({ mode: 'enforce' });
  const gate = new ProofGate({ gatedTools: ['shell_exec', 'file_write'], verifiers: [new SignedAttestationVerifier([{ name: 'ops', alg: 'hmac-sha256', key: secret }])] }, config);
  const base = tmpDir();
  const rt = new AgentRuntime({ policy: { basePath: base, allowedCommands: ['node *'] }, autoApproveAll: true, asi: { proofGate: gate, config } });

  await rejects(() => rt.exec('node --version', 'agent-1'), (e) => e instanceof AsiPolicyError, 'exec without proof blocked');
  const proof = issuer.issue('shell_exec', rt.shellProofArgs('node   "--version"'), 'agent-1');
  const out = await rt.exec('node --version', 'agent-1', { proof });
  assert(out.exitCode === 0 && /^v\d+/.test(out.stdout.trim()), 'exec with proof bound to the canonical command runs');
  const wrong = issuer.issue('shell_exec', rt.shellProofArgs('node --help'), 'agent-1');
  await rejects(() => rt.exec('node --version', 'agent-1', { proof: wrong }), (e) => e instanceof AsiPolicyError, 'proof for another command blocked');

  let w = await rt.writeFile('data/out.txt', 'hello', 'agent-1');
  assert(!w.success, 'write without proof blocked');
  w = await rt.writeFile('data/out.txt', 'hello', 'agent-1', { proof: issuer.issue('file_write', rt.writeProofArgs('data/out.txt', 'hello'), 'agent-1') });
  assert(w.success, 'write with proof bound to path and content succeeds', w.error);
  w = await rt.writeFile('data/out.txt', 'tampered', 'agent-1', { proof: issuer.issue('file_write', rt.writeProofArgs('data/out.txt', 'hello'), 'agent-1') });
  assert(!w.success, 'proof for different content blocked');
  w = await rt.writeFile('evil.ts', 'x', 'agent-1', { proof: issuer.issue('file_write', rt.writeProofArgs('evil.ts', 'x'), 'agent-1') });
  assert(!w.success && rt.policy.getConfig().sourceProtection === true, 'enforce mode forces sourceProtection');

  // Env scrubbing
  const key = `ASI_TEST_${randomBytes(4).toString('hex').toUpperCase()}`;
  process.env[key] = randomBytes(8).toString('hex');
  try {
    const noGate = new ProofGate({ gatedTools: [], verifiers: [] }, config);
    const strictRt = new AgentRuntime({ policy: { basePath: base, allowedCommands: ['node *'] }, autoApproveAll: true, asi: { proofGate: noGate, config } });
    const scrubbed = await strictRt.exec(`node -p process.env.${key}`, 'a');
    assert(scrubbed.stdout.trim() === 'undefined', 'enforce mode withholds secret-like env vars from children', scrubbed.stdout);
    const plainRt = new AgentRuntime({ policy: { basePath: base, allowedCommands: ['node *'] }, autoApproveAll: true });
    const visible = await plainRt.exec(`node -p process.env.${key}`, 'a');
    assert(visible.stdout.trim() === process.env[key], 'runtime without strict mode unchanged');
  } finally {
    delete process.env[key];
  }

  // Halt
  const token = generateShutdownToken();
  const halt = new HaltCoordinator({ tokenHash: hashShutdownToken(token), haltTimeoutMs: 2000 }, { config });
  fs.writeFileSync(path.join(base, 'hang.js'), 'setInterval(() => {}, 1000);\n');
  const haltRt = new AgentRuntime({ policy: { basePath: base, allowedCommands: ['node *'] }, autoApproveAll: true, asi: { halt, config } });
  halt.register('runtime', haltRt);
  const running = haltRt.exec('node hang.js', 'a', { timeoutMs: 20_000 });
  await sleep(500);
  const report = await halt.trigger('test');
  const finished = await running;
  assert(report.closed >= 1 && finished.exitCode !== 0, 'halt kills running child processes');
  await rejects(() => haltRt.exec('node --version', 'a'), (e) => e instanceof AsiHaltedError, 'runtime refuses work while halted');
}

// ---------------------------------------------------------------------------
// MCP integration
// ---------------------------------------------------------------------------

async function testMcp(): Promise<void> {
  section('MCP requires_formal_proof');
  const received: Record<string, unknown>[] = [];
  const defs: MCPToolDefinition[] = [
    { name: 'danger', description: 'd', inputSchema: { type: 'object', properties: {} }, requires_formal_proof: true, risk_tier: 'critical' },
    { name: 'safe', description: 's', inputSchema: { type: 'object', properties: {} } },
  ];
  const provider: McpToolProvider = {
    getDefinitions: () => defs,
    call: async (tool, args) => { received.push(args); return { ok: true, tool }; },
  };
  const secret = randomBytes(32);
  const issuer = new CapabilityIssuer('ops', { alg: 'hmac-sha256', secret });
  const { config } = cfg({ mode: 'enforce' });
  const bridge = new McpCombinedBridge();
  bridge.register(provider);
  bridge.useProofGate(new ProofGate({ gatedTools: [], verifiers: [new SignedAttestationVerifier([{ name: 'ops', alg: 'hmac-sha256', key: secret }])] }, config));
  const call = (name: string, args: Record<string, unknown>) => bridge.handleRPC({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

  let r = await call('danger', { x: 1, agentId: 'a' });
  assert(r.error !== undefined && received.length === 0, 'flagged tool without proof rejected');
  const proof = issuer.issue('danger', { x: 1, agentId: 'a' }, 'a');
  r = await call('danger', { x: 1, agentId: 'a', __proof: proof });
  assert(r.error === undefined && received.length === 1 && !('__proof' in received[0]), 'flagged tool with proof runs; proof stripped from args');
  r = await call('danger', { x: 2, agentId: 'a', __proof: issuer.issue('danger', { x: 1, agentId: 'a' }, 'a') });
  assert(r.error !== undefined, 'proof bound to other arguments rejected');
  r = await call('safe', { y: 1, __proof: 'junk' });
  assert(r.error === undefined && !('__proof' in received[received.length - 1]), 'unflagged tool runs; stray __proof stripped');

  const offBridge = new McpCombinedBridge();
  offBridge.useProofGate(new ProofGate({ gatedTools: [], verifiers: [] }, createAsiConfig({ mode: 'off' })));
  offBridge.register(provider);
  r = await offBridge.handleRPC({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'danger', arguments: {} } });
  assert(r.error === undefined, 'off mode: flagged tools run without proof');
}

// ---------------------------------------------------------------------------
// Tighten-only (mutates the process-wide config — runs last)
// ---------------------------------------------------------------------------

function testTightenOnly(): void {
  section('Tighten-only runtime config');
  const sinkA = { record: () => undefined };
  let c = tightenAsiConfig({ mode: 'audit', auditors: ['aud'], sink: sinkA });
  assert(c.mode === 'audit' && getAsiConfig().mode === 'audit', 'off → audit allowed');
  throwsSync(() => tightenAsiConfig({ mode: 'off' }), 'audit → off rejected');
  throwsSync(() => tightenAsiConfig({ auditors: ['aud', 'intruder'] }), 'adding auditors at runtime rejected');
  throwsSync(() => tightenAsiConfig({ lowTrustBelow: 0.1 }), 'lowering LOW threshold rejected');
  throwsSync(() => tightenAsiConfig({ sink: { record: () => undefined } }), 'replacing the event sink rejected');
  c = tightenAsiConfig({ context: { [AgentTrustLevel.LOW]: { maxBudgetTokens: 100 } } });
  assert(c.context?.[AgentTrustLevel.LOW]?.maxBudgetTokens === 100, 'setting an unset policy allowed');
  throwsSync(() => tightenAsiConfig({ context: { [AgentTrustLevel.LOW]: { maxBudgetTokens: 100_000 } } }), 'replacing a set policy rejected');
  c = tightenAsiConfig({ mode: 'enforce', lowTrustBelow: 0.6, requireReceiptAtOrBelow: AgentTrustLevel.HIGH });
  assert(c.mode === 'enforce' && c.lowTrustBelow === 0.6 && c.requireReceiptAtOrBelow === AgentTrustLevel.HIGH, 'stricter settings applied');
  throwsSync(() => tightenAsiConfig({ requireReceiptAtOrBelow: AgentTrustLevel.LOW }), 'lowering receipt tier rejected');
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  process.stdout.write('ASI STRICT MODE TESTS\n');
  testConfig();
  testTrust();
  await testProofGate();
  await testConsensus();
  await testReceipts();
  await testShutdown();
  await testCanaryAndChain();
  await testContextAndCognitive();
  await testGateway();
  await testRuntime();
  await testMcp();
  testTightenOnly();

  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  process.stdout.write(`\n${passed + failed} checks — ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.stdout.write(failures.map((f) => `  FAIL: ${f}`).join('\n') + '\n');
    process.exit(1);
  }
  process.stdout.write('ALL ASI STRICT MODE TESTS PASSED ✓\n');
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
