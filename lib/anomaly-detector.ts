/**
 * AnomalyDetector — Baseline agent behavior and flag statistical outliers.
 *
 * Maintains rolling statistics (mean, stddev) per agent for latency, token
 * usage, and error rate.  New observations are checked against the baseline
 * and flagged as anomalies when they exceed a configurable z-score threshold.
 *
 * Uses Welford's online algorithm for numerically stable incremental
 * mean/variance — no batch recomputation needed.
 *
 * @module AnomalyDetector
 */

// ============================================================================
// TYPES
// ============================================================================

/** A detected anomaly */
export interface Anomaly {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Agent that triggered the anomaly */
  agentId: string;
  /** Which metric is anomalous */
  metric: AnomalyMetric;
  /** Observed value */
  observed: number;
  /** Baseline mean for this agent + metric */
  baselineMean: number;
  /** Baseline standard deviation */
  baselineStddev: number;
  /** Z-score of the observation */
  zScore: number;
  /** Severity based on z-score magnitude */
  severity: 'warning' | 'critical';
}

/** Metrics that are monitored for anomalies */
export type AnomalyMetric = 'latency' | 'tokens' | 'errorRate';

/** Rolling statistics via Welford's algorithm */
interface WelfordState {
  count: number;
  mean: number;
  m2: number; // sum of squared deviations
}

/** Per-agent baseline */
interface AgentBaseline {
  latency: WelfordState;
  tokens: WelfordState;
  errorRate: WelfordState;
}

/** Summary of an agent's baseline */
export interface BaselineSummary {
  agentId: string;
  latency: { mean: number; stddev: number; samples: number };
  tokens: { mean: number; stddev: number; samples: number };
  errorRate: { mean: number; stddev: number; samples: number };
}

// ============================================================================
// WELFORD HELPERS
// ============================================================================

function welfordInit(): WelfordState {
  return { count: 0, mean: 0, m2: 0 };
}

function welfordUpdate(state: WelfordState, value: number): void {
  state.count++;
  const delta = value - state.mean;
  state.mean += delta / state.count;
  const delta2 = value - state.mean;
  state.m2 += delta * delta2;
}

function welfordStddev(state: WelfordState): number {
  if (state.count < 2) return 0;
  return Math.sqrt(state.m2 / (state.count - 1));
}

function welfordZScore(state: WelfordState, value: number): number {
  const std = welfordStddev(state);
  if (std === 0 || state.count < 5) return 0; // Need minimum samples
  return (value - state.mean) / std;
}

// ============================================================================
// DETECTOR
// ============================================================================

/**
 * Monitors agent behavior and flags statistical anomalies.
 *
 * @example
 * ```ts
 * const detector = new AnomalyDetector();
 *
 * // Feed observations as they occur:
 * detector.observe('agent-1', { latencyMs: 200, tokens: 500, success: true });
 * detector.observe('agent-1', { latencyMs: 15000, tokens: 500, success: true });
 * // ^ second call may flag latency anomaly if baseline is ~200ms
 *
 * const anomalies = detector.getAnomalies();
 * const baseline = detector.getBaseline('agent-1');
 * ```
 */
export class AnomalyDetector {
  private baselines: Map<string, AgentBaseline> = new Map();
  private anomalies: Anomaly[] = [];
  private maxAnomalies: number;
  private warningThreshold: number;
  private criticalThreshold: number;
  private minSamples: number;
  private errorWindow: Map<string, { total: number; errors: number }> = new Map();

  constructor(options?: {
    /** Z-score threshold for 'warning' level. Default 2.0 */
    warningThreshold?: number;
    /** Z-score threshold for 'critical' level. Default 3.0 */
    criticalThreshold?: number;
    /** Minimum samples before anomaly detection activates. Default 10 */
    minSamples?: number;
    /** Max anomalies to retain. Default 1000 */
    maxAnomalies?: number;
  }) {
    this.warningThreshold = options?.warningThreshold ?? 2.0;
    this.criticalThreshold = options?.criticalThreshold ?? 3.0;
    this.minSamples = options?.minSamples ?? 10;
    this.maxAnomalies = options?.maxAnomalies ?? 1000;
  }

