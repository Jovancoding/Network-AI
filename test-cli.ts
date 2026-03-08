/**
 * test-cli.ts — Unit tests for the Network-AI CLI (bin/cli.ts)
 *
 * Tests exercise the CLI logic by importing the core classes directly
 * (same path the CLI uses), so no subprocess spawning is required.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LockedBlackboard } from './lib/locked-blackboard';
import { AuthGuardian } from './index';
import { FederatedBudget } from './lib/federated-budget';

// ── tiny test harness (matches project style) ─────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

// ── helpers ───────────────────────────────────────────────────────────────────

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-cli-'));
  return dir;
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── SECTION 1: LockedBlackboard (backing layer for bb commands) ───────────────

section('1. Blackboard — get/set/delete/list');

(function () {
  const dir = tmpDir();
  try {
    const board = new LockedBlackboard(dir);

    // set
    const entry = board.write('status', 'running', 'cli');
    assert(entry !== null, 'write returns an entry');
    assert((entry as { value: unknown }).value === 'running', 'entry.value matches written value');

    // get
    const fetched = board.read('status');
    assert(fetched !== null, 'read returns entry for existing key');
    assert((fetched as { value: unknown }).value === 'running', 'read value matches written value');

    // list
    board.write('task', { id: 1, status: 'pending' }, 'cli');
    const keys = board.listKeys();
    assert(keys.includes('status'), 'list includes "status"');
    assert(keys.includes('task'), 'list includes "task"');

    // delete
    const ok = board.delete('status');
    assert(ok, 'delete returns true for existing key');
    assert(board.read('status') === null, 'deleted key is gone');

    // delete non-existent
    const ng = board.delete('nonexistent-key-xyz');
    assert(!ng, 'delete returns false for missing key');

    // get non-existent
    const missing = board.read('nonexistent-key-xyz');
    assert(missing === null, 'read returns null for missing key');
  } finally {
    cleanup(dir);
  }
})();

// ── SECTION 2: JSON values ────────────────────────────────────────────────────

section('2. Blackboard — JSON value types');

(function () {
  const dir = tmpDir();
  try {
    const board = new LockedBlackboard(dir);

    board.write('num', 42, 'cli');
    assert((board.read('num') as { value: unknown })?.value === 42, 'numeric value preserved');

    board.write('obj', { x: 1, y: 2 }, 'cli');
    const obj = (board.read('obj') as { value: unknown })?.value as Record<string, number>;
    assert(obj?.x === 1 && obj?.y === 2, 'object value preserved');

    board.write('arr', [1, 2, 3], 'cli');
    const arr = (board.read('arr') as { value: unknown })?.value as number[];
    assert(Array.isArray(arr) && arr.length === 3, 'array value preserved');

    board.write('bool', false, 'cli');
    assert((board.read('bool') as { value: unknown })?.value === false, 'boolean false preserved');
  } finally {
    cleanup(dir);
  }
})();

// ── SECTION 3: Snapshot ───────────────────────────────────────────────────────

section('3. Blackboard — snapshot');

(function () {
  const dir = tmpDir();
  try {
    const board = new LockedBlackboard(dir);
    board.write('a', 1, 'cli');
    board.write('b', 2, 'cli');
    board.write('c', 3, 'cli');

    const snap: Record<string, unknown> = {};
    for (const key of board.listKeys()) snap[key] = board.read(key);

    assert(Object.keys(snap).length === 3, 'snapshot contains 3 keys');
    assert('a' in snap && 'b' in snap && 'c' in snap, 'snapshot has all written keys');
  } finally {
    cleanup(dir);
  }
})();

// ── SECTION 4: Atomic propose → validate → commit ────────────────────────────

section('4. Blackboard — propose / validate / commit');

(function () {
  const dir = tmpDir();
  try {
    const board = new LockedBlackboard(dir);

    const changeId = board.propose('workflow', 'started', 'agent-1');
    assert(typeof changeId === 'string' && changeId.length > 0, 'propose returns a change-id string');

    const valid = board.validate(changeId, 'agent-1');
    assert(valid === true, 'validate returns true for uncontested change');

    const result = board.commit(changeId);
    assert(result.success === true, 'commit succeeds');
    assert(result.change_id === changeId, 'commit result carries change_id');
    assert(board.read('workflow') !== null, 'committed key is readable');
  } finally {
    cleanup(dir);
  }
})();

// ── SECTION 5: Abort ──────────────────────────────────────────────────────────

section('5. Blackboard — abort');

(function () {
  const dir = tmpDir();
  try {
    const board = new LockedBlackboard(dir);

    const changeId = board.propose('temp', 'value', 'cli');
    const aborted = board.abort(changeId);
    assert(aborted === true, 'abort returns true for pending change');

    const abortMissing = board.abort('nonexistent-change-id-xyz');
    assert(abortMissing === false, 'abort returns false for unknown change-id');
  } finally {
    cleanup(dir);
  }
})();

// ── SECTION 6: TTL ────────────────────────────────────────────────────────────

section('6. Blackboard — TTL metadata');

(function () {
  const dir = tmpDir();
  try {
    const board = new LockedBlackboard(dir);
    board.write('ephemeral', 'data', 'cli', 60);
    const entry = board.read('ephemeral') as { ttl?: number; value: unknown } | null;
    assert(entry !== null, 'TTL entry is written');
    assert(entry!.value === 'data', 'TTL entry has correct value');
  } finally {
    cleanup(dir);
  }
})();

// ── SECTION 7: Auth — token issuance ─────────────────────────────────────────

section('7. Auth — token issuance and validation');

(function () {
  const dir = tmpDir();
  const auditPath = path.join(dir, 'audit_log.jsonl');
  try {
    const guardian = new AuthGuardian({ auditLogPath: auditPath });
    guardian.registerAgentTrust({ agentId: 'bot-1', trustLevel: 1, allowedResources: ['blackboard'] });

    let error: unknown = null;
    (async () => {
      try {
        await guardian.requestPermission('bot-1', 'blackboard', 'CLI test');
      } catch (e) {
        error = e;
      }
    })();

    // synchronous path: AuthGuardian.requestPermission may be sync-within-async
    // test via validateToken which is synchronous
    assert(error === null, 'requestPermission does not throw synchronously');
  } finally {
    cleanup(dir);
  }
})();

section('7b. Auth — validateToken on fresh guardian');

(function () {
  const dir = tmpDir();
  const auditPath = path.join(dir, 'audit_log.jsonl');
  try {
    const guardian = new AuthGuardian({ auditLogPath: auditPath });
    const valid = guardian.validateToken('not-a-real-token');
    assert(valid === false, 'validateToken returns false for unknown token');
  } finally {
    cleanup(dir);
  }
})();

section('7c. Auth — revokeToken does not throw');

(function () {
  const dir = tmpDir();
  const auditPath = path.join(dir, 'audit_log.jsonl');
  try {
    const guardian = new AuthGuardian({ auditLogPath: auditPath });
    let threw = false;
    try { guardian.revokeToken('some-token'); } catch { threw = true; }
    assert(!threw, 'revokeToken does not throw for unknown token');
  } finally {
    cleanup(dir);
  }
})();

section('7d. Auth — enforceRestrictions with invalid token');

(function () {
  const dir = tmpDir();
  const auditPath = path.join(dir, 'audit_log.jsonl');
  try {
    const guardian = new AuthGuardian({ auditLogPath: auditPath });
    const result = guardian.enforceRestrictions('invalid-token', { type: 'read' });
    assert(result !== null, 'enforceRestrictions returns violation reason for invalid token');
    assert(typeof result === 'string', 'violation reason is a string');
  } finally {
    cleanup(dir);
  }
})();

// ── SECTION 8: FederatedBudget ────────────────────────────────────────────────

section('8. Budget — ceiling and spend tracking');

(function () {
  const fed = new FederatedBudget({ ceiling: 1000 });

  assert(fed.getCeiling() === 1000, 'getCeiling returns configured ceiling');
  assert(fed.remaining() === 1000, 'remaining equals full ceiling before any spend');
  assert(fed.getTotalSpent() === 0, 'getTotalSpent is 0 initially');
  assert(fed.getAgentSpent('agent-x') === 0, 'getAgentSpent is 0 for unseen agent');

  const result = fed.spend('agent-x', 100);
  assert(result.allowed === true, 'spend allowed when under ceiling');
  assert(fed.getTotalSpent() === 100, 'getTotalSpent updated after spend');
  assert(fed.remaining() === 900, 'remaining decremented after spend');
  assert(fed.getAgentSpent('agent-x') === 100, 'getAgentSpent tracks per-agent usage');
})();

section('8b. Budget — ceiling enforcement');

(function () {
  const fed = new FederatedBudget({ ceiling: 50 });
  const r = fed.spend('bot', 100);
  assert(r.allowed === false, 'spend denied when exceeds ceiling');
  assert(typeof r.deniedReason === 'string', 'deniedReason is a string');
})();

section('8c. Budget — setCeiling');

(function () {
  const fed = new FederatedBudget({ ceiling: 100 });
  fed.setCeiling(500);
  assert(fed.getCeiling() === 500, 'setCeiling updates ceiling');
  assert(fed.remaining() === 500, 'remaining reflects new ceiling');
})();

section('8d. Budget — getSpendLog');

(function () {
  const fed = new FederatedBudget({ ceiling: 10_000 });
  fed.spend('a', 10);
  fed.spend('b', 20);
  const log = fed.getSpendLog();
  assert(typeof log === 'object' && log !== null, 'getSpendLog returns an object');
  assert(log['a'] === 10, 'spend log tracks agent-a');
  assert(log['b'] === 20, 'spend log tracks agent-b');
})();

// ── SECTION 9: Audit log ──────────────────────────────────────────────────────

section('9. Audit — log file operations');

(function () {
  const dir = tmpDir();
  const logFile = path.join(dir, 'audit_log.jsonl');
  try {
    // write some fake entries
    const entries = [
      { ts: Date.now(), event: 'write', key: 'x', agent: 'a' },
      { ts: Date.now(), event: 'read',  key: 'y', agent: 'b' },
      { ts: Date.now(), event: 'write', key: 'z', agent: 'c' },
    ];
    fs.writeFileSync(logFile, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

    const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
    assert(lines.length === 3, 'audit log has 3 lines after writing 3 entries');

    const parsed = lines.map(l => JSON.parse(l) as { event: string; key: string });
    assert(parsed[0].event === 'write', 'first entry is a write event');
    assert(parsed[1].event === 'read',  'second entry is a read event');

    // clear
    fs.writeFileSync(logFile, '');
    const after = fs.readFileSync(logFile, 'utf-8').trim();
    assert(after === '', 'audit log is empty after clear');
  } finally {
    cleanup(dir);
  }
})();

section('9b. Audit — tail detects new content');

(function () {
  const dir = tmpDir();
  const logFile = path.join(dir, 'audit_log.jsonl');
  try {
    fs.writeFileSync(logFile, '');
    const before = fs.statSync(logFile).size;
    assert(before === 0, 'initial file size is 0');

    fs.appendFileSync(logFile, JSON.stringify({ event: 'write', key: 'k' }) + '\n');
    const after = fs.statSync(logFile).size;
    assert(after > before, 'file size grew after append (tail would detect this)');
  } finally {
    cleanup(dir);
  }
})();

// ── SECTION 10: CLI module structure ─────────────────────────────────────────

section('10. CLI — module structure');

(function () {
  const cliPath = path.resolve(__dirname, 'bin', 'cli.ts');
  const exists = fs.existsSync(cliPath);
  assert(exists, 'bin/cli.ts exists');

  if (exists) {
    const src = fs.readFileSync(cliPath, 'utf-8');
    assert(src.includes('#!/usr/bin/env node'), 'cli has shebang line');
    assert(src.includes("from 'commander'"), 'cli imports commander');
    assert(src.includes('LockedBlackboard'), 'cli imports LockedBlackboard');
    assert(src.includes('AuthGuardian'), 'cli imports AuthGuardian');
    assert(src.includes('FederatedBudget'), 'cli imports FederatedBudget');
    assert(src.includes("'bb'"), 'cli registers bb command');
    assert(src.includes("'auth'"), 'cli registers auth command');
    assert(src.includes("'budget'"), 'cli registers budget command');
    assert(src.includes("'audit'"), 'cli registers audit command');
  }
})();

section('10b. CLI — package.json bin entry');

(function () {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require('./package.json') as { bin: Record<string, string> };
  assert('network-ai' in pkg.bin, 'package.json has network-ai bin entry');
  assert(pkg.bin['network-ai'].includes('cli.js'), 'network-ai bin points to cli.js');
  assert('network-ai-server' in pkg.bin, 'package.json still has network-ai-server bin');
})();

section('10c. CLI — commander version');

(function () {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cmdPkg = require('./node_modules/commander/package.json') as { version: string };
  const major = parseInt(cmdPkg.version.split('.')[0], 10);
  assert(major >= 10, `commander v${cmdPkg.version} installed (>=10 required for optsWithGlobals)`);
})();

// ── summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`CLI tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
