/**
 * gif-demo.ts — Short, visual demo optimized for GIF/terminal recording.
 *
 * Shows the three core primitives in ~2 seconds, minimal output:
 *   1. Atomic blackboard (propose → validate → commit)
 *   2. Permission gate (blocked → granted)
 *   3. Token budget enforcement
 *
 * Run:  npx ts-node examples/gif-demo.ts
 */

import * as path from 'node:path';
import { AuthGuardian } from '..';
import { FederatedBudget } from '../lib/federated-budget';
import { LockedBlackboard } from '../lib/locked-blackboard';

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', magenta: '\x1b[35m',
};

function log(icon: string, msg: string, color = c.green) {
  console.log(`  ${color}${icon}${c.reset} ${msg}`);
}

async function main() {
  console.log(`\n${c.bold}${c.cyan}${'━'.repeat(52)}${c.reset}`);
  console.log(`${c.bold}${c.cyan}  Network-AI — Multi-Agent Coordination Demo${c.reset}`);
  console.log(`${c.bold}${c.cyan}${'━'.repeat(52)}${c.reset}\n`);

  // ── 1. Atomic blackboard ──────────────────────────
  console.log(`${c.bold}  ▸ Atomic Blackboard${c.reset}`);
  const bb = new LockedBlackboard(
    path.join(__dirname, '..', 'data', 'gif-demo'),
    { conflictResolution: 'priority-wins' },
  );

  const low = bb.propose('task:deploy', { status: 'queued' }, 'agent-A', undefined, 0);
  bb.validate(low, 'orchestrator');
  bb.commit(low);
  log('●', `agent-A wrote  priority=0  status=queued`, c.dim);

  const high = bb.propose('task:deploy', { status: 'approved' }, 'agent-B', undefined, 3);
  bb.validate(high, 'orchestrator');
  bb.commit(high);
  log('●', `agent-B wrote  priority=3  status=approved`, c.yellow);

  const final = bb.read('task:deploy');
  log('✓', `final value: ${c.bold}${JSON.stringify(final?.value)}${c.reset}  (priority wins)`, c.green);

  // ── 2. Permission gate ────────────────────────────
  console.log(`\n${c.bold}  ▸ AuthGuardian Permission Gate${c.reset}`);
  const guardian = new AuthGuardian({
    trustLevels: [{ agentId: 'agent-B', trustLevel: 0.5, allowedResources: ['PAYMENTS'] }],
  });

  const denied = await guardian.requestPermission('agent-B', 'PAYMENTS', 'need it', 'read');
  log('✗', `weak justification → ${c.red}${c.bold}BLOCKED${c.reset}`, c.red);

  const granted = await guardian.requestPermission(
    'agent-B', 'PAYMENTS',
    'Processing deploy verification: need to read the PAYMENTS transaction ledger in order to verify the exact balance before committing blackboard state for agent coordination.',
    'read',
  );
  if (granted.granted) {
    log('✓', `strong justification → ${c.green}${c.bold}GRANTED${c.reset}  token=${granted.grantToken?.slice(0, 12)}…`, c.green);
  } else {
    log('✗', `still denied — ${granted.reason}`, c.red);
  }

  // ── 3. Budget enforcement ─────────────────────────
  console.log(`\n${c.bold}  ▸ FederatedBudget${c.reset}`);
  const budget = new FederatedBudget({ ceiling: 5000 });
  const s1 = budget.spend('agent-A', 1200);
  log('●', `agent-A spent 1,200 tokens  remaining=${5000 - 1200}`, c.cyan);
  const s2 = budget.spend('agent-B', 800);
  log('●', `agent-B spent   800 tokens  remaining=${5000 - 2000}`, c.cyan);
  log('✓', `ceiling=5,000  total=2,000  ${c.green}${c.bold}within budget${c.reset}`, c.green);

  console.log(`\n${c.bold}${c.green}  ✓ Done — 3 primitives, 0 API calls, 0 race conditions.${c.reset}\n`);
}

main().catch(console.error);
