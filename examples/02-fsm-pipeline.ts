/**
 * 02-fsm-pipeline.ts
 * ──────────────────
 * Demonstrates `JourneyFSM` — network-ai's Finite State Machine governance
 * layer that controls which agents can act (and which tools they can use)
 * depending on the current workflow state.
 *
 * You'll see:
 *   ✅ Successful state transitions
 *   🚫 A blocked action (wrong agent for current state)
 *   🔒 A blocked tool (agent not authorized for that tool in this state)
 *   📋 Full transition history at the end
 *
 * No API key needed.
 *
 * Run:
 *   npx ts-node examples/02-fsm-pipeline.ts
 */

import {
  JourneyFSM,
  WORKFLOW_STATES,
  type ComplianceCheckResult,
  type TransitionResult,
} from '..';

// ─── ANSI helpers ─────────────────────────────────────────────────────────────
const c = {
  reset  : '\x1b[0m',
  bold   : '\x1b[1m',
  cyan   : '\x1b[36m',
  green  : '\x1b[32m',
  red    : '\x1b[31m',
  yellow : '\x1b[33m',
  blue   : '\x1b[34m',
  dim    : '\x1b[2m',
};
const banner = (msg: string) =>
  console.log(`\n${c.bold}${c.cyan}---  ${msg}  ---${c.reset}`);
const ok     = (msg: string) => console.log(`  ${c.green}[OK]${c.reset} ${msg}`);
const fail   = (msg: string) => console.log(`  ${c.red}[NO]${c.reset} ${msg}`);
const info   = (msg: string) => console.log(`  ${c.dim}${msg}${c.reset}`);

// ─── Helper: pretty-print a compliance result ─────────────────────────────────
function showCompliance(label: string, result: ComplianceCheckResult) {
  if (result.allowed) {
    ok(`  ${label}: ${c.green}ALLOWED${c.reset} in state [${result.currentState}]`);
  } else {
    fail(`  ${label}: ${c.red}BLOCKED${c.reset} - ${result.reason}`);
  }
}

