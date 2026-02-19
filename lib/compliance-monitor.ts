/**
 * Real-Time Compliance Monitor — Phase 4: Behavioral Control Plane
 *
 * Async monitoring loop that continuously checks for:
 * - Turn-taking violations (agent acting out of turn)
 * - Response timeouts (agent silent for too long)
 * - Journey adherence (current FSM state timed out)
 * - Tool usage anomalies (tool called more than allowed rate)
 *
 * @module compliance-monitor
 */

import type { JourneyFSM } from './fsm-journey';

// ============================================================================
// TYPES
// ============================================================================

/** Categories of compliance violation. */
export type ViolationType =
  | 'TURN_TAKING'
  | 'RESPONSE_TIMEOUT'
  | 'JOURNEY_TIMEOUT'
  | 'TOOL_ABUSE'
  | 'UNAUTHORIZED_ACTION'
  | 'RATE_LIMIT';

/** A single compliance violation event. */
export interface ComplianceViolation {
  id: string;
  type: ViolationType;
  agentId: string;
  message: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/** An action record submitted to the monitor. */
export interface AgentAction {
  agentId: string;
  action: string;
  tool?: string;
  timestamp?: number;
}

/** Per-agent settings for the monitor. */
export interface AgentMonitorConfig {
  agentId: string;
  /** Max time (ms) allowed between actions before a `RESPONSE_TIMEOUT` is raised. */
  responseTimeoutMs?: number;
  /** Max number of tool calls per `toolRateWindowMs`. */
  maxToolCallsPerWindow?: number;
  /** Window size (ms) for tool rate limiting. Default: 60_000. */
  toolRateWindowMs?: number;
}

/** Options for the ComplianceMonitor. */
export interface ComplianceMonitorOptions {
  /** How often the monitor polls for violations (ms). Default: 5_000. */
  pollIntervalMs?: number;
  /** Per-agent config for timeouts and rate limits. */
  agentConfigs?: AgentMonitorConfig[];
  /** Called when a violation is detected. */
  onViolation?: (violation: ComplianceViolation) => void;
  /** FSM reference — enables journey-adherence and state-timeout checks. */
  fsm?: JourneyFSM;
  /** If true, violations are also collected internally (getViolations()). Default: true. */
  collectViolations?: boolean;
  /** Max violations kept in memory. Default: 500. */
  maxViolationsInMemory?: number;
}

// ============================================================================
// COMPLIANCE MONITOR
// ============================================================================

/**
 * Real-time async compliance monitor.
 *
 * @example
 * ```typescript
 * import { ComplianceMonitor } from 'network-ai';
 *
 * const monitor = new ComplianceMonitor({
 *   pollIntervalMs: 5_000,
 *   fsm,
 *   agentConfigs: [
 *     { agentId: 'data_analyst', responseTimeoutMs: 30_000, maxToolCallsPerWindow: 10 },
 *   ],
 *   onViolation: v => console.warn('[COMPLIANCE]', v.type, v.message),
 * });
 *
 * monitor.start();
 *
 * // Record actions as agents work
 * monitor.recordAction({ agentId: 'data_analyst', action: 'query', tool: 'query_db' });
 *
 * // Later…
 * monitor.stop();
 * const violations = monitor.getViolations();
 * ```
 */
export class ComplianceMonitor {
  private options: Required<Omit<ComplianceMonitorOptions, 'fsm' | 'onViolation' | 'agentConfigs'>> & {
    fsm?: JourneyFSM;
    onViolation?: (v: ComplianceViolation) => void;
    agentConfigs: AgentMonitorConfig[];
  };

  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  // agentId -> last action timestamp
  private lastActionAt: Map<string, number> = new Map();
  // agentId -> { tool -> timestamps[] }
  private toolCallLog: Map<string, Map<string, number[]>> = new Map();
  // recorded turn order
  private turnOrder: string[] = [];
  // violations collected internally
  private violations: ComplianceViolation[] = [];
  // agentId -> action count (for sequential turn checking)
  private consecutiveActionsBy: Map<string, number> = new Map();
  private lastActingAgent: string | null = null;

