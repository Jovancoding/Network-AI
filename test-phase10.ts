/**
 * Phase 10: Goal Decomposer — LLM-powered goal → task DAG → parallel execution
 * Run with: npx ts-node test-phase10.ts
 */

import {
  GoalDecomposer,
  TeamRunner,
  runTeam,
  createLLMPlanner,
  validateDAG,
  topologicalLayers,
  parsePlanJSON,
} from './lib/goal-decomposer';

import type {
  TaskNode,
  TaskDAG,
  TeamAgent,
  PlannedTask,
  PlannerFunction,
  ExecutorFunction,
  RunTeamOptions,
  TeamResult,
} from './lib/goal-decomposer';

import type { AgentPayload, AgentContext, AgentResult } from './types/agent-adapter';

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

async function assertThrows(fn: () => unknown, name: string, expectedMsg?: string) {
  try {
    await fn();
    fail(name, 'Expected error but nothing was thrown');
  } catch (e) {
    if (expectedMsg) {
      const msg = (e as Error).message ?? String(e);
      msg.includes(expectedMsg) ? pass(name) : fail(name, `Expected "${expectedMsg}", got: "${msg}"`);
    } else {
      pass(name);
    }
  }
}

// ============================================================================
// MOCK HELPERS
// ============================================================================

const SAMPLE_AGENTS: TeamAgent[] = [
  { id: 'researcher', role: 'Research topics and gather information', defaultAction: 'research' },
  { id: 'writer', role: 'Write documents and summaries', defaultAction: 'write' },
  { id: 'reviewer', role: 'Review and validate outputs', defaultAction: 'review' },
];

const SAMPLE_PLAN: PlannedTask[] = [
  { id: 'task-1', description: 'Research the topic', agent: 'researcher', action: 'research', params: { query: 'REST APIs' }, dependencies: [], priority: 2 },
  { id: 'task-2', description: 'Write the document', agent: 'writer', action: 'write', params: { format: 'markdown' }, dependencies: ['task-1'], priority: 1 },
  { id: 'task-3', description: 'Review the output', agent: 'reviewer', action: 'review', params: {}, dependencies: ['task-2'], priority: 1 },
];

const PARALLEL_PLAN: PlannedTask[] = [
  { id: 'a', description: 'Task A', agent: 'researcher', action: 'research', params: {}, dependencies: [], priority: 1 },
  { id: 'b', description: 'Task B', agent: 'writer', action: 'write', params: {}, dependencies: [], priority: 2 },
  { id: 'c', description: 'Task C', agent: 'reviewer', action: 'review', params: {}, dependencies: ['a', 'b'], priority: 1 },
];

/** Create a mock planner that returns a fixed plan */
function mockPlanner(plan: PlannedTask[]): PlannerFunction {
  return async () => JSON.parse(JSON.stringify(plan));
}

/** Create a mock planner that fails N times then succeeds */
function failingPlanner(failCount: number, plan: PlannedTask[]): PlannerFunction {
  let attempts = 0;
  return async () => {
    attempts++;
    if (attempts <= failCount) throw new Error(`Planning attempt ${attempts} failed`);
    return JSON.parse(JSON.stringify(plan));
  };
}

/** Create a mock executor that succeeds with deterministic data */
function mockExecutor(delay = 0): ExecutorFunction {
  return async (agentId: string, payload: AgentPayload, context: AgentContext): Promise<AgentResult> => {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return {
      success: true,
      data: { agent: agentId, action: payload.action, taskId: context.taskId },
      metadata: { executionTimeMs: delay, adapter: 'mock' },
    };
  };
}

/** Create a mock executor that fails for specified tasks */
function failingExecutor(failTasks: Set<string>): ExecutorFunction {
  return async (agentId: string, payload: AgentPayload, context: AgentContext): Promise<AgentResult> => {
    if (failTasks.has(context.taskId ?? '')) {
      return {
        success: false,
        error: { code: 'TASK_FAILED', message: `${context.taskId} deliberately failed`, recoverable: false },
      };
    }
    return { success: true, data: { agent: agentId, taskId: context.taskId } };
  };
}

/** Create a mock executor that throws for specified tasks */
function throwingExecutor(throwTasks: Set<string>): ExecutorFunction {
  return async (_agentId: string, _payload: AgentPayload, context: AgentContext): Promise<AgentResult> => {
    if (throwTasks.has(context.taskId ?? '')) {
      throw new Error(`${context.taskId} exploded`);
    }
    return { success: true, data: { taskId: context.taskId } };
  };
}

// ============================================================================
// 10a — DAG VALIDATION
// ============================================================================

