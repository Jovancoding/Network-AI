/**
 * Live Agent Topology — Real-time agent graph and event tracking
 *
 * Maintains a live directed graph of agents (nodes) and their interactions
 * (edges). Emits events for every state change so dashboards can render
 * the topology in real time.
 *
 * @module Topology
 * @version 1.0.0
 */

import { EventEmitter } from 'events';

// ============================================================================
// TYPES
// ============================================================================

/** Operational status of an agent node */
export type AgentNodeStatus =
  | 'idle'
  | 'running'
  | 'completed'
  | 'failed'
  | 'waiting'
  | 'spawning';

/** Visual group / role for clustering in the UI */
export type AgentRole =
  | 'orchestrator'
  | 'worker'
  | 'validator'
  | 'planner'
  | 'aggregator'
  | 'custom';

/** A single agent node in the topology graph */
export interface AgentNode {
  /** Unique agent identifier */
  id: string;
  /** Display label (defaults to id) */
  label: string;
  /** Current operational status */
  status: AgentNodeStatus;
  /** Adapter framework (e.g. 'langchain', 'crewai', 'custom') */
  adapter?: string;
  /** Visual grouping role */
  role: AgentRole;
  /** Current task description */
  currentTask?: string;
  /** Tokens consumed so far */
  tokensUsed: number;
  /** Budget cap for this agent (if any) */
  tokenBudget?: number;
  /** ISO 8601 timestamp when the agent was registered */
  registeredAt: string;
  /** ISO 8601 timestamp of last activity */
  lastActivityAt: string;
  /** Arbitrary metadata */
  metadata: Record<string, unknown>;
}

/** Type of edge between agents */
export type EdgeType =
  | 'blackboard_write'
  | 'blackboard_read'
  | 'delegation'
  | 'result'
  | 'dependency'
  | 'message';

/** A directed edge representing an interaction between agents */
export interface TopologyEdge {
  /** Unique edge identifier */
  id: string;
  /** Source agent id */
  from: string;
  /** Target agent id (or '_blackboard' for board interactions) */
  to: string;
  /** Type of interaction */
  type: EdgeType;
  /** Edge label (e.g. blackboard key, task id) */
  label?: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Optional payload metadata */
  metadata?: Record<string, unknown>;
}

/** A timestamped event in the topology stream */
export interface TopologyEvent {
  /** Monotonic event counter */
  seq: number;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Event type */
  type: TopologyEventType;
  /** Event payload */
  data: Record<string, unknown>;
}

/** All topology event types */
export type TopologyEventType =
  | 'agent:added'
  | 'agent:removed'
  | 'agent:status'
  | 'agent:task'
  | 'agent:tokens'
  | 'edge:added'
  | 'edge:removed'
  | 'snapshot'
  | 'clear';

/** Full snapshot of the topology graph */
export interface TopologySnapshot {
  /** All agent nodes */
  nodes: AgentNode[];
  /** All edges */
  edges: TopologyEdge[];
  /** Event log since last clear */
  events: TopologyEvent[];
  /** Snapshot timestamp */
  timestamp: string;
  /** Live narrative summary */
  narrative: string;
  /** Phase progress */
  phase: PhaseProgress;
  /** Attention-based status panel */
  attention: AttentionPanel;
  /** Agent activity timeline spans */
  timeline: TimelineSpan[];
  /** Agent clusters for scaled views (optional, populated by server) */
  clusters?: AgentCluster[];
}

/** Events emitted by TopologyTracker */
export interface TopologyTrackerEvents {
  'agent:added': (node: AgentNode) => void;
  'agent:removed': (id: string) => void;
  'agent:status': (id: string, status: AgentNodeStatus, prev: AgentNodeStatus) => void;
  'agent:task': (id: string, task: string | undefined) => void;
  'agent:tokens': (id: string, tokens: number) => void;
  'edge:added': (edge: TopologyEdge) => void;
  'edge:removed': (edgeId: string) => void;
  'snapshot': (snapshot: TopologySnapshot) => void;
  'event': (event: TopologyEvent) => void;
  'clear': () => void;
}

