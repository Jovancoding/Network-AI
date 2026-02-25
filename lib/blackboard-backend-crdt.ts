/**
 * CRDT Blackboard Backend
 *
 * Provides a `CrdtBackend` implementation of `BlackboardBackend` that uses
 * vector clocks and conflict-free merge semantics to synchronize state across
 * multiple nodes (processes or machines) without requiring coordination.
 *
 * Each `CrdtBackend` instance represents one "node" in the distributed system.
 * Nodes exchange `CrdtEntry` records and merge them using `mergeEntry()` to
 * converge to the same state — even after concurrent, offline writes.
 *
 * Architecture:
 *   - Each node has a unique `nodeId` and a local `VectorClock`.
 *   - Writes increment the node's own clock counter and tag the entry.
 *   - Deletes record tombstones (`deleted: true`) so deletions propagate.
 *   - `merge(entries)` applies conflict-free resolution for each key.
 *   - `sync(other)` performs a full bidirectional merge with another node.
 *
 * @example
 * ```typescript
 * import { CrdtBackend } from 'network-ai';
 *
 * const nodeA = new CrdtBackend('node-a');
 * const nodeB = new CrdtBackend('node-b');
 *
 * nodeA.write('status', 'idle',  'agent-1');
 * nodeB.write('status', 'busy',  'agent-2');
 *
 * nodeA.sync(nodeB); // bidirectional merge
 *
 * // Both nodes now converge on the deterministic winner for 'status'
 * console.log(nodeA.read('status')?.value === nodeB.read('status')?.value); // true
 * ```
 *
 * @module BlackboardBackendCrdt
 * @version 1.0.0
 * @license MIT
 */

import type { BlackboardBackend, BlackboardEntry } from './blackboard-backend';
import {
  type VectorClock,
  type CrdtEntry,
  tickClock,
  mergeClock,
  mergeEntry,
} from './crdt';

export type { VectorClock, CrdtEntry };

// ============================================================================
// OPTIONS
// ============================================================================

/**
 * Construction options for `CrdtBackend`.
 */
export interface CrdtBackendOptions {
  /**
   * Unique identifier for this node.
   * Must be distinct from all other nodes that will ever sync with this one.
   * If omitted, a random identifier is generated.
   */
  nodeId?: string;
}

// ============================================================================
// CRDT BACKEND
// ============================================================================

/**
 * CRDT-based `BlackboardBackend` for distributed multi-node agent coordination.
 *
 * Fully satisfies the synchronous `BlackboardBackend` interface while adding
 * vector-clock-based merge semantics for deterministic convergence across nodes.
 *
 * All reads and writes are O(1). `merge()` is O(n) in the number of incoming
 * entries. `sync()` is O(n + m) in the combined store sizes.
 */
export class CrdtBackend implements BlackboardBackend {
  private readonly _nodeId: string;
  private _clock: VectorClock = {};
  private _store: Map<string, CrdtEntry> = new Map();

  /**
   * Create a new `CrdtBackend` node.
   *
   * @param nodeId  Unique node identifier. Defaults to a random string.
   * @param options Additional options.
   */
  constructor(nodeId?: string, options?: CrdtBackendOptions) {
    // nodeId param takes precedence; fall back to options.nodeId, then random
    this._nodeId = nodeId ?? options?.nodeId ?? `node-${Math.random().toString(36).slice(2, 10)}`;
  }

  // --------------------------------------------------------------------------
  // BlackboardBackend interface
  // --------------------------------------------------------------------------

  /**
   * Read an entry. Returns `null` if not found, expired, or tombstoned.
   */
  read(key: string): BlackboardEntry | null {
    const entry = this._store.get(key);
    if (!entry) return null;
    if (entry.deleted) return null;
    if (this._isExpired(entry)) return null;
    return entry;
  }

  /**
   * Write a value to this node, incrementing the local vector clock.
   * The entry is tagged with the current clock and this node's id.
   */
  write(key: string, value: unknown, sourceAgent: string, ttl?: number): BlackboardEntry {
    this._clock = tickClock(this._clock, this._nodeId);

    const existing = this._store.get(key);
    const version = (existing && !existing.deleted) ? existing.version + 1 : 1;

    const entry: CrdtEntry = {
      key,
      value,
      source_agent: sourceAgent,
      timestamp: new Date().toISOString(),
      ttl: ttl ?? null,
      version,
      vectorClock: { ...this._clock },
      nodeId: this._nodeId,
    };

    this._store.set(key, entry);
    return entry;
  }

