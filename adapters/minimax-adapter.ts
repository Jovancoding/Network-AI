/**
 * MiniMax Adapter
 *
 * Integrates MiniMax LLM API (OpenAI-compatible chat completions) with
 * the SwarmOrchestrator. Supports MiniMax-M2.5 and MiniMax-M2.5-highspeed
 * models with 204K context window.
 *
 * Usage — built-in fetch:
 *   const adapter = new MiniMaxAdapter();
 *   adapter.registerAgent('analyst', {
 *     model: 'MiniMax-M2.5',
 *     apiKey: process.env.MINIMAX_API_KEY,
 *     systemPrompt: 'You are an expert analyst.',
 *   });
 *
 * Usage — bring-your-own client (any OpenAI-compatible SDK):
 *   adapter.registerAgent('fast', {
 *     model: 'MiniMax-M2.5-highspeed',
 *     client: openaiCompatibleInstance.chat.completions,
 *   });
 *
 * @module MiniMaxAdapter
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
 * Minimal interface for an OpenAI-compatible chat completions client.
 * Users supply their own SDK instance; no hard dependency.
 */
export interface MiniMaxChatClient {
  create(params: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    max_tokens?: number;
    temperature?: number;
    stop?: string[];
  }): Promise<{
    choices: Array<{ message?: { content?: string | null }; text?: string }>;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  }>;
}

/** Configuration for a registered MiniMax agent */
export interface MiniMaxAgentConfig {
  /** Model name — e.g. 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed' */
  model?: string;
  /** MiniMax API key — falls back to MINIMAX_API_KEY env var */
  apiKey?: string;
  /** Base URL override (default: 'https://api.minimax.io/v1') */
  baseUrl?: string;
  /** System-level prompt prepended to every request */
  systemPrompt?: string;
  /** Maximum tokens in the completion */
  maxTokens?: number;
  /** Temperature — must be in (0.0, 1.0]. MiniMax rejects 0. Default: 0.7 */
  temperature?: number;
  /** Stop sequences */
  stop?: string[];
  /**
   * Bring-your-own OpenAI-compatible chat completions instance.
   * If supplied, apiKey / baseUrl are ignored and this client is used directly.
   */
  client?: MiniMaxChatClient;
  /** Additional headers to send with fetch-based requests */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds (default: 120000) */
  timeout?: number;
}

/** Internal entry stored per registered agent */
interface MiniMaxAgentEntry {
  config: MiniMaxAgentConfig;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the prompt string from an AgentPayload */
function buildPrompt(payload: AgentPayload): string {
  const parts: string[] = [];

  const instruction = payload.handoff?.instruction;
  if (instruction) parts.push(instruction);

  if (payload.action) parts.push(`Task: ${payload.action}`);

  if (payload.params && Object.keys(payload.params).length > 0) {
    parts.push(`Parameters: ${JSON.stringify(payload.params, null, 2)}`);
  }

  if (payload.blackboardSnapshot && Object.keys(payload.blackboardSnapshot).length > 0) {
    const relevant = Object.entries(payload.blackboardSnapshot)
      .slice(0, 10)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join('\n');
    parts.push(`Context from blackboard:\n${relevant}`);
  }

  return parts.join('\n\n') || 'Complete the task.';
}

/** Resolve API key — config first, then env */
function resolveApiKey(config: MiniMaxAgentConfig): string {
  return config.apiKey ?? process.env['MINIMAX_API_KEY'] ?? '';
}

/**
 * Clamp temperature to MiniMax's valid range (0.0, 1.0].
 * MiniMax rejects exactly 0, so we use a small epsilon.
 */
function clampTemperature(temp: number | undefined): number {
  const t = temp ?? 0.7;
  if (t <= 0) return 0.01;
  if (t > 1) return 1.0;
  return t;
}

// ---------------------------------------------------------------------------
// MiniMaxAdapter
// ---------------------------------------------------------------------------

/**
 * Adapter that connects MiniMax LLM models to the SwarmOrchestrator.
 * Uses MiniMax's OpenAI-compatible chat completions API.
 *
 * Available models:
 * - MiniMax-M2.5 — flagship model with 204K context
 * - MiniMax-M2.5-highspeed — faster variant optimised for throughput
 */
export class MiniMaxAdapter extends BaseAdapter {
  readonly name = 'minimax';
  readonly version = '1.0.0';

