/**
 * Fan-Out / Fan-In — Parallel agent spawning and result aggregation
 *
 * Launches multiple agents in parallel (fan-out) and combines their results
 * using pluggable strategies (fan-in). Supports concurrency limits, timeouts,
 * and custom aggregation. Inspired by Claude Code's parallel agent patterns.
 *
 * @module FanOutFanIn
 * @version 1.0.0
 */

import type { AgentPayload, AgentContext, AgentResult } from '../types/agent-adapter';
import type { AdapterRegistry } from '../adapters/adapter-registry';

// ============================================================================
// TYPES
// ============================================================================

/**
 * A single agent invocation for the fan-out step.
 */
export interface FanOutStep {
  /** Agent to execute */
  agentId: string;
  /** Payload to send */
  payload: AgentPayload;
  /** Optional context overrides (merged with baseContext) */
  context?: Partial<AgentContext>;
  /** Per-step timeout in ms (overrides global timeout) */
  timeoutMs?: number;
  /** Arbitrary label for this step (used in result mapping) */
  label?: string;
  /**
   * Same-agent retries before falling back (default: 0). Budgeted per step, so
   * one sub-agent's retries never consume another's allowance.
   */
  retries?: number;
  /** This sub-agent's OWN fallback agent, tried once after retries are exhausted. */
  fallbackAgentId?: string;
  /** Payload for the fallback agent (defaults to the step's payload). */
  fallbackPayload?: AgentPayload;
}

/**
 * Result of a single fan-out execution, tagged with its step info.
 */
export interface TaggedResult {
  /** The agent that produced this result */
  agentId: string;
  /** Step label (if provided) */
  label?: string;
  /** Index of the step in the original fan-out array */
  index: number;
  /** Actual agent result */
  result: AgentResult;
  /** Execution duration in ms */
  durationMs: number;
  /** Total invocations (primary retries + fallback) when resilience is configured. */
  retryAttempts?: number;
  /** The fallback agent that served this result, if the primary chain failed. */
  fellBackTo?: string;
}

/**
 * Fan-in aggregation strategy.
 *
 * - `merge`:       Collect all results into an array
 * - `firstSuccess`: Return the first successful result
 * - `vote`:        Return the result that occurs most often (by data equality)
 * - `consensus`:   Return result only if all agents agree
 * - `custom`:      Use a custom reducer function
 */
export type FanInStrategy = 'merge' | 'firstSuccess' | 'vote' | 'consensus' | 'custom';

/**
 * Result of a fan-in aggregation.
 */
export interface FanInResult {
  /** Whether aggregation was successful */
  success: boolean;
  /** Strategy that was used */
  strategy: FanInStrategy;
  /** Aggregated data (depends on strategy) */
  data: unknown;
  /** All individual tagged results */
  results: TaggedResult[];
  /** Total execution time in ms */
  totalMs: number;
  /** Count of successful individual results */
  successCount: number;
  /** Count of failed individual results */
  failureCount: number;
}

/**
 * Custom reducer for the 'custom' fan-in strategy.
 */
export type FanInReducer = (results: TaggedResult[]) => { success: boolean; data: unknown };

/**
 * Options for FanOutFanIn execution.
 */
export interface FanOutOptions {
  /** Max concurrent agent executions (default: unlimited) */
  concurrency?: number;
  /** Global timeout in ms for all fan-out (default: none) */
  timeoutMs?: number;
  /** If true, continue even when some agents fail (default: true) */
  continueOnError?: boolean;
}

// ============================================================================
// FAN-OUT / FAN-IN
// ============================================================================

/**
 * Parallel agent execution with pluggable result aggregation.
 *
 * @example
 * ```typescript
 * const fanout = new FanOutFanIn(registry, { agentId: 'orchestrator' });
 *
 * const steps: FanOutStep[] = [
 *   { agentId: 'researcher-a', payload: { action: 'search', params: { q: 'AI safety' } }, label: 'web' },
 *   { agentId: 'researcher-b', payload: { action: 'search', params: { q: 'AI safety' } }, label: 'papers' },
 *   { agentId: 'researcher-c', payload: { action: 'search', params: { q: 'AI safety' } }, label: 'news' },
 * ];
 *
 * const results = await fanout.fanOut(steps, { concurrency: 2 });
 * const aggregated = fanout.fanIn(results, 'merge');
 * ```
 */
