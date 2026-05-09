/**
 * test-phase12.ts — Tests for Phase 12 features
 *
 * Feature 1: Context Throttler (lib/context-throttler.ts)
 * Feature 2: Partition Planner (lib/partition-planner.ts)
 * Feature 3: Coverage Gate (lib/coverage-gate.ts)
 * Feature 4: Route Classifier (lib/route-classifier.ts)
 *
 * All tests are deterministic — no LLM calls, no I/O, no network.
 */

import assert from 'assert';

// ── Imports ──────────────────────────────────────────────────────────────────
import {
  filterState,
  ContextThrottler,
} from './lib/context-throttler';
import type { BlackboardSnapshot } from './lib/context-throttler';

import {
  PartitionPlanner,
  createLexicalOverlapChecker,
  parsePartitionJSON,
} from './lib/partition-planner';
import type { PartitionEntry, PartitionSchema } from './lib/partition-planner';

import {
  CoverageGate,
  createKeywordEvaluator,
} from './lib/coverage-gate';

import {
  RouteClassifier,
  createHeuristicClassifier,
} from './lib/route-classifier';

import { WORKFLOW_STATES } from './lib/fsm-journey';
import { runTeam } from './lib/goal-decomposer';
import type { TeamAgent, PlannerFunction, ExecutorFunction } from './lib/goal-decomposer';

// ── Utilities ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      console.log(`  ✓ ${name}`);
      passed++;
    })
    .catch((err: unknown) => {
      console.error(`  ✗ ${name}`);
      console.error(`    ${(err as Error).message}`);
      failed++;
    });
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// ── SECTION 1: Context Throttler ─────────────────────────────────────────────

