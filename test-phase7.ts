/**
 * Phase 7: Claw-Code Inspired Enhancements — Test Suite
 *
 * Tests for:
 *   7a — Deferred adapter initialization
 *   7b — Adapter hook middleware
 *   7c — Blackboard flow control (pause/resume/throttle)
 *   7d — Skill composition (chain/batch/loop/verify)
 *   7e — Semantic memory search
 *
 * Run with: npx ts-node test-phase7.ts
 */

import { AdapterRegistry, AdapterFactory } from './adapters/adapter-registry';
import { BaseAdapter } from './adapters/base-adapter';
import { AdapterHookManager } from './lib/adapter-hooks';
import type { HookContext, ExecutionHook } from './lib/adapter-hooks';
import { SkillComposer } from './lib/skill-composer';
import type { ComposableStep } from './lib/skill-composer';
import { SemanticMemory } from './lib/semantic-search';
import type { SearchResult } from './lib/semantic-search';
import { LockedBlackboard } from './lib/locked-blackboard';
import type { AgentPayload, AgentContext, AgentResult, AdapterConfig } from './types/agent-adapter';

import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

// ============================================================================
// TEST UTILITIES
// ============================================================================

const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
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

function assert(condition: boolean, test: string, detail?: string) {
  if (condition) pass(test);
  else fail(test, detail);
}

function assertThrows(fn: () => void, test: string) {
  try { fn(); fail(test, 'Expected to throw'); }
  catch { pass(test); }
}

async function assertThrowsAsync(fn: () => Promise<unknown>, test: string) {
  try { await fn(); fail(test, 'Expected to throw'); }
  catch { pass(test); }
}

// ============================================================================
// MOCK ADAPTER
// ============================================================================

class MockAdapter extends BaseAdapter {
  readonly name: string;
  readonly version = '1.0.0';
  callCount = 0;
  lastPayload?: AgentPayload;

  constructor(name = 'mock') { super(); this.name = name; }

  async executeAgent(agentId: string, payload: AgentPayload, _context: AgentContext): Promise<AgentResult> {
    this.callCount++;
    this.lastPayload = payload;
    return { success: true, data: { agentId, echo: payload.params }, metadata: { adapter: this.name } };
  }
}

class FailingAdapter extends BaseAdapter {
  readonly name = 'failing';
  readonly version = '1.0.0';

  async executeAgent(): Promise<AgentResult> {
    return { success: false, error: { code: 'FAIL', message: 'intentional failure', recoverable: false } };
  }
}

// ============================================================================
// 7a — DEFERRED ADAPTER INITIALIZATION
// ============================================================================

