/**
 * QA Orchestrator Agent
 *
 * Coordination layer on top of QualityGateAgent and ComplianceMonitor.
 * Provides:
 *   1. Scenario replay — re-run blackboard entries through quality gates
 *   2. Feedback loop — route rejections back to agents with suggested fixes
 *   3. Regression tracker — historical quality metrics over time
 *   4. Cross-agent consistency — detect contradictions in multi-agent output
 *
 * @module lib/qa-orchestrator
 */

import {
  QualityGateAgent,
  type QualityGateResult,
  type GateDecision,
  type AIReviewCallback,
  type ValidationConfig,
} from './blackboard-validator';
import {
  ComplianceMonitor,
  type ComplianceViolation,
  type ComplianceMonitorOptions,
} from './compliance-monitor';

// ============================================================================
// Types
// ============================================================================

/** A recorded blackboard entry that can be replayed through the QA pipeline. */
export interface QAScenario {
  /** Unique scenario identifier */
  id: string;
  /** Blackboard key */
  key: string;
  /** The value that was (or would be) written */
  value: unknown;
  /** Agent that produced the value */
  sourceAgent: string;
  /** Optional metadata carried through gating */
  metadata?: Record<string, unknown>;
  /** Minimum acceptable quality score (overrides global threshold) */
  minScore?: number;
}

/** Result of running a single scenario through the QA pipeline. */
export interface QAScenarioResult {
  scenarioId: string;
  decision: GateDecision;
  score: number;
  passed: boolean;
  issues: string[];
  feedbackRouted: boolean;
  /** Non-null when feedback was routed back to the agent */
  feedbackPayload?: QAFeedback;
}

/** Structured feedback sent back to the originating agent. */
export interface QAFeedback {
  scenarioId: string;
  sourceAgent: string;
  key: string;
  decision: GateDecision;
  score: number;
  issues: string[];
  suggestedFixes: string[];
  retryCount: number;
}

/** A snapshot of quality metrics at a point in time. */
export interface QASnapshot {
  timestamp: string;
  gateMetrics: Readonly<{
    totalChecked: number;
    approved: number;
    rejected: number;
    quarantined: number;
    aiReviewed: number;
  }>;
  complianceViolations: number;
  violationsByType: Record<string, number>;
  violationsByAgent: Record<string, number>;
  scenariosRun: number;
  scenarioPassRate: number;
}

/** Options for creating a QAOrchestratorAgent instance. */
export interface QAOrchestratorOptions {
  /** Quality gate configuration */
  qualityThreshold?: number;
  autoRejectThreshold?: number;
  validationConfig?: Partial<ValidationConfig>;
  aiReviewCallback?: AIReviewCallback;

  /** Compliance monitor configuration */
  complianceOptions?: ComplianceMonitorOptions;

  /** Feedback loop settings */
  maxRetries?: number;
  /** Callback invoked when a rejection should be routed back to an agent */
  onFeedback?: (feedback: QAFeedback) => void | Promise<void>;

  /** Consistency checker: given two values for the same key, return true if contradictory */
  contradictionDetector?: (a: unknown, b: unknown) => boolean;
}

/** Detected contradiction between two agents writing the same key. */
export interface Contradiction {
  key: string;
  agentA: string;
  agentB: string;
  valueA: unknown;
  valueB: unknown;
  detectedAt: string;
}

/** Aggregate result of running a full test harness. */
export interface QAHarnessResult {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  results: QAScenarioResult[];
  contradictions: Contradiction[];
  snapshot: QASnapshot;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * QA Orchestrator Agent — coordinates quality gating, compliance monitoring,
 * feedback routing, regression tracking, and cross-agent consistency checks.
 *
 * @example
 * ```typescript
 * const qa = new QAOrchestratorAgent({
 *   qualityThreshold: 0.7,
 *   maxRetries: 2,
 *   onFeedback: (fb) => console.log('Route to agent:', fb),
 * });
 *
 * const result = await qa.runScenario({
 *   id: 'test-1', key: 'analysis', value: { findings: [...] },
 *   sourceAgent: 'analyst',
 * });
 * ```
 */
export class QAOrchestratorAgent {
  private readonly gate: QualityGateAgent;
  private readonly compliance: ComplianceMonitor;
  private readonly maxRetries: number;
  private readonly onFeedback?: (feedback: QAFeedback) => void | Promise<void>;
  private readonly contradictionDetector: (a: unknown, b: unknown) => boolean;

  /** Historical snapshots for regression tracking */
  private readonly history: QASnapshot[] = [];

  /** Track retry counts per scenario */
  private readonly retryCounts: Map<string, number> = new Map();

  /** Track last-seen value per key+agent for contradiction detection */
  private readonly agentOutputs: Map<string, Map<string, unknown>> = new Map();

