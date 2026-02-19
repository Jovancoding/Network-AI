/**
 * Phase 4: Behavioral Control Plane — Test Suite
 * Run with: npx ts-node test-phase4.ts
 */

import {
  JourneyFSM,
  ToolAuthorizationMatrix,
  ComplianceMiddleware,
  ComplianceViolationError,
  createDeliveryPipelineFSM,
  WORKFLOW_STATES,
} from './lib/fsm-journey';

import { ComplianceMonitor } from './lib/compliance-monitor';

import {
  BlackboardMCPTools,
  registerBlackboardTools,
  BLACKBOARD_TOOL_DEFINITIONS,
  IBlackboard,
} from './lib/mcp-blackboard-tools';

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

async function assertThrows(fn: () => unknown, ctor: Function, name: string) {
  try {
    await fn();
    fail(name, `Expected ${ctor.name} but nothing was thrown`);
  } catch (e) {
    e instanceof ctor ? pass(name) : fail(name, `Expected ${ctor.name}, got: ${e}`);
  }
}

// ============================================================================
// MOCK BLACKBOARD
// ============================================================================

type BB_Entry = { key: string; value: unknown; sourceAgent: string; timestamp: string; ttl: number | null };

function makeMockBlackboard(): IBlackboard & { _store: Map<string, BB_Entry> } {
  const store = new Map<string, BB_Entry>();
  return {
    _store: store,
    read(key)        { return store.get(key) ?? null; },
    write(key, value, sourceAgent, ttl, _tok) {
      const e: BB_Entry = { key, value, sourceAgent, timestamp: new Date().toISOString(), ttl: ttl ?? null };
      store.set(key, e); return e;
    },
    exists(key)      { return store.has(key); },
    getSnapshot()    { const o: Record<string, BB_Entry> = {}; store.forEach((v, k) => { o[k] = v; }); return o; },
    getScopedSnapshot(_id) { const o: Record<string, unknown> = {}; store.forEach((v, k) => { o[k] = v; }); return o; },
    delete(key)      { store.delete(key); },
  };
}

// ============================================================================
// Helper: build a minimal FSM with two states
// ============================================================================

function makeSimpleFSM(extraTools?: { agentId: string; tools: string[] }) {
  const intel = WORKFLOW_STATES.INTAKE;
  const exec  = WORKFLOW_STATES.EXECUTE;
  return new JourneyFSM({
    states: [
      {
        name: intel,
        authorizedAgents: ['orchestrator'],
        authorizedTools: extraTools?.tools
          ? { [extraTools.agentId]: extraTools.tools }
          : undefined,
      },
      {
        name: exec,
        authorizedAgents: ['orchestrator', 'executor'],
        authorizedTools: { executor: ['run_code', 'write_blackboard'] },
      },
    ],
    transitions: [
      { from: intel, event: 'START', to: exec, allowedBy: 'orchestrator' },
    ],
    initialState: intel,
  });
}

// ============================================================================
// SECTION 1 — WORKFLOW_STATES constants
// ============================================================================

async function testWorkflowStates() {
  header('Section 1 — WORKFLOW_STATES constants');

  assert(typeof WORKFLOW_STATES === 'object', 'WORKFLOW_STATES is an object');
  assert(WORKFLOW_STATES.INTAKE   === 'INTAKE',   'INTAKE   constant correct');
  assert(WORKFLOW_STATES.VALIDATE === 'VALIDATE', 'VALIDATE constant correct');
  assert(WORKFLOW_STATES.RESEARCH === 'RESEARCH', 'RESEARCH constant correct');
  assert(WORKFLOW_STATES.PLAN     === 'PLAN',     'PLAN     constant correct');
  assert(WORKFLOW_STATES.EXECUTE  === 'EXECUTE',  'EXECUTE  constant correct');
  assert(WORKFLOW_STATES.REVIEW   === 'REVIEW',   'REVIEW   constant correct');
  assert(WORKFLOW_STATES.DELIVER  === 'DELIVER',  'DELIVER  constant correct');
  assert(WORKFLOW_STATES.COMPLETE === 'COMPLETE', 'COMPLETE constant correct');
  assert(WORKFLOW_STATES.ERROR    === 'ERROR',    'ERROR    constant correct');
}