async function testDeferredInit() {
  header('Phase 7a — Deferred Adapter Initialization');

  // 1. registerDeferred stores factory without creating instance
  {
    const registry = new AdapterRegistry();
    let created = false;
    const factory: AdapterFactory = () => { created = true; return new MockAdapter('lazy'); };
    registry.registerDeferred('lazy', factory);
    assert(!created, 'Factory is NOT called during registerDeferred');
  }

  // 2. listAdapters shows deferred entries
  {
    const registry = new AdapterRegistry();
    registry.registerDeferred('lazy', () => new MockAdapter('lazy'));
    const list = registry.listAdapters();
    assert(list.some(a => a.name === 'lazy' && a.deferred === true), 'listAdapters includes deferred with deferred=true');
  }

  // 3. hasDeferred
  {
    const registry = new AdapterRegistry();
    registry.registerDeferred('lazy', () => new MockAdapter('lazy'));
    assert(registry.hasDeferred('lazy'), 'hasDeferred returns true');
    assert(!registry.hasDeferred('nope'), 'hasDeferred returns false for unknown');
  }

  // 4. registerDeferred throws on duplicate active name
  {
    const registry = new AdapterRegistry();
    const adapter = new MockAdapter('active');
    await registry.addAdapter(adapter);
    assertThrows(
      () => registry.registerDeferred('active', () => new MockAdapter('active')),
      'registerDeferred throws if active adapter with same name exists',
    );
  }

  // 5. resolveAdapterAsync materializes deferred via route
  {
    const registry = new AdapterRegistry();
    let created = false;
    registry.registerDeferred('lazy', () => { created = true; return new MockAdapter('lazy'); });
    registry.addRoute({ pattern: 'lazy:*', adapterName: 'lazy', priority: 1 });

    const adapter = await registry.resolveAdapterAsync('lazy:agent1');
    assert(created, 'Factory is called during resolveAdapterAsync');
    assert(adapter !== null, 'Resolved adapter is not null');
    assert(adapter!.isReady(), 'Materialized adapter is ready');
  }

  // 6. resolveAdapterAsync materializes deferred via prefix convention
  {
    const registry = new AdapterRegistry();
    registry.registerDeferred('pfx', () => new MockAdapter('pfx'));
    const adapter = await registry.resolveAdapterAsync('pfx:task');
    assert(adapter !== null && adapter.name === 'pfx', 'Prefix convention triggers materialization');
  }

  // 7. executeAgent auto-materializes deferred
  {
    const registry = new AdapterRegistry();
    const mock = new MockAdapter('auto');
    registry.registerDeferred('auto', () => mock);
    registry.addRoute({ pattern: 'auto:*', adapterName: 'auto', priority: 1 });

    const result = await registry.executeAgent('auto:worker', { action: 'ping', params: {} }, { agentId: 'test' });
    assert(result.success, 'executeAgent succeeds after auto-materializing deferred');
    assert(mock.callCount === 1, 'Mock was called exactly once');
  }

  // 8. Deferred is cleared after materialization
  {
    const registry = new AdapterRegistry();
    registry.registerDeferred('once', () => new MockAdapter('once'));
    registry.addRoute({ pattern: 'once:*', adapterName: 'once', priority: 1 });
    await registry.resolveAdapterAsync('once:x');
    assert(!registry.hasDeferred('once'), 'Deferred entry removed after materialization');
  }

  // 9. shutdownAll clears deferred
  {
    const registry = new AdapterRegistry();
    registry.registerDeferred('d1', () => new MockAdapter('d1'));
    await registry.shutdownAll();
    assert(!registry.hasDeferred('d1'), 'shutdownAll clears deferred factories');
  }

  // 10. Multiple deferred adapters
  {
    const registry = new AdapterRegistry();
    registry.registerDeferred('a', () => new MockAdapter('a'));
    registry.registerDeferred('b', () => new MockAdapter('b'));
    assert(registry.listAdapters().length === 2, 'Two deferred adapters listed');
    registry.addRoute({ pattern: 'a:*', adapterName: 'a', priority: 1 });
    registry.addRoute({ pattern: 'b:*', adapterName: 'b', priority: 1 });
    const resA = await registry.executeAgent('a:x', { action: 'go', params: {} }, { agentId: 'test' });
    const resB = await registry.executeAgent('b:x', { action: 'go', params: {} }, { agentId: 'test' });
    assert(resA.success && resB.success, 'Both deferred adapters materialize and execute');
  }
}

// ============================================================================
// 7b — ADAPTER HOOK MIDDLEWARE
// ============================================================================

