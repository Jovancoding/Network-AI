/**
 * Phase 11: TTL/Sweep, WAL Crash Recovery, Circuit Breaker, OTel Telemetry
 *
 * Run with: npx ts-node test-phase11.ts
 */

import { LockedBlackboard } from './lib/locked-blackboard';
import { CircuitBreaker } from './lib/circuit-breaker';
import type { CircuitBreakerConfig } from './lib/circuit-breaker';
import {
  NullTelemetryProvider,
  CapturingTelemetryProvider,
  createOtelHooks,
} from './lib/telemetry-provider';
import { AdapterRegistry } from './adapters/adapter-registry';
import { BaseAdapter } from './adapters/base-adapter';
import { AdapterHookManager } from './lib/adapter-hooks';
import type { AgentPayload, AgentContext, AgentResult, AdapterConfig } from './types/agent-adapter';
import { mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

// ============================================================================
// TEST UTILITIES
// ============================================================================

const colors = {
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
} as const;

let passed = 0;
let failed = 0;

function log(msg: string, color: keyof typeof colors = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}
function header(title: string) {
  console.log('\n' + '='.repeat(64));
  log(`  ${title}`, 'bold');
  console.log('='.repeat(64));
}
function pass(test: string) { log(`  [PASS] ${test}`, 'green'); passed++; }
function fail(test: string, err?: string) {
  log(`  [FAIL] ${test}`, 'red');
  if (err) log(`         ${err}`, 'red');
  failed++;
}
function assert(cond: boolean, name: string, err?: string) {
  cond ? pass(name) : fail(name, err ?? 'Assertion failed');
}
async function assertThrows(fn: () => unknown, name: string, match?: string) {
  try {
    await fn();
    fail(name, 'Expected throw but nothing thrown');
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (match && !msg.includes(match)) fail(name, `Expected "${match}" in: "${msg}"`);
    else pass(name);
  }
}
function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

// ============================================================================
// HELPERS
// ============================================================================

function tmpDir() {
  const dir = join('data', `test-phase11-${randomUUID().substring(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

class StubAdapter extends BaseAdapter {
  readonly name: string;
  readonly version = '1.0.0';
  public callCount = 0;
  public shouldFail = false;
  public failMessage = 'stub error';

  constructor(name = 'stub') { super(); this.name = name; }

  async initialize(_config: AdapterConfig): Promise<void> { this.ready = true; }
  async shutdown(): Promise<void> { this.ready = false; }

  async executeAgent(_agentId: string, _payload: AgentPayload, _context: AgentContext): Promise<AgentResult> {
    this.callCount++;
    if (this.shouldFail) throw new Error(this.failMessage);
    return { success: true, data: `ok-${this.callCount}`, metadata: {} };
  }

  async listAgents() { return []; }
  async isAgentAvailable() { return true; }
  async healthCheck() { return { healthy: true }; }
  getCapabilities() { return { name: this.name, version: this.version, streaming: false, tools: [] }; }
}

// ============================================================================
// FEATURE 1: TTL / SWEEP
// ============================================================================

async function testTTL() {
  header('Feature 1 — TTL & Background Sweep');
  const dir = tmpDir();
  try {
    const bb = new LockedBlackboard(dir);

    // 1. Write with TTL=1s and read back immediately
    bb.write('ttl-key', 'alive', 'agent', 1 /* seconds */);
    const alive = bb.read('ttl-key');
    assert(alive !== null && alive.value === 'alive', 'read before expiry returns entry');

    // 2. Wait for expiry then read
    await sleep(1100);
    const expired = bb.read('ttl-key');
    assert(expired === null, 'read after TTL expiry returns null');

    // 3. purgeExpired() returns correct count
    bb.write('ttl-a', 1, 'agent', 1);
    bb.write('ttl-b', 2, 'agent', 1);
    bb.write('no-ttl', 3, 'agent');         // no TTL — should survive
    await sleep(1100);
    const evicted = bb.purgeExpired();
    assert(evicted === 2, `purgeExpired evicts 2 (got ${evicted})`);
    assert(bb.read('no-ttl') !== null, 'non-TTL key survives purge');

    // 4. listKeys() hides expired entries
    bb.write('x', 1, 'agent', 1);
    await sleep(1100);
    const keys = bb.listKeys();
    assert(!keys.includes('x'), 'listKeys omits expired key');

    // 5. startSweep() / stopSweep() without error
    bb.startSweep(500);
    await sleep(600);
    bb.stopSweep();
    pass('startSweep / stopSweep cycle completes without error');

    // 6. propose → commit with TTL stored in entry
    const changeId = bb.propose('ttl-propose', 'val', 'agent', 2);
    bb.validate(changeId, 'validator');
    const result = bb.commit(changeId);
    assert(result.success, 'commit with TTL succeeds');
    assert(result.entry?.ttl === 2, `entry.ttl is 2 (got ${result.entry?.ttl})`);

  } finally {
    cleanup(dir);
  }
}

// ============================================================================
// FEATURE 2: WAL CRASH RECOVERY
// ============================================================================

async function testWAL() {
  header('Feature 2 — WAL Crash Recovery');
  const dir = tmpDir();
  try {
    // 1. Normal operation: WAL file is created and compacted
    const bb = new LockedBlackboard(dir);
    bb.write('w1', 'hello', 'agent');
    const walPath = join(dir, 'data', '.wal.jsonl');
    // WAL might be empty after checkpoint — just check no error thrown
    pass('WAL created without error');

    // 2. Simulate crash: manually inject an uncommitted WAL record
    const { appendFileSync } = await import('fs');
    const fakeEntry = { key: 'crash-key', value: 'crash-val', source_agent: 'agent', timestamp: new Date().toISOString(), ttl: null, version: 1 };
    const walRecord = JSON.stringify({ op: 'write', opId: 'wal_crash_001', key: 'crash-key', entry: fakeEntry, ts: new Date().toISOString() }) + '\n';
    appendFileSync(walPath, walRecord, 'utf-8');

    // 3. Construct a new LockedBlackboard — should replay crash record
    const bb2 = new LockedBlackboard(dir);
    const recovered = bb2.read('crash-key');
    assert(recovered !== null && recovered.value === 'crash-val', 'WAL replay recovers uncommitted write');

    // 4. Checkpointed entry is NOT replayed a second time
    const bb3 = new LockedBlackboard(dir);
    const notDoubled = bb3.read('crash-key');
    assert(notDoubled !== null, 'Checkpointed entry persists normally on second load');

    // 5. compactWAL truncates the WAL
    bb3.compactWAL();
    const walContent = readFileSync(walPath, 'utf-8');
    assert(walContent.length === 0, 'compactWAL truncates WAL file');

    // 6. replayWAL is a no-op when WAL is empty
    bb3.replayWAL();  // should not throw
    pass('replayWAL on empty WAL is a no-op');

    // 7. Malformed tail line is skipped gracefully
    appendFileSync(walPath, '{"op":"write","opId":"wal_ok","key":"ok-key",' +
      '"entry":{"key":"ok-key","value":42,"source_agent":"a","timestamp":"2024-01-01T00:00:00.000Z","ttl":null,"version":1},' +
      '"ts":"2024-01-01T00:00:00.000Z"}\n', 'utf-8');
    appendFileSync(walPath, '{broken json line\n', 'utf-8');
    const bb4 = new LockedBlackboard(dir);
    const okEntry = bb4.read('ok-key');
    assert(okEntry !== null && okEntry.value === 42, 'WAL replays valid entry before corrupt tail');

  } finally {
    cleanup(dir);
  }
}

// ============================================================================
// FEATURE 3: CIRCUIT BREAKER
// ============================================================================

async function testCircuitBreaker() {
  header('Feature 3 — Circuit Breaker');

  // 1. Basic execute success
  const cb = new CircuitBreaker('test', { failureThreshold: 3, recoveryTimeoutMs: 200 });
  const r1 = await cb.execute(() => Promise.resolve(42));
  assert(r1 === 42, 'CLOSED state: execute returns value');

  // 2. Failures trip the circuit
  for (let i = 0; i < 3; i++) {
    try { await cb.execute(() => Promise.reject(new Error('fail'))); } catch { /* expected */ }
  }
  assert(cb.getState() === 'OPEN', 'Circuit trips to OPEN after threshold failures');

  // 3. CircuitOpenError when OPEN
  await assertThrows(() => cb.execute(() => Promise.resolve(1)), 'OPEN state throws CircuitOpenError', 'fast-failing');

  // 4. HALF_OPEN after recoveryTimeout
  await sleep(250);
  assert(cb.getState() === 'HALF_OPEN', 'Transitions to HALF_OPEN after recoveryTimeoutMs');

  // 5. Success in HALF_OPEN → CLOSED
  await cb.execute(() => Promise.resolve('ok'));
  assert(cb.getState() === 'CLOSED', 'Single success in HALF_OPEN closes circuit');

  // 6. Failure in HALF_OPEN → OPEN again
  const cb2 = new CircuitBreaker('test2', { failureThreshold: 2, recoveryTimeoutMs: 200, successThreshold: 1 });
  for (let i = 0; i < 2; i++) {
    try { await cb2.execute(() => Promise.reject(new Error('fail'))); } catch { /* expected */ }
  }
  await sleep(250);
  try { await cb2.execute(() => Promise.reject(new Error('fail'))); } catch { /* expected */ }
  assert(cb2.getState() === 'OPEN', 'Failure in HALF_OPEN re-opens circuit');

  // 7. reset() clears to CLOSED
  cb2.reset();
  assert(cb2.getState() === 'CLOSED', 'reset() returns circuit to CLOSED');

  // 8. trip() forces OPEN
  const cb3 = new CircuitBreaker('test3');
  cb3.trip();
  assert(cb3.getState() === 'OPEN', 'trip() forces OPEN');

  // 9. onStateChange callback fires
  const states: string[] = [];
  const cb4 = new CircuitBreaker('test4', {
    failureThreshold: 1,
    recoveryTimeoutMs: 100,
    onStateChange: (_from, to) => states.push(to),
  });
  try { await cb4.execute(() => Promise.reject(new Error('x'))); } catch { /* expected */ }
  assert(states.includes('OPEN'), 'onStateChange fires on state change');

  // 10. AdapterRegistry circuit breaker integration
  const registry = new AdapterRegistry({ circuitBreaker: { failureThreshold: 2, recoveryTimeoutMs: 100 } });
  const stub = new StubAdapter('stub-cb');
  await registry.addAdapter(stub);

  const payload: AgentPayload = { action: 'test', params: {} };
  const agentCtx: AgentContext = { agentId: 'test-agent' };

  // Fail twice → circuit opens
  stub.shouldFail = true;
  await registry.executeAgent('stub-cb:agent', payload, agentCtx);
  await registry.executeAgent('stub-cb:agent', payload, agentCtx);
  const state = registry.getCircuitState('stub-cb');
  assert(state === 'OPEN', `Registry: circuit OPEN after 2 failures (got ${state})`);

  // Third call → CIRCUIT_OPEN error, not ADAPTER_ERROR
  const r2 = await registry.executeAgent('stub-cb:agent', payload, agentCtx);
  assert(!r2.success && r2.error?.code === 'CIRCUIT_OPEN', 'Registry: OPEN circuit returns CIRCUIT_OPEN error');

  // resetCircuit() → CLOSED
  registry.resetCircuit('stub-cb');
  assert(registry.getCircuitState('stub-cb') === 'CLOSED', 'resetCircuit() clears to CLOSED');

  // 11. Fallback adapter used when circuit OPEN
  const fallback = new StubAdapter('fallback-cb');
  fallback.shouldFail = false;
  await registry.addAdapter(fallback);

  stub.shouldFail = true;
  // Trip circuit
  await registry.executeAgent('stub-cb:agent', payload, agentCtx);
  await registry.executeAgent('stub-cb:agent', payload, agentCtx);

  // Configure fallback chain
  const registry2 = new AdapterRegistry({
    circuitBreaker: { failureThreshold: 2, recoveryTimeoutMs: 100 },
    fallbackChain: ['fallback-cb2'],
  });
  const stubFail = new StubAdapter('stubFail');
  const fallbackOk = new StubAdapter('fallback-cb2');
  stubFail.shouldFail = true;
  await registry2.addAdapter(stubFail);
  await registry2.addAdapter(fallbackOk);
  // Trip stubFail
  await registry2.executeAgent('stubFail:a', payload, agentCtx);
  await registry2.executeAgent('stubFail:a', payload, agentCtx);
  const r3 = await registry2.executeAgent('stubFail:a', payload, agentCtx);
  assert(r3.success, `Fallback chain used when circuit OPEN (success=${r3.success})`);
}

// ============================================================================
// FEATURE 4: OTEL TELEMETRY PROVIDER
// ============================================================================

async function testTelemetry() {
  header('Feature 4 — OTel ITelemetryProvider & hooks');

  // 1. NullTelemetryProvider
  const nullP = new NullTelemetryProvider();
  const sid = nullP.startSpan('foo');
  assert(sid === '', 'NullTelemetryProvider.startSpan returns empty string');
  nullP.endSpan(sid, 'ok');
  nullP.recordEvent(sid, 'ev');
  pass('NullTelemetryProvider all methods are no-ops');

  // 2. CapturingTelemetryProvider
  const cap = new CapturingTelemetryProvider();
  const spanId = cap.startSpan('test.span', { agentId: 'agent1' });
  cap.recordEvent(spanId, 'my.event', { foo: 'bar' });
  cap.endSpan(spanId, 'ok', { extra: 'x' });

  assert(cap.spans.length === 1, 'CapturingProvider records 1 span');
  const span = cap.spans[0];
  assert(span.name === 'test.span', 'span name is test.span');
  assert(span.attributes.agentId === 'agent1', 'span attributes preserved');
  assert(span.status === 'ok', 'span status is ok');
  assert(span.events.length === 1 && span.events[0].name === 'my.event', 'span event recorded');
  assert(span.events[0].attributes.foo === 'bar', 'span event attributes preserved');
  assert(span.attributes.extra === 'x', 'endSpan attrs merged into span');

  // 3. clear() resets
  cap.clear();
  assert(cap.spans.length === 0, 'clear() resets captured spans');

  // 4. createOtelHooks wires into AdapterHookManager
  const cap2 = new CapturingTelemetryProvider();
  const hooks = new AdapterHookManager();
  createOtelHooks(cap2).forEach(h => hooks.register(h));
  assert(hooks.list().length === 3, '3 OTel hooks registered (before/after/onError)');

  // 5. Hooks emit span on successful adapter execution via AdapterRegistry
  const registry = new AdapterRegistry();
  const stub = new StubAdapter('otel-stub');
  await registry.addAdapter(stub);

  const cap3 = new CapturingTelemetryProvider();
  const hookMgr = new AdapterHookManager();
  createOtelHooks(cap3).forEach(h => hookMgr.register(h));

  // Simulate hook lifecycle: beforeExecute → execute → afterExecute
  // (We test the hook handlers directly since registry doesn't have hook integration)
  const ctx = {
    agentId: 'otel-stub:agent',
    payload: { action: 'run', params: {} } as AgentPayload,
    context: { agentId: 'otel-stub:agent' } as AgentContext,
    result: undefined,
    error: undefined,
    metadata: {} as Record<string, unknown>,
    aborted: false,
    depth: 0,
  };

  let c = await hookMgr.runBefore(ctx);
  assert(cap3.spans.length === 1, 'beforeExecute creates span');
  assert(cap3.spans[0].name === 'adapter.execute', 'span name is adapter.execute');

  c.result = { success: true, data: 'ok' };
  await hookMgr.runAfter(c);
  assert(cap3.spans[0].status === 'ok', 'afterExecute closes span with ok');

  // 6. onError sets status to 'error'
  cap3.clear();
  const errCtx = hookMgr.createContext('otel-stub:agent', { action: 'run', params: {} }, { agentId: 'otel-stub:agent' });
  const errCtxAfterBefore = await hookMgr.runBefore(errCtx);
  errCtxAfterBefore.error = new Error('test error');
  await hookMgr.runOnError(errCtxAfterBefore);
  assert(cap3.spans[0]?.status === 'error', 'onError closes span with error');

  // 7. Unknown spanId is handled gracefully
  cap3.endSpan('non-existent', 'ok');
  pass('endSpan with unknown spanId is a no-op');
}

// ============================================================================
// MAIN
// ============================================================================

(async () => {
  console.log('\n' + '='.repeat(64));
  log('  Phase 11 — TTL/Sweep, WAL, Circuit Breaker, OTel', 'bold');
  console.log('='.repeat(64));

  try { await testTTL(); }         catch (e) { fail('TTL suite (uncaught)', String(e)); }
  try { await testWAL(); }         catch (e) { fail('WAL suite (uncaught)', String(e)); }
  try { await testCircuitBreaker(); } catch (e) { fail('Circuit Breaker suite (uncaught)', String(e)); }
  try { await testTelemetry(); }   catch (e) { fail('Telemetry suite (uncaught)', String(e)); }

  console.log('\n' + '='.repeat(64));
  log(`  Results: ${passed} passed, ${failed} failed`, failed > 0 ? 'red' : 'green');
  console.log('='.repeat(64));
  if (failed > 0) process.exit(1);
})();