// ============================================================================
// SECTION 2 — ToolAuthorizationMatrix
// ============================================================================

async function testToolAuthorizationMatrix() {
  header('Section 2 — ToolAuthorizationMatrix');

  const matrix = new ToolAuthorizationMatrix();

  matrix.allow('analyst', WORKFLOW_STATES.RESEARCH, ['web_search', 'scrape']);
  assert(matrix.isAllowed('analyst', WORKFLOW_STATES.RESEARCH, 'web_search'), 'allow: web_search permitted');
  assert(matrix.isAllowed('analyst', WORKFLOW_STATES.RESEARCH, 'scrape'),     'allow: scrape permitted');
  assert(!matrix.isAllowed('analyst', WORKFLOW_STATES.RESEARCH, 'delete'),    'deny: delete not allowed');

  // State isolation
  assert(!matrix.isAllowed('analyst', WORKFLOW_STATES.EXECUTE, 'web_search'), 'state isolation: no carry-over');

  // Revoke
  matrix.revoke('analyst', WORKFLOW_STATES.RESEARCH, 'scrape');
  assert(!matrix.isAllowed('analyst', WORKFLOW_STATES.RESEARCH, 'scrape'),    'revoke: scrape removed');
  assert(matrix.isAllowed('analyst', WORKFLOW_STATES.RESEARCH, 'web_search'), 'revoke: web_search intact');

  // Wildcard agent
  matrix.allow('*', WORKFLOW_STATES.EXECUTE, ['read_blackboard']);
  assert(matrix.isAllowed('anyone', WORKFLOW_STATES.EXECUTE, 'read_blackboard'), 'wildcard agent: any agent allowed');

  // Wildcard tool
  matrix.allow('superagent', WORKFLOW_STATES.PLAN, ['*']);
  assert(matrix.isAllowed('superagent', WORKFLOW_STATES.PLAN, 'anything'), 'wildcard tool: any tool allowed');

  // Unknown agent
  assert(!matrix.isAllowed('nobody', WORKFLOW_STATES.RESEARCH, 'web_search'), 'unknown agent denied');

  // dump() shape
  const dump = matrix.dump();
  assert(typeof dump === 'object' && dump !== null, 'dump() returns object');
  assert('analyst' in dump, 'dump() contains analyst key');
}

// ============================================================================
// SECTION 3 — JourneyFSM construction & initial state
// ============================================================================

async function testJourneyFSMInit() {
  header('Section 3 — JourneyFSM construction & initial state');

  const fsm = makeSimpleFSM();
  assert(fsm.state === WORKFLOW_STATES.INTAKE, 'initial state is INTAKE');
  assert(fsm.transitionHistory.length === 1,   'history has 1 entry (initial state)');
  assert(fsm.availableEvents().includes('START'), 'START event available from INTAKE');
  assert(fsm.timeInCurrentState >= 0,           'timeInCurrentState >= 0');
  assert(fsm.isTimedOut === false,              'isTimedOut is false (no timeout set)');
}

// ============================================================================
// SECTION 4 — JourneyFSM transitions
// ============================================================================