/** Options for creating a TopologyTracker */
export interface TopologyTrackerOptions {
  /** Maximum number of events to retain (default: 2000) */
  maxEvents?: number;
  /** Maximum number of edges to retain (default: 5000) */
  maxEdges?: number;
  /** Auto-prune edges older than this (ms). 0 = no pruning (default: 0) */
  edgeTtlMs?: number;
  /** Maximum timeline spans to retain (default: 50000) */
  maxTimelineSpans?: number;
}

// ============================================================================
// PHASE, NARRATIVE, ATTENTION, TIMELINE TYPES
// ============================================================================

/** A phase milestone in the workflow */
export interface PhaseMilestone {
  /** Phase name */
  name: string;
  /** Status */
  status: 'pending' | 'active' | 'completed';
}

/** Phase progress for the progress bar */
export interface PhaseProgress {
  /** Ordered milestones */
  milestones: PhaseMilestone[];
  /** 0-1 overall progress */
  progress: number;
  /** Current phase label */
  currentPhase: string;
}

/** Attention-based panel items */
export interface AttentionItem {
  /** Agent id */
  agentId: string;
  /** Agent label */
  label: string;
  /** Summary text */
  summary: string;
  /** Severity */
  severity: 'critical' | 'active' | 'done';
  /** Elapsed time in ms (for active items) */
  elapsedMs?: number;
  /** ISO timestamp */
  timestamp: string;
}

/** Attention panel with categorized items */
export interface AttentionPanel {
  /** Items needing attention (failures, budget overruns, stuck) */
  needsAttention: AttentionItem[];
  /** Currently active agents */
  activeNow: AttentionItem[];
  /** Recently finished */
  recentlyCompleted: AttentionItem[];
}

/** A timeline span for Gantt chart visualization */
export interface TimelineSpan {
  /** Agent id */
  agentId: string;
  /** Agent label */
  label: string;
  /** Status during this span */
  status: AgentNodeStatus;
  /** Start time in ms (epoch) */
  startMs: number;
  /** End time in ms (epoch), undefined if still active */
  endMs?: number;
}

/** A cluster of agents for zoomed-out views */
export interface AgentCluster {
  /** Cluster identifier */
  id: string;
  /** Role shared by agents in this cluster */
  role: AgentRole;
  /** Number of agents in this cluster */
  count: number;
  /** Status breakdown */
  statusCounts: Record<AgentNodeStatus, number>;
  /** Aggregate tokens used */
  totalTokensUsed: number;
  /** Aggregate token budget */
  totalTokenBudget: number;
  /** Representative agent ids (first few) */
  sampleIds: string[];
}

/** Delta patch for incremental updates */
export interface TopologyDelta {
  /** Sequence number this delta starts from */
  sinceSeq: number;
  /** Current sequence number */
  currentSeq: number;
  /** New or changed agent nodes */
  nodesChanged: AgentNode[];
  /** Removed agent ids */
  nodesRemoved: string[];
  /** New edges */
  edgesAdded: TopologyEdge[];
  /** Removed edge ids */
  edgesRemoved: string[];
  /** Updated summary fields */
  narrative: string;
  phase: PhaseProgress;
  attention: AttentionPanel;
  /** Only new timeline spans since sinceSeq */
  timelineAdded: TimelineSpan[];
  /** Aggregated clusters (sent with every delta for up-to-date cluster view) */
  clusters?: AgentCluster[];
}

// ============================================================================
// TOPOLOGY TRACKER
// ============================================================================

let edgeCounter = 0;

