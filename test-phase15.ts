/**
 * test-phase15.ts
 *
 * v5.13.0 — Orchestration resilience (Tier 2):
 *   #4 Per-sub-agent fallback + retry budgets (RetryBudget, FanOutFanIn, TeamRunner)
 *   #5 Effort governance (EffortPolicy)
 */

import { RetryBudget } from './lib/retry-budget';
import { EffortPolicy } from './lib/effort-policy';
import { FanOutFanIn, type FanOutStep } from './lib/fan-out';
import { TeamRunner, type TaskDAG, type TaskNode } from './lib/goal-decomposer';
import type { AdapterRegistry } from './adapters/adapter-registry';
import type { AgentResult, AgentContext, AgentPayload } from './types/agent-adapter';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];
function pass(label: string) { passed++; process.stdout.write(`  ✓ ${label}\n`); }
function fail(label: string, reason: string) { failed++; failures.push(`${label}: ${reason}`); process.stdout.write(`  ✗ ${label} — ${reason}\n`); }
function assert(cond: boolean, label: string, detail = '') { if (cond) pass(label); else fail(label, detail || 'assertion failed'); }
function header(t: string) { process.stdout.write(`\n=== ${t} ===\n`); }

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeRegistry(behavior: (agentId: string) => AgentResult): AdapterRegistry {
  return {
    executeAgent: async (agentId: string, _p: AgentPayload, _c: AgentContext) => behavior(agentId),
  } as unknown as AdapterRegistry;
}

const okResult: AgentResult = { success: true, data: 'ok' };
const failResult: AgentResult = { success: false, error: { code: 'X', message: 'fail', recoverable: true } };

function buildDag(nodes: TaskNode[]): TaskDAG {
  const edges = new Map<string, string[]>();
  for (const n of nodes) edges.set(n.id, []);
  return { goal: 'test', nodes, edges, createdAt: Date.now() };
}

function node(id: string, agent: string, extra: Partial<TaskNode> = {}): TaskNode {
  return { id, description: id, agent, action: 'do', params: {}, dependencies: [], priority: 0, status: 'pending', ...extra };
}

// ---------------------------------------------------------------------------
// #4a RetryBudget
// ---------------------------------------------------------------------------

function testRetryBudget() {
  header('#4 RetryBudget — per-key allowance and isolation');
  const b = new RetryBudget({ maxPerKey: 2 });
  assert(b.tryConsume('a') && b.tryConsume('a'), 'two retries allowed for key a');
  assert(!b.tryConsume('a'), 'third retry denied for key a');
  assert(b.used('a') === 2 && b.remaining('a') === 0, 'used/remaining tracked');
  assert(b.tryConsume('b'), 'key b has its own independent budget');
  b.reset('a');
  assert(b.tryConsume('a'), 'reset restores key a');
  assert(b.getMax() === 2, 'getMax reports configured max');

  let threw = false;
  try { new RetryBudget({ maxPerKey: -1 }); } catch { threw = true; }
  assert(threw, 'negative maxPerKey rejected');
}

// ---------------------------------------------------------------------------
// #4b Fan-out per-sub-agent fallback
// ---------------------------------------------------------------------------

async function testFanOutFallback() {
  header('#4 FanOutFanIn — per-step fallback + retries');
  const reg = fakeRegistry((id) => (id === 'good' ? okResult : failResult));
  const fan = new FanOutFanIn(reg, { agentId: 'orchestrator' });

  // Primary fails → fallback serves
  const step1: FanOutStep = { agentId: 'bad', payload: { action: 'x', params: {} }, fallbackAgentId: 'good' };
  const [r1] = await fan.fanOut([step1]);
  assert(r1.result.success, 'fallback agent served the step');
  assert(r1.fellBackTo === 'good', 'fellBackTo records the fallback agent', String(r1.fellBackTo));
  assert(r1.retryAttempts === 2, 'one primary + one fallback attempt', String(r1.retryAttempts));

  // Retries then fallback
  const step2: FanOutStep = { agentId: 'bad', payload: { action: 'x', params: {} }, retries: 2, fallbackAgentId: 'good' };
  const [r2] = await fan.fanOut([step2]);
  assert(r2.result.success && r2.fellBackTo === 'good', 'served by fallback after retries');
  assert(r2.retryAttempts === 4, 'three primary tries + one fallback', String(r2.retryAttempts));

  // Retries, no fallback, still failing
  const step3: FanOutStep = { agentId: 'bad', payload: { action: 'x', params: {} }, retries: 1 };
  const [r3] = await fan.fanOut([step3]);
  assert(!r3.result.success && r3.retryAttempts === 2, 'exhausts retries with no fallback', String(r3.retryAttempts));

  // No resilience configured → simple path (no retryAttempts field)
  const step4: FanOutStep = { agentId: 'good', payload: { action: 'x', params: {} } };
  const [r4] = await fan.fanOut([step4]);
  assert(r4.result.success && r4.retryAttempts === undefined, 'simple path unchanged when no resilience');
}