async function testJourneyFSMTransitions() {
  header('Section 4 — JourneyFSM transitions');

  const fsm = new JourneyFSM({
    states: [
      { name: WORKFLOW_STATES.INTAKE,   authorizedAgents: ['orchestrator'] },
      { name: WORKFLOW_STATES.PLAN,     authorizedAgents: ['orchestrator'] },
      { name: WORKFLOW_STATES.COMPLETE, authorizedAgents: ['*'] },
    ],
    transitions: [
      { from: WORKFLOW_STATES.INTAKE,   event: 'START',    to: WORKFLOW_STATES.PLAN     },
      { from: WORKFLOW_STATES.PLAN,     event: 'DONE',     to: WORKFLOW_STATES.COMPLETE },
    ],
    initialState: WORKFLOW_STATES.INTAKE,
  });

  const r1 = fsm.transition('START', 'orchestrator');
  assert(r1.success, 'START transition succeeds');
  assert(fsm.state === WORKFLOW_STATES.PLAN, 'state is PLAN after START');
  assert(r1.previousState === WORKFLOW_STATES.INTAKE, 'previousState is INTAKE');

  // Invalid event from current state
  const r2 = fsm.transition('START', 'orchestrator');
  assert(!r2.success, 'START not valid from PLAN');
  assert(fsm.state === WORKFLOW_STATES.PLAN, 'state unchanged on failed transition');

  // Second valid transition
  const r3 = fsm.transition('DONE', 'orchestrator');
  assert(r3.success, 'DONE transition succeeds');
  assert(fsm.state === WORKFLOW_STATES.COMPLETE, 'state is COMPLETE');

  // Terminal state
  const r4 = fsm.transition('ANY', 'orchestrator');
  assert(!r4.success, 'no transitions from terminal state');

  // History tracking — each state entry is recorded
  assert(fsm.transitionHistory.length >= 3, 'history has at least 3 entries');
  assert(fsm.transitionHistory[0].state === WORKFLOW_STATES.INTAKE, 'history[0] is INTAKE');
  assert(fsm.transitionHistory[1].state === WORKFLOW_STATES.PLAN,   'history[1] is PLAN');
  assert(typeof fsm.transitionHistory[0].enteredAt === 'number',    'history entry has enteredAt');
}

// ============================================================================
// SECTION 5 — JourneyFSM agent authorization
// ============================================================================

async function testJourneyFSMAuthorization() {
  header('Section 5 — JourneyFSM agent authorization');

  const fsm = makeSimpleFSM();

  // canAgentAct in INTAKE
  assert(fsm.canAgentAct('orchestrator'), 'orchestrator can act in INTAKE');
  assert(!fsm.canAgentAct('executor'),    'executor cannot act in INTAKE');

  // After transition
  fsm.transition('START', 'orchestrator');
  assert(fsm.canAgentAct('executor'),     'executor can act in EXECUTE');
  assert(fsm.canAgentAct('orchestrator'), 'orchestrator can act in EXECUTE');
  assert(!fsm.canAgentAct('rogue'),       'rogue cannot act in EXECUTE');

  // getAuthorizedAgents
  const agents = fsm.getAuthorizedAgents();
  assert(agents.includes('executor'),     'getAuthorizedAgents includes executor');
  assert(agents.includes('orchestrator'), 'getAuthorizedAgents includes orchestrator');

  // allowedBy enforcement
  const fsm2 = new JourneyFSM({
    states: [
      { name: WORKFLOW_STATES.INTAKE, authorizedAgents: ['*'] },
      { name: WORKFLOW_STATES.PLAN,   authorizedAgents: ['*'] },
    ],
    transitions: [
      { from: WORKFLOW_STATES.INTAKE, event: 'GO', to: WORKFLOW_STATES.PLAN, allowedBy: 'orchestrator' },
    ],
    initialState: WORKFLOW_STATES.INTAKE,
  });

  const rBad = fsm2.transition('GO', 'rogue');
  assert(!rBad.success, 'allowedBy: rogue cannot fire transition');
  const rGood = fsm2.transition('GO', 'orchestrator');
  assert(rGood.success, 'allowedBy: orchestrator can fire transition');
}

// ============================================================================
// SECTION 6 — JourneyFSM tool authorization
// ============================================================================