async function test10a() {
  header('10a — DAG Validation');

  // Valid DAGs
  validateDAG(SAMPLE_PLAN);
  pass('Linear chain is valid');

  validateDAG(PARALLEL_PLAN);
  pass('Diamond DAG is valid');

  validateDAG([{ id: 'solo', description: 'Solo', agent: 'x', action: 'go', params: {}, dependencies: [] }]);
  pass('Single node is valid');

  validateDAG([]);
  pass('Empty plan is valid');

  // Duplicate IDs
  await assertThrows(
    () => validateDAG([
      { id: 'dup', description: 'A', agent: 'x', action: 'go', params: {}, dependencies: [] },
      { id: 'dup', description: 'B', agent: 'y', action: 'go', params: {}, dependencies: [] },
    ]),
    'Rejects duplicate task IDs',
    'Duplicate task IDs',
  );

  // Unknown dependency
  await assertThrows(
    () => validateDAG([
      { id: 't1', description: 'A', agent: 'x', action: 'go', params: {}, dependencies: ['nonexistent'] },
    ]),
    'Rejects unknown dependency reference',
    'unknown task "nonexistent"',
  );

  // Self-dependency
  await assertThrows(
    () => validateDAG([
      { id: 't1', description: 'A', agent: 'x', action: 'go', params: {}, dependencies: ['t1'] },
    ]),
    'Rejects self-dependency',
    'depends on itself',
  );

  // Simple cycle: A→B, B→A
  await assertThrows(
    () => validateDAG([
      { id: 'a', description: 'A', agent: 'x', action: 'go', params: {}, dependencies: ['b'] },
      { id: 'b', description: 'B', agent: 'y', action: 'go', params: {}, dependencies: ['a'] },
    ]),
    'Rejects simple cycle',
    'cycle',
  );

  // Longer cycle: A→B→C→A
  await assertThrows(
    () => validateDAG([
      { id: 'a', description: 'A', agent: 'x', action: 'go', params: {}, dependencies: ['c'] },
      { id: 'b', description: 'B', agent: 'y', action: 'go', params: {}, dependencies: ['a'] },
      { id: 'c', description: 'C', agent: 'z', action: 'go', params: {}, dependencies: ['b'] },
    ]),
    'Rejects longer cycle',
    'cycle',
  );
}

// ============================================================================
// 10b — TOPOLOGICAL LAYERS
// ============================================================================

async function test10b() {
  header('10b — Topological Layers');

  // Linear chain: 3 layers
  const linearLayers = topologicalLayers(SAMPLE_PLAN);
  assert(linearLayers.length === 3, 'Linear chain produces 3 layers');
  assert(linearLayers[0].includes('task-1'), 'Layer 0 contains task-1');
  assert(linearLayers[1].includes('task-2'), 'Layer 1 contains task-2');
  assert(linearLayers[2].includes('task-3'), 'Layer 2 contains task-3');

  // Parallel start: 2 layers
  const parallelLayers = topologicalLayers(PARALLEL_PLAN);
  assert(parallelLayers.length === 2, 'Diamond DAG produces 2 layers');
  assert(parallelLayers[0].length === 2, 'Layer 0 has 2 parallel tasks');
  assert(parallelLayers[0].includes('a') && parallelLayers[0].includes('b'), 'Layer 0 contains a and b');
  assert(parallelLayers[1].includes('c'), 'Layer 1 contains c');

  // All parallel (no deps)
  const allParallel: PlannedTask[] = [
    { id: 'x', description: 'X', agent: 'a', action: 'go', params: {}, dependencies: [] },
    { id: 'y', description: 'Y', agent: 'b', action: 'go', params: {}, dependencies: [] },
    { id: 'z', description: 'Z', agent: 'c', action: 'go', params: {}, dependencies: [] },
  ];
  const pLayers = topologicalLayers(allParallel);
  assert(pLayers.length === 1, 'All-parallel plan yields 1 layer');
  assert(pLayers[0].length === 3, 'Single layer has all 3 tasks');

  // Empty plan
  const emptyLayers = topologicalLayers([]);
  assert(emptyLayers.length === 0, 'Empty plan produces 0 layers');

  // Complex diamond: A→C, B→C, C→D, C→E, D→F, E→F
  const complexPlan: PlannedTask[] = [
    { id: 'A', description: 'A', agent: 'x', action: 'go', params: {}, dependencies: [] },
    { id: 'B', description: 'B', agent: 'x', action: 'go', params: {}, dependencies: [] },
    { id: 'C', description: 'C', agent: 'x', action: 'go', params: {}, dependencies: ['A', 'B'] },
    { id: 'D', description: 'D', agent: 'x', action: 'go', params: {}, dependencies: ['C'] },
    { id: 'E', description: 'E', agent: 'x', action: 'go', params: {}, dependencies: ['C'] },
    { id: 'F', description: 'F', agent: 'x', action: 'go', params: {}, dependencies: ['D', 'E'] },
  ];
  const cLayers = topologicalLayers(complexPlan);
  assert(cLayers.length === 4, 'Complex diamond produces 4 layers');
  assert(cLayers[0].length === 2, 'Layer 0: A, B');
  assert(cLayers[1].length === 1 && cLayers[1][0] === 'C', 'Layer 1: C');
  assert(cLayers[2].length === 2, 'Layer 2: D, E');
  assert(cLayers[3].length === 1 && cLayers[3][0] === 'F', 'Layer 3: F');
}