/**
 * Tracks the live agent topology graph and emits real-time events.
 *
 * Usage:
 * ```typescript
 * const topo = new TopologyTracker();
 *
 * topo.addAgent({ id: 'planner', role: 'planner' });
 * topo.addAgent({ id: 'worker-1', role: 'worker', adapter: 'langchain' });
 *
 * topo.setStatus('planner', 'running');
 * topo.addEdge('planner', 'worker-1', 'delegation', 'analyze code');
 *
 * topo.on('agent:status', (id, status) => {
 *   console.log(`${id} → ${status}`);
 * });
 * ```
 */
export class TopologyTracker extends EventEmitter {
  private nodes: Map<string, AgentNode> = new Map();
  private edges: Map<string, TopologyEdge> = new Map();
  private eventLog: TopologyEvent[] = [];
  private seq = 0;
  private readonly maxEvents: number;
  private readonly maxEdges: number;
  private readonly edgeTtlMs: number;
  private readonly maxTimelineSpans: number;
  private timelineSpans: TimelineSpan[] = [];
  private deltaNodesChanged: Set<string> = new Set();
  private deltaNodesRemoved: Set<string> = new Set();
  private deltaEdgesAdded: string[] = [];
  private deltaEdgesRemoved: string[] = [];
  private deltaTimelineStart = 0;

  constructor(options?: TopologyTrackerOptions) {
    super();
    this.maxEvents = options?.maxEvents ?? 2000;
    this.maxEdges = options?.maxEdges ?? 5000;
    this.edgeTtlMs = options?.edgeTtlMs ?? 0;
    this.maxTimelineSpans = options?.maxTimelineSpans ?? 50000;
  }

  // --------------------------------------------------------------------------
  // AGENT NODE OPERATIONS
  // --------------------------------------------------------------------------

  /**
   * Add or update an agent node.
   */
  addAgent(opts: {
    id: string;
    label?: string;
    role?: AgentRole;
    adapter?: string;
    status?: AgentNodeStatus;
    tokenBudget?: number;
    metadata?: Record<string, unknown>;
  }): AgentNode {
    const now = new Date().toISOString();
    const existing = this.nodes.get(opts.id);

    const node: AgentNode = {
      id: opts.id,
      label: opts.label ?? opts.id,
      status: opts.status ?? existing?.status ?? 'idle',
      adapter: opts.adapter ?? existing?.adapter,
      role: opts.role ?? existing?.role ?? 'worker',
      tokensUsed: existing?.tokensUsed ?? 0,
      tokenBudget: opts.tokenBudget ?? existing?.tokenBudget,
      registeredAt: existing?.registeredAt ?? now,
      lastActivityAt: now,
      metadata: { ...existing?.metadata, ...opts.metadata },
    };

    this.nodes.set(opts.id, node);
    this.deltaNodesChanged.add(opts.id);

    if (!existing) {
      this.timelineSpans.push({
        agentId: node.id,
        label: node.label,
        status: node.status,
        startMs: Date.now(),
      });
      this.trimTimeline();
      this.pushEvent('agent:added', { node: { ...node } });
      this.emit('agent:added', node);
    }

    return node;
  }

  /**
   * Remove an agent node and all its edges.
   */
  removeAgent(id: string): boolean {
    if (!this.nodes.has(id)) return false;
    const removeNow = Date.now();
    for (const span of this.timelineSpans) {
      if (span.agentId === id && !span.endMs) {
        span.endMs = removeNow;
      }
    }
    this.nodes.delete(id);
    this.deltaNodesRemoved.add(id);
    this.deltaNodesChanged.delete(id);

    // Remove all edges involving this agent
    for (const [edgeId, edge] of this.edges.entries()) {
      if (edge.from === id || edge.to === id) {
        this.edges.delete(edgeId);
        this.deltaEdgesRemoved.push(edgeId);
        this.pushEvent('edge:removed', { edgeId });
        this.emit('edge:removed', edgeId);
      }
    }

    this.pushEvent('agent:removed', { id });
    this.emit('agent:removed', id);
    return true;
  }