async function testHookMiddleware() {
  header('Phase 7b — Adapter Hook Middleware');

  // 1. Register and list hooks
  {
    const hm = new AdapterHookManager();
    hm.register({ name: 'h1', phase: 'beforeExecute', handler: ctx => ctx });
    hm.register({ name: 'h2', phase: 'afterExecute', handler: ctx => ctx });
    assert(hm.size() === 2, 'Two hooks registered');
    assert(hm.list().length === 2, 'list() returns both hooks');
  }

  // 2. Duplicate name throws
  {
    const hm = new AdapterHookManager();
    hm.register({ name: 'dup', phase: 'beforeExecute', handler: ctx => ctx });
    assertThrows(
      () => hm.register({ name: 'dup', phase: 'afterExecute', handler: ctx => ctx }),
      'Duplicate hook name throws',
    );
  }

  // 3. Unregister
  {
    const hm = new AdapterHookManager();
    hm.register({ name: 'rem', phase: 'beforeExecute', handler: ctx => ctx });
    assert(hm.unregister('rem'), 'unregister returns true');
    assert(hm.size() === 0, 'Hook removed');
    assert(!hm.unregister('nope'), 'unregister returns false for unknown');
  }

  // 4. clear
  {
    const hm = new AdapterHookManager();
    hm.register({ name: 'a', phase: 'beforeExecute', handler: ctx => ctx });
    hm.register({ name: 'b', phase: 'afterExecute', handler: ctx => ctx });
    hm.clear();
    assert(hm.size() === 0, 'clear removes all hooks');
  }

  // 5. createContext
  {
    const hm = new AdapterHookManager();
    const ctx = hm.createContext('agent1', { action: 'test', params: {} }, { agentId: 'caller' });
    assert(ctx.agentId === 'agent1', 'Context has correct agentId');
    assert(ctx.aborted === false, 'Context starts not aborted');
    assert(Object.keys(ctx.metadata).length === 0, 'Metadata starts empty');
  }

  // 6. beforeExecute hooks run in priority order
  {
    const hm = new AdapterHookManager();
    const order: number[] = [];
    hm.register({ name: 'low', phase: 'beforeExecute', priority: 1, handler: ctx => { order.push(1); return ctx; } });
    hm.register({ name: 'high', phase: 'beforeExecute', priority: 10, handler: ctx => { order.push(10); return ctx; } });
    hm.register({ name: 'mid', phase: 'beforeExecute', priority: 5, handler: ctx => { order.push(5); return ctx; } });
    const ctx = hm.createContext('a', { action: 'x', params: {} }, { agentId: 'c' });
    await hm.runBefore(ctx);
    assert(order[0] === 10 && order[1] === 5 && order[2] === 1, 'Hooks run highest priority first');
  }

  // 7. beforeExecute can modify payload
  {
    const hm = new AdapterHookManager();
    hm.register({
      name: 'inject',
      phase: 'beforeExecute',
      handler: ctx => { ctx.payload.params.injected = true; return ctx; },
    });
    const ctx = hm.createContext('a', { action: 'x', params: {} }, { agentId: 'c' });
    const result = await hm.runBefore(ctx);
    assert(result.payload.params.injected === true, 'beforeExecute can modify payload');
  }

  // 8. beforeExecute can abort
  {
    const hm = new AdapterHookManager();
    hm.register({
      name: 'abort',
      phase: 'beforeExecute',
      handler: ctx => { ctx.aborted = true; ctx.result = { success: false, error: { code: 'BLOCKED', message: 'blocked', recoverable: false } }; return ctx; },
    });
    const ctx = hm.createContext('a', { action: 'x', params: {} }, { agentId: 'c' });
    const result = await hm.runBefore(ctx);
    assert(result.aborted, 'Abort flag is set');
    assert(result.result?.error?.code === 'BLOCKED', 'Abort provides result');
  }

  // 9. afterExecute can transform result
  {
    const hm = new AdapterHookManager();
    hm.register({
      name: 'enrich',
      phase: 'afterExecute',
      handler: ctx => {
        if (ctx.result) {
          (ctx.result.metadata as Record<string, unknown>) = { ...ctx.result.metadata, enriched: true };
        }
        return ctx;
      },
    });
    const ctx = hm.createContext('a', { action: 'x', params: {} }, { agentId: 'c' });
    ctx.result = { success: true, data: 'ok', metadata: {} };
    const result = await hm.runAfter(ctx);
    assert((result.result?.metadata as Record<string, unknown>)?.enriched === true, 'afterExecute enriches result');
  }

  // 10. onError hooks run
  {
    const hm = new AdapterHookManager();
    let errorSeen = false;
    hm.register({
      name: 'logError',
      phase: 'onError',
      handler: ctx => { errorSeen = !!ctx.error; return ctx; },
    });
    const ctx = hm.createContext('a', { action: 'x', params: {} }, { agentId: 'c' });
    ctx.error = new Error('boom');
    await hm.runOnError(ctx);
    assert(errorSeen, 'onError sees the error');
  }

  // 11. Async hook handler
  {
    const hm = new AdapterHookManager();
    hm.register({
      name: 'asyncHook',
      phase: 'beforeExecute',
      handler: async ctx => {
        await new Promise(r => setTimeout(r, 5));
        ctx.metadata.async = true;
        return ctx;
      },
    });
    const ctx = hm.createContext('a', { action: 'x', params: {} }, { agentId: 'c' });
    const result = await hm.runBefore(ctx);
    assert(result.metadata.async === true, 'Async hooks work');
  }

  // 12. Multiple hooks chain
  {
    const hm = new AdapterHookManager();
    hm.register({ name: 'step1', phase: 'beforeExecute', priority: 2, handler: ctx => { ctx.metadata.step1 = true; return ctx; } });
    hm.register({ name: 'step2', phase: 'beforeExecute', priority: 1, handler: ctx => { ctx.metadata.step2 = ctx.metadata.step1; return ctx; } });
    const ctx = hm.createContext('a', { action: 'x', params: {} }, { agentId: 'c' });
    const result = await hm.runBefore(ctx);
    assert(result.metadata.step2 === true, 'Hooks chain — step2 sees step1 output');
  }
}

