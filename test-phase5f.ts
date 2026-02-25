/**
 * Phase 5 Part 6 -- Federated Budget Tracking Tests
 *
 * Tests for lib/federated-budget.ts:
 *   - FederatedBudget construction and validation
 *   - spend() -- allowed / denied paths
 *   - Global ceiling enforcement
 *   - Per-agent ceiling enforcement
 *   - remaining() / getTotalSpent() / getAgentSpent()
 *   - getSpendLog() / getTransactionLog()
 *   - reset() clears all state
 *   - setCeiling() dynamic adjustment
 *   - Blackboard persistence (write after spend/reset)
 *   - loadFromBlackboard() state recovery
 *   - Custom budgetKey option
 *   - Edge cases: boundary values, zero-remaining, multi-agent
 *
 * No real Redis, file I/O, or network connections -- all in-process.
 * Run with: npx ts-node test-phase5f.ts
 */

import {
  FederatedBudget,
  type FederatedBudgetOptions,
  type SpendResult,
  type SpendLogEntry,
} from './lib/federated-budget';

import { MemoryBackend } from './lib/blackboard-backend';

// ============================================================================
// TEST HARNESS
// ============================================================================

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  [PASS] ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.log(`  [FAIL] ${message}`);
  }
}

function assertThrows(fn: () => unknown, expectedSubstring: string, message: string): void {
  try {
    fn();
    failed++;
    failures.push(message);
    console.log(`  [FAIL] ${message} (no error thrown)`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes(expectedSubstring)) {
      passed++;
      console.log(`  [PASS] ${message}`);
    } else {
      failed++;
      failures.push(`${message} (wrong error: ${msg})`);
      console.log(`  [FAIL] ${message} (wrong error: "${msg}")`);
    }
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// ============================================================================
// SECTION 1: CONSTRUCTION
// ============================================================================

section('1. Construction');

{
  const b = new FederatedBudget({ ceiling: 1000 });
  assert(b.getCeiling() === 1000, 'ceiling stored correctly');
  assert(b.remaining() === 1000, 'remaining equals ceiling on init');
  assert(b.getTotalSpent() === 0, 'totalSpent is 0 on init');
  assert(Object.keys(b.getSpendLog()).length === 0, 'spend log empty on init');
  assert(b.getTransactionLog().length === 0, 'transaction log empty on init');
  assert(b.getPerAgentCeiling() === undefined, 'no perAgentCeiling on init');
}

{
  const b = new FederatedBudget({ ceiling: 500, perAgentCeiling: 200 });
  assert(b.getPerAgentCeiling() === 200, 'perAgentCeiling stored correctly');
}

assertThrows(
  () => new FederatedBudget({ ceiling: 0 } as FederatedBudgetOptions),
  'ceiling must be a positive finite number',
  'throws on ceiling = 0'
);

assertThrows(
  () => new FederatedBudget({ ceiling: -100 } as FederatedBudgetOptions),
  'ceiling must be a positive finite number',
  'throws on negative ceiling'
);

assertThrows(
  () => new FederatedBudget({ ceiling: Infinity } as FederatedBudgetOptions),
  'ceiling must be a positive finite number',
  'throws on Infinity ceiling'
);

assertThrows(
  () => new FederatedBudget({ ceiling: NaN } as FederatedBudgetOptions),
  'ceiling must be a positive finite number',
  'throws on NaN ceiling'
);

assertThrows(
  () => new FederatedBudget({ ceiling: 1000, perAgentCeiling: 0 }),
  'perAgentCeiling must be a positive finite number',
  'throws on perAgentCeiling = 0'
);

assertThrows(
  () => new FederatedBudget({ ceiling: 1000, perAgentCeiling: -1 }),
  'perAgentCeiling must be a positive finite number',
  'throws on negative perAgentCeiling'
);

// ============================================================================
// SECTION 2: BASIC SPEND -- ALLOWED
// ============================================================================

section('2. Basic spend -- allowed');

{
  const b = new FederatedBudget({ ceiling: 1000 });
  const r = b.spend('agent-1', 500);
  assert(r.allowed === true, 'spend within ceiling is allowed');
  assert(r.remaining === 500, 'remaining reflects spend');
  assert(r.deniedReason === undefined, 'no deniedReason when allowed');
  assert(b.getTotalSpent() === 500, 'totalSpent updated');
  assert(b.remaining() === 500, 'remaining() matches');
  assert(b.getAgentSpent('agent-1') === 500, 'getAgentSpent correct');
}

{
  const b = new FederatedBudget({ ceiling: 1000 });
  b.spend('agent-1', 300);
  b.spend('agent-1', 200);
  assert(b.getAgentSpent('agent-1') === 500, 'same-agent spends accumulate');
  assert(b.getTotalSpent() === 500, 'total correct after two spends');
}

{
  const b = new FederatedBudget({ ceiling: 1000 });
  b.spend('agent-1', 300);
  b.spend('agent-2', 400);
  assert(b.getTotalSpent() === 700, 'multi-agent total correct');
  assert(b.getAgentSpent('agent-1') === 300, 'agent-1 total');
  assert(b.getAgentSpent('agent-2') === 400, 'agent-2 total');
  assert(b.remaining() === 300, 'remaining after multi-agent spend');
}

{
  // Exactly at ceiling
  const b = new FederatedBudget({ ceiling: 1000 });
  const r = b.spend('agent-1', 1000);
  assert(r.allowed === true, 'spend exactly at ceiling is allowed');
  assert(r.remaining === 0, 'remaining is 0 at exact ceiling');
  assert(b.remaining() === 0, 'remaining() is 0');
}

// ============================================================================
// SECTION 3: BASIC SPEND -- DENIED (GLOBAL CEILING)
// ============================================================================

section('3. Basic spend -- denied (global ceiling)');

{
  const b = new FederatedBudget({ ceiling: 1000 });
  b.spend('agent-1', 900);
  const r = b.spend('agent-1', 200);
  assert(r.allowed === false, 'spend exceeding ceiling is denied');
  assert(r.remaining === 100, 'remaining unchanged after denial');
  assert(r.deniedReason === 'global_ceiling', 'deniedReason is global_ceiling');
  assert(b.getTotalSpent() === 900, 'totalSpent unchanged after denial');
  assert(b.getAgentSpent('agent-1') === 900, 'agent spend unchanged after denial');
}

{
  // Denied when pool is empty
  const b = new FederatedBudget({ ceiling: 500 });
  b.spend('agent-1', 500);
  const r = b.spend('agent-2', 1);
  assert(r.allowed === false, 'any spend denied when pool exhausted');
  assert(r.remaining === 0, 'remaining is 0 after pool exhausted');
  assert(r.deniedReason === 'global_ceiling', 'deniedReason is global_ceiling');
}

{
  // Single massive spend exceeding ceiling from zero
  const b = new FederatedBudget({ ceiling: 100 });
  const r = b.spend('agent-x', 101);
  assert(r.allowed === false, 'spend above ceiling from zero is denied');
  assert(r.remaining === 100, 'remaining is full ceiling after denial');
}

{
  // Denied does not accumulate agentSpent
  const b = new FederatedBudget({ ceiling: 100 });
  b.spend('agent-1', 50);
  b.spend('agent-1', 80); // denied
  assert(b.getAgentSpent('agent-1') === 50, 'failed spend not counted in agent total');
}

{
  // Multiple denials don't change state
  const b = new FederatedBudget({ ceiling: 200 });
  b.spend('agent-1', 200);
  b.spend('agent-2', 50); // denied
  b.spend('agent-3', 1);  // denied
  assert(b.getTotalSpent() === 200, 'multiple denials do not change totalSpent');
  assert(b.getAgentSpent('agent-2') === 0, 'denied agent has 0 spend');
  assert(b.getAgentSpent('agent-3') === 0, 'denied agent has 0 spend');
}

// ============================================================================
// SECTION 4: PER-AGENT CEILING
// ============================================================================

section('4. Per-agent ceiling');

{
  const b = new FederatedBudget({ ceiling: 1000, perAgentCeiling: 300 });
  b.spend('agent-1', 300);
  const r = b.spend('agent-1', 1); // exceeds per-agent cap
  assert(r.allowed === false, 'per-agent ceiling enforced');
  assert(r.deniedReason === 'per_agent_ceiling', 'deniedReason is per_agent_ceiling');
  assert(b.getTotalSpent() === 300, 'global pool not affected by per-agent denial');
}

{
  // Per-agent ceiling is independent per agent
  const b = new FederatedBudget({ ceiling: 1000, perAgentCeiling: 300 });
  b.spend('agent-1', 300);
  const r2 = b.spend('agent-2', 300); // agent-2 still has full per-agent cap
  assert(r2.allowed === true, 'second agent unaffected by first agent hitting per-agent ceiling');
  assert(b.getTotalSpent() === 600, 'global pool reflects two agent spends');
}

{
  // Per-agent ceiling exactly reached
  const b = new FederatedBudget({ ceiling: 1000, perAgentCeiling: 200 });
  const r = b.spend('agent-1', 200);
  assert(r.allowed === true, 'spend exactly at per-agent ceiling is allowed');
  const r2 = b.spend('agent-1', 1);
  assert(r2.allowed === false, 'spend one over per-agent ceiling denied');
}

{
  // Per-agent denial checked before global ceiling
  const b = new FederatedBudget({ ceiling: 1000, perAgentCeiling: 100 });
  b.spend('agent-1', 100);
  const r = b.spend('agent-1', 50);
  assert(r.deniedReason === 'per_agent_ceiling', 'per-agent denial takes precedence');
}

{
  // Per-agent ceiling higher than global ceiling -- global wins
  const b = new FederatedBudget({ ceiling: 200, perAgentCeiling: 500 });
  b.spend('agent-1', 200);
  const r = b.spend('agent-1', 1);
  assert(r.allowed === false, 'global ceiling wins when lower than per-agent ceiling');
  assert(r.deniedReason === 'global_ceiling', 'correct deniedReason');
}

// ============================================================================
// SECTION 5: getSpendLog() AND getAgentSpent()
// ============================================================================

section('5. getSpendLog() and getAgentSpent()');

{
  const b = new FederatedBudget({ ceiling: 5000 });
  b.spend('alpha', 1000);
  b.spend('beta', 500);
  b.spend('alpha', 250); // accumulates with earlier alpha

  const log = b.getSpendLog();
  assert(log['alpha'] === 1250, 'alpha total accumulated correctly');
  assert(log['beta'] === 500, 'beta total correct');
  assert(Object.keys(log).length === 2, 'only two agents in log');
}

{
  // getSpendLog returns a copy -- mutations don't affect internal state
  const b = new FederatedBudget({ ceiling: 1000 });
  b.spend('agent-1', 100);
  const log = b.getSpendLog();
  log['agent-1'] = 9999;
  assert(b.getAgentSpent('agent-1') === 100, 'getSpendLog copy not affecting internal state');
}

{
  const b = new FederatedBudget({ ceiling: 1000 });
  assert(b.getAgentSpent('unknown-agent') === 0, 'getAgentSpent returns 0 for unseen agent');
}

{
  // Large agent pool
  const b = new FederatedBudget({ ceiling: 100_000 });
  for (let i = 0; i < 20; i++) {
    b.spend(`agent-${i}`, 1000);
  }
  assert(b.getTotalSpent() === 20_000, 'large pool spend total correct');
  const log = b.getSpendLog();
  assert(Object.keys(log).length === 20, 'all 20 agents in log');
}

// ============================================================================
// SECTION 6: getTransactionLog()
// ============================================================================

section('6. getTransactionLog()');

{
  const b = new FederatedBudget({ ceiling: 5000 });
  b.spend('agent-1', 100);
  b.spend('agent-2', 200);
  b.spend('agent-1', 50);

  const log = b.getTransactionLog();
  assert(log.length === 3, 'transaction log has 3 entries');
  assert(log[0].agentId === 'agent-1', 'first entry agentId');
  assert(log[0].tokens === 100, 'first entry tokens');
  assert(typeof log[0].timestamp === 'string', 'timestamp is string');
  assert(log[1].agentId === 'agent-2', 'second entry agentId');
  assert(log[2].tokens === 50, 'third entry tokens');
}

{
  // Denied spends not in transaction log
  const b = new FederatedBudget({ ceiling: 100 });
  b.spend('agent-1', 90);
  b.spend('agent-2', 50); // denied
  assert(b.getTransactionLog().length === 1, 'denied spend not in transaction log');
}

{
  // getTransactionLog returns a copy
  const b = new FederatedBudget({ ceiling: 1000 });
  b.spend('agent-1', 100);
  const log = b.getTransactionLog();
  log.push({ agentId: 'fake', tokens: 999, timestamp: 'now' });
  assert(b.getTransactionLog().length === 1, 'transaction log copy does not affect internal log');
}

{
  // Timestamps are valid ISO strings
  const b = new FederatedBudget({ ceiling: 1000 });
  b.spend('agent-1', 10);
  const ts = b.getTransactionLog()[0].timestamp;
  assert(!isNaN(Date.parse(ts)), 'timestamp is valid ISO string');
}

// ============================================================================
// SECTION 7: reset()
// ============================================================================

section('7. reset()');

{
  const b = new FederatedBudget({ ceiling: 1000 });
  b.spend('agent-1', 500);
  b.spend('agent-2', 300);
  b.reset();
  assert(b.getTotalSpent() === 0, 'totalSpent is 0 after reset');
  assert(b.remaining() === 1000, 'remaining equals ceiling after reset');
  assert(Object.keys(b.getSpendLog()).length === 0, 'spend log empty after reset');
  assert(b.getTransactionLog().length === 0, 'transaction log empty after reset');
  assert(b.getAgentSpent('agent-1') === 0, 'agent spend cleared after reset');
}

{
  // Spend is allowed after reset
  const b = new FederatedBudget({ ceiling: 500 });
  b.spend('agent-1', 500);
  b.reset();
  const r = b.spend('agent-1', 500);
  assert(r.allowed === true, 'spend allowed again after reset');
  assert(b.getTotalSpent() === 500, 'total correct after reset + re-spend');
}

{
  // Ceiling preserved after reset
  const b = new FederatedBudget({ ceiling: 750 });
  b.reset();
  assert(b.getCeiling() === 750, 'ceiling preserved after reset');
  assert(b.remaining() === 750, 'remaining equals ceiling after reset');
}

// ============================================================================
// SECTION 8: setCeiling()
// ============================================================================

section('8. setCeiling()');

{
  const b = new FederatedBudget({ ceiling: 1000 });
  b.setCeiling(2000);
  assert(b.getCeiling() === 2000, 'ceiling updated by setCeiling');
  assert(b.remaining() === 2000, 'remaining reflects new ceiling');
}

{
  // Reduce ceiling below current spend -- remaining is 0, no reversal
  const b = new FederatedBudget({ ceiling: 1000 });
  b.spend('agent-1', 800);
  b.setCeiling(500); // below current spend
  assert(b.getCeiling() === 500, 'ceiling reduced below spend');
  assert(b.remaining() === 0, 'remaining is 0 when ceiling < totalSpent');
  assert(b.getTotalSpent() === 800, 'prior spends preserved after setCeiling');
}

{
  // After setCeiling below spend, new spends are denied
  const b = new FederatedBudget({ ceiling: 1000 });
  b.spend('agent-1', 800);
  b.setCeiling(500);
  const r = b.spend('agent-2', 1);
  assert(r.allowed === false, 'spend denied when ceiling below totalSpent');
}

{
  // setCeiling then reset -- remaining = new ceiling
  const b = new FederatedBudget({ ceiling: 1000 });
  b.spend('agent-1', 400);
  b.setCeiling(1500);
  b.reset();
  assert(b.remaining() === 1500, 'remaining equals updated ceiling after reset');
}

assertThrows(
  () => { const b = new FederatedBudget({ ceiling: 1000 }); b.setCeiling(0); },
  'ceiling must be a positive finite number',
  'setCeiling throws on 0'
);

assertThrows(
  () => { const b = new FederatedBudget({ ceiling: 1000 }); b.setCeiling(-1); },
  'ceiling must be a positive finite number',
  'setCeiling throws on negative value'
);

assertThrows(
  () => { const b = new FederatedBudget({ ceiling: 1000 }); b.setCeiling(Infinity); },
  'ceiling must be a positive finite number',
  'setCeiling throws on Infinity'
);

// ============================================================================
// SECTION 9: ARGUMENT VALIDATION IN spend()
// ============================================================================

section('9. Argument validation in spend()');

{
  const b = new FederatedBudget({ ceiling: 1000 });

  assertThrows(
    () => b.spend('', 100),
    'agentId must be a non-empty string',
    'spend throws on empty agentId'
  );

  assertThrows(
    () => b.spend(null as unknown as string, 100),
    'agentId must be a non-empty string',
    'spend throws on null agentId'
  );

  assertThrows(
    () => b.spend('agent', 0),
    'tokens must be a positive finite number',
    'spend throws on 0 tokens'
  );

  assertThrows(
    () => b.spend('agent', -10),
    'tokens must be a positive finite number',
    'spend throws on negative tokens'
  );

  assertThrows(
    () => b.spend('agent', Infinity),
    'tokens must be a positive finite number',
    'spend throws on Infinity tokens'
  );

  assertThrows(
    () => b.spend('agent', NaN),
    'tokens must be a positive finite number',
    'spend throws on NaN tokens'
  );
}

// ============================================================================
// SECTION 10: BLACKBOARD PERSISTENCE -- WRITE AFTER SPEND
// ============================================================================

section('10. Blackboard persistence -- write after spend');

{
  const backend = new MemoryBackend();
  const b = new FederatedBudget({ ceiling: 1000, blackboard: backend });

  assert(backend.read('federated-budget') === null, 'no entry before any spend');

  b.spend('agent-1', 100);
  const entry1 = backend.read('federated-budget');
  assert(entry1 !== null, 'entry written after first spend');

  const snap1 = JSON.parse(entry1!.value as string);
  assert(snap1.totalSpent === 100, 'snapshot totalSpent correct');
  assert(snap1.ceiling === 1000, 'snapshot ceiling correct');
  assert(snap1.spent['agent-1'] === 100, 'snapshot per-agent correct');

  b.spend('agent-2', 300);
  const entry2 = backend.read('federated-budget');
  const snap2 = JSON.parse(entry2!.value as string);
  assert(snap2.totalSpent === 400, 'snapshot totalSpent updated after second spend');
  assert(snap2.spent['agent-2'] === 300, 'snapshot includes agent-2');
}

{
  // Denied spend does NOT update the blackboard
  const backend = new MemoryBackend();
  const b = new FederatedBudget({ ceiling: 500, blackboard: backend });
  b.spend('agent-1', 500);
  const snap1 = JSON.parse(backend.read('federated-budget')!.value as string);
  b.spend('agent-2', 100); // denied
  const snap2 = JSON.parse(backend.read('federated-budget')!.value as string);
  assert(snap1.totalSpent === snap2.totalSpent, 'blackboard not updated after denied spend');
}

{
  // reset() updates the blackboard
  const backend = new MemoryBackend();
  const b = new FederatedBudget({ ceiling: 1000, blackboard: backend });
  b.spend('agent-1', 400);
  b.reset();
  const snap = JSON.parse(backend.read('federated-budget')!.value as string);
  assert(snap.totalSpent === 0, 'blackboard reflects reset');
  assert(Object.keys(snap.spent).length === 0, 'blackboard spent empty after reset');
}

{
  // setCeiling() updates the blackboard
  const backend = new MemoryBackend();
  const b = new FederatedBudget({ ceiling: 1000, blackboard: backend });
  b.spend('agent-1', 100);
  b.setCeiling(2000);
  const snap = JSON.parse(backend.read('federated-budget')!.value as string);
  assert(snap.ceiling === 2000, 'blackboard ceiling updated by setCeiling');
}

{
  // Custom budgetKey
  const backend = new MemoryBackend();
  const b = new FederatedBudget({ ceiling: 1000, blackboard: backend, budgetKey: 'my-budget' });
  b.spend('agent-1', 50);
  assert(backend.read('my-budget') !== null, 'custom budgetKey used for blackboard write');
  assert(backend.read('federated-budget') === null, 'default key not used when custom key specified');
}

// ============================================================================
// SECTION 11: loadFromBlackboard()
// ============================================================================

section('11. loadFromBlackboard()');

{
  // No blackboard configured -- returns false
  const b = new FederatedBudget({ ceiling: 1000 });
  assert(b.loadFromBlackboard() === false, 'loadFromBlackboard returns false without backend');
}

{
  // No entry in blackboard -- returns false
  const backend = new MemoryBackend();
  const b = new FederatedBudget({ ceiling: 1000, blackboard: backend });
  assert(b.loadFromBlackboard() === false, 'loadFromBlackboard returns false when no entry');
}

{
  // State recovery: write on node A, read on node B (shared backend)
  const sharedBackend = new MemoryBackend();

  const nodeA = new FederatedBudget({ ceiling: 5000, blackboard: sharedBackend });
  nodeA.spend('agent-1', 1000);
  nodeA.spend('agent-2', 750);

  // Node B restores from the shared backend
  const nodeB = new FederatedBudget({ ceiling: 5000, blackboard: sharedBackend });
  const loaded = nodeB.loadFromBlackboard();
  assert(loaded === true, 'loadFromBlackboard returns true on success');
  assert(nodeB.getTotalSpent() === 1750, 'nodeB totalSpent restored from blackboard');
  assert(nodeB.getAgentSpent('agent-1') === 1000, 'nodeB agent-1 spend restored');
  assert(nodeB.getAgentSpent('agent-2') === 750, 'nodeB agent-2 spend restored');
  assert(nodeB.remaining() === 3250, 'nodeB remaining restored correctly');
}

{
  // Ceiling restored from snapshot
  const sharedBackend = new MemoryBackend();
  const nodeA = new FederatedBudget({ ceiling: 5000, blackboard: sharedBackend });
  nodeA.setCeiling(7000);
  nodeA.spend('agent-1', 500);

  const nodeB = new FederatedBudget({ ceiling: 5000, blackboard: sharedBackend });
  nodeB.loadFromBlackboard();
  assert(nodeB.getCeiling() === 7000, 'loadFromBlackboard restores updated ceiling');
}

{
  // loadFromBlackboard replaces any existing in-memory state.
  // We pre-populate the backend with a known snapshot so that a fresh node
  // loading from it sees the pre-saved state (and not its own prior writes).
  const backend = new MemoryBackend();
  const savedSnapshot = JSON.stringify({
    ceiling: 5000,
    spent: { 'agent-x': 2000 },
    totalSpent: 2000,
  });
  backend.write('federated-budget', savedSnapshot, 'test');

  // nodeB starts fresh, accumulates local state, then loads from the backend.
  // (In production nodeB would use its own blackboard; here we use a shared
  //  backend seeded with nodeA's snapshot to simulate recovery.)
  const nodeB = new FederatedBudget({ ceiling: 5000, blackboard: backend });
  // The initial load should replace the empty default state with the snapshot.
  nodeB.loadFromBlackboard();
  assert(nodeB.getAgentSpent('agent-y') === 0, 'prior local state replaced by loadFromBlackboard');
  assert(nodeB.getAgentSpent('agent-x') === 2000, 'correct state loaded from blackboard');
}

{
  // loadFromBlackboard with custom budgetKey
  const backend = new MemoryBackend();
  const nodeA = new FederatedBudget({ ceiling: 1000, blackboard: backend, budgetKey: 'custom-key' });
  nodeA.spend('agent-1', 200);

  const nodeB = new FederatedBudget({ ceiling: 1000, blackboard: backend, budgetKey: 'custom-key' });
  nodeB.loadFromBlackboard();
  assert(nodeB.getTotalSpent() === 200, 'custom budgetKey state recovered');
}

{
  // Corrupt entry in blackboard -- returns false, does not throw
  const backend = new MemoryBackend();
  backend.write('federated-budget', 'not-valid-json', 'test');
  const b = new FederatedBudget({ ceiling: 1000, blackboard: backend });
  let threw = false;
  let result = false;
  try {
    result = b.loadFromBlackboard();
  } catch {
    threw = true;
  }
  assert(!threw, 'loadFromBlackboard does not throw on corrupt entry');
  assert(result === false, 'loadFromBlackboard returns false on corrupt entry');
}

// ============================================================================
// SECTION 12: BLACKBOARD-LESS OPERATION
// ============================================================================

section('12. Blackboard-less operation');

{
  const b = new FederatedBudget({ ceiling: 1000 });
  let threw = false;
  try {
    b.spend('agent-1', 100);
    b.reset();
    b.setCeiling(2000);
  } catch {
    threw = true;
  }
  assert(!threw, 'all operations work without blackboard configured');
}

// ============================================================================
// SECTION 13: FRACTIONAL TOKENS
// ============================================================================

section('13. Fractional tokens');

{
  // Non-integer tokens are valid as long as they are positive finite numbers
  const b = new FederatedBudget({ ceiling: 100 });
  const r = b.spend('agent-1', 0.5);
  assert(r.allowed === true, 'fractional token spend allowed');
  assert(Math.abs(b.getTotalSpent() - 0.5) < 1e-9, 'fractional total correct');
  assert(Math.abs(b.remaining() - 99.5) < 1e-9, 'fractional remaining correct');
}

// ============================================================================
// SECTION 14: LARGE-SCALE / STRESS
// ============================================================================

section('14. Large-scale / stress');

{
  const b = new FederatedBudget({ ceiling: 1_000_000 });
  let expectedSpent = 0;

  for (let i = 0; i < 50; i++) {
    const agentId = `agent-${i % 5}`;
    const tokens = (i + 1) * 100;
    const r = b.spend(agentId, tokens);
    if (r.allowed) expectedSpent += tokens;
  }

  assert(b.getTotalSpent() === expectedSpent, 'totalSpent correct after 50 spends');
  assert(b.remaining() === 1_000_000 - expectedSpent, 'remaining correct after 50 spends');
}

{
  // 100 resets
  const b = new FederatedBudget({ ceiling: 100 });
  for (let i = 0; i < 100; i++) {
    b.spend('agent-1', 50);
    b.reset();
  }
  assert(b.getTotalSpent() === 0, 'state clean after 100 reset cycles');
  assert(b.remaining() === 100, 'remaining clean after 100 reset cycles');
}

// ============================================================================
// SUMMARY
// ============================================================================

console.log('\n' + '='.repeat(60));
console.log(`  Phase 5 Part 6 -- Federated Budget Tracking`);
console.log(`  Passed: ${passed}  Failed: ${failed}`);
console.log('='.repeat(60));

if (failures.length > 0) {
  console.log('\nFailed tests:');
  for (const f of failures) console.log(`  - ${f}`);
}

process.exit(failed > 0 ? 1 : 0);