  /**
   * Update an agent's operational status.
   */
  setStatus(id: string, status: AgentNodeStatus): void {
    const node = this.nodes.get(id);
    if (!node) return;

    const prev = node.status;
    if (prev === status) return;

    const now = Date.now();
    // Close the previous span for this agent
    for (let i = this.timelineSpans.length - 1; i >= 0; i--) {
      if (this.timelineSpans[i].agentId === id && !this.timelineSpans[i].endMs) {
        this.timelineSpans[i].endMs = now;
        break;
      }
    }
    // Open a new span
    this.timelineSpans.push({
      agentId: id,
      label: node.label,
      status,
      startMs: now,
    });
    this.trimTimeline();

    node.status = status;
    node.lastActivityAt = new Date().toISOString();
    this.deltaNodesChanged.add(id);
    this.pushEvent('agent:status', { id, status, prev });
    this.emit('agent:status', id, status, prev);
  }

  /**
   * Update or clear the agent's current task.
   */
  setTask(id: string, task?: string): void {
    const node = this.nodes.get(id);
    if (!node) return;

    node.currentTask = task;
    node.lastActivityAt = new Date().toISOString();
    this.deltaNodesChanged.add(id);
    this.pushEvent('agent:task', { id, task });
    this.emit('agent:task', id, task);
  }

  /**
   * Add tokens consumed by an agent.
   */
  addTokens(id: string, tokens: number): void {
    const node = this.nodes.get(id);
    if (!node) return;

    node.tokensUsed += tokens;
    node.lastActivityAt = new Date().toISOString();
    this.deltaNodesChanged.add(id);
    this.pushEvent('agent:tokens', { id, tokens: node.tokensUsed, delta: tokens });
    this.emit('agent:tokens', id, node.tokensUsed);
  }

  /**
   * Get a single agent node.
   */
  getAgent(id: string): AgentNode | undefined {
    const node = this.nodes.get(id);
    return node ? { ...node } : undefined;
  }

  /**
   * Get all agent nodes.
   */
  getAgents(): AgentNode[] {
    return Array.from(this.nodes.values()).map(n => ({ ...n }));
  }

  // --------------------------------------------------------------------------
  // EDGE OPERATIONS
  // --------------------------------------------------------------------------

  /**
   * Add a directed edge between agents.
   */
  addEdge(
    from: string,
    to: string,
    type: EdgeType,
    label?: string,
    metadata?: Record<string, unknown>,
  ): TopologyEdge {
    const id = `e-${++edgeCounter}-${Date.now().toString(36)}`;
    const edge: TopologyEdge = {
      id,
      from,
      to,
      type,
      label,
      timestamp: new Date().toISOString(),
      metadata,
    };

    this.edges.set(id, edge);
    this.deltaEdgesAdded.push(id);

    // Prune if over limit
    if (this.edges.size > this.maxEdges) {
      const oldest = this.edges.keys().next().value;
      if (oldest) {
        this.edges.delete(oldest);
      }
    }

    this.pushEvent('edge:added', { edge: { ...edge } });
    this.emit('edge:added', edge);
    return edge;
  }

  /**
   * Remove an edge by id.
   */
  removeEdge(edgeId: string): boolean {
    if (!this.edges.has(edgeId)) return false;
    this.edges.delete(edgeId);
    this.deltaEdgesRemoved.push(edgeId);
    this.pushEvent('edge:removed', { edgeId });
    this.emit('edge:removed', edgeId);
    return true;
  }

  /**
   * Get all edges, optionally filtered by agent id.
   */
  getEdges(agentId?: string): TopologyEdge[] {
    const all = Array.from(this.edges.values());
    if (!agentId) return all.map(e => ({ ...e }));
    return all
      .filter(e => e.from === agentId || e.to === agentId)
      .map(e => ({ ...e }));
  }