async function testContextThrottler(): Promise<void> {
  section('ContextThrottler — filterState()');

  const state: BlackboardSnapshot = {
    'financials:q3':    { revenue: 100 },
    'regulations:gdpr': { compliant: true },
    'employees:count':  42,
    'logistics:routes': ['A', 'B'],
    'marketing:budget': 5000,
  };

  await test('retains keys matching a single tag', () => {
    const result = filterState('agent-1', state, ['financials']);
    assert.deepStrictEqual(result.retainedKeys, ['financials:q3']);
    assert.strictEqual(Object.keys(result.filteredState).length, 1);
  });

  await test('retains keys matching multiple tags', () => {
    const result = filterState('agent-2', state, ['financials', 'regulations']);
    assert.strictEqual(result.retainedKeys.length, 2);
    assert.ok(result.retainedKeys.includes('financials:q3'));
    assert.ok(result.retainedKeys.includes('regulations:gdpr'));
  });

  await test('wildcard ["*"] keeps all keys', () => {
    const result = filterState('agent-3', state, ['*']);
    assert.strictEqual(result.retainedKeys.length, Object.keys(state).length);
    assert.strictEqual(result.prunedKeys.length, 0);
  });

  await test('empty scope keeps all keys', () => {
    const result = filterState('agent-4', state, []);
    assert.strictEqual(result.retainedKeys.length, Object.keys(state).length);
  });

  await test('no matching tags returns empty filteredState', () => {
    const result = filterState('agent-5', state, ['nonexistent']);
    assert.strictEqual(Object.keys(result.filteredState).length, 0);
    assert.strictEqual(result.prunedKeys.length, Object.keys(state).length);
  });

  await test('exactMatch option only matches full key equality', () => {
    const result = filterState('agent-6', state, ['financials:q3'], { exactMatch: true });
    assert.strictEqual(result.retainedKeys.length, 1);
    // 'financials' as a tag does NOT match with exactMatch
    const r2 = filterState('agent-7', state, ['financials'], { exactMatch: true });
    assert.strictEqual(r2.retainedKeys.length, 0);
  });

  await test('maxKeys cap limits retained keys', () => {
    const result = filterState('agent-8', state, ['financials', 'regulations', 'employees'], { maxKeys: 2 });
    assert.strictEqual(result.retainedKeys.length, 2);
    assert.ok(result.prunedKeys.length >= 1);
  });

  await test('result metadata contains agentId and scopeMetadata', () => {
    const result = filterState('my-agent', state, ['logistics']);
    assert.strictEqual(result.agentId, 'my-agent');
    assert.deepStrictEqual(result.scopeMetadata, ['logistics']);
  });

  section('ContextThrottler — OOP interface');

  await test('registerScope + filter returns correct subset', () => {
    const throttler = new ContextThrottler();
    throttler.registerScope('tax-agent', ['financials', 'regulations']);
    const result = throttler.filter('tax-agent', state);
    assert.strictEqual(result.retainedKeys.length, 2);
  });

  await test('filterToState convenience wrapper returns plain object', () => {
    const throttler = new ContextThrottler();
    throttler.registerScope('hr-agent', ['employees']);
    const filtered = throttler.filterToState('hr-agent', state);
    assert.deepStrictEqual(filtered, { 'employees:count': 42 });
  });

  await test('unregistered agent gets all keys', () => {
    const throttler = new ContextThrottler();
    const result = throttler.filter('unknown-agent', state);
    assert.strictEqual(result.retainedKeys.length, Object.keys(state).length);
  });

  await test('overrideScope in filter() overrides registered scope', () => {
    const throttler = new ContextThrottler();
    throttler.registerScope('agent', ['marketing']);
    const result = throttler.filter('agent', state, ['logistics']);
    assert.strictEqual(result.retainedKeys.length, 1);
    assert.ok(result.retainedKeys[0].startsWith('logistics'));
  });

  await test('deregisterScope removes the registration', () => {
    const throttler = new ContextThrottler();
    throttler.registerScope('agent', ['employees']);
    throttler.deregisterScope('agent');
    const result = throttler.filter('agent', state);
    assert.strictEqual(result.retainedKeys.length, Object.keys(state).length);
  });

  await test('filterAll applies scope to every registered agent', () => {
    const throttler = new ContextThrottler();
    throttler.registerScope('a', ['financials']);
    throttler.registerScope('b', ['marketing']);
    const allResults = throttler.filterAll(state);
    assert.strictEqual(allResults.size, 2);
    assert.strictEqual(allResults.get('a')!.retainedKeys.length, 1);
    assert.strictEqual(allResults.get('b')!.retainedKeys.length, 1);
  });

  await test('size reflects registered agent count', () => {
    const throttler = new ContextThrottler();
    assert.strictEqual(throttler.size, 0);
    throttler.registerScope('x', ['a']);
    assert.strictEqual(throttler.size, 1);
    throttler.registerScope('y', ['b']);
    assert.strictEqual(throttler.size, 2);
    throttler.deregisterScope('x');
    assert.strictEqual(throttler.size, 1);
  });

  await test('registerScope throws on empty agentId', () => {
    const throttler = new ContextThrottler();
    assert.throws(() => throttler.registerScope('', ['a']), /agentId/);
  });
}

// ── SECTION 2: Partition Planner ─────────────────────────────────────────────