  private agents: Map<string, MiniMaxAgentEntry> = new Map();

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

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Register a MiniMax-powered agent.
   *
   * @param agentId   Unique identifier used in `delegateTask` calls.
   * @param config    MiniMax agent configuration.
   */
  registerAgent(agentId: string, config: MiniMaxAgentConfig = {}): void {
    if (!this.ready) {
      this.ready = true;
    }

    this.agents.set(agentId, { config });
    this.registeredAgents.set(agentId, {
      id: agentId,
      name: agentId,
      description: `MiniMax agent (model: ${config.model ?? 'MiniMax-M2.5'})`,
      capabilities: ['chat', 'analysis', 'code-generation', 'reasoning'],
      adapter: this.name,
      status: 'available',
    });
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  async executeAgent(
    agentId: string,
    payload: AgentPayload,
    context: AgentContext
  ): Promise<AgentResult> {
    if (!this.ready) {
      throw new Error('MiniMaxAdapter: adapter not initialized. Call initialize() first.');
    }

    const entry = this.agents.get(agentId);
    if (!entry) {
      return {
        success: false,
        error: {
          code: 'AGENT_NOT_FOUND',
          message: `MiniMaxAdapter: no agent registered with id "${agentId}"`,
          recoverable: false,
        },
        metadata: { adapter: this.name },
      };
    }

    const cfg = entry.config;

    try {
      const { output, usage } = await this._executeChat(cfg, payload);

      return {
        success: true,
        data: { output, model: cfg.model ?? 'MiniMax-M2.5' },
        metadata: {
          adapter: this.name,
          trace: {
            taskId: context.taskId,
            ...(usage ? { usage } : {}),
          },
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: {
          code: 'EXECUTION_ERROR',
          message,
          recoverable: true,
        },
        metadata: { adapter: this.name },
      };
    }
  }

  // -------------------------------------------------------------------------
  // Private execution
  // -------------------------------------------------------------------------

  private async _executeChat(
    cfg: MiniMaxAgentConfig,
    payload: AgentPayload
  ): Promise<{ output: string; usage?: Record<string, number> }> {
    const prompt = buildPrompt(payload);
    const model = cfg.model ?? 'MiniMax-M2.5';
    const temperature = clampTemperature(cfg.temperature);

    // Bring-your-own SDK client
    if (cfg.client) {
      const messages: Array<{ role: string; content: string }> = [];
      if (cfg.systemPrompt) messages.push({ role: 'system', content: cfg.systemPrompt });
      messages.push({ role: 'user', content: prompt });

      const resp = await cfg.client.create({
        model,
        messages,
        max_tokens: cfg.maxTokens,
        temperature,
        stop: cfg.stop,
      });

      const output = resp.choices[0]?.message?.content ?? resp.choices[0]?.text ?? '';
      return { output, usage: resp.usage as Record<string, number> | undefined };
    }

    // Built-in fetch path
    const apiKey = resolveApiKey(cfg);
    if (!apiKey) {
      throw new Error(
        'MiniMaxAdapter: no API key provided. Set apiKey in config or MINIMAX_API_KEY env var.'
      );
    }

    const base = (cfg.baseUrl ?? 'https://api.minimax.io/v1').replace(/\/+$/, '');
    const url = `${base}/chat/completions`;

    const messages: Array<{ role: string; content: string }> = [];
    if (cfg.systemPrompt) messages.push({ role: 'system', content: cfg.systemPrompt });
    messages.push({ role: 'user', content: prompt });

    const body = {
      model,
      messages,
      ...(cfg.maxTokens != null ? { max_tokens: cfg.maxTokens } : {}),
      temperature,
      ...(cfg.stop ? { stop: cfg.stop } : {}),
    };

    const timeoutMs = cfg.timeout ?? 120_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          ...cfg.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`MiniMaxAdapter: HTTP ${resp.status} from MiniMax API — ${text.slice(0, 200)}`);
    }

    const json = await resp.json() as {
      choices: Array<{ message?: { content?: string | null } }>;
      usage?: Record<string, number>;
    };

    const output = json.choices[0]?.message?.content ?? '';
    return { output, usage: json.usage };
  }
}