  /**
   * Get edges between two specific agents.
   */
  getEdgesBetween(from: string, to: string): TopologyEdge[] {
    return Array.from(this.edges.values())
      .filter(e => e.from === from && e.to === to)
      .map(e => ({ ...e }));
  }

  // --------------------------------------------------------------------------
  // NARRATIVE, PHASE, ATTENTION, TIMELINE
  // --------------------------------------------------------------------------

  /**
   * Generate a one-line narrative summary of the current topology state.
   */
  generateNarrative(): string {
    const agents = Array.from(this.nodes.values());
    if (agents.length === 0) return 'No agents registered.';

    const running = agents.filter(a => a.status === 'running');
    const failed = agents.filter(a => a.status === 'failed');
    const completed = agents.filter(a => a.status === 'completed');
    const waiting = agents.filter(a => a.status === 'waiting');
    const parts: string[] = [];

    if (running.length > 0) {
      const names = running.slice(0, 3).map(a => a.label);
      const suffix = running.length > 3 ? ` +${running.length - 3} more` : '';
      parts.push(`${names.join(', ')}${suffix} running`);
    }
    if (waiting.length > 0) {
      parts.push(`${waiting.length} waiting`);
    }
    if (failed.length > 0) {
      parts.push(`${failed.length} failed`);
    }
    if (completed.length > 0) {
      parts.push(`${completed.length}/${agents.length} completed`);
    }
    if (parts.length === 0) {
      return `${agents.length} agent${agents.length !== 1 ? 's' : ''} idle.`;
    }
    return parts.join(' \u00b7 ') + '.';
  }

  /**
   * Compute phase progress from agent roles and statuses.
   */
  computePhase(): PhaseProgress {
    const agents = Array.from(this.nodes.values());
    if (agents.length === 0) {
      return { milestones: [], progress: 0, currentPhase: 'idle' };
    }

    const phaseOrder: { role: AgentRole; label: string }[] = [
      { role: 'orchestrator', label: 'Orchestrate' },
      { role: 'planner', label: 'Plan' },
      { role: 'worker', label: 'Execute' },
      { role: 'validator', label: 'Validate' },
      { role: 'aggregator', label: 'Aggregate' },
    ];

    const milestones: PhaseMilestone[] = [];
    let currentPhase = 'idle';
    let completedCount = 0;

    for (const phase of phaseOrder) {
      const phaseAgents = agents.filter(a => a.role === phase.role);
      if (phaseAgents.length === 0) continue;

      const allDone = phaseAgents.every(a => a.status === 'completed');
      const anyActive = phaseAgents.some(
        a => a.status === 'running' || a.status === 'waiting' || a.status === 'spawning',
      );

      let status: PhaseMilestone['status'] = 'pending';
      if (allDone) {
        status = 'completed';
        completedCount++;
      } else if (anyActive) {
        status = 'active';
        currentPhase = phase.label;
      }

      milestones.push({ name: phase.label, status });
    }

    if (currentPhase === 'idle' && milestones.length > 0) {
      const lastCompleted = [...milestones].reverse().find(m => m.status === 'completed');
      currentPhase = lastCompleted ? lastCompleted.name : milestones[0].name;
    }

    const progress = milestones.length > 0 ? completedCount / milestones.length : 0;
    return { milestones, progress, currentPhase };
  }

