/**
 * CostHeatmap — Per-agent cost & performance overlay for the topology graph.
 *
 * Tracks token spend (with configurable USD-per-token rates), latency
 * percentiles, throughput, and error rates per agent so the dashboard can
 * render a cost/performance heatmap on top of the topology view.
 *
 * @module CostHeatmap
 */

// ============================================================================
// TYPES
// ============================================================================

/** Per-model cost rates (USD per 1K tokens) */
export interface CostRate {
  inputPer1k: number;
  outputPer1k: number;
}

/** Recorded data point for one agent execution */
export interface ExecutionSample {
  timestamp: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  success: boolean;
}

/** Heatmap cell for a single agent */
export interface HeatmapCell {
  agentId: string;
  /** Total estimated cost in USD */
  costUsd: number;
  /** Total tokens consumed (input + output) */
  totalTokens: number;
  /** Number of executions */
  executions: number;
  /** Error count */
  errors: number;
  /** Error rate (0-1) */
  errorRate: number;
  /** Average latency in ms */
  avgLatencyMs: number;
  /** p50 latency ms */
  p50LatencyMs: number;
  /** p95 latency ms */
  p95LatencyMs: number;
  /** p99 latency ms */
  p99LatencyMs: number;
  /** Throughput: executions per minute (over the window) */
  throughputPerMin: number;
  /** Normalized heat value 0-1 (higher = more expensive/slow) */
  heat: number;
}

/** Full heatmap snapshot */
export interface HeatmapSnapshot {
  timestamp: string;
  cells: HeatmapCell[];
  totalCostUsd: number;
  totalTokens: number;
  hottestAgent: string | null;
}

// ============================================================================
// HEATMAP
// ============================================================================

/**
 * Tracks per-agent cost and performance for heatmap rendering.
 *
 * @example
 * ```ts
 * const heatmap = new CostHeatmap();
 * heatmap.setCostRate('gpt-4', { inputPer1k: 0.03, outputPer1k: 0.06 });
 * heatmap.record('agent-1', { durationMs: 200, inputTokens: 500, outputTokens: 100, success: true });
 * const snap = heatmap.getSnapshot();
 * ```
 */
export class CostHeatmap {
  private samples: Map<string, ExecutionSample[]> = new Map();
  private costRates: Map<string, CostRate> = new Map();
  private agentModels: Map<string, string> = new Map();
  private defaultRate: CostRate = { inputPer1k: 0.01, outputPer1k: 0.03 };
  private maxSamplesPerAgent: number;
  private windowMs: number;

  constructor(options?: {
    /** Max samples to keep per agent. Default 1000 */
    maxSamplesPerAgent?: number;
    /** Time window for throughput calculation (ms). Default 60_000 (1 min) */
    windowMs?: number;
    /** Default cost rate if no model-specific rate set */
    defaultRate?: CostRate;
  }) {
    this.maxSamplesPerAgent = options?.maxSamplesPerAgent ?? 1000;
    this.windowMs = options?.windowMs ?? 60_000;
    if (options?.defaultRate) this.defaultRate = options.defaultRate;
  }

  /** Set the cost rate for a model */
  setCostRate(model: string, rate: CostRate): void {
    this.costRates.set(model, rate);
  }

  /** Associate an agent with a model (for cost lookups) */
  setAgentModel(agentId: string, model: string): void {
    this.agentModels.set(agentId, model);
  }

  /** Record an execution sample for an agent */
  record(
    agentId: string,
    sample: Omit<ExecutionSample, 'timestamp'> & { timestamp?: number },
  ): void {
    let list = this.samples.get(agentId);
    if (!list) {
      list = [];
      this.samples.set(agentId, list);
    }

    list.push({
      timestamp: sample.timestamp ?? Date.now(),
      durationMs: sample.durationMs,
      inputTokens: sample.inputTokens,
      outputTokens: sample.outputTokens,
      success: sample.success,
    });

    // Evict oldest
    if (list.length > this.maxSamplesPerAgent) {
      list.splice(0, list.length - this.maxSamplesPerAgent);
    }
  }

  /** Get the heatmap cell for a single agent */
  getCell(agentId: string): HeatmapCell | null {
    const list = this.samples.get(agentId);
    if (!list || list.length === 0) return null;
    return this.computeCell(agentId, list);
  }

  /** Get the full heatmap snapshot */
  getSnapshot(): HeatmapSnapshot {
    const cells: HeatmapCell[] = [];
    let totalCostUsd = 0;
    let totalTokens = 0;

    for (const [agentId, list] of this.samples) {
      if (list.length === 0) continue;
      const cell = this.computeCell(agentId, list);
      cells.push(cell);
      totalCostUsd += cell.costUsd;
      totalTokens += cell.totalTokens;
    }

    // Normalize heat values (relative to max cost in this snapshot)
    const maxCost = Math.max(...cells.map(c => c.costUsd), 0.001);
    const maxLatency = Math.max(...cells.map(c => c.p95LatencyMs), 1);
    for (const cell of cells) {
      // Heat = 60% cost weight + 40% latency weight
      cell.heat = Math.min(1, 0.6 * (cell.costUsd / maxCost) + 0.4 * (cell.p95LatencyMs / maxLatency));
    }

    cells.sort((a, b) => b.heat - a.heat);

    return {
      timestamp: new Date().toISOString(),
      cells,
      totalCostUsd,
      totalTokens,
      hottestAgent: cells.length > 0 ? cells[0].agentId : null,
    };
  }

  /** List all tracked agent IDs */
  listAgents(): string[] {
    return [...this.samples.keys()];
  }

  /** Clear all data */
  clear(): void {
    this.samples.clear();
  }

  /** Clear data for a specific agent */
  clearAgent(agentId: string): void {
    this.samples.delete(agentId);
  }

  private computeCell(agentId: string, list: ExecutionSample[]): HeatmapCell {
    const model = this.agentModels.get(agentId);
    const rate = model ? (this.costRates.get(model) ?? this.defaultRate) : this.defaultRate;

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalDurationMs = 0;
    let errors = 0;
    const durations: number[] = [];
    const now = Date.now();
    let recentCount = 0;

    for (const s of list) {
      totalInputTokens += s.inputTokens;
      totalOutputTokens += s.outputTokens;
      totalDurationMs += s.durationMs;
      durations.push(s.durationMs);
      if (!s.success) errors++;
      if (now - s.timestamp <= this.windowMs) recentCount++;
    }

    durations.sort((a, b) => a - b);
    const totalTokens = totalInputTokens + totalOutputTokens;
    const costUsd = (totalInputTokens / 1000) * rate.inputPer1k + (totalOutputTokens / 1000) * rate.outputPer1k;

    return {
      agentId,
      costUsd,
      totalTokens,
      executions: list.length,
      errors,
      errorRate: list.length > 0 ? errors / list.length : 0,
      avgLatencyMs: list.length > 0 ? totalDurationMs / list.length : 0,
      p50LatencyMs: this.percentile(durations, 0.50),
      p95LatencyMs: this.percentile(durations, 0.95),
      p99LatencyMs: this.percentile(durations, 0.99),
      throughputPerMin: this.windowMs > 0 ? (recentCount / this.windowMs) * 60_000 : 0,
      heat: 0, // Will be normalized in getSnapshot()
    };
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil(p * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }
}