  constructor(options: ComplianceMonitorOptions = {}) {
    this.options = {
      pollIntervalMs:        options.pollIntervalMs        ?? 5_000,
      agentConfigs:          options.agentConfigs          ?? [],
      collectViolations:     options.collectViolations     ?? true,
      maxViolationsInMemory: options.maxViolationsInMemory ?? 500,
      fsm:         options.fsm,
      onViolation: options.onViolation,
    };
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /** Start the monitoring loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this._poll(), this.options.pollIntervalMs);
  }

  /** Stop the monitoring loop. */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Whether the monitor is currently running. */
  get isRunning(): boolean {
    return this.running;
  }

  // --------------------------------------------------------------------------
  // Action recording
  // --------------------------------------------------------------------------

  /**
   * Record an agent action. Call this every time an agent performs an action
   * so the monitor can track turn-taking, timeouts, and tool rates.
   */
  recordAction(action: AgentAction): void {
    const now = action.timestamp ?? Date.now();
    const { agentId, tool } = action;

    this.lastActionAt.set(agentId, now);

    // Track turn taking
    if (this.lastActingAgent !== null && this.lastActingAgent !== agentId) {
      this.consecutiveActionsBy.set(this.lastActingAgent, 0);
    }
    const prev = this.consecutiveActionsBy.get(agentId) ?? 0;
    this.consecutiveActionsBy.set(agentId, prev + 1);
    this.lastActingAgent = agentId;
    this.turnOrder.push(agentId);
    // Keep turn order bounded
    if (this.turnOrder.length > 1000) this.turnOrder.splice(0, 500);

    // Track tool calls
    if (tool) {
      if (!this.toolCallLog.has(agentId)) this.toolCallLog.set(agentId, new Map());
      const agentTools = this.toolCallLog.get(agentId)!;
      if (!agentTools.has(tool)) agentTools.set(tool, []);
      agentTools.get(tool)!.push(now);
    }

    // Immediate tool-rate check
    if (tool) this._checkToolRate(agentId, tool, now);
  }

  // --------------------------------------------------------------------------
  // Queries
  // --------------------------------------------------------------------------

  /** Get all collected violations (newest last). */
  getViolations(filter?: { type?: ViolationType; agentId?: string; severity?: ComplianceViolation['severity'] }): ComplianceViolation[] {
    if (!filter) return [...this.violations];
    return this.violations.filter(v => {
      if (filter.type      && v.type      !== filter.type)      return false;
      if (filter.agentId   && v.agentId   !== filter.agentId)   return false;
      if (filter.severity  && v.severity  !== filter.severity)  return false;
      return true;
    });
  }

  /** Clear collected violations. */
  clearViolations(): void {
    this.violations = [];
  }

  /** Get a compliance summary (counts per type and agent). */
  getSummary(): {
    total: number;
    bySeverity: Record<string, number>;
    byType: Record<string, number>;
    byAgent: Record<string, number>;
  } {
    const bySeverity: Record<string, number> = {};
    const byType: Record<string, number>     = {};
    const byAgent: Record<string, number>    = {};
    for (const v of this.violations) {
      bySeverity[v.severity]  = (bySeverity[v.severity]  ?? 0) + 1;
      byType[v.type]          = (byType[v.type]          ?? 0) + 1;
      byAgent[v.agentId]      = (byAgent[v.agentId]      ?? 0) + 1;
    }
    return { total: this.violations.length, bySeverity, byType, byAgent };
  }

  /** Update (or add) a per-agent config at runtime. */
  setAgentConfig(config: AgentMonitorConfig): void {
    const idx = this.options.agentConfigs.findIndex(c => c.agentId === config.agentId);
    if (idx >= 0) this.options.agentConfigs[idx] = config;
    else this.options.agentConfigs.push(config);
  }

  // --------------------------------------------------------------------------
  // Internal polling
  // --------------------------------------------------------------------------

  private _poll(): void {
    this._checkResponseTimeouts();
    this._checkJourneyTimeout();
    this._checkTurnTaking();
  }

  private _checkResponseTimeouts(): void {
    const now = Date.now();
    for (const cfg of this.options.agentConfigs) {
      if (!cfg.responseTimeoutMs) continue;
      const lastAt = this.lastActionAt.get(cfg.agentId);
      if (!lastAt) continue;
      const elapsed = now - lastAt;
      if (elapsed > cfg.responseTimeoutMs) {
        this._emit({
          type: 'RESPONSE_TIMEOUT',
          agentId: cfg.agentId,
          message: `Agent "${cfg.agentId}" has been silent for ${Math.round(elapsed / 1000)}s (limit: ${Math.round(cfg.responseTimeoutMs / 1000)}s)`,
          severity: 'high',
          metadata: { elapsed, limit: cfg.responseTimeoutMs },
        });
      }
    }
  }

  private _checkJourneyTimeout(): void {
    const fsm = this.options.fsm;
    if (!fsm) return;
    if (fsm.isTimedOut) {
      this._emit({
        type: 'JOURNEY_TIMEOUT',
        agentId: 'system',
        message: `FSM state "${fsm.state}" has exceeded its timeout (${fsm.timeInCurrentState}ms elapsed)`,
        severity: 'high',
        metadata: { state: fsm.state, elapsed: fsm.timeInCurrentState },
      });
    }
  }

  private _checkTurnTaking(): void {
    // Detect any single agent acting more than 5 consecutive times
    for (const [agentId, count] of this.consecutiveActionsBy) {
      if (count >= 5) {
        this._emit({
          type: 'TURN_TAKING',
          agentId,
          message: `Agent "${agentId}" has taken ${count} consecutive actions without yielding`,
          severity: 'medium',
          metadata: { consecutiveCount: count },
        });
        // Reset after emitting so we don't spam
        this.consecutiveActionsBy.set(agentId, 0);
      }
    }
  }

  private _checkToolRate(agentId: string, tool: string, now: number): void {
    const cfg = this.options.agentConfigs.find(c => c.agentId === agentId);
    if (!cfg?.maxToolCallsPerWindow) return;

    const windowMs     = cfg.toolRateWindowMs ?? 60_000;
    const maxCalls     = cfg.maxToolCallsPerWindow;
    const timestamps   = this.toolCallLog.get(agentId)?.get(tool) ?? [];
    const windowStart  = now - windowMs;
    const recentCalls  = timestamps.filter(t => t >= windowStart);

    if (recentCalls.length > maxCalls) {
      this._emit({
        type: 'TOOL_ABUSE',
        agentId,
        message: `Agent "${agentId}" called tool "${tool}" ${recentCalls.length}x in ${windowMs / 1000}s (max: ${maxCalls})`,
        severity: 'high',
        metadata: { tool, callCount: recentCalls.length, windowMs, max: maxCalls },
      });
    }
  }

  private _emit(params: Omit<ComplianceViolation, 'id' | 'timestamp'>): void {
    const violation: ComplianceViolation = {
      id: `cv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      ...params,
    };

    if (this.options.collectViolations) {
      this.violations.push(violation);
      // Trim if over limit
      if (this.violations.length > this.options.maxViolationsInMemory) {
        this.violations.splice(0, Math.floor(this.options.maxViolationsInMemory / 4));
      }
    }

    this.options.onViolation?.(violation);
  }
}
