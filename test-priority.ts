/**
 * Phase 3: Priority & Preemption Test Suite
 * 
 * Tests priority-based conflict resolution in LockedBlackboard.
 * 
 * Run with: npx ts-node test-priority.ts
 */

import { LockedBlackboard } from './lib/locked-blackboard';
import type { ConflictResolutionStrategy, AgentPriority } from './lib/locked-blackboard';
import { join } from 'path';
import { existsSync, rmSync, mkdirSync } from 'fs';

// ============================================================================
// TEST UTILITIES
// ============================================================================

const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
};

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ${colors.green}[v]${colors.reset} ${message}`);
    passed++;
  } else {
    console.log(`  ${colors.red}[x]${colors.reset} ${message}`);
    failed++;
  }
}

function section(title: string): void {
  console.log(`\n${colors.cyan}${colors.bold}> ${title}${colors.reset}`);
}

function cleanup(testDir: string): void {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
  mkdirSync(testDir, { recursive: true });
}

// ============================================================================
// TEST 1: DEFAULT first-commit-wins BEHAVIOR (REGRESSION)
// ============================================================================

function testFirstCommitWinsDefault(): void {
  section('1. Default first-commit-wins behavior (regression)');

  const testDir = join(process.cwd(), 'data', 'test-priority-fcw');
  cleanup(testDir);

  const board = new LockedBlackboard(testDir);

  // Verify default strategy
  assert(board.getConflictResolution() === 'first-commit-wins', 'Default strategy is first-commit-wins');

  // Basic propose/validate/commit works
  const id1 = board.propose('task:alpha', { status: 'running' }, 'agent-1');
  assert(typeof id1 === 'string' && id1.startsWith('chg_'), 'propose() returns change ID');

  const valid = board.validate(id1, 'orchestrator');
  assert(valid === true, 'validate() returns true for non-conflicting change');

  const result = board.commit(id1);
  assert(result.success === true, 'commit() succeeds for validated change');
  assert(result.entry?.version === 1, 'First commit is version 1');

  // Verify data is written
  const entry = board.read('task:alpha');
  assert(entry !== null, 'read() returns committed entry');
  assert((entry?.value as any)?.status === 'running', 'Value matches what was proposed');

  // Conflict detection: propose two changes to same key
  const id2 = board.propose('task:alpha', { status: 'done' }, 'agent-2');
  const id3 = board.propose('task:alpha', { status: 'failed' }, 'agent-3');

  // First one validates fine
  const valid2 = board.validate(id2, 'orchestrator');
  assert(valid2 === true, 'First of two conflicting proposals validates');

  // Commit first one
  const result2 = board.commit(id2);
  assert(result2.success === true, 'First conflicting commit succeeds');

  // Second one should fail validation (key was modified)
  const valid3 = board.validate(id3, 'orchestrator');
  assert(valid3 === false, 'Second conflicting proposal fails validation (first-commit-wins)');

  // Cleanup
  board.abort(id3);

  cleanup(testDir);
}

// ============================================================================
// TEST 2: PRIORITY FIELD ON PROPOSE
// ============================================================================

function testPriorityOnPropose(): void {
  section('2. Priority field on propose()');

  const testDir = join(process.cwd(), 'data', 'test-priority-propose');
  cleanup(testDir);

  const board = new LockedBlackboard(testDir);

  // Default priority is 0
  const id1 = board.propose('key:a', 'value1', 'agent-1');
  const pending1 = board.listPendingChanges().find(c => c.change_id === id1);
  assert(pending1?.priority === 0, 'Default priority is 0');

  // Explicit priority
  const id2 = board.propose('key:b', 'value2', 'agent-2', undefined, 2);
  const pending2 = board.listPendingChanges().find(c => c.change_id === id2);
  assert(pending2?.priority === 2, 'Explicit priority 2 is stored');

  // Max priority
  const id3 = board.propose('key:c', 'value3', 'agent-3', undefined, 3);
  const pending3 = board.listPendingChanges().find(c => c.change_id === id3);
  assert(pending3?.priority === 3, 'Critical priority 3 is stored');

  // Priority clamping: negative becomes 0
  const id4 = board.propose('key:d', 'value4', 'agent-4', undefined, -1 as any);
  const pending4 = board.listPendingChanges().find(c => c.change_id === id4);
  assert(pending4?.priority === 0, 'Negative priority is clamped to 0');

  // Priority clamping: >3 becomes 3
  const id5 = board.propose('key:e', 'value5', 'agent-5', undefined, 99 as any);
  const pending5 = board.listPendingChanges().find(c => c.change_id === id5);
  assert(pending5?.priority === 3, 'Priority > 3 is clamped to 3');

  // Non-integer becomes 0
  const id6 = board.propose('key:f', 'value6', 'agent-6', undefined, 1.5 as any);
  const pending6 = board.listPendingChanges().find(c => c.change_id === id6);
  assert(pending6?.priority === 0, 'Non-integer priority defaults to 0');

  // undefined/null becomes 0
  const id7 = board.propose('key:g', 'value7', 'agent-7', undefined, undefined);
  const pending7 = board.listPendingChanges().find(c => c.change_id === id7);
  assert(pending7?.priority === 0, 'undefined priority defaults to 0');

  cleanup(testDir);
}

// ============================================================================
// TEST 3: PRIORITY-WINS BASIC PREEMPTION
// ============================================================================

function testPriorityWinsBasic(): void {
  section('3. Priority-wins: high-priority preempts low-priority');

  const testDir = join(process.cwd(), 'data', 'test-priority-wins');
  cleanup(testDir);

  const board = new LockedBlackboard(testDir, { conflictResolution: 'priority-wins' });

  assert(board.getConflictResolution() === 'priority-wins', 'Strategy is priority-wins');

  // Both agents propose BEFORE either commits (creates true conflict)
  const idLow = board.propose('shared:resource', { owner: 'worker' }, 'worker-agent', undefined, 1);
  const idHigh = board.propose('shared:resource', { owner: 'supervisor' }, 'supervisor-agent', undefined, 3);

  // Low-priority validates and commits first
  const validLow = board.validate(idLow, 'orchestrator');
  assert(validLow === true, 'Low-priority change validates first');
  const commitLow = board.commit(idLow);
  assert(commitLow.success === true, 'Low-priority change commits first');

  // High-priority validates — has stale hash, but priority-wins should resolve it
  const validHigh = board.validate(idHigh, 'orchestrator');
  assert(validHigh === true, 'High-priority validates despite conflict (preempts committed)');

  // High-priority commits
  const commitHigh = board.commit(idHigh);
  assert(commitHigh.success === true, 'High-priority change commits successfully');

  // Verify final value
  const entry = board.read('shared:resource');
  assert((entry?.value as any)?.owner === 'supervisor', 'Final value is from high-priority agent');

  cleanup(testDir);
}

// ============================================================================
// TEST 4: PRIORITY-WINS SAME PRIORITY FALLS BACK TO FIRST-COMMIT-WINS
// ============================================================================

function testPriorityWinsSamePriority(): void {
  section('4. Priority-wins: same priority falls back to first-commit-wins');

  const testDir = join(process.cwd(), 'data', 'test-priority-same');
  cleanup(testDir);

  const board = new LockedBlackboard(testDir, { conflictResolution: 'priority-wins' });

  // Both agents propose BEFORE either commits (same priority = 2)
  const idA = board.propose('counter', 1, 'agent-a', undefined, 2);
  const idB = board.propose('counter', 2, 'agent-b', undefined, 2);

  // A validates and commits first
  board.validate(idA, 'orchestrator');
  const commitA = board.commit(idA);
  assert(commitA.success === true, 'Agent A commits first');

  // B tries to validate — has stale hash, same priority → should fail
  const validB = board.validate(idB, 'orchestrator');
  assert(validB === false, 'Same-priority conflicting change fails validation (first-commit-wins fallback)');

  cleanup(testDir);
}

// ============================================================================
// TEST 5: NO CONFLICT ON DIFFERENT KEYS
// ============================================================================

function testNoConflictDifferentKeys(): void {
  section('5. No conflict on different keys (both strategies)');

  // Test with first-commit-wins
  const testDir1 = join(process.cwd(), 'data', 'test-priority-noconflict1');
  cleanup(testDir1);

  const board1 = new LockedBlackboard(testDir1);

  const id1 = board1.propose('key:alpha', 'val1', 'agent-1', undefined, 1);
  const id2 = board1.propose('key:beta', 'val2', 'agent-2', undefined, 2);

  const v1 = board1.validate(id1, 'orch');
  const v2 = board1.validate(id2, 'orch');

  assert(v1 === true, '[fcw] Different keys: both validate (key:alpha)');
  assert(v2 === true, '[fcw] Different keys: both validate (key:beta)');

  const c1 = board1.commit(id1);
  const c2 = board1.commit(id2);

  assert(c1.success === true, '[fcw] Different keys: both commit (key:alpha)');
  assert(c2.success === true, '[fcw] Different keys: both commit (key:beta)');

  cleanup(testDir1);

  // Test with priority-wins
  const testDir2 = join(process.cwd(), 'data', 'test-priority-noconflict2');
  cleanup(testDir2);

  const board2 = new LockedBlackboard(testDir2, { conflictResolution: 'priority-wins' });

  const id3 = board2.propose('key:gamma', 'val3', 'agent-3', undefined, 0);
  const id4 = board2.propose('key:delta', 'val4', 'agent-4', undefined, 3);

  const v3 = board2.validate(id3, 'orch');
  const v4 = board2.validate(id4, 'orch');

  assert(v3 === true, '[pw] Different keys: both validate (key:gamma)');
  assert(v4 === true, '[pw] Different keys: both validate (key:delta)');

  const c3 = board2.commit(id3);
  const c4 = board2.commit(id4);

  assert(c3.success === true, '[pw] Different keys: both commit (key:gamma)');
  assert(c4.success === true, '[pw] Different keys: both commit (key:delta)');

  cleanup(testDir2);
}

// ============================================================================
// TEST 6: PREEMPTION METADATA
// ============================================================================

function testPreemptionMetadata(): void {
  section('6. Preemption metadata on aborted changes');

  const testDir = join(process.cwd(), 'data', 'test-priority-metadata');
  cleanup(testDir);

  const board = new LockedBlackboard(testDir, { conflictResolution: 'priority-wins' });

  // Both propose before either commits
  const idLow = board.propose('data:shared', { v: 1 }, 'low-agent', undefined, 0);
  const idHigh = board.propose('data:shared', { v: 99 }, 'high-agent', undefined, 3);

  // Low commits first
  board.validate(idLow, 'orch');
  board.commit(idLow);

  // High validates — should succeed (higher priority than committed)
  const validHigh = board.validate(idHigh, 'orch');
  assert(validHigh === true, 'High-priority validates after low committed');

  // Verify only high-priority change remains pending
  const pending = board.listPendingChanges();
  assert(pending.length === 1, 'Only 1 pending change remains (the high-priority one)');
  assert(pending[0].change_id === idHigh, 'Remaining pending change is the high-priority one');

  cleanup(testDir);
}

// ============================================================================
// TEST 7: COMMIT-LEVEL PREEMPTION (under lock)
// ============================================================================

function testCommitLevelPreemption(): void {
  section('7. Commit-level priority check (under lock)');

  const testDir = join(process.cwd(), 'data', 'test-priority-commit');
  cleanup(testDir);

  const board = new LockedBlackboard(testDir, { conflictResolution: 'priority-wins' });

  // Low-priority writes first
  const idLow = board.propose('lock:key', 'low-value', 'low-agent', undefined, 1);
  board.validate(idLow, 'orch');
  board.commit(idLow);
  assert(board.read('lock:key')?.value === 'low-value', 'Low-priority value committed');

  // High-priority proposes and validates (with current hash)
  const idHigh = board.propose('lock:key', 'high-value', 'high-agent', undefined, 3);
  const validHigh = board.validate(idHigh, 'orch');
  assert(validHigh === true, 'High-priority change validates');

  // Commit high-priority
  const commitHigh = board.commit(idHigh);
  assert(commitHigh.success === true, 'High-priority commit succeeds');
  assert(board.read('lock:key')?.value === 'high-value', 'Final value is high-priority');

  cleanup(testDir);
}

// ============================================================================
// TEST 8: CONSTRUCTOR OVERLOADS
// ============================================================================

function testConstructorOverloads(): void {
  section('8. Constructor overloads for options');

  const testDir = join(process.cwd(), 'data', 'test-priority-ctor');
  cleanup(testDir);

  // Default (no options)
  const b1 = new LockedBlackboard(testDir);
  assert(b1.getConflictResolution() === 'first-commit-wins', 'Default constructor: first-commit-wins');
  cleanup(testDir);

  // Options-only (no audit logger)
  const b2 = new LockedBlackboard(testDir, { conflictResolution: 'priority-wins' });
  assert(b2.getConflictResolution() === 'priority-wins', 'Options constructor: priority-wins');
  cleanup(testDir);

  // With audit logger + options
  const b3 = new LockedBlackboard(testDir, undefined, { conflictResolution: 'priority-wins' });
  assert(b3.getConflictResolution() === 'priority-wins', 'AuditLogger + options: priority-wins');
  cleanup(testDir);

  // With audit logger, no options (backward compat)
  const b4 = new LockedBlackboard(testDir, undefined);
  assert(b4.getConflictResolution() === 'first-commit-wins', 'AuditLogger only (undefined): first-commit-wins');
  cleanup(testDir);
}

// ============================================================================
// TEST 9: LOW-PRIORITY CANNOT PREEMPT HIGH-PRIORITY
// ============================================================================

function testLowCannotPreemptHigh(): void {
  section('9. Low-priority cannot preempt high-priority');

  const testDir = join(process.cwd(), 'data', 'test-priority-no-preempt');
  cleanup(testDir);

  const board = new LockedBlackboard(testDir, { conflictResolution: 'priority-wins' });

  // Both propose before either commits
  const idHigh = board.propose('critical:data', 'important', 'high-agent', undefined, 3);
  const idLow = board.propose('critical:data', 'overwrite-attempt', 'low-agent', undefined, 0);

  // High-priority commits first
  board.validate(idHigh, 'orch');
  board.commit(idHigh);

  // Low-priority tries to validate — should fail (cannot preempt higher)
  const validLow = board.validate(idLow, 'orch');
  assert(validLow === false, 'Low-priority cannot preempt high-priority committed value');

  // Value unchanged
  assert(board.read('critical:data')?.value === 'important', 'High-priority value remains intact');

  cleanup(testDir);
}

// ============================================================================
// TEST 10: FIND CONFLICTING PENDING CHANGES
// ============================================================================

function testFindConflictingPendingChanges(): void {
  section('10. findConflictingPendingChanges()');

  const testDir = join(process.cwd(), 'data', 'test-priority-find');
  cleanup(testDir);

  const board = new LockedBlackboard(testDir);

  const id1 = board.propose('shared:key', 'v1', 'agent-1', undefined, 1);
  const id2 = board.propose('shared:key', 'v2', 'agent-2', undefined, 2);
  const id3 = board.propose('different:key', 'v3', 'agent-3', undefined, 3);
  const id4 = board.propose('shared:key', 'v4', 'agent-4', undefined, 0);

  // Find conflicts for id1 on 'shared:key'
  const conflicts = board.findConflictingPendingChanges('shared:key', id1);
  assert(conflicts.length === 2, 'Found 2 conflicting changes on shared:key (excluding self)');
  assert(conflicts.some(c => c.change_id === id2), 'id2 is in conflicts');
  assert(conflicts.some(c => c.change_id === id4), 'id4 is in conflicts');
  assert(!conflicts.some(c => c.change_id === id3), 'id3 (different key) not in conflicts');

  cleanup(testDir);
}

// ============================================================================
// TEST 11: PRIORITY WITH TTL
// ============================================================================

function testPriorityWithTTL(): void {
  section('11. Priority works with TTL');

  const testDir = join(process.cwd(), 'data', 'test-priority-ttl');
  cleanup(testDir);

  const board = new LockedBlackboard(testDir, { conflictResolution: 'priority-wins' });

  // Propose with both priority and TTL
  const id = board.propose('cache:temp', 'ephemeral', 'agent-1', 300, 2);
  const pending = board.listPendingChanges().find(c => c.change_id === id);
  assert(pending?.priority === 2, 'Priority stored correctly with TTL');
  assert(pending?.ttl === 300, 'TTL stored correctly with priority');

  board.validate(id, 'orch');
  const result = board.commit(id);
  assert(result.success === true, 'Commit with priority + TTL succeeds');
  assert(result.entry?.ttl === 300, 'Committed entry has correct TTL');

  cleanup(testDir);
}

// ============================================================================
// TEST 12: MULTIPLE PREEMPTIONS IN ONE VALIDATE
// ============================================================================

function testMultiplePreemptions(): void {
  section('12. Multiple low-priority changes preempted at once');

  const testDir = join(process.cwd(), 'data', 'test-priority-multi');
  cleanup(testDir);

  const board = new LockedBlackboard(testDir, { conflictResolution: 'priority-wins' });

  // ALL four agents propose before any commits (creates true conflict)
  const idL1 = board.propose('hot:key', 'low1', 'agent-low-1', undefined, 0);
  const _idL2 = board.propose('hot:key', 'low2', 'agent-low-2', undefined, 1);
  const _idL3 = board.propose('hot:key', 'low3', 'agent-low-3', undefined, 1);
  const idHigh = board.propose('hot:key', 'critical-update', 'agent-critical', undefined, 3);

  // Low-1 commits first
  board.validate(idL1, 'orch');
  board.commit(idL1);

  // Now high-priority validates — should preempt remaining low-priority pending changes
  const validHigh = board.validate(idHigh, 'orch');
  assert(validHigh === true, 'High-priority validates');

  const remaining = board.listPendingChanges();
  assert(remaining.length === 1, `Only 1 pending remains (got ${remaining.length})`);
  assert(remaining[0].change_id === idHigh, 'Remaining is the high-priority change');

  // Commit
  const commitResult = board.commit(idHigh);
  assert(commitResult.success === true, 'Commit succeeds after preempting changes');
  assert(board.read('hot:key')?.value === 'critical-update', 'Final value is from critical agent');

  cleanup(testDir);
}

// ============================================================================
// TEST 13: BACKWARD COMPATIBILITY — OLD CODE WITHOUT PRIORITY
// ============================================================================

function testBackwardCompatibility(): void {
  section('13. Backward compatibility (no priority argument)');

  const testDir = join(process.cwd(), 'data', 'test-priority-compat');
  cleanup(testDir);

  // Old-style usage: no priority, no options
  const board = new LockedBlackboard(testDir);

  const id = board.propose('legacy:key', { data: 'works' }, 'legacy-agent');
  const valid = board.validate(id, 'orchestrator');
  assert(valid === true, 'Old-style propose (no priority) validates');

  const result = board.commit(id);
  assert(result.success === true, 'Old-style commit succeeds');

  const entry = board.read('legacy:key');
  assert((entry?.value as any)?.data === 'works', 'Old-style value is readable');

  // Also test propose with TTL but no priority (4-arg call)
  const id2 = board.propose('legacy:ttl', 'expires', 'legacy-agent', 600);
  const pending2 = board.listPendingChanges().find(c => c.change_id === id2);
  assert(pending2?.priority === 0, 'No priority arg → defaults to 0');
  assert(pending2?.ttl === 600, 'TTL still works in 4-arg call');

  cleanup(testDir);
}

// ============================================================================
// RUN ALL PRIORITY TESTS
// ============================================================================

async function runPriorityTests(): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log(`${colors.bold}  Phase 3: Priority & Preemption Test Suite${colors.reset}`);
  console.log('='.repeat(60));

  const start = Date.now();

  try {
    testFirstCommitWinsDefault();
    testPriorityOnPropose();
    testPriorityWinsBasic();
    testPriorityWinsSamePriority();
    testNoConflictDifferentKeys();
    testPreemptionMetadata();
    testCommitLevelPreemption();
    testConstructorOverloads();
    testLowCannotPreemptHigh();
    testFindConflictingPendingChanges();
    testPriorityWithTTL();
    testMultiplePreemptions();
    testBackwardCompatibility();

    const duration = Date.now() - start;

    console.log('\n' + '='.repeat(60));
    if (failed === 0) {
      console.log(`${colors.green}${colors.bold}  ALL ${passed} PRIORITY TESTS PASSED${colors.reset} (${duration}ms)`);
    } else {
      console.log(`${colors.red}${colors.bold}  ${failed} FAILED${colors.reset}, ${colors.green}${passed} passed${colors.reset} (${duration}ms)`);
    }
    console.log('='.repeat(60) + '\n');

    if (failed > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error(`\n${colors.red}UNEXPECTED ERROR:${colors.reset}`, error);
    process.exit(1);
  }
}

runPriorityTests();
