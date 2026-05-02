/**
 * Phase 8: Claude-Code Inspired Enhancements — Test Suite
 *
 * Tests for:
 *   8a — Multi-phase pipeline with approval gates
 *   8b — Confidence-based multi-agent filtering
 *   8c — Matcher-based hook filtering
 *   8d — Fan-out / fan-in parallel aggregation
 *
 * Run with: npx ts-node test-phase8.ts
 */

import { AdapterRegistry } from './adapters/adapter-registry';
import { BaseAdapter } from './adapters/base-adapter';
import { AdapterHookManager, matchGlob, matchToolPattern } from './lib/adapter-hooks';
import type { HookContext, ExecutionHook, HookMatcher } from './lib/adapter-hooks';
import { PhasePipeline } from './lib/phase-pipeline';
import type { PhaseDefinition, PhaseResult, PipelineResult, PipelineExecutionContext } from './lib/phase-pipeline';
import { ConfidenceFilter } from './lib/confidence-filter';
import type { Finding, FilterResult, AggregationStrategy } from './lib/confidence-filter';
import { FanOutFanIn } from './lib/fan-out';
import type { FanOutStep, TaggedResult, FanInResult, FanInStrategy } from './lib/fan-out';
import type { AgentPayload, AgentContext, AgentResult } from './types/agent-adapter';

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

// ============================================================================
// MOCK ADAPTERS
// ============================================================================

class MockAdapter extends BaseAdapter {
  readonly name: string;
  readonly version = '1.0.0';
  callCount = 0;
  lastPayload?: AgentPayload;
  customResult?: AgentResult;

  constructor(name = 'mock') { super(); this.name = name; }

