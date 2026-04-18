/**
 * OrchestratorEventBus — Central event stream for replay & time-travel debugging.
 *
 * Collects events from all orchestrator subsystems (blackboard, auth, adapters,
 * topology, decisions) into a single monotonically-sequenced stream with periodic
 * state snapshots for efficient point-in-time reconstruction.
 *
 * @module EventBus
 */

import { EventEmitter } from 'events';

// ============================================================================
// TYPES
// ============================================================================

/** Sources that can publish events */
export type EventSource =
  | 'blackboard'
  | 'auth'
  | 'adapter'
  | 'topology'
  | 'decision'
  | 'budget'
  | 'quality'
  | 'injection'
  | 'orchestrator'
  | 'runtime'
  | 'custom';

/** Severity / importance of the event */
export type EventSeverity = 'trace' | 'info' | 'warn' | 'error';

/** A single event in the unified stream */
export interface BusEvent {
  /** Monotonic sequence number (global across all sources) */
  seq: number;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Which subsystem produced this event */
  source: EventSource;
  /** Event type within the source (e.g. 'write', 'commit', 'permission_check') */
  type: string;
  /** Severity level */
  severity: EventSeverity;
  /** Agent involved, if any */
  agentId?: string;
  /** Correlation id to group related events across subsystems */
  correlationId?: string;
  /** Event-specific payload */
  data: Record<string, unknown>;
}

/** A point-in-time snapshot of orchestrator state for efficient replay */
export interface StateSnapshot {
  /** Sequence number at the time the snapshot was taken */
  atSeq: number;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Blackboard key→value dump */
  blackboard: Record<string, unknown>;
  /** Active agents and their status */
  agents: Record<string, { status: string; tokensUsed: number }>;
  /** Budget state */
  budget?: Record<string, unknown>;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

/** Options for replaying events */
export interface ReplayOptions {
  /** Start sequence (inclusive). Defaults to 0 */
  fromSeq?: number;
  /** End sequence (inclusive). Defaults to latest */
  toSeq?: number;
  /** Filter by source(s) */
  sources?: EventSource[];
  /** Filter by agent */
  agentId?: string;
  /** Filter by correlation id */
  correlationId?: string;
  /** Filter by severity */
  minSeverity?: EventSeverity;
}

/** Result of a replay query */
export interface ReplayResult {
  /** The nearest snapshot at or before fromSeq */
  baseSnapshot: StateSnapshot | null;
  /** Events in the requested range */
  events: BusEvent[];
  /** Total events in the stream */
  totalEvents: number;
}

// Severity ordering for filtering
const SEVERITY_ORDER: Record<EventSeverity, number> = {
  trace: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ============================================================================
// EVENT BUS
// ============================================================================

/**
 * Central event bus for the orchestrator.
 *
 * Provides:
 * - Unified monotonic event stream from all subsystems
 * - Periodic state snapshots for O(1) point-in-time reconstruction
 * - Replay with filtering (source, agent, severity, correlation)
 * - Configurable retention (max events, max snapshots)
 *
 * @example
 * ```ts
 * const bus = new OrchestratorEventBus();
 * bus.publish('blackboard', 'write', 'info', { key: 'x', value: 42 }, 'agent-1');
 * bus.snapshot({ blackboard: bb.getSnapshot(), agents: {} });
 * const replay = bus.replay({ fromSeq: 0, toSeq: 100 });
 * ```
 */
export class OrchestratorEventBus extends EventEmitter {
  private events: BusEvent[] = [];
  private snapshots: StateSnapshot[] = [];
  private seq = 0;
  private maxEvents: number;
  private maxSnapshots: number;
  private snapshotInterval: number;
  private eventsSinceSnapshot = 0;

  constructor(options?: {
    /** Max events to retain in memory. Default 50_000 */
    maxEvents?: number;
    /** Max snapshots to retain. Default 100 */
    maxSnapshots?: number;
    /** Take a snapshot every N events (0 = manual only). Default 0 */
    snapshotInterval?: number;
  }) {
    super();
    this.maxEvents = options?.maxEvents ?? 50_000;
    this.maxSnapshots = options?.maxSnapshots ?? 100;
    this.snapshotInterval = options?.snapshotInterval ?? 0;
  }

  /**
   * Publish an event to the bus.
   * Returns the assigned sequence number.
   */
  publish(
    source: EventSource,
    type: string,
    severity: EventSeverity,
    data: Record<string, unknown>,
    agentId?: string,
    correlationId?: string,
  ): number {
    const event: BusEvent = {
      seq: this.seq++,
      timestamp: new Date().toISOString(),
      source,
      type,
      severity,
      agentId,
      correlationId,
      data,
    };

    this.events.push(event);
    this.eventsSinceSnapshot++;

    // Evict oldest
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }

    this.emit('event', event);

    return event.seq;
  }

  /**
   * Take a state snapshot at the current sequence position.
   */
  snapshot(state: Omit<StateSnapshot, 'atSeq' | 'timestamp'>): StateSnapshot {
    const snap: StateSnapshot = {
      atSeq: this.seq - 1,
      timestamp: new Date().toISOString(),
      blackboard: state.blackboard,
      agents: state.agents,
      budget: state.budget,
      metadata: state.metadata,
    };

    this.snapshots.push(snap);
    this.eventsSinceSnapshot = 0;

    // Evict oldest snapshots
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.splice(0, this.snapshots.length - this.maxSnapshots);
    }

    this.emit('snapshot', snap);
    return snap;
  }

