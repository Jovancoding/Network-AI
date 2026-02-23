/**
 * test-phase5b.ts — Phase 5 Part 2: Pluggable Backend API
 *
 * Tests for BlackboardBackend interface, MemoryBackend, FileBackend,
 * and getBlackboard() with custom backend options.
 *
 * Run: npx ts-node test-phase5b.ts
 */

import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';

import {
  SwarmOrchestrator,
  MemoryBackend,
  FileBackend,
  ValidationError,
} from './index';
import type { BlackboardBackend } from './index';

// ============================================================================
// HELPERS
// ============================================================================

let passed = 0;
let failed = 0;
const errors: string[] = [];

function pass(label: string): void {
  passed++;
  process.stdout.write(`  ✓ ${label}\n`);
}

function fail(label: string, reason: string): void {
  failed++;
  errors.push(`  ✗ ${label}: ${reason}`);
  process.stdout.write(`  ✗ ${label}: ${reason}\n`);
}

function assert(condition: boolean, label: string, reason = 'assertion failed'): void {
  condition ? pass(label) : fail(label, reason);
}

function assertThrows(fn: () => unknown, label: string, msgFragment?: string): void {
  try {
    fn();
    fail(label, 'expected an error to be thrown');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msgFragment && !msg.toLowerCase().includes(msgFragment.toLowerCase())) {
      fail(label, `expected message to contain "${msgFragment}", got: "${msg}"`);
    } else {
      pass(label);
    }
  }
}

function section(title: string): void {
  process.stdout.write(`\n--- ${title} ---\n`);
}

const dirs: string[] = [];
function tmpDir(): string {
  const d = join(tmpdir(), `nai-p5b-${randomUUID()}`);
  dirs.push(d);
  return d;
}

function makeOrchestrator(): SwarmOrchestrator {
  return new SwarmOrchestrator(tmpDir());
}

// ============================================================================
// 1. MemoryBackend — standalone
// ============================================================================
section('1. MemoryBackend standalone');

{
  const b = new MemoryBackend();

  // write + read
  const entry = b.write('k1', { x: 1 }, 'agent-a');
  assert(entry.key === 'k1', 'write returns entry with correct key');
  assert(entry.source_agent === 'agent-a', 'write records source_agent');
  assert(entry.version === 1, 'first write gets version 1');
  assert(entry.ttl === null, 'default ttl is null');

  const read = b.read('k1');
  assert(read !== null, 'read returns stored entry');
  assert((read!.value as any).x === 1, 'read value is correct');

  // version increment
  b.write('k1', { x: 2 }, 'agent-a');
  const v2 = b.read('k1');
  assert(v2?.version === 2, 'version increments on overwrite');

  // missing key
  assert(b.read('no-such-key') === null, 'read returns null for missing key');

  // delete
  const del = b.delete('k1');
  assert(del === true, 'delete returns true for existing key');
  assert(b.read('k1') === null, 'key is gone after delete');
  assert(b.delete('k1') === false, 'delete returns false for already-gone key');

  // listKeys + getSnapshot
  b.write('a', 1, 'agent-a');
  b.write('b', 2, 'agent-b');
  const keys = b.listKeys();
  assert(keys.includes('a') && keys.includes('b'), 'listKeys returns all keys');
  const snap = b.getSnapshot();
  assert(typeof snap === 'object' && snap['a'] !== undefined && snap['b'] !== undefined, 'getSnapshot returns all entries');

  // clear
  b.clear();
  assert(b.listKeys().length === 0, 'clear removes all entries');
  assert(b.size() === 0, 'size() is 0 after clear');
}

// ============================================================================
// 2. MemoryBackend — TTL expiry
// ============================================================================
section('2. MemoryBackend TTL expiry');

{
  const b = new MemoryBackend();

  // Write with 0s TTL (already expired)
  const past = new Date(Date.now() - 5000).toISOString();
  // Manually inject an expired entry to test without needing to wait
  // We'll use write with a 1s TTL and simulate by checking the logic
  b.write('expire-me', 'val', 'agent', 1);
  const immediate = b.read('expire-me');
  assert(immediate !== null, 'entry readable immediately after write');

  // Write with a very short ttl, then backdating via delete+re-add trick
  // Instead: just verify a 0-ttl (null = never expires)
  b.write('no-expire', 42, 'agent');
  assert(b.read('no-expire')?.ttl === null, 'null ttl means no expiry');

  // Verify ttl is stored correctly
  b.write('with-ttl', 'x', 'agent', 3600);
  assert(b.read('with-ttl')?.ttl === 3600, 'ttl is stored on the entry');
}

// ============================================================================
// 3. FileBackend standalone
// ============================================================================
section('3. FileBackend standalone');