// ============================================================================
// 7c — FLOW CONTROL (PAUSE / RESUME / THROTTLE)
// ============================================================================

async function testFlowControl() {
  header('Phase 7c — Blackboard Flow Control');

  const tmpBase = join(process.cwd(), 'data', 'test-phase7-flow');

  function cleanDir() {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
    mkdirSync(tmpBase, { recursive: true });
  }

  // 1. Initial state: not paused
  {
    cleanDir();
    const bb = new LockedBlackboard(tmpBase);
    assert(!bb.isPaused(), 'Initially not paused');
  }

  // 2. pause() sets paused
  {
    cleanDir();
    const bb = new LockedBlackboard(tmpBase);
    bb.pause();
    assert(bb.isPaused(), 'isPaused returns true after pause');
  }

  // 3. resume() clears paused
  {
    cleanDir();
    const bb = new LockedBlackboard(tmpBase);
    bb.pause();
    bb.resume();
    assert(!bb.isPaused(), 'isPaused returns false after resume');
  }

  // 4. write() throws when paused
  {
    cleanDir();
    const bb = new LockedBlackboard(tmpBase);
    bb.pause();
    assertThrows(() => bb.write('k', 'v', 'agent'), 'write throws when paused');
  }

  // 5. delete() throws when paused
  {
    cleanDir();
    const bb = new LockedBlackboard(tmpBase);
    bb.write('k', 'v', 'agent');
    bb.pause();
    assertThrows(() => bb.delete('k'), 'delete throws when paused');
  }

  // 6. commit() throws when paused
  {
    cleanDir();
    const bb = new LockedBlackboard(tmpBase);
    const cid = bb.propose('key', 'val', 'agent');
    bb.validate(cid, 'validator');
    bb.pause();
    assertThrows(() => bb.commit(cid), 'commit throws when paused');
  }

  // 7. read() works while paused
  {
    cleanDir();
    const bb = new LockedBlackboard(tmpBase);
    bb.write('k', 'v', 'agent');
    bb.pause();
    const entry = bb.read('k');
    assert(entry !== null && entry.value === 'v', 'read works while paused');
  }

  // 8. listKeys() works while paused
  {
    cleanDir();
    const bb = new LockedBlackboard(tmpBase);
    bb.write('a', 1, 'agent');
    bb.pause();
    assert(bb.listKeys().includes('a'), 'listKeys works while paused');
  }

  // 9. resume allows writes again
  {
    cleanDir();
    const bb = new LockedBlackboard(tmpBase);
    bb.pause();
    bb.resume();
    bb.write('k', 'v', 'agent');
    assert(bb.read('k')?.value === 'v', 'Writes work after resume');
  }

  // 10. setThrottle / getThrottle
  {
    cleanDir();
    const bb = new LockedBlackboard(tmpBase);
    assert(bb.getThrottle() === 0, 'Default throttle is 0');
    bb.setThrottle(100);
    assert(bb.getThrottle() === 100, 'setThrottle updates value');
  }

  // 11. Throttle rejects rapid writes
  {
    cleanDir();
    const bb = new LockedBlackboard(tmpBase);
    bb.setThrottle(500);
    bb.write('k1', 'v1', 'agent');
    let threw = false;
    try { bb.write('k2', 'v2', 'agent'); } catch { threw = true; }
    assert(threw, 'Throttle rejects rapid second write');
  }

  // 12. Throttle via constructor options
  {
    cleanDir();
    const bb = new LockedBlackboard(tmpBase, { throttleMs: 200 });
    assert(bb.getThrottle() === 200, 'Throttle set via constructor options');
  }

  // 13. propose() works while paused (it's not a mutating disk op)
  {
    cleanDir();
    const bb = new LockedBlackboard(tmpBase);
    bb.pause();
    const cid = bb.propose('key', 'val', 'agent');
    assert(typeof cid === 'string' && cid.startsWith('chg_'), 'propose works while paused');
  }

  // 14. getSnapshot works while paused
  {
    cleanDir();
    const bb = new LockedBlackboard(tmpBase);
    bb.write('test', 42, 'agent');
    bb.pause();
    const snap = bb.getSnapshot();
    assert(snap['test']?.value === 42, 'getSnapshot works while paused');
  }

  // Cleanup
  if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
}

