/**
 * Task decomposition engine for parallel multi-agent execution.
 *
 * Breaks complex tasks into parallel sub-agent calls, routes them through
 * the adapter registry, caches results on the blackboard, and synthesizes
 * outputs using configurable strategies (merge, vote, chain, first-success).
 *
 * @module TaskDecomposer
 */

import { randomUUID } from 'crypto';
import { AdapterRegistry } from '../adapters/adapter-registry';
import { InputSanitizer } from '../security';
import { ValidationError } from './errors';
import { SharedBlackboard } from './shared-blackboard';
import { AuthGuardian } from './auth-guardian';
import { CONFIG } from './orchestrator-types';
import type {
  SkillContext,
  TaskPayload,
  HandoffMessage,
  ParallelTask,
  ParallelExecutionResult,
  SynthesisStrategy,
} from './orchestrator-types';
import type { AgentPayload, AgentContext } from '../types/agent-adapter';

export class TaskDecomposer {
  private blackboard: SharedBlackboard;
  private authGuardian: AuthGuardian;
  private adapterRegistry: AdapterRegistry;
  /** Maximum number of tasks to run concurrently (0 = unlimited). */
  private maxConcurrency: number;

  constructor(
    blackboard: SharedBlackboard,
    authGuardian: AuthGuardian,
    adapterRegistry: AdapterRegistry,
    options?: { maxConcurrency?: number }
  ) {
    if (!blackboard || !(blackboard instanceof SharedBlackboard)) {
      throw new ValidationError('blackboard must be an instance of SharedBlackboard');
    }
    if (!authGuardian || !(authGuardian instanceof AuthGuardian)) {
      throw new ValidationError('authGuardian must be an instance of AuthGuardian');
    }
    if (!adapterRegistry || !(adapterRegistry instanceof AdapterRegistry)) {
      throw new ValidationError('adapterRegistry must be an instance of AdapterRegistry');
    }
    this.blackboard = blackboard;
    this.authGuardian = authGuardian;
    this.adapterRegistry = adapterRegistry;
    this.maxConcurrency = options?.maxConcurrency ?? 5;
  }

  /**
   * Decomposes a complex task into parallel sub-agent calls
   * This is the "Wall Breaker" - transforms impossible monolithic tasks
   * into manageable parallel executions
   */
  async executeParallel(
    tasks: ParallelTask[],
    synthesisStrategy: SynthesisStrategy = 'merge',
    context: SkillContext
  ): Promise<ParallelExecutionResult> {
    if (!tasks || !Array.isArray(tasks)) {
      throw new ValidationError('tasks must be an array');
    }
    if (tasks.length === 0) {
      throw new ValidationError('tasks array must not be empty');
    }
    if (!context || typeof context !== 'object' || !context.agentId) {
      throw new ValidationError('context is required and must include agentId');
    }
    // No hard parallel limit — caller controls concurrency via task count

    const startTime = Date.now();
    const individualResults: ParallelExecutionResult['individualResults'] = [];

    // Check blackboard for cached results first
    const cachedTasks: ParallelTask[] = [];
    const uncachedTasks: ParallelTask[] = [];

    for (const task of tasks) {
      const cacheKey = `task:${task.agentType}:${this.hashPayload(task.taskPayload)}`;
      const cached = this.blackboard.read(cacheKey);

      if (cached) {
        individualResults.push({
          agentType: task.agentType,
          success: true,
          result: cached.value,
          executionTime: 0, // From cache
        });
        cachedTasks.push(task);
      } else {
        uncachedTasks.push(task);
      }
    }

    // Execute uncached tasks with concurrency cap
    if (uncachedTasks.length > 0) {
      const results = await this.runWithConcurrencyLimit(
        uncachedTasks,
        task => this.executeSingleTask(task, context),
        this.maxConcurrency
      );

      for (let i = 0; i < results.length; i++) {
        const task = uncachedTasks[i];
        const result = results[i];

        individualResults.push(result);

        // Cache successful results
        if (result.success) {
          const cacheKey = `task:${task.agentType}:${this.hashPayload(task.taskPayload)}`;
          this.blackboard.write(cacheKey, result.result, context.agentId, 3600, 'system-orchestrator-token'); // 1 hour TTL
        }
      }
    }

    // Synthesize results based on strategy
    const synthesizedResult = this.synthesize(individualResults, synthesisStrategy);

    const totalTime = Date.now() - startTime;
    const successCount = individualResults.filter(r => r.success).length;

    return {
      synthesizedResult,
      individualResults,
      executionMetrics: {
        totalTime,
        successRate: successCount / individualResults.length,
        synthesisStrategy,
      },
    };
  }