// ============================================================================
// 10c — JSON PARSING
// ============================================================================

async function test10c() {
  header('10c — Plan JSON Parsing');

  // Plain JSON array
  const plain = parsePlanJSON(JSON.stringify(SAMPLE_PLAN));
  assert(plain.length === 3, 'Parses plain JSON array');
  assert(plain[0].id === 'task-1', 'First task has correct ID');

  // With markdown code fence
  const fenced = parsePlanJSON('```json\n' + JSON.stringify(SAMPLE_PLAN) + '\n```');
  assert(fenced.length === 3, 'Parses JSON inside code fence');

  // With preamble text before JSON
  const withPreamble = parsePlanJSON('Here is the plan:\n\n' + JSON.stringify(SAMPLE_PLAN));
  assert(withPreamble.length === 3, 'Parses JSON with preamble text');

  // Fence without json language tag
  const plainFence = parsePlanJSON('```\n' + JSON.stringify([SAMPLE_PLAN[0]]) + '\n```');
  assert(plainFence.length === 1, 'Parses JSON inside plain code fence');

  // Invalid JSON
  await assertThrows(
    () => parsePlanJSON('not json at all'),
    'Rejects invalid JSON',
    'Failed to parse',
  );

  // JSON object instead of array
  await assertThrows(
    () => parsePlanJSON('{"not": "array"}'),
    'Rejects JSON object (needs array)',
    'Expected JSON array',
  );

  // Empty array
  const empty = parsePlanJSON('[]');
  assert(empty.length === 0, 'Parses empty array');
}

// ============================================================================
// 10d — GOAL DECOMPOSER
// ============================================================================

async function test10d() {
  header('10d — GoalDecomposer');

  const decomposer = new GoalDecomposer(mockPlanner(SAMPLE_PLAN));

  // Basic decomposition
  const dag = await decomposer.decompose('Write a blog post', SAMPLE_AGENTS);
  assert(dag.goal === 'Write a blog post', 'DAG stores goal');
  assert(dag.nodes.length === 3, 'DAG has 3 nodes');
  assert(dag.edges.size === 3, 'DAG has 3 edge entries');
  assert(dag.nodes[0].status === 'pending', 'All nodes start as pending');
  assert(dag.createdAt > 0, 'DAG has creation timestamp');

  // Edge structure
  const task1Downstream = dag.edges.get('task-1');
  assert(task1Downstream !== undefined && task1Downstream.includes('task-2'), 'task-1 → task-2 edge exists');
  const task2Downstream = dag.edges.get('task-2');
  assert(task2Downstream !== undefined && task2Downstream.includes('task-3'), 'task-2 → task-3 edge exists');
  const task3Downstream = dag.edges.get('task-3');
  assert(task3Downstream !== undefined && task3Downstream.length === 0, 'task-3 has no downstream edges');

  // Validation: empty goal
  await assertThrows(
    () => decomposer.decompose('', SAMPLE_AGENTS),
    'Rejects empty goal',
    'non-empty string',
  );

  // Validation: no agents
  await assertThrows(
    () => decomposer.decompose('Do stuff', []),
    'Rejects empty agent list',
    'At least one agent',
  );

  // Validation: duplicate agent IDs
  await assertThrows(
    () => decomposer.decompose('Do stuff', [
      { id: 'a', role: 'role1' },
      { id: 'a', role: 'role2' },
    ]),
    'Rejects duplicate agent IDs',
    'Duplicate agent IDs',
  );

  // Validation: plan references unknown agent
  const badAgentPlan: PlannedTask[] = [
    { id: 't1', description: 'Test', agent: 'nonexistent_agent', action: 'go', params: {}, dependencies: [] },
  ];
  const badDecomposer = new GoalDecomposer(mockPlanner(badAgentPlan));
  await assertThrows(
    () => badDecomposer.decompose('Do stuff', [{ id: 'only_agent', role: 'role' }]),
    'Rejects plan referencing unknown agent',
    'unknown agent',
  );

  // Retry logic
  const retryDecomposer = new GoalDecomposer(failingPlanner(1, SAMPLE_PLAN));
  const retryDag = await retryDecomposer.decompose('Retry test', SAMPLE_AGENTS, undefined, 1);
  assert(retryDag.nodes.length === 3, 'Succeeds after retry on planning failure');

  // Retry exhaustion
  const noRetryDecomposer = new GoalDecomposer(failingPlanner(3, SAMPLE_PLAN));
  await assertThrows(
    () => noRetryDecomposer.decompose('Will fail', SAMPLE_AGENTS, undefined, 1),
    'Fails after retries exhausted',
    'Planning attempt',
  );
}