export class FanOutFanIn {
  private registry: AdapterRegistry;
  private baseContext: AgentContext;

  /**
   * @param registry Adapter registry for agent execution
   * @param baseContext Default execution context (merged with step-level overrides)
   */
  constructor(registry: AdapterRegistry, baseContext: AgentContext) {
    this.registry = registry;
    this.baseContext = baseContext;
  }

  /**
   * Execute agents in parallel (fan-out phase).
   *
   * Uses a true semaphore queue — as soon as one slot frees up the next
   * step starts, rather than waiting for an entire chunk to drain.
   *
   * @param steps Steps to execute
   * @param options Concurrency and timeout settings
   */
  async fanOut(steps: FanOutStep[], options: FanOutOptions = {}): Promise<TaggedResult[]> {
    if (steps.length === 0) return [];

    const maxConcurrency = Math.max(1, options.concurrency ?? steps.length);
    const continueOnError = options.continueOnError ?? true;
    const results: (TaggedResult | undefined)[] = new Array(steps.length);

    return new Promise<TaggedResult[]>((resolve) => {
      let activeCount = 0;
      let nextToStart = 0;
      let completedCount = 0;
      let shouldAbort = false;

      const checkDone = () => {
        if (completedCount === steps.length) {
          resolve(results as TaggedResult[]);
        }
      };

      /** Mark all not-yet-started (and not-yet-filled) slots as SKIPPED. */
      const markRemainingSkipped = (fromIdx: number) => {
        for (let k = fromIdx; k < steps.length; k++) {
          if (results[k] === undefined) {
            results[k] = {
              agentId: steps[k].agentId,
              label: steps[k].label,
              index: k,
              result: {
                success: false,
                error: { code: 'FANOUT_SKIPPED', message: 'Skipped due to earlier failure', recoverable: false },
              },
              durationMs: 0,
            };
            completedCount++;
          }
        }
      };

      const onTaskDone = (tagged: TaggedResult, isFailure: boolean) => {
        results[tagged.index] = tagged;
        activeCount--;
        completedCount++;

        if (!continueOnError && isFailure && !shouldAbort) {
          shouldAbort = true;
          // Skip all tasks that haven't been picked up yet
          markRemainingSkipped(nextToStart);
        }

        checkDone();
        if (!shouldAbort) {
          scheduleNext();
        }
      };

      const scheduleNext = () => {
        while (activeCount < maxConcurrency && nextToStart < steps.length && !shouldAbort) {
          const idx = nextToStart++;
          activeCount++;
          this.executeStep(steps[idx], idx, options.timeoutMs).then(
            (tagged) => onTaskDone(tagged, !tagged.result.success),
            (reason) => {
              const tagged: TaggedResult = {
                agentId: steps[idx].agentId,
                label: steps[idx].label,
                index: idx,
                result: {
                  success: false,
                  error: { code: 'FANOUT_ERROR', message: String(reason), recoverable: false },
                },
                durationMs: 0,
              };
              onTaskDone(tagged, true);
            },
          );
        }
      };

      scheduleNext();
    });
  }

  /**
   * Aggregate results (fan-in phase).
   *
   * @param results Tagged results from fan-out
   * @param strategy Aggregation strategy to apply
   * @param customReducer Required when strategy is 'custom'
   */
  fanIn(results: TaggedResult[], strategy: FanInStrategy = 'merge', customReducer?: FanInReducer): FanInResult {
    const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);
    const successCount = results.filter(r => r.result.success).length;
    const failureCount = results.length - successCount;

    let success: boolean;
    let data: unknown;

