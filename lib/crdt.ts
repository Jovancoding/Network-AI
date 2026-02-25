/**
 * CRDT (Conflict-free Replicated Data Type) Primitives
 *
 * Provides vector clocks and merge logic that allow multiple `CrdtBackend`
 * instances (on different processes or machines) to synchronize without
 * coordination and converge to the same state.
 *
 * Vector clock semantics:
 *   - Each node tracks its own logical time as an integer counter.
 *   - On every write, the node increments its own counter.
 *   - "Happens-before" (A → B): every component of A's clock is ≤ B's,
 *     and at least one is strictly less.
 *   - "Concurrent" (A ∥ B): neither happened-before the other.
 *   - Conflict resolution for concurrent writes: last-write-wins by
 *     wall-clock timestamp; lexicographically larger nodeId as tiebreaker
 *     for identical timestamps (deterministic, independent of arrival order).
 *
 * @module CRDT
 * @version 1.0.0
 * @license MIT
 */

import type { BlackboardEntry } from './blackboard-backend';

export type { BlackboardEntry };

// ============================================================================
// VECTOR CLOCK
// ============================================================================

/**
 * A vector clock — maps nodeId → logical counter.
 * Missing entries are treated as 0.
 */
export type VectorClock = Record<string, number>;

/**
 * A `BlackboardEntry` augmented with CRDT metadata.
 * All `CrdtEntry` values satisfy the `BlackboardEntry` interface.
 */
export interface CrdtEntry extends BlackboardEntry {
  /** The vector clock at the time of this write. */
  vectorClock: VectorClock;
  /** The node that produced this entry. */
  nodeId: string;
  /** `true` if this is a tombstone (logical delete). */
  deleted?: boolean;
}

// ============================================================================
// CLOCK OPERATIONS
// ============================================================================

/**
 * Increment a node's counter in a vector clock.
 * Returns a new clock — does not mutate the input.
 *
 * @example
 * ```typescript
 * const c0 = {};
 * const c1 = tickClock(c0, 'node-a'); // { 'node-a': 1 }
 * const c2 = tickClock(c1, 'node-a'); // { 'node-a': 2 }
 * ```
 */
export function tickClock(clock: VectorClock, nodeId: string): VectorClock {
  return { ...clock, [nodeId]: (clock[nodeId] ?? 0) + 1 };
}

/**
 * Merge two vector clocks by taking the component-wise maximum.
 * Returns a new clock — does not mutate the inputs.
 *
 * @example
 * ```typescript
 * const a = { 'node-a': 3, 'node-b': 1 };
 * const b = { 'node-a': 1, 'node-b': 4 };
 * mergeClock(a, b); // { 'node-a': 3, 'node-b': 4 }
 * ```
 */
export function mergeClock(a: VectorClock, b: VectorClock): VectorClock {
  const result: VectorClock = { ...a };
  for (const [node, counter] of Object.entries(b)) {
    result[node] = Math.max(result[node] ?? 0, counter);
  }
  return result;
}

/**
 * Returns `true` if clock `a` happened-before clock `b`.
 *
 * Every component of `a` must be ≤ the corresponding component of `b`,
 * and at least one component of `a` must be strictly less than `b`.
 */
export function happensBefore(a: VectorClock, b: VectorClock): boolean {
  const allNodes = new Set([...Object.keys(a), ...Object.keys(b)]);
  let hasStrictlyLess = false;
  for (const node of allNodes) {
    const aVal = a[node] ?? 0;
    const bVal = b[node] ?? 0;
    if (aVal > bVal) return false;       // a is NOT ≤ b — cannot happen-before
    if (aVal < bVal) hasStrictlyLess = true;
  }
  return hasStrictlyLess;
}

/**
 * Returns `true` if `a` and `b` are concurrent — neither happened-before
 * the other. Both clocks have components where each is strictly greater
 * than the other.
 */
export function isConcurrent(a: VectorClock, b: VectorClock): boolean {
  return !happensBefore(a, b) && !happensBefore(b, a);
}

/**
 * Compare two vector clocks.
 *
 * Returns:
 *   -1  if `a` happened-before `b`
 *    1  if `b` happened-before `a`
 *    0  if concurrent or identical
 */
export function compareClock(a: VectorClock, b: VectorClock): -1 | 0 | 1 {
  if (happensBefore(a, b)) return -1;
  if (happensBefore(b, a)) return 1;
  return 0;
}

// ============================================================================
// CRDT MERGE
// ============================================================================

/**
 * Merge two `CrdtEntry` values for the same key, returning the winner.
 *
 * Resolution order:
 *   1. Causal order — if one entry happened-before the other, the later one wins.
 *   2. Timestamp tiebreak — for concurrent entries, the later wall-clock
 *      `timestamp` wins.
 *   3. NodeId tiebreak — for identical timestamps, the lexicographically
 *      larger `nodeId` wins (deterministic, node-independent).
 *
 * Tombstones (`deleted: true`) participate normally in this ordering —
 * a delete recorded at a later vector clock will win over a live write.
 *
 * @example
 * ```typescript
 * const winner = mergeEntry(entryFromNodeA, entryFromNodeB);
 * ```
 */
export function mergeEntry(a: CrdtEntry, b: CrdtEntry): CrdtEntry {
  const order = compareClock(a.vectorClock, b.vectorClock);
  if (order === -1) return b;   // a happened-before b → b wins
  if (order === 1)  return a;   // b happened-before a → a wins

  // Concurrent — tiebreak by timestamp, then nodeId
  const aTime = new Date(a.timestamp).getTime();
  const bTime = new Date(b.timestamp).getTime();
  if (aTime !== bTime) return aTime > bTime ? a : b;
  return a.nodeId >= b.nodeId ? a : b;
}