// ============================================================================
// 10e — TEAM RUNNER: BASIC EXECUTION
// ============================================================================

async function test10e() {
  header('10e — TeamRunner Basic Execution');

  const decomposer = new GoalDecomposer(mockPlanner(SAMPLE_PLAN));
  const dag = await decomposer.decompose('Build something', SAMPLE_AGENTS);

  const runner = new TeamRunner(mockExecutor());
  const result = await runner.run(dag);

  assert(result.success === true, 'Linear chain succeeds');
  assert(result.stats.total === 3, 'Total is 3');
  assert(result.stats.completed === 3, 'All 3 completed');
  assert(result.stats.failed === 0, 'None failed');
  assert(result.stats.skipped === 0, 'None skipped');
  assert(result.durationMs >= 0, 'Duration is recorded');
  assert(result.summary.includes('3/3'), 'Summary says 3/3');
  assert(result.results.size === 3, 'Results map has 3 entries');

  // Check individual results
  const t1Res = result.results.get('task-1');
  assert(t1Res !== undefined && t1Res.success === true, 'task-1 result is success');
  assert(
    t1Res !== undefined && (t1Res.data as Record<string, unknown>)?.agent === 'researcher',
    'task-1 was executed by researcher',
  );

  // Parallel execution
  const parallelDecomposer = new GoalDecomposer(mockPlanner(PARALLEL_PLAN));
  const parallelDag = await parallelDecomposer.decompose('Parallel test', SAMPLE_AGENTS);
  const parallelResult = await runner.run(parallelDag);
  assert(parallelResult.success === true, 'Parallel DAG succeeds');
  assert(parallelResult.stats.completed === 3, 'All 3 parallel tasks completed');
}

// ============================================================================
// 10f — TEAM RUNNER: FAILURE HANDLING
// ============================================================================

async function test10f() {
  header('10f — TeamRunner Failure Handling');

  const decomposer = new GoalDecomposer(mockPlanner(SAMPLE_PLAN));

  // Task failure aborts downstream (default: continueOnFailure = false)
  const dag1 = await decomposer.decompose('Fail test', SAMPLE_AGENTS);
  const failRunner = new TeamRunner(failingExecutor(new Set(['task-1'])));
  const result1 = await failRunner.run(dag1);
  assert(result1.success === false, 'Fails when a task fails');
  assert(result1.stats.failed === 1, '1 task failed');
  assert(result1.stats.skipped >= 1, 'Downstream tasks were skipped');

  // With continueOnFailure
  const dag2 = await decomposer.decompose('Continue test', SAMPLE_AGENTS);
  const result2 = await failRunner.run(dag2, { continueOnFailure: true });
  assert(result2.success === false, 'Still reports failure with continueOnFailure');
  assert(result2.stats.failed === 1, '1 task failed with continueOnFailure');
  // task-2 depends on task-1 but with continueOnFailure it should still try
  // (but task-2 will work with the failing executor since only task-1 fails)

  // Task throwing exception
  const dag3 = await decomposer.decompose('Throw test', SAMPLE_AGENTS);
  const throwRunner = new TeamRunner(throwingExecutor(new Set(['task-2'])));
  const result3 = await throwRunner.run(dag3);
  assert(result3.success === false, 'Fails when executor throws');
  assert(result3.stats.failed >= 1, 'At least 1 task failed from throw');
  const failedNode = dag3.nodes.find((n) => n.id === 'task-2');
  assert(
    failedNode !== undefined && failedNode.error !== undefined && failedNode.error.includes('exploded'),
    'Error message captured from thrown exception',
  );
}

// ============================================================================
// 10g — TEAM RUNNER: CONCURRENCY & TIMEOUTS
// ============================================================================