async function testJourneyFSMToolAuth() {
  header('Section 6 — JourneyFSM tool authorization');

  const fsm = new JourneyFSM({
    states: [
      {
        name: WORKFLOW_STATES.RESEARCH,
        authorizedAgents: ['analyst'],
        authorizedTools: { analyst: ['web_search', 'read_doc'] },
      },
      {
        name: WORKFLOW_STATES.EXECUTE,
        authorizedAgents: ['analyst'],
        authorizedTools: { analyst: ['write_result'] },
      },
    ],
    transitions: [
      { from: WORKFLOW_STATES.RESEARCH, event: 'GO', to: WORKFLOW_STATES.EXECUTE },
    ],
    initialState: WORKFLOW_STATES.RESEARCH,
  });

  assert(fsm.canAgentUseTool('analyst', 'web_search'),   'analyst can use web_search in RESEARCH');
  assert(!fsm.canAgentUseTool('analyst', 'write_result'),'analyst cannot use write_result in RESEARCH');

  fsm.transition('GO', 'analyst');
  assert(!fsm.canAgentUseTool('analyst', 'web_search'),  'analyst cannot use web_search in EXECUTE');
  assert(fsm.canAgentUseTool('analyst', 'write_result'), 'analyst can use write_result in EXECUTE');

  // checkCompliance shape
  const ok  = fsm.checkCompliance('analyst', 'write_result');
  assert(ok.allowed === true,  'checkCompliance allowed=true when permitted');
  assert(typeof ok.currentState === 'string', 'checkCompliance has currentState');

  const nok = fsm.checkCompliance('analyst', 'web_search');
  assert(nok.allowed === false, 'checkCompliance allowed=false when not permitted');
  assert(typeof nok.reason === 'string', 'checkCompliance has reason when denied');
}

// ============================================================================
// SECTION 7 — JourneyFSM reset
// ============================================================================

async function testJourneyFSMReset() {
  header('Section 7 — JourneyFSM reset');

  const fsm = makeSimpleFSM();
  fsm.transition('START', 'orchestrator');
  assert(fsm.state === WORKFLOW_STATES.EXECUTE, 'moved to EXECUTE before reset');

  const histLenBefore = fsm.transitionHistory.length;
  fsm.reset();
  assert(fsm.state === WORKFLOW_STATES.INTAKE, 'state reset to INTAKE');
  assert(fsm.transitionHistory.length > histLenBefore, 'history grows on reset (new entry appended)');
}

// ============================================================================
// SECTION 8 — ComplianceMiddleware
// ============================================================================

async function testComplianceMiddleware() {
  header('Section 8 — ComplianceMiddleware');

  const fsm = new JourneyFSM({
    states: [
      {
        name: WORKFLOW_STATES.EXECUTE,
        authorizedAgents: ['executor'],
        authorizedTools: { executor: ['write_result', 'read_doc'] },
      },
    ],
    transitions: [],
    initialState: WORKFLOW_STATES.EXECUTE,
  });

  const mw = new ComplianceMiddleware(fsm);

  // Allowed async action
  let ran = false;
  await mw.enforce('executor', 'write_result', async () => { ran = true; });
  assert(ran, 'enforce: allowed action executes');

  // Disallowed tool
  await assertThrows(
    () => mw.enforce('executor', 'forbidden_tool', async () => 'x'),
    ComplianceViolationError,
    'enforce: throws ComplianceViolationError for disallowed tool'
  );

  // Unauthorized agent
  await assertThrows(
    () => mw.enforce('rogue', 'write_result', async () => 'x'),
    ComplianceViolationError,
    'enforce: throws ComplianceViolationError for unauthorized agent'
  );

  // enforceSync — allowed
  let syncRan = false;
  mw.enforceSync('executor', 'read_doc', () => { syncRan = true; });
  assert(syncRan, 'enforceSync: allowed action executes');

  // enforceSync — disallowed
  let threw = false;
  try { mw.enforceSync('executor', 'banned', () => 'x'); } catch (e) { threw = e instanceof ComplianceViolationError; }
  assert(threw, 'enforceSync: throws ComplianceViolationError for disallowed tool');

  // ComplianceViolationError.check shape
  try {
    mw.enforceSync('executor', 'no_tool', () => 'x');
  } catch (e) {
    if (e instanceof ComplianceViolationError) {
      assert(typeof e.check === 'object', 'error.check is object');
      assert(e.check.allowed === false,    'error.check.allowed is false');
      assert(typeof e.check.currentState === 'string', 'error.check.currentState is string');
    }
  }
}

