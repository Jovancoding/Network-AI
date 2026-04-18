/**
 * SpeculativeExecutor — Dispatch the same task to multiple agents in parallel,
 * then pick the best result via confidence scoring.
 *
 * Uses FanOutFanIn for parallel dispatch and ConfidenceFilter for quality-based
 * winner selection. Optimistic concurrency: spend the extra budget up-front
 * and discard inferior results.
 *
 * @module SpeculativeExecutor
 */

// ============================================================================
// TYPES
// ============================================================================

/** A candidate agent for speculative execution */
export interface SpeculativeCandidate {
  agentId: string;
  /** Optional label for logging/tracing */
  label?: string;
  /** Per-candidate timeout override (ms) */
  timeoutMs?: number;
}

/** Scored result from a speculative candidate */
export interface SpeculativeResult {
  agentId: string;
  label?: string;
  success: boolean;
  data: unknown;
  confidence: number;
  durationMs: number;
}

/** Final outcome of speculative execution */
export interface SpeculativeOutcome {
  /** The winning result (highest confidence above threshold) */
  winner: SpeculativeResult | null;
  /** All candidate results, sorted by confidence descending */
  candidates: SpeculativeResult[];
  /** Whether a winner was selected */
  hasWinner: boolean;
  /** Total wall-clock time for the speculative run */
  totalMs: number;
  /** How many candidates succeeded */
  successCount: number;
}

/** Configuration for speculative execution */
export interface SpeculativeOptions {
  /** Minimum confidence to be considered a valid winner (0-100, default 50) */
  minConfidence?: number;
  /** Global timeout for all candidates (ms, default 30000) */
  timeoutMs?: number;
  /** Maximum concurrent candidates (default: all) */
  concurrency?: number;
}

/** Executor function: (agentId, payload) → { success, data, confidence } */
export type SpeculativeExecutorFn = (
  agentId: string,
  payload: Record<string, unknown>,
) => Promise<{ success: boolean; data: unknown; confidence: number }>;

// ============================================================================
// SPECULATIVE EXECUTOR
// ============================================================================

/**
 * Dispatch one task to multiple agents, pick the best result.
 *
 * @example
 * ```ts
 * const executor = new SpeculativeExecutor(async (agentId, payload) => {
 *   const result = await adapters.executeAgent(agentId, payload, ctx);
 *   return {
 *     success: result.success,
 *     data: result.data,
 *     confidence: result.data?.confidence ?? 70,
 *   };
 * });
 *
 * const outcome = await executor.race(
 *   { instruction: 'Summarize this document', context: { doc: '...' } },
 *   [{ agentId: 'gpt4' }, { agentId: 'claude' }, { agentId: 'gemini' }],
 * );
 * if (outcome.hasWinner) {
 *   console.log(`Winner: ${outcome.winner!.agentId} (${outcome.winner!.confidence})`);
 * }
 * ```
 */
export class SpeculativeExecutor {
  private executeFn: SpeculativeExecutorFn;

  constructor(executeFn: SpeculativeExecutorFn) {
    this.executeFn = executeFn;
  }

  /**
   * Race the same payload across multiple candidate agents.
   * Returns the highest-confidence successful result.
   */
  async race(
    payload: Record<string, unknown>,
    candidates: SpeculativeCandidate[],
    options: SpeculativeOptions = {},
  ): Promise<SpeculativeOutcome> {
    const minConfidence = options.minConfidence ?? 50;
    const globalTimeout = options.timeoutMs ?? 30_000;
    const concurrency = options.concurrency ?? candidates.length;
    const startMs = Date.now();

    // Build per-candidate promises with individual timeouts
    const tasks = candidates.map(c => ({
      candidate: c,
      promise: this.executeWithTimeout(
        c.agentId,
        payload,
        c.timeoutMs ?? globalTimeout,
      ),
    }));

    // Execute with concurrency limit
    const results: SpeculativeResult[] = [];
    for (let i = 0; i < tasks.length; i += concurrency) {
      const batch = tasks.slice(i, i + concurrency);
      const settled = await Promise.allSettled(
        batch.map(async t => {
          const res = await t.promise;
          return {
            agentId: t.candidate.agentId,
            label: t.candidate.label,
            ...res,
          };
        }),
      );

      for (const s of settled) {
        if (s.status === 'fulfilled') {
          results.push(s.value);
        }
        // Rejections are silently dropped — speculative by design
      }
    }

    // Sort by confidence descending
    results.sort((a, b) => b.confidence - a.confidence);

    // Pick winner: highest confidence that is successful and above threshold
    const winner = results.find(r => r.success && r.confidence >= minConfidence) ?? null;

    return {
      winner,
      candidates: results,
      hasWinner: winner !== null,
      totalMs: Date.now() - startMs,
      successCount: results.filter(r => r.success).length,
    };
  }

  // --------------------------------------------------------------------------
  // INTERNAL
  // --------------------------------------------------------------------------

  private async executeWithTimeout(
    agentId: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<{ success: boolean; data: unknown; confidence: number; durationMs: number }> {
    const start = Date.now();

    const resultPromise = this.executeFn(agentId, payload);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Speculative timeout for ${agentId}`)), timeoutMs),
    );

    try {
      const result = await Promise.race([resultPromise, timeoutPromise]);
      return { ...result, durationMs: Date.now() - start };
    } catch {
      return { success: false, data: null, confidence: 0, durationMs: Date.now() - start };
    }
  }
}
