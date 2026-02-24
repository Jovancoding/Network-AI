/**
 * Redis Blackboard Backend
 *
 * Provides a `RedisBackend` implementation of `BlackboardBackend` suitable for
 * multi-process and multi-machine agent coordination. Data is shared across all
 * processes that connect to the same Redis server.
 *
 * Architecture — write-through cache:
 *   Reads  → served from a local in-memory cache (fast, sync)
 *   Writes → written to local cache immediately, then flushed to Redis async
 *   Hydrate → on startup, loads existing keys from Redis into the local cache
 *
 * This design keeps the synchronous `BlackboardBackend` interface intact while
 * still leveraging Redis for distributed coordination.
 *
 * Peer dependency:
 *   Install `ioredis`, `node-redis`, or any Redis client that satisfies the
 *   minimal `RedisClient` interface defined below. No production dependency is
 *   added to network-ai — Redis is optional and user-supplied.
 *
 *   npm install ioredis        # recommended
 *   # or
 *   npm install redis          # node-redis v4+
 *
 * @example
 * ```typescript
 * import Redis from 'ioredis';
 * import { RedisBackend } from 'network-ai/lib/blackboard-backend-redis';
 *
 * const client = new Redis({ host: 'localhost', port: 6379 });
 * const backend = new RedisBackend(client, { keyPrefix: 'myapp:bb:' });
 * await backend.hydrate(); // load existing data from Redis
 *
 * const board = orchestrator.getBlackboard('prod', { backend });
 * ```
 *
 * @module BlackboardBackendRedis
 * @version 1.0.0
 * @license MIT
 */

import type { BlackboardBackend, BlackboardEntry } from './blackboard-backend';

// ============================================================================
// MINIMAL REDIS CLIENT INTERFACE
// Compatible with ioredis, node-redis v4+, and any client that exposes these
// methods. No hard dependency on any specific Redis package.
// ============================================================================

/**
 * Minimal pipeline interface — returned by `client.pipeline()` or
 * `client.multi()`. Only the methods used by `RedisBackend` are required.
 */
export interface RedisPipeline {
  set(key: string, value: string): this;
  set(key: string, value: string, exArg: 'EX', seconds: number): this;
  exec(): Promise<unknown[]>;
}

/**
 * Minimal Redis client interface.
 *
 * Any client that satisfies this shape can be used — ioredis, node-redis v4+,
 * or a custom mock for testing.
 */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, exArg: 'EX', seconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  pipeline(): RedisPipeline;
}

// ============================================================================
// OPTIONS
// ============================================================================

export interface RedisBackendOptions {
  /**
   * Prefix prepended to every Redis key.
   * Useful for namespacing multiple boards on the same Redis server.
   * @default 'network-ai:bb:'
   */
  keyPrefix?: string;
}

// ============================================================================
// REDIS BACKEND
// ============================================================================

/**
 * Redis-backed `BlackboardBackend` for multi-process / multi-machine
 * agent coordination.
 *
 * Uses a write-through local cache so reads remain synchronous and fast.
 * Call `hydrate()` after construction to load any pre-existing Redis data
 * into the local cache before your agents start reading.
 *
 * @example
 * ```typescript
 * import Redis from 'ioredis';
 * import { RedisBackend } from 'network-ai/lib/blackboard-backend-redis';
 *
 * const client = new Redis();
 * const backend = new RedisBackend(client, { keyPrefix: 'project-x:bb:' });
 * await backend.hydrate();
 *
 * const board = orchestrator.getBlackboard('shared', { backend });
 * ```
 */
export class RedisBackend implements BlackboardBackend {
  private cache: Map<string, BlackboardEntry> = new Map();
  private client: RedisClient;
  private keyPrefix: string;
  private _ready: boolean = false;

  constructor(client: RedisClient, options?: RedisBackendOptions) {
    this.client = client;
    this.keyPrefix = options?.keyPrefix ?? 'network-ai:bb:';
  }

  // --------------------------------------------------------------------------
  // BlackboardBackend interface
  // --------------------------------------------------------------------------

