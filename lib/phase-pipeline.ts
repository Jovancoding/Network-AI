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
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';

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
 * Options for trajectory compaction in long-running pipelines.
 *
 * When the cumulative serialised output of completed phases exceeds
 * `thresholdChars`, `summarize()` is called and the full history is replaced
 * with a single compact stub. This prevents the context window from growing
 * unboundedly during multi-hundred-phase pipelines.
 */
export interface CompactionOptions {
  /**
   * Cumulative serialised char count above which compaction triggers.
   * Default: 50 000 characters.
   */
  thresholdChars?: number;
  /**
   * Async function that distils all completed phases into a single summary string.
   * The pipeline calls this every time the threshold is breached and replaces the
   * full phase history with the returned string.
   */
  summarize: (completedPhases: PhaseResult[]) => Promise<string>;
  /**
   * Optional callback fired after every successful compaction.
   * Receives the summary text, the running compaction count (1-based), and a
   * **read-only snapshot of all phase results before they were replaced**.  Use
   * this to archive full phase history before the stub overwrites it.
   *
   * @param summary         The summary produced by `summarize`.
   * @param compactionCount Running count of compactions (1-based).
   * @param archivedPhases  Full phase results that were compacted away.
   */
  onCompact?: (summary: string, compactionCount: number, archivedPhases: ReadonlyArray<PhaseResult>) => void;
}

/**
 * Options for creating a PhasePipeline.
 */
export interface PhasePipelineOptions {
  /** Ordered list of phase definitions */
  phases: PhaseDefinition[];
  /** Called when a phase requires approval */
  onApproval?: ApprovalCallback;
  /**
   * Maximum milliseconds to wait for an `onApproval` callback to resolve.
   * If the callback does not settle within this window the phase is **denied**
   * (fail-closed) and the pipeline stops with `stopReason: 'Approval timeout'`.
   * Defaults to **300 000 ms (5 minutes)**.
   */
  approvalTimeoutMs?: number;
  /** Called when each phase starts */
  onPhaseStart?: (phaseName: string, index: number) => void;
  /** Called when each phase completes */
  onPhaseComplete?: (result: PhaseResult, index: number) => void;
  /** If true, auto-approve all gates (useful for testing) */
  autoApprove?: boolean;
  /**
   * Trajectory compaction settings.
   * When set, the pipeline monitors cumulative phase output size and
   * summarises the history whenever the threshold is breached.
   */
  compaction?: CompactionOptions;
  /**
   * Path to a JSON checkpoint file for durable DAG execution.
   * When set, the pipeline saves a checkpoint after every completed phase.
   * On restart, if the file exists, already-completed phases are skipped and
   * execution resumes from the first non-completed phase.
   * Use `PhasePipeline.clearCheckpoint(path)` to delete after a successful run.
   */
  checkpointPath?: string;
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
// CHECKPOINT TYPES
// ============================================================================

/** Serializable form of a PhaseResult (Maps → arrays for JSON). */
interface CheckpointPhaseResult {
  phaseName: string;
  status: PhaseStatus;
  agentResults: Array<[string, AgentResult]>;
  durationMs: number;
  approval?: { approvedBy?: string; reason?: string; timestamp: number };
}

/** On-disk checkpoint format. */
interface PipelineCheckpoint {
  version: 1;
  savedAt: string;
  nextPhaseIndex: number;
  completedPhases: CheckpointPhaseResult[];
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
  /** Running count of compactions for this pipeline run. */
  private _compactionCount = 0;
  /** Summary produced by the most recent compaction, or null. */
  private _lastCompactionSummary: string | null = null;

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

    // ── Checkpoint resume ─────────────────────────────────────────────────
    const startIndex = this._loadCheckpoint();
    // ── End checkpoint resume ─────────────────────────────────────────────

    for (let i = startIndex; i < this.options.phases.length; i++) {
      const phaseDef = this.options.phases[i];
      this.options.onPhaseStart?.(phaseDef.name, i);

      const phaseStart = Date.now();
      const agentResults = new Map<string, AgentResult>();
      let phaseStatus: PhaseStatus;

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
        this._saveCheckpoint(i); // save so resume can retry from this phase
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
          const timeoutMs = this.options.approvalTimeoutMs ?? 300_000;
          const timeoutError = new Error(`Approval timeout: phase "${phaseDef.name}" did not receive a decision within ${timeoutMs}ms`);
          approval = await Promise.race([
            this.options.onApproval(phaseDef.name, phaseResult, pipelineCtx),
            new Promise<never>((_, reject) => setTimeout(() => reject(timeoutError), timeoutMs)),
          ]).catch((err: unknown) => ({
            approved: false as const,
            reason: err instanceof Error ? err.message : 'Approval callback failed',
          }));
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
          this._saveCheckpoint(i); // save so resume can retry from this phase
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
      this._saveCheckpoint(i + 1); // advance checkpoint to next phase

      // ── Trajectory compaction ─────────────────────────────────────────────
      if (this.options.compaction) {
        await this._maybeCompact();
      }
      // ── End compaction ────────────────────────────────────────────────────
    }