// ============================================================================
// SECTION 9 — createDeliveryPipelineFSM factory
// ============================================================================

async function testDeliveryPipelineFactory() {
  header('Section 9 — createDeliveryPipelineFSM factory');

  const transitions: string[] = [];
  const fsm = createDeliveryPipelineFSM({
    orchestratorId:  'orc',
    researchAgentId: 'research',
    executorId:      'exec',
    reviewerId:      'reviewer',
    onTransition: (result, _agentId) => transitions.push(result.previousState + '->' + result.currentState),
  });

  assert(fsm instanceof JourneyFSM, 'factory returns JourneyFSM instance');
  assert(fsm.state === WORKFLOW_STATES.INTAKE, 'starts at INTAKE');

  const r1 = fsm.transition('validate', 'orc');
  assert(r1.success, 'validate transition from INTAKE succeeds');
  assert(fsm.state === WORKFLOW_STATES.VALIDATE, 'in VALIDATE after validate');
  assert(transitions.length > 0, 'onTransition callback fired');

  const r2 = fsm.transition('start_research', 'orc');
  assert(r2.success, 'start_research from VALIDATE succeeds');
  assert(fsm.state === WORKFLOW_STATES.RESEARCH, 'in RESEARCH');

  // Research agent can act
  assert(fsm.canAgentAct('research'), 'research agent authorized in RESEARCH');
  assert(!fsm.canAgentAct('exec'),    'exec not authorized in RESEARCH');

  // availableEvents check
  const events = fsm.availableEvents();
  assert(events.includes('research_done'), 'research_done available in RESEARCH');
}

// ============================================================================
// SECTION 10 — ComplianceMonitor start/stop
// ============================================================================

async function testComplianceMonitorBasic() {
  header('Section 10 — ComplianceMonitor start/stop');

  const monitor = new ComplianceMonitor({ pollIntervalMs: 50_000, collectViolations: true });

  assert(!monitor.isRunning, 'not running before start');
  monitor.start();
  assert(monitor.isRunning, 'running after start');
  monitor.stop();
  assert(!monitor.isRunning, 'stopped after stop');

  // Idempotent stop
  monitor.stop();
  pass('double stop() is safe');

  // Idempotent start
  monitor.start();
  monitor.start();
  assert(monitor.isRunning, 'double start() is safe');
  monitor.stop();
}

// ============================================================================
// SECTION 11 — ComplianceMonitor recordAction & getSummary
// ============================================================================

async function testComplianceMonitorSummary() {
  header('Section 11 — ComplianceMonitor recordAction & getSummary');

  const monitor = new ComplianceMonitor({ pollIntervalMs: 100_000, collectViolations: true });

  monitor.recordAction({ agentId: 'agentA', action: 'query',    tool: 'web_search' });
  monitor.recordAction({ agentId: 'agentA', action: 'write',    tool: 'write_doc'  });
  monitor.recordAction({ agentId: 'agentB', action: 'read',     tool: 'read_db'    });

  const summary = monitor.getSummary();
  assert(typeof summary === 'object',           'getSummary returns object');
  assert(typeof summary.total === 'number',     'summary.total is number');
  assert(typeof summary.bySeverity === 'object','summary.bySeverity is object');
  assert(typeof summary.byType === 'object',    'summary.byType is object');
  assert(typeof summary.byAgent === 'object',   'summary.byAgent is object');
}