async function test10g() {
  header('10g — Concurrency & Timeouts');

  // Test concurrency limiting
  const widePlan: PlannedTask[] = [];
  for (let i = 0; i < 10; i++) {
    widePlan.push({
      id: `t-${i}`,
      description: `Task ${i}`,
      agent: 'researcher',
      action: 'research',
      params: {},
      dependencies: [],
      priority: i,
    });
  }
  const decomposer = new GoalDecomposer(mockPlanner(widePlan));
  const dag = await decomposer.decompose('Wide test', SAMPLE_AGENTS);

  let maxConcurrent = 0;
  let currentConcurrent = 0;
  const trackingExecutor: ExecutorFunction = async (agentId, payload, context) => {
    currentConcurrent++;
    if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;
    await new Promise((r) => setTimeout(r, 10));
    currentConcurrent--;
    return { success: true, data: { taskId: context.taskId } };
  };

  const runner = new TeamRunner(trackingExecutor);
  const result = await runner.run(dag, { concurrency: 3 });
  assert(result.success === true, 'All 10 tasks completed');
  assert(result.stats.completed === 10, '10/10 completed');
  assert(maxConcurrent <= 3, `Max concurrency was ${maxConcurrent} (limit: 3)`);

  // Task timeout
  const slowExecutor: ExecutorFunction = async () => {
    await new Promise((r) => setTimeout(r, 500));
    return { success: true, data: {} };
  };
  const singlePlan: PlannedTask[] = [
    { id: 'slow', description: 'Slow', agent: 'researcher', action: 'research', params: {}, dependencies: [] },
  ];
  const slowDecomposer = new GoalDecomposer(mockPlanner(singlePlan));
  const slowDag = await slowDecomposer.decompose('Timeout test', SAMPLE_AGENTS);
  const slowRunner = new TeamRunner(slowExecutor);
  const slowResult = await slowRunner.run(slowDag, { taskTimeout: 50 });
  assert(slowResult.success === false, 'Task times out');
  assert(slowResult.stats.failed === 1, 'Timed out task is marked failed');
  const slowNode = slowDag.nodes.find((n) => n.id === 'slow');
  assert(
    slowNode !== undefined && slowNode.error !== undefined && slowNode.error.includes('timed out'),
    'Timeout error message captured',
  );

  // Total timeout
  const manySlowPlan: PlannedTask[] = [
    { id: 's1', description: 'S1', agent: 'researcher', action: 'go', params: {}, dependencies: [] },
    { id: 's2', description: 'S2', agent: 'writer', action: 'go', params: {}, dependencies: ['s1'] },
    { id: 's3', description: 'S3', agent: 'reviewer', action: 'go', params: {}, dependencies: ['s2'] },
  ];
  const delayExecutor: ExecutorFunction = async (_, __, ctx) => {
    await new Promise((r) => setTimeout(r, 100));
    return { success: true, data: { taskId: ctx.taskId } };
  };
  const totalDecomposer = new GoalDecomposer(mockPlanner(manySlowPlan));
  const totalDag = await totalDecomposer.decompose('Total timeout', SAMPLE_AGENTS);
  const totalRunner = new TeamRunner(delayExecutor);
  const totalResult = await totalRunner.run(totalDag, { totalTimeout: 150 });
  // At least one task should complete, but later ones should be skipped due to total timeout
  assert(totalResult.stats.completed >= 1, 'At least 1 task completed before total timeout');
  assert(totalResult.stats.skipped >= 1, 'Later tasks skipped due to total timeout');
}

// ============================================================================
// 10h — EVENTS & CALLBACKS
// ============================================================================

async function test10h() {
  header('10h — Events & Callbacks');

  const decomposer = new GoalDecomposer(mockPlanner(SAMPLE_PLAN));
  const dag = await decomposer.decompose('Event test', SAMPLE_AGENTS);

  const events: string[] = [];
  const runner = new TeamRunner(mockExecutor());

  runner.on('dag:created', () => events.push('dag:created'));
  runner.on('task:start', (node: TaskNode) => events.push(`start:${node.id}`));
  runner.on('task:complete', (node: TaskNode) => events.push(`complete:${node.id}`));
  runner.on('run:complete', () => events.push('run:complete'));

  await runner.run(dag);

  assert(events.includes('dag:created'), 'dag:created event emitted');
  assert(events.includes('start:task-1'), 'task:start emitted for task-1');
  assert(events.includes('complete:task-1'), 'task:complete emitted for task-1');
  assert(events.includes('start:task-2'), 'task:start emitted for task-2');
  assert(events.includes('complete:task-3'), 'task:complete emitted for task-3');
  assert(events.includes('run:complete'), 'run:complete emitted');
  assert(events.indexOf('start:task-1') < events.indexOf('start:task-2'), 'task-1 starts before task-2');
  assert(events.indexOf('complete:task-2') < events.indexOf('start:task-3'), 'task-2 completes before task-3 starts');

  // Failure events
  const failDag = await decomposer.decompose('Fail event test', SAMPLE_AGENTS);
  const failEvents: string[] = [];
  const failRunner = new TeamRunner(failingExecutor(new Set(['task-1'])));
  failRunner.on('task:fail', (node: TaskNode) => failEvents.push(`fail:${node.id}`));
  failRunner.on('task:skip', (node: TaskNode) => failEvents.push(`skip:${node.id}`));
  await failRunner.run(failDag);
  assert(failEvents.includes('fail:task-1'), 'task:fail emitted for task-1');
  assert(failEvents.some((e) => e.startsWith('skip:')), 'task:skip emitted for downstream tasks');
}