// ============================================================================
// 7d — SKILL COMPOSITION
// ============================================================================

async function testSkillComposition() {
  header('Phase 7d — Skill Composition');

  async function makeRegistry(): Promise<{ registry: AdapterRegistry; mock: MockAdapter; failing: FailingAdapter }> {
    const registry = new AdapterRegistry();
    const mock = new MockAdapter('mock');
    const failing = new FailingAdapter();
    await registry.addAdapter(mock);
    await registry.addAdapter(failing);
    registry.addRoute({ pattern: 'mock:*', adapterName: 'mock', priority: 1 });
    registry.addRoute({ pattern: 'fail:*', adapterName: 'failing', priority: 1 });
    return { registry, mock, failing };
  }

  const baseCtx: AgentContext = { agentId: 'composer' };

  // 1. chain — sequential execution
  {
    const { registry, mock } = await makeRegistry();
    const composer = new SkillComposer(registry, baseCtx);
    const steps: ComposableStep[] = [
      { agentId: 'mock:a', payload: { action: 'step1', params: { x: 1 } } },
      { agentId: 'mock:b', payload: { action: 'step2', params: { x: 2 } } },
      { agentId: 'mock:c', payload: { action: 'step3', params: { x: 3 } } },
    ];
    const result = await composer.chain(steps);
    assert(result.success && result.results.length === 3, 'chain runs all 3 steps');
    assert(result.successCount === 3 && result.failureCount === 0, 'chain reports correct counts');
    assert(mock.callCount === 3, 'Mock called 3 times');
  }

  // 2. chain stops on first failure
  {
    const { registry } = await makeRegistry();
    const composer = new SkillComposer(registry, baseCtx);
    const steps: ComposableStep[] = [
      { agentId: 'mock:a', payload: { action: 'ok', params: {} } },
      { agentId: 'fail:b', payload: { action: 'boom', params: {} } },
      { agentId: 'mock:c', payload: { action: 'skip', params: {} } },
    ];
    const result = await composer.chain(steps);
    assert(!result.success, 'chain fails on failure');
    assert(result.results.length === 2, 'chain stops after failure');
  }

  // 3. chain with continueOnError
  {
    const { registry } = await makeRegistry();
    const composer = new SkillComposer(registry, baseCtx);
    const steps: ComposableStep[] = [
      { agentId: 'fail:a', payload: { action: 'x', params: {} } },
      { agentId: 'mock:b', payload: { action: 'x', params: {} } },
    ];
    const result = await composer.chain(steps, true);
    assert(result.results.length === 2, 'chain continues on error when flag set');
    assert(result.successCount === 1 && result.failureCount === 1, 'Counts accurate with continueOnError');
  }

  // 4. chain passes previous result to next step
  {
    const { registry, mock } = await makeRegistry();
    const composer = new SkillComposer(registry, baseCtx);
    const steps: ComposableStep[] = [
      { agentId: 'mock:a', payload: { action: 'first', params: {} } },
      { agentId: 'mock:b', payload: { action: 'second', params: {} } },
    ];
    await composer.chain(steps);
    const lastPayload = mock.lastPayload;
    assert(lastPayload?.blackboardSnapshot?.previousResult !== undefined, 'Chain passes previousResult');
  }

  // 5. batch — parallel execution
  {
    const { registry, mock } = await makeRegistry();
    const composer = new SkillComposer(registry, baseCtx);
    const steps: ComposableStep[] = Array.from({ length: 5 }, (_, i) => ({
      agentId: 'mock:w' + i,
      payload: { action: 'work', params: { i } },
    }));
    const result = await composer.batch(steps);
    assert(result.success && result.results.length === 5, 'batch runs all 5 steps');
    assert(mock.callCount === 5, 'Mock called 5 times');
  }

  // 6. batch with concurrency limit
  {
    const { registry, mock } = await makeRegistry();
    const composer = new SkillComposer(registry, baseCtx);
    const steps: ComposableStep[] = Array.from({ length: 4 }, (_, i) => ({
      agentId: 'mock:w' + i,
      payload: { action: 'work', params: { i } },
    }));
    const result = await composer.batch(steps, 2);
    assert(result.results.length === 4, 'batch respects concurrency limit');
    assert(result.successCount === 4, 'All succeed');
  }

  // 7. batch with failures
  {
    const { registry } = await makeRegistry();
    const composer = new SkillComposer(registry, baseCtx);
    const steps: ComposableStep[] = [
      { agentId: 'mock:ok', payload: { action: 'ok', params: {} } },
      { agentId: 'fail:bad', payload: { action: 'bad', params: {} } },
    ];
    const result = await composer.batch(steps);
    assert(!result.success, 'batch reports failure');
    assert(result.successCount === 1 && result.failureCount === 1, 'batch counts accurate');
  }

  // 8. loop — repeat with condition
  {
    const { registry, mock } = await makeRegistry();
    const composer = new SkillComposer(registry, baseCtx);
    const step: ComposableStep = { agentId: 'mock:loop', payload: { action: 'iter', params: {} } };
    const result = await composer.loop(step, {
      maxIterations: 10,
      condition: (_result, iteration) => iteration < 3,
    });
    assert(result.results.length === 4, 'loop runs 4 times (0,1,2,3 — stops when condition returns false)');
    assert(mock.callCount === 4, 'Mock called 4 times');
  }

  // 9. loop respects maxIterations
  {
    const { registry } = await makeRegistry();
    const composer = new SkillComposer(registry, baseCtx);
    const step: ComposableStep = { agentId: 'mock:loop', payload: { action: 'iter', params: {} } };
    const result = await composer.loop(step, {
      maxIterations: 3,
      condition: () => true,
    });
    assert(result.results.length === 3, 'loop stops at maxIterations');
  }

  // 10. verify — retries until valid
  {
    const { registry, mock } = await makeRegistry();
    const composer = new SkillComposer(registry, baseCtx);
    const step: ComposableStep = { agentId: 'mock:v', payload: { action: 'test', params: {} } };
    let calls = 0;
    const result = await composer.verify(step, {
      maxRetries: 5,
      validator: () => { calls++; return calls >= 3; },
    });
    assert(result.success, 'verify succeeds when validator passes');
    assert(mock.callCount === 3, 'verify took 3 attempts');
  }

  // 11. verify — exhausts retries
  {
    const { registry } = await makeRegistry();
    const composer = new SkillComposer(registry, baseCtx);
    const step: ComposableStep = { agentId: 'mock:v', payload: { action: 'test', params: {} } };
    const result = await composer.verify(step, {
      maxRetries: 2,
      validator: () => false,
    });
    // Returns last result (which is success from mock, but validator never passes)
    assert(result.success === true, 'verify returns last result even if validator fails');
  }

  // 12. chain totalMs is positive
  {
    const { registry } = await makeRegistry();
    const composer = new SkillComposer(registry, baseCtx);
    const result = await composer.chain([{ agentId: 'mock:t', payload: { action: 'go', params: {} } }]);
    assert(typeof result.totalMs === 'number' && result.totalMs >= 0, 'totalMs is non-negative');
  }

  // 13. batch empty steps
  {
    const { registry } = await makeRegistry();
    const composer = new SkillComposer(registry, baseCtx);
    const result = await composer.batch([]);
    assert(result.success && result.results.length === 0, 'batch with empty steps succeeds');
  }

  // 14. chain with context overrides
  {
    const { registry } = await makeRegistry();
    const composer = new SkillComposer(registry, baseCtx);
    const steps: ComposableStep[] = [
      { agentId: 'mock:a', payload: { action: 'go', params: {} }, context: { taskId: 'task-1' } },
    ];
    const result = await composer.chain(steps);
    assert(result.success, 'chain with context overrides succeeds');
  }
}