// ---------------------------------------------------------------------------
// #4c Goal-decomposer per-task fallback
// ---------------------------------------------------------------------------

async function testDecomposerFallback() {
  header('#4 TeamRunner — per-task fallback agent');
  const executor = async (agentId: string): Promise<AgentResult> => (agentId === 'fb' ? okResult : failResult);
  const runner = new TeamRunner(executor);
  const n = node('t1', 'primary', { fallbackAgent: 'fb' });
  const dag = buildDag([n]);
  const result = await runner.run(dag);
  assert(result.success, 'run succeeds when fallback serves');
  assert(n.status === 'completed', 'task completed via fallback', n.status);
  assert(n.fellBackTo === 'fb', 'node.fellBackTo records fallback', String(n.fellBackTo));
}

async function testDecomposerRetries() {
  header('#4 TeamRunner — per-task retry budget');
  let calls = 0;
  const executor = async (): Promise<AgentResult> => { calls++; return calls >= 3 ? okResult : failResult; };
  const runner = new TeamRunner(executor);
  const n = node('t1', 'flaky');
  const dag = buildDag([n]);
  const result = await runner.run(dag, { retriesPerTask: 2 });
  assert(result.success, 'run succeeds on 3rd attempt');
  assert(n.status === 'completed', 'flaky task completed after retries', n.status);
  assert(calls === 3, 'exactly three attempts made', String(calls));
}

async function testDecomposerDefaultPathUnchanged() {
  header('#4 TeamRunner — default path unchanged (no retries/fallback)');
  const executor = async (): Promise<AgentResult> => failResult;
  const runner = new TeamRunner(executor);
  const n = node('t1', 'primary');
  const dag = buildDag([n]);
  const result = await runner.run(dag);
  assert(!result.success, 'failing task with no resilience still fails');
  assert(n.status === 'failed' && n.fellBackTo === undefined, 'no fallback applied on default path');
}

// ---------------------------------------------------------------------------
// #5 EffortPolicy
// ---------------------------------------------------------------------------

function testEffortPolicy() {
  header('#5 EffortPolicy — ceilings, defaults, justification');
  const capped = new EffortPolicy({ ceiling: 'high' });
  assert(capped.resolve('max') === 'high', 'global ceiling clamps max → high');
  assert(capped.resolve(undefined) === 'high', 'omitted effort uses default high');
  assert(capped.resolve('low') === 'low', 'below-ceiling effort unchanged');

  const perAgent = new EffortPolicy({ ceiling: 'max', perAgent: { sub: 'low' } });
  assert(perAgent.resolve('max', { agentId: 'sub' }) === 'low', 'per-agent ceiling clamps sub-agent to low');
  assert(perAgent.resolve('max', { agentId: 'other' }) === 'max', 'other agents keep global ceiling');

  const gated = new EffortPolicy({ ceiling: 'max', requireJustificationAtOrAbove: 'xhigh' });
  const d1 = gated.gate('max', {});
  assert(d1.reason === 'justification_required' && d1.downgraded, 'max without justification is downgraded');
  assert(d1.granted === 'high', 'clamped to highest tier below threshold', d1.granted);
  const d2 = gated.gate('max', { justification: 'frontier task' });
  assert(d2.granted === 'max' && !d2.downgraded, 'justification unlocks max');

  const ceilGate = new EffortPolicy({ ceiling: 'high' });
  const d3 = ceilGate.gate('max', {});
  assert(d3.granted === 'high' && d3.reason === 'global_ceiling', 'gate reports global_ceiling downgrade');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  process.stdout.write('\n========================================\n');
  process.stdout.write('  Phase 15 — Orchestration Resilience (Tier 2)\n');
  process.stdout.write('========================================\n');

  testRetryBudget();
  await testFanOutFallback();
  await testDecomposerFallback();
  await testDecomposerRetries();
  await testDecomposerDefaultPathUnchanged();
  testEffortPolicy();

  process.stdout.write(`\n========================================\n`);
  process.stdout.write(`  Phase 15: ${passed} passed, ${failed} failed\n`);
  process.stdout.write('========================================\n');
  if (failed > 0) {
    process.stdout.write('\nFailures:\n');
    failures.forEach((f) => process.stdout.write(`  - ${f}\n`));
    process.exit(1);
  }
}

main().catch((err) => { process.stdout.write(`\nFATAL: ${err instanceof Error ? err.stack : String(err)}\n`); process.exit(1); });