// ============================================================================
// 10i — runTeam() ONE-LINER
// ============================================================================

async function test10i() {
  header('10i — runTeam() One-Liner');

  // Basic usage
  const result = await runTeam(
    'Build a REST API',
    SAMPLE_AGENTS,
    { planner: mockPlanner(SAMPLE_PLAN), executor: mockExecutor() },
  );
  assert(result.success === true, 'runTeam succeeds');
  assert(result.stats.total === 3, 'runTeam executed 3 tasks');
  assert(result.dag.goal === 'Build a REST API', 'runTeam stores goal in DAG');

  // With options
  const result2 = await runTeam(
    'With options',
    SAMPLE_AGENTS,
    { planner: mockPlanner(PARALLEL_PLAN), executor: mockExecutor() },
    { concurrency: 1, sessionId: 'test-session', metadata: { env: 'test' } },
  );
  assert(result2.success === true, 'runTeam with options succeeds');

  // Approval callback — approved
  const approvedResult = await runTeam(
    'Approved run',
    SAMPLE_AGENTS,
    { planner: mockPlanner(SAMPLE_PLAN), executor: mockExecutor() },
    { approvalCallback: async () => true },
  );
  assert(approvedResult.success === true, 'runTeam with approval succeeds');

  // Approval callback — rejected
  const rejectedResult = await runTeam(
    'Rejected run',
    SAMPLE_AGENTS,
    { planner: mockPlanner(SAMPLE_PLAN), executor: mockExecutor() },
    { approvalCallback: async () => false },
  );
  assert(rejectedResult.success === false, 'runTeam with rejection fails');
  assert(rejectedResult.stats.skipped === 3, 'All tasks skipped on rejection');
  assert(rejectedResult.summary.includes('not approved'), 'Summary mentions not approved');

  // Planner retries
  const retryResult = await runTeam(
    'Retry plan',
    SAMPLE_AGENTS,
    { planner: failingPlanner(1, SAMPLE_PLAN), executor: mockExecutor() },
    { plannerRetries: 2 },
  );
  assert(retryResult.success === true, 'runTeam retries planner and succeeds');
}

// ============================================================================
// 10j — DEPENDENCY RESULT INJECTION
// ============================================================================

async function test10j() {
  header('10j — Dependency Result Injection');

  const capturedPayloads: Map<string, AgentPayload> = new Map();
  const capturingExecutor: ExecutorFunction = async (agentId, payload, context) => {
    capturedPayloads.set(context.taskId ?? '', payload);
    return { success: true, data: { output: `result-from-${context.taskId}` } };
  };

  const result = await runTeam(
    'Dep injection test',
    SAMPLE_AGENTS,
    { planner: mockPlanner(SAMPLE_PLAN), executor: capturingExecutor },
  );

  assert(result.success === true, 'Execution succeeds');

  // task-1 should have no dependency results
  const t1Payload = capturedPayloads.get('task-1');
  assert(t1Payload !== undefined, 'task-1 payload captured');
  const t1DepResults = (t1Payload?.params as Record<string, unknown>)?._dependencyResults as Record<string, unknown>;
  assert(t1DepResults !== undefined && Object.keys(t1DepResults).length === 0, 'task-1 has empty dependency results');

  // task-2 should have task-1's result
  const t2Payload = capturedPayloads.get('task-2');
  assert(t2Payload !== undefined, 'task-2 payload captured');
  const t2DepResults = (t2Payload?.params as Record<string, unknown>)?._dependencyResults as Record<string, unknown>;
  assert(
    t2DepResults !== undefined && (t2DepResults['task-1'] as Record<string, unknown>)?.output === 'result-from-task-1',
    'task-2 receives task-1 result via _dependencyResults',
  );

  // task-3 should have task-2's result
  const t3Payload = capturedPayloads.get('task-3');
  assert(t3Payload !== undefined, 'task-3 payload captured');
  const t3DepResults = (t3Payload?.params as Record<string, unknown>)?._dependencyResults as Record<string, unknown>;
  assert(
    t3DepResults !== undefined && (t3DepResults['task-2'] as Record<string, unknown>)?.output === 'result-from-task-2',
    'task-3 receives task-2 result via _dependencyResults',
  );
}

