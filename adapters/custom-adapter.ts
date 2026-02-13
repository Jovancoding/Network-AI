/**
 * Custom Agent Adapter -- The simplest way to plug in any agent
 * 
 * For agent systems that don't have a dedicated adapter, or for
 * quick prototyping, this adapter lets you register plain async functions
 * as agents. No framework dependency needed.
 * 
 * Usage:
 *   const adapter = new CustomAdapter();
 * 
 *   // Register any async function as an agent
 *   adapter.registerHandler("my-agent", async (payload, context) => {
 *     // Your agent logic here
 *     return { analysis: "result data" };
 *   });
 * 
 *   // Register an HTTP-based agent
 *   adapter.registerHttpAgent("remote-agent", "https://api.example.com/agent");
 * 
 *   await registry.addAdapter(adapter);
 * 
 * Then in the orchestrator:
 *   delegateTask({ targetAgent: "custom:my-agent", ... })
 * 
 * @module CustomAdapter
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
 * A simple agent handler function.
 * Takes the task payload and context, returns any result.
 */
export type AgentHandler = (
  payload: AgentPayload,
  context: AgentContext
) => Promise<unknown>;

/**
 * HTTP agent configuration
 */
export interface HttpAgentConfig {
  url: string;
  method?: 'POST' | 'PUT';
  headers?: Record<string, string>;
  timeout?: number;
  /** Transform the payload before sending */
  transformRequest?: (payload: AgentPayload, context: AgentContext) => unknown;
  /** Transform the response before returning */
  transformResponse?: (response: unknown) => unknown;
}

export class CustomAdapter extends BaseAdapter {
  readonly name = 'custom';
  readonly version = '1.0.0';
  private handlers: Map<string, AgentHandler> = new Map();
  private httpAgents: Map<string, HttpAgentConfig> = new Map();

  get capabilities(): AdapterCapabilities {
    return {
      streaming: false,
      parallel: true,
      bidirectional: false,
      discovery: true,
      authentication: false,
      statefulSessions: false,
    };
  }

  /**
   * Register a plain async function as an agent.
   * This is the simplest way to add custom agent logic.
   */
  registerHandler(
    agentId: string,
    handler: AgentHandler,
    metadata?: { description?: string; capabilities?: string[] }
  ): void {
    this.handlers.set(agentId, handler);
    this.registerLocalAgent({
      id: agentId,
      name: agentId,
      description: metadata?.description ?? `Custom agent: ${agentId}`,
      capabilities: metadata?.capabilities,
      status: 'available',
    });
  }

  /**
   * Register an HTTP endpoint as an agent.
   * The orchestrator will POST task payloads to the URL.
   */
  registerHttpAgent(
    agentId: string,
    urlOrConfig: string | HttpAgentConfig,
    metadata?: { description?: string; capabilities?: string[] }
  ): void {
    const config: HttpAgentConfig = typeof urlOrConfig === 'string'
      ? { url: urlOrConfig }
      : urlOrConfig;

    this.httpAgents.set(agentId, config);
    this.registerLocalAgent({
      id: agentId,
      name: agentId,
      description: metadata?.description ?? `HTTP agent at ${config.url}`,
      capabilities: metadata?.capabilities,
      status: 'available',
      metadata: { url: config.url },
    });
  }

  async executeAgent(
    agentId: string,
    payload: AgentPayload,
    context: AgentContext
  ): Promise<AgentResult> {
    this.ensureReady();

    const startTime = Date.now();

    // Check local handlers first
    const handler = this.handlers.get(agentId);
    if (handler) {
      return this.executeHandler(handler, payload, context, startTime);
    }

    // Check HTTP agents
    const httpConfig = this.httpAgents.get(agentId);
    if (httpConfig) {
      return this.executeHttpAgent(httpConfig, payload, context, startTime);
    }

    return this.errorResult(
      'AGENT_NOT_FOUND',
      `Custom agent "${agentId}" is not registered. Use registerHandler() or registerHttpAgent().`,
      false
    );
  }

  private async executeHandler(
    handler: AgentHandler,
    payload: AgentPayload,
    context: AgentContext,
    startTime: number
  ): Promise<AgentResult> {
    try {
      const result = await handler(payload, context);
      return this.successResult(result, Date.now() - startTime);
    } catch (error) {
      return this.errorResult(
        'HANDLER_ERROR',
        error instanceof Error ? error.message : 'Custom handler failed',
        true,
        error
      );
    }
  }

  private async executeHttpAgent(
    config: HttpAgentConfig,
    payload: AgentPayload,
    context: AgentContext,
    startTime: number
  ): Promise<AgentResult> {
    try {
      const body = config.transformRequest
        ? config.transformRequest(payload, context)
        : { payload, context };

      const controller = new AbortController();
      const timeoutId = config.timeout
        ? setTimeout(() => controller.abort(), config.timeout)
        : null;

      const response = await fetch(config.url, {
        method: config.method ?? 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...config.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (timeoutId) clearTimeout(timeoutId);

      if (!response.ok) {
        return this.errorResult(
          'HTTP_ERROR',
          `HTTP ${response.status}: ${response.statusText}`,
          response.status >= 500 // Server errors are recoverable
        );
      }

      let result = await response.json();

      if (config.transformResponse) {
        result = config.transformResponse(result);
      }

      return this.successResult(result, Date.now() - startTime);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return this.errorResult('TIMEOUT', `HTTP agent timed out after ${config.timeout}ms`, true);
      }
      return this.errorResult(
        'HTTP_ERROR',
        error instanceof Error ? error.message : 'HTTP agent call failed',
        true,
        error
      );
    }
  }
}
