/**
 * Configurable Consistency Levels for Blackboard Backends
 *
 * Wraps any `BlackboardBackend` with one of three consistency guarantees:
 *
 *  - `'eventual'`  (default) — writes return immediately; async replication
 *                              happens in the background. Highest throughput.
 *  - `'session'`             — read-your-writes guarantee. Every write made
 *                              by this instance is immediately visible to
 *                              subsequent reads, even before it propagates to
 *                              other nodes. Tracked in a local session cache.
 *  - `'strong'`              — writes are flushed to the backend before the
 *                              async `writeAsync()` resolves. For backends
 *                              that implement `FlushableBackend` (e.g.
 *                              `RedisBackend`, `CrdtBackend`) this guarantees
 *                              durability before the caller continues.
 *
 * Usage:
 * ```typescript
 * import { MemoryBackend } from './blackboard-backend';
 * import { ConsistentBackend } from './consistency';
 *
 * const backend = new ConsistentBackend(new MemoryBackend(), 'session');
 * backend.write('k', 'v', 'agent-1');
 * backend.read('k'); // always returns 'v' in this session
 * ```
 *
 * Integration with `getBlackboard()`:
 * ```typescript
 * const board = orchestrator.getBlackboard('live', {
 *   backend: new RedisBackend(client),
 *   consistency: 'strong',
 * });
 * ```
 *
 * @module Consistency
 * @version 1.0.0
 * @license MIT
 */

import type { BlackboardBackend, BlackboardEntry } from './blackboard-backend';

// ============================================================================
// TYPES
// ============================================================================

/**
 * The three supported consistency levels.
 *
 * | Level      | Read guarantee        | Write latency | Best for                        |
 * |------------|-----------------------|---------------|---------------------------------|
 * | `eventual` | Stale reads possible  | Lowest        | High-throughput, async pipelines|
 * | `session`  | Read-your-writes      | Low           | Single-node agent sessions      |
 * | `strong`   | Durable after `writeAsync` | Higher   | Critical state, audit trails    |
 */
export type ConsistencyLevel = 'eventual' | 'session' | 'strong';

// ============================================================================
// FLUSHABLE BACKEND
// ============================================================================

/**
 * Optional extension of `BlackboardBackend` for backends that support an
 * explicit flush operation (e.g. `RedisBackend`, `CrdtBackend`).
 *
 * `ConsistentBackend` automatically detects this interface at runtime and
 * uses it for `'strong'` consistency writes via `writeAsync()`.
 */
export interface FlushableBackend extends BlackboardBackend {
  /**
   * Flush all pending writes to the durable store.
   * Called by `ConsistentBackend` after each write under `'strong'` consistency.
   */
  flush(): Promise<void>;
}

/**
 * Type guard — returns `true` if `backend` implements `FlushableBackend`.
 *
 * @example
 * ```typescript
 * if (isFlushable(backend)) {
 *   await backend.flush();
 * }
 * ```
 */
export function isFlushable(backend: BlackboardBackend): backend is FlushableBackend {
  return typeof (backend as FlushableBackend).flush === 'function';
}

// ============================================================================
// CONSISTENT BACKEND
// ============================================================================

/**
 * A `BlackboardBackend` wrapper that adds configurable consistency semantics.
 *
 * Fully satisfies the synchronous `BlackboardBackend` interface so it can be
 * used anywhere a plain backend is accepted. For `'strong'` consistency, use
 * `writeAsync()` to await durability confirmation.
 *
 * @example
 * ```typescript
 * // Session consistency — read-your-writes
 * const backend = new ConsistentBackend(new MemoryBackend(), 'session');
 * backend.write('task', 'pending', 'agent-1');
 * backend.read('task'); // → 'pending' (guaranteed, even before replication)
 *
 * // Strong consistency with Redis
 * const backend = new ConsistentBackend(new RedisBackend(client), 'strong');
 * await backend.writeAsync('result', data, 'agent-1');
 * // Redis has confirmed the write
 * ```
 */
export class ConsistentBackend implements BlackboardBackend {
  private readonly _backend: BlackboardBackend;
  private readonly _level: ConsistencyLevel;

  /**
   * Session write cache.
   *
   * - `BlackboardEntry`  → written in this session (overrides backend reads)
   * - `null`             → deleted in this session (hides backend reads)
   *
   * Only populated for `'session'` consistency.
   */
  private readonly _session: Map<string, BlackboardEntry | null> = new Map();

  /**
   * Create a new `ConsistentBackend`.
   *
   * @param backend  The underlying storage backend to wrap.
   * @param level    Consistency level. Defaults to `'eventual'`.
   */
  constructor(backend: BlackboardBackend, level: ConsistencyLevel = 'eventual') {
    this._backend = backend;
    this._level = level;
  }

  // --------------------------------------------------------------------------
  // BlackboardBackend interface
  // --------------------------------------------------------------------------