  constructor(options: QAOrchestratorOptions = {}) {
    this.gate = new QualityGateAgent({
      qualityThreshold: options.qualityThreshold,
      autoRejectThreshold: options.autoRejectThreshold,
      validationConfig: options.validationConfig,
      aiReviewCallback: options.aiReviewCallback,
    });

    this.compliance = new ComplianceMonitor(options.complianceOptions);

    this.maxRetries = options.maxRetries ?? 3;
    this.onFeedback = options.onFeedback;
    this.contradictionDetector = options.contradictionDetector ?? defaultContradictionDetector;
  }

  // --------------------------------------------------------------------------
  // Core: Single scenario
  // --------------------------------------------------------------------------

  /**
   * Run a single scenario through the two-layer quality gate.
   * If the entry is rejected or quarantined and a feedback callback is
   * configured, structured feedback is routed back to the source agent.
   */
  async runScenario(scenario: QAScenario): Promise<QAScenarioResult> {
    const { id, key, value, sourceAgent, metadata, minScore } = scenario;

    // Record the agent action for compliance monitoring
    this.compliance.recordAction({
      agentId: sourceAgent,
      action: 'qa_submission',
      tool: 'qa_orchestrator',
    });

    // Run through quality gate
    const gateResult: QualityGateResult = await this.gate.gate(key, value, sourceAgent, metadata);
    const score = gateResult.validation.score;
    const issues = gateResult.validation.issues.map(i => `[${i.severity}] ${i.message}`);

    // Threshold override per scenario
    const passThreshold = minScore ?? (this.gate.getValidator() ? 0.7 : 0.7);
    const passed = gateResult.decision === 'approve' && score >= passThreshold;

    // Track for cross-agent consistency
    this.trackAgentOutput(key, sourceAgent, value);

    // Route feedback on rejection/quarantine
    let feedbackRouted = false;
    let feedbackPayload: QAFeedback | undefined;

    if (!passed && this.onFeedback) {
      const retries = this.retryCounts.get(id) ?? 0;
      if (retries < this.maxRetries) {
        this.retryCounts.set(id, retries + 1);
        feedbackPayload = {
          scenarioId: id,
          sourceAgent,
          key,
          decision: gateResult.decision,
          score,
          issues,
          suggestedFixes: this.extractSuggestedFixes(gateResult),
          retryCount: retries + 1,
        };
        await this.onFeedback(feedbackPayload);
        feedbackRouted = true;
      }
    }

    return { scenarioId: id, decision: gateResult.decision, score, passed, issues, feedbackRouted, feedbackPayload };
  }

  // --------------------------------------------------------------------------
  // Harness: Batch scenario replay
  // --------------------------------------------------------------------------

  /**
   * Run a batch of scenarios and collect aggregate results, contradictions,
   * and a quality snapshot.
   */
  async runHarness(scenarios: QAScenario[]): Promise<QAHarnessResult> {
    const results: QAScenarioResult[] = [];
    for (const scenario of scenarios) {
      results.push(await this.runScenario(scenario));
    }

    const passedCount = results.filter(r => r.passed).length;
    const contradictions = this.detectContradictions();
    const snapshot = this.takeSnapshot(results.length, passedCount);

    return {
      total: results.length,
      passed: passedCount,
      failed: results.length - passedCount,
      passRate: results.length > 0 ? passedCount / results.length : 0,
      results,
      contradictions,
      snapshot,
    };
  }

  // --------------------------------------------------------------------------
  // Regression tracking
  // --------------------------------------------------------------------------

  /**
   * Take an explicit quality snapshot and store it in history.
   * Called automatically after `runHarness()`, but can also be called manually.
   */
  takeSnapshot(scenariosRun: number = 0, scenariosPassed: number = 0): QASnapshot {
    const gateMetrics = this.gate.getMetrics();
    const complianceSummary = this.compliance.getSummary();

    const snapshot: QASnapshot = {
      timestamp: new Date().toISOString(),
      gateMetrics,
      complianceViolations: complianceSummary.total,
      violationsByType: complianceSummary.byType,
      violationsByAgent: complianceSummary.byAgent,
      scenariosRun,
      scenarioPassRate: scenariosRun > 0 ? scenariosPassed / scenariosRun : 0,
    };

    this.history.push(snapshot);
    return snapshot;
  }

  /**
   * Get all historical quality snapshots for trend analysis.
   */
  getHistory(): ReadonlyArray<Readonly<QASnapshot>> {
    return this.history;
  }