  /**
   * Compute the attention-based status panel.
   */
  computeAttention(): AttentionPanel {
    const now = Date.now();
    const agents = Array.from(this.nodes.values());
    const needsAttention: AttentionItem[] = [];
    const activeNow: AttentionItem[] = [];
    const recentlyCompleted: AttentionItem[] = [];

    for (const agent of agents) {
      const elapsed = now - new Date(agent.lastActivityAt).getTime();
      const base: AttentionItem = {
        agentId: agent.id,
        label: agent.label,
        summary: '',
        severity: 'active',
        elapsedMs: elapsed,
        timestamp: agent.lastActivityAt,
      };

      if (agent.status === 'failed') {
        needsAttention.push({
          ...base,
          summary: `Failed${agent.currentTask ? ': ' + agent.currentTask : ''}`,
          severity: 'critical',
        });
      } else if (agent.tokenBudget && agent.tokensUsed / agent.tokenBudget > 0.9) {
        needsAttention.push({
          ...base,
          summary: `Budget ${Math.round(agent.tokensUsed / agent.tokenBudget * 100)}% used`,
          severity: 'critical',
        });
      } else if (agent.status === 'running' && elapsed > 30000) {
        needsAttention.push({
          ...base,
          summary: `Running for ${Math.round(elapsed / 1000)}s — may be stuck`,
          severity: 'critical',
        });
      } else if (agent.status === 'running' || agent.status === 'spawning' || agent.status === 'waiting') {
        activeNow.push({
          ...base,
          summary: agent.currentTask || agent.status,
          severity: 'active',
        });
      } else if (agent.status === 'completed') {
        recentlyCompleted.push({
          ...base,
          summary: agent.currentTask || 'Done',
          severity: 'done',
        });
      }
    }

    return { needsAttention, activeNow, recentlyCompleted };
  }

  /**
   * Get all timeline spans for the Gantt chart.
   */
  getTimelineSpans(): TimelineSpan[] {
    return [...this.timelineSpans];
  }

  // --------------------------------------------------------------------------
  // CLUSTERS & DELTA PROTOCOL
  // --------------------------------------------------------------------------

  /**
   * Compute clusters by grouping agents by role.
   * Returns an array of clusters with aggregate statistics.
   */
  computeClusters(): AgentCluster[] {
    const roleMap = new Map<AgentRole, AgentNode[]>();
    for (const node of this.nodes.values()) {
      const arr = roleMap.get(node.role) ?? [];
      arr.push(node);
      roleMap.set(node.role, arr);
    }

    const clusters: AgentCluster[] = [];
    for (const [role, agents] of roleMap.entries()) {
      const statusCounts: Record<AgentNodeStatus, number> = {
        idle: 0, running: 0, completed: 0, failed: 0, waiting: 0, spawning: 0,
      };
      let totalTokensUsed = 0;
      let totalTokenBudget = 0;
      for (const a of agents) {
        statusCounts[a.status]++;
        totalTokensUsed += a.tokensUsed;
        totalTokenBudget += a.tokenBudget ?? 0;
      }

      clusters.push({
        id: `cluster:${role}`,
        role,
        count: agents.length,
        statusCounts,
        totalTokensUsed,
        totalTokenBudget,
        sampleIds: agents.slice(0, 5).map(a => a.id),
      });
    }
    return clusters;
  }

  /**
   * Get a delta patch of changes since the last call to resetDelta().
   * Use this for incremental WebSocket updates instead of full snapshots.
   */
  delta(sinceSeq: number): TopologyDelta {
    const nodesChanged: AgentNode[] = [];
    for (const id of this.deltaNodesChanged) {
      const node = this.nodes.get(id);
      if (node) nodesChanged.push({ ...node });
    }

    const edgesAdded: TopologyEdge[] = [];
    for (const edgeId of this.deltaEdgesAdded) {
      const edge = this.edges.get(edgeId);
      if (edge) edgesAdded.push({ ...edge });
    }

    const timelineAdded = this.timelineSpans.slice(this.deltaTimelineStart);

    return {
      sinceSeq,
      currentSeq: this.seq,
      nodesChanged,
      nodesRemoved: [...this.deltaNodesRemoved],
      edgesAdded,
      edgesRemoved: [...this.deltaEdgesRemoved],
      narrative: this.generateNarrative(),
      phase: this.computePhase(),
      attention: this.computeAttention(),
      timelineAdded: timelineAdded.map(s => ({ ...s })),
    };
  }