  /**
   * Delete an entry by recording a tombstone so the deletion propagates on
   * sync to other nodes.
   *
   * Returns `true` if the key existed and was not already deleted.
   */
  delete(key: string): boolean {
    const existing = this._store.get(key);
    if (!existing || existing.deleted) return false;

    this._clock = tickClock(this._clock, this._nodeId);

    const tombstone: CrdtEntry = {
      ...existing,
      value: null,
      deleted: true,
      timestamp: new Date().toISOString(),
      vectorClock: { ...this._clock },
      nodeId: this._nodeId,
    };

    this._store.set(key, tombstone);
    return true;
  }

  /**
   * Return all non-expired, non-deleted keys.
   */
  listKeys(): string[] {
    const keys: string[] = [];
    for (const [key, entry] of this._store.entries()) {
      if (!entry.deleted && !this._isExpired(entry)) {
        keys.push(key);
      }
    }
    return keys;
  }

  /**
   * Return a snapshot of all non-expired, non-deleted entries.
   */
  getSnapshot(): Record<string, BlackboardEntry> {
    const result: Record<string, BlackboardEntry> = {};
    for (const [key, entry] of this._store.entries()) {
      if (!entry.deleted && !this._isExpired(entry)) {
        result[key] = entry;
      }
    }
    return result;
  }

  // --------------------------------------------------------------------------
  // CRDT-specific API
  // --------------------------------------------------------------------------

  /**
   * The unique node identifier for this backend instance.
   */
  get nodeId(): string {
    return this._nodeId;
  }

  /**
   * Return a copy of the current vector clock for this node.
   */
  getVectorClock(): VectorClock {
    return { ...this._clock };
  }

  /**
   * Return the raw `CrdtEntry` for a key, including tombstones and expired
   * entries. Use `read()` for normal agent access.
   *
   * @returns The stored `CrdtEntry`, or `null` if the key has never been written.
   */
  getCrdtEntry(key: string): CrdtEntry | null {
    return this._store.get(key) ?? null;
  }

  /**
   * Return a snapshot of all raw `CrdtEntry` records in this node's store,
   * including tombstones and expired entries.
   *
   * Use this to obtain the payload for sending to another node's `merge()`.
   */
  getCrdtSnapshot(): Record<string, CrdtEntry> {
    const result: Record<string, CrdtEntry> = {};
    for (const [key, entry] of this._store.entries()) {
      result[key] = entry;
    }
    return result;
  }

  /**
   * Merge an array of `CrdtEntry` records from another node into this store.
   *
   * For each incoming entry:
   *   - If this node has no entry for the key, store it directly.
   *   - Otherwise, apply `mergeEntry()` to pick the winner deterministically.
   *
   * The local vector clock is advanced to the component-wise max of the
   * current clock and all clocks carried in the incoming entries.
   *
   * @param entries  Entries from another node (obtained via `getCrdtSnapshot()`).
   *
   * @example
   * ```typescript
   * nodeA.merge(Object.values(nodeB.getCrdtSnapshot()));
   * ```
   */
  merge(entries: CrdtEntry[]): void {
    for (const incoming of entries) {
      // Advance our clock to acknowledge the remote writes
      this._clock = mergeClock(this._clock, incoming.vectorClock);

      const local = this._store.get(incoming.key);
      if (!local) {
        this._store.set(incoming.key, incoming);
      } else {
        this._store.set(incoming.key, mergeEntry(local, incoming));
      }
    }
  }

  /**
   * Bidirectionally synchronise this node with `other`.
   *
   * After `sync()`, both nodes will have merged each other's entire store and
   * converge to the same state for every key.
   *
   * Equivalent to:
   * ```typescript
   * const mine   = Object.values(this.getCrdtSnapshot());
   * const theirs = Object.values(other.getCrdtSnapshot());
   * this.merge(theirs);
   * other.merge(mine);
   * ```
   *
   * @param other  The remote `CrdtBackend` node to sync with.
   */
  sync(other: CrdtBackend): void {
    const myEntries    = Object.values(this.getCrdtSnapshot());
    const theirEntries = Object.values(other.getCrdtSnapshot());
    this.merge(theirEntries);
    other.merge(myEntries);
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private _isExpired(entry: BlackboardEntry): boolean {
    if (!entry.ttl) return false;
    return Date.now() > new Date(entry.timestamp).getTime() + entry.ttl * 1000;
  }
}
