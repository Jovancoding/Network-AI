/**
 * OpenAI Agents SDK Adapter
 *
 * Integrates the OpenAI Agents SDK (Python-first, but JS-compatible API)
 * with the SwarmOrchestrator.
 *
 * The OpenAI Agents SDK provides:
 *   - Agent definition with instructions + tools
 *   - Handoff between agents
 *   - Guardrails (input/output validation)
 *   - Tracing
 *
 * This adapter wraps user-supplied agent runners or HTTP endpoints
 * that expose the Agents SDK interface. No hard dependency on the SDK.
 *
 * Usage:
 *   const adapter = new OpenAIAgentsAdapter();
 *   adapter.registerAgentRunner('researcher', {
 *     runner: myAgentRunner,
 *   });
 *
 * @module OpenAIAgentsAdapter
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

/** Tool definition for an OpenAI Agent */
export interface OAIAgentTool {
  /** Tool name */
  name: string;
  /** Tool description */
  description: string;
  /** JSON schema for the tool's parameters */
  parameters: Record<string, unknown>;
}

/** Result from an agent run */
export interface OAIAgentRunResult {
  /** Final text output */
  output: string;
  /** Tool calls made during execution */
  toolCalls?: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: unknown;
  }>;
  /** Agent handoffs that occurred */
  handoffs?: Array<{ from: string; to: string; reason?: string }>;
  /** Whether guardrails triggered */
  guardrailTriggered?: boolean;
  /** Token usage */
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Minimal interface for running an OpenAI Agent.
 * Wraps `Runner.run()` from the Agents SDK or an HTTP endpoint.
 */
export interface OAIAgentRunner {
  run(input: string, context?: Record<string, unknown>): Promise<OAIAgentRunResult>;
}

/** Configuration for a registered OpenAI Agents SDK agent */
export interface OAIAgentsConfig {
  /** The agent runner instance */
  runner: OAIAgentRunner;
  /** Agent instructions (system prompt) */
  instructions?: string;
  /** Tools available to the agent */
  tools?: OAIAgentTool[];
  /** Model to use (default: 'gpt-4o') */
  model?: string;
  /** Per-invocation timeout in ms (default: 120000) */
  timeoutMs?: number;
  /** Whether handoffs are enabled */
  handoffsEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Adapter for the OpenAI Agents SDK.
 *
 * Wraps agent runners that implement the OAIAgentRunner interface.
 * Supports tool use, handoffs, and guardrails via the SDK's execution model.
 */
export class OpenAIAgentsAdapter extends BaseAdapter {
  readonly name = 'openai-agents';
  readonly version = '1.0.0';

  private runners = new Map<string, OAIAgentsConfig>();

  get capabilities(): AdapterCapabilities {
    return {
      streaming: false,
      parallel: true,
      bidirectional: false,
      discovery: true,
      authentication: true,
      statefulSessions: false,
    };
  }

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  /**
   * Register an OpenAI Agent runner as a named agent.
   */
  registerAgentRunner(agentId: string, config: OAIAgentsConfig): void {
    this.runners.set(agentId, config);
    this.registerLocalAgent({
      id: agentId,
      name: agentId,
      status: 'available',
      capabilities: ['tool-use', 'handoff', ...(config.tools?.map((t) => t.name) ?? [])],
      metadata: {
        adapter: 'openai-agents',
        model: config.model ?? 'gpt-4o',
        handoffsEnabled: config.handoffsEnabled ?? false,
      },
    });
  }

  // -----------------------------------------------------------------------
  // Execution
  // -----------------------------------------------------------------------

  async executeAgent(agentId: string, payload: AgentPayload, _context: AgentContext): Promise<AgentResult> {
    this.ensureReady();

    const config = this.runners.get(agentId);
    if (!config) {
      return this.errorResult('OAI_AGENTS_NOT_FOUND', `No agent runner registered as '${agentId}'`);
    }

    const input = payload.handoff?.instruction
      ?? (payload.params?.instruction as string)
      ?? (payload.params?.input as string)
      ?? payload.action;

    const runContext: Record<string, unknown> = {
      ...(payload.params as Record<string, unknown> | undefined),
      ...(payload.handoff?.context as Record<string, unknown> | undefined),
    };

    const timeoutMs = config.timeoutMs ?? 120_000;
    const start = Date.now();

    try {
      const result = await Promise.race([
        config.runner.run(input, runContext),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('OpenAI Agent execution timed out')), timeoutMs),
        ),
      ]);

      const durationMs = Date.now() - start;

      return this.successResult({
        output: result.output,
        toolCalls: result.toolCalls,
        handoffs: result.handoffs,
        guardrailTriggered: result.guardrailTriggered,
        usage: result.usage,
      }, durationMs);
    } catch (err) {
      return this.errorResult(
        'OAI_AGENTS_EXECUTION_FAILED',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async shutdown(): Promise<void> {
    this.runners.clear();
    await super.shutdown();
  }
}