// ============================================================================
// SECTION 12 — ComplianceMonitor setAgentConfig + getViolations
// ============================================================================

async function testComplianceMonitorViolations() {
  header('Section 12 — ComplianceMonitor setAgentConfig + getViolations');

  const emitted: unknown[] = [];
  const monitor = new ComplianceMonitor({
    pollIntervalMs: 100_000,
    collectViolations: true,
    onViolation: (v) => emitted.push(v),
  });

  // Configure with a very tight tool rate window
  monitor.setAgentConfig({
    agentId: 'fastAgent',
    maxToolCallsPerWindow: 2,
    toolRateWindowMs: 60_000,
  });

  const now = Date.now();
  monitor.recordAction({ agentId: 'fastAgent', action: 'search', tool: 'search', timestamp: now      });
  monitor.recordAction({ agentId: 'fastAgent', action: 'search', tool: 'search', timestamp: now + 10 });
  monitor.recordAction({ agentId: 'fastAgent', action: 'search', tool: 'search', timestamp: now + 20 });

  // Third call should trigger TOOL_ABUSE immediately
  const violations = monitor.getViolations();
  assert(Array.isArray(violations), 'getViolations returns array');

  // clearViolations
  monitor.clearViolations();
  const afterClear = monitor.getViolations();
  assert(afterClear.length === 0, 'getViolations empty after clearViolations');

  // filter by type
  monitor.recordAction({ agentId: 'fastAgent', action: 'x', tool: 'search', timestamp: Date.now() });
  const filtered = monitor.getViolations({ agentId: 'fastAgent' });
  assert(Array.isArray(filtered), 'filtered getViolations returns array');
}

// ============================================================================
// SECTION 13 — BlackboardMCPTools getDefinitions
// ============================================================================

async function testMCPToolDefinitions() {
  header('Section 13 — BlackboardMCPTools getDefinitions');

  const bb   = makeMockBlackboard();
  const tools = new BlackboardMCPTools(bb);
  const defs  = tools.getDefinitions();

  assert(Array.isArray(defs),  'getDefinitions returns array');
  assert(defs.length === 5,    `5 definitions returned (got ${defs.length})`);

  const names = defs.map(d => d.name);
  assert(names.includes('blackboard_read'),   'blackboard_read defined');
  assert(names.includes('blackboard_write'),  'blackboard_write defined');
  assert(names.includes('blackboard_list'),   'blackboard_list defined');
  assert(names.includes('blackboard_delete'), 'blackboard_delete defined');
  assert(names.includes('blackboard_exists'), 'blackboard_exists defined');

  for (const d of defs) {
    assert(typeof d.name        === 'string', `${d.name}: name is string`);
    assert(typeof d.description === 'string', `${d.name}: description is string`);
    assert(d.inputSchema.type   === 'object', `${d.name}: inputSchema.type is object`);
  }

  assert(BLACKBOARD_TOOL_DEFINITIONS.length === 5, 'BLACKBOARD_TOOL_DEFINITIONS re-export has 5 entries');
}

// ============================================================================
// SECTION 14 — blackboard_write
// ============================================================================

async function testMCPWrite() {
  header('Section 14 — BlackboardMCPTools blackboard_write');

  const bb    = makeMockBlackboard();
  const tools = new BlackboardMCPTools(bb);

  const r1 = await tools.call('blackboard_write', {
    key: 'task:result', value: JSON.stringify({ score: 0.95 }), agent_id: 'executor',
  });
  assert(r1.ok,                          'write: ok=true');
  assert(r1.tool === 'blackboard_write', 'write: tool name correct');
  assert(bb.exists('task:result'),       'write: key stored in blackboard');
  assert((bb.read('task:result') as any).sourceAgent === 'executor', 'write: sourceAgent stored');

  // With TTL
  const r2 = await tools.call('blackboard_write', {
    key: 'ephemeral:x', value: 'true', agent_id: 'agent', ttl: '60',
  });
  assert(r2.ok, 'write with TTL: ok=true');

  // Missing required field
  const r3 = await tools.call('blackboard_write', { key: 'k', agent_id: 'a' });
  assert(!r3.ok, 'write: ok=false when value missing');

  // JSON value parsing
  const r4 = await tools.call('blackboard_write', {
    key: 'obj:key', value: '{"nested":true}', agent_id: 'a',
  });
  assert(r4.ok, 'write: JSON value parsed and stored');
}

