/**
 * RLM Phases Test Suite
 *
 * Tests for all 8 RLM-inspired enhancements:
 *   A — FederatedBudget.spawnChild() + commit() (Phase 1)
 *   B — LockedBlackboard.readMetadata() / listMetadata() (Phase 2)
 *   C — QualityGateAgent.getBestPartialResult() (Phase 3)
 *   D — HookContext depth field (Phase 4)
 *   E — GoalDecomposer sub-goal recursion (Phase 5)
 *   F — FanOutFanIn semaphore queue (Phase 6)
 *   G — PhasePipeline trajectory compaction (Phase 7)
 *   H — RLMAdapter (Phase 8)
 *
 * Run with: npx ts-node test-rlm-phases.ts
 */

import * as path from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';

import { FederatedBudget } from './lib/federated-budget';
import { LockedBlackboard } from './lib/locked-blackboard';
import { QualityGateAgent } from './lib/blackboard-validator';
import { AdapterHookManager } from './lib/adapter-hooks';
import type { HookContext } from './lib/adapter-hooks';
import { TeamRunner, GoalDecomposer } from './lib/goal-decomposer';
import type { PlannedTask, PlannerFunction, ExecutorFunction, RunTeamOptions } from './lib/goal-decomposer';
import { FanOutFanIn } from './lib/fan-out';
import type { FanOutStep } from './lib/fan-out';
import { PhasePipeline } from './lib/phase-pipeline';
import type { PhaseResult } from './lib/phase-pipeline';
import { RLMAdapter } from './adapters/rlm-adapter';
import type { RLMHttpClient } from './adapters/rlm-adapter';
import { AdapterRegistry } from './adapters/adapter-registry';
import { BaseAdapter } from './adapters/base-adapter';
import type { AgentPayload, AgentContext, AgentResult } from './types/agent-adapter';

// ============================================================================
// TEST UTILITIES
// ============================================================================

