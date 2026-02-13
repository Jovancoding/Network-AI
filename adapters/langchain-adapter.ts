/**
 * LangChain / LangGraph Adapter
 * 
 * Allows LangChain agents, chains, and LangGraph workflows to plug into
 * the SwarmOrchestrator. Agents are registered as callable functions
 * or LangChain Runnable objects.
 * 
 * Usage:
 *   const adapter = new LangChainAdapter();
 *   adapter.registerAgent("research", myLangChainAgent);
 *   adapter.registerAgent("summarizer", myChain);
 *   await registry.addAdapter(adapter);
 * 
 * Then in the orchestrator:
 *   delegateTask({ targetAgent: "lc:research", ... })
 * 
 * @module LangChainAdapter
 * @version 1.0.0
 */

import { BaseAdapter } from './base-adapter';
import type {
  AdapterConfig,
  AdapterCapabilities,
  AgentPayload,
  AgentContext,
  AgentResult,
} from '../types/agent-adapter';

/**
 * A LangChain-compatible callable.
 * This matches LangChain's Runnable interface: anything with .invoke()
 * Also supports plain async functions for flexibility.
 */
export type LangChainRunnable = {
  invoke: (input: unknown, config?: unknown) => Promise<unknown>;
  getName?: () => string;
} | ((input: unknown) => Promise<unknown>);

export class LangChainAdapter extends BaseAdapter {
  readonly name = 'langchain';
  readonly version = '1.0.0';
  private runnables: Map<string, LangChainRunnable> = new Map();

  get capabilities(): AdapterCapabilities {
    return {
      streaming: true,
      parallel: true,
      bidirectional: false,
      discovery: true,
      authentication: false,
      statefulSessions: true,
    };
  }

  /**
   * Register a LangChain agent, chain, or LangGraph graph.
   * 
   * @param agentId - Unique identifier for this agent
   * @param runnable - A LangChain Runnable (agent, chain, graph) or async function
   * @param metadata - Optional metadata (description, capabilities)
   */
  registerAgent(
    agentId: string,
    runnable: LangChainRunnable,
    metadata?: { description?: string; capabilities?: string[] }
  ): void {
    this.runnables.set(agentId, runnable);
    this.registerLocalAgent({
      id: agentId,
      name: agentId,
      description: metadata?.description ?? `LangChain agent: ${agentId}`,
      capabilities: metadata?.capabilities,
      status: 'available',
    });
  }

  async executeAgent(
    agentId: string,
    payload: AgentPayload,
    context: AgentContext
  ): Promise<AgentResult> {
    this.ensureReady();

    const runnable = this.runnables.get(agentId);
    if (!runnable) {
      return this.errorResult(
        'AGENT_NOT_FOUND',
        `LangChain agent "${agentId}" is not registered. Call adapter.registerAgent() first.`,
        false
      );
    }

    const startTime = Date.now();

    try {
      // Build the input in LangChain's expected format
      const input = this.buildInput(payload, context);

      // Execute: support both Runnable.invoke() and plain functions
      let result: unknown;
      if (typeof runnable === 'function') {
        result = await runnable(input);
      } else {
        result = await runnable.invoke(input, {
          metadata: {
            taskId: context.taskId,
            sessionId: context.sessionId,
            sourceAgent: context.agentId,
          },
        });
      }

      // Normalize the result
      return this.normalizeResult(result, startTime);
    } catch (error) {
      return this.errorResult(
        'LANGCHAIN_ERROR',
        error instanceof Error ? error.message : 'LangChain execution failed',
        true,
        error
      );
    }
  }

  private buildInput(payload: AgentPayload, context: AgentContext): Record<string, unknown> {
    const input: Record<string, unknown> = {
      ...payload.params,
    };

    // Map handoff instruction to common LangChain input keys
    if (payload.handoff) {
      input.input = payload.handoff.instruction;
      input.question = payload.handoff.instruction; // Some chains expect "question"
      input.task = payload.handoff.instruction;

      if (payload.handoff.context) {
        input.context = payload.handoff.context;
      }
      if (payload.handoff.constraints) {
        input.constraints = payload.handoff.constraints;
      }
    }

    // Include blackboard data
    if (payload.blackboardSnapshot) {
      input.shared_state = payload.blackboardSnapshot;
    }

    // Agent context
    input.agent_context = {
      agentId: context.agentId,
      taskId: context.taskId,
      sessionId: context.sessionId,
    };

    return input;
  }

  private normalizeResult(result: unknown, startTime: number): AgentResult {
    // Handle LangChain's various output formats
    if (result && typeof result === 'object') {
      const obj = result as Record<string, unknown>;

      // AgentExecutor returns { output: "..." }
      if ('output' in obj) {
        return this.successResult(obj.output, Date.now() - startTime);
      }

      // Some chains return { result: "..." }
      if ('result' in obj) {
        return this.successResult(obj.result, Date.now() - startTime);
      }

      // LangGraph returns state objects -- pass through  
      return this.successResult(result, Date.now() - startTime);
    }

    // String or primitive result
    return this.successResult(result, Date.now() - startTime);
  }
}