// ============================================================================
// SECTION 15 — blackboard_read
// ============================================================================

async function testMCPRead() {
  header('Section 15 — BlackboardMCPTools blackboard_read');

  const bb    = makeMockBlackboard();
  const tools = new BlackboardMCPTools(bb);

  bb.write('task:analysis', { revenue: 1_000_000 }, 'analyst');

  const r1 = await tools.call('blackboard_read', { key: 'task:analysis', agent_id: 'exec' });
  assert(r1.ok,           'read: ok=true for existing key');
  assert(r1.data !== null, 'read: data not null');

  const r2 = await tools.call('blackboard_read', { key: 'no:such:key', agent_id: 'exec' });
  assert(r2.ok, 'read: ok=true even for missing key');
  assert(r2.data === null || r2.data === undefined, 'read: data null/undefined for missing key');

  const r3 = await tools.call('blackboard_read', { agent_id: 'exec' });
  assert(!r3.ok,                   'read: ok=false when key missing');
  assert(typeof r3.error === 'string', 'read: error message present');
}

// ============================================================================
// SECTION 16 — blackboard_list
// ============================================================================

async function testMCPList() {
  header('Section 16 — BlackboardMCPTools blackboard_list');

  const bb    = makeMockBlackboard();
  const tools = new BlackboardMCPTools(bb);

  bb.write('task:a', 1, 'agent');
  bb.write('task:b', 2, 'agent');
  bb.write('meta:x', 3, 'agent');

  const r1 = await tools.call('blackboard_list', { agent_id: 'exec' });
  assert(r1.ok, 'list: ok=true');
  const d1 = r1.data as any;
  assert(d1.count >= 3, `list: count >= 3 (got ${d1.count})`);

  const r2 = await tools.call('blackboard_list', { agent_id: 'exec', prefix: 'task:' });
  assert(r2.ok, 'list with prefix: ok=true');
  const d2 = r2.data as any;
  assert(d2.count === 2, `list with prefix: count=2 (got ${d2.count})`);
  assert(d2.keys.every((k: string) => k.startsWith('task:')), 'list with prefix: all keys match');
}

// ============================================================================
// SECTION 17 — blackboard_delete
// ============================================================================

async function testMCPDelete() {
  header('Section 17 — BlackboardMCPTools blackboard_delete');

  const bb    = makeMockBlackboard();
  const tools = new BlackboardMCPTools(bb);

  bb.write('temp:foo', 42, 'agent');
  const r1 = await tools.call('blackboard_delete', { key: 'temp:foo', agent_id: 'exec' });
  assert(r1.ok,                  'delete: ok=true for existing key');
  assert(!bb.exists('temp:foo'), 'delete: key removed');

  const r2 = await tools.call('blackboard_delete', { key: 'missing', agent_id: 'exec' });
  assert(!r2.ok,                    'delete: ok=false for missing key');
  assert(typeof r2.error === 'string', 'delete: error message present');
}

// ============================================================================
// SECTION 18 — blackboard_exists
// ============================================================================

