/**
 * test-phase5c.ts -- Phase 5 Part 3: Redis Blackboard Backend
 *
 * Tests for RedisBackend -- uses a fully in-process mock Redis client so no
 * real Redis server is required. The mock faithfully implements the RedisClient
 * interface including pipeline, EX (TTL), and keys() pattern matching.
 *
 * Run: npx ts-node test-phase5c.ts
 */

import { RedisBackend } from './lib/blackboard-backend-redis';
import type { RedisClient, RedisPipeline } from './lib/blackboard-backend-redis';
import type { BlackboardBackend } from './lib/blackboard-backend';

// ============================================================================
// HELPERS
// ============================================================================

let passed = 0;
let failed = 0;
const errors: string[] = [];

function pass(label: string): void {
  passed++;
  process.stdout.write(`  [PASS] ${label}\n`);
}

function fail(label: string, reason: string): void {
  failed++;
  errors.push(`  [FAIL] ${label}: ${reason}`);
  process.stdout.write(`  [FAIL] ${label}: ${reason}\n`);
}

function assert(condition: boolean, label: string, reason = 'assertion failed'): void {
  condition ? pass(label) : fail(label, reason);
}

function section(title: string): void {
  process.stdout.write(`\n--- ${title} ---\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================================
// MOCK REDIS CLIENT
// Fully in-memory mock that satisfies the RedisClient interface.
// Supports EX (TTL), keys() pattern matching, and pipeline.
// ============================================================================

interface MockEntry {
  value: string;
  expiresAt: number | null; // epoch ms, null = no expiry
}

class MockRedisClient implements RedisClient {
  public store: Map<string, MockEntry> = new Map();
  public callLog: string[] = [];

  private _isExpired(entry: MockEntry): boolean {
    if (!entry.expiresAt) return false;
    return Date.now() > entry.expiresAt;
  }

  async get(key: string): Promise<string | null> {
    this.callLog.push(`get:${key}`);
    const entry = this.store.get(key);
    if (!entry || this._isExpired(entry)) return null;
    return entry.value;
  }

  async set(key: string, value: string, exArg?: 'EX', seconds?: number): Promise<string> {
    this.callLog.push(`set:${key}`);
    const expiresAt = (exArg === 'EX' && seconds) ? Date.now() + seconds * 1000 : null;
    this.store.set(key, { value, expiresAt });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      this.callLog.push(`del:${key}`);
      if (this.store.delete(key)) count++;
    }
    return count;
  }

  async keys(pattern: string): Promise<string[]> {
    this.callLog.push(`keys:${pattern}`);
    // Convert Redis glob pattern to regex (support * wildcard only)
    const regexStr = '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
    const regex = new RegExp(regexStr);
    return Array.from(this.store.keys()).filter(k => regex.test(k) && !this._isExpired(this.store.get(k)!));
  }

  pipeline(): RedisPipeline {
    this.callLog.push('pipeline');
    const ops: Array<() => Promise<unknown>> = [];
    const pip: RedisPipeline = {
      set: (key: string, value: string, exArg?: 'EX', seconds?: number) => {
        ops.push(() => this.set(key, value, exArg as 'EX', seconds as number));
        return pip;
      },
      exec: async () => {
        const results: unknown[] = [];
        for (const op of ops) results.push(await op());
        return results;
      },
    };
    return pip;
  }

  /** Test helper: raw store access bypassing TTL */
  getRaw(key: string): MockEntry | undefined {
    return this.store.get(key);
  }

  clearLog(): void {
    this.callLog = [];
  }
}

// ============================================================================
// MAIN TEST RUNNER (async to allow hydrate/flush/await)
// ============================================================================

async function main(): Promise<void> {

section('1. Construction and interface compliance');
{
  const client = new MockRedisClient();
  const backend = new RedisBackend(client);

  assert(backend instanceof RedisBackend, 'RedisBackend instantiates');
  assert(typeof backend.read === 'function', 'implements read()');
  assert(typeof backend.write === 'function', 'implements write()');
  assert(typeof backend.delete === 'function', 'implements delete()');
  assert(typeof backend.listKeys === 'function', 'implements listKeys()');
  assert(typeof backend.getSnapshot === 'function', 'implements getSnapshot()');

  // Satisfies BlackboardBackend interface (compile-time check via assignment)
  const _typed: BlackboardBackend = backend;
  assert(_typed !== undefined, 'satisfies BlackboardBackend interface');

  assert(backend.isReady === false, 'isReady is false before hydrate()');
  assert(backend.cacheSize === 0, 'cacheSize starts at 0');
}

section('2. Basic write and read');
{
  const backend = new RedisBackend(new MockRedisClient());

  const entry = backend.write('hello', 'world', 'agent-1');
  assert(entry.key === 'hello', 'write returns entry with correct key');
  assert(entry.value === 'world', 'write returns entry with correct value');
  assert(entry.source_agent === 'agent-1', 'write stores source_agent');
  assert(entry.version === 1, 'first write has version 1');
  assert(entry.ttl === null, 'write without ttl stores null');
  assert(typeof entry.timestamp === 'string', 'timestamp is a string');

  const read = backend.read('hello');
  assert(read !== null, 'read returns entry after write');
  assert(read?.value === 'world', 'read returns correct value');
}

section('3. Read miss');
{
  const backend = new RedisBackend(new MockRedisClient());
  const result = backend.read('nonexistent');
  assert(result === null, 'read returns null for missing key');
}

section('4. Version increment on overwrite');
{
  const backend = new RedisBackend(new MockRedisClient());
  backend.write('k', 'v1', 'agent-1');
  const e2 = backend.write('k', 'v2', 'agent-1');
  const e3 = backend.write('k', 'v3', 'agent-1');
  assert(e2.version === 2, 'second write increments version to 2');
  assert(e3.version === 3, 'third write increments version to 3');
  assert(backend.read('k')?.value === 'v3', 'latest value is returned');
}

section('5. Delete');
{
  const backend = new RedisBackend(new MockRedisClient());
  backend.write('del-me', 42, 'agent-1');
  assert(backend.read('del-me') !== null, 'entry exists before delete');

  const result = backend.delete('del-me');
  assert(result === true, 'delete returns true for existing key');
  assert(backend.read('del-me') === null, 'entry gone after delete');

  const result2 = backend.delete('del-me');
  assert(result2 === false, 'delete returns false for already-deleted key');
}

section('6. listKeys');
{
  const backend = new RedisBackend(new MockRedisClient());
  backend.write('a', 1, 'agent');
  backend.write('b', 2, 'agent');
  backend.write('c', 3, 'agent');
  const keys = backend.listKeys();
  assert(keys.length === 3, 'listKeys returns 3 keys');
  assert(keys.includes('a') && keys.includes('b') && keys.includes('c'), 'all keys present');

  backend.delete('b');
  assert(backend.listKeys().length === 2, 'listKeys reflects deletion');
}

section('7. getSnapshot');
{
  const backend = new RedisBackend(new MockRedisClient());
  backend.write('x', 10, 'agent');
  backend.write('y', 20, 'agent');
  const snap = backend.getSnapshot();
  assert(typeof snap === 'object', 'getSnapshot returns object');
  assert(snap['x']?.value === 10, 'snapshot contains x');
  assert(snap['y']?.value === 20, 'snapshot contains y');
  assert(Object.keys(snap).length === 2, 'snapshot has 2 entries');
}

section('8. TTL expiry in local cache');
{
  const backend = new RedisBackend(new MockRedisClient());
  // Write with 1 second TTL
  backend.write('short-lived', 'bye', 'agent', 1);
  assert(backend.read('short-lived') !== null, 'entry readable immediately');

  // Manually backdate the entry to simulate expiry
  const snap = (backend as any).cache as Map<string, any>;
  const entry = snap.get('short-lived');
  entry.timestamp = new Date(Date.now() - 2000).toISOString(); // 2s ago
  snap.set('short-lived', entry);

  assert(backend.read('short-lived') === null, 'expired entry returns null');
  assert(!backend.listKeys().includes('short-lived'), 'expired key not in listKeys');
  assert(backend.getSnapshot()['short-lived'] === undefined, 'expired entry not in snapshot');
}

  section('9. Write-through -- Redis client is called on write');
  {
    const client = new MockRedisClient();
    const backend = new RedisBackend(client);
    client.clearLog();

    backend.write('wt-key', 'wt-val', 'agent');
    await sleep(10);

    const setCall = client.callLog.find(l => l.startsWith('set:'));
    assert(setCall !== undefined, 'Redis set() called on write');
    const containsPrefix = setCall !== undefined && setCall.includes('network-ai:bb:wt-key');
    assert(containsPrefix, 'Redis key uses default prefix');
  }

  section('10. Write-through with TTL -- Redis gets EX');
  {
    const client = new MockRedisClient();
    const backend = new RedisBackend(client);

    backend.write('ttl-key', 'ttl-val', 'agent', 60);
    await sleep(10);

    const raw = client.getRaw('network-ai:bb:ttl-key');
    assert(raw !== undefined, 'Redis entry created');
    assert(raw !== undefined && raw.expiresAt !== null, 'Redis entry has expiry set');
  }

  section('11. Delete -- Redis del() is called');
  {
    const client = new MockRedisClient();
    const backend = new RedisBackend(client);
    backend.write('del-key', 'val', 'agent');
    await sleep(10);
    client.clearLog();

    backend.delete('del-key');
    await sleep(10);

    const delCall = client.callLog.find(l => l.startsWith('del:'));
    assert(delCall !== undefined, 'Redis del() called on delete');
  }

  section('12. Custom keyPrefix');
  {
    const client = new MockRedisClient();
    const backend = new RedisBackend(client, { keyPrefix: 'myapp:v2:' });
    backend.write('prefixed', 'val', 'agent');
    await sleep(10);

    const raw = client.getRaw('myapp:v2:prefixed');
    assert(raw !== undefined, 'custom prefix used in Redis key');

    const defaultRaw = client.getRaw('network-ai:bb:prefixed');
    assert(defaultRaw === undefined, 'default prefix NOT used');
  }

  section('13. hydrate() -- loads from Redis into local cache');
  {
    const client = new MockRedisClient();
    const seedBackend = new RedisBackend(client, { keyPrefix: 'test:' });
    seedBackend.write('existing-1', 'alpha', 'agent-seed');
    seedBackend.write('existing-2', 'beta', 'agent-seed');
    await sleep(10);

    const freshBackend = new RedisBackend(client, { keyPrefix: 'test:' });
    assert(freshBackend.read('existing-1') === null, 'empty cache before hydrate');
    assert(freshBackend.isReady === false, 'not ready before hydrate');

    await freshBackend.hydrate();

    assert(freshBackend.isReady === true, 'isReady true after hydrate');
    assert(freshBackend.read('existing-1')?.value === 'alpha', 'existing-1 loaded from Redis');
    assert(freshBackend.read('existing-2')?.value === 'beta', 'existing-2 loaded from Redis');
    assert(freshBackend.cacheSize === 2, 'cacheSize reflects hydrated entries');
  }

  section('14. hydrate() skips expired entries');
  {
    const client = new MockRedisClient();
    const expiredEntry = {
      key: 'expired-key',
      value: 'old',
      source_agent: 'agent',
      timestamp: new Date(Date.now() - 10000).toISOString(),
      ttl: 1,
      version: 1,
    };
    client.store.set('net:expired-key', { value: JSON.stringify(expiredEntry), expiresAt: null });

    const backend = new RedisBackend(client, { keyPrefix: 'net:' });
    await backend.hydrate();

    assert(backend.read('expired-key') === null, 'expired entry not loaded by hydrate');
  }

  section('15. flush() -- writes all cache entries to Redis pipeline');
  {
    const client = new MockRedisClient();
    const backend = new RedisBackend(client, { keyPrefix: 'flush:' });
    backend.write('a', 1, 'agent');
    backend.write('b', 2, 'agent');
    backend.write('c', 3, 'agent', 600);

    client.store.clear();
    assert(client.store.size === 0, 'Redis store empty before flush');

    await backend.flush();

    assert(client.store.has('flush:a'), 'flush:a written to Redis');
    assert(client.store.has('flush:b'), 'flush:b written to Redis');
    assert(client.store.has('flush:c'), 'flush:c written to Redis');

    const cEntry = client.getRaw('flush:c');
    assert(cEntry !== undefined && cEntry.expiresAt !== null, 'flush:c written with TTL');
  }

  section('16. clearCache() -- empties local cache, isReady resets');
  {
    const client = new MockRedisClient();
    const backend = new RedisBackend(client);
    backend.write('tmp', 'val', 'agent');
    await backend.hydrate();

    assert(backend.cacheSize > 0, 'cache has entries before clear');
    assert(backend.isReady === true, 'isReady true before clear');

    backend.clearCache();

    assert(backend.cacheSize === 0, 'cacheSize is 0 after clearCache');
    assert(backend.isReady === false, 'isReady false after clearCache');
    assert(backend.read('tmp') === null, 'entry no longer readable after clearCache');
  }

  section('17. Multiple backends isolated by keyPrefix');
  {
    const client = new MockRedisClient();
    const backendA = new RedisBackend(client, { keyPrefix: 'boardA:' });
    const backendB = new RedisBackend(client, { keyPrefix: 'boardB:' });

    backendA.write('shared-key', 'value-from-A', 'agent');
    backendB.write('shared-key', 'value-from-B', 'agent');

    assert(backendA.read('shared-key')?.value === 'value-from-A', 'board A reads its own value');
    assert(backendB.read('shared-key')?.value === 'value-from-B', 'board B reads its own value');

    await sleep(10);
    assert(client.store.has('boardA:shared-key'), 'boardA:shared-key in Redis');
    assert(client.store.has('boardB:shared-key'), 'boardB:shared-key in Redis');
  }

  section('18. flush() + hydrate() round-trip');
  {
    const client = new MockRedisClient();
    const writer = new RedisBackend(client, { keyPrefix: 'rt:' });
    writer.write('round', 'trip-value', 'agent-writer');
    await writer.flush();

    const reader = new RedisBackend(client, { keyPrefix: 'rt:' });
    await reader.hydrate();

    const entry = reader.read('round');
    assert(entry?.value === 'trip-value', 'round-trip: value survives flush+hydrate');
    assert(entry?.source_agent === 'agent-writer', 'round-trip: source_agent preserved');
    assert(entry?.version === 1, 'round-trip: version preserved');
  }

  section('19. getSnapshot excludes deleted entries');
  {
    const backend = new RedisBackend(new MockRedisClient());
    backend.write('keep', 1, 'agent');
    backend.write('remove', 2, 'agent');
    backend.delete('remove');

    const snap = backend.getSnapshot();
    assert(snap['keep'] !== undefined, 'kept entry in snapshot');
    assert(snap['remove'] === undefined, 'deleted entry not in snapshot');
    assert(Object.keys(snap).length === 1, 'snapshot has exactly 1 entry');
  }

  section('20. Export verification');
  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('./lib/blackboard-backend-redis');
    assert(typeof mod.RedisBackend === 'function', 'RedisBackend exported from lib module');

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const indexMod = require('./index');
    assert(typeof indexMod.RedisBackend === 'function', 'RedisBackend exported from index');
    assert(indexMod.RedisBackend === mod.RedisBackend, 'same class reference from both');
  }

  // ==========================================================================
  // SUMMARY
  // ==========================================================================

  const total = passed + failed;
  process.stdout.write('\n' + '='.repeat(60) + '\n');
  if (failed === 0) {
    process.stdout.write(`  ALL ${total} PHASE 5c TESTS PASSED\n`);
  } else {
    process.stdout.write(`  ${passed}/${total} passed, ${failed} FAILED\n`);
    for (const e of errors) process.stdout.write(e + '\n');
  }
  process.stdout.write('='.repeat(60) + '\n');

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  process.stderr.write(`Unexpected error: ${err}\n`);
  process.exit(1);
});