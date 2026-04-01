/**
 * Phase Pipeline — Multi-phase workflows with approval gates
 *
 * Defines ordered execution phases. Each phase can optionally require human
 * approval before proceeding. Phases may run their assigned agents in parallel
 * or sequentially. Inspired by Claude Code's multi-phase orchestration pattern.
 *
 * @module PhasePipeline
 * @version 1.0.0
 */

import type { AgentPayload, AgentContext, AgentResult } from '../types/agent-adapter';
import type { AdapterRegistry } from '../adapters/adapter-registry';

// ============================================================================
// TYPES
// ============================================================================

/** Current execution status of a phase */
export type PhaseStatus = 'pending' | 'running' | 'awaiting_approval' | 'approved' | 'rejected' | 'completed' | 'failed' | 'skipped';

/**
 * Defines a single phase in the pipeline.
 */
export interface PhaseDefinition {
  /** Unique phase name */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Agent IDs to execute in this phase */
  agents: string[];
  /** If true, pipeline pauses after this phase until approval is granted */
  requiresApproval?: boolean;
  /** If true, agents within this phase run in parallel (default: sequential) */
  parallel?: boolean;
  /** Payload factory — builds the payload for each agent in this phase */
  payloadFactory?: (agentId: string, previousResults: PhaseResult[]) => AgentPayload;
  /** Maximum time (ms) allowed for this phase before timeout */
  timeoutMs?: number;
}

/**
 * Result from a single phase execution.
 */
export interface PhaseResult {
  /** Phase name */
  phaseName: string;
  /** Final status */
  status: PhaseStatus;
  /** Agent results, keyed by agentId */
  agentResults: Map<string, AgentResult>;
  /** Phase execution time in milliseconds */
  durationMs: number;
  /** Approval metadata (if phase required approval) */
  approval?: { approvedBy?: string; reason?: string; timestamp: number };
}

/**
 * Result from the entire pipeline execution.
 */
export interface PipelineResult {
  /** Whether the entire pipeline completed successfully */
  success: boolean;
  /** Results per phase */
  phases: PhaseResult[];
  /** Total execution time in milliseconds */
  totalMs: number;
  /** Name of the phase that stopped the pipeline (if any) */
  stoppedAt?: string;
  /** Reason the pipeline stopped (rejection, failure, timeout) */
  stopReason?: string;
}

/**
 * Callback signature for approval gates.
 * Return `{ approved: true }` to proceed, `{ approved: false, reason }` to reject.
 */
export type ApprovalCallback = (
  phaseName: string,
  phaseResult: PhaseResult,
  pipelineContext: PipelineExecutionContext,
) => Promise<{ approved: boolean; approvedBy?: string; reason?: string }>;

/**
 * Options for creating a PhasePipeline.
 */
export interface PhasePipelineOptions {
  /** Ordered list of phase definitions */
  phases: PhaseDefinition[];
  /** Called when a phase requires approval */
  onApproval?: ApprovalCallback;
  /** Called when each phase starts */
  onPhaseStart?: (phaseName: string, index: number) => void;
  /** Called when each phase completes */
  onPhaseComplete?: (result: PhaseResult, index: number) => void;
  /** If true, auto-approve all gates (useful for testing) */
  autoApprove?: boolean;
}

/**
 * Runtime context available during pipeline execution.
 */
export interface PipelineExecutionContext {
  /** Results from previously completed phases */
  completedPhases: PhaseResult[];
  /** Index of the current phase */
  currentPhaseIndex: number;
  /** Total number of phases */
  totalPhases: number;
}

// ============================================================================
// PHASE PIPELINE
// ============================================================================

/**
 * Orchestrates multi-phase workflows with optional approval gates.
 *
 * @example
 * ```typescript
 * const pipeline = new PhasePipeline(registry, baseContext, {
 *   phases: [
 *     { name: 'research', agents: ['researcher'], parallel: false },
 *     { name: 'review', agents: ['reviewer-a', 'reviewer-b'], parallel: true, requiresApproval: true },
 *     { name: 'publish', agents: ['publisher'] },
 *   ],
 *   onApproval: async (name, result) => {
 *     // In production: prompt the user
 *     return { approved: true, approvedBy: 'admin' };
 *   },
 * });
 *
 * const result = await pipeline.run();
 * ```
 */
export class PhasePipeline {
  private registry: AdapterRegistry;
  private baseContext: AgentContext;
  private options: PhasePipelineOptions;
  private phaseResults: PhaseResult[] = [];
  private _status: 'idle' | 'running' | 'completed' | 'failed' | 'rejected' = 'idle';

  constructor(registry: AdapterRegistry, baseContext: AgentContext, options: PhasePipelineOptions) {
    if (!options.phases.length) {
      throw new Error('PhasePipeline requires at least one phase');
    }
    const names = new Set<string>();
    for (const p of options.phases) {
      if (names.has(p.name)) {
        throw new Error(`Duplicate phase name: "${p.name}"`);
      }
      names.add(p.name);
    }
    this.registry = registry;
    this.baseContext = baseContext;
    this.options = options;
  }

  /** Current pipeline status */
  get status(): string {
    return this._status;
  }

  /** Results from all executed phases (even if pipeline was aborted) */
  get results(): ReadonlyArray<PhaseResult> {
    return this.phaseResults;
  }

  /** Phase definitions */
  get phases(): ReadonlyArray<PhaseDefinition> {
    return this.options.phases;
  }

