/**
 * MetricsRegistry — Zero-dependency Prometheus-compatible metrics.
 *
 * Provides Counter, Gauge, and Histogram metric types with label support.
 * Exports metrics in Prometheus text exposition format for scraping.
 *
 * No runtime dependencies — drop-in for any HTTP server or the MCP endpoint.
 *
 * @module Metrics
 */

// ============================================================================
// TYPES
// ============================================================================

/** Supported metric types */
export type MetricType = 'counter' | 'gauge' | 'histogram';

/** A set of label key-value pairs */
export type Labels = Record<string, string>;

/** Configuration for a histogram */
export interface HistogramBuckets {
  /** Upper bounds for each bucket (must be sorted ascending) */
  boundaries: number[];
}

/** Default latency buckets (ms) */
const DEFAULT_BUCKETS: number[] = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

// ============================================================================
// METRIC PRIMITIVES
// ============================================================================

/** Serialise labels into the Prometheus `{k="v",k2="v2"}` format */
function labelsToString(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return '{' + entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',') + '}';
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labelKey(labels: Labels): string {
  return Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(',');
}

/** Internal storage for one metric series (one set of labels) */
interface CounterSeries { value: number }
interface GaugeSeries { value: number }
interface HistogramSeries { bucketCounts: number[]; sum: number; count: number }

// ============================================================================
// METRIC CLASSES
// ============================================================================

/** Monotonically increasing counter */
export class Counter {
  readonly name: string;
  readonly help: string;
  private series: Map<string, CounterSeries> = new Map();
  private labelMap: Map<string, Labels> = new Map();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  inc(labels: Labels = {}, amount = 1): void {
    if (amount < 0) throw new Error('Counter can only be incremented');
    const key = labelKey(labels);
    const s = this.series.get(key);
    if (s) { s.value += amount; }
    else { this.series.set(key, { value: amount }); this.labelMap.set(key, labels); }
  }

  get(labels: Labels = {}): number {
    return this.series.get(labelKey(labels))?.value ?? 0;
  }

  /** Prometheus text lines */
  expose(): string {
    const lines: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, s] of this.series) {
      lines.push(`${this.name}${labelsToString(this.labelMap.get(key)!)} ${s.value}`);
    }
    return lines.join('\n');
  }
}

/** Gauge — can go up or down */
export class Gauge {
  readonly name: string;
  readonly help: string;
  private series: Map<string, GaugeSeries> = new Map();
  private labelMap: Map<string, Labels> = new Map();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  set(labels: Labels, value: number): void;
  set(value: number): void;
  set(labelsOrValue: Labels | number, value?: number): void {
    if (typeof labelsOrValue === 'number') {
      const key = labelKey({});
      const s = this.series.get(key);
      if (s) { s.value = labelsOrValue; }
      else { this.series.set(key, { value: labelsOrValue }); this.labelMap.set(key, {}); }
    } else {
      const key = labelKey(labelsOrValue);
      const s = this.series.get(key);
      if (s) { s.value = value!; }
      else { this.series.set(key, { value: value! }); this.labelMap.set(key, labelsOrValue); }
    }
  }

  inc(labels: Labels = {}, amount = 1): void {
    const key = labelKey(labels);
    const s = this.series.get(key);
    if (s) { s.value += amount; }
    else { this.series.set(key, { value: amount }); this.labelMap.set(key, labels); }
  }

  dec(labels: Labels = {}, amount = 1): void {
    this.inc(labels, -amount);
  }

  get(labels: Labels = {}): number {
    return this.series.get(labelKey(labels))?.value ?? 0;
  }

  expose(): string {
    const lines: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [key, s] of this.series) {
      lines.push(`${this.name}${labelsToString(this.labelMap.get(key)!)} ${s.value}`);
    }
    return lines.join('\n');
  }
}

/** Histogram with configurable buckets */
export class Histogram {
  readonly name: string;
  readonly help: string;
  readonly boundaries: number[];
  private series: Map<string, HistogramSeries> = new Map();
  private labelMap: Map<string, Labels> = new Map();

  constructor(name: string, help: string, buckets?: HistogramBuckets) {
    this.name = name;
    this.help = help;
    this.boundaries = buckets?.boundaries ?? DEFAULT_BUCKETS;
  }

  observe(labels: Labels, value: number): void;
  observe(value: number): void;
  observe(labelsOrValue: Labels | number, value?: number): void {
    const labels = typeof labelsOrValue === 'number' ? {} : labelsOrValue;
    const v = typeof labelsOrValue === 'number' ? labelsOrValue : value!;
    const key = labelKey(labels);

    let s = this.series.get(key);
    if (!s) {
      s = { bucketCounts: new Array(this.boundaries.length + 1).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
      this.labelMap.set(key, labels);
    }

    s.sum += v;
    s.count++;
    for (let i = 0; i < this.boundaries.length; i++) {
      if (v <= this.boundaries[i]) {
        s.bucketCounts[i]++;
      }
    }
    s.bucketCounts[this.boundaries.length]++; // +Inf bucket
  }

  expose(): string {
    const lines: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, s] of this.series) {
      const lbl = this.labelMap.get(key)!;
      const base = labelsToString(lbl);
      const comma = Object.keys(lbl).length > 0 ? ',' : '';

      for (let i = 0; i < this.boundaries.length; i++) {
        const le = this.boundaries[i];
        lines.push(`${this.name}_bucket{${comma ? base.slice(1, -1) + ',' : ''}le="${le}"} ${s.bucketCounts[i]}`);
      }
      lines.push(`${this.name}_bucket{${comma ? base.slice(1, -1) + ',' : ''}le="+Inf"} ${s.bucketCounts[this.boundaries.length]}`);
      lines.push(`${this.name}_sum${base} ${s.sum}`);
      lines.push(`${this.name}_count${base} ${s.count}`);
    }
    return lines.join('\n');
  }
}

