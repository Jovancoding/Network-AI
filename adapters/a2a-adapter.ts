/**
 * A2AAdapter — Agent-to-Agent (A2A) protocol adapter.
 *
 * Implements the Google A2A (Agent-to-Agent) open protocol that lets
 * independently hosted agents discover each other through a standard
 * Agent Card (/.well-known/agent.json) and exchange tasks via a
 * JSON-RPC envelope posted to the agent's task endpoint.
 *
 * References:
 *   https://google.github.io/A2A/
 *   https://github.com/google/A2A
 *
 * Usage:
 *
 *   const adapter = new A2AAdapter();
 *   await adapter.initialize({});
 *
 *   // Register a remote agent by its Agent Card URL
 *   await adapter.registerRemoteAgent('remote-analyst', 'https://agent.example.com');
 *
 *   // Or register a local agent that serves an A2A-compliant card
 *   adapter.registerLocalA2AAgent('local-writer', {
 *     name: 'Writing Agent',
 *     description: 'Draft documents given a topic',
 *     version: '1.0',
 *     capabilities: { streaming: false },
 *     taskEndpoint: 'https://writer.internal/tasks',
 *   });
 *
 *   await registry.addAdapter(adapter);
 *
 *   // In the orchestrator:
 *   delegateTask({ targetAgent: 'a2a:remote-analyst', ... })
 *
 * @module A2AAdapter
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

// ─── A2A spec types ───────────────────────────────────────────────────────────

/** Agent Card served at /.well-known/agent.json (A2A spec §3.1) */
export interface A2AAgentCard {
  /** Human-readable agent name */
  name: string;
  /** Purpose / capabilities in plain English */
  description?: string;
  /** SemVer */
  version?: string;
  /** Protocol capabilities declared by the agent */
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
  };
  /** URL that accepts A2A task envelopes (defaults to <baseUrl>/tasks) */
  taskEndpoint?: string;
  /** Agent homepage or further docs */
  url?: string;
}

/** JSON-RPC 2.0 task request envelope sent to the task endpoint (A2A spec §4) */
export interface A2ATask {
  jsonrpc: '2.0';
  id: string;
  method: 'tasks/send';
  params: {
    id: string;
    message: {
      role: 'user';
      parts: Array<{ type: 'text'; text: string }>;
    };
    metadata?: Record<string, unknown>;
  };
}

/** State of a running A2A task */
export type A2ATaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'canceled'
  | 'failed'
  | 'unknown';

/** Artifact produced by the agent (A2A spec §4.3) */
export interface A2AArtifact {
  name?: string;
  description?: string;
  parts: Array<{ type: string; text?: string; data?: unknown }>;
}

/** JSON-RPC 2.0 task response (A2A spec §4) */
export interface A2ATaskResponse {
  jsonrpc: '2.0';
  id: string;
  result?: {
    id: string;
    status: { state: A2ATaskState; message?: string };
    artifacts?: A2AArtifact[];
    metadata?: Record<string, unknown>;
  };
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** Internal config for a registered A2A agent */
interface A2AAgentConfig {
  baseUrl: string;
  card: A2AAgentCard;
  taskEndpoint: string;
  /** Optional bearer token included in Authorization header */
  bearerToken?: string;
  /** Request timeout in ms (default: 30 000) */
  timeoutMs?: number;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

/** Adapter configuration specific to A2A */
export interface A2AAdapterConfig extends AdapterConfig {
  /** Default bearer token applied to all agents unless overridden at agent level */
  defaultBearerToken?: string;
  /** Default timeout for all agents in ms (default: 30 000) */
  defaultTimeoutMs?: number;
  /** Custom fetch implementation (for testing / node compat) */
  fetchImpl?: typeof fetch;
}

export class A2AAdapter extends BaseAdapter {
  readonly name = 'a2a';
  readonly version = '1.0.0';

  private a2aAgents: Map<string, A2AAgentConfig> = new Map();
  private defaultBearerToken?: string;
  private defaultTimeoutMs = 30_000;
  private fetchImpl: typeof fetch = globalThis.fetch;

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

  async initialize(config: A2AAdapterConfig): Promise<void> {
    await super.initialize(config);
    if (config.defaultBearerToken) this.defaultBearerToken = config.defaultBearerToken;
    if (config.defaultTimeoutMs)   this.defaultTimeoutMs   = config.defaultTimeoutMs;
    if (config.fetchImpl)          this.fetchImpl           = config.fetchImpl;
  }

  // ── Registration ────────────────────────────────────────────────────────────

  /**
   * Fetch the Agent Card from `<baseUrl>/.well-known/agent.json` and register
   * the remote agent for use in the orchestrator.
   *
   * @param agentId  - Local identifier (used in `delegate_task` calls)
   * @param baseUrl  - Root URL of the remote A2A-compliant agent server
   * @param options  - Optional bearer token / timeout override
   */
  async registerRemoteAgent(
    agentId: string,
    baseUrl: string,
    options?: { bearerToken?: string; timeoutMs?: number },
  ): Promise<void> {
    const url = baseUrl.replace(/\/$/, '');
    const card = await this.fetchAgentCard(url, options?.bearerToken ?? this.defaultBearerToken);

    const taskEndpoint =
      card.taskEndpoint ??
      (card.url ? `${card.url.replace(/\/$/, '')}/tasks` : `${url}/tasks`);

    this.a2aAgents.set(agentId, {
      baseUrl: url,
      card,
      taskEndpoint,
      bearerToken: options?.bearerToken ?? this.defaultBearerToken,
      timeoutMs: options?.timeoutMs ?? this.defaultTimeoutMs,
    });

    this.registerLocalAgent({
      id: agentId,
      name: card.name,
      description: card.description ?? `Remote A2A agent at ${url}`,
      capabilities: card.capabilities
        ? Object.keys(card.capabilities).filter(k => (card.capabilities as Record<string,unknown>)[k] === true)
        : undefined,
      status: 'available',
      metadata: { a2aBaseUrl: url, taskEndpoint },
    });
  }