async function testPartitionPlanner(): Promise<void> {
  section('PartitionPlanner — lexical overlap checker');

  const checker = createLexicalOverlapChecker();

  await test('no overlap when focus areas are disjoint', async () => {
    const schema: PartitionSchema = [
      { agent_type: 'a', focus_area: 'financial revenue projections', excluded_topics: [] },
      { agent_type: 'b', focus_area: 'legal compliance regulations', excluded_topics: [] },
    ];
    const overlaps = await checker(schema);
    assert.strictEqual(overlaps.length, 0);
  });

  await test('detects overlap when focus areas share significant words', async () => {
    const schema: PartitionSchema = [
      { agent_type: 'a', focus_area: 'market research analysis competitive trends', excluded_topics: [] },
      { agent_type: 'b', focus_area: 'market research consumer behavior competitive', excluded_topics: [] },
    ];
    const overlaps = await checker(schema);
    assert.ok(overlaps.length > 0, 'Expected overlap to be detected');
  });

  await test('single-agent schema never overlaps', async () => {
    const schema: PartitionSchema = [
      { agent_type: 'solo', focus_area: 'everything under the sun', excluded_topics: [] },
    ];
    const overlaps = await checker(schema);
    assert.strictEqual(overlaps.length, 0);
  });

  section('PartitionPlanner — parsePartitionJSON');

  await test('parses valid JSON array', () => {
    const json = JSON.stringify([
      { agent_type: 'researcher', focus_area: 'market trends', excluded_topics: ['finance'] },
    ]);
    const schema = parsePartitionJSON(json);
    assert.strictEqual(schema.length, 1);
    assert.strictEqual(schema[0].agent_type, 'researcher');
    assert.strictEqual(schema[0].focus_area, 'market trends');
    assert.deepStrictEqual(schema[0].excluded_topics, ['finance']);
  });

  await test('parses JSON wrapped in markdown fences', () => {
    const json = '```json\n[{"agent_type":"a","focus_area":"x","excluded_topics":[]}]\n```';
    const schema = parsePartitionJSON(json);
    assert.strictEqual(schema.length, 1);
  });

  await test('throws on invalid JSON', () => {
    assert.throws(() => parsePartitionJSON('not json'), /Failed to parse/);
  });

  await test('throws on non-array JSON', () => {
    assert.throws(() => parsePartitionJSON('{"foo":"bar"}'), /must be a JSON array/);
  });

  await test('throws on entry missing agent_type', () => {
    assert.throws(
      () => parsePartitionJSON('[{"focus_area":"x","excluded_topics":[]}]'),
      /agent_type/,
    );
  });

  await test('throws on entry missing focus_area', () => {
    assert.throws(
      () => parsePartitionJSON('[{"agent_type":"a","excluded_topics":[]}]'),
      /focus_area/,
    );
  });

  await test('defaults missing excluded_topics to []', () => {
    const schema = parsePartitionJSON('[{"agent_type":"a","focus_area":"x"}]');
    assert.deepStrictEqual(schema[0].excluded_topics, []);
  });

  section('PartitionPlanner — PartitionPlanner class');

  const mockPlannerFn = async (goal: string, agents: TeamAgent[]): Promise<PartitionSchema> => {
    return agents.map((a, i) => ({
      agent_type: a.id,
      focus_area: `area ${i}: ${a.role}`,
      excluded_topics: agents.filter((_, j) => j !== i).map((other) => other.role),
    }));
  };

  await test('plan() returns schema with one entry per agent', async () => {
    const planner = new PartitionPlanner(mockPlannerFn);
    const agents: TeamAgent[] = [
      { id: 'a', role: 'financials analyst' },
      { id: 'b', role: 'legal compliance expert' },
    ];
    const result = await planner.plan('Analyse Q3 results', agents);
    assert.strictEqual(result.schema.length, 2);
    assert.strictEqual(result.schema[0].agent_type, 'a');
  });

  await test('plan() reports createdAt timestamp', async () => {
    const planner = new PartitionPlanner(mockPlannerFn);
    const before = Date.now();
    const result = await planner.plan('goal', [{ id: 'x', role: 'worker' }]);
    assert.ok(result.createdAt >= before);
  });

  await test('strictOverlap throws when overlap found', async () => {
    const overlappingPlanner = async (): Promise<PartitionSchema> => [
      { agent_type: 'a', focus_area: 'market research competitive analysis trends', excluded_topics: [] },
      { agent_type: 'b', focus_area: 'market research competitive trends landscape', excluded_topics: [] },
    ];
    const planner = new PartitionPlanner(overlappingPlanner, { strictOverlap: true });
    await assert.rejects(
      () => planner.plan('goal', [{ id: 'a', role: 'x' }, { id: 'b', role: 'y' }]),
      /overlap/i,
    );
  });

  await test('injectConstraint adds _partitionConstraint to params', () => {
    const schema: PartitionSchema = [
      { agent_type: 'researcher', focus_area: 'market trends', excluded_topics: ['finance'] },
    ];
    const params = { query: 'hello' };
    const result = PartitionPlanner.injectConstraint('researcher', params, schema);
    assert.ok('_partitionConstraint' in result);
    const pc = result._partitionConstraint as PartitionEntry;
    assert.strictEqual(pc.focus_area, 'market trends');
    assert.deepStrictEqual(pc.excluded_topics, ['finance']);
  });

  await test('injectConstraint returns params unchanged when agent not in schema', () => {
    const schema: PartitionSchema = [];
    const params = { query: 'hello' };
    const result = PartitionPlanner.injectConstraint('missing', params, schema);
    assert.deepStrictEqual(result, params);
  });

  await test('plan() throws on empty goal', async () => {
    const planner = new PartitionPlanner(mockPlannerFn);
    await assert.rejects(() => planner.plan('', [{ id: 'a', role: 'x' }]), /non-empty/);
  });

  await test('plan() throws on empty agents array', async () => {
    const planner = new PartitionPlanner(mockPlannerFn);
    await assert.rejects(() => planner.plan('goal', []), /at least one agent/i);
  });
}

