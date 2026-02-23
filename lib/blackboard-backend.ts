/**
 * Pluggable Backend API for Named Blackboards
 *
 * Defines the `BlackboardBackend` interface that abstracts the storage layer
 * used by `SharedBlackboard`. Two built-in implementations are provided:
 *
 *  - `FileBackend`   — persisted to disk via LockedBlackboard (default)
 *  - `MemoryBackend` — pure in-memory, no disk writes (testing / ephemeral boards)
 *
 * Custom backends (Redis, CRDT, cloud storage, etc.) can be implemented by
 * satisfying the `BlackboardBackend` interface and passing the instance to
 * `orchestrator.getBlackboard(name, { backend: myBackend })`.
 *
 * @module BlackboardBackend
 * @version 1.0.0
 * @license MIT
 */

import { LockedBlackboard } from './locked-blackboard';
import type { BlackboardEntry } from './locked-blackboard';

export type { BlackboardEntry };

// ============================================================================
// INTERFACE
// ============================================================================

/**
 * Storage abstraction for a `SharedBlackboard` instance.
 *
 * Implement this interface to plug in any storage backend:
 * file system, Redis, an in-memory Map, a cloud KV store, etc.
 *
 * @example
 * ```typescript
 * class RedisBackend implements BlackboardBackend {
 *   constructor(private client: RedisClient) {}
 *   read(key: string) { ... }
 *   write(key, value, sourceAgent, ttl) { ... }
 *   delete(key) { ... }
 *   listKeys() { ... }
 *   getSnapshot() { ... }
 * }
 * const board = orchestrator.getBlackboard('prod', { backend: new RedisBackend(client) });
 * ```
 */
export interface BlackboardBackend {
  /**
   * Read a single entry. Returns `null` if not found or expired.
   */
  read(key: string): BlackboardEntry | null;

  /**
   * Write a value. Returns the stored entry including generated metadata.
   * @param key         The entry key
   * @param value       Any JSON-serializable value
   * @param sourceAgent The agent performing the write
   * @param ttl         Optional time-to-live in seconds
   */
  write(key: string, value: unknown, sourceAgent: string, ttl?: number): BlackboardEntry;

  /**
   * Delete an entry by key. Returns `true` if it existed.
   */
  delete(key: string): boolean;

  /**
   * Return all non-expired keys.
   */
  listKeys(): string[];

  /**
   * Return a full snapshot of all non-expired entries, keyed by entry key.
   */
  getSnapshot(): Record<string, BlackboardEntry>;
}

// ============================================================================
// FILE BACKEND (default — wraps LockedBlackboard)
// ============================================================================

/**
 * File-backed persistent storage using `LockedBlackboard`.
 *
 * All writes are atomic and file-locked. Data survives process restarts.
 * This is the default backend used when no `backend` option is provided to
 * `orchestrator.getBlackboard()`.
 *
 * @example
 * ```typescript
 * const board = orchestrator.getBlackboard('reports', {
 *   backend: new FileBackend('./data/reports'),
 * });
 * ```
 */
export class FileBackend implements BlackboardBackend {
  private lb: LockedBlackboard;

  constructor(basePath: string) {
    this.lb = new LockedBlackboard(basePath);
  }

  read(key: string): BlackboardEntry | null {
    return this.lb.read(key);
  }

  write(key: string, value: unknown, sourceAgent: string, ttl?: number): BlackboardEntry {
    return this.lb.write(key, value, sourceAgent, ttl);
  }

  delete(key: string): boolean {
    return this.lb.delete(key);
  }

  listKeys(): string[] {
    return this.lb.listKeys();
  }

  getSnapshot(): Record<string, BlackboardEntry> {
    return this.lb.getSnapshot();
  }
}

// ============================================================================
// MEMORY BACKEND (pure in-memory, no disk)
// ============================================================================

/**
 * Pure in-memory backend — data lives only for the lifetime of the process.
 *
 * Ideal for:
 * - Unit testing (no temp directories, instant, isolated)
 * - Short-lived ephemeral boards
 * - Read-heavy caches that don't need persistence
 *
 * Thread-safety note: Node.js is single-threaded; no locking is needed for
 * in-process use. For multi-process scenarios use `FileBackend` or a
 * distributed backend (Redis, etc.).
 *
 * @example
 * ```typescript
 * const board = orchestrator.getBlackboard('ephemeral', {
 *   backend: new MemoryBackend(),
 * });
 * ```
 */
export class MemoryBackend implements BlackboardBackend {
  private store: Map<string, BlackboardEntry> = new Map();

  private isExpired(entry: BlackboardEntry): boolean {
    if (!entry.ttl) return false;
    return Date.now() > new Date(entry.timestamp).getTime() + entry.ttl * 1000;
  }

  read(key: string): BlackboardEntry | null {
    const entry = this.store.get(key);
    if (!entry || this.isExpired(entry)) return null;
    return entry;
  }

  write(key: string, value: unknown, sourceAgent: string, ttl?: number): BlackboardEntry {
    const existing = this.store.get(key);
    const version = existing ? existing.version + 1 : 1;
    const entry: BlackboardEntry = {
      key,
      value,
      source_agent: sourceAgent,
      timestamp: new Date().toISOString(),
      ttl: ttl ?? null,
      version,
    };
    this.store.set(key, entry);
    return entry;
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  listKeys(): string[] {
    return Array.from(this.store.entries())
      .filter(([, entry]) => !this.isExpired(entry))
      .map(([key]) => key);
  }

  getSnapshot(): Record<string, BlackboardEntry> {
    const result: Record<string, BlackboardEntry> = {};
    for (const [key, entry] of this.store.entries()) {
      if (!this.isExpired(entry)) {
        result[key] = entry;
      }
    }
    return result;
  }

  /**
   * Clear all entries. Useful for test teardown.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Returns the current entry count (including expired entries not yet evicted).
   */
  size(): number {
    return this.store.size;
  }
}