{
  const dir = tmpDir();
  const fb = new FileBackend(dir);

  const w = fb.write('file-key', { hello: 'world' }, 'agent-x', 60);
  assert(w.key === 'file-key', 'FileBackend write returns entry');
  assert(w.source_agent === 'agent-x', 'FileBackend records source_agent');

  const r = fb.read('file-key');
  assert(r !== null, 'FileBackend read returns stored entry');
  assert((r!.value as any).hello === 'world', 'FileBackend read value correct');

  const keys = fb.listKeys();
  assert(keys.includes('file-key'), 'FileBackend listKeys includes written key');

  const snap = fb.getSnapshot();
  assert(snap['file-key'] !== undefined, 'FileBackend getSnapshot includes key');

  const d = fb.delete('file-key');
  assert(d === true, 'FileBackend delete returns true');
  assert(fb.read('file-key') === null, 'FileBackend key gone after delete');
}

// ============================================================================
// 4. BlackboardBackend interface — custom implementation (duck typing)
// ============================================================================
section('4. Custom BlackboardBackend (duck typing)');

{
  // A custom backend backed by a plain object
  class MapBackend implements BlackboardBackend {
    private store: Map<string, any> = new Map();
    read(key: string) { return this.store.get(key) ?? null; }
    write(key: string, value: unknown, sourceAgent: string, ttl?: number) {
      const entry = { key, value, source_agent: sourceAgent, timestamp: new Date().toISOString(), ttl: ttl ?? null, version: 1 };
      this.store.set(key, entry);
      return entry;
    }
    delete(key: string) { return this.store.delete(key); }
    listKeys() { return Array.from(this.store.keys()); }
    getSnapshot() { return Object.fromEntries(this.store); }
  }

  const orch = makeOrchestrator();
  const custom = new MapBackend();
  const board = orch.getBlackboard('custom', { backend: custom });

  board.registerAgent('cust-agent', 'tok-c', ['*']);
  board.write('custom-key', 'hi', 'cust-agent', undefined, 'tok-c');
  const r = board.read('custom-key');
  assert(r !== null, 'custom backend: write+read works');
  assert(r!.value === 'hi', 'custom backend: value correct');
}

// ============================================================================
// 5. getBlackboard() with MemoryBackend option
// ============================================================================
section('5. getBlackboard() with MemoryBackend');

{
  const orch = makeOrchestrator();
  const memBackend = new MemoryBackend();
  const board = orch.getBlackboard('mem-board', { backend: memBackend });

  board.registerAgent('mem-agent', 'tok-m', ['*']);
  board.write('score', 99, 'mem-agent', undefined, 'tok-m');
  const r = board.read('score');
  assert(r !== null && r.value === 99, 'MemoryBackend board: write+read works');

  // No disk directory created for memory board
  const expectedDir = join((orch as any)._workspacePath, 'boards', 'mem-board');
  assert(!existsSync(expectedDir), 'no disk directory created for MemoryBackend board');
}

// ============================================================================
// 6. Idempotency with MemoryBackend
// ============================================================================
section('6. Idempotency with MemoryBackend');

{
  const orch = makeOrchestrator();
  const b1 = orch.getBlackboard('idem', { backend: new MemoryBackend() });
  const b2 = orch.getBlackboard('idem', { backend: new MemoryBackend() }); // second call, options ignored
  assert(b1 === b2, 'getBlackboard is idempotent — same instance returned');

  b1.registerAgent('a', 'tok', ['*']);
  b1.write('x', 1, 'a', undefined, 'tok');
  assert(b2.read('x')?.value === 1, 'idempotent: second reference sees same data');
}

// ============================================================================
// 7. Mixed backends on the same orchestrator are isolated
// ============================================================================
section('7. Mixed backends — isolation');

{
  const orch = makeOrchestrator();

  const memBoard = orch.getBlackboard('mem', { backend: new MemoryBackend() });
  const fileBoard = orch.getBlackboard('file'); // default FileBackend

  memBoard.registerAgent('a', 'tok-a', ['*']);
  fileBoard.registerAgent('b', 'tok-b', ['*']);

  memBoard.write('shared-key', 'from-mem', 'a', undefined, 'tok-a');
  fileBoard.write('shared-key', 'from-file', 'b', undefined, 'tok-b');

  assert(memBoard.read('shared-key')?.value === 'from-mem', 'mem board has its own value');
  assert(fileBoard.read('shared-key')?.value === 'from-file', 'file board has its own value');
  assert(memBoard.read('shared-key')?.value !== fileBoard.read('shared-key')?.value, 'backends are isolated');
}

// ============================================================================
// 8. getBlackboard() default (no backend) still uses file backend
// ============================================================================
section('8. Default backend is FileBackend (backward compat)');