  async executeAgent(agentId: string, payload: AgentPayload, _context: AgentContext): Promise<AgentResult> {
    this.callCount++;
    this.lastPayload = payload;
    if (this.customResult) return this.customResult;
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

/** Helper: create a registry with a mock adapter registered for all agents */
async function makeRegistry(adapterName = 'mock'): Promise<{ registry: AdapterRegistry; adapter: MockAdapter }> {
  const registry = new AdapterRegistry();
  const adapter = new MockAdapter(adapterName);
  await registry.addAdapter(adapter);
  registry.setDefaultAdapter(adapterName);
  return { registry, adapter };
}

const baseCtx: AgentContext = { agentId: 'orchestrator' };

// ============================================================================
// 8a — MULTI-PHASE PIPELINE WITH APPROVAL GATES
// ============================================================================

async function testPhasePipeline() {
  header('Phase 8a — Multi-Phase Pipeline with Approval Gates');

  // 1. Constructor validates non-empty phases
  {
    const { registry } = await makeRegistry();
    assertThrows(() => new PhasePipeline(registry, baseCtx, { phases: [] }), 'Rejects empty phases');
  }

  // 2. Constructor validates duplicate phase names
  {
    const { registry } = await makeRegistry();
    assertThrows(
      () => new PhasePipeline(registry, baseCtx, {
        phases: [
          { name: 'a', agents: ['x'] },
          { name: 'a', agents: ['y'] },
        ],
      }),
      'Rejects duplicate phase names',
    );
  }

  // 3. Simple two-phase pipeline succeeds
  {
    const { registry } = await makeRegistry();
    const pipeline = new PhasePipeline(registry, baseCtx, {
      phases: [
        { name: 'research', agents: ['researcher'] },
        { name: 'publish', agents: ['publisher'] },
      ],
    });
    const result = await pipeline.run();
    assert(result.success, 'Two-phase pipeline succeeds');
    assert(result.phases.length === 2, 'Reports two phase results');
  }

  // 4. Phase status reflects completion
  {
    const { registry } = await makeRegistry();
    const pipeline = new PhasePipeline(registry, baseCtx, {
      phases: [{ name: 'work', agents: ['worker'] }],
    });
    const result = await pipeline.run();
    assert(result.phases[0].status === 'completed', 'Phase status is completed');
  }

  // 5. Parallel agents in a phase
  {
    const { registry } = await makeRegistry();
    const pipeline = new PhasePipeline(registry, baseCtx, {
      phases: [{ name: 'scan', agents: ['a', 'b', 'c'], parallel: true }],
    });
    const result = await pipeline.run();
    assert(result.success, 'Parallel phase succeeds');
    assert(result.phases[0].agentResults.size === 3, 'All 3 parallel agents ran');
  }

  // 6. Sequential agents stop on first failure
  {
    const registry = new AdapterRegistry();
    await registry.addAdapter(new MockAdapter('mock'));
    await registry.addAdapter(new FailingAdapter());
    registry.addRoute({ pattern: 'fail:*', adapterName: 'failing' });
    registry.setDefaultAdapter('mock');
    const pipeline = new PhasePipeline(registry, baseCtx, {
      phases: [{ name: 'work', agents: ['fail:one', 'agent-b'] }],
    });
    const result = await pipeline.run();
    assert(!result.success, 'Pipeline fails on agent failure');
    assert(result.stoppedAt === 'work', 'Reports stopped at phase');
  }

  // 7. Approval gate — approved
  {
    const { registry } = await makeRegistry();
    const approvals: string[] = [];
    const pipeline = new PhasePipeline(registry, baseCtx, {
      phases: [
        { name: 'draft', agents: ['writer'] },
        { name: 'review', agents: ['reviewer'], requiresApproval: true },
        { name: 'publish', agents: ['publisher'] },
      ],
      onApproval: async (name) => {
        approvals.push(name);
        return { approved: true, approvedBy: 'admin' };
      },
    });
    const result = await pipeline.run();
    assert(result.success, 'Pipeline with approved gate succeeds');
    assert(approvals.includes('review'), 'Approval callback was called for review phase');
    assert(result.phases[1].status === 'approved', 'Review phase status is approved');
    assert(result.phases[1].approval?.approvedBy === 'admin', 'Approval records approver');
  }

  // 8. Approval gate — rejected
  {
    const { registry } = await makeRegistry();
    const pipeline = new PhasePipeline(registry, baseCtx, {
      phases: [
        { name: 'draft', agents: ['writer'] },
        { name: 'review', agents: ['reviewer'], requiresApproval: true },
        { name: 'publish', agents: ['publisher'] },
      ],
      onApproval: async () => ({ approved: false, reason: 'Not ready' }),
    });
    const result = await pipeline.run();
    assert(!result.success, 'Pipeline fails on rejection');
    assert(result.stoppedAt === 'review', 'Stopped at review gate');
    assert(result.stopReason === 'Not ready', 'Reports rejection reason');
    assert(result.phases.length === 2, 'Only draft and review phases recorded');
  }

  // 9. autoApprove skips approval callback
  {
    const { registry } = await makeRegistry();
    let callbackCalled = false;
    const pipeline = new PhasePipeline(registry, baseCtx, {
      phases: [
        { name: 'work', agents: ['worker'], requiresApproval: true },
        { name: 'done', agents: ['finisher'] },
      ],
      autoApprove: true,
      onApproval: async () => { callbackCalled = true; return { approved: false }; },
    });
    const result = await pipeline.run();
    assert(result.success, 'autoApprove bypasses gate');
    assert(!callbackCalled, 'onApproval callback not called when autoApprove=true');
  }

  // 10. No approval callback rejects by default
  {
    const { registry } = await makeRegistry();
    const pipeline = new PhasePipeline(registry, baseCtx, {
      phases: [{ name: 'gated', agents: ['worker'], requiresApproval: true }],
    });
    const result = await pipeline.run();
    assert(!result.success, 'No approval callback → rejection');
  }

  // 11. onPhaseStart and onPhaseComplete callbacks
  {
    const { registry } = await makeRegistry();
    const starts: string[] = [];
    const completes: string[] = [];
    const pipeline = new PhasePipeline(registry, baseCtx, {
      phases: [
        { name: 'a', agents: ['agent-a'] },
        { name: 'b', agents: ['agent-b'] },
      ],
      onPhaseStart: (name) => starts.push(name),
      onPhaseComplete: (result) => completes.push(result.phaseName),
    });
    await pipeline.run();
    assert(starts.join(',') === 'a,b', 'onPhaseStart fires in order');
    assert(completes.join(',') === 'a,b', 'onPhaseComplete fires in order');
  }

  // 12. payloadFactory provides custom payloads
  {
    const { registry, adapter } = await makeRegistry();
    const pipeline = new PhasePipeline(registry, baseCtx, {
      phases: [{
        name: 'custom',
        agents: ['worker'],
        payloadFactory: (agentId, prev) => ({
          action: 'custom-action',
          params: { agent: agentId, prevCount: prev.length },
        }),
      }],
    });
    await pipeline.run();
    assert(adapter.lastPayload?.action === 'custom-action', 'payloadFactory sets payload');
  }

  // 13. Pipeline status lifecycle
  {
    const { registry } = await makeRegistry();
    const pipeline = new PhasePipeline(registry, baseCtx, {
      phases: [{ name: 'work', agents: ['worker'] }],
    });
    assert(pipeline.status === 'idle', 'Initial status is idle');
    await pipeline.run();
    assert(pipeline.status === 'completed', 'Final status is completed');
  }

  // 14. Reset clears state
  {
    const { registry } = await makeRegistry();
    const pipeline = new PhasePipeline(registry, baseCtx, {
      phases: [{ name: 'work', agents: ['worker'] }],
    });
    await pipeline.run();
    pipeline.reset();
    assert(pipeline.status === 'idle', 'Reset restores idle status');
    assert(pipeline.results.length === 0, 'Reset clears results');
  }

  // 15. phases property returns definitions
  {
    const { registry } = await makeRegistry();
    const pipeline = new PhasePipeline(registry, baseCtx, {
      phases: [{ name: 'a', agents: ['x'] }, { name: 'b', agents: ['y'] }],
    });
    assert(pipeline.phases.length === 2, 'phases getter returns definitions');
    assert(pipeline.phases[0].name === 'a', 'phases[0].name matches');
  }

  // 16. totalMs is tracked
  {
    const { registry } = await makeRegistry();
    const pipeline = new PhasePipeline(registry, baseCtx, {
      phases: [{ name: 'a', agents: ['x'] }],
    });
    const result = await pipeline.run();
    assert(result.totalMs >= 0, 'totalMs is non-negative');
  }

  // 17. Phase durationMs is tracked
  {
    const { registry } = await makeRegistry();
    const pipeline = new PhasePipeline(registry, baseCtx, {
      phases: [{ name: 'a', agents: ['x'] }],
    });
    const result = await pipeline.run();
    assert(result.phases[0].durationMs >= 0, 'Phase durationMs is non-negative');
  }

  // 18. Approval context has pipeline info
  {
    const { registry } = await makeRegistry();
    let capturedCtx: PipelineExecutionContext | undefined;
    const pipeline = new PhasePipeline(registry, baseCtx, {
      phases: [
        { name: 'a', agents: ['x'] },
        { name: 'b', agents: ['y'], requiresApproval: true },
      ],
      onApproval: async (_name, _result, ctx) => {
        capturedCtx = ctx;
        return { approved: true };
      },
    });
    await pipeline.run();
    assert(capturedCtx?.currentPhaseIndex === 1, 'Approval context has correct phase index');
    assert(capturedCtx?.totalPhases === 2, 'Approval context has total phases');
    assert(capturedCtx?.completedPhases.length === 1, 'Approval context has completed phases');
  }

  // 19. Multiple approval gates in sequence
  {
    const { registry } = await makeRegistry();
    const gates: string[] = [];
    const pipeline = new PhasePipeline(registry, baseCtx, {
      phases: [
        { name: 'a', agents: ['x'], requiresApproval: true },
        { name: 'b', agents: ['y'], requiresApproval: true },
        { name: 'c', agents: ['z'] },
      ],
      onApproval: async (name) => { gates.push(name); return { approved: true }; },
    });
    const result = await pipeline.run();
    assert(result.success, 'Multiple gates all approved');
    assert(gates.length === 2, 'Both gates triggered');
  }

  // 20. Default payload used when no payloadFactory
  {
    const { registry, adapter } = await makeRegistry();
    const pipeline = new PhasePipeline(registry, baseCtx, {
      phases: [{ name: 'run', agents: ['x'] }],
    });
    await pipeline.run({ action: 'go', params: { x: 1 } });
    assert(adapter.lastPayload?.action === 'go', 'Uses default payload from run()');
  }

  // 21. Rejected pipeline has status rejected
  {
    const { registry } = await makeRegistry();
    const pipeline = new PhasePipeline(registry, baseCtx, {
      phases: [{ name: 'gated', agents: ['x'], requiresApproval: true }],
      onApproval: async () => ({ approved: false }),
    });
    await pipeline.run();
    assert(pipeline.status === 'rejected', 'Pipeline status is rejected');
  }

  // 22. Failed pipeline has status failed
  {
    const registry = new AdapterRegistry();
    await registry.addAdapter(new FailingAdapter());
    registry.setDefaultAdapter('failing');
    const pipeline = new PhasePipeline(registry, baseCtx, {
      phases: [{ name: 'work', agents: ['x'] }],
    });
    await pipeline.run();
    assert(pipeline.status === 'failed', 'Pipeline status is failed');
  }

  // 23. phase description is optional
  {
    const { registry } = await makeRegistry();
    const pipeline = new PhasePipeline(registry, baseCtx, {
      phases: [{ name: 'test', agents: ['x'], description: 'A test phase' }],
    });
    assert(pipeline.phases[0].description === 'A test phase', 'Phase description preserved');
  }
}

// ============================================================================
// 8b — CONFIDENCE-BASED MULTI-AGENT FILTERING
// ============================================================================

async function testConfidenceFilter() {
  header('Phase 8b — Confidence-Based Multi-Agent Filtering');

  const makeFinding = (id: string, confidence: number, source = 'agent-a'): Finding => ({
    id,
    description: `Finding ${id}`,
    confidence,
    sourceAgent: source,
  });

  // 1. score() normalises to 0–100
  {
    const filter = new ConfidenceFilter(null, null);
    assert(filter.score(makeFinding('1', 150)) === 100, 'score() caps at 100');
    assert(filter.score(makeFinding('2', -10)) === 0, 'score() floors at 0');
    assert(filter.score(makeFinding('3', 75)) === 75, 'score() passes through in-range');
  }

  // 2. filter() with default threshold (70)
  {
    const filter = new ConfidenceFilter(null, null);
    const findings = [makeFinding('a', 80), makeFinding('b', 50), makeFinding('c', 70)];
    const result = filter.filter(findings);
    assert(result.accepted.length === 2, 'Default threshold accepts 80 and 70');
    assert(result.rejected.length === 1, 'Default threshold rejects 50');
    assert(result.threshold === 70, 'Reports default threshold');
  }

  // 3. filter() with custom threshold
  {
    const filter = new ConfidenceFilter(null, null, { defaultThreshold: 90 });
    const findings = [makeFinding('a', 95), makeFinding('b', 85)];
    const result = filter.filter(findings);
    assert(result.accepted.length === 1, 'Custom threshold=90 accepts 95');
    assert(result.rejected.length === 1, 'Custom threshold=90 rejects 85');
  }

  // 4. filter() with override threshold
  {
    const filter = new ConfidenceFilter(null, null, { defaultThreshold: 90 });
    const findings = [makeFinding('a', 60)];
    const result = filter.filter(findings, 50);
    assert(result.accepted.length === 1, 'Override threshold=50 accepts 60');
  }

  // 5. filter() with empty input
  {
    const filter = new ConfidenceFilter(null, null);
    const result = filter.filter([]);
    assert(result.accepted.length === 0, 'Empty input → empty accepted');
    assert(result.rejected.length === 0, 'Empty input → empty rejected');
  }

  // 6. validate() requires registry
  {
    const filter = new ConfidenceFilter(null, null);
    let threw = false;
    try { await filter.validate(makeFinding('1', 50), 'validator'); } catch { threw = true; }
    assert(threw, 'validate() throws without registry');
  }

  // 7. validate() requires validator agent
  {
    const { registry } = await makeRegistry();
    const filter = new ConfidenceFilter(registry, baseCtx);
    let threw = false;
    try { await filter.validate(makeFinding('1', 50)); } catch { threw = true; }
    assert(threw, 'validate() throws without validator agent');
  }

  // 8. validate() boosts confidence on success
  {
    const { registry } = await makeRegistry();
    const filter = new ConfidenceFilter(registry, baseCtx);
    const result = await filter.validate(makeFinding('1', 50), 'validator');
    assert(result.validated === true, 'Validated flag is true');
    assert(result.validatedBy === 'validator', 'validatedBy is set');
    assert(result.confidence === 70, 'Confidence boosted by 20 on success');
  }

  // 9. validate() reduces confidence on failure
  {
    const registry = new AdapterRegistry();
    await registry.addAdapter(new FailingAdapter());
    registry.setDefaultAdapter('failing');
    const filter = new ConfidenceFilter(registry, baseCtx);
    const result = await filter.validate(makeFinding('1', 50), 'failing-agent');
    assert(result.validated === false, 'Validated flag is false');
    assert(result.confidence === 40, 'Confidence reduced by 10 on failure');
  }

  // 10. validate() caps at 100
  {
    const { registry } = await makeRegistry();
    const filter = new ConfidenceFilter(registry, baseCtx);
    const result = await filter.validate(makeFinding('1', 95), 'validator');
    assert(result.confidence === 100, 'Confidence capped at 100');
  }

  // 11. validate() floors at 0
  {
    const registry = new AdapterRegistry();
    await registry.addAdapter(new FailingAdapter());
    registry.setDefaultAdapter('failing');
    const filter = new ConfidenceFilter(registry, baseCtx);
    const result = await filter.validate(makeFinding('1', 5), 'x');
    assert(result.confidence === 0, 'Confidence floors at 0');
  }

  // 12. validateRejected() re-filters after validation
  {
    const { registry } = await makeRegistry();
    const filter = new ConfidenceFilter(registry, baseCtx, { defaultThreshold: 70 });
    const findings = [makeFinding('a', 80), makeFinding('b', 55)];
    const initial = filter.filter(findings);
    assert(initial.rejected.length === 1, 'Initially one rejected');
    const refiltered = await filter.validateRejected(initial, 'validator');
    // b was 55, boosted by 20 → 75, which passes threshold 70
    assert(refiltered.accepted.length === 2, 'After validation, b is now accepted');
    assert(refiltered.rejected.length === 0, 'No more rejected');
  }

  // 13. aggregate() — highest strategy
  {
    const filter = new ConfidenceFilter(null, null);
    const sets = [
      [makeFinding('x', 80, 'a'), makeFinding('y', 60, 'a')],
      [makeFinding('x', 90, 'b'), makeFinding('y', 50, 'b')],
    ];
    const agg = filter.aggregate(sets, 'highest');
    assert(agg.findings.length === 2, 'highest: 2 findings');
    const xFinding = agg.findings.find(f => f.id === 'x')!;
    assert(xFinding.confidence === 90, 'highest: takes highest confidence');
  }

  // 14. aggregate() — average strategy
  {
    const filter = new ConfidenceFilter(null, null);
    const sets = [
      [makeFinding('x', 80, 'a')],
      [makeFinding('x', 60, 'b')],
    ];
    const agg = filter.aggregate(sets, 'average');
    assert(agg.findings[0].confidence === 70, 'average: (80+60)/2 = 70');
  }

  // 15. aggregate() — unanimous strategy (all sources must have finding)
  {
    const filter = new ConfidenceFilter(null, null);
    const sets = [
      [makeFinding('x', 80, 'a'), makeFinding('y', 90, 'a')],
      [makeFinding('x', 70, 'b')],  // no y
    ];
    const agg = filter.aggregate(sets, 'unanimous');
    assert(agg.findings.length === 1, 'unanimous: only x (both sources)');
    assert(agg.findings[0].id === 'x', 'unanimous: x is the unanimous finding');
  }

  // 16. aggregate() — majority strategy
  {
    const filter = new ConfidenceFilter(null, null);
    const sets = [
      [makeFinding('x', 80, 'a'), makeFinding('y', 90, 'a')],
      [makeFinding('x', 70, 'b'), makeFinding('y', 60, 'b')],
      [makeFinding('x', 75, 'c')],  // no y in third
    ];
    const agg = filter.aggregate(sets, 'majority');
    // majority = floor(3/2)+1 = 2. x appears 3 times, y appears 2 times
    assert(agg.findings.length === 2, 'majority: both x and y have >= 2 sources');
  }

  // 17. aggregate() — empty input
  {
    const filter = new ConfidenceFilter(null, null);
    const agg = filter.aggregate([], 'highest');
    assert(agg.findings.length === 0, 'Empty aggregate → empty findings');
    assert(agg.sourceCount === 0, 'Empty aggregate → sourceCount 0');
  }

  // 18. aggregate() reports metadata
  {
    const filter = new ConfidenceFilter(null, null);
    const sets = [
      [makeFinding('a', 80, 'x')],
      [makeFinding('b', 60, 'y')],
    ];
    const agg = filter.aggregate(sets, 'highest');
    assert(agg.totalInput === 2, 'totalInput counts all input findings');
    assert(agg.sourceCount === 2, 'sourceCount matches input array length');
    assert(agg.strategy === 'highest', 'Reports strategy used');
  }

  // 19. validationPayloadFactory is used
  {
    const { registry, adapter } = await makeRegistry();
    const filter = new ConfidenceFilter(registry, baseCtx, {
      validationPayloadFactory: (f) => ({ action: 'check', params: { fid: f.id } }),
    });
    await filter.validate(makeFinding('custom', 50), 'validator');
    assert(adapter.lastPayload?.action === 'check', 'Custom payload factory used');
  }

  // 20. Options default threshold via constructor
  {
    const filter = new ConfidenceFilter(null, null, { defaultThreshold: 55 });
    const result = filter.filter([makeFinding('a', 56)]);
    assert(result.accepted.length === 1, 'Constructor defaultThreshold=55 accepts 56');
  }

  // 21. Finding metadata preserved
  {
    const filter = new ConfidenceFilter(null, null);
    const f: Finding = { ...makeFinding('m', 80), metadata: { severity: 'high' } };
    const result = filter.filter([f]);
    assert(result.accepted[0].metadata?.severity === 'high', 'Metadata preserved through filter');
  }
}

// ============================================================================
// 8c — MATCHER-BASED HOOK FILTERING
// ============================================================================

async function testMatcherHooks() {
  header('Phase 8c — Matcher-Based Hook Filtering');

  // 1. matchGlob — exact match
  {
    assert(matchGlob('hello', 'hello'), 'matchGlob: exact match');
  }

  // 2. matchGlob — star wildcard
  {
    assert(matchGlob('agent-*', 'agent-research'), 'matchGlob: agent-* matches agent-research');
    assert(!matchGlob('agent-*', 'other-agent'), 'matchGlob: agent-* does not match other-agent');
  }

  // 3. matchGlob — question mark wildcard
  {
    assert(matchGlob('v?.0', 'v1.0'), 'matchGlob: v?.0 matches v1.0');
    assert(!matchGlob('v?.0', 'v12.0'), 'matchGlob: v?.0 does not match v12.0');
  }

  // 4. matchGlob — case insensitive
  {
    assert(matchGlob('AGENT', 'agent'), 'matchGlob: case insensitive');
  }

  // 5. matchGlob — special regex chars escaped
  {
    assert(matchGlob('file.ts', 'file.ts'), 'matchGlob: dot is literal');
    assert(!matchGlob('file.ts', 'filexts'), 'matchGlob: dot is not regex any-char');
  }

  // 6. matchToolPattern — tool with args
  {
    assert(matchToolPattern('Bash(git *)', 'Bash(git push)'), 'matchToolPattern: Bash(git push) matches');
    assert(!matchToolPattern('Bash(git *)', 'Bash(npm install)'), 'matchToolPattern: Bash(npm install) does not match');
  }

  // 7. matchToolPattern — tool name only
  {
    assert(matchToolPattern('Bash', 'Bash'), 'matchToolPattern: bare tool name');
  }

  // 8. matchToolPattern — wildcard tool name
  {
    assert(matchToolPattern('*(*.env)', 'Edit(.env)'), 'matchToolPattern: *(*.env) matches Edit(.env)');
  }

  // 9. Hook with agentPattern matcher — fires for matching agent
  {
    const hooks = new AdapterHookManager();
    let fired = false;
    hooks.register({
      name: 'agent-filter',
      phase: 'beforeExecute',
      handler: (ctx) => { fired = true; return ctx; },
      matcher: { agentPattern: 'scan-*' },
    });
    const ctx1 = hooks.createContext('scan-vuln', { action: 'run', params: {} }, baseCtx);
    await hooks.runBefore(ctx1);
    assert(fired, 'Hook fires for matching agent pattern');
  }

  // 10. Hook with agentPattern matcher — skipped for non-matching agent
  {
    const hooks = new AdapterHookManager();
    let fired = false;
    hooks.register({
      name: 'agent-filter2',
      phase: 'beforeExecute',
      handler: (ctx) => { fired = true; return ctx; },
      matcher: { agentPattern: 'scan-*' },
    });
    const ctx1 = hooks.createContext('deploy-agent', { action: 'run', params: {} }, baseCtx);
    await hooks.runBefore(ctx1);
    assert(!fired, 'Hook skipped for non-matching agent');
  }

  // 11. Hook with actionPattern matcher
  {
    const hooks = new AdapterHookManager();
    let fired = false;
    hooks.register({
      name: 'action-filter',
      phase: 'beforeExecute',
      handler: (ctx) => { fired = true; return ctx; },
      matcher: { actionPattern: 'deploy*' },
    });
    const ctx1 = hooks.createContext('agent', { action: 'deploy-prod', params: {} }, baseCtx);
    await hooks.runBefore(ctx1);
    assert(fired, 'Hook fires for matching action pattern');
  }

  // 12. Hook with toolPattern matcher
  {
    const hooks = new AdapterHookManager();
    let fired = false;
    hooks.register({
      name: 'tool-filter',
      phase: 'beforeExecute',
      handler: (ctx) => { fired = true; return ctx; },
      matcher: { toolPattern: 'Bash(git *)' },
    });
    const ctx1 = hooks.createContext('agent', { action: 'run', params: {} }, baseCtx);
    ctx1.metadata.tool = 'Bash(git push)';
    await hooks.runBefore(ctx1);
    assert(fired, 'Hook fires for matching tool pattern');
  }

  // 13. Hook with condition function
  {
    const hooks = new AdapterHookManager();
    let fired = false;
    hooks.register({
      name: 'cond-filter',
      phase: 'beforeExecute',
      handler: (ctx) => { fired = true; return ctx; },
      matcher: { condition: (ctx) => ctx.payload.params?.urgent === true },
    });
    const ctx1 = hooks.createContext('agent', { action: 'run', params: { urgent: true } }, baseCtx);
    await hooks.runBefore(ctx1);
    assert(fired, 'Hook fires when condition returns true');
  }

  // 14. Hook with condition — skipped when false
  {
    const hooks = new AdapterHookManager();
    let fired = false;
    hooks.register({
      name: 'cond-filter2',
      phase: 'beforeExecute',
      handler: (ctx) => { fired = true; return ctx; },
      matcher: { condition: (ctx) => ctx.payload.params?.urgent === true },
    });
    const ctx1 = hooks.createContext('agent', { action: 'run', params: { urgent: false } }, baseCtx);
    await hooks.runBefore(ctx1);
    assert(!fired, 'Hook skipped when condition returns false');
  }

  // 15. Combined matchers — all must pass (AND logic)
  {
    const hooks = new AdapterHookManager();
    let fired = false;
    hooks.register({
      name: 'combo',
      phase: 'beforeExecute',
      handler: (ctx) => { fired = true; return ctx; },
      matcher: { agentPattern: 'scan-*', actionPattern: 'deploy*' },
    });

    // Agent matches, action doesn't
    const ctx1 = hooks.createContext('scan-vuln', { action: 'test', params: {} }, baseCtx);
    await hooks.runBefore(ctx1);
    assert(!fired, 'AND logic: agent matches but action does not → skipped');

    // Both match
    fired = false;
    const ctx2 = hooks.createContext('scan-prod', { action: 'deploy-now', params: {} }, baseCtx);
    await hooks.runBefore(ctx2);
    assert(fired, 'AND logic: both agent and action match → fires');
  }

  // 16. Hooks without matcher always fire
  {
    const hooks = new AdapterHookManager();
    let fired = false;
    hooks.register({
      name: 'no-matcher',
      phase: 'beforeExecute',
      handler: (ctx) => { fired = true; return ctx; },
    });
    const ctx1 = hooks.createContext('anything', { action: 'whatever', params: {} }, baseCtx);
    await hooks.runBefore(ctx1);
    assert(fired, 'Hook without matcher always fires');
  }

  // 17. Matcher on afterExecute phase
  {
    const hooks = new AdapterHookManager();
    let fired = false;
    hooks.register({
      name: 'after-match',
      phase: 'afterExecute',
      handler: (ctx) => { fired = true; return ctx; },
      matcher: { agentPattern: 'special-*' },
    });
    const ctx1 = hooks.createContext('special-agent', { action: 'run', params: {} }, baseCtx);
    ctx1.result = { success: true };
    await hooks.runAfter(ctx1);
    assert(fired, 'Matcher works on afterExecute phase');
  }

  // 18. Matcher on onError phase
  {
    const hooks = new AdapterHookManager();
    let fired = false;
    hooks.register({
      name: 'error-match',
      phase: 'onError',
      handler: (ctx) => { fired = true; return ctx; },
      matcher: { agentPattern: 'critical-*' },
    });
    const ctx1 = hooks.createContext('critical-db', { action: 'query', params: {} }, baseCtx);
    ctx1.error = new Error('boom');
    await hooks.runOnError(ctx1);
    assert(fired, 'Matcher works on onError phase');
  }

  // 19. Tool pattern with no args part in context
  {
    const hooks = new AdapterHookManager();
    let fired = false;
    hooks.register({
      name: 'tool-no-args',
      phase: 'beforeExecute',
      handler: (ctx) => { fired = true; return ctx; },
      matcher: { toolPattern: 'Bash(git *)' },
    });
    const ctx1 = hooks.createContext('agent', { action: 'run', params: {} }, baseCtx);
    ctx1.metadata.tool = 'Bash'; // no args
    await hooks.runBefore(ctx1);
    assert(!fired, 'Tool pattern with args does not match bare tool');
  }

  // 20. Priority ordering still respected with matchers
  {
    const hooks = new AdapterHookManager();
    const order: string[] = [];
    hooks.register({
      name: 'low-prio',
      phase: 'beforeExecute',
      priority: 1,
      handler: (ctx) => { order.push('low'); return ctx; },
      matcher: { agentPattern: '*' },
    });
    hooks.register({
      name: 'high-prio',
      phase: 'beforeExecute',
      priority: 10,
      handler: (ctx) => { order.push('high'); return ctx; },
      matcher: { agentPattern: '*' },
    });
    const ctx1 = hooks.createContext('agent', { action: 'run', params: {} }, baseCtx);
    await hooks.runBefore(ctx1);
    assert(order[0] === 'high' && order[1] === 'low', 'Priority ordering preserved with matchers');
  }

  // 21. matchGlob — full wildcard
  {
    assert(matchGlob('*', 'anything'), 'matchGlob: * matches anything');
  }
}

// ============================================================================
// 8d — FAN-OUT / FAN-IN PARALLEL AGGREGATION
// ============================================================================

async function testFanOutFanIn() {
  header('Phase 8d — Fan-Out / Fan-In Parallel Aggregation');

  // 1. Basic fan-out executes all steps
  {
    const { registry, adapter } = await makeRegistry();
    const fanout = new FanOutFanIn(registry, baseCtx);
    const steps: FanOutStep[] = [
      { agentId: 'a', payload: { action: 'search', params: {} } },
      { agentId: 'b', payload: { action: 'search', params: {} } },
      { agentId: 'c', payload: { action: 'search', params: {} } },
    ];
    const results = await fanout.fanOut(steps);
    assert(results.length === 3, 'Fan-out returns 3 results');
    assert(adapter.callCount === 3, 'All 3 agents executed');
  }

  // 2. Results are tagged with index and agentId
  {
    const { registry } = await makeRegistry();
    const fanout = new FanOutFanIn(registry, baseCtx);
    const results = await fanout.fanOut([
      { agentId: 'agent-x', payload: { action: 'go', params: {} }, label: 'web' },
    ]);
    assert(results[0].agentId === 'agent-x', 'Tagged with agentId');
    assert(results[0].label === 'web', 'Tagged with label');
    assert(results[0].index === 0, 'Tagged with index');
  }

  // 3. durationMs is tracked per result
  {
    const { registry } = await makeRegistry();
    const fanout = new FanOutFanIn(registry, baseCtx);
    const results = await fanout.fanOut([
      { agentId: 'a', payload: { action: 'go', params: {} } },
    ]);
    assert(results[0].durationMs >= 0, 'durationMs is non-negative');
  }

  // 4. Concurrency limit chunks execution
  {
    const { registry, adapter } = await makeRegistry();
    const fanout = new FanOutFanIn(registry, baseCtx);
    const steps: FanOutStep[] = Array.from({ length: 6 }, (_, i) => ({
      agentId: `agent-${i}`,
      payload: { action: 'go', params: {} },
    }));
    const results = await fanout.fanOut(steps, { concurrency: 2 });
    assert(results.length === 6, 'All 6 results returned with concurrency=2');
    assert(adapter.callCount === 6, 'All 6 agents executed');
  }

  // 5. continueOnError=true (default) — continues past failures
  {
    const registry = new AdapterRegistry();
    await registry.addAdapter(new MockAdapter('mock'));
    await registry.addAdapter(new FailingAdapter());
    registry.addRoute({ pattern: 'fail:*', adapterName: 'failing' });
    registry.setDefaultAdapter('mock');
    const fanout = new FanOutFanIn(registry, baseCtx);
    const steps: FanOutStep[] = [
      { agentId: 'ok-agent', payload: { action: 'go', params: {} } },
      { agentId: 'fail:agent', payload: { action: 'go', params: {} } },
      { agentId: 'ok-agent2', payload: { action: 'go', params: {} } },
    ];
    const results = await fanout.fanOut(steps);
    assert(results.length === 3, 'All 3 results returned despite failure');
    assert(!results[1].result.success, 'Second result is a failure');
    assert(results[2].result.success, 'Third result still succeeds');
  }

  // 6. continueOnError=false — stops on first failure
  {
    const registry = new AdapterRegistry();
    await registry.addAdapter(new MockAdapter('mock'));
    await registry.addAdapter(new FailingAdapter());
    registry.addRoute({ pattern: 'fail:*', adapterName: 'failing' });
    registry.setDefaultAdapter('mock');
    const fanout = new FanOutFanIn(registry, baseCtx);
    const results = await fanout.fanOut(
      [
        { agentId: 'fail:x', payload: { action: 'go', params: {} } },
        { agentId: 'ok', payload: { action: 'go', params: {} } },
      ],
      { continueOnError: false, concurrency: 1 },
    );
    assert(results[1]?.result?.error?.code === 'FANOUT_SKIPPED', 'Second step skipped after failure');
  }

  // 7. fanIn — merge strategy
  {
    const { registry } = await makeRegistry();
    const fanout = new FanOutFanIn(registry, baseCtx);
    const results = await fanout.fanOut([
      { agentId: 'a', payload: { action: 'go', params: {} } },
      { agentId: 'b', payload: { action: 'go', params: {} } },
    ]);
    const merged = fanout.fanIn(results, 'merge');
    assert(merged.success, 'merge: success');
    assert(Array.isArray(merged.data), 'merge: data is array');
    assert((merged.data as unknown[]).length === 2, 'merge: 2 items');
  }

  // 8. fanIn — firstSuccess strategy
  {
    const tagged: TaggedResult[] = [
      { agentId: 'a', index: 0, result: { success: false, error: { code: 'E', message: 'fail', recoverable: false } }, durationMs: 1 },
      { agentId: 'b', index: 1, result: { success: true, data: 'winner' }, durationMs: 1 },
      { agentId: 'c', index: 2, result: { success: true, data: 'also-ok' }, durationMs: 1 },
    ];
    const { registry } = await makeRegistry();
    const fanout = new FanOutFanIn(registry, baseCtx);
    const result = fanout.fanIn(tagged, 'firstSuccess');
    assert(result.success, 'firstSuccess: success');
    assert(result.data === 'winner', 'firstSuccess: picks first success');
  }

  // 9. fanIn — firstSuccess with no successes
  {
    const tagged: TaggedResult[] = [
      { agentId: 'a', index: 0, result: { success: false }, durationMs: 1 },
    ];
    const { registry } = await makeRegistry();
    const fanout = new FanOutFanIn(registry, baseCtx);
    const result = fanout.fanIn(tagged, 'firstSuccess');
    assert(!result.success, 'firstSuccess: fails when no successes');
  }

  // 10. fanIn — vote strategy
  {
    const tagged: TaggedResult[] = [
      { agentId: 'a', index: 0, result: { success: true, data: 'yes' }, durationMs: 1 },
      { agentId: 'b', index: 1, result: { success: true, data: 'no' }, durationMs: 1 },
      { agentId: 'c', index: 2, result: { success: true, data: 'yes' }, durationMs: 1 },
    ];
    const { registry } = await makeRegistry();
    const fanout = new FanOutFanIn(registry, baseCtx);
    const result = fanout.fanIn(tagged, 'vote');
    assert(result.data === 'yes', 'vote: majority wins');
  }

  // 11. fanIn — consensus strategy (all agree)
  {
    const tagged: TaggedResult[] = [
      { agentId: 'a', index: 0, result: { success: true, data: 42 }, durationMs: 1 },
      { agentId: 'b', index: 1, result: { success: true, data: 42 }, durationMs: 1 },
    ];
    const { registry } = await makeRegistry();
    const fanout = new FanOutFanIn(registry, baseCtx);
    const result = fanout.fanIn(tagged, 'consensus');
    assert(result.success, 'consensus: all agree → success');
    assert(result.data === 42, 'consensus: returns agreed data');
  }

  // 12. fanIn — consensus strategy (disagreement)
  {
    const tagged: TaggedResult[] = [
      { agentId: 'a', index: 0, result: { success: true, data: 'yes' }, durationMs: 1 },
      { agentId: 'b', index: 1, result: { success: true, data: 'no' }, durationMs: 1 },
    ];
    const { registry } = await makeRegistry();
    const fanout = new FanOutFanIn(registry, baseCtx);
    const result = fanout.fanIn(tagged, 'consensus');
    assert(!result.success, 'consensus: disagreement → failure');
    assert(result.data === null, 'consensus: data is null on disagreement');
  }

  // 13. fanIn — custom strategy
  {
    const tagged: TaggedResult[] = [
      { agentId: 'a', index: 0, result: { success: true, data: 10 }, durationMs: 1 },
      { agentId: 'b', index: 1, result: { success: true, data: 20 }, durationMs: 1 },
    ];
    const { registry } = await makeRegistry();
    const fanout = new FanOutFanIn(registry, baseCtx);
    const result = fanout.fanIn(tagged, 'custom', (results) => {
      const sum = results.reduce((s, r) => s + (r.result.data as number), 0);
      return { success: true, data: sum };
    });
    assert(result.data === 30, 'custom: sums data');
  }

  // 14. fanIn — custom without reducer throws
  {
    const { registry } = await makeRegistry();
    const fanout = new FanOutFanIn(registry, baseCtx);
    let threw = false;
    try { fanout.fanIn([], 'custom'); } catch { threw = true; }
    assert(threw, 'custom: throws without reducer');
  }

  // 15. fanIn — reports successCount and failureCount
  {
    const tagged: TaggedResult[] = [
      { agentId: 'a', index: 0, result: { success: true, data: 1 }, durationMs: 10 },
      { agentId: 'b', index: 1, result: { success: false }, durationMs: 5 },
    ];
    const { registry } = await makeRegistry();
    const fanout = new FanOutFanIn(registry, baseCtx);
    const result = fanout.fanIn(tagged, 'merge');
    assert(result.successCount === 1, 'Reports successCount');
    assert(result.failureCount === 1, 'Reports failureCount');
    assert(result.totalMs === 15, 'Reports totalMs');
  }

  // 16. run() convenience method — fan-out + fan-in
  {
    const { registry } = await makeRegistry();
    const fanout = new FanOutFanIn(registry, baseCtx);
    const result = await fanout.run(
      [
        { agentId: 'a', payload: { action: 'go', params: {} } },
        { agentId: 'b', payload: { action: 'go', params: {} } },
      ],
      'merge',
    );
    assert(result.success, 'run() convenience succeeds');
    assert(result.results.length === 2, 'run() has 2 results');
    assert(result.strategy === 'merge', 'run() reports strategy');
  }

  // 17. Context overrides per step
  {
    const { registry } = await makeRegistry();
    const fanout = new FanOutFanIn(registry, baseCtx);
    const results = await fanout.fanOut([
      { agentId: 'a', payload: { action: 'go', params: {} }, context: { agentId: 'custom-ctx' } },
    ]);
    assert(results[0].result.success, 'Step with context override succeeds');
  }

  // 18. Empty fan-out
  {
    const { registry } = await makeRegistry();
    const fanout = new FanOutFanIn(registry, baseCtx);
    const results = await fanout.fanOut([]);
    assert(results.length === 0, 'Empty fan-out returns empty array');
  }

  // 19. fanIn — empty results
  {
    const { registry } = await makeRegistry();
    const fanout = new FanOutFanIn(registry, baseCtx);
    const result = fanout.fanIn([], 'merge');
    assert(!result.success, 'merge with empty → not success');
    assert((result.data as unknown[]).length === 0, 'merge with empty → empty data');
  }

  // 20. fanIn — vote with empty
  {
    const { registry } = await makeRegistry();
    const fanout = new FanOutFanIn(registry, baseCtx);
    const result = fanout.fanIn([], 'vote');
    assert(!result.success, 'vote with empty → not success');
  }

  // 21. Fan-out with labels
  {
    const { registry } = await makeRegistry();
    const fanout = new FanOutFanIn(registry, baseCtx);
    const results = await fanout.fanOut([
      { agentId: 'a', payload: { action: 'go', params: {} }, label: 'first' },
      { agentId: 'b', payload: { action: 'go', params: {} }, label: 'second' },
    ]);
    assert(results[0].label === 'first', 'Label preserved on first');
    assert(results[1].label === 'second', 'Label preserved on second');
  }

  // 22. Large fan-out (20 agents)
  {
    const { registry, adapter } = await makeRegistry();
    const fanout = new FanOutFanIn(registry, baseCtx);
    const steps: FanOutStep[] = Array.from({ length: 20 }, (_, i) => ({
      agentId: `agent-${i}`,
      payload: { action: 'work', params: { idx: i } },
    }));
    const results = await fanout.fanOut(steps, { concurrency: 5 });
    assert(results.length === 20, 'All 20 results returned');
    assert(adapter.callCount === 20, 'All 20 agents called');
  }

  // 23. Fan-in merge preserves labels
  {
    const tagged: TaggedResult[] = [
      { agentId: 'a', label: 'web', index: 0, result: { success: true, data: 'r1' }, durationMs: 1 },
      { agentId: 'b', label: 'db', index: 1, result: { success: true, data: 'r2' }, durationMs: 1 },
    ];
    const { registry } = await makeRegistry();
    const fanout = new FanOutFanIn(registry, baseCtx);
    const result = fanout.fanIn(tagged, 'merge');
    const data = result.data as Array<{ label?: string }>;
    assert(data[0].label === 'web', 'merge preserves label in data');
  }

  // 24. consensus with single result always succeeds
  {
    const tagged: TaggedResult[] = [
      { agentId: 'a', index: 0, result: { success: true, data: 'only' }, durationMs: 1 },
    ];
    const { registry } = await makeRegistry();
    const fanout = new FanOutFanIn(registry, baseCtx);
    const result = fanout.fanIn(tagged, 'consensus');
    assert(result.success, 'consensus: single result → success');
  }

  // 25. consensus with all failures
  {
    const tagged: TaggedResult[] = [
      { agentId: 'a', index: 0, result: { success: false }, durationMs: 1 },
      { agentId: 'b', index: 1, result: { success: false }, durationMs: 1 },
    ];
    const { registry } = await makeRegistry();
    const fanout = new FanOutFanIn(registry, baseCtx);
    const result = fanout.fanIn(tagged, 'consensus');
    assert(!result.success, 'consensus: all failures → fail');
  }
}

// ============================================================================
// RUNNER
// ============================================================================

async function main() {
  console.log('\n' + '='.repeat(64));
  log('  Phase 8: Claude-Code Inspired Enhancements — Test Suite', 'bold');
  console.log('='.repeat(64));

  await testPhasePipeline();
  await testConfidenceFilter();
  await testMatcherHooks();
  await testFanOutFanIn();

  console.log('\n' + '='.repeat(64));
  log(`  RESULTS: ${passed} passed, ${failed} failed (${passed + failed} total)`, failed > 0 ? 'red' : 'green');
  console.log('='.repeat(64) + '\n');

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
