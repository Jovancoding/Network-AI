/**
 * Confidence Filter — Multi-agent result confidence scoring & filtering
 *
 * Scores agent findings by confidence, filters by threshold, and optionally
 * validates low-confidence findings with a secondary agent. Inspired by
 * Claude Code's confidence-based multi-agent filtering pattern.
 *
 * @module ConfidenceFilter
 * @version 1.0.0
 */

import type { AgentPayload, AgentContext, AgentResult } from '../types/agent-adapter';
import type { AdapterRegistry } from '../adapters/adapter-registry';

// ============================================================================
// TYPES
// ============================================================================

/**
 * A single finding produced by an agent, annotated with confidence.
 */
export interface Finding {
  /** Unique identifier for this finding */
  id: string;
  /** Human-readable description of the finding */
  description: string;
  /** Confidence score from 0 to 100 */
  confidence: number;
  /** Agent that produced this finding */
  sourceAgent: string;
  /** Agent that validated this finding (set after validation) */
  validatedBy?: string;
  /** Whether validation passed (set after validation) */
  validated?: boolean;
  /** Arbitrary metadata attached to the finding */
  metadata?: Record<string, unknown>;
}

/**
 * Result of filtering findings by confidence threshold.
 */
export interface FilterResult {
  /** Findings that passed the threshold */
  accepted: Finding[];
  /** Findings below the threshold */
  rejected: Finding[];
  /** Threshold that was applied */
  threshold: number;
}

/**
 * Aggregation strategies for combining findings from multiple agents.
 */
export type AggregationStrategy = 'highest' | 'average' | 'unanimous' | 'majority';

/**
 * Result of aggregating multiple sets of findings.
 */
export interface AggregatedResult {
  /** Merged findings after applying aggregation strategy */
  findings: Finding[];
  /** Strategy that was used */
  strategy: AggregationStrategy;
  /** Total number of input findings before aggregation */
  totalInput: number;
  /** Number of sources that contributed */
  sourceCount: number;
}

/**
 * Options for the ConfidenceFilter constructor.
 */
export interface ConfidenceFilterOptions {
  /** Default confidence threshold (0–100). Default: 70 */
  defaultThreshold?: number;
  /** If true, findings below threshold are auto-validated with a second agent */
  autoValidate?: boolean;
  /** Agent to use for validation passes */
  validatorAgent?: string;
  /** Payload factory for validation calls */
  validationPayloadFactory?: (finding: Finding) => AgentPayload;
}

// ============================================================================
// CONFIDENCE FILTER
// ============================================================================

/**
 * Filters and validates multi-agent findings based on confidence scores.
 *
 * @example
 * ```typescript
 * const filter = new ConfidenceFilter(registry, baseCtx, { defaultThreshold: 70 });
 *
 * const findings: Finding[] = [
 *   { id: '1', description: 'SQL injection in login.ts', confidence: 95, sourceAgent: 'scanner-a' },
 *   { id: '2', description: 'Possible XSS in comments', confidence: 45, sourceAgent: 'scanner-b' },
 * ];
 *
 * const filtered = filter.filter(findings);
 * // filtered.accepted → finding #1, filtered.rejected → finding #2
 *
 * // Validate a low-confidence finding with a secondary agent
 * const validated = await filter.validate(findings[1], 'expert-reviewer');
 * ```
 */
export class ConfidenceFilter {
  private registry: AdapterRegistry | null;
  private baseContext: AgentContext | null;
  private options: ConfidenceFilterOptions;

  /**
   * @param registry Adapter registry for validation calls (optional — filter-only mode if null)
   * @param baseContext Default execution context for validation agents
   * @param options Filter configuration
   */
  constructor(
    registry: AdapterRegistry | null,
    baseContext: AgentContext | null,
    options: ConfidenceFilterOptions = {},
  ) {
    this.registry = registry;
    this.baseContext = baseContext;
    this.options = options;
  }

  /**
   * Score a single finding. Returns a normalised 0–100 confidence score.
   * Currently a pass-through; override or extend for custom scoring logic.
   */
  score(finding: Finding): number {
    return Math.max(0, Math.min(100, finding.confidence));
  }

  /**
   * Filter findings by confidence threshold.
   *
   * @param findings Findings to filter
   * @param threshold Override the default threshold for this call
   */
  filter(findings: Finding[], threshold?: number): FilterResult {
    const t = threshold ?? this.options.defaultThreshold ?? 70;
    const accepted: Finding[] = [];
    const rejected: Finding[] = [];

    for (const f of findings) {
      const s = this.score(f);
      if (s >= t) {
        accepted.push(f);
      } else {
        rejected.push(f);
      }
    }

    return { accepted, rejected, threshold: t };
  }

