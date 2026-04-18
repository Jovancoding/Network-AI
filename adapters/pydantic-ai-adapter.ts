/**
 * Pydantic AI Adapter
 *
 * Integrates Pydantic AI (type-safe Python agent framework) with the
 * SwarmOrchestrator via user-supplied runner functions.
 *
 * Pydantic AI provides structured, validated agent responses with
 * dependency injection, streaming, and multi-step tool use. Since
 * it's Python-native, this adapter wraps either:
 *   - A JS-compatible runner interface (for interop bridges)
 *   - An HTTP endpoint that fronts a Pydantic AI agent
 *
 * Usage:
 *   const adapter = new PydanticAIAdapter();
 *   adapter.registerAgent('data-analyst', {
 *     runner: myPydanticRunner,
 *     resultSchema: { type: 'object', properties: { answer: { type: 'string' } } },
 *   });
 *
 * @module PydanticAIAdapter
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

/** Pydantic AI run result */
export interface PydanticAIRunResult {
  /** Structured data output (validated against resultSchema) */
  data: unknown;
  /** Raw text output if available */
  text?: string;
  /** Tool calls made during execution */
  toolCalls?: Array<{ tool: string; args: Record<string, unknown>; result: unknown }>;
  /** Message history */
  messages?: Array<{ role: string; content: string }>;
  /** Token usage */
  usage?: { requestTokens: number; responseTokens: number; totalTokens: number };
  /** Whether validation succeeded */
  validated: boolean;
}

/**
 * Runner interface for a Pydantic AI agent.
 * Wraps `agent.run()` or an HTTP call to a Pydantic AI server.
 */
export interface PydanticAIRunner {
  run(
    prompt: string,
    deps?: Record<string, unknown>,
  ): Promise<PydanticAIRunResult>;
}

/**
 * HTTP-based runner configuration.
 * Sends POST requests to a Pydantic AI HTTP endpoint.
 */
export interface PydanticAIHttpConfig {
  /** Base URL of the Pydantic AI server */
  baseUrl: string;
  /** Auth header value (e.g. 'Bearer xxx') */
  authorization?: string;
  /** Additional headers */
  headers?: Record<string, string>;
}

/** Configuration for a registered Pydantic AI agent */
export interface PydanticAIAgentConfig {
  /** Direct runner instance */
  runner?: PydanticAIRunner;
  /** HTTP configuration (alternative to runner) */
  http?: PydanticAIHttpConfig;
  /** JSON schema for expected result structure */
  resultSchema?: Record<string, unknown>;
  /** Model name (for metadata) */
  model?: string;
  /** Dependencies to inject into each run */
  defaultDeps?: Record<string, unknown>;
  /** Per-invocation timeout in ms (default: 60000) */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Adapter for Pydantic AI structured agent framework.
 *
 * Supports both direct runners (for JS/Python bridges) and
 * HTTP endpoints (for remote Pydantic AI servers).
 */
export class PydanticAIAdapter extends BaseAdapter {
  readonly name = 'pydantic-ai';
  readonly version = '1.0.0';

  private agents = new Map<string, PydanticAIAgentConfig>();

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
   * Register a Pydantic AI agent (runner or HTTP-backed).
   */
  registerPydanticAgent(agentId: string, config: PydanticAIAgentConfig): void {
    if (!config.runner && !config.http) {
      throw new Error('PydanticAIAgentConfig requires either runner or http');
    }
    this.agents.set(agentId, config);
    this.registerLocalAgent({
      id: agentId,
      name: agentId,
      status: 'available',
      capabilities: ['structured-output', 'validation', 'tool-use'],
      metadata: {
        adapter: 'pydantic-ai',
        model: config.model,
        mode: config.runner ? 'direct' : 'http',
      },
    });
  }

  // -----------------------------------------------------------------------
  // Execution
  // -----------------------------------------------------------------------

  async executeAgent(agentId: string, payload: AgentPayload, _context: AgentContext): Promise<AgentResult> {
    this.ensureReady();

    const config = this.agents.get(agentId);
    if (!config) {
      return this.errorResult('PYDANTIC_AGENT_NOT_FOUND', `No agent registered as '${agentId}'`);
    }

    const prompt = payload.handoff?.instruction
      ?? (payload.params?.instruction as string)
      ?? (payload.params?.prompt as string)
      ?? payload.action;

    const deps: Record<string, unknown> = {
      ...config.defaultDeps,
      ...(payload.params as Record<string, unknown> | undefined),
      ...(payload.handoff?.context as Record<string, unknown> | undefined),
    };

    const timeoutMs = config.timeoutMs ?? 60_000;
    const start = Date.now();

    try {
      let result: PydanticAIRunResult;

      if (config.runner) {
        result = await Promise.race([
          config.runner.run(prompt, deps),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Pydantic AI execution timed out')), timeoutMs),
          ),
        ]);
      } else if (config.http) {
        result = await this.executeHttp(config.http, prompt, deps, timeoutMs);
      } else {
        return this.errorResult('PYDANTIC_NO_RUNNER', 'No runner or HTTP config available');
      }

      const durationMs = Date.now() - start;

      return this.successResult({
        data: result.data,
        text: result.text,
        validated: result.validated,
        toolCalls: result.toolCalls,
        usage: result.usage,
      }, durationMs);
    } catch (err) {
      return this.errorResult(
        'PYDANTIC_EXECUTION_FAILED',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // -----------------------------------------------------------------------
  // HTTP runner
  // -----------------------------------------------------------------------

  private async executeHttp(
    httpConfig: PydanticAIHttpConfig,
    prompt: string,
    deps: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<PydanticAIRunResult> {
    const url = `${httpConfig.baseUrl.replace(/\/$/, '')}/run`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...httpConfig.headers,
    };
    if (httpConfig.authorization) {
      headers['Authorization'] = httpConfig.authorization;
    }

    const body = JSON.stringify({ prompt, deps });

    // Use dynamic import for fetch (Node 18+) or global
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
      }

      const data = await response.json() as PydanticAIRunResult;
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async shutdown(): Promise<void> {
    this.agents.clear();
    await super.shutdown();
  }
}