// ============================================================================
// 10k — createLLMPlanner
// ============================================================================

async function test10k() {
  header('10k — createLLMPlanner');

  // Mock executor that simulates an LLM returning JSON tasks
  const llmExecutor: ExecutorFunction = async (agentId, payload, context) => {
    // The planner sends the prompt as payload.params.prompt
    const prompt = (payload.params as Record<string, unknown>).prompt as string;
    assert(typeof prompt === 'string' && prompt.length > 0, 'LLM planner sends prompt');
    assert(prompt.includes('GOAL:'), 'Prompt contains GOAL section');
    assert(prompt.includes('AVAILABLE AGENTS:'), 'Prompt contains AVAILABLE AGENTS section');

    return {
      success: true,
      data: JSON.stringify(SAMPLE_PLAN),
    };
  };

  const planner = createLLMPlanner(llmExecutor, 'gpt-4');
  const tasks = await planner('Build an API', SAMPLE_AGENTS);
  assert(tasks.length === 3, 'LLM planner returns 3 tasks');
  assert(tasks[0].id === 'task-1', 'First task from LLM planner is task-1');

  // Test with pre-parsed response
  const parsedExecutor: ExecutorFunction = async () => ({
    success: true,
    data: SAMPLE_PLAN, // Already an array
  });
  const planner2 = createLLMPlanner(parsedExecutor, 'gpt-4');
  const tasks2 = await planner2('Another goal', SAMPLE_AGENTS);
  assert(tasks2.length === 3, 'Handles pre-parsed array response');

  // Test with nested response
  const nestedExecutor: ExecutorFunction = async () => ({
    success: true,
    data: { tasks: SAMPLE_PLAN }, // Wrapped in { tasks: [] }
  });
  const planner3 = createLLMPlanner(nestedExecutor, 'gpt-4');
  const tasks3 = await planner3('Nested goal', SAMPLE_AGENTS);
  assert(tasks3.length === 3, 'Handles { tasks: [] } response shape');

  // Test with text field response
  const textExecutor: ExecutorFunction = async () => ({
    success: true,
    data: { text: JSON.stringify(SAMPLE_PLAN) },
  });
  const planner4 = createLLMPlanner(textExecutor, 'gpt-4');
  const tasks4 = await planner4('Text goal', SAMPLE_AGENTS);
  assert(tasks4.length === 3, 'Handles { text: "json" } response shape');

  // Test with content field response
  const contentExecutor: ExecutorFunction = async () => ({
    success: true,
    data: { content: JSON.stringify(SAMPLE_PLAN) },
  });
  const planner5 = createLLMPlanner(contentExecutor, 'gpt-4');
  const tasks5 = await planner5('Content goal', SAMPLE_AGENTS);
  assert(tasks5.length === 3, 'Handles { content: "json" } response shape');

  // Test with failing LLM
  const failLLM: ExecutorFunction = async () => ({
    success: false,
    error: { code: 'LLM_ERROR', message: 'Rate limited', recoverable: true },
  });
  const planner6 = createLLMPlanner(failLLM, 'gpt-4');
  await assertThrows(
    () => planner6('Fail goal', SAMPLE_AGENTS),
    'LLM planner throws on failure',
    'Planner agent failed',
  );

  // Test with context passed through
  const contextExecutor: ExecutorFunction = async (_agentId, payload) => {
    const meta = payload.params as Record<string, unknown>;
    assert(
      (meta as Record<string, Record<string, unknown>>).agents !== undefined,
      'Agent info passed to LLM',
    );
    return { success: true, data: [SAMPLE_PLAN[0]] };
  };
  const planner7 = createLLMPlanner(contextExecutor, 'gpt-4');
  const tasks7 = await planner7('Context test', SAMPLE_AGENTS, { extra: 'data' });
  assert(tasks7.length === 1, 'Context planner returns tasks');

  // Validation: missing required fields
  const missingFieldsExecutor: ExecutorFunction = async () => ({
    success: true,
    data: [{ notAnId: 'x' }],
  });
  const planner8 = createLLMPlanner(missingFieldsExecutor, 'gpt-4');
  await assertThrows(
    () => planner8('Invalid plan', SAMPLE_AGENTS),
    'Rejects plan with missing fields',
    'missing',
  );
}