  /**
   * Validate a finding using a secondary agent.
   * The validator agent's result is used to update `validatedBy` and `validated`.
   *
   * @param finding The finding to validate
   * @param validatorAgentId Agent to perform the validation (overrides options)
   * @returns Updated finding with validation metadata
   */
  async validate(finding: Finding, validatorAgentId?: string): Promise<Finding> {
    const agentId = validatorAgentId ?? this.options.validatorAgent;
    if (!agentId) {
      throw new Error('No validator agent specified');
    }
    if (!this.registry || !this.baseContext) {
      throw new Error('Registry and baseContext required for validation');
    }

    const payload = this.options.validationPayloadFactory
      ? this.options.validationPayloadFactory(finding)
      : {
          action: 'validate',
          params: { findingId: finding.id, description: finding.description, confidence: finding.confidence },
        };

    const ctx: AgentContext = {
      ...this.baseContext,
      metadata: { ...this.baseContext.metadata, validating: finding.id },
    };

    const result = await this.registry.executeAgent(agentId, payload, ctx);

    return {
      ...finding,
      validatedBy: agentId,
      validated: result.success,
      confidence: result.success
        ? Math.min(100, finding.confidence + 20) // boost confidence if validated
        : Math.max(0, finding.confidence - 10),  // reduce if validation failed
    };
  }

  /**
   * Validate all rejected findings from a filter result.
   * Returns the updated filter result with re-scored findings.
   */
  async validateRejected(filterResult: FilterResult, validatorAgentId?: string): Promise<FilterResult> {
    const validated: Finding[] = [];
    for (const f of filterResult.rejected) {
      validated.push(await this.validate(f, validatorAgentId));
    }

    // Re-filter after validation
    const newAccepted: Finding[] = [];
    const newRejected: Finding[] = [];
    for (const f of validated) {
      if (f.confidence >= filterResult.threshold) {
        newAccepted.push(f);
      } else {
        newRejected.push(f);
      }
    }

    return {
      accepted: [...filterResult.accepted, ...newAccepted],
      rejected: newRejected,
      threshold: filterResult.threshold,
    };
  }

  /**
   * Aggregate findings from multiple sources using a strategy.
   *
   * - `highest`: Keep the finding with the highest confidence for each id
   * - `average`: Average the confidence scores for each id
   * - `unanimous`: Only keep findings that appear in ALL sources
   * - `majority`: Only keep findings that appear in more than half of sources
   *
   * @param findingSets Arrays of findings from different agents
   * @param strategy Aggregation strategy to use
   */
  aggregate(findingSets: Finding[][], strategy: AggregationStrategy = 'highest'): AggregatedResult {
    const totalInput = findingSets.reduce((sum, s) => sum + s.length, 0);
    const sourceCount = findingSets.length;

    if (sourceCount === 0) {
      return { findings: [], strategy, totalInput: 0, sourceCount: 0 };
    }

    // Group by finding id
    const grouped = new Map<string, Finding[]>();
    for (const set of findingSets) {
      for (const f of set) {
        if (!grouped.has(f.id)) grouped.set(f.id, []);
        grouped.get(f.id)!.push(f);
      }
    }

    let findings: Finding[];

    switch (strategy) {
      case 'highest': {
        findings = [];
        for (const [, group] of grouped) {
          const best = group.reduce((a, b) => (a.confidence > b.confidence ? a : b));
          findings.push(best);
        }
        break;
      }
      case 'average': {
        findings = [];
        for (const [, group] of grouped) {
          const avgConfidence = Math.round(group.reduce((s, f) => s + f.confidence, 0) / group.length);
          findings.push({ ...group[0], confidence: avgConfidence });
        }
        break;
      }
      case 'unanimous': {
        findings = [];
        for (const [, group] of grouped) {
          if (group.length === sourceCount) {
            const avgConfidence = Math.round(group.reduce((s, f) => s + f.confidence, 0) / group.length);
            findings.push({ ...group[0], confidence: avgConfidence });
          }
        }
        break;
      }
      case 'majority': {
        findings = [];
        const majorityThreshold = Math.floor(sourceCount / 2) + 1;
        for (const [, group] of grouped) {
          if (group.length >= majorityThreshold) {
            const avgConfidence = Math.round(group.reduce((s, f) => s + f.confidence, 0) / group.length);
            findings.push({ ...group[0], confidence: avgConfidence });
          }
        }
        break;
      }
    }

    return { findings, strategy, totalInput, sourceCount };
  }
}