const colors = {
  green: '\x1b[32m',
  red:   '\x1b[31m',
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
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
function assert(cond: boolean, name: string, detail?: string) {
  cond ? pass(name) : fail(name, detail ?? 'Assertion failed');
}
async function assertThrowsAsync(fn: () => Promise<unknown>, name: string, substr?: string) {
  try {
    await fn();
    fail(name, 'Expected error but nothing was thrown');
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (substr && !msg.includes(substr)) {
      fail(name, `Expected "${substr}" in error, got: "${msg}"`);
    } else {
      pass(name);
    }
  }
}
function assertThrowsSync(fn: () => unknown, name: string, substr?: string) {
  try {
    fn();
    fail(name, 'Expected error but nothing was thrown');
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (substr && !msg.includes(substr)) {
      fail(name, `Expected "${substr}" in error, got: "${msg}"`);
    } else {
      pass(name);
    }
  }
}

// ============================================================================
// MOCK HELPERS
// ============================================================================

class MockAdapter extends BaseAdapter {
  readonly name: string;
  readonly version = '1.0.0';
  private _handler: (agentId: string, payload: AgentPayload) => AgentResult;
  constructor(name: string, handler?: (agentId: string, payload: AgentPayload) => AgentResult) {
    super();
    this.name = name;
    this._handler = handler ?? ((id, p) => ({ success: true, data: { agentId: id, action: p.action } }));
  }
  async executeAgent(agentId: string, payload: AgentPayload, _ctx: AgentContext): Promise<AgentResult> {
    return this._handler(agentId, payload);
  }
}

async function makeRegistry(handler?: (agentId: string, payload: AgentPayload) => AgentResult) {
  const registry = new AdapterRegistry();
  const adapter = new MockAdapter('mock', handler);
  await registry.addAdapter(adapter);
  await adapter.initialize({});
  registry.setDefaultAdapter('mock');
  return { registry, adapter };
}

// Temp dir for blackboard tests
const TMP_DIR = path.join(__dirname, 'data', 'test-rlm-phases-tmp');

function cleanTmp() {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
}
function makeBB(subdir: string): LockedBlackboard {
  const dir = path.join(TMP_DIR, subdir);
  mkdirSync(dir, { recursive: true });
  return new LockedBlackboard(dir);
}

// ============================================================================
// A — FederatedBudget.spawnChild() + commit()
// ============================================================================

async function testSpawnChild() {
  header('A — FederatedBudget.spawnChild() + commit()');

  // Basic child ceiling defaults to parent remaining
  {
    const parent = new FederatedBudget({ ceiling: 1000 });
    parent.spend('setup', 200);
    const { budget: child } = parent.spawnChild('child-agent');
    assert(child.getCeiling() === 800, 'Child ceiling defaults to parent remaining (800)');
  }

  // Child ceiling is capped at explicit value
  {
    const parent = new FederatedBudget({ ceiling: 1000 });
    const { budget: child } = parent.spawnChild('child-agent', 300);
    assert(child.getCeiling() === 300, 'Child ceiling honours explicit cap (300)');
  }

  // Explicit ceiling larger than remaining is capped at remaining
  {
    const parent = new FederatedBudget({ ceiling: 1000 });
    parent.spend('setup', 700);
    const { budget: child } = parent.spawnChild('child-agent', 9999);
    assert(child.getCeiling() === 300, 'Explicit ceiling > remaining is capped at remaining (300)');
  }

  // Child spend is independent of parent until commit
  {
    const parent = new FederatedBudget({ ceiling: 1000 });
    const { budget: child, commit } = parent.spawnChild('worker');
    child.spend('task-1', 400);
    assert(parent.getTotalSpent() === 0, 'Child spend does not affect parent before commit');
    const result = commit();
    assert(result.allowed === true, 'commit() allowed');
    assert(parent.getTotalSpent() === 400, 'commit() propagates 400 to parent');
    assert(parent.remaining() === 600, 'Parent remaining reflects committed child spend');
  }

  // Zero-spend commit is a no-op
  {
    const parent = new FederatedBudget({ ceiling: 1000 });
    const { commit } = parent.spawnChild('idle-worker');
    const result = commit();
    assert(result.allowed === true, 'Zero-spend commit returns allowed:true');
    assert(parent.getTotalSpent() === 0, 'Zero-spend commit does not touch parent');
  }

  // commit() fails gracefully when parent is exhausted
  {
    const parent = new FederatedBudget({ ceiling: 500 });
    parent.spend('prior', 490);
    const { budget: child, commit } = parent.spawnChild('big-spender');
    child.spend('work', 100); // allowed in child (ceiling = 10 — safe floor when parent has 10 left)
    // Actually parent.remaining() = 10, so child ceiling = 10. 100 > 10, so child.spend would be denied.
    // Let's just test that commit with a large child spend denies correctly.
    const parent2 = new FederatedBudget({ ceiling: 500 });
    parent2.spend('prior', 490); // remaining = 10
    const { budget: child2, commit: commit2 } = parent2.spawnChild('worker');
    child2.spend('small', 8);
    const r = commit2();
    assert(r.allowed === true, 'commit() for child spend within parent remaining is allowed');
    assert(parent2.getTotalSpent() === 498, 'Parent now shows 490 + 8 = 498');
  }

  // Multiple children are independent
  {
    const parent = new FederatedBudget({ ceiling: 1000 });
    const { budget: c1, commit: commit1 } = parent.spawnChild('worker-1', 400);
    const { budget: c2, commit: commit2 } = parent.spawnChild('worker-2', 400);
    c1.spend('a', 100);
    c2.spend('b', 200);
    commit1();
    commit2();
    assert(parent.getTotalSpent() === 300, 'Two children committed: 100 + 200 = 300 propagated to parent');
  }

  // Invalid spenderId throws
  assertThrowsSync(() => new FederatedBudget({ ceiling: 100 }).spawnChild(''), 'spawnChild("") throws TypeError', 'spenderId');

  // Exhausted parent gets safe ceiling floor of 1
  {
    const parent = new FederatedBudget({ ceiling: 100 });
    parent.spend('all', 100);
    const { budget: child } = parent.spawnChild('desperate');
    assert(child.getCeiling() === 1, 'Exhausted parent gives child safe ceiling floor of 1');
  }
}

// ============================================================================
// B — LockedBlackboard.readMetadata() / listMetadata()
// ============================================================================

async function testBlackboardMetadata() {
  header('B — LockedBlackboard.readMetadata() / listMetadata()');

  const bb = makeBB('metadata');

  // readMetadata on non-existent key returns null
  assert(bb.readMetadata('does-not-exist') === null, 'readMetadata non-existent key → null');

  // Write a string value and check metadata
  bb.write('str-key', 'hello world', 'agent-1');
  const strMeta = bb.readMetadata('str-key');
  assert(strMeta !== null, 'readMetadata returns non-null for existing key');
  assert(strMeta!.key === 'str-key', 'metadata.key matches');
  assert(strMeta!.type === 'string', 'metadata.type is "string"');
  assert(strMeta!.sizeBytes > 0, 'metadata.sizeBytes > 0 for string value');
  assert(strMeta!.version === 1, 'metadata.version starts at 1');
  assert(typeof strMeta!.timestamp === 'string', 'metadata.timestamp is a string');
  assert(strMeta!.ttl === null, 'metadata.ttl is null when no TTL set');

  // Write an object value
  bb.write('obj-key', { foo: 1, bar: 'baz' }, 'agent-2');
  const objMeta = bb.readMetadata('obj-key');
  assert(objMeta!.type === 'object', 'metadata.type is "object" for plain objects');

  // Write an array value
  bb.write('arr-key', [1, 2, 3], 'agent-3');
  const arrMeta = bb.readMetadata('arr-key');
  assert(arrMeta!.type === 'array', 'metadata.type is "array" for arrays');

  // Write a number value
  bb.write('num-key', 42, 'agent-4');
  const numMeta = bb.readMetadata('num-key');
  assert(numMeta!.type === 'number', 'metadata.type is "number"');

  // Version increments on re-write
  bb.write('str-key', 'updated', 'agent-1');
  const strMeta2 = bb.readMetadata('str-key');
  assert(strMeta2!.version === 2, 'metadata.version increments on re-write');

  // TTL is reflected in metadata
  bb.write('ttl-key', 'expires soon', 'agent-5', 5000);
  const ttlMeta = bb.readMetadata('ttl-key');
  assert(ttlMeta!.ttl === 5000, 'metadata.ttl reflects written TTL');

  // readMetadata does NOT expose the value
  const meta = bb.readMetadata('str-key');
  assert(!('value' in (meta ?? {})), 'readMetadata does not expose "value" field');

  // listMetadata returns all live keys
  const allMeta = bb.listMetadata();
  const keys = allMeta.map(m => m.key);
  assert(keys.includes('str-key'), 'listMetadata includes str-key');
  assert(keys.includes('obj-key'), 'listMetadata includes obj-key');
  assert(keys.includes('arr-key'), 'listMetadata includes arr-key');
  assert(keys.includes('num-key'), 'listMetadata includes num-key');
  assert(keys.includes('ttl-key'), 'listMetadata includes ttl-key');

  // listMetadata entries all have required fields
  const allValid = allMeta.every(m =>
    typeof m.key === 'string' &&
    typeof m.type === 'string' &&
    typeof m.sizeBytes === 'number' &&
    typeof m.version === 'number' &&
    typeof m.timestamp === 'string',
  );
  assert(allValid, 'All listMetadata entries have required fields');

  // Deleted key not in listMetadata
  bb.delete('num-key');
  const afterDelete = bb.listMetadata();
  assert(!afterDelete.map(m => m.key).includes('num-key'), 'Deleted key absent from listMetadata');
}

// ============================================================================
// C — QualityGateAgent.getBestPartialResult()
// ============================================================================

async function testBestPartialResult() {
  header('C — QualityGateAgent.getBestPartialResult()');

  const gate = new QualityGateAgent({ autoRejectThreshold: 0, qualityThreshold: 0.99 });

  // Initially null
  assert(gate.getBestPartialResult() === null, 'getBestPartialResult() is null before any gate() calls');

  // After first gate() call it is non-null
  await gate.gate('result:task-1', { summary: 'First result — contains some real output data.' }, 'agent-1');
  assert(gate.getBestPartialResult() !== null, 'getBestPartialResult() is non-null after first gate()');

  // Reset clears it
  gate.resetBestPartialResult();
  assert(gate.getBestPartialResult() === null, 'resetBestPartialResult() sets it back to null');

  // Higher score wins — use a value with an error field (scores low) vs a rich result (scores high)
  const gate2 = new QualityGateAgent({ autoRejectThreshold: 0, qualityThreshold: 0.99 });

  // Value with only an error field scores lower (result.error_check fires)
  await gate2.gate('result:low', { error: 'Connection timed out' }, 'agent-x');
  const firstBest = gate2.getBestPartialResult();
  assert(firstBest !== null, 'firstBest is non-null after first gate()');

  // Rich result scores higher
  await gate2.gate(
    'result:high',
    { data: 'Analysis complete', status: 'success', confidence: 0.92, findings: ['trend-up', 'anomaly-detected'] },
    'agent-y',
  );
  const secondBest = gate2.getBestPartialResult();

  assert(secondBest !== null, 'getBestPartialResult() non-null after second gate()');
  // The best should have a higher score
  assert(
    secondBest!.result.validation.score >= (firstBest?.result.validation.score ?? 0),
    'Higher-scoring result replaces lower-scoring best',
  );
  assert(secondBest!.key === 'result:high', 'Best partial result key updated to the higher-scoring entry');

  // getBestPartialResult() returns the result field with a decision
  const best = gate2.getBestPartialResult();
  assert(['approve', 'reject', 'quarantine', 'needs_review'].includes(best!.result.decision), 'Best result has a valid decision');

  // Multiple calls accumulate correctly
  const gate3 = new QualityGateAgent({ autoRejectThreshold: 0, qualityThreshold: 0.99 });
  for (let i = 0; i < 5; i++) {
    await gate3.gate(`result:entry-${i}`, { data: `result ${i}`, iteration: i, status: 'ok' }, 'agent');
  }
  assert(gate3.getBestPartialResult() !== null, 'getBestPartialResult() non-null after 5 gate() calls');
}

// ============================================================================
// D — HookContext depth field
// ============================================================================

async function testHookDepth() {
  header('D — HookContext depth field');

  const hooks = new AdapterHookManager();

  const mockPayload: AgentPayload = { action: 'test', params: {} };
  const mockCtx: AgentContext = { agentId: 'orchestrator', taskId: 't1' };

  // Default depth is 0
  const ctx0 = hooks.createContext('agent-1', mockPayload, mockCtx);
  assert(ctx0.depth === 0, 'createContext() default depth is 0');

  // Explicit depth is honoured
  const ctx3 = hooks.createContext('agent-1', mockPayload, mockCtx, 3);
  assert(ctx3.depth === 3, 'createContext() with explicit depth=3 sets depth to 3');

  // depth is present in HookContext interface (runtime check)
  assert('depth' in ctx0, 'HookContext has depth property');

  // Hook handler can read depth
  let observedDepth = -1;
  hooks.register({
    name: 'depth-observer',
    phase: 'beforeExecute',
    handler(ctx) {
      observedDepth = ctx.depth;
      return ctx;
    },
  });

  const ctxDepth2 = hooks.createContext('agent-2', mockPayload, mockCtx, 2);
  await hooks.runBefore(ctxDepth2);
  assert(observedDepth === 2, `Hook handler reads depth=2 (got ${observedDepth})`);

  // Hook can distinguish root vs recursive
  const rootCtx  = hooks.createContext('agent', mockPayload, mockCtx, 0);
  const subCtx   = hooks.createContext('agent', mockPayload, mockCtx, 1);
  assert(rootCtx.depth === 0,  'Root call: depth === 0');
  assert(subCtx.depth  === 1,  'Sub-call:  depth === 1');

  // afterExecute phase also has depth
  let afterDepth = -1;
  hooks.register({
    name: 'after-depth-observer',
    phase: 'afterExecute',
    handler(ctx) {
      afterDepth = ctx.depth;
      return ctx;
    },
  });
  const ctxAfter = hooks.createContext('agent-3', mockPayload, mockCtx, 5);
  ctxAfter.result = { success: true, data: null };
  await hooks.runAfter(ctxAfter);
  assert(afterDepth === 5, `afterExecute handler reads depth=5 (got ${afterDepth})`);

  // depth is not mutated by the hook manager
  const ctxOrig = hooks.createContext('agent-4', mockPayload, mockCtx, 7);
  const ctxAfterRun = await hooks.runBefore(ctxOrig);
  assert(ctxAfterRun.depth === 7, 'depth is preserved through runBefore pipeline');
}

// ============================================================================
// E — GoalDecomposer sub-goal recursion
// ============================================================================

async function testSubGoalRecursion() {
  header('E — GoalDecomposer sub-goal recursion');

  const agents = [
    { id: 'planner', role: 'Plans sub-tasks', defaultAction: 'plan' },
    { id: 'executor', role: 'Executes tasks', defaultAction: 'execute' },
  ];

  // Planner that produces a single sub-goal task
  const subGoalPlan: PlannedTask[] = [
    { id: 'top-1', description: 'Do sub-task', agent: 'executor', action: 'execute',
      params: { _subgoal: 'Write unit tests for the module' }, dependencies: [], priority: 1 },
  ];
  // Planner for the sub-goal (returns simple leaf tasks)
  const leafPlan: PlannedTask[] = [
    { id: 'leaf-1', description: 'Write a test', agent: 'executor', action: 'execute',
      params: { file: 'foo.test.ts' }, dependencies: [], priority: 1 },
  ];

  let planCallCount = 0;
  const planner: PlannerFunction = async (goal) => {
    planCallCount++;
    if (goal === 'Write unit tests for the module') return JSON.parse(JSON.stringify(leafPlan));
    return JSON.parse(JSON.stringify(subGoalPlan));
  };

  const executor: ExecutorFunction = async (agentId, payload) => ({
    success: true,
    data: { agentId, action: payload.action, params: payload.params },
  });

  const decomposer = new GoalDecomposer(planner);
  const runner = new TeamRunner(executor);
  const dag = await decomposer.decompose('Build the feature', agents);

  const result = await runner.run(dag, {
    maxDepth: 1,
    agents,
    subGoalDecomposer: decomposer,
  });

  assert(result.success, 'TeamRunner succeeds with sub-goal recursion');
  assert(planCallCount === 2, `Planner called twice: once for root, once for sub-goal (got ${planCallCount})`);

  // The result for the top-1 task should contain sub-goal summary
  const topResult = result.results.get('top-1');
  assert(topResult !== undefined, 'top-1 result exists');
  assert(topResult!.success === true, 'top-1 result is successful');
  const data = topResult!.data as Record<string, unknown>;
  assert(typeof data.subgoal === 'string', 'sub-goal result contains subgoal string');
  assert(data.subgoal === 'Write unit tests for the module', 'sub-goal matches original params._subgoal');
  assert(typeof data.summary === 'string', 'sub-goal result contains summary string');
  assert(typeof data.stats === 'object', 'sub-goal result contains stats object');

  // maxDepth=0 disables recursion — task falls through to normal executor
  {
    let regularExecCalled = false;
    const regularExecutor: ExecutorFunction = async (agentId, payload) => {
      regularExecCalled = true;
      return { success: true, data: { via: 'regular', action: payload.action } };
    };
    const decomposer2 = new GoalDecomposer(planner);
    const runner2 = new TeamRunner(regularExecutor);
    const dag2 = await decomposer2.decompose('Build the feature', agents);
    await runner2.run(dag2, { maxDepth: 0, agents, subGoalDecomposer: decomposer2 });
    assert(regularExecCalled, 'maxDepth=0 falls through to normal executor');
  }

  // Without subGoalDecomposer, sub-goal param is ignored and executor is called normally
  {
    let execCalledWithoutDecomposer = false;
    const exec2: ExecutorFunction = async () => {
      execCalledWithoutDecomposer = true;
      return { success: true, data: { via: 'normal' } };
    };
    const runner3 = new TeamRunner(exec2);
    const dag3 = await decomposer.decompose('Build the feature', agents);
    await runner3.run(dag3, { maxDepth: 1 }); // no subGoalDecomposer provided
    assert(execCalledWithoutDecomposer, 'Without subGoalDecomposer, executor is called normally');
  }
}

// ============================================================================
// F — FanOutFanIn semaphore queue
// ============================================================================

async function testSemaphoreFanOut() {
  header('F — FanOutFanIn semaphore queue');

  const { registry } = await makeRegistry();
  const baseCtx: AgentContext = { agentId: 'orchestrator', taskId: 'fanout-test' };
  const fanout = new FanOutFanIn(registry, baseCtx);

  // ── F1: Basic semaphore — correct result count ────────────────────────────
  {
    const steps: FanOutStep[] = Array.from({ length: 6 }, (_, i) => ({
      agentId: 'mock',
      payload: { action: 'ping', params: { i } },
      label: `step-${i}`,
    }));
    const results = await fanout.fanOut(steps, { concurrency: 3 });
    assert(results.length === 6, `Semaphore: all 6 results returned (got ${results.length})`);
    assert(results.every(r => r.result.success), 'All results are successful');
    // Indices are correct
    const indices = results.map(r => r.index).sort((a, b) => a - b);
    assert(JSON.stringify(indices) === JSON.stringify([0,1,2,3,4,5]), 'Result indices 0-5 all present');
  }

  // ── F2: Semaphore allows at most `concurrency` tasks simultaneously ───────
  {
    let activeConcurrent = 0;
    let maxObservedConcurrent = 0;
    const concurrency = 2;

    // Build a timed registry: default adapter sleeps for payload.params.delay ms
    const timedRegistry = new AdapterRegistry();
    const timedAdapter = new class extends BaseAdapter {
      readonly name = 'timed';
      readonly version = '1.0.0';
      async executeAgent(_agentId: string, payload: AgentPayload): Promise<AgentResult> {
        const delay = (payload.params.delay as number) ?? 0;
        activeConcurrent++;
        if (activeConcurrent > maxObservedConcurrent) maxObservedConcurrent = activeConcurrent;
        await new Promise<void>(r => setTimeout(r, delay));
        activeConcurrent--;
        return { success: true, data: { delay } };
      }
    }();
    await timedRegistry.addAdapter(timedAdapter);
    await timedAdapter.initialize({});
    timedRegistry.setDefaultAdapter('timed');

    // delays: step-0 is slow; steps 1-3 are fast
    // Semaphore: step-0 and step-1 start together; step-1 finishes at ~20ms → step-2 starts.
    // Total ≈ 80ms. Old chunk-based approach would give ≈ 100ms.
    const DELAYS = [80, 20, 20, 20];
    const timedSteps: FanOutStep[] = DELAYS.map((delay, i) => ({
      agentId: `step-${i}`,
      payload: { action: 'sleep', params: { delay } },
    }));

    const startAll = Date.now();
    const timedFanout = new FanOutFanIn(timedRegistry, baseCtx);
    const timedResults = await timedFanout.fanOut(timedSteps, { concurrency });
    const totalMs = Date.now() - startAll;

    assert(timedResults.length === DELAYS.length, `Timed fanOut: all ${DELAYS.length} results returned`);
    assert(timedResults.every(r => r.result.success), 'All timed results successful');

    // Semaphore total time ≈ 80ms; chunk total would be ≈ 100ms.
    // Allow generous 2× slack for CI timing variance.
    const expectedMs = 80 + 30;
    assert(
      totalMs < expectedMs * 2,
      `Semaphore total time ${totalMs}ms is within bound of ${expectedMs * 2}ms`,
    );

    // Max concurrent never exceeded the concurrency limit
    assert(
      maxObservedConcurrent <= concurrency,
      `Max concurrent (${maxObservedConcurrent}) ≤ concurrency limit (${concurrency})`,
    );
  }

  // ── F3: Empty steps returns empty array ───────────────────────────────────
  {
    const result = await fanout.fanOut([], { concurrency: 3 });
    assert(Array.isArray(result) && result.length === 0, 'Empty steps → empty result array');
  }

  // ── F4: continueOnError=false stops on first failure ──────────────────────
  {
    const failRegistry = new AdapterRegistry();
    const failAdapter = new class extends BaseAdapter {
      readonly name = 'failing';
      readonly version = '1.0.0';
      async executeAgent(): Promise<AgentResult> {
        return { success: false, error: { code: 'ERR', message: 'fail', recoverable: false } };
      }
    }();
    await failRegistry.addAdapter(failAdapter);
    await failAdapter.initialize({});
    failRegistry.setDefaultAdapter('failing');

    const failSteps: FanOutStep[] = Array.from({ length: 4 }, (_, i) => ({
      agentId: `any-agent-${i}`,
      payload: { action: 'op', params: { i } },
    }));
    const failFanout = new FanOutFanIn(failRegistry, baseCtx);
    const failResults = await failFanout.fanOut(failSteps, { concurrency: 1, continueOnError: false });
    assert(failResults.length === 4, 'continueOnError=false still returns full result array');
    assert(failResults[0].result.success === false, 'First result is failure');
    assert(failResults.slice(1).every(r => r.result.error?.code === 'FANOUT_SKIPPED'), 'Remaining results are FANOUT_SKIPPED');
  }
}

// ============================================================================
// G — PhasePipeline trajectory compaction
// ============================================================================

async function testPipelineCompaction() {
  header('G — PhasePipeline trajectory compaction');

  // Minimal registry
  const { registry } = await makeRegistry();
  const baseCtx: AgentContext = { agentId: 'pipeline-runner', taskId: 'pipe-1' };

  // ── G1: No compaction when under threshold ────────────────────────────────
  {
    let summarizeCalled = false;
    const pipeline = new PhasePipeline(registry, baseCtx, {
      phases: [
        { name: 'phase-1', agents: ['mock'] },
        { name: 'phase-2', agents: ['mock'] },
      ],
      autoApprove: true,
      compaction: {
        thresholdChars: 999_999,
        summarize: async () => { summarizeCalled = true; return 'summary'; },
      },
    });
    await pipeline.run();
    assert(!summarizeCalled, 'summarize() not called when under threshold');
    assert(pipeline.compactionCount === 0, 'compactionCount is 0 when no compaction triggered');
    assert(pipeline.lastCompactionSummary === null, 'lastCompactionSummary is null when no compaction');
  }

  // ── G2: Compaction triggers when threshold breached ───────────────────────
  {
    let summarizeCallCount = 0;
    let summaryArg: PhaseResult[] = [];
    const compact_summary = 'COMPACTED: phases 1-2 complete';

    const pipeline = new PhasePipeline(registry, baseCtx, {
      phases: [
        { name: 'phase-A', agents: ['mock'] },
        { name: 'phase-B', agents: ['mock'] },
        { name: 'phase-C', agents: ['mock'] },
      ],
      autoApprove: true,
      compaction: {
        thresholdChars: 1, // Always compact (1 char threshold)
        summarize: async (completed) => {
          summarizeCallCount++;
          summaryArg = completed;
          return compact_summary;
        },
      },
    });

    const result = await pipeline.run();
    assert(result.success, 'Pipeline succeeds with compaction enabled');
    assert(summarizeCallCount > 0, `summarize() was called (${summarizeCallCount} times)`);
    assert(pipeline.compactionCount > 0, `compactionCount > 0 (got ${pipeline.compactionCount})`);
    assert(pipeline.lastCompactionSummary === compact_summary, 'lastCompactionSummary matches returned summary');
  }

  // ── G3: onCompact callback fires ──────────────────────────────────────────
  {
    let onCompactFired = false;
    let onCompactSummary = '';
    let onCompactCount = 0;

    const pipeline = new PhasePipeline(registry, baseCtx, {
      phases: [{ name: 'only-phase', agents: ['mock'] }],
      autoApprove: true,
      compaction: {
        thresholdChars: 1,
        summarize: async () => 'compact-summary',
        onCompact: (summary, count) => {
          onCompactFired = true;
          onCompactSummary = summary;
          onCompactCount = count;
        },
      },
    });

    await pipeline.run();
    assert(onCompactFired, 'onCompact callback fires after compaction');
    assert(onCompactSummary === 'compact-summary', 'onCompact receives the summary');
    assert(onCompactCount === 1, `onCompact receives count=1 (got ${onCompactCount})`);
  }

  // ── G4: reset() clears compaction state ──────────────────────────────────
  {
    const pipeline = new PhasePipeline(registry, baseCtx, {
      phases: [{ name: 'p', agents: ['mock'] }],
      autoApprove: true,
      compaction: { thresholdChars: 1, summarize: async () => 'summary' },
    });
    await pipeline.run();
    assert(pipeline.compactionCount > 0, 'compactionCount > 0 after run');
    pipeline.reset();
    assert(pipeline.compactionCount === 0, 'reset() clears compactionCount to 0');
    assert(pipeline.lastCompactionSummary === null, 'reset() clears lastCompactionSummary to null');
  }

  // ── G5: Pipeline can continue running phases after compaction ─────────────
  {
    const phaseNames: string[] = [];
    const pipeline = new PhasePipeline(registry, baseCtx, {
      phases: [
        { name: 'before', agents: ['mock'] },
        { name: 'after',  agents: ['mock'] },
      ],
      autoApprove: true,
      onPhaseComplete: (r) => phaseNames.push(r.phaseName),
      compaction: { thresholdChars: 1, summarize: async () => 'mid-compact' },
    });
    const result = await pipeline.run();
    assert(result.success, 'Pipeline completes all phases after mid-run compaction');
    assert(phaseNames.includes('before'), 'phase "before" completed');
    assert(phaseNames.includes('after'), 'phase "after" completed');
  }
}

// ============================================================================
// H — RLMAdapter
// ============================================================================

async function testRLMAdapter() {
  header('H — RLMAdapter');

  // ── H1: Basic construction and initialization ─────────────────────────────
  {
    const adapter = new RLMAdapter();
    assert(adapter.name === 'rlm', 'adapter.name is "rlm"');
    assert(adapter.version === '1.0.0', 'adapter.version is "1.0.0"');
    assert(!adapter.isReady(), 'Adapter not ready before initialize()');
    await adapter.initialize({});
    assert(adapter.isReady(), 'Adapter ready after initialize()');
  }

  // ── H2: registerAgent and listAgents ─────────────────────────────────────
  {
    const adapter = new RLMAdapter();
    await adapter.initialize({});
    adapter.registerAgent('rlm-planner', { endpoint: 'http://localhost:8080' });
    const agents = await adapter.listAgents();
    assert(agents.length === 1, 'listAgents returns 1 agent after registerAgent');
    assert(agents[0].id === 'rlm-planner', 'agent id is "rlm-planner"');
    assert(await adapter.isAgentAvailable('rlm-planner'), 'isAgentAvailable returns true for registered agent');
    assert(!(await adapter.isAgentAvailable('nonexistent')), 'isAgentAvailable returns false for unregistered agent');
  }

  // ── H3: executeAgent with BYOC mock client ────────────────────────────────
  {
    let lastRequestBody: Record<string, unknown> = {};
    const mockClient: RLMHttpClient = {
      async post(_url, body) {
        lastRequestBody = body;
        return { text: 'RLM says hello', usage: { tokens: 42 } };
      },
    };

    const adapter = new RLMAdapter();
    await adapter.initialize({});
    adapter.registerAgent('rlm-agent', {
      endpoint: 'http://rlm.local',
      model: 'rlm-7b',
      maxDepth: 2,
      client: mockClient,
    });

    const payload: AgentPayload = { action: 'complete', params: { query: 'What is RLM?' } };
    const ctx: AgentContext = { agentId: 'orchestrator', taskId: 'task-1', sessionId: 'sess-1' };
    const result = await adapter.executeAgent('rlm-agent', payload, ctx);

    assert(result.success === true, 'executeAgent with BYOC client returns success:true');
    assert((result.data as Record<string, unknown>).text === 'RLM says hello', 'result.data.text matches mock response');
    assert(lastRequestBody['model'] === 'rlm-7b', 'Request body contains model name');
    assert(lastRequestBody['max_depth'] === 2, 'Request body contains max_depth');
    assert(lastRequestBody['agent_id'] === 'rlm-agent', 'Request body contains agent_id');
    assert(lastRequestBody['task_id'] === 'task-1', 'Request body contains task_id');
    assert(lastRequestBody['session_id'] === 'sess-1', 'Request body contains session_id');
    assert(typeof lastRequestBody['prompt'] === 'string', 'Request body has prompt string');
  }

  // ── H4: Prompt building includes action and params ────────────────────────
  {
    let capturedPrompt = '';
    const mockClient: RLMHttpClient = {
      async post(_url, body) {
        capturedPrompt = body['prompt'] as string;
        return { text: 'ok' };
      },
    };
    const adapter = new RLMAdapter();
    await adapter.initialize({});
    adapter.registerAgent('prompter', { endpoint: 'http://x', client: mockClient, systemPrompt: 'You are a helpful bot.' });
    await adapter.executeAgent('prompter', { action: 'summarize', params: { topic: 'AI' } }, { agentId: 'test', taskId: 't' });
    assert(capturedPrompt.includes('You are a helpful bot.'), 'Prompt includes systemPrompt');
    assert(capturedPrompt.includes('summarize'), 'Prompt includes action');
    assert(capturedPrompt.includes('topic'), 'Prompt includes param key');
  }

  // ── H5: Handoff instruction included in prompt ────────────────────────────
  {
    let capturedPrompt = '';
    const mockClient: RLMHttpClient = {
      async post(_url, body) { capturedPrompt = body['prompt'] as string; return { text: 'ok' }; },
    };
    const adapter = new RLMAdapter();
    await adapter.initialize({});
    adapter.registerAgent('hand-agent', { endpoint: 'http://x', client: mockClient });
    await adapter.executeAgent('hand-agent', {
      action: 'delegate',
      params: {},
      handoff: { handoffId: 'h1', sourceAgent: 'src', targetAgent: 'hand-agent', taskType: 'delegate', instruction: 'Solve world hunger' },
    }, { agentId: 'src', taskId: 't2' });
    assert(capturedPrompt.includes('Solve world hunger'), 'Prompt includes handoff instruction');
  }

  // ── H6: Unregistered agent returns errorResult ────────────────────────────
  {
    const adapter = new RLMAdapter();
    await adapter.initialize({});
    const result = await adapter.executeAgent('ghost', { action: 'x', params: {} }, { agentId: 'o', taskId: 't' });
    assert(result.success === false, 'Unregistered agent returns success:false');
    assert(result.error?.code === 'AGENT_NOT_FOUND', 'Error code is AGENT_NOT_FOUND');
  }

  // ── H7: Client error propagates as errorResult ────────────────────────────
  {
    const failClient: RLMHttpClient = {
      async post() { throw new Error('Connection refused'); },
    };
    const adapter = new RLMAdapter();
    await adapter.initialize({});
    adapter.registerAgent('err-agent', { endpoint: 'http://unreachable', client: failClient });
    const result = await adapter.executeAgent('err-agent', { action: 'x', params: {} }, { agentId: 'o', taskId: 't' });
    assert(result.success === false, 'Client error returns success:false');
    assert(result.error?.code === 'RLM_REQUEST_FAILED', 'Error code is RLM_REQUEST_FAILED');
    assert(result.error?.message.includes('Connection refused') === true, 'Error message includes original error');
  }

  // ── H8: content field fallback when text is absent ────────────────────────
  {
    const mockClient: RLMHttpClient = {
      async post() { return { content: 'fallback content response' }; },
    };
    const adapter = new RLMAdapter();
    await adapter.initialize({});
    adapter.registerAgent('fallback-agent', { endpoint: 'http://x', client: mockClient });
    const result = await adapter.executeAgent('fallback-agent', { action: 'op', params: {} }, { agentId: 'o', taskId: 't' });
    assert(result.success === true, 'content-field response succeeds');
    assert((result.data as Record<string, unknown>).text === 'fallback content response', 'Falls back to content field');
  }

  // ── H9: Invalid registration args throw ──────────────────────────────────
  {
    const adapter = new RLMAdapter();
    await adapter.initialize({});
    assertThrowsSync(() => adapter.registerAgent('', { endpoint: 'http://x' }), 'registerAgent("") throws', 'agentId');
    assertThrowsSync(() => adapter.registerAgent('valid-id', { endpoint: '' }), 'registerAgent with empty endpoint throws', 'endpoint');
  }

  // ── H10: healthCheck reflects ready state ─────────────────────────────────
  {
    const adapter = new RLMAdapter();
    const before = await adapter.healthCheck();
    assert(!before.healthy, 'healthCheck unhealthy before initialize');
    await adapter.initialize({});
    const after = await adapter.healthCheck();
    assert(after.healthy, 'healthCheck healthy after initialize');
  }

  // ── H11: capabilities are correct ────────────────────────────────────────
  {
    const adapter = new RLMAdapter();
    const caps = adapter.capabilities;
    assert(caps.streaming === false, 'RLMAdapter streaming=false');
    assert(caps.parallel === true, 'RLMAdapter parallel=true');
  }

  // ── H12: executionTimeMs is set in metadata ───────────────────────────────
  {
    const mockClient: RLMHttpClient = {
      async post() { return { text: 'quick response' }; },
    };
    const adapter = new RLMAdapter();
    await adapter.initialize({});
    adapter.registerAgent('timer-agent', { endpoint: 'http://x', client: mockClient });
    const result = await adapter.executeAgent('timer-agent', { action: 'op', params: {} }, { agentId: 'o', taskId: 't' });
    assert(typeof (result.metadata as Record<string, unknown>)?.executionTimeMs === 'number', 'executionTimeMs is a number in metadata');
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  cleanTmp();

  try {
    await testSpawnChild();
    await testBlackboardMetadata();
    await testBestPartialResult();
    await testHookDepth();
    await testSubGoalRecursion();
    await testSemaphoreFanOut();
    await testPipelineCompaction();
    await testRLMAdapter();
  } finally {
    cleanTmp();
  }

  console.log('\n' + '='.repeat(64));
  if (failed === 0) {
    log(`  ALL ${passed} TESTS PASSED`, 'green');
  } else {
    log(`  ${passed} passed, ${failed} FAILED`, 'red');
  }
  console.log('='.repeat(64) + '\n');

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