  /**
   * Read an entry.
   *
   * - `eventual` / `strong`: delegates directly to the underlying backend.
   * - `session`: returns the session-cached entry if present; falls back to
   *   the backend. Returns `null` for session-deleted keys even if the backend
   *   still has them.
   */
  read(key: string): BlackboardEntry | null {
    if (this._level === 'session') {
      const cached = this._session.get(key);
      if (cached === undefined) {
        // Not in session cache — fall through to backend
      } else if (cached === null) {
        // Session-deleted tombstone
        return null;
      } else {
        // Live session entry — check expiry
        if (this._isExpired(cached)) {
          this._session.delete(key);
          return null;
        }
        return cached;
      }
    }
    return this._backend.read(key);
  }

  /**
   * Write a value synchronously.
   *
   * For all consistency levels this writes immediately to the underlying
   * backend. For `'session'` the result is also cached locally so subsequent
   * `read()` calls see it without waiting for replication.
   *
   * For `'strong'` consistency, prefer `writeAsync()` to await durability.
   */
  write(key: string, value: unknown, sourceAgent: string, ttl?: number): BlackboardEntry {
    const entry = this._backend.write(key, value, sourceAgent, ttl);
    if (this._level === 'session') {
      this._session.set(key, entry);
    }
    return entry;
  }

  /**
   * Delete an entry.
   *
   * For `'session'` consistency, also records a session-tombstone so the key
   * appears deleted to subsequent `read()` calls in this session.
   */
  delete(key: string): boolean {
    const result = this._backend.delete(key);
    if (this._level === 'session') {
      this._session.set(key, null); // tombstone
    }
    return result;
  }

  /**
   * Return all non-expired, non-deleted keys.
   *
   * For `'session'` consistency, session-written keys are included even if
   * not yet visible in the backend; session-deleted keys are excluded.
   */
  listKeys(): string[] {
    if (this._level !== 'session') {
      return this._backend.listKeys();
    }

    // Start with backend keys, then overlay session mutations
    const backendKeys = new Set(this._backend.listKeys());

    // Add session-written keys (not yet in backend, or overriding backend)
    for (const [key, entry] of this._session.entries()) {
      if (entry === null) {
        // Session delete — remove from result
        backendKeys.delete(key);
      } else if (!this._isExpired(entry)) {
        backendKeys.add(key);
      }
    }

    return Array.from(backendKeys);
  }

  /**
   * Return a snapshot of all non-expired, non-deleted entries.
   *
   * For `'session'` consistency, session writes overlay the backend snapshot.
   */
  getSnapshot(): Record<string, BlackboardEntry> {
    if (this._level !== 'session') {
      return this._backend.getSnapshot();
    }

    // Start from backend snapshot, apply session overlay
    const result: Record<string, BlackboardEntry> = { ...this._backend.getSnapshot() };

    for (const [key, entry] of this._session.entries()) {
      if (entry === null) {
        // Session delete
        delete result[key];
      } else if (!this._isExpired(entry)) {
        result[key] = entry;
      }
    }

    return result;
  }

  // --------------------------------------------------------------------------
  // Extended consistency API
  // --------------------------------------------------------------------------

  /**
   * Write a value and, for `'strong'` consistency, await durability
   * confirmation from the backend.
   *
   * - `eventual` / `session`: behaves identically to `write()` but returns
   *   a `Promise` for API uniformity.
   * - `strong` + `FlushableBackend`: calls `backend.flush()` after the write
   *   and resolves only after the flush completes.
   * - `strong` + non-flushable backend: writes synchronously and resolves
   *   immediately (backend writes are already synchronous/durable).
   *
   * @example
   * ```typescript
   * const entry = await backend.writeAsync('checkpoint', data, 'agent-1');
   * // Under 'strong' + RedisBackend: Redis has persisted the entry by here
   * ```
   */
  async writeAsync(
    key: string,
    value: unknown,
    sourceAgent: string,
    ttl?: number,
  ): Promise<BlackboardEntry> {
    const entry = this.write(key, value, sourceAgent, ttl);
    if (this._level === 'strong' && isFlushable(this._backend)) {
      await this._backend.flush();
    }
    return entry;
  }

  /**
   * The configured consistency level.
   */
  get consistencyLevel(): ConsistencyLevel {
    return this._level;
  }

  /**
   * The underlying backend being wrapped.
   */
  get backend(): BlackboardBackend {
    return this._backend;
  }

  /**
   * Number of entries currently in the session cache (live + tombstones).
   * Always `0` for `'eventual'` and `'strong'` levels.
   */
  get sessionSize(): number {
    return this._session.size;
  }

  /**
   * Clear the session write cache without modifying the underlying backend.
   *
   * After calling this, `read()` will reflect the backend state directly.
   * Only meaningful for `'session'` consistency.
   */
  clearSession(): void {
    this._session.clear();
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private _isExpired(entry: BlackboardEntry): boolean {
    if (!entry.ttl) return false;
    return Date.now() > new Date(entry.timestamp).getTime() + entry.ttl * 1000;
  }
}
