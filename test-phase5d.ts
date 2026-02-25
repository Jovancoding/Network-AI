/**
 * Phase 5 Part 4 — CRDT Blackboard Backend Tests
 *
 * Tests for:
 *   - lib/crdt.ts               Vector clock primitives + merge logic
 *   - lib/blackboard-backend-crdt.ts  CrdtBackend class
 *
 * Uses no real network connections or file I/O — all in-process.
 * Run with: npx ts-node test-phase5d.ts
 */

import {
  tickClock,
  mergeClock,
  happensBefore,
  isConcurrent,
  compareClock,
  mergeEntry,
  type VectorClock,
  type CrdtEntry,
} from './lib/crdt';

import {
  CrdtBackend,
  type CrdtBackendOptions,
} from './lib/blackboard-backend-crdt';

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

function section(title: string): void {
  console.log(`\n${title}`);
}

async function main(): Promise<void> {

  // ==========================================================================
  // 1. tickClock
  // ==========================================================================
  section('1. tickClock');
  {
    const c0: VectorClock = {};
    const c1 = tickClock(c0, 'node-a');
    assert(c1['node-a'] === 1, 'first tick sets counter to 1');
    assert(c0['node-a'] === undefined, 'tickClock does not mutate input');

    const c2 = tickClock(c1, 'node-a');
    assert(c2['node-a'] === 2, 'second tick increments to 2');

    const c3 = tickClock(c1, 'node-b');
    assert(c3['node-a'] === 1, 'ticking node-b preserves node-a counter');
    assert(c3['node-b'] === 1, 'ticking node-b sets node-b counter to 1');
  }

  // ==========================================================================
  // 2. mergeClock
  // ==========================================================================
  section('2. mergeClock');
  {
    const a: VectorClock = { 'node-a': 3, 'node-b': 1 };
    const b: VectorClock = { 'node-a': 1, 'node-b': 4 };
    const merged = mergeClock(a, b);
    assert(merged['node-a'] === 3, 'mergeClock takes max for node-a');
    assert(merged['node-b'] === 4, 'mergeClock takes max for node-b');
    assert(a['node-b'] === 1, 'mergeClock does not mutate first input');
    assert(b['node-a'] === 1, 'mergeClock does not mutate second input');

    const c: VectorClock = { 'node-c': 5 };
    const merged2 = mergeClock(a, c);
    assert(merged2['node-a'] === 3, 'mergeClock keeps node-a from first');
    assert(merged2['node-c'] === 5, 'mergeClock adds node-c from second');

    const empty = mergeClock({}, {});
    assert(Object.keys(empty).length === 0, 'merge of two empty clocks is empty');
  }

  // ==========================================================================
  // 3. happensBefore
  // ==========================================================================
  section('3. happensBefore');
  {
    const a: VectorClock = { 'node-a': 1 };
    const b: VectorClock = { 'node-a': 2 };
    assert(happensBefore(a, b) === true,  'a={1} happens-before b={2}');
    assert(happensBefore(b, a) === false, 'b={2} does NOT happen-before a={1}');

    const c: VectorClock = { 'node-a': 1, 'node-b': 0 };
    const d: VectorClock = { 'node-a': 1, 'node-b': 1 };
    assert(happensBefore(c, d) === true,  'c happens-before d (node-b 0<1)');
    assert(happensBefore(d, c) === false, 'd does NOT happen-before c');

    // Identical clocks — neither happens-before the other
    const e: VectorClock = { 'node-a': 2 };
    const f: VectorClock = { 'node-a': 2 };
    assert(happensBefore(e, f) === false, 'identical clocks: not happens-before');
    assert(happensBefore(f, e) === false, 'identical clocks: not happens-before (reversed)');

    // Empty clock happens-before any non-empty clock
    assert(happensBefore({}, { 'node-a': 1 }) === true,  'empty happens-before {1}');
    assert(happensBefore({ 'node-a': 1 }, {}) === false, '{1} does NOT happen-before empty');
  }

  // ==========================================================================
  // 4. isConcurrent
  // ==========================================================================
  section('4. isConcurrent');
  {
    // Causally ordered — not concurrent
    assert(isConcurrent({ 'node-a': 1 }, { 'node-a': 2 }) === false,
      'causally ordered clocks are not concurrent');

    // True concurrency: each advanced a different component
    const a: VectorClock = { 'node-a': 2, 'node-b': 1 };
    const b: VectorClock = { 'node-a': 1, 'node-b': 2 };
    assert(isConcurrent(a, b) === true,  'cross-incremented clocks are concurrent');
    assert(isConcurrent(b, a) === true,  'concurrency is symmetric');

    // Identical clocks — isConcurrent returns true (neither happens-before)
    assert(isConcurrent({ 'node-a': 1 }, { 'node-a': 1 }) === true,
      'identical clocks are treated as concurrent');
  }

  // ==========================================================================
  // 5. compareClock
  // ==========================================================================
  section('5. compareClock');
  {
    assert(compareClock({ 'node-a': 1 }, { 'node-a': 2 }) === -1,
      'compareClock returns -1 when a happened-before b');
    assert(compareClock({ 'node-a': 2 }, { 'node-a': 1 }) === 1,
      'compareClock returns 1 when b happened-before a');
    assert(compareClock({ 'node-a': 1, 'node-b': 2 }, { 'node-a': 2, 'node-b': 1 }) === 0,
      'compareClock returns 0 for concurrent clocks');
    assert(compareClock({ 'node-a': 1 }, { 'node-a': 1 }) === 0,
      'compareClock returns 0 for identical clocks');
  }

  // ==========================================================================
  // 6. mergeEntry — causal order (a happened-before b)
  // ==========================================================================
  section('6. mergeEntry causal: a happened-before b');
  {
    const base: Omit<CrdtEntry, 'vectorClock' | 'nodeId' | 'value'> = {
      key: 'x', source_agent: 'ag', timestamp: new Date().toISOString(),
      ttl: null, version: 1,
    };
    const a: CrdtEntry = { ...base, value: 'old', vectorClock: { 'n': 1 }, nodeId: 'n' };
    const b: CrdtEntry = { ...base, value: 'new', vectorClock: { 'n': 2 }, nodeId: 'n' };

    const winner = mergeEntry(a, b);
    assert(winner.value === 'new', 'b wins when a happened-before b');

    const winner2 = mergeEntry(b, a);
    assert(winner2.value === 'new', 'b still wins regardless of argument order');
  }

  // ==========================================================================
  // 7. mergeEntry — causal order (b happened-before a)
  // ==========================================================================
  section('7. mergeEntry causal: b happened-before a');
  {
    const base: Omit<CrdtEntry, 'vectorClock' | 'nodeId' | 'value'> = {
      key: 'x', source_agent: 'ag', timestamp: new Date().toISOString(),
      ttl: null, version: 1,
    };
    const a: CrdtEntry = { ...base, value: 'newer', vectorClock: { 'n': 3 }, nodeId: 'n' };
    const b: CrdtEntry = { ...base, value: 'older', vectorClock: { 'n': 1 }, nodeId: 'n' };

    const winner = mergeEntry(a, b);
    assert(winner.value === 'newer', 'a wins when b happened-before a');
  }

  // ==========================================================================
  // 8. mergeEntry — concurrent: timestamp tiebreak
  // ==========================================================================
  section('8. mergeEntry concurrent: timestamp tiebreak');
  {
    const t1 = new Date(Date.now() - 1000).toISOString();
    const t2 = new Date().toISOString();

    // Concurrent clocks: each node incremented its own counter
    const a: CrdtEntry = {
      key: 'x', value: 'early', source_agent: 'ag',
      timestamp: t1, ttl: null, version: 1,
      vectorClock: { 'node-a': 1, 'node-b': 0 }, nodeId: 'node-a',
    };
    const b: CrdtEntry = {
      key: 'x', value: 'late', source_agent: 'ag',
      timestamp: t2, ttl: null, version: 1,
      vectorClock: { 'node-a': 0, 'node-b': 1 }, nodeId: 'node-b',
    };

    const winner = mergeEntry(a, b);
    assert(winner.value === 'late',  'later timestamp wins for concurrent entries');
    const winner2 = mergeEntry(b, a);
    assert(winner2.value === 'late', 'result is independent of argument order');
  }

  // ==========================================================================
  // 9. mergeEntry — concurrent: nodeId tiebreak
  // ==========================================================================
  section('9. mergeEntry concurrent: nodeId tiebreak');
  {
    const ts = new Date().toISOString();
    const a: CrdtEntry = {
      key: 'x', value: 'from-node-a', source_agent: 'ag',
      timestamp: ts, ttl: null, version: 1,
      vectorClock: { 'node-a': 1 }, nodeId: 'node-a',
    };
    const b: CrdtEntry = {
      key: 'x', value: 'from-node-z', source_agent: 'ag',
      timestamp: ts, ttl: null, version: 1,
      vectorClock: { 'node-z': 1 }, nodeId: 'node-z',
    };

    // 'node-z' > 'node-a' lexicographically
    const winner = mergeEntry(a, b);
    assert(winner.nodeId === 'node-z', 'lexicographically larger nodeId wins on tie');
    const winner2 = mergeEntry(b, a);
    assert(winner2.nodeId === 'node-z', 'tie result stable regardless of order');
  }

  // ==========================================================================
  // 10. mergeEntry — tombstone wins over live entry with earlier clock
  // ==========================================================================
  section('10. mergeEntry: tombstone wins over stale live entry');
  {
    const ts = new Date().toISOString();
    const live: CrdtEntry = {
      key: 'x', value: 'alive', source_agent: 'ag',
      timestamp: ts, ttl: null, version: 1,
      vectorClock: { 'node-a': 1 }, nodeId: 'node-a',
    };
    const tomb: CrdtEntry = {
      key: 'x', value: null, source_agent: 'ag',
      timestamp: ts, ttl: null, version: 1,
      deleted: true,
      vectorClock: { 'node-a': 2 }, nodeId: 'node-a',
    };

    const winner = mergeEntry(live, tomb);
    assert(winner.deleted === true, 'tombstone with later clock wins over live entry');
    const winner2 = mergeEntry(tomb, live);
    assert(winner2.deleted === true, 'tombstone wins regardless of arg order');
  }

  // ==========================================================================
  // 11. CrdtBackend — construction
  // ==========================================================================
  section('11. CrdtBackend construction');
  {
    const explicit = new CrdtBackend('my-node');
    assert(explicit.nodeId === 'my-node', 'explicit nodeId is stored');

    const random = new CrdtBackend();
    assert(typeof random.nodeId === 'string' && random.nodeId.length > 0,
      'random nodeId is a non-empty string');
    assert(random.nodeId.startsWith('node-'), 'random nodeId starts with node-');

    const viaOptions = new CrdtBackend(undefined, { nodeId: 'opt-node' });
    assert(viaOptions.nodeId === 'opt-node', 'nodeId can be set via options');
  }

  // ==========================================================================
  // 12. CrdtBackend — initial state
  // ==========================================================================
  section('12. CrdtBackend initial state');
  {
    const node = new CrdtBackend('n1');
    assert(node.read('missing') === null,       'read returns null for missing key');
    assert(node.listKeys().length === 0,        'listKeys is empty on new node');
    assert(Object.keys(node.getSnapshot()).length === 0, 'getSnapshot is empty on new node');
    assert(Object.keys(node.getVectorClock()).length === 0, 'clock is empty on new node');
  }

  // ==========================================================================
  // 13. CrdtBackend — write and read
  // ==========================================================================
  section('13. CrdtBackend write and read');
  {
    const node = new CrdtBackend('n1');
    const entry = node.write('task', 'do dishes', 'agent-1');

    assert(entry.key === 'task',            'entry has correct key');
    assert(entry.value === 'do dishes',     'entry has correct value');
    assert(entry.source_agent === 'agent-1', 'entry has correct source_agent');
    assert(entry.version === 1,             'first write is version 1');
    assert(entry.ttl === null,              'no TTL by default');

    const read = node.read('task');
    assert(read !== null,                   'read finds the written entry');
    assert(read?.value === 'do dishes',     'read returns correct value');
  }

  // ==========================================================================
  // 14. CrdtBackend — version increments on overwrite
  // ==========================================================================
  section('14. CrdtBackend version increments');
  {
    const node = new CrdtBackend('n1');
    node.write('k', 'v1', 'ag');
    const e2 = node.write('k', 'v2', 'ag');
    assert(e2.version === 2, 'overwrite increments version to 2');
    const e3 = node.write('k', 'v3', 'ag');
    assert(e3.version === 3, 'second overwrite increments version to 3');
  }

  // ==========================================================================
  // 15. CrdtBackend — vector clock increments on write
  // ==========================================================================
  section('15. CrdtBackend vector clock grows on write');
  {
    const node = new CrdtBackend('n1');
    node.write('a', 1, 'ag');
    assert(node.getVectorClock()['n1'] === 1, 'clock at n1=1 after first write');
    node.write('b', 2, 'ag');
    assert(node.getVectorClock()['n1'] === 2, 'clock at n1=2 after second write');
    node.write('c', 3, 'ag');
    assert(node.getVectorClock()['n1'] === 3, 'clock at n1=3 after third write');
  }

  // ==========================================================================
  // 16. CrdtBackend — written entry carries vector clock and nodeId
  // ==========================================================================
  section('16. CrdtBackend entry carries CRDT metadata');
  {
    const node = new CrdtBackend('my-node');
    const entry = node.write('key', 'val', 'ag') as CrdtEntry;

    assert(entry.nodeId === 'my-node',            'entry.nodeId matches node');
    assert(entry.vectorClock['my-node'] === 1,    'entry.vectorClock has node counter = 1');
    assert(entry.deleted !== true,                'entry is not a tombstone');
  }

  // ==========================================================================
  // 17. CrdtBackend — delete creates tombstone
  // ==========================================================================
  section('17. CrdtBackend delete (tombstone)');
  {
    const node = new CrdtBackend('n1');
    node.write('k', 'v', 'ag');
    const deleted = node.delete('k');
    assert(deleted === true,          'delete returns true for existing key');
    assert(node.read('k') === null,   'read returns null after delete');

    const raw = node.getCrdtEntry('k');
    assert(raw !== null,              'getCrdtEntry still returns tombstone');
    assert(raw?.deleted === true,     'tombstone has deleted=true');
    assert(raw?.value === null,       'tombstone value is null');
  }

  // ==========================================================================
  // 18. CrdtBackend — delete returns false for missing / already-deleted
  // ==========================================================================
  section('18. CrdtBackend delete edge cases');
  {
    const node = new CrdtBackend('n1');
    assert(node.delete('never-written') === false, 'delete returns false for never-written key');

    node.write('k', 'v', 'ag');
    node.delete('k');
    assert(node.delete('k') === false, 'delete returns false for already-deleted key');
  }

  // ==========================================================================
  // 19. CrdtBackend — delete increments vector clock
  // ==========================================================================
  section('19. CrdtBackend delete increments vector clock');
  {
    const node = new CrdtBackend('n1');
    node.write('k', 'v', 'ag');
    assert(node.getVectorClock()['n1'] === 1, 'clock=1 after write');
    node.delete('k');
    assert(node.getVectorClock()['n1'] === 2, 'clock=2 after delete');
  }

  // ==========================================================================
  // 20. CrdtBackend — listKeys excludes deleted and expired
  // ==========================================================================
  section('20. CrdtBackend listKeys');
  {
    const node = new CrdtBackend('n1');
    node.write('a', 1, 'ag');
    node.write('b', 2, 'ag');
    node.write('c', 3, 'ag');
    node.delete('b');

    const keys = node.listKeys().sort();
    assert(keys.length === 2,    'listKeys returns 2 live keys');
    assert(keys[0] === 'a',      'listKeys includes a');
    assert(keys[1] === 'c',      'listKeys includes c');
    assert(!keys.includes('b'),  'listKeys excludes deleted b');
  }

  // ==========================================================================
  // 21. CrdtBackend — getSnapshot excludes deleted
  // ==========================================================================
  section('21. CrdtBackend getSnapshot');
  {
    const node = new CrdtBackend('n1');
    node.write('x', 10, 'ag');
    node.write('y', 20, 'ag');
    node.delete('x');

    const snap = node.getSnapshot();
    assert(Object.keys(snap).length === 1, 'snapshot has 1 entry after delete');
    assert(snap['y'] !== undefined,        'snapshot contains y');
    assert(snap['x'] === undefined,        'snapshot excludes deleted x');
  }

  // ==========================================================================
  // 22. CrdtBackend — getCrdtSnapshot includes tombstones
  // ==========================================================================
  section('22. CrdtBackend getCrdtSnapshot includes tombstones');
  {
    const node = new CrdtBackend('n1');
    node.write('k', 'v', 'ag');
    node.delete('k');

    const crdtSnap = node.getCrdtSnapshot();
    assert(Object.keys(crdtSnap).length === 1,  'CRDT snapshot has 1 raw entry');
    assert(crdtSnap['k'] !== undefined,         'CRDT snapshot includes tombstone');
    assert(crdtSnap['k'].deleted === true,       'included entry is tombstone');
  }

  // ==========================================================================
  // 23. CrdtBackend — merge: different keys (no conflict)
  // ==========================================================================
  section('23. CrdtBackend merge: no conflict (different keys)');
  {
    const nodeA = new CrdtBackend('node-a');
    const nodeB = new CrdtBackend('node-b');

    nodeA.write('from-a', 'hello', 'ag');
    nodeB.write('from-b', 'world', 'ag');

    nodeA.merge(Object.values(nodeB.getCrdtSnapshot()));

    const keys = nodeA.listKeys().sort();
    assert(keys.length === 2,           'after merge, nodeA has 2 keys');
    assert(keys.includes('from-a'),     'nodeA retains its own key');
    assert(keys.includes('from-b'),     'nodeA gains nodeB key after merge');
    assert(nodeA.read('from-b')?.value === 'world', 'merged value is correct');
  }

  // ==========================================================================
  // 24. CrdtBackend — merge: causal order (happened-before)
  // ==========================================================================
  section('24. CrdtBackend merge: causal order');
  {
    const nodeA = new CrdtBackend('node-a');
    const nodeB = new CrdtBackend('node-b');

    // nodeA writes first, nodeB knows about it and then overwrites
    nodeA.write('task', 'v1', 'ag');
    nodeB.merge(Object.values(nodeA.getCrdtSnapshot())); // nodeB learns v1
    nodeB.write('task', 'v2', 'ag');                     // nodeB writes v2 (causally after v1)

    // nodeA merges nodeB's update
    nodeA.merge(Object.values(nodeB.getCrdtSnapshot()));

    assert(nodeA.read('task')?.value === 'v2', 'causally later v2 wins after merge');
    assert(nodeB.read('task')?.value === 'v2', 'nodeB still has v2');
  }

  // ==========================================================================
  // 25. CrdtBackend — merge: concurrent writes (deterministic winner)
  // ==========================================================================
  section('25. CrdtBackend merge: concurrent writes converge');
  {
    const nodeA = new CrdtBackend('node-a');
    const nodeB = new CrdtBackend('node-b');

    // Both write to the same key independently (concurrent)
    nodeA.write('status', 'idle', 'ag');
    nodeB.write('status', 'busy', 'ag');

    // Sync both ways
    nodeA.sync(nodeB);

    const aValue = nodeA.read('status')?.value;
    const bValue = nodeB.read('status')?.value;

    assert(aValue !== undefined,  'nodeA has a value after sync');
    assert(bValue !== undefined,  'nodeB has a value after sync');
    assert(aValue === bValue,     'both nodes converge on the same value');
  }

  // ==========================================================================
  // 26. CrdtBackend — merge: idempotent (merge same entries twice)
  // ==========================================================================
  section('26. CrdtBackend merge: idempotent');
  {
    const nodeA = new CrdtBackend('node-a');
    const nodeB = new CrdtBackend('node-b');
    nodeB.write('k', 'v', 'ag');

    const entries = Object.values(nodeB.getCrdtSnapshot());
    nodeA.merge(entries);
    nodeA.merge(entries); // merge same entries again

    const keys = nodeA.listKeys();
    assert(keys.length === 1,             'idempotent: still 1 key after double merge');
    assert(nodeA.read('k')?.value === 'v', 'value unchanged after double merge');
  }

  // ==========================================================================
  // 27. CrdtBackend — merge: clock advances to max of incoming
  // ==========================================================================
  section('27. CrdtBackend merge: clock advances on incoming entries');
  {
    const nodeA = new CrdtBackend('node-a');
    const nodeB = new CrdtBackend('node-b');

    nodeB.write('k', 'v', 'ag'); // nodeB clock: { node-b: 1 }
    nodeB.write('k', 'v2', 'ag'); // nodeB clock: { node-b: 2 }

    nodeA.merge(Object.values(nodeB.getCrdtSnapshot()));

    // nodeA should now know about node-b's clock
    const clock = nodeA.getVectorClock();
    assert(clock['node-b'] === 2, 'nodeA clock advanced to node-b:2 after merge');
  }

  // ==========================================================================
  // 28. CrdtBackend — merge: tombstone propagates
  // ==========================================================================
  section('28. CrdtBackend merge: tombstone propagates');
  {
    const nodeA = new CrdtBackend('node-a');
    const nodeB = new CrdtBackend('node-b');

    // nodeA writes a key, nodeB learns it
    nodeA.write('item', 'value', 'ag');
    nodeB.merge(Object.values(nodeA.getCrdtSnapshot()));
    assert(nodeB.read('item')?.value === 'value', 'nodeB has item before delete');

    // nodeA deletes the key
    nodeA.delete('item');
    assert(nodeA.read('item') === null, 'nodeA: item deleted');

    // Sync to propagate tombstone
    nodeB.merge(Object.values(nodeA.getCrdtSnapshot()));
    assert(nodeB.read('item') === null, 'tombstone propagated: nodeB item is now null');
    assert(nodeB.getCrdtEntry('item')?.deleted === true, 'nodeB has tombstone in raw store');
  }

  // ==========================================================================
  // 29. CrdtBackend — sync: bidirectional (both nodes get each other's keys)
  // ==========================================================================
  section('29. CrdtBackend sync: bidirectional');
  {
    const nodeA = new CrdtBackend('node-a');
    const nodeB = new CrdtBackend('node-b');

    nodeA.write('from-a', 'A', 'ag');
    nodeB.write('from-b', 'B', 'ag');

    nodeA.sync(nodeB);

    assert(nodeA.read('from-a')?.value === 'A', 'nodeA has own key');
    assert(nodeA.read('from-b')?.value === 'B', 'nodeA gained nodeB key');
    assert(nodeB.read('from-a')?.value === 'A', 'nodeB gained nodeA key');
    assert(nodeB.read('from-b')?.value === 'B', 'nodeB has own key');
  }

  // ==========================================================================
  // 30. CrdtBackend — sync: three-node convergence
  // ==========================================================================
  section('30. CrdtBackend sync: three-node convergence');
  {
    const nodeA = new CrdtBackend('node-a');
    const nodeB = new CrdtBackend('node-b');
    const nodeC = new CrdtBackend('node-c');

    nodeA.write('shared', 'from-a', 'ag');
    nodeB.write('shared', 'from-b', 'ag');
    nodeC.write('shared', 'from-c', 'ag');

    // Sync A↔B, then A↔C, then B↔C
    nodeA.sync(nodeB);
    nodeA.sync(nodeC);
    nodeB.sync(nodeC);

    const aVal = nodeA.read('shared')?.value;
    const bVal = nodeB.read('shared')?.value;
    const cVal = nodeC.read('shared')?.value;

    assert(aVal === bVal, 'nodeA and nodeB converge on same value');
    assert(bVal === cVal, 'nodeB and nodeC converge on same value');
    assert(aVal !== undefined, 'converged value is defined');
  }

  // ==========================================================================
  // 31. CrdtBackend — TTL: expired entries invisible to read/listKeys/getSnapshot
  // ==========================================================================
  section('31. CrdtBackend TTL expiry');
  {
    const node = new CrdtBackend('n1');
    // Write with a very small TTL that we'll fake by back-dating the timestamp
    node.write('expiring', 'soon', 'ag', 1);

    // Manually back-date the entry by 2 seconds to simulate expiry
    const raw = node.getCrdtEntry('expiring');
    if (raw) {
      const backdated: CrdtEntry = {
        ...raw,
        timestamp: new Date(Date.now() - 2000).toISOString(),
      };
      // Access internal store via merge (same node, so it will lose to newer... 
      // instead do it via direct reassignment by writing a stale entry to another node)
      const nodeB = new CrdtBackend('n2');
      nodeB.merge([backdated]);

      assert(nodeB.read('expiring') === null,           'expired TTL: read returns null');
      assert(!nodeB.listKeys().includes('expiring'),    'expired TTL: not in listKeys');
      assert(nodeB.getSnapshot()['expiring'] === undefined, 'expired TTL: not in snapshot');
    } else {
      assert(false, 'could not retrieve raw entry for TTL test');
    }
  }

  // ==========================================================================
  // 32. CrdtBackend — write with TTL stores ttl on entry
  // ==========================================================================
  section('32. CrdtBackend write with TTL');
  {
    const node = new CrdtBackend('n1');
    const entry = node.write('k', 'v', 'ag', 60);
    assert(entry.ttl === 60, 'entry.ttl is set to provided TTL');

    const entryNoTtl = node.write('k2', 'v', 'ag');
    assert(entryNoTtl.ttl === null, 'entry.ttl is null when not provided');
  }

  // ==========================================================================
  // 33. CrdtBackend — write after delete resets version to 1
  // ==========================================================================
  section('33. CrdtBackend re-write after delete resets version');
  {
    const node = new CrdtBackend('n1');
    node.write('k', 'v1', 'ag');
    node.write('k', 'v2', 'ag'); // version 2
    node.delete('k');
    const e = node.write('k', 'v3', 'ag'); // should be version 1 again
    assert(e.version === 1, 're-write after delete starts version at 1');
  }

  // ==========================================================================
  // 34. CrdtBackend — concurrent sync is associative and commutative
  // ==========================================================================
  section('34. CrdtBackend sync: commutative convergence');
  {
    const nodeA = new CrdtBackend('node-a');
    const nodeB = new CrdtBackend('node-b');
    nodeA.write('k', 'a-value', 'ag');
    nodeB.write('k', 'b-value', 'ag');

    // Order 1: sync A→B first
    const nodeA1 = new CrdtBackend('node-a');
    const nodeB1 = new CrdtBackend('node-b');
    nodeA1.write('k', 'a-value', 'ag');
    nodeB1.write('k', 'b-value', 'ag');
    nodeA1.sync(nodeB1);
    const result1 = nodeA1.read('k')?.value;

    // Order 2: sync B→A first (swap order of sync args)
    const nodeA2 = new CrdtBackend('node-a');
    const nodeB2 = new CrdtBackend('node-b');
    nodeA2.write('k', 'a-value', 'ag');
    nodeB2.write('k', 'b-value', 'ag');
    nodeB2.sync(nodeA2);
    const result2 = nodeA2.read('k')?.value;

    assert(result1 === result2, 'sync outcome is commutative (order of sync call does not matter)');
  }

  // ==========================================================================
  // 35. Export verification
  // ==========================================================================
  section('35. Export verification');
  {
    // Verify all exports exist via require
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crdtLib = require('./lib/crdt');
    assert(typeof crdtLib.tickClock === 'function',    'crdt.ts exports tickClock');
    assert(typeof crdtLib.mergeClock === 'function',   'crdt.ts exports mergeClock');
    assert(typeof crdtLib.happensBefore === 'function','crdt.ts exports happensBefore');
    assert(typeof crdtLib.isConcurrent === 'function', 'crdt.ts exports isConcurrent');
    assert(typeof crdtLib.compareClock === 'function', 'crdt.ts exports compareClock');
    assert(typeof crdtLib.mergeEntry === 'function',   'crdt.ts exports mergeEntry');

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const backendLib = require('./lib/blackboard-backend-crdt');
    assert(typeof backendLib.CrdtBackend === 'function', 'blackboard-backend-crdt.ts exports CrdtBackend');

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const indexLib = require('./index');
    assert(typeof indexLib.CrdtBackend === 'function', 'index.ts exports CrdtBackend');
  }

  // ==========================================================================
  // SUMMARY
  // ==========================================================================
  console.log('\n' + '='.repeat(60));
  if (failed === 0) {
    console.log(`ALL ${passed} PHASE 5d TESTS PASSED`);
  } else {
    console.log(`${passed} passed, ${failed} FAILED`);
    console.log('\nFailed tests:');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
