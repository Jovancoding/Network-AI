/**
 * Skill Composer — Meta-operations for composing agent execution
 *
 * Provides chain(), batch(), loop(), and verify() combinators that orchestrate
 * multiple agent calls into higher-level workflows. Works with any AdapterRegistry.
 *
 * Inspired by Claw-Code's skill composition pattern.
 *
 * @module SkillComposer
 * @version 1.0.0
 */

import type { AgentPayload, AgentContext, AgentResult } from '../types/agent-adapter';
import type { AdapterRegistry } from '../adapters/adapter-registry';

// ============================================================================
// TYPES
// ============================================================================

/**
 * A single composable execution step.
 */
export interface ComposableStep {
  /** The agent to execute */
  agentId: string;
  /** Payload to send to the agent */
  payload: AgentPayload;
  /** Partial context overrides (merged with base context) */
  context?: Partial<AgentContext>;
}

/**
 * Result of a composed workflow.
 */
export interface ComposedResult {
  /** Whether all steps succeeded */
  success: boolean;
  /** Individual results for each step */
  results: AgentResult[];
  /** Total execution time in milliseconds */
  totalMs: number;
  /** Number of steps that succeeded */
  successCount: number;
  /** Number of steps that failed */
  failureCount: number;
}

/**
 * Options for the loop combinator.
 */
export interface LoopOptions {
  /** Maximum iterations (default 10) */
  maxIterations?: number;
  /** Condition: return true to continue looping, false to stop */
  condition: (result: AgentResult, iteration: number) => boolean;
}

/**
 * Options for the verify combinator.
 */
export interface VerifyOptions {
  /** Maximum retry attempts (default 3) */
  maxRetries?: number;
  /** Validator: return true if the result is acceptable */
  validator: (result: AgentResult) => boolean;
}

// ============================================================================
// SKILL COMPOSER
// ============================================================================

/**
 * Composes agent execution into higher-level workflows.
 *
 * @example
 * ```typescript
 * const composer = new SkillComposer(registry, { agentId: 'orchestrator' });
 *
 * // Sequential chain — output of each step feeds into next
 * const results = await composer.chain([
 *   { agentId: 'researcher', payload: { action: 'search', params: { query: 'AI safety' } } },
 *   { agentId: 'writer', payload: { action: 'draft', params: {} } },
 *   { agentId: 'reviewer', payload: { action: 'review', params: {} } },
 * ]);
 *
 * // Parallel batch with concurrency limit
 * const batchResults = await composer.batch(steps, 5);
 * ```
 */
export class SkillComposer {
  private registry: AdapterRegistry;
  private baseContext: AgentContext;

  /**
   * @param registry The adapter registry to execute agents through
   * @param baseContext Default execution context (merged with step-level overrides)
   */
  constructor(registry: AdapterRegistry, baseContext: AgentContext) {
    this.registry = registry;
    this.baseContext = baseContext;
  }

  /**
   * Execute steps sequentially. Each step's result is passed as
   * `blackboardSnapshot.previousResult` to the next step.
   *
   * Stops on first failure unless `continueOnError` is true.
   */
  async chain(steps: ComposableStep[], continueOnError = false): Promise<ComposedResult> {
    const start = Date.now();
    const results: AgentResult[] = [];
    let successCount = 0;
    let failureCount = 0;

    let previousResult: unknown = undefined;

    for (const step of steps) {
      const payload: AgentPayload = {
        ...step.payload,
        blackboardSnapshot: {
          ...step.payload.blackboardSnapshot,
          previousResult,
        },
      };

      const ctx: AgentContext = { ...this.baseContext, ...step.context };
      const result = await this.registry.executeAgent(step.agentId, payload, ctx);
      results.push(result);

      if (result.success) {
        successCount++;
        previousResult = result.data;
      } else {
        failureCount++;
        if (!continueOnError) break;
      }
    }

    return {
      success: failureCount === 0,
      results,
      totalMs: Date.now() - start,
      successCount,
      failureCount,
    };
  }

  /**
   * Execute steps in parallel with an optional concurrency limit.
   *
   * @param steps Steps to execute
   * @param concurrency Max parallel executions (default: all at once)
   */
  async batch(steps: ComposableStep[], concurrency?: number): Promise<ComposedResult> {
    const start = Date.now();
    const limit = concurrency ?? steps.length;
    const results: AgentResult[] = new Array(steps.length);
    let successCount = 0;
    let failureCount = 0;

    // Process in chunks of `limit`
    for (let i = 0; i < steps.length; i += limit) {
      const chunk = steps.slice(i, i + limit);
      const chunkResults = await Promise.all(
        chunk.map((step, idx) => {
          const ctx: AgentContext = { ...this.baseContext, ...step.context };
          return this.registry.executeAgent(step.agentId, step.payload, ctx);
        }),
      );

      for (let j = 0; j < chunkResults.length; j++) {
        results[i + j] = chunkResults[j];
        if (chunkResults[j].success) {
          successCount++;
        } else {
          failureCount++;
        }
      }
    }

    return {
      success: failureCount === 0,
      results,
      totalMs: Date.now() - start,
      successCount,
      failureCount,
    };
  }

  /**
   * Repeatedly execute a step while `condition` returns true.
   *
   * @param step The step to repeat
   * @param options Loop options (condition + maxIterations)
   */
  async loop(step: ComposableStep, options: LoopOptions): Promise<ComposedResult> {
    const start = Date.now();
    const maxIter = options.maxIterations ?? 10;
    const results: AgentResult[] = [];
    let successCount = 0;
    let failureCount = 0;

    for (let i = 0; i < maxIter; i++) {
      const ctx: AgentContext = {
        ...this.baseContext,
        ...step.context,
        metadata: { ...this.baseContext.metadata, ...step.context?.metadata, iteration: i },
      };

      const result = await this.registry.executeAgent(step.agentId, step.payload, ctx);
      results.push(result);

      if (result.success) {
        successCount++;
      } else {
        failureCount++;
      }

      if (!options.condition(result, i)) break;
    }

    return {
      success: failureCount === 0,
      results,
      totalMs: Date.now() - start,
      successCount,
      failureCount,
    };
  }

  /**
   * Execute a step and retry until the validator accepts the result or retries are exhausted.
   *
   * @param step The step to execute and verify
   * @param options Verify options (validator + maxRetries)
   */
  async verify(step: ComposableStep, options: VerifyOptions): Promise<AgentResult> {
    const maxRetries = options.maxRetries ?? 3;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const ctx: AgentContext = {
        ...this.baseContext,
        ...step.context,
        metadata: { ...this.baseContext.metadata, ...step.context?.metadata, attempt },
      };

      const result = await this.registry.executeAgent(step.agentId, step.payload, ctx);

      if (result.success && options.validator(result)) {
        return result;
      }

      // Last attempt — return whatever we got
      if (attempt === maxRetries) {
        return result;
      }
    }

    // Unreachable, but TypeScript needs it
    return { success: false, error: { code: 'VERIFY_EXHAUSTED', message: 'All retries exhausted', recoverable: false } };
  }
}