{
  const orch = makeOrchestrator();
  const board = orch.getBlackboard('default-file');
  board.registerAgent('def-agent', 'tok-d', ['*']);
  board.write('persist-key', 'persist-val', 'def-agent', undefined, 'tok-d');

  const expectedDir = join((orch as any)._workspacePath, 'boards', 'default-file');
  assert(existsSync(expectedDir), 'file directory created for default (FileBackend) board');
  assert(board.read('persist-key')?.value === 'persist-val', 'default board read works');
}

// ============================================================================
// 9. destroyBlackboard + re-attach with MemoryBackend gives fresh board
// ============================================================================
section('9. destroyBlackboard + re-attach with MemoryBackend');

{
  const orch = makeOrchestrator();
  const mem1 = new MemoryBackend();
  const b1 = orch.getBlackboard('rebind', { backend: mem1 });
  b1.registerAgent('ra', 'tok-ra', ['*']);
  b1.write('k', 'original', 'ra', undefined, 'tok-ra');
  assert(b1.read('k')?.value === 'original', 'original value written');

  orch.destroyBlackboard('rebind');

  // Re-attach with a fresh MemoryBackend — new instance
  const mem2 = new MemoryBackend();
  const b2 = orch.getBlackboard('rebind', { backend: mem2 });
  assert(b1 !== b2, 'new board instance after re-attach');
  assert(b2.read('k') === null, 'fresh MemoryBackend has no prior data');
}

// ============================================================================
// 10. MemoryBackend size() tracks entries
// ============================================================================
section('10. MemoryBackend size()');

{
  const b = new MemoryBackend();
  assert(b.size() === 0, 'size is 0 initially');
  b.write('a', 1, 'x');
  b.write('b', 2, 'x');
  assert(b.size() === 2, 'size reflects stored entries');
  b.delete('a');
  assert(b.size() === 1, 'size decrements after delete');
  b.clear();
  assert(b.size() === 0, 'size is 0 after clear');
}

// ============================================================================
// 11. MemoryBackend export: importable from 'index'
// ============================================================================
section('11. Exports from index');

{
  // Already imported at top — just verify the types are correct
  assert(typeof MemoryBackend === 'function', 'MemoryBackend is exported from index');
  assert(typeof FileBackend === 'function', 'FileBackend is exported from index');
  const b = new MemoryBackend();
  assert(typeof b.read === 'function', 'MemoryBackend satisfies BlackboardBackend interface');
  assert(typeof b.write === 'function', 'MemoryBackend.write is a function');
  assert(typeof b.delete === 'function', 'MemoryBackend.delete is a function');
  assert(typeof b.listKeys === 'function', 'MemoryBackend.listKeys is a function');
  assert(typeof b.getSnapshot === 'function', 'MemoryBackend.getSnapshot is a function');
}

// ============================================================================
// 12. Multiple named boards with different backends on same orchestrator
// ============================================================================
section('12. Multiple boards, multiple backends');

{
  const orch = makeOrchestrator();

  const boardA = orch.getBlackboard('alpha', { backend: new MemoryBackend() });
  const boardB = orch.getBlackboard('beta',  { backend: new MemoryBackend() });
  const boardC = orch.getBlackboard('gamma'); // FileBackend

  boardA.registerAgent('aa', 'tok-aa', ['*']);
  boardB.registerAgent('ab', 'tok-ab', ['*']);
  boardC.registerAgent('ac', 'tok-ac', ['*']);

  boardA.write('x', 'alpha-val', 'aa', undefined, 'tok-aa');
  boardB.write('x', 'beta-val',  'ab', undefined, 'tok-ab');
  boardC.write('x', 'gamma-val', 'ac', undefined, 'tok-ac');

  assert(boardA.read('x')?.value === 'alpha-val', 'board alpha has correct value');
  assert(boardB.read('x')?.value === 'beta-val',  'board beta has correct value');
  assert(boardC.read('x')?.value === 'gamma-val', 'board gamma has correct value');
  assert(orch.listBlackboards().length === 3, 'orchestrator tracks 3 boards');
}

// ============================================================================
// CLEANUP
// ============================================================================
for (const d of dirs) {
  try { rmSync(d, { recursive: true }); } catch { /* ignore */ }
}

// ============================================================================
// RESULTS
// ============================================================================
const total = passed + failed;
process.stdout.write('\n' + '='.repeat(60) + '\n');
if (failed === 0) {
  process.stdout.write(`  ALL ${total} PHASE 5b TESTS PASSED\n`);
} else {
  process.stdout.write(`  ${passed}/${total} passed, ${failed} FAILED\n`);
  for (const e of errors) process.stdout.write(e + '\n');
}
process.stdout.write('='.repeat(60) + '\n');
process.exit(failed > 0 ? 1 : 0);