async function testMCPExists() {
  header('Section 18 — BlackboardMCPTools blackboard_exists');

  const bb    = makeMockBlackboard();
  const tools = new BlackboardMCPTools(bb);

  bb.write('check:me', true, 'agent');

  const r1 = await tools.call('blackboard_exists', { key: 'check:me', agent_id: 'exec' });
  assert(r1.ok,                           'exists: ok=true');
  assert((r1.data as any).exists === true,'exists: data.exists true for present key');

  const r2 = await tools.call('blackboard_exists', { key: 'no:such', agent_id: 'exec' });
  assert(r2.ok,                            'exists (missing): ok=true');
  assert((r2.data as any).exists === false,'exists: data.exists false for missing key');
}

// ============================================================================
// SECTION 19 — edge cases
// ============================================================================

async function testMCPEdgeCases() {
  header('Section 19 — BlackboardMCPTools edge cases');

  const bb    = makeMockBlackboard();
  const tools = new BlackboardMCPTools(bb);

  // Unknown tool
  const r1 = await tools.call('nonexistent_tool', { agent_id: 'x' });
  assert(!r1.ok, 'unknown tool: ok=false');
  assert(typeof r1.error === 'string', 'unknown tool: error string present');

  // Blackboard without delete
  const bbNoDel: IBlackboard = { ...bb, delete: undefined };
  const toolsNoDel = new BlackboardMCPTools(bbNoDel);
  bb.write('x', 1, 'a'); // seed data so exists() returns true
  const r2 = await toolsNoDel.call('blackboard_delete', { key: 'x', agent_id: 'a' });
  assert(!r2.ok, 'no-delete bb: ok=false');
  assert(typeof r2.error === 'string', 'no-delete bb: error string present');
}

// ============================================================================
// SECTION 20 — registerBlackboardTools factory
// ============================================================================

async function testRegisterBlackboardTools() {
  header('Section 20 — registerBlackboardTools factory');

  const bb = makeMockBlackboard();
  const registered: Record<string, { handler: Function; metadata: unknown }> = {};

  const mcpAdapter = {
    registerTool(name: string, handler: Function, metadata: unknown) {
      registered[name] = { handler, metadata };
    },
  };

  const instance = registerBlackboardTools(mcpAdapter as any, bb);
  assert(instance instanceof BlackboardMCPTools, 'returns BlackboardMCPTools instance');
  assert(Object.keys(registered).length === 5,   'all 5 tools registered on adapter');
  assert('blackboard_read'  in registered, 'blackboard_read registered');
  assert('blackboard_write' in registered, 'blackboard_write registered');

  // Registered handler works
  bb.write('factory:test', 'hello', 'agent');
  const result = await (registered['blackboard_read'].handler as Function)({ key: 'factory:test', agent_id: 'x' });
  assert((result as any).ok === true, 'registered handler returns ok=true');
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('\n' + '='.repeat(64));
  log('  Network-AI Phase 4 — Behavioral Control Plane', 'bold');
  console.log('='.repeat(64));

  try {
    await testWorkflowStates();
    await testToolAuthorizationMatrix();
    await testJourneyFSMInit();
    await testJourneyFSMTransitions();
    await testJourneyFSMAuthorization();
    await testJourneyFSMToolAuth();
    await testJourneyFSMReset();
    await testComplianceMiddleware();
    await testDeliveryPipelineFactory();
    await testComplianceMonitorBasic();
    await testComplianceMonitorSummary();
    await testComplianceMonitorViolations();
    await testMCPToolDefinitions();
    await testMCPWrite();
    await testMCPRead();
    await testMCPList();
    await testMCPDelete();
    await testMCPExists();
    await testMCPEdgeCases();
    await testRegisterBlackboardTools();
  } catch (err) {
    console.error('Unexpected test runner error:', err);
    process.exit(1);
  }

  console.log('\n' + '='.repeat(64));
  log(`  Results: ${passed} passed, ${failed} failed`, failed > 0 ? 'red' : 'green');
  console.log('='.repeat(64) + '\n');
  process.exit(failed > 0 ? 1 : 0);
}

main();
