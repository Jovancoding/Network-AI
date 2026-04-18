/**
 * LangGraph Adapter
 *
 * Integrates LangGraph (LangChain's stateful graph execution framework)
 * with the SwarmOrchestrator.
 *
 * LangGraph models agent workflows as directed graphs with typed state,
 * conditional edges, and cycles. This adapter wraps user-supplied graph
 * instances with no hard dependency on the LangGraph package.
 *
 * Usage:
 *   const adapter = new LangGraphAdapter();
 *   adapter.registerGraph('research-flow', myCompiledGraph, {
 *     inputKey: 'messages',
 *     outputKey: 'response',
 *   });
 *
 * @module LangGraphAdapter
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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal interface for a compiled LangGraph graph.
 * Compatible with `StateGraph.compile()` output.
 * Users supply their own LangGraph instance — no hard dependency.
 */
export interface LangGraphRunnable {
  invoke(
    input: Record<string, unknown>,
    config?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

/**
 * Streaming variant — optional, for graphs that support streaming.
 */
export interface LangGraphStreamable extends LangGraphRunnable {
  stream(
    input: Record<string, unknown>,
    config?: Record<string, unknown>,
  ): AsyncIterable<Record<string, unknown>>;
}

/** Configuration for a registered graph agent */
export interface LangGraphAgentConfig {
  /** The compiled graph instance */
  graph: LangGraphRunnable;
  /** State key to populate with the agent payload (default: 'messages') */
  inputKey?: string;
  /** State key to read the result from (default: 'response') */
  outputKey?: string;
  /** Optional thread/session ID for checkpointed graphs */
  threadId?: string;
  /** Per-invocation timeout in ms (default: 60000) */
  timeoutMs?: number;
  /** Additional config passed to graph.invoke() */
  runnableConfig?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Adapter for LangGraph stateful agent graphs.
 *
 * Each registered graph is exposed as a named agent. The adapter
 * handles input mapping, timeout enforcement, and result extraction.
 */
export class LangGraphAdapter extends BaseAdapter {
  readonly name = 'langgraph';
  readonly version = '1.0.0';

  private graphs = new Map<string, LangGraphAgentConfig>();

  get capabilities(): AdapterCapabilities {
    return {
      streaming: false,
      parallel: true,
      bidirectional: false,
      discovery: true,
      authentication: false,
      statefulSessions: true,
    };
  }

  // -----------------------------------------------------------------------
  // Graph registration
  // -----------------------------------------------------------------------

  /**
   * Register a compiled LangGraph as a named agent.
   */
  registerGraph(agentId: string, graph: LangGraphRunnable, options: Omit<LangGraphAgentConfig, 'graph'> = {}): void {
    const config: LangGraphAgentConfig = { graph, ...options };
    this.graphs.set(agentId, config);
    this.registerLocalAgent({
      id: agentId,
      name: agentId,
      status: 'available',
      capabilities: ['graph', 'stateful'],
      metadata: { adapter: 'langgraph', inputKey: config.inputKey ?? 'messages' },
    });
  }

  // -----------------------------------------------------------------------
  // Execution
  // -----------------------------------------------------------------------

  async executeAgent(agentId: string, payload: AgentPayload, _context: AgentContext): Promise<AgentResult> {
    this.ensureReady();

    const config = this.graphs.get(agentId);
    if (!config) {
      return this.errorResult('LANGGRAPH_AGENT_NOT_FOUND', `No graph registered for agent '${agentId}'`);
    }

    const inputKey = config.inputKey ?? 'messages';
    const outputKey = config.outputKey ?? 'response';
    const timeoutMs = config.timeoutMs ?? 60_000;

    // Build input state
    const input: Record<string, unknown> = {
      [inputKey]: payload.params ?? payload.action,
      ...(payload.handoff?.context as Record<string, unknown> | undefined),
    };

    // Build runnable config
    const runnableConfig: Record<string, unknown> = {
      ...config.runnableConfig,
    };
    if (config.threadId) {
      runnableConfig['configurable'] = {
        ...(runnableConfig['configurable'] as Record<string, unknown> | undefined),
        thread_id: config.threadId,
      };
    }

    const start = Date.now();
    try {
      const result = await Promise.race([
        config.graph.invoke(input, runnableConfig),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('LangGraph invocation timed out')), timeoutMs),
        ),
      ]);

      const durationMs = Date.now() - start;
      const output = result[outputKey] ?? result;

      return this.successResult({
        output,
        state: result,
        graphAgent: agentId,
      }, durationMs);
    } catch (err) {
      return this.errorResult(
        'LANGGRAPH_EXECUTION_FAILED',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async shutdown(): Promise<void> {
    this.graphs.clear();
    await super.shutdown();
  }
}