  /**
   * Record an observation for an agent and check for anomalies.
   * Returns any anomalies detected from this observation.
   */
  observe(agentId: string, obs: {
    latencyMs: number;
    tokens: number;
    success: boolean;
  }): Anomaly[] {
    let baseline = this.baselines.get(agentId);
    if (!baseline) {
      baseline = {
        latency: welfordInit(),
        tokens: welfordInit(),
        errorRate: welfordInit(),
      };
      this.baselines.set(agentId, baseline);
    }

    // Update error rate tracking
    let errWin = this.errorWindow.get(agentId);
    if (!errWin) { errWin = { total: 0, errors: 0 }; this.errorWindow.set(agentId, errWin); }
    errWin.total++;
    if (!obs.success) errWin.errors++;
    const currentErrorRate = errWin.total > 0 ? errWin.errors / errWin.total : 0;

    const detected: Anomaly[] = [];

    // Check before updating baseline (compare against historical)
    detected.push(
      ...this.checkMetric(agentId, 'latency', baseline.latency, obs.latencyMs),
    );
    detected.push(
      ...this.checkMetric(agentId, 'tokens', baseline.tokens, obs.tokens),
    );
    detected.push(
      ...this.checkMetric(agentId, 'errorRate', baseline.errorRate, currentErrorRate),
    );

    // Now update baselines
    welfordUpdate(baseline.latency, obs.latencyMs);
    welfordUpdate(baseline.tokens, obs.tokens);
    welfordUpdate(baseline.errorRate, currentErrorRate);

    // Store detected anomalies
    for (const a of detected) {
      this.anomalies.push(a);
    }
    if (this.anomalies.length > this.maxAnomalies) {
      this.anomalies.splice(0, this.anomalies.length - this.maxAnomalies);
    }

    return detected;
  }

  /** Get all recorded anomalies, optionally filtered by agent */
  getAnomalies(agentId?: string): Anomaly[] {
    if (agentId) return this.anomalies.filter(a => a.agentId === agentId);
    return [...this.anomalies];
  }

  /** Get recent anomalies (last N) */
  getRecentAnomalies(count: number): Anomaly[] {
    return this.anomalies.slice(-count);
  }

  /** Get the baseline summary for an agent */
  getBaseline(agentId: string): BaselineSummary | null {
    const b = this.baselines.get(agentId);
    if (!b) return null;
    return {
      agentId,
      latency: { mean: b.latency.mean, stddev: welfordStddev(b.latency), samples: b.latency.count },
      tokens: { mean: b.tokens.mean, stddev: welfordStddev(b.tokens), samples: b.tokens.count },
      errorRate: { mean: b.errorRate.mean, stddev: welfordStddev(b.errorRate), samples: b.errorRate.count },
    };
  }

  /** List all agents with baselines */
  listAgents(): string[] {
    return [...this.baselines.keys()];
  }

  /** Total anomalies recorded */
  get anomalyCount(): number {
    return this.anomalies.length;
  }

  /** Clear all baselines and anomalies */
  clear(): void {
    this.baselines.clear();
    this.anomalies.length = 0;
    this.errorWindow.clear();
  }

  /** Clear data for a specific agent */
  clearAgent(agentId: string): void {
    this.baselines.delete(agentId);
    this.errorWindow.delete(agentId);
    this.anomalies = this.anomalies.filter(a => a.agentId !== agentId);
  }

  private checkMetric(
    agentId: string,
    metric: AnomalyMetric,
    state: WelfordState,
    value: number,
  ): Anomaly[] {
    if (state.count < this.minSamples) return [];

    const z = welfordZScore(state, value);
    const absZ = Math.abs(z);

    if (absZ >= this.warningThreshold) {
      return [{
        timestamp: new Date().toISOString(),
        agentId,
        metric,
        observed: value,
        baselineMean: state.mean,
        baselineStddev: welfordStddev(state),
        zScore: z,
        severity: absZ >= this.criticalThreshold ? 'critical' : 'warning',
      }];
    }

    return [];
  }
}
