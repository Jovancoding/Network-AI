/**
 * 08-control-plane-stress-demo.ts
 * ───────────────────────────────
 * Control-plane focused demo (no API key required):
 *
 * - LockedBlackboard atomic workflow: propose → validate → commit
 * - Priority preemption with conflictResolution='priority-wins'
 * - AuthGuardian permission gate: blocked → justified → granted
 * - JourneyFSM state governance + timeout detection
 * - ComplianceMonitor real-time violations (tool abuse, turn-taking, response timeout, journey timeout)
 * - FederatedBudget spend enforcement snapshot
 *
 * Run:
 *   npx ts-node examples/08-control-plane-stress-demo.ts
 *
 * Demo video: https://www.youtube.com/watch?v=niVRZJu1MEo
 */

import * as path from 'node:path';
import {
  JourneyFSM,
  WORKFLOW_STATES,
  ComplianceMonitor,
  AuthGuardian,
} from '..';
import { FederatedBudget } from '../lib/federated-budget';
import { LockedBlackboard } from '../lib/locked-blackboard';

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
};

function banner(title: string) {
  const line = '═'.repeat(64);
  console.log(`\n${c.bold}${c.cyan}${line}${c.reset}`);
  console.log(`${c.bold}${c.cyan}  ${title}${c.reset}`);
  console.log(`${c.bold}${c.cyan}${line}${c.reset}\n`);
}