// ─── Helper: pretty-print a transition result ─────────────────────────────────
function showTransition(event: string, result: TransitionResult) {
  if (result.success) {
    ok(`  "${event}": ${c.blue}${result.previousState}${c.reset} -> ${c.bold}${c.blue}${result.currentState}${c.reset}`);
  } else {
    fail(`  "${event}" blocked - ${result.reason}`);
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  banner('network-ai - FSM Governance Pipeline');

  // ─── Build the FSM ──────────────────────────────────────────────────────────
  //
  // Pipeline stages:
  //   INTAKE → VALIDATE → RESEARCH → EXECUTE → DELIVER → COMPLETE
  //
  // Each state declares:
  //   • which agents are authorized to act
  //   • which tools those agents may use
  //
  const fsm = new JourneyFSM({
    states: [
      {
        name: WORKFLOW_STATES.INTAKE,
        description: 'Initial intake and triage',
        authorizedAgents: ['orchestrator'],
        authorizedTools: {
          orchestrator: ['read_intake', 'triage_task'],
        },
      },
      {
        name: WORKFLOW_STATES.VALIDATE,
        description: 'Validate inputs and permissions',
        authorizedAgents: ['orchestrator', 'validator'],
        authorizedTools: {
          orchestrator: ['check_schema'],
          validator   : ['run_validation', 'check_schema'],
        },
      },
      {
        name: WORKFLOW_STATES.RESEARCH,
        description: 'Gather information',
        authorizedAgents: ['data_analyst', 'researcher'],
        authorizedTools: {
          data_analyst: ['query_db', 'search_web', 'read_blackboard'],
          researcher  : ['search_web', 'read_blackboard'],
        },
        timeoutMs: 60_000, // 60 second timeout
      },
      {
        name: WORKFLOW_STATES.EXECUTE,
        description: 'Execute the main task',
        authorizedAgents: ['executor', 'code_writer'],
        authorizedTools: {
          executor   : ['write_file', 'run_build'],
          code_writer: ['write_file', 'read_file'],
          '*'        : ['read_blackboard'],
        },
      },
      {
        name: WORKFLOW_STATES.DELIVER,
        description: 'Produce and write final output',
        authorizedAgents: ['reporter', 'orchestrator'],
        authorizedTools: {
          reporter    : ['write_report', 'write_blackboard'],
          orchestrator: ['write_blackboard', 'notify'],
        },
      },
      {
        name: WORKFLOW_STATES.COMPLETE,
        description: 'Workflow complete',
        authorizedAgents: ['*'],
        authorizedTools: { '*': ['read_blackboard'] },
      },
    ],

    transitions: [
      { from: WORKFLOW_STATES.INTAKE,    event: 'intake_done',   to: WORKFLOW_STATES.VALIDATE, allowedBy: 'orchestrator' },
      { from: WORKFLOW_STATES.VALIDATE,  event: 'valid',         to: WORKFLOW_STATES.RESEARCH,  allowedBy: 'orchestrator' },
      { from: WORKFLOW_STATES.VALIDATE,  event: 'invalid',       to: WORKFLOW_STATES.ERROR,     allowedBy: '*' },
      { from: WORKFLOW_STATES.RESEARCH,  event: 'research_done', to: WORKFLOW_STATES.EXECUTE,   allowedBy: 'data_analyst' },
      { from: WORKFLOW_STATES.EXECUTE,   event: 'exec_done',     to: WORKFLOW_STATES.DELIVER,   allowedBy: 'executor' },
      { from: WORKFLOW_STATES.DELIVER,   event: 'delivered',     to: WORKFLOW_STATES.COMPLETE,  allowedBy: '*' },
    ],

    initialState: WORKFLOW_STATES.INTAKE,

    // Called on every successful transition
    onTransition: (result) => {
      info(`     [FSM] ${result.previousState} -> ${result.currentState}`);
    },

    // Called when a compliance check fails
    onViolation: (result) => {
      info(`     [FSM] Violation: ${result.reason}`);
    },
  });

  // ─── PHASE 1: Compliance checks in INTAKE state ──────────────────────────────
  banner(`Current state: ${fsm.state}`);
  info(`Authorized agents: [${fsm.stateDefinition.authorizedAgents.join(', ')}]`);
  console.log();

  showCompliance(
    'orchestrator can act              ',
    fsm.checkCompliance('orchestrator'),
  );
  showCompliance(
    'orchestrator uses read_intake     ',
    fsm.checkCompliance('orchestrator', 'read_intake'),
  );
  showCompliance(
    'data_analyst (wrong state) can act',
    fsm.checkCompliance('data_analyst'),
  );
  showCompliance(
    'orchestrator uses query_db (wrong)',
    fsm.checkCompliance('orchestrator', 'query_db'),
  );

  // ─── PHASE 2: Transition INTAKE → VALIDATE ────────────────────────────────┐
  banner('Transitions');

  showTransition('intake_done', fsm.transition('intake_done', 'orchestrator'));
  info(`  Now in: ${c.bold}${fsm.state}${c.reset}`);

  showTransition('valid', fsm.transition('valid', 'orchestrator'));
  info(`  Now in: ${c.bold}${fsm.state}${c.reset}`);  // RESEARCH

  // Wrong agent trying to move out of RESEARCH (should fail)
  showTransition(
    'research_done by orchestrator (blocked)',
    fsm.transition('research_done', 'orchestrator'), // only data_analyst allowed
  );

  // Correct agent
  showTransition('research_done', fsm.transition('research_done', 'data_analyst'));
  info(`  Now in: ${c.bold}${fsm.state}${c.reset}`);  // EXECUTE

  // ─── PHASE 3: Tool checks in EXECUTE state ───────────────────────────────────
  banner(`Tool Checks in state: ${fsm.state}`);

  showCompliance(
    'executor uses write_file     ',
    fsm.checkCompliance('executor', 'write_file'),
  );
  showCompliance(
    'executor uses run_build      ',
    fsm.checkCompliance('executor', 'run_build'),
  );
  showCompliance(
    'code_writer uses read_file   ',
    fsm.checkCompliance('code_writer', 'read_file'),
  );
  showCompliance(
    'anyone reads blackboard (*)  ',
    fsm.checkCompliance('random_agent', 'read_blackboard'),
  );
  showCompliance(
    'reporter (wrong state)       ',
    fsm.checkCompliance('reporter', 'write_report'),
  );

  // ─── PHASE 4: Finish the pipeline ────────────────────────────────────────────
  banner('Finish Pipeline');
  showTransition('exec_done',  fsm.transition('exec_done',  'executor'));
  showTransition('delivered',  fsm.transition('delivered',  'reporter'));
  info(`  Final state: ${c.bold}${c.green}${fsm.state}${c.reset}`);

  // ─── PHASE 5: Transition history ─────────────────────────────────────────────
  banner('Transition History');
  const history = fsm.transitionHistory;
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    const duration = h.exitedAt
      ? `${h.exitedAt - h.enteredAt} ms`
      : '(current)';
    info(`  ${String(i + 1).padStart(2)}. ${c.blue}${h.state.padEnd(10)}${c.reset}  ` +
      `entered ${new Date(h.enteredAt).toISOString().slice(11, 23)}  ` +
      `${duration}`);
  }

  console.log(`\n${c.dim}Done.${c.reset}\n`);
}

main().catch(err => {
  console.error('\n[ERROR]', err.message);
  process.exit(1);
});