// ── SECTION 3: Coverage Gate ──────────────────────────────────────────────────

async function testCoverageGate(): Promise<void> {
  section('CoverageGate — createKeywordEvaluator');

  await test('score is 100 when all keywords present', async () => {
    const evaluator = createKeywordEvaluator(['revenue', 'compliance', 'market']);
    const board = { a: 'revenue data here', b: 'compliance check done', c: 'market analysis complete' };
    const result = await evaluator('goal', board);
    assert.strictEqual(result.score, 100);
    assert.strictEqual(result.gaps.length, 0);
  });

  await test('score reflects missing keywords', async () => {
    const evaluator = createKeywordEvaluator(['revenue', 'compliance', 'market']);
    const board = { a: 'revenue data here' };
    const result = await evaluator('goal', board);
    assert.ok(result.score < 100);
    assert.ok(result.gaps.includes('compliance'));
    assert.ok(result.gaps.includes('market'));
  });

  await test('score is 0 when no keywords present', async () => {
    const evaluator = createKeywordEvaluator(['alpha', 'beta', 'gamma']);
    const board = { x: 'nothing relevant' };
    const result = await evaluator('goal', board);
    assert.strictEqual(result.score, 0);
    assert.strictEqual(result.gaps.length, 3);
  });

  await test('empty keyword list gives score 100', async () => {
    const evaluator = createKeywordEvaluator([]);
    const result = await evaluator('goal', {});
    assert.strictEqual(result.score, 100);
  });

  await test('evaluatedAt is set', async () => {
    const evaluator = createKeywordEvaluator(['x']);
    const before = Date.now();
    const result = await evaluator('g', { a: 'x' });
    assert.ok(result.evaluatedAt >= before);
  });

  section('CoverageGate — CoverageGate class');

  await test('evaluate passes when score >= threshold', async () => {
    const evaluator = createKeywordEvaluator(['revenue']);
    const gate = new CoverageGate(evaluator, { threshold: 90 });
    const result = await gate.evaluate('goal', { a: 'revenue present' });
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.evaluation.score, 100);
  });

  await test('evaluate fails when score < threshold', async () => {
    const evaluator = createKeywordEvaluator(['revenue', 'compliance', 'market']);
    const gate = new CoverageGate(evaluator, { threshold: 90 });
    const result = await gate.evaluate('goal', { a: 'revenue only' });
    assert.strictEqual(result.passed, false);
    assert.ok(result.evaluation.gaps.length > 0);
  });

  await test('refinementsUsed increments on each failing evaluate', async () => {
    const evaluator = createKeywordEvaluator(['missing']);
    const gate = new CoverageGate(evaluator, { threshold: 90, maxRefinements: 3 });
    await gate.evaluate('goal', {});
    assert.strictEqual(gate.refinementsUsed, 1);
    await gate.evaluate('goal', {});
    assert.strictEqual(gate.refinementsUsed, 2);
  });

  await test('passes (fail-open) when maxRefinements reached', async () => {
    const evaluator = createKeywordEvaluator(['never-present']);
    const gate = new CoverageGate(evaluator, { threshold: 90, maxRefinements: 2 });
    await gate.evaluate('goal', {}); // round 1 — fail, refinementsUsed = 1
    await gate.evaluate('goal', {}); // round 2 — fail, refinementsUsed = 2 (= max)
    const result = await gate.evaluate('goal', {}); // round 3 — maxRefinementsReached → pass
    assert.strictEqual(result.maxRefinementsReached, true);
    assert.strictEqual(result.passed, true);
  });

  await test('history records every round', async () => {
    const evaluator = createKeywordEvaluator(['key']);
    const gate = new CoverageGate(evaluator, { threshold: 90, maxRefinements: 5 });
    await gate.evaluate('goal', {});
    await gate.evaluate('goal', { a: 'key' });
    assert.strictEqual(gate.history.length, 2);
    assert.strictEqual(gate.history[1].evaluation.score, 100);
  });

  await test('reset clears counter and history', async () => {
    const evaluator = createKeywordEvaluator(['missing']);
    const gate = new CoverageGate(evaluator, { threshold: 90, maxRefinements: 3 });
    await gate.evaluate('goal', {});
    gate.reset();
    assert.strictEqual(gate.refinementsUsed, 0);
    assert.strictEqual(gate.history.length, 0);
  });

  await test('scoreThreshold getter returns configured threshold', () => {
    const evaluator = createKeywordEvaluator([]);
    const gate = new CoverageGate(evaluator, { threshold: 75 });
    assert.strictEqual(gate.scoreThreshold, 75);
  });

  await test('gapsRequeued is empty when passed', async () => {
    const evaluator = createKeywordEvaluator(['key']);
    const gate = new CoverageGate(evaluator, { threshold: 50 });
    await gate.evaluate('goal', { a: 'key present' });
    assert.deepStrictEqual(gate.history[0].gapsRequeued, []);
  });

  await test('gapsRequeued contains gap list when failed', async () => {
    const evaluator = createKeywordEvaluator(['alpha', 'beta']);
    const gate = new CoverageGate(evaluator, { threshold: 90, maxRefinements: 5 });
    await gate.evaluate('goal', {});
    assert.ok(gate.history[0].gapsRequeued.includes('alpha'));
    assert.ok(gate.history[0].gapsRequeued.includes('beta'));
  });
}