  /**
   * Register a local A2A agent whose card you already have (no network fetch).
   * Useful when the card is embedded in config or returned from another service.
   */
  registerLocalA2AAgent(
    agentId: string,
    card: A2AAgentCard & { taskEndpoint: string },
    options?: { bearerToken?: string; timeoutMs?: number },
  ): void {
    this.a2aAgents.set(agentId, {
      baseUrl: card.url ?? '',
      card,
      taskEndpoint: card.taskEndpoint,
      bearerToken: options?.bearerToken ?? this.defaultBearerToken,
      timeoutMs: options?.timeoutMs ?? this.defaultTimeoutMs,
    });

    this.registerLocalAgent({
      id: agentId,
      name: card.name,
      description: card.description ?? `Local A2A agent: ${agentId}`,
      capabilities: card.capabilities
        ? Object.keys(card.capabilities).filter(k => (card.capabilities as Record<string,unknown>)[k] === true)
        : undefined,
      status: 'available',
    });
  }

  // ── Execution ───────────────────────────────────────────────────────────────

  async executeAgent(
    agentId: string,
    payload: AgentPayload,
    context: AgentContext,
  ): Promise<AgentResult> {
    this.ensureReady();

    const config = this.a2aAgents.get(agentId);
    if (!config) {
      return this.errorResult(
        'AGENT_NOT_FOUND',
        `A2A agent "${agentId}" is not registered. Call registerRemoteAgent() or registerLocalA2AAgent() first.`,
        false,
      );
    }

    const startTime = Date.now();

    // Build the task instruction from the handoff payload
    const instruction =
      payload.handoff?.instruction ??
      (payload.params ? JSON.stringify(payload.params) : 'No instruction provided');

    const taskId = `${context.taskId ?? 'task'}-${Date.now()}`;

    const taskEnvelope: A2ATask = {
      jsonrpc: '2.0',
      id: taskId,
      method: 'tasks/send',
      params: {
        id: taskId,
        message: {
          role: 'user',
          parts: [{ type: 'text', text: instruction }],
        },
        metadata: {
          sourceAgent: context.agentId,
          sessionId: context.sessionId,
          ...(payload.handoff?.context ?? {}),
        },
      },
    };

    try {
      const response = await this.sendTask(config, taskEnvelope);

      if (response.error) {
        return this.errorResult(
          `A2A_ERROR_${response.error.code}`,
          response.error.message,
          response.error.code >= 500,
          response.error,
        );
      }

      if (!response.result) {
        return this.errorResult('A2A_EMPTY_RESPONSE', 'A2A response had no result field', true);
      }

      const state = response.result.status.state;
      if (state === 'failed' || state === 'canceled') {
        return this.errorResult(
          `A2A_TASK_${state.toUpperCase()}`,
          response.result.status.message ?? `Task ended with state: ${state}`,
          state === 'failed',
        );
      }

      // Extract text from artifacts
      const output = this.extractOutput(response.result.artifacts);

      return this.successResult(
        { output, state, artifacts: response.result.artifacts, metadata: response.result.metadata },
        Date.now() - startTime,
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return this.errorResult('A2A_TIMEOUT', `A2A request timed out after ${config.timeoutMs}ms`, true);
      }
      return this.errorResult(
        'A2A_REQUEST_FAILED',
        err instanceof Error ? err.message : 'A2A request failed',
        true,
        err,
      );
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async fetchAgentCard(baseUrl: string, bearerToken?: string): Promise<A2AAgentCard> {
    const cardUrl = `${baseUrl}/.well-known/agent.json`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), this.defaultTimeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(cardUrl, { headers, signal: controller.signal });
    } finally {
      clearTimeout(id);
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch agent card from ${cardUrl}: HTTP ${response.status}`);
    }

    const card = await response.json() as A2AAgentCard;
    if (!card.name) {
      throw new Error(`Agent card at ${cardUrl} is missing required "name" field`);
    }
    return card;
  }

  private async sendTask(
    config: A2AAgentConfig,
    task: A2ATask,
  ): Promise<A2ATaskResponse> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (config.bearerToken) headers.Authorization = `Bearer ${config.bearerToken}`;

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), config.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(config.taskEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(task),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(id);
    }

    if (!response.ok) {
      throw new Error(`A2A task endpoint returned HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json() as Promise<A2ATaskResponse>;
  }

  private extractOutput(artifacts?: A2AArtifact[]): string {
    if (!artifacts?.length) return '';
    return artifacts
      .flatMap(a => a.parts)
      .filter(p => p.type === 'text' && typeof p.text === 'string')
      .map(p => p.text as string)
      .join('\n');
  }
}