  /**
   * Check if an automatic snapshot should be taken (called internally after publish).
   * Returns true if a snapshot is due. Callers must provide state via `snapshot()`.
   */
  isSnapshotDue(): boolean {
    return this.snapshotInterval > 0 && this.eventsSinceSnapshot >= this.snapshotInterval;
  }

  /**
   * Replay events with optional filtering.
   * Returns the nearest base snapshot + matching events.
   */
  replay(options?: ReplayOptions): ReplayResult {
    const fromSeq = options?.fromSeq ?? 0;
    const toSeq = options?.toSeq ?? this.seq;
    const minSev = options?.minSeverity ? SEVERITY_ORDER[options.minSeverity] : 0;

    // Find nearest snapshot at or before fromSeq
    let baseSnapshot: StateSnapshot | null = null;
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      if (this.snapshots[i].atSeq <= fromSeq) {
        baseSnapshot = this.snapshots[i];
        break;
      }
    }

    // Filter events
    const filtered = this.events.filter((e) => {
      if (e.seq < fromSeq || e.seq > toSeq) return false;
      if (options?.sources && !options.sources.includes(e.source)) return false;
      if (options?.agentId && e.agentId !== options.agentId) return false;
      if (options?.correlationId && e.correlationId !== options.correlationId) return false;
      if (SEVERITY_ORDER[e.severity] < minSev) return false;
      return true;
    });

    return {
      baseSnapshot,
      events: filtered,
      totalEvents: this.events.length,
    };
  }

  /**
   * Get the event at a specific sequence number.
   */
  getEvent(seq: number): BusEvent | undefined {
    return this.events.find((e) => e.seq === seq);
  }

  /**
   * Get the most recent N events.
   */
  recent(count: number): BusEvent[] {
    return this.events.slice(-count);
  }

  /**
   * Get all snapshots.
   */
  getSnapshots(): StateSnapshot[] {
    return [...this.snapshots];
  }

  /**
   * Find the nearest snapshot at or before a given sequence.
   */
  snapshotAt(seq: number): StateSnapshot | null {
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      if (this.snapshots[i].atSeq <= seq) {
        return this.snapshots[i];
      }
    }
    return null;
  }

  /** Current sequence counter value (next event will get this seq). */
  get currentSeq(): number {
    return this.seq;
  }

  /** Total stored events. */
  get size(): number {
    return this.events.length;
  }

  /** Total stored snapshots. */
  get snapshotCount(): number {
    return this.snapshots.length;
  }

  /** Clear all events and snapshots, reset sequence. */
  clear(): void {
    this.events.length = 0;
    this.snapshots.length = 0;
    this.seq = 0;
    this.eventsSinceSnapshot = 0;
  }

  /**
   * Export the full stream (events + snapshots) as a serializable object.
   */
  export(): { events: BusEvent[]; snapshots: StateSnapshot[] } {
    return {
      events: [...this.events],
      snapshots: [...this.snapshots],
    };
  }

  /**
   * Import a previously exported stream, merging into current state.
   */
  import(data: { events: BusEvent[]; snapshots: StateSnapshot[] }): void {
    if (!Array.isArray(data.events) || !Array.isArray(data.snapshots)) {
      throw new Error('Invalid import data: expected { events: [], snapshots: [] }');
    }
    for (const e of data.events) {
      this.events.push(e);
      if (e.seq >= this.seq) {
        this.seq = e.seq + 1;
      }
    }
    for (const s of data.snapshots) {
      this.snapshots.push(s);
    }
    // Sort by sequence
    this.events.sort((a, b) => a.seq - b.seq);
    this.snapshots.sort((a, b) => a.atSeq - b.atSeq);
    // Enforce limits
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.splice(0, this.snapshots.length - this.maxSnapshots);
    }
  }
}