  private async executeSingleTask(
    task: ParallelTask,
    context: SkillContext
  ): Promise<ParallelExecutionResult['individualResults'][0]> {
    const taskStart = Date.now();

    try {
      // Build the handoff message
      const handoff: HandoffMessage = {
        handoffId: randomUUID(),
        sourceAgent: context.agentId,
        targetAgent: task.agentType,
        taskType: 'delegate',
        payload: task.taskPayload,
        metadata: {
          priority: 1,
          deadline: Date.now() + CONFIG.defaultTimeout,
          parentTaskId: context.taskId ?? null,
        },
      };

      // Sanitize the instruction before sending to adapter
      let sanitizedInstruction = task.taskPayload.instruction;
      try {
        sanitizedInstruction = InputSanitizer.sanitizeString(task.taskPayload.instruction, 10000);
      } catch { /* use original if sanitization fails */ }

      // Use namespace-scoped snapshot -- target agent only sees keys it's allowed to see
      const scopedSnapshot = this.blackboard.getScopedSnapshot(task.agentType);

      // Route through the adapter registry (framework-agnostic)
      const agentPayload: AgentPayload = {
        action: 'execute',
        params: {},
        handoff: {
          handoffId: handoff.handoffId,
          sourceAgent: handoff.sourceAgent,
          targetAgent: handoff.targetAgent,
          taskType: handoff.taskType,
          instruction: sanitizedInstruction,
          context: handoff.payload.context,
          constraints: handoff.payload.constraints,
          expectedOutput: handoff.payload.expectedOutput,
          metadata: handoff.metadata as unknown as Record<string, unknown>,
        },
        blackboardSnapshot: scopedSnapshot as Record<string, unknown>,
      };

      const agentContext: AgentContext = {
        agentId: context.agentId,
        taskId: context.taskId,
        sessionId: context.sessionId,
      };

      const result = await this.adapterRegistry.executeAgent(task.agentType, agentPayload, agentContext);

      // Sanitize adapter output before returning/caching
      let sanitizedData = result.data;
      try {
        sanitizedData = InputSanitizer.sanitizeObject(result.data);
      } catch { /* use raw if sanitization fails */ }

      return {
        agentType: task.agentType,
        success: true,
        result: sanitizedData,
        executionTime: Date.now() - taskStart,
      };
    } catch (error) {
      return {
        agentType: task.agentType,
        success: false,
        result: {
          error: error instanceof Error ? error.message : 'Unknown error',
          recoverable: true,
        },
        executionTime: Date.now() - taskStart,
      };
    }
  }

  private synthesize(
    results: ParallelExecutionResult['individualResults'],
    strategy: SynthesisStrategy
  ): unknown {
    const successfulResults = results.filter(r => r.success);

    if (successfulResults.length === 0) {
      return {
        error: 'All parallel tasks failed',
        individualErrors: results.map(r => ({
          agent: r.agentType,
          error: r.result,
        })),
      };
    }

    switch (strategy) {
      case 'merge':
        // Combine all results into a unified object
        return {
          merged: true,
          contributions: successfulResults.map(r => ({
            source: r.agentType,
            data: r.result,
          })),
          summary: this.generateMergeSummary(successfulResults),
        };

      case 'vote':
        // Return the result with highest "confidence" (simplified: most data)
        const scored = successfulResults.map(r => ({
          result: r,
          score: JSON.stringify(r.result).length,
        }));
        scored.sort((a, b) => b.score - a.score);
        return {
          voted: true,
          winner: scored[0].result.agentType,
          result: scored[0].result.result,
        };

      case 'chain':
        // Results should already be ordered; return the final one
        return {
          chained: true,
          finalResult: successfulResults[successfulResults.length - 1].result,
          chainLength: successfulResults.length,
        };

      case 'first-success':
        // Return the first successful result
        return {
          firstSuccess: true,
          source: successfulResults[0].agentType,
          result: successfulResults[0].result,
        };

      default:
        return successfulResults.map(r => r.result);
    }
  }

  private generateMergeSummary(results: ParallelExecutionResult['individualResults']): string {
    const agents = results.map(r => r.agentType).join(', ');
    return `Synthesized from ${results.length} agents: ${agents}`;
  }

  private hashPayload(payload: TaskPayload): string {
    // Simple hash for cache key generation
    const str = JSON.stringify(payload);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Execute async functions with a bounded concurrency pool.
   * @param items Items to process
   * @param fn Async function to apply to each item
   * @param limit Max concurrent executions (0 = unlimited)
   */
  private async runWithConcurrencyLimit<T, R>(
    items: T[],
    fn: (item: T) => Promise<R>,
    limit: number
  ): Promise<R[]> {
    if (limit <= 0 || items.length <= limit) {
      return Promise.all(items.map(fn));
    }

    const results: R[] = new Array(items.length);
    let nextIndex = 0;

    async function worker(): Promise<void> {
      while (nextIndex < items.length) {
        const idx = nextIndex++;
        results[idx] = await fn(items[idx]);
      }
    }

    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(limit, items.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return results;
  }
}