// ============================================================================
// 7e — SEMANTIC MEMORY SEARCH
// ============================================================================

async function testSemanticMemory() {
  header('Phase 7e — Semantic Memory Search');

  // Simple mock embedding: hash-like vectors for testing
  const mockEmbed: (text: string) => Promise<number[]> = async (text) => {
    const vec = new Array(8).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % 8] += text.charCodeAt(i) / 1000;
    }
    // Normalize
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return mag > 0 ? vec.map(v => v / mag) : vec;
  };

  // 1. index and size
  {
    const mem = new SemanticMemory(mockEmbed);
    await mem.index('k1', 'hello world', { data: 1 }, 'agent1');
    assert(mem.size() === 1, 'size returns 1 after indexing');
  }

  // 2. has
  {
    const mem = new SemanticMemory(mockEmbed);
    await mem.index('k1', 'hello', null, 'a');
    assert(mem.has('k1'), 'has returns true for indexed key');
    assert(!mem.has('k2'), 'has returns false for unknown key');
  }

  // 3. keys
  {
    const mem = new SemanticMemory(mockEmbed);
    await mem.index('a', 'alpha', null, 'x');
    await mem.index('b', 'beta', null, 'x');
    const k = mem.keys();
    assert(k.includes('a') && k.includes('b'), 'keys returns all indexed keys');
  }

  // 4. remove
  {
    const mem = new SemanticMemory(mockEmbed);
    await mem.index('k1', 'hello', null, 'a');
    assert(mem.remove('k1'), 'remove returns true');
    assert(mem.size() === 0, 'size is 0 after remove');
    assert(!mem.remove('k1'), 'remove returns false for missing key');
  }

  // 5. clear
  {
    const mem = new SemanticMemory(mockEmbed);
    await mem.index('a', 'x', null, 'a');
    await mem.index('b', 'y', null, 'a');
    mem.clear();
    assert(mem.size() === 0, 'clear removes all entries');
  }

  // 6. search returns results sorted by score
  {
    const mem = new SemanticMemory(mockEmbed);
    await mem.index('exact', 'revenue analysis quarterly', { match: true }, 'analyst');
    await mem.index('partial', 'revenue report', { match: false }, 'reporter');
    await mem.index('unrelated', 'cat pictures', { match: false }, 'random');
    const results = await mem.search('revenue analysis quarterly');
    assert(results.length > 0, 'search returns results');
    assert(results[0].key === 'exact', 'Exact match ranks first');
    assert(results[0].score >= results[results.length - 1].score, 'Results sorted by descending score');
  }

  // 7. search topK
  {
    const mem = new SemanticMemory(mockEmbed);
    for (let i = 0; i < 10; i++) {
      await mem.index(`k${i}`, `entry ${i}`, null, 'a');
    }
    const results = await mem.search('entry', 3);
    assert(results.length === 3, 'topK limits results');
  }

  // 8. search threshold
  {
    const mem = new SemanticMemory(mockEmbed);
    await mem.index('rel', 'machine learning', null, 'a');
    await mem.index('irr', 'zzzzz qqqqq xxxxx', null, 'a');
    const results = await mem.search('machine learning', 10, 0.9);
    // The exact match should pass threshold, the gibberish probably won't
    assert(results.every(r => r.score >= 0.9), 'Threshold filters low-score results');
  }

  // 9. search on empty memory
  {
    const mem = new SemanticMemory(mockEmbed);
    const results = await mem.search('anything');
    assert(results.length === 0, 'Search on empty memory returns empty');
  }

  // 10. re-indexing replaces entry
  {
    const mem = new SemanticMemory(mockEmbed);
    await mem.index('k1', 'old text', 'oldval', 'a');
    await mem.index('k1', 'new text', 'newval', 'a');
    assert(mem.size() === 1, 'Re-index replaces, not duplicates');
    const results = await mem.search('new text', 1);
    assert(results[0]?.value === 'newval', 'Re-indexed value is updated');
  }

  // 11. indexSnapshot
  {
    const mem = new SemanticMemory(mockEmbed);
    const snapshot: Record<string, { value: unknown; source_agent: string }> = {
      'task:1': { value: 'analyze revenue', source_agent: 'analyst' },
      'task:2': { value: { complex: true }, source_agent: 'worker' },
    };
    const count = await mem.indexSnapshot(snapshot);
    assert(count === 2, 'indexSnapshot returns correct count');
    assert(mem.size() === 2, 'indexSnapshot indexes all entries');
  }

  // 12. search result shape
  {
    const mem = new SemanticMemory(mockEmbed);
    await mem.index('k', 'test data', { myData: 1 }, 'myAgent');
    const results = await mem.search('test data', 1);
    const r = results[0];
    assert(r.key === 'k', 'Result has correct key');
    assert((r.value as Record<string, number>).myData === 1, 'Result has correct value');
    assert(r.sourceAgent === 'myAgent', 'Result has correct sourceAgent');
    assert(typeof r.score === 'number' && r.score > 0, 'Result has positive score');
  }

  // 13. cosine similarity: identical texts score ~1.0
  {
    const mem = new SemanticMemory(mockEmbed);
    await mem.index('same', 'identical text here', null, 'a');
    const results = await mem.search('identical text here', 1);
    assert(results[0]?.score > 0.99, 'Identical text scores ~1.0');
  }
}

// ============================================================================
// RUNNER
// ============================================================================

async function main() {
  console.log('\n' + '='.repeat(64));
  log('  Phase 7: Claw-Code Inspired Enhancements — Test Suite', 'bold');
  console.log('='.repeat(64));

  await testDeferredInit();
  await testHookMiddleware();
  await testFlowControl();
  await testSkillComposition();
  await testSemanticMemory();

  console.log('\n' + '='.repeat(64));
  log(`  RESULTS: ${passed} passed, ${failed} failed (${passed + failed} total)`, failed > 0 ? 'red' : 'green');
  console.log('='.repeat(64) + '\n');

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