function tag(scope: string, msg: string, color = c.green) {
  console.log(`  ${color}${c.bold}[${scope.padEnd(18)}]${c.reset} ${msg}`);
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

async function main() {
  banner('Network-AI — Control Plane Stress Demo');

  const basePath = path.join(__dirname, '..', 'data', 'demo-08-control-plane');
  const bb = new LockedBlackboard(basePath, { conflictResolution: 'priority-wins' });
  const budget = new FederatedBudget({ ceiling: 5_000 });

  const fsm = new JourneyFSM({
    states: [
      { name: WORKFLOW_STATES.INTAKE, authorizedAgents: ['orchestrator'], description: 'Task intake' },
      { name: WORKFLOW_STATES.EXECUTE, authorizedAgents: ['executor', 'debugger'], description: 'Execution', timeoutMs: 700 },
      { name: WORKFLOW_STATES.REVIEW, authorizedAgents: ['reviewer'], description: 'Review stage' },
      { name: WORKFLOW_STATES.DELIVER, authorizedAgents: ['orchestrator'], description: 'Delivery' },
    ],
    transitions: [
      { from: WORKFLOW_STATES.INTAKE, event: 'start_exec', to: WORKFLOW_STATES.EXECUTE, allowedBy: 'orchestrator' },
      { from: WORKFLOW_STATES.EXECUTE, event: 'exec_done', to: WORKFLOW_STATES.REVIEW, allowedBy: 'executor' },
      { from: WORKFLOW_STATES.REVIEW, event: 'approved', to: WORKFLOW_STATES.DELIVER, allowedBy: 'reviewer' },
    ],
    initialState: WORKFLOW_STATES.INTAKE,
    onTransition: t => tag('FSM', `${t.previousState} → ${t.currentState}`, c.yellow),
  });

  // Track first occurrence per violation type+agent — suppress duplicates for clean output
  const seenViolations = new Map<string, number>();

  const monitor = new ComplianceMonitor({
    pollIntervalMs: 200,
    fsm,
    agentConfigs: [
      { agentId: 'executor', responseTimeoutMs: 500, maxToolCallsPerWindow: 3, toolRateWindowMs: 1000 },
      { agentId: 'debugger', responseTimeoutMs: 500, maxToolCallsPerWindow: 2, toolRateWindowMs: 1000 },
    ],
    onViolation: v => {
      const key = `${v.type}|${v.agentId}`;
      const count = seenViolations.get(key) ?? 0;
      seenViolations.set(key, count + 1);
      if (count === 0) {
        tag('COMPLIANCE', `${v.type} | ${v.agentId} | ${v.message}`, c.red);
      }
    },
  });
  monitor.start();

  banner('Phase 1 — Priority Preemption (LockedBlackboard)');
  const lowChange = bb.propose('task:invoice-42', { status: 'queued', owner: 'agent_low' }, 'agent_low', undefined, 0);
  tag('blackboard', `low priority change proposed: ${lowChange}`, c.dim);
  const lowValid = bb.validate(lowChange, 'orchestrator');
  const lowCommit = lowValid ? bb.commit(lowChange) : { success: false, message: 'validate failed' };
  tag('blackboard', `low change validate=${lowValid} commit=${lowCommit.success}`, lowCommit.success ? c.green : c.red);

  const highChange = bb.propose('task:invoice-42', { status: 'approved', owner: 'agent_high' }, 'agent_high', undefined, 3);
  tag('blackboard', `high priority change proposed: ${highChange}`, c.dim);

  const highValid = bb.validate(highChange, 'orchestrator');
  const highCommit = highValid ? bb.commit(highChange) : { success: false, message: 'validate failed' };
  tag('blackboard', `high change validate=${highValid} commit=${highCommit.success}`, highCommit.success ? c.green : c.red);

  const entry = bb.read('task:invoice-42');
  tag('blackboard', `final value: ${JSON.stringify(entry?.value ?? null)}`, c.magenta);

  banner('Phase 2 — Permission Gate (AuthGuardian)');

  const guardian = new AuthGuardian({
    trustLevels: [
      { agentId: 'executor', trustLevel: 0.5, allowedResources: ['FILESYSTEM', 'PAYMENTS'] },
    ],
  });

  // Attempt 1: weak justification → BLOCKED
  const denied = await guardian.requestPermission('executor', 'PAYMENTS', 'need it', 'read');
  tag('auth', `executor → PAYMENTS: ${denied.granted ? 'GRANTED' : 'BLOCKED'} — "${denied.reason}"`, c.red);

  // Attempt 2: strong justification → GRANTED
  const granted = await guardian.requestPermission(
    'executor', 'PAYMENTS',
    'Processing invoice-42 settlement: need to read the PAYMENTS transaction ledger in order to verify the exact balance before committing blackboard state.',
    'read'
  );
  if (granted.granted) {
    tag('auth', `executor → PAYMENTS: GRANTED (token=${granted.grantToken?.slice(0, 16)}… expires=${granted.expiresAt?.slice(11, 19)} UTC)`, c.green);
    tag('auth', `restrictions: ${JSON.stringify(granted.restrictions)}`, c.dim);
  } else {
    tag('auth', `executor → PAYMENTS: DENIED — ${granted.reason}`, c.red);
  }

  banner('Phase 3 — FSM + Compliance Violations');
  fsm.transition('start_exec', 'orchestrator');

  for (let i = 1; i <= 6; i++) {
    monitor.recordAction({ agentId: 'executor', action: `tool_call_${i}`, tool: 'write_file' });
  }
  tag('executor', 'Recorded 6 rapid write_file calls (tool abuse expected)', c.yellow);

  for (let i = 1; i <= 5; i++) {
    monitor.recordAction({ agentId: 'executor', action: `consecutive_${i}` });
  }
  tag('executor', 'Recorded 5 consecutive actions (turn-taking violation expected)', c.yellow);
  await sleep(300);

  monitor.recordAction({ agentId: 'debugger', action: 'single_action', tool: 'read_file' });
  tag('debugger', 'Waiting to trigger response/journey timeouts...', c.yellow);

  await sleep(1200);

  const spendExec = budget.spend('executor', 1200);
  const spendDbg = budget.spend('debugger', 800);
  tag('budget', `executor spend allowed=${spendExec.allowed}`, spendExec.allowed ? c.green : c.red);
  tag('budget', `debugger spend allowed=${spendDbg.allowed}`, spendDbg.allowed ? c.green : c.red);

  banner('Phase 4 — Summary');
  const summary = monitor.getSummary();
  tag('summary', `violations total=${summary.total}`, c.magenta);
  tag('summary', `byType=${JSON.stringify(summary.byType)}`, c.dim);
  tag('summary', `byAgent=${JSON.stringify(summary.byAgent)}`, c.dim);
  const suppressed = [...seenViolations.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k.split('|')[0]}×${n}`).join(', ');
  if (suppressed) tag('summary', `duplicate violations suppressed: ${suppressed}`, c.dim);

  const keys = bb.listKeys();
  tag('blackboard', `keys=${JSON.stringify(keys)}`, c.dim);
  tag('blackboard', `lockStatus=${JSON.stringify(bb.getLockStatus())}`, c.dim);
  tag('fsm', `currentState=${fsm.state} timedOut=${fsm.isTimedOut} elapsedMs=${fsm.timeInCurrentState}`, c.dim);

  monitor.stop();
  console.log(`\n${c.bold}${c.green}✓ Control-plane stress demo complete.${c.reset}\n`);
}

main().catch(err => {
  console.error(`\n${c.red}Demo failed:${c.reset}`, err?.message ?? err);
  process.exit(1);
});