    this._status = 'completed';
    return {
      success: true,
      phases: this.phaseResults,
      totalMs: Date.now() - pipelineStart,
    };
  }

  /** The summary produced by the last compaction, or `null` if none has occurred. */
  get lastCompactionSummary(): string | null {
    return this._lastCompactionSummary;
  }

  /** Total number of compactions performed so far in this run. */
  get compactionCount(): number {
    return this._compactionCount;
  }

  /**
   * Reset the pipeline for re-execution.
   */
  reset(): void {
    this.phaseResults = [];
    this._status = 'idle';
    this._compactionCount = 0;
    this._lastCompactionSummary = null;
  }

  // --------------------------------------------------------------------------
  // Checkpoint / resume
  // --------------------------------------------------------------------------

  /**
   * Save the current pipeline state to the checkpoint file.
   * Called automatically after each phase when `checkpointPath` is set.
   * @internal
   */
  private _saveCheckpoint(nextPhaseIndex: number): void {
    const path = this.options.checkpointPath;
    if (!path) return;
    const resolved = resolve(path);
    const dir = dirname(resolved);
    try {
      mkdirSync(dir, { recursive: true });
      const checkpoint: PipelineCheckpoint = {
        version: 1,
        savedAt: new Date().toISOString(),
        nextPhaseIndex,
        completedPhases: this.phaseResults.map(pr => ({
          phaseName: pr.phaseName,
          status: pr.status,
          agentResults: Array.from(pr.agentResults.entries()),
          durationMs: pr.durationMs,
          approval: pr.approval,
        })),
      };
      writeFileSync(resolved, JSON.stringify(checkpoint, null, 2), 'utf-8');
    } catch {
      // Non-fatal — checkpoint write failure should not abort the pipeline
    }
  }

  /**
   * Load a checkpoint from disk and restore phase results + next phase index.
   * Returns the index of the next phase to run (0 if no checkpoint).
   * @internal
   */
  private _loadCheckpoint(): number {
    const path = this.options.checkpointPath;
    if (!path) return 0;
    const resolved = resolve(path);
    if (!existsSync(resolved)) return 0;
    try {
      const raw = readFileSync(resolved, 'utf-8');
      const cp = JSON.parse(raw) as PipelineCheckpoint;
      if (cp.version !== 1) return 0;
      this.phaseResults = cp.completedPhases.map(pr => ({
        phaseName: pr.phaseName,
        status: pr.status,
        agentResults: new Map(pr.agentResults),
        durationMs: pr.durationMs,
        approval: pr.approval,
      }));
      return cp.nextPhaseIndex;
    } catch {
      return 0;
    }
  }

  /**
   * Delete the checkpoint file for this pipeline (or any given path).
   * Call this after a successful pipeline run to clean up.
   *
   * @example
   * ```typescript
   * const result = await pipeline.run();
   * if (result.success) PhasePipeline.clearCheckpoint('./data/my-pipeline.checkpoint.json');
   * ```
   */
  static clearCheckpoint(checkpointPath: string): void {
    const resolved = resolve(checkpointPath);
    if (existsSync(resolved)) {
      try {
        const { unlinkSync } = require('fs') as typeof import('fs');
        unlinkSync(resolved);
      } catch { /* ignore */ }
    }
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /** @internal */
  private async _maybeCompact(): Promise<void> {
    const opts = this.options.compaction!;
    const threshold = opts.thresholdChars ?? 50_000;

    let size = 0;
    for (const pr of this.phaseResults) {
      try {
        size += JSON.stringify({ n: pr.phaseName, r: Array.from(pr.agentResults.values()) }).length;
      } catch {
        // ignore serialisation errors
      }
    }

    if (size <= threshold) return;

    const summary = await opts.summarize(this.phaseResults);
    this._compactionCount++;
    this._lastCompactionSummary = summary;

    // Capture full history before it is replaced so callers can archive it
    const archivedPhases: ReadonlyArray<PhaseResult> = [...this.phaseResults];

    // Replace the full history with a single compact stub phase
    const stub: PhaseResult = {
      phaseName: `__compacted_${this._compactionCount}`,
      status: 'completed',
      agentResults: new Map([
        ['__summary', { success: true, data: summary, metadata: { compacted: true, compactionCount: this._compactionCount } }],
      ]),
      durationMs: 0,
    };
    this.phaseResults = [stub];

    opts.onCompact?.(summary, this._compactionCount, archivedPhases);
  }

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