  /**
   * Read a single entry from the local cache.
   * Returns `null` if not found or TTL has expired.
   */
  read(key: string): BlackboardEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (this._isExpired(entry)) {
      this.cache.delete(key);
      // Async eviction from Redis
      this.client.del(this.keyPrefix + key).catch(() => {});
      return null;
    }
    return entry;
  }

  /**
   * Write a value to the local cache and push to Redis asynchronously.
   * The write is immediately visible to all local reads.
   */
  write(key: string, value: unknown, sourceAgent: string, ttl?: number): BlackboardEntry {
    const existing = this.cache.get(key);
    const version = existing ? existing.version + 1 : 1;

    const entry: BlackboardEntry = {
      key,
      value,
      source_agent: sourceAgent,
      timestamp: new Date().toISOString(),
      ttl: ttl ?? null,
      version,
    };

    this.cache.set(key, entry);
    this._pushToRedis(key, entry, ttl);
    return entry;
  }

  /**
   * Delete an entry from the local cache and Redis asynchronously.
   * Returns `true` if the key existed.
   */
  delete(key: string): boolean {
    const existed = this.cache.has(key);
    this.cache.delete(key);
    this.client.del(this.keyPrefix + key).catch(() => {});
    return existed;
  }

  /**
   * Return all non-expired keys from the local cache.
   */
  listKeys(): string[] {
    return Array.from(this.cache.entries())
      .filter(([, entry]) => !this._isExpired(entry))
      .map(([key]) => key);
  }

  /**
   * Return a full snapshot of all non-expired entries from the local cache.
   */
  getSnapshot(): Record<string, BlackboardEntry> {
    const result: Record<string, BlackboardEntry> = {};
    for (const [key, entry] of this.cache.entries()) {
      if (!this._isExpired(entry)) {
        result[key] = entry;
      }
    }
    return result;
  }

  // --------------------------------------------------------------------------
  // Extended Redis API
  // --------------------------------------------------------------------------

  /**
   * Load all existing entries from Redis into the local cache.
   *
   * Call this once after construction before your agents start reading, so the
   * local cache reflects any state written by other processes.
   *
   * @example
   * ```typescript
   * const backend = new RedisBackend(client);
   * await backend.hydrate();
   * ```
   */
  async hydrate(): Promise<void> {
    const redisKeys = await this.client.keys(`${this.keyPrefix}*`);
    for (const redisKey of redisKeys) {
      const raw = await this.client.get(redisKey);
      if (raw) {
        try {
          const entry = JSON.parse(raw) as BlackboardEntry;
          const localKey = redisKey.slice(this.keyPrefix.length);
          if (!this._isExpired(entry)) {
            this.cache.set(localKey, entry);
          }
        } catch {
          // Skip malformed entries
        }
      }
    }
    this._ready = true;
  }

  /**
   * Flush all local cache entries to Redis in a single pipeline.
   *
   * Useful for ensuring durability before a graceful shutdown, or for
   * synchronising a newly-started process with the latest in-memory state.
   */
  async flush(): Promise<void> {
    const pipeline = this.client.pipeline();
    for (const [key, entry] of this.cache.entries()) {
      if (this._isExpired(entry)) continue;
      const redisKey = this.keyPrefix + key;
      const raw = JSON.stringify(entry);
      if (entry.ttl) {
        // Calculate remaining TTL in seconds
        const elapsed = (Date.now() - new Date(entry.timestamp).getTime()) / 1000;
        const remaining = Math.max(1, Math.ceil(entry.ttl - elapsed));
        pipeline.set(redisKey, raw, 'EX', remaining);
      } else {
        pipeline.set(redisKey, raw);
      }
    }
    await pipeline.exec();
  }

  /**
   * Clear the local cache. Does NOT delete keys in Redis.
   * Call `hydrate()` afterwards to reload from Redis.
   */
  clearCache(): void {
    this.cache.clear();
    this._ready = false;
  }

  /**
   * `true` after `hydrate()` has completed at least once.
   */
  get isReady(): boolean {
    return this._ready;
  }

  /**
   * Number of entries currently in the local cache
   * (including expired entries not yet evicted).
   */
  get cacheSize(): number {
    return this.cache.size;
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private _isExpired(entry: BlackboardEntry): boolean {
    if (!entry.ttl) return false;
    return Date.now() > new Date(entry.timestamp).getTime() + entry.ttl * 1000;
  }

  private _pushToRedis(key: string, entry: BlackboardEntry, ttl?: number): void {
    const redisKey = this.keyPrefix + key;
    const raw = JSON.stringify(entry);
    if (ttl) {
      this.client.set(redisKey, raw, 'EX', ttl).catch(() => {});
    } else {
      this.client.set(redisKey, raw).catch(() => {});
    }
  }
}
