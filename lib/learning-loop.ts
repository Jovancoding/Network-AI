/**
 * LearningLoop — Store successful DAG patterns and prefer proven ones.
 *
 * After a TeamResult completes, `recordOutcome()` extracts the DAG shape
 * (agent→action edges, dependency structure) and scores it by success rate.
 * Before planning, `suggestPatterns()` returns the top matching patterns
 * so the GoalDecomposer or planner can bias toward proven approaches.
 *
 * @module LearningLoop
 */

// ============================================================================
// TYPES
// ============================================================================

/** Compressed representation of a DAG pattern */
export interface DAGPattern {
  id: string;
  /** Original goal (or goal hash) that produced this pattern */
  goalSignature: string;
  /** Ordered agent→action pairs that form the pattern */
  steps: PatternStep[];
  /** Dependency edges: stepIndex → upstream stepIndex[] */
  edges: number[][];
  /** Number of times this pattern was used */
  usageCount: number;
  /** Number of successful completions */
  successCount: number;
  /** Number of failures */
  failureCount: number;
  /** Success rate: successCount / usageCount */
  successRate: number;
  /** Average execution duration in ms */
  avgDurationMs: number;
  /** Tags for classification */
  tags: string[];
  /** First recorded timestamp */
  createdAt: number;
  /** Last used timestamp */
  lastUsedAt: number;
}

/** A single step in a pattern */
export interface PatternStep {
  agent: string;
  action: string;
}

/** Outcome of a team/DAG execution */
export interface DAGOutcome {
  goal: string;
  steps: PatternStep[];
  edges: number[][];
  success: boolean;
  durationMs: number;
  tags?: string[];
}

/** Match result when searching for proven patterns */
export interface PatternMatch {
  pattern: DAGPattern;
  /** How well this pattern matches the query (0-1) */
  relevance: number;
}

// ============================================================================
// LEARNING LOOP
// ============================================================================

/**
 * Records DAG execution outcomes and recalls proven patterns.
 *
 * @example
 * ```ts
 * const loop = new LearningLoop();
 *
 * // After execution:
 * loop.recordOutcome({
 *   goal: 'Review and fix code',
 *   steps: [{ agent: 'reviewer', action: 'review' }, { agent: 'fixer', action: 'fix' }],
 *   edges: [[], [0]],
 *   success: true,
 *   durationMs: 5000,
 * });
 *
 * // Before planning:
 * const proven = loop.suggestPatterns('code review', ['review']);
 * ```
 */
export class LearningLoop {
  private patterns: Map<string, DAGPattern> = new Map();
  private maxPatterns: number;
  private minSuccessRate: number;

  constructor(options: { maxPatterns?: number; minSuccessRate?: number } = {}) {
    this.maxPatterns = options.maxPatterns ?? 2000;
    this.minSuccessRate = options.minSuccessRate ?? 0.3;
  }

  /**
   * Record the outcome of a DAG execution.
   * If a matching pattern exists (same signature), updates stats.
   * Otherwise creates a new pattern entry.
   */
  recordOutcome(outcome: DAGOutcome): string {
    const sig = this.computeSignature(outcome.steps, outcome.edges);
    const existing = this.findBySignature(sig);

    if (existing) {
      existing.usageCount++;
      if (outcome.success) existing.successCount++;
      else existing.failureCount++;
      existing.successRate = existing.successCount / existing.usageCount;
      existing.avgDurationMs = (existing.avgDurationMs * (existing.usageCount - 1) + outcome.durationMs) / existing.usageCount;
      existing.lastUsedAt = Date.now();
      if (outcome.tags) {
        for (const t of outcome.tags) {
          if (!existing.tags.includes(t)) existing.tags.push(t);
        }
      }
      return existing.id;
    }

    const id = `pat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const pattern: DAGPattern = {
      id,
      goalSignature: sig,
      steps: [...outcome.steps],
      edges: outcome.edges.map(e => [...e]),
      usageCount: 1,
      successCount: outcome.success ? 1 : 0,
      failureCount: outcome.success ? 0 : 1,
      successRate: outcome.success ? 1.0 : 0.0,
      avgDurationMs: outcome.durationMs,
      tags: outcome.tags ? [...outcome.tags] : [],
      createdAt: now,
      lastUsedAt: now,
    };
    this.patterns.set(id, pattern);
    this.evict();
    return id;
  }

  /**
   * Suggest proven patterns matching a goal description and tags.
   * Returns patterns sorted by (relevance × successRate).
   */
  suggestPatterns(goalHint: string, tags: string[] = [], maxResults = 5): PatternMatch[] {
    const hintTokens = this.tokenize(goalHint);
    const matches: PatternMatch[] = [];

    for (const pattern of this.patterns.values()) {
      if (pattern.usageCount < 2) continue; // not enough data
      if (pattern.successRate < this.minSuccessRate) continue;

      let relevance = 0;

      // Tag overlap scoring
      if (tags.length > 0 && pattern.tags.length > 0) {
        const overlap = tags.filter(t => pattern.tags.includes(t)).length;
        relevance = overlap / Math.max(tags.length, 1);
      }

      // Goal signature token overlap (lightweight text similarity)
      const patternTokens = this.tokenize(pattern.goalSignature);
      if (hintTokens.length > 0 && patternTokens.length > 0) {
        const tokenOverlap = hintTokens.filter(t => patternTokens.includes(t)).length;
        const tokenScore = tokenOverlap / Math.max(hintTokens.length, 1);
        relevance = Math.max(relevance, tokenScore);
      }

      if (relevance > 0) {
        matches.push({
          pattern,
          relevance: relevance * pattern.successRate,
        });
      }
    }

    matches.sort((a, b) => b.relevance - a.relevance);
    return matches.slice(0, maxResults);
  }

  /** Get a specific pattern by ID */
  get(id: string): DAGPattern | undefined {
    return this.patterns.get(id);
  }

  /** Get all patterns */
  getAll(): DAGPattern[] {
    return [...this.patterns.values()];
  }

  /** Number of stored patterns */
  size(): number {
    return this.patterns.size;
  }

  /** Clear all patterns */
  clear(): void {
    this.patterns.clear();
  }

  /** Export patterns for persistence */
  export(): DAGPattern[] {
    return [...this.patterns.values()];
  }

  /** Import patterns from a persisted array */
  import(patterns: DAGPattern[]): void {
    for (const p of patterns) {
      this.patterns.set(p.id, p);
    }
    this.evict();
  }

  // --------------------------------------------------------------------------
  // INTERNAL
  // --------------------------------------------------------------------------

  private computeSignature(steps: PatternStep[], edges: number[][]): string {
    const stepParts = steps.map(s => `${s.agent}:${s.action}`).join('|');
    const edgeParts = edges.map((deps, i) => deps.length > 0 ? `${i}<-${deps.join(',')}` : `${i}`).join(';');
    return `${stepParts}#${edgeParts}`;
  }

  private findBySignature(sig: string): DAGPattern | undefined {
    for (const p of this.patterns.values()) {
      if (p.goalSignature === sig) return p;
    }
    return undefined;
  }

  private tokenize(text: string): string[] {
    return text.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  }

  private evict(): void {
    if (this.patterns.size <= this.maxPatterns) return;
    // Remove lowest-scoring patterns
    const sorted = [...this.patterns.entries()].sort(
      (a, b) => (a[1].successRate * a[1].usageCount) - (b[1].successRate * b[1].usageCount)
    );
    const toRemove = sorted.slice(0, this.patterns.size - this.maxPatterns);
    for (const [id] of toRemove) this.patterns.delete(id);
  }
}