    switch (strategy) {
      case 'merge': {
        success = successCount > 0;
        data = results.map(r => ({
          agentId: r.agentId,
          label: r.label,
          success: r.result.success,
          data: r.result.data,
        }));
        break;
      }
      case 'firstSuccess': {
        const first = results.find(r => r.result.success);
        success = !!first;
        data = first?.result.data ?? null;
        break;
      }
      case 'vote': {
        const votes = new Map<string, { count: number; data: unknown }>();
        for (const r of results) {
          if (!r.result.success) continue;
          const key = JSON.stringify(r.result.data);
          const existing = votes.get(key);
          if (existing) {
            existing.count++;
          } else {
            votes.set(key, { count: 1, data: r.result.data });
          }
        }
        let best: { count: number; data: unknown } | undefined;
        for (const v of votes.values()) {
          if (!best || v.count > best.count) best = v;
        }
        success = !!best;
        data = best?.data ?? null;
        break;
      }
      case 'consensus': {
        const successResults = results.filter(r => r.result.success);
        if (successResults.length === 0) {
          success = false;
          data = null;
        } else {
          const first = JSON.stringify(successResults[0].result.data);
          const allAgree = successResults.every(r => JSON.stringify(r.result.data) === first);
          success = allAgree;
          data = allAgree ? successResults[0].result.data : null;
        }
        break;
      }
      case 'custom': {
        if (!customReducer) {
          throw new Error('customReducer is required when strategy is "custom"');
        }
        const reduced = customReducer(results);
        success = reduced.success;
        data = reduced.data;
        break;
      }
    }

    return { success, strategy, data, results, totalMs, successCount, failureCount };
  }

  /**
   * Convenience: fan-out + fan-in in a single call.
   */
  async run(
    steps: FanOutStep[],
    strategy: FanInStrategy = 'merge',
    options?: FanOutOptions,
    customReducer?: FanInReducer,
  ): Promise<FanInResult> {
    const results = await this.fanOut(steps, options);
    return this.fanIn(results, strategy, customReducer);
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private async executeStep(step: FanOutStep, index: number, globalTimeout?: number): Promise<TaggedResult> {
    const start = Date.now();
    const maxRetries = Math.max(0, step.retries ?? 0);
    const hasResilience = maxRetries > 0 || Boolean(step.fallbackAgentId);

    // Backward-compatible simple path: no retries, no fallback.
    if (!hasResilience) {
      const result = await this.invoke(step.agentId, step.payload, step, globalTimeout);
      return { agentId: step.agentId, label: step.label, index, result, durationMs: Date.now() - start };
    }

    // Resilient path: per-step retry budget, then this sub-agent's own fallback.
    let attempts = 0;
    let last: AgentResult = { success: false, error: { code: 'NOT_RUN', message: 'step not executed', recoverable: false } };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      attempts++;
      last = await this.invokeSafe(step.agentId, step.payload, step, globalTimeout);
      if (last.success) {
        return { agentId: step.agentId, label: step.label, index, result: last, durationMs: Date.now() - start, retryAttempts: attempts };
      }
    }

    if (step.fallbackAgentId) {
      attempts++;
      const fb = await this.invokeSafe(step.fallbackAgentId, step.fallbackPayload ?? step.payload, step, globalTimeout);
      return {
        agentId: step.agentId,
        label: step.label,
        index,
        result: fb,
        durationMs: Date.now() - start,
        retryAttempts: attempts,
        fellBackTo: step.fallbackAgentId,
      };
    }

    return { agentId: step.agentId, label: step.label, index, result: last, durationMs: Date.now() - start, retryAttempts: attempts };
  }

  /** Invoke an agent with the step's timeout. Rejects on timeout. @internal */
  private async invoke(agentId: string, payload: AgentPayload, step: FanOutStep, globalTimeout?: number): Promise<AgentResult> {
    const ctx: AgentContext = { ...this.baseContext, ...step.context };
    const timeout = step.timeoutMs ?? globalTimeout;
    if (timeout) {
      return Promise.race([
        this.registry.executeAgent(agentId, payload, ctx),
        new Promise<AgentResult>((_, reject) =>
          setTimeout(() => reject(new Error(`Fan-out timeout: agent "${agentId}" exceeded ${timeout}ms`)), timeout),
        ),
      ]);
    }
    return this.registry.executeAgent(agentId, payload, ctx);
  }

  /** Like {@link invoke} but captures timeouts/throws as a failed result so a retry can follow. @internal */
  private async invokeSafe(agentId: string, payload: AgentPayload, step: FanOutStep, globalTimeout?: number): Promise<AgentResult> {
    try {
      return await this.invoke(agentId, payload, step, globalTimeout);
    } catch (err) {
      return { success: false, error: { code: 'FANOUT_ERROR', message: err instanceof Error ? err.message : String(err), recoverable: true } };
    }
  }
}