  /**
   * Reset delta tracking. Call after sending a delta to a client.
   */
  resetDelta(): void {
    this.deltaNodesChanged.clear();
    this.deltaNodesRemoved.clear();
    this.deltaEdgesAdded.length = 0;
    this.deltaEdgesRemoved.length = 0;
    this.deltaTimelineStart = this.timelineSpans.length;
  }

  /**
   * Current sequence number for delta protocol.
   */
  currentSeq(): number {
    return this.seq;
  }

  // --------------------------------------------------------------------------
  // SNAPSHOT & EVENTS
  // --------------------------------------------------------------------------

  /**
   * Get a full snapshot of the current topology.
   */
  snapshot(): TopologySnapshot {
    this.pruneExpiredEdges();
    const snap: TopologySnapshot = {
      nodes: this.getAgents(),
      edges: this.getEdges(),
      events: [...this.eventLog],
      timestamp: new Date().toISOString(),
      narrative: this.generateNarrative(),
      phase: this.computePhase(),
      attention: this.computeAttention(),
      timeline: this.getTimelineSpans(),
    };
    this.pushEvent('snapshot', {});
    this.emit('snapshot', snap);
    return snap;
  }

  /**
   * Return snapshot data without emitting events or logging.
   * Used by the dashboard server's broadcast loop to avoid
   * re-entrant event emission (snapshot → event → broadcast → snapshot).
   */
  snapshotQuiet(): TopologySnapshot {
    this.pruneExpiredEdges();
    return {
      nodes: this.getAgents(),
      edges: this.getEdges(),
      events: [...this.eventLog],
      timestamp: new Date().toISOString(),
      narrative: this.generateNarrative(),
      phase: this.computePhase(),
      attention: this.computeAttention(),
      timeline: this.getTimelineSpans(),
    };
  }

  /**
   * Get the event log.
   */
  getEvents(since?: number): TopologyEvent[] {
    if (since === undefined) return [...this.eventLog];
    return this.eventLog.filter(e => e.seq > since);
  }

  /**
   * Number of agent nodes.
   */
  nodeCount(): number {
    return this.nodes.size;
  }

  /**
   * Number of edges.
   */
  edgeCount(): number {
    return this.edges.size;
  }

  /**
   * Clear all nodes, edges, and events.
   */
  clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this.eventLog.length = 0;
    this.timelineSpans.length = 0;
    this.deltaNodesChanged.clear();
    this.deltaNodesRemoved.clear();
    this.deltaEdgesAdded.length = 0;
    this.deltaEdgesRemoved.length = 0;
    this.deltaTimelineStart = 0;
    this.seq = 0;
    this.emit('clear');
  }

  // --------------------------------------------------------------------------
  // INTERNALS
  // --------------------------------------------------------------------------

  private pushEvent(type: TopologyEventType, data: Record<string, unknown>): void {
    const event: TopologyEvent = {
      seq: ++this.seq,
      timestamp: new Date().toISOString(),
      type,
      data,
    };
    this.eventLog.push(event);

    // Trim event log
    if (this.eventLog.length > this.maxEvents) {
      this.eventLog.splice(0, this.eventLog.length - this.maxEvents);
    }

    this.emit('event', event);
  }

  private pruneExpiredEdges(): void {
    if (this.edgeTtlMs <= 0) return;
    const cutoff = Date.now() - this.edgeTtlMs;
    for (const [id, edge] of this.edges.entries()) {
      if (new Date(edge.timestamp).getTime() < cutoff) {
        this.edges.delete(id);
      }
    }
  }

  private trimTimeline(): void {
    if (this.timelineSpans.length > this.maxTimelineSpans) {
      const excess = this.timelineSpans.length - this.maxTimelineSpans;
      this.timelineSpans.splice(0, excess);
      this.deltaTimelineStart = Math.max(0, this.deltaTimelineStart - excess);
    }
  }
}