  /**
   * Execute the entire pipeline, phase by phase.
   *
   * For each phase:
   * 1. Run all assigned agents (parallel or sequential)
   * 2. If `requiresApproval`, call the approval callback and wait
   * 3. If rejected, stop the pipeline
   * 4. Otherwise move to the next phase
   */
  async run(defaultPayload?: AgentPayload): Promise<PipelineResult> {
    const pipelineStart = Date.now();
    this._status = 'running';
    this.phaseResults = [];

    for (let i = 0; i < this.options.phases.length; i++) {
      const phaseDef = this.options.phases[i];
      this.options.onPhaseStart?.(phaseDef.name, i);

      const phaseStart = Date.now();
      const agentResults = new Map<string, AgentResult>();
      let phaseStatus: PhaseStatus = 'running';

      // --- Execute agents -------------------------------------------------
      try {
        if (phaseDef.parallel) {
          const executions = phaseDef.agents.map(agentId => {
            const payload = this.buildPayload(agentId, phaseDef, defaultPayload);
            const ctx: AgentContext = { ...this.baseContext, metadata: { ...this.baseContext.metadata, phase: phaseDef.name } };
            return this.executeWithTimeout(agentId, payload, ctx, phaseDef.timeoutMs)
              .then(result => ({ agentId, result }));
          });
          const results = await Promise.all(executions);
          for (const { agentId, result } of results) {
            agentResults.set(agentId, result);
          }
        } else {
          for (const agentId of phaseDef.agents) {
            const payload = this.buildPayload(agentId, phaseDef, defaultPayload);
            const ctx: AgentContext = { ...this.baseContext, metadata: { ...this.baseContext.metadata, phase: phaseDef.name } };
            const result = await this.executeWithTimeout(agentId, payload, ctx, phaseDef.timeoutMs);
            agentResults.set(agentId, result);
            if (!result.success) break; // stop this phase on first failure
          }
        }

        // Check if any agent failed
        const anyFailed = Array.from(agentResults.values()).some(r => !r.success);
        phaseStatus = anyFailed ? 'failed' : 'completed';
      } catch (err) {
        phaseStatus = 'failed';
      }

      const phaseResult: PhaseResult = {
        phaseName: phaseDef.name,
        status: phaseStatus,
        agentResults,
        durationMs: Date.now() - phaseStart,
      };

      // --- Check failure --------------------------------------------------
      if (phaseStatus === 'failed') {
        phaseResult.status = 'failed';
        this.phaseResults.push(phaseResult);
        this.options.onPhaseComplete?.(phaseResult, i);
        this._status = 'failed';
        return {
          success: false,
          phases: this.phaseResults,
          totalMs: Date.now() - pipelineStart,
          stoppedAt: phaseDef.name,
          stopReason: 'Phase failed',
        };
      }

      // --- Approval gate --------------------------------------------------
      if (phaseDef.requiresApproval) {
        phaseResult.status = 'awaiting_approval';
        const pipelineCtx: PipelineExecutionContext = {
          completedPhases: [...this.phaseResults],
          currentPhaseIndex: i,
          totalPhases: this.options.phases.length,
        };

        let approval: { approved: boolean; approvedBy?: string; reason?: string };
        if (this.options.autoApprove) {
          approval = { approved: true, approvedBy: 'auto' };
        } else if (this.options.onApproval) {
          approval = await this.options.onApproval(phaseDef.name, phaseResult, pipelineCtx);
        } else {
          // No approval handler and not auto-approved → reject by default
          approval = { approved: false, reason: 'No approval callback configured' };
        }

        phaseResult.approval = {
          approvedBy: approval.approvedBy,
          reason: approval.reason,
          timestamp: Date.now(),
        };

        if (!approval.approved) {
          phaseResult.status = 'rejected';
          this.phaseResults.push(phaseResult);
          this.options.onPhaseComplete?.(phaseResult, i);
          this._status = 'rejected';
          return {
            success: false,
            phases: this.phaseResults,
            totalMs: Date.now() - pipelineStart,
            stoppedAt: phaseDef.name,
            stopReason: approval.reason ?? 'Approval rejected',
          };
        }

        phaseResult.status = 'approved';
      }

      this.phaseResults.push(phaseResult);
      this.options.onPhaseComplete?.(phaseResult, i);
    }

    this._status = 'completed';
    return {
      success: true,
      phases: this.phaseResults,
      totalMs: Date.now() - pipelineStart,
    };
  }

  /**
   * Reset the pipeline for re-execution.
   */
  reset(): void {
    this.phaseResults = [];
    this._status = 'idle';
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private buildPayload(agentId: string, phase: PhaseDefinition, defaultPayload?: AgentPayload): AgentPayload {
    if (phase.payloadFactory) {
      return phase.payloadFactory(agentId, this.phaseResults);
    }
    return defaultPayload ?? { action: phase.name, params: {} };
  }

  private async executeWithTimeout(agentId: string, payload: AgentPayload, ctx: AgentContext, timeoutMs?: number): Promise<AgentResult> {
    if (!timeoutMs) {
      return this.registry.executeAgent(agentId, payload, ctx);
    }

    return Promise.race([
      this.registry.executeAgent(agentId, payload, ctx),
      new Promise<AgentResult>((_, reject) =>
        setTimeout(() => reject(new Error(`Phase timeout: agent "${agentId}" exceeded ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  }
}