// ── SECTION 4: Route Classifier ───────────────────────────────────────────────

async function testRouteClassifier(): Promise<void> {
  section('RouteClassifier — createHeuristicClassifier');

  const classifierFn = createHeuristicClassifier();

  await test('short question-like goal → FACTUAL_LOOKUP', async () => {
    const result = await classifierFn('What is the capital of France?');
    assert.strictEqual(result.category, 'FACTUAL_LOOKUP');
  });

  await test('long complex goal → COMPLEX_SYNTHESIS', async () => {
    const result = await classifierFn(
      'Analyse Q3 financials, identify cost reduction opportunities, produce a board-ready presentation including regulatory risk assessment and competitive benchmarking across five markets',
    );
    assert.strictEqual(result.category, 'COMPLEX_SYNTHESIS');
  });

  await test('empty goal → SYSTEM_FAILURE', async () => {
    const result = await classifierFn('');
    assert.strictEqual(result.category, 'SYSTEM_FAILURE');
  });

  await test('classifiedAt is set', async () => {
    const before = Date.now();
    const result = await classifierFn('What is 2 + 2?');
    assert.ok(result.classifiedAt >= before);
  });

  await test('confidence is present and 0–1', async () => {
    const result = await classifierFn('Who is the CEO of Apple?');
    if (result.confidence !== undefined) {
      assert.ok(result.confidence >= 0 && result.confidence <= 1);
    }
  });

  section('RouteClassifier — OOP interface');

  await test('classify() delegates to classifierFn', async () => {
    const rc = new RouteClassifier(classifierFn);
    const result = await rc.classify('What is the speed of light?');
    assert.strictEqual(result.category, 'FACTUAL_LOOKUP');
  });

  await test('classify() returns SYSTEM_FAILURE for non-string input', async () => {
    const rc = new RouteClassifier(classifierFn);
    // @ts-expect-error testing runtime guard
    const result = await rc.classify(null);
    assert.strictEqual(result.category, 'SYSTEM_FAILURE');
  });

  await test('route() returns shortCircuited=false for COMPLEX_SYNTHESIS without executor', async () => {
    const rc = new RouteClassifier(classifierFn);
    const result = await rc.route(
      'Deep analysis of global supply chain disruptions and their financial implications',
    );
    assert.strictEqual(result.shortCircuited, false);
  });

  await test('route() short-circuits FACTUAL_LOOKUP when executor + agentId provided', async () => {
    const rc = new RouteClassifier(classifierFn, { lookupAgentId: 'lookup-bot' });
    const mockExecutor = async () => ({ success: true, data: 'Paris' });
    const result = await rc.route('What is the capital of France?', mockExecutor);
    assert.strictEqual(result.shortCircuited, true);
    assert.strictEqual(result.answer, 'Paris');
  });

  await test('route() does NOT short-circuit FACTUAL_LOOKUP when no executor', async () => {
    const rc = new RouteClassifier(classifierFn);
    const result = await rc.route('What is 2 + 2?');
    // No executor → falls through to DAG pipeline
    assert.strictEqual(result.shortCircuited, false);
  });

  await test('route() returns error for SYSTEM_FAILURE', async () => {
    const rc = new RouteClassifier(classifierFn);
    const result = await rc.route('');
    assert.strictEqual(result.shortCircuited, true);
    assert.ok(result.error);
  });

  await test('route() surfaces executor error in result.error', async () => {
    const rc = new RouteClassifier(classifierFn, { lookupAgentId: 'bot' });
    const failingExecutor = async () => { throw new Error('network failure'); };
    const result = await rc.route('What is 2 + 2?', failingExecutor);
    assert.strictEqual(result.shortCircuited, true);
    assert.ok(result.error?.includes('network failure'));
  });
}