  /**
   * Compare the latest two snapshots and return a regression report.
   * Returns null if fewer than two snapshots exist.
   */
  getRegressionReport(): RegressionReport | null {
    if (this.history.length < 2) return null;

    const prev = this.history[this.history.length - 2];
    const curr = this.history[this.history.length - 1];

    return {
      from: prev.timestamp,
      to: curr.timestamp,
      passRateDelta: curr.scenarioPassRate - prev.scenarioPassRate,
      complianceDelta: curr.complianceViolations - prev.complianceViolations,
      approvalRateDelta: approvalRate(curr.gateMetrics) - approvalRate(prev.gateMetrics),
      regressed: curr.scenarioPassRate < prev.scenarioPassRate ||
                 curr.complianceViolations > prev.complianceViolations,
    };
  }

  // --------------------------------------------------------------------------
  // Cross-agent consistency
  // --------------------------------------------------------------------------

  /**
   * Detect contradictions across agents that wrote to the same blackboard key.
   */
  detectContradictions(): Contradiction[] {
    const contradictions: Contradiction[] = [];

    for (const [key, agentMap] of this.agentOutputs) {
      const agents = Array.from(agentMap.entries());
      for (let i = 0; i < agents.length; i++) {
        for (let j = i + 1; j < agents.length; j++) {
          const [agentA, valueA] = agents[i];
          const [agentB, valueB] = agents[j];
          if (this.contradictionDetector(valueA, valueB)) {
            contradictions.push({
              key,
              agentA,
              agentB,
              valueA,
              valueB,
              detectedAt: new Date().toISOString(),
            });
          }
        }
      }
    }

    return contradictions;
  }

  // --------------------------------------------------------------------------
  // Accessors
  // --------------------------------------------------------------------------

  /** Access the underlying QualityGateAgent for direct configuration. */
  getQualityGate(): QualityGateAgent {
    return this.gate;
  }

  /** Access the underlying ComplianceMonitor for direct configuration. */
  getComplianceMonitor(): ComplianceMonitor {
    return this.compliance;
  }

  /** Get current gate metrics without taking a full snapshot. */
  getMetrics(): Readonly<{
    totalChecked: number;
    approved: number;
    rejected: number;
    quarantined: number;
    aiReviewed: number;
  }> {
    return this.gate.getMetrics();
  }

  /** Get the number of remaining retries for a scenario. */
  getRetriesRemaining(scenarioId: string): number {
    return this.maxRetries - (this.retryCounts.get(scenarioId) ?? 0);
  }

  /** Reset retry count for a scenario (e.g., after manual fix). */
  resetRetries(scenarioId: string): void {
    this.retryCounts.delete(scenarioId);
  }

  /** Clear all tracked agent outputs (for fresh contradiction detection). */
  clearOutputTracking(): void {
    this.agentOutputs.clear();
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private trackAgentOutput(key: string, agent: string, value: unknown): void {
    if (!this.agentOutputs.has(key)) {
      this.agentOutputs.set(key, new Map());
    }
    this.agentOutputs.get(key)!.set(agent, value);
  }

  private extractSuggestedFixes(gateResult: QualityGateResult): string[] {
    const fixes: string[] = [];
    for (const issue of gateResult.validation.issues) {
      if (issue.suggestion) {
        fixes.push(issue.suggestion);
      }
    }
    if (gateResult.reviewNotes.length > 0) {
      fixes.push(...gateResult.reviewNotes);
    }
    return fixes;
  }
}

// ============================================================================
// Regression Report
// ============================================================================

/** Comparison between two consecutive quality snapshots. */
export interface RegressionReport {
  from: string;
  to: string;
  /** Positive = improvement, negative = regression */
  passRateDelta: number;
  /** Positive = more violations (worse), negative = fewer (better) */
  complianceDelta: number;
  /** Positive = higher approval rate (better) */
  approvalRateDelta: number;
  /** True if any metric regressed */
  regressed: boolean;
}

// ============================================================================
// Utility functions
// ============================================================================

function approvalRate(metrics: Readonly<{ totalChecked: number; approved: number }>): number {
  return metrics.totalChecked > 0 ? metrics.approved / metrics.totalChecked : 0;
}

/**
 * Default contradiction detector: returns true when two values for the same
 * key have opposing boolean fields (e.g., `{ success: true }` vs `{ success: false }`)
 * or when one is an error and the other is not.
 */
function defaultContradictionDetector(a: unknown, b: unknown): boolean {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;

  // Check for opposing boolean fields
  for (const key of Object.keys(objA)) {
    if (typeof objA[key] === 'boolean' && typeof objB[key] === 'boolean') {
      if (objA[key] !== objB[key]) return true;
    }
  }

  // One has error, other has success data
  const aHasError = 'error' in objA && objA['error'] != null;
  const bHasError = 'error' in objB && objB['error'] != null;
  const aHasData = 'data' in objA || 'result' in objA || 'findings' in objA;
  const bHasData = 'data' in objB || 'result' in objB || 'findings' in objB;

  if ((aHasError && bHasData && !bHasError) || (bHasError && aHasData && !aHasError)) {
    return true;
  }

  return false;
}