// ============================================================================
// REGISTRY
// ============================================================================

/**
 * Central metrics registry. Collects all metrics and exposes them in
 * Prometheus text format.
 *
 * @example
 * ```ts
 * const registry = new MetricsRegistry();
 * const delegations = registry.counter('nai_delegations_total', 'Total delegations');
 * const activeAgents = registry.gauge('nai_active_agents', 'Currently active agents');
 * const latency = registry.histogram('nai_delegation_duration_ms', 'Delegation latency');
 *
 * delegations.inc({ agent: 'planner' });
 * activeAgents.set(5);
 * latency.observe({ agent: 'planner' }, 142);
 *
 * const text = registry.expose(); // Prometheus text exposition format
 * ```
 */
export class MetricsRegistry {
  private counters: Map<string, Counter> = new Map();
  private gauges: Map<string, Gauge> = new Map();
  private histograms: Map<string, Histogram> = new Map();

  /** Create or retrieve a counter */
  counter(name: string, help: string): Counter {
    let c = this.counters.get(name);
    if (!c) { c = new Counter(name, help); this.counters.set(name, c); }
    return c;
  }

  /** Create or retrieve a gauge */
  gauge(name: string, help: string): Gauge {
    let g = this.gauges.get(name);
    if (!g) { g = new Gauge(name, help); this.gauges.set(name, g); }
    return g;
  }

  /** Create or retrieve a histogram */
  histogram(name: string, help: string, buckets?: HistogramBuckets): Histogram {
    let h = this.histograms.get(name);
    if (!h) { h = new Histogram(name, help, buckets); this.histograms.set(name, h); }
    return h;
  }

  /**
   * Export all registered metrics in Prometheus text exposition format.
   */
  expose(): string {
    const parts: string[] = [];
    for (const c of this.counters.values()) parts.push(c.expose());
    for (const g of this.gauges.values()) parts.push(g.expose());
    for (const h of this.histograms.values()) parts.push(h.expose());
    return parts.join('\n\n') + '\n';
  }

  /** Get a specific counter by name */
  getCounter(name: string): Counter | undefined { return this.counters.get(name); }

  /** Get a specific gauge by name */
  getGauge(name: string): Gauge | undefined { return this.gauges.get(name); }

  /** Get a specific histogram by name */
  getHistogram(name: string): Histogram | undefined { return this.histograms.get(name); }

  /** Total number of registered metrics */
  get size(): number {
    return this.counters.size + this.gauges.size + this.histograms.size;
  }
}

// ============================================================================
// PRE-BUILT ORCHESTRATOR METRICS
// ============================================================================

/**
 * Create a pre-configured MetricsRegistry with standard orchestrator metrics.
 *
 * Returns the registry and named handles to the individual metrics.
 */
export function createOrchestratorMetrics(): {
  registry: MetricsRegistry;
  delegationsTotal: Counter;
  delegationErrors: Counter;
  permissionChecks: Counter;
  permissionDenials: Counter;
  injectionBlocks: Counter;
  qualityRejections: Counter;
  blackboardWrites: Counter;
  activeAgents: Gauge;
  blackboardSize: Gauge;
  budgetUsedPercent: Gauge;
  delegationDurationMs: Histogram;
  adapterDurationMs: Histogram;
} {
  const registry = new MetricsRegistry();
  return {
    registry,
    delegationsTotal: registry.counter('nai_delegations_total', 'Total task delegations'),
    delegationErrors: registry.counter('nai_delegation_errors_total', 'Delegation failures'),
    permissionChecks: registry.counter('nai_permission_checks_total', 'Permission check requests'),
    permissionDenials: registry.counter('nai_permission_denials_total', 'Permission denials'),
    injectionBlocks: registry.counter('nai_injection_blocks_total', 'Prompt injection blocks'),
    qualityRejections: registry.counter('nai_quality_rejections_total', 'Quality gate rejections'),
    blackboardWrites: registry.counter('nai_blackboard_writes_total', 'Blackboard write operations'),
    activeAgents: registry.gauge('nai_active_agents', 'Currently active agents'),
    blackboardSize: registry.gauge('nai_blackboard_size', 'Blackboard entry count'),
    budgetUsedPercent: registry.gauge('nai_budget_used_percent', 'Budget utilization percentage'),
    delegationDurationMs: registry.histogram('nai_delegation_duration_ms', 'Delegation latency in milliseconds'),
    adapterDurationMs: registry.histogram('nai_adapter_duration_ms', 'Adapter execution latency in milliseconds'),
  };
}
