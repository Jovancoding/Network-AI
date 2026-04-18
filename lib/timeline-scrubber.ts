/**
 * TimelineScrubber — Step through orchestrator history at any sequence point.
 *
 * Wraps an OrchestratorEventBus and reconstructs state at any point by
 * loading the nearest snapshot and replaying events forward.  Dashboard
 * clients can "drag a slider" to any sequence and get the state at that
 * moment.
 *
 * @module TimelineScrubber
 */

import type { OrchestratorEventBus, BusEvent, StateSnapshot } from './event-bus';

// ============================================================================
// TYPES
// ============================================================================

/** Reconstructed state at a given point in time */
export interface TimelineFrame {
  /** Sequence number this frame represents */
  seq: number;
  /** ISO 8601 timestamp of the event at this seq */
  timestamp: string;
  /** Base snapshot used (or null if before first snapshot) */
  baseSnapshotSeq: number | null;
  /** Events applied on top of the snapshot to reach this state */
  appliedEvents: BusEvent[];
  /** Reconstructed blackboard state */
  blackboard: Record<string, unknown>;
  /** Reconstructed agent statuses */
  agents: Record<string, { status: string; tokensUsed: number }>;
  /** Budget state if available */
  budget?: Record<string, unknown>;
}

/** Range info for the timeline */
export interface TimelineRange {
  /** Earliest available sequence number */
  minSeq: number;
  /** Latest available sequence number */
  maxSeq: number;
  /** Total events in the stream */
  totalEvents: number;
  /** Number of snapshots available */
  snapshotCount: number;
  /** Sequence numbers of all available snapshots */
  snapshotSeqs: number[];
}

// ============================================================================
// STATE REDUCER
// ============================================================================

/** Apply a single bus event to mutable state. */
function applyEvent(
  state: { blackboard: Record<string, unknown>; agents: Record<string, { status: string; tokensUsed: number }> },
  event: BusEvent,
): void {
  switch (event.source) {
    case 'blackboard': {
      if (event.type === 'write' || event.type === 'commit') {
        const key = event.data.key as string | undefined;
        if (key) state.blackboard[key] = event.data.value;
      } else if (event.type === 'delete') {
        const key = event.data.key as string | undefined;
        if (key) delete state.blackboard[key];
      }
      break;
    }
    case 'orchestrator': {
      if (event.type === 'delegation_start' && event.agentId) {
        const target = event.data.targetAgent as string | undefined;
        if (target && !state.agents[target]) {
          state.agents[target] = { status: 'running', tokensUsed: 0 };
        } else if (target && state.agents[target]) {
          state.agents[target].status = 'running';
        }
      }
      if (event.type === 'delegation_failed' && event.data.targetAgent) {
        const target = event.data.targetAgent as string;
        if (state.agents[target]) state.agents[target].status = 'failed';
      }
      break;
    }
    case 'adapter': {
      if (event.type === 'agent:execution:complete' && event.agentId) {
        if (state.agents[event.agentId]) {
          state.agents[event.agentId].status = 'completed';
        }
      }
      break;
    }
    case 'quality': {
      if (event.type === 'reject' && event.agentId) {
        if (state.agents[event.agentId]) {
          state.agents[event.agentId].status = 'failed';
        }
      }
      break;
    }
    // Other sources: no state mutation needed for reconstruction
    default:
      break;
  }
}

// ============================================================================
// SCRUBBER
// ============================================================================

/**
 * Reconstructs state at any point in the event stream.
 *
 * @example
 * ```ts
 * const scrubber = new TimelineScrubber(orchestrator.eventBus);
 * const frame = scrubber.frameAt(42);
 * // frame.blackboard — state of blackboard at seq 42
 * // frame.agents — agent statuses at seq 42
 *
 * const range = scrubber.getRange();
 * // range.minSeq, range.maxSeq — slider bounds
 * ```
 */
export class TimelineScrubber {
  private bus: OrchestratorEventBus;

  constructor(bus: OrchestratorEventBus) {
    this.bus = bus;
  }

  /**
   * Reconstruct state at a specific sequence number.
   */
  frameAt(seq: number): TimelineFrame {
    // Find nearest snapshot at or before seq
    const snapshot = this.bus.snapshotAt(seq);

    // Determine replay start
    const fromSeq = snapshot ? snapshot.atSeq + 1 : 0;

    // Get events from snapshot to target seq
    const replay = this.bus.replay({ fromSeq, toSeq: seq });
    const appliedEvents = replay.events;

    // Initialize state from snapshot or empty
    const blackboard: Record<string, unknown> = snapshot
      ? { ...snapshot.blackboard }
      : {};
    const agents: Record<string, { status: string; tokensUsed: number }> = snapshot
      ? Object.fromEntries(Object.entries(snapshot.agents).map(([k, v]) => [k, { ...v }]))
      : {};

    // Apply events forward
    for (const event of appliedEvents) {
      applyEvent({ blackboard, agents }, event);
    }

    // Find the event timestamp at this seq
    const targetEvent = this.bus.getEvent(seq);
    const timestamp = targetEvent?.timestamp ?? snapshot?.timestamp ?? new Date().toISOString();

    return {
      seq,
      timestamp,
      baseSnapshotSeq: snapshot?.atSeq ?? null,
      appliedEvents,
      blackboard,
      agents,
      budget: snapshot?.budget,
    };
  }

  /**
   * Get a range of frames (e.g. for scrubbing a window).
   * Returns frames at evenly-spaced sequence numbers.
   */
  frameRange(fromSeq: number, toSeq: number, maxFrames = 50): TimelineFrame[] {
    const range = toSeq - fromSeq;
    const step = Math.max(1, Math.floor(range / maxFrames));
    const frames: TimelineFrame[] = [];

    for (let s = fromSeq; s <= toSeq; s += step) {
      frames.push(this.frameAt(s));
    }

    // Always include the last frame
    if (frames.length === 0 || frames[frames.length - 1].seq !== toSeq) {
      frames.push(this.frameAt(toSeq));
    }

    return frames;
  }

  /**
   * Get the timeline range info (slider bounds).
   */
  getRange(): TimelineRange {
    const snapshots = this.bus.getSnapshots();
    const replay = this.bus.replay();

    return {
      minSeq: replay.events.length > 0 ? replay.events[0].seq : 0,
      maxSeq: this.bus.currentSeq - 1,
      totalEvents: replay.totalEvents,
      snapshotCount: snapshots.length,
      snapshotSeqs: snapshots.map(s => s.atSeq),
    };
  }

  /**
   * Step forward from a given frame by N events.
   */
  stepForward(currentSeq: number, steps = 1): TimelineFrame {
    return this.frameAt(Math.min(currentSeq + steps, this.bus.currentSeq - 1));
  }

  /**
   * Step backward from a given frame by N events.
   */
  stepBackward(currentSeq: number, steps = 1): TimelineFrame {
    return this.frameAt(Math.max(currentSeq - steps, 0));
  }
}
