/**
 * RLM Adapter — Recursive Language Model integration
 *
 * Connects the SwarmOrchestrator to any RLM-compatible HTTP endpoint
 * (see arxiv 2512.24601 / alexzhang13/rlm). BYOC — bring your own client.
 *
 * The adapter serialises each `AgentPayload` into a prompt string and POST it
 * to `<endpoint>/completion`. The server responds with a JSON body whose
 * `text` (or `content`) field becomes the agent result data.
 *
 * Usage:
 * ```typescript
 * const adapter = new RLMAdapter();
 * adapter.registerAgent('rlm-planner', {
 *   endpoint: 'http://localhost:8080',
 *   model: 'rlm-7b',
 *   maxDepth: 3,
 * });
 * await adapter.initialize({});
 * const result = await adapter.executeAgent('rlm-planner', payload, ctx);
 * ```
 *
 * @module RLMAdapter
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
 * Minimal interface for a BYOC HTTP client capable of sending a JSON POST.
 * Pass any client that implements this — no hard dependency on any HTTP lib.
 */
export interface RLMHttpClient {
  post(
    url: string,
    body: Record<string, unknown>,
    options?: { headers?: Record<string, string>; timeoutMs?: number },
  ): Promise<Record<string, unknown>>;
}

/**
 * Configuration for a registered RLM agent.
 */
export interface RLMAgentConfig {
  /**
   * Base URL of the RLM HTTP server.
   * Example: `'http://localhost:8080'`
   */
  endpoint: string;

  /**
   * Model identifier forwarded to the RLM server.
   * Default: `'rlm-default'`
   */
  model?: string;

  /**
   * Maximum recursion depth the RLM server should apply.
   * Forwarded as `max_depth` in the request body.
   * Default: `1` (no sub-calls).
   */
  maxDepth?: number;

  /**
   * Request timeout in milliseconds.
   * Default: `60 000` (60 s).
   */
  timeoutMs?: number;

  /**
   * Optional system prompt prepended before the serialised payload.
   */
  systemPrompt?: string;

  /**
   * Additional headers forwarded with every request (e.g. `Authorization`).
   */
  headers?: Record<string, string>;

  /**
   * Bring-your-own HTTP client.
   * When provided the adapter delegates all HTTP to this client instead of
   * using the built-in `fetch`-based transport.
   */
  client?: RLMHttpClient;
}

/** @internal */
interface StoredAgent {
  config: RLMAgentConfig;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Adapter for RLM-compatible recursive language-model servers.
 */
export class RLMAdapter extends BaseAdapter {
  readonly name = 'rlm';
  readonly version = '1.0.0';

  private agentConfigs = new Map<string, StoredAgent>();

  get capabilities(): AdapterCapabilities {
    return {
      streaming: false,
      parallel: true,
      bidirectional: false,
      discovery: false,
      authentication: false,
      statefulSessions: false,
    };
  }

  async initialize(config: AdapterConfig): Promise<void> {
    await super.initialize(config);
  }

  /**
   * Register an agent backed by an RLM endpoint.
   *
   * @param agentId Unique agent identifier used when calling `executeAgent`.
   * @param config  Per-agent RLM configuration.
   */
  registerAgent(agentId: string, config: RLMAgentConfig): void {
    if (!agentId || typeof agentId !== 'string') {
      throw new TypeError('RLMAdapter.registerAgent: agentId must be a non-empty string');
    }
    if (!config.endpoint || typeof config.endpoint !== 'string') {
      throw new TypeError('RLMAdapter.registerAgent: config.endpoint must be a non-empty string');
    }
    this.agentConfigs.set(agentId, { config });
    this.registerLocalAgent({
      id: agentId,
      name: agentId,
      description: `RLM agent at ${config.endpoint}`,
      capabilities: ['completion'],
      status: 'available',
    });
  }

  async executeAgent(
    agentId: string,
    payload: AgentPayload,
    context: AgentContext,
  ): Promise<AgentResult> {
    this.ensureReady();

    const stored = this.agentConfigs.get(agentId);
    if (!stored) {
      return this.errorResult(
        'AGENT_NOT_FOUND',
        `RLMAdapter: no agent registered with id "${agentId}"`,
        false,
      );
    }

    const { config } = stored;
    const startMs = Date.now();

    try {
      const prompt = this._buildPrompt(config.systemPrompt, payload);
      const requestBody: Record<string, unknown> = {
        prompt,
        model: config.model ?? 'rlm-default',
        max_depth: config.maxDepth ?? 1,
        agent_id: agentId,
        task_id: context.taskId,
        session_id: context.sessionId,
        metadata: context.metadata,
      };

      const responseBody = await this._post(config, `${config.endpoint}/completion`, requestBody);

      const text =
        typeof responseBody['text'] === 'string'
          ? responseBody['text']
          : typeof responseBody['content'] === 'string'
          ? responseBody['content']
          : JSON.stringify(responseBody);

      return this.successResult(
        { text, raw: responseBody },
        Date.now() - startMs,
      );
    } catch (err) {
      return this.errorResult(
        'RLM_REQUEST_FAILED',
        err instanceof Error ? err.message : String(err),
        true,
        err,
      );
    }
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /** Build a plain-text prompt from the agent config + payload. */
  private _buildPrompt(systemPrompt: string | undefined, payload: AgentPayload): string {
    const parts: string[] = [];
    if (systemPrompt) parts.push(systemPrompt);
    parts.push(`Action: ${payload.action}`);
    if (payload.params && Object.keys(payload.params).length > 0) {
      try {
        parts.push(`Params: ${JSON.stringify(payload.params)}`);
      } catch {
        parts.push('Params: [unserializable]');
      }
    }
    if (payload.handoff) {
      parts.push(`Instruction: ${payload.handoff.instruction ?? ''}`);
    }
    return parts.join('\n');
  }

  /**
   * Send a POST request using the BYOC client when provided,
   * otherwise fall back to the built-in `fetch`-based transport.
   */
  private async _post(
    config: RLMAgentConfig,
    url: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const timeoutMs = config.timeoutMs ?? 60_000;

    if (config.client) {
      const result = await config.client.post(url, body, {
        headers: config.headers,
        timeoutMs,
      });
      return result;
    }

    // Built-in fetch transport with timeout via AbortController
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(config.headers ?? {}),
      };

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`RLM HTTP ${response.status}: ${response.statusText}`);
      }

      const json = await response.json() as Record<string, unknown>;
      return json;
    } finally {
      clearTimeout(timer);
    }
  }
}