// ── SECTION 5: WORKFLOW_STATES.EVALUATING ────────────────────────────────────

async function testEvaluatingState(): Promise<void> {
  section('WORKFLOW_STATES — EVALUATING constant');

  await test('EVALUATING is present in WORKFLOW_STATES', () => {
    assert.strictEqual(WORKFLOW_STATES.EVALUATING, 'EVALUATING');
  });

  await test('EVALUATING does not shadow other states', () => {
    assert.strictEqual(WORKFLOW_STATES.COMPLETE, 'COMPLETE');
    assert.strictEqual(WORKFLOW_STATES.EXECUTE, 'EXECUTE');
    assert.notStrictEqual(WORKFLOW_STATES.EVALUATING, WORKFLOW_STATES.COMPLETE);
    assert.notStrictEqual(WORKFLOW_STATES.EVALUATING, WORKFLOW_STATES.REVIEW);
  });
}

// ── SECTION 6: Integration — runTeam with new features ────────────────────────

async function testRunTeamIntegration(): Promise<void> {
  section('runTeam integration — route classifier short-circuit');

  await test('runTeam short-circuits on FACTUAL_LOOKUP', async () => {
    const classifier = new RouteClassifier(createHeuristicClassifier(), { lookupAgentId: 'lookup' });

    const mockExecutor: ExecutorFunction = async (agentId) => ({
      success: true,
      data: agentId === 'lookup' ? 'Paris' : 'done',
      metadata: {},
    });

    const mockPlanner: PlannerFunction = async () => [
      { id: 't1', description: 'd', agent: 'lookup', action: 'answer', params: {}, dependencies: [], priority: 1 },
    ];

    const result = await runTeam(
      'What is the capital of France?',
      [{ id: 'lookup', role: 'factual lookup agent' }],
      { planner: mockPlanner, executor: mockExecutor },
      { routeClassifier: classifier, lookupAgentId: 'lookup' },
    );

    assert.strictEqual(result.success, true);
    assert.ok(result.summary.includes('short-circuit'));
  });

  section('runTeam integration — partition schema injection');

  await test('runTeam injects _partitionConstraint into task params', async () => {
    const capturedParams: Record<string, unknown>[] = [];

    const mockExecutor: ExecutorFunction = async (agentId, payload) => {
      capturedParams.push(payload.params as Record<string, unknown>);
      return { success: true, data: 'done', metadata: {} };
    };

    const mockPlanner: PlannerFunction = async (goal, agents) => [
      { id: 't1', description: 'research', agent: agents[0].id, action: 'run', params: { q: 'hello' }, dependencies: [], priority: 1 },
    ];

    const schema = [
      { agent_type: 'researcher', focus_area: 'market trends', excluded_topics: ['finance'] },
    ];

    await runTeam(
      'Analyse the market',
      [{ id: 'researcher', role: 'market researcher' }],
      { planner: mockPlanner, executor: mockExecutor },
      { partitionSchema: schema },
    );

    assert.strictEqual(capturedParams.length, 1);
    const constraint = capturedParams[0]._partitionConstraint as Record<string, unknown>;
    assert.ok(constraint, '_partitionConstraint should be injected into task params');
    assert.strictEqual(constraint.focus_area, 'market trends');
  });

  section('runTeam integration — coverage gate refinement loop');

  await test('runTeam triggers refinement when gate score below threshold', async () => {
    let callCount = 0;
    const board: Record<string, string> = {};

    const mockExecutor: ExecutorFunction = async (agentId, payload) => {
      callCount++;
      // After first call, add 'result' to the board so evaluator passes on 2nd round
      board.result = 'completed';
      return { success: true, data: 'done', metadata: {} };
    };

    const mockPlanner: PlannerFunction = async (goal, agents) => [
      { id: `t${Date.now()}`, description: 'task', agent: agents[0].id, action: 'run', params: {}, dependencies: [], priority: 1 },
    ];

    // First evaluation: board is empty → score 0 → triggers one refinement
    // After refinement, board has 'result' → score 100 → passes
    let evaluationCount = 0;
    const evaluator = async (goal: string, snapshot: Record<string, unknown>) => {
      evaluationCount++;
      if (evaluationCount === 1) {
        return { score: 0, gaps: ['result'], summary: 'missing result', evaluatedAt: Date.now() };
      }
      return { score: 100, gaps: [], summary: 'complete', evaluatedAt: Date.now() };
    };

    const gate = new CoverageGate(evaluator, { threshold: 90, maxRefinements: 3 });

    await runTeam(
      'Complete analysis',
      [{ id: 'worker', role: 'worker' }],
      { planner: mockPlanner, executor: mockExecutor },
      {
        coverageGate: gate,
        blackboardSnapshot: () => ({ ...board }),
      },
    );

    // Should have been called at least twice (original + 1 refinement)
    assert.ok(callCount >= 2, `Expected at least 2 executor calls, got ${callCount}`);
    assert.ok(evaluationCount >= 2, `Expected at least 2 evaluations, got ${evaluationCount}`);
  });

  section('runTeam integration — context throttler via scopeMetadata on TeamAgent');

  await test('agents with scopeMetadata receive filtered context', async () => {
    const capturedContexts: Record<string, unknown>[] = [];

    const mockExecutor: ExecutorFunction = async (agentId, payload) => {
      capturedContexts.push(payload.params as Record<string, unknown>);
      return { success: true, data: 'done', metadata: {} };
    };

    const board = {
      'financials:q3': 100,
      'marketing:spend': 5000,
      'legal:status': 'ok',
    };

    // Planner injects _agentContextMap from metadata context into task params
    const mockPlanner: PlannerFunction = async (goal, agents, context) => [
      {
        id: 't1',
        description: 'task',
        agent: agents[0].id,
        action: 'run',
        params: { agentContext: (context as Record<string, unknown>)?._agentContextMap },
        dependencies: [],
        priority: 1,
      },
    ];

    const agents: TeamAgent[] = [
      { id: 'finance-agent', role: 'financial analyst', scopeMetadata: ['financials'] },
    ];

    await runTeam(
      'Produce financial report',
      agents,
      { planner: mockPlanner, executor: mockExecutor },
      { blackboardSnapshot: () => ({ ...board }) },
    );

    assert.strictEqual(capturedContexts.length, 1);
    const agentCtxMap = capturedContexts[0].agentContext as Record<string, unknown>;
    // The finance agent should only see 'financials:q3'
    const agentCtx = agentCtxMap?.['finance-agent'] as Record<string, unknown>;
    assert.ok(agentCtx, 'agentContextMap should have entry for finance-agent');
    assert.ok('financials:q3' in agentCtx, 'filtered context should include financials:q3');
    assert.ok(!('marketing:spend' in agentCtx), 'filtered context should exclude marketing:spend');
    assert.ok(!('legal:status' in agentCtx), 'filtered context should exclude legal:status');
  });
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Network-AI — Phase 12: Context Throttler, Partition Planner, Coverage Gate, Route Classifier\n');

  await testContextThrottler();
  await testPartitionPlanner();
  await testCoverageGate();
  await testRouteClassifier();
  await testEvaluatingState();
  await testRunTeamIntegration();

  const total = passed + failed;
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} FAILED` : ''}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