// ============================================================================
// 10l — EDGE CASES & INTEGRATION
// ============================================================================

async function test10l() {
  header('10l — Edge Cases & Integration');

  // Single task plan
  const singlePlan: PlannedTask[] = [
    { id: 'only', description: 'The only task', agent: 'researcher', action: 'research', params: { q: 'test' }, dependencies: [] },
  ];
  const singleResult = await runTeam(
    'Single task',
    SAMPLE_AGENTS,
    { planner: mockPlanner(singlePlan), executor: mockExecutor() },
  );
  assert(singleResult.success === true, 'Single task plan succeeds');
  assert(singleResult.stats.total === 1, 'Stats show 1 total');

  // Wide fan-out (all parallel)
  const widePlan: PlannedTask[] = [];
  for (let i = 0; i < 20; i++) {
    widePlan.push({
      id: `w-${i}`, description: `Wide ${i}`, agent: 'researcher', action: 'research',
      params: {}, dependencies: [], priority: Math.floor(i / 5),
    });
  }
  const wideResult = await runTeam(
    'Wide fan-out',
    SAMPLE_AGENTS,
    { planner: mockPlanner(widePlan), executor: mockExecutor() },
    { concurrency: 5 },
  );
  assert(wideResult.success === true, '20-task wide fan-out succeeds');
  assert(wideResult.stats.completed === 20, 'All 20 completed');

  // Deep chain
  const deepPlan: PlannedTask[] = [];
  for (let i = 0; i < 10; i++) {
    deepPlan.push({
      id: `d-${i}`, description: `Deep ${i}`, agent: 'writer', action: 'write',
      params: {}, dependencies: i > 0 ? [`d-${i - 1}`] : [],
    });
  }
  const deepResult = await runTeam(
    'Deep chain',
    SAMPLE_AGENTS,
    { planner: mockPlanner(deepPlan), executor: mockExecutor() },
  );
  assert(deepResult.success === true, '10-deep chain succeeds');
  assert(deepResult.stats.completed === 10, 'All 10 completed');

  // Verify node timestamps are populated
  for (const node of deepResult.dag.nodes) {
    assert(typeof node.startedAt === 'number' && node.startedAt > 0, `Node ${node.id} has startedAt`);
    assert(typeof node.completedAt === 'number' && node.completedAt > 0, `Node ${node.id} has completedAt`);
    assert(node.completedAt! >= node.startedAt!, `Node ${node.id} completedAt >= startedAt`);
  }

  // Priority ordering within a layer
  const prioPlan: PlannedTask[] = [
    { id: 'low', description: 'Low', agent: 'researcher', action: 'research', params: {}, dependencies: [], priority: 1 },
    { id: 'high', description: 'High', agent: 'writer', action: 'write', params: {}, dependencies: [], priority: 10 },
  ];
  const executionOrder: string[] = [];
  const orderExecutor: ExecutorFunction = async (_, __, ctx) => {
    executionOrder.push(ctx.taskId ?? '');
    return { success: true, data: {} };
  };
  await runTeam(
    'Priority test',
    SAMPLE_AGENTS,
    { planner: mockPlanner(prioPlan), executor: orderExecutor },
    { concurrency: 1 }, // Force serial execution within layer to test ordering
  );
  assert(
    executionOrder.indexOf('high') < executionOrder.indexOf('low'),
    'Higher priority tasks execute first within layer',
  );

  // Empty plan (weird but valid)
  const emptyResult = await runTeam(
    'Empty plan',
    SAMPLE_AGENTS,
    { planner: mockPlanner([]), executor: mockExecutor() },
  );
  assert(emptyResult.success === true, 'Empty plan is vacuously successful');
  assert(emptyResult.stats.total === 0, 'Empty plan has 0 tasks');
}

// ============================================================================
// RUN ALL
// ============================================================================

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Phase 10: Goal Decomposer — Test Suite                    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  await test10a();
  await test10b();
  await test10c();
  await test10d();
  await test10e();
  await test10f();
  await test10g();
  await test10h();
  await test10i();
  await test10j();
  await test10k();
  await test10l();

  console.log('\n' + '='.repeat(64));
  const total = passed + failed;
  if (failed === 0) {
    log(`  ALL ${total} TESTS PASSED`, 'green');
  } else {
    log(`  ${passed} passed, ${failed} FAILED out of ${total}`, 'red');
  }
  console.log('='.repeat(64));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
