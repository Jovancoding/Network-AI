/**
 * OpenAI Responses Adapter
 *
 * Integrates the OpenAI Responses API (the successor to Chat Completions and
 * the deprecated Assistants API) with the SwarmOrchestrator. Supports GPT-4.1 /
 * GPT-5.x class models, reasoning-effort control, and instructions.
 *
 * The Assistants API is scheduled for sunset — this adapter is the migration
 * path: agents registered here run against `POST /v1/responses`.
 *
 * Usage — built-in fetch:
 *   const adapter = new OpenAIResponsesAdapter();
 *   adapter.registerAgent('writer', {
 *     model: 'gpt-5.2',
 *     apiKey: process.env.OPENAI_API_KEY,
 *     instructions: 'You are a concise technical writer.',
 *   });
 *
 * Usage — bring-your-own client (official openai SDK):
 *   import OpenAI from 'openai';
 *   const openai = new OpenAI();
 *   adapter.registerAgent('reasoner', {
 *     model: 'o4-mini',
 *     reasoningEffort: 'high',
 *     client: { create: (params) => openai.responses.create(params) },
 *   });
 *
 * @module OpenAIResponsesAdapter
 * @version 1.0.0
 */

import { BaseAdapter } from './base-adapter';
import type {
  AdapterCapabilities,
  AgentPayload,
  AgentContext,
  AgentResult,
} from '../types/agent-adapter';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One output item from a Responses API result */
export interface ResponsesOutputItem {
  type: string;
  content?: Array<{ type: string; text?: string }>;
}

/** Response shape returned by the Responses API */
export interface ResponsesApiResult {
  /** SDK convenience accessor — full concatenated output text */
  output_text?: string;
  output?: ResponsesOutputItem[];
  status?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Minimal interface for an OpenAI Responses client. Matches the official
 * `openai` SDK's `responses.create` signature; users supply their own SDK
 * instance — no hard dependency (BYOC).
 */
export interface OpenAIResponsesClient {
  create(params: {
    model: string;
    input: string;
    instructions?: string;
    max_output_tokens?: number;
    temperature?: number;
    reasoning?: { effort?: string };
  }): Promise<ResponsesApiResult>;
}

/** Reasoning effort levels supported by reasoning-capable models */
export type ResponsesReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

/** Configuration for a registered OpenAI Responses agent */
export interface OpenAIResponsesAgentConfig {
  /** Model name — e.g. 'gpt-5.2', 'gpt-4.1', 'o4-mini' (default: 'gpt-4.1') */
  model?: string;
  /** OpenAI API key — falls back to OPENAI_API_KEY env var */
  apiKey?: string;
  /** Base URL override (default: 'https://api.openai.com/v1') */
  baseUrl?: string;
  /** System-level instructions sent with every request */
  instructions?: string;
  /** Maximum output tokens */
  maxOutputTokens?: number;
  /** Temperature */
  temperature?: number;
  /** Reasoning effort for reasoning-capable models (o-series, gpt-5.x) */
  reasoningEffort?: ResponsesReasoningEffort;
  /**
   * Bring-your-own OpenAI SDK responses instance. If supplied,
   * apiKey / baseUrl are ignored and this client is used directly.
   */
  client?: OpenAIResponsesClient;
  /** Additional headers to send with fetch-based requests */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds (default: 120000) */
  timeout?: number;
}

/** Internal entry stored per registered agent */
interface ResponsesAgentEntry {
  config: OpenAIResponsesAgentConfig;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the input string from an AgentPayload */
function buildInput(payload: AgentPayload): string {
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
function resolveApiKey(config: OpenAIResponsesAgentConfig): string {
  return config.apiKey ?? process.env['OPENAI_API_KEY'] ?? '';
}

/** Extract the output text from a Responses API result */
function extractOutputText(resp: ResponsesApiResult): string {
  if (typeof resp.output_text === 'string' && resp.output_text.length > 0) {
    return resp.output_text;
  }
  const items = resp.output ?? [];
  const chunks: string[] = [];
  for (const item of items) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === 'output_text' && typeof c.text === 'string') chunks.push(c.text);
      }
    }
  }
  return chunks.join('');
}

// ---------------------------------------------------------------------------
// OpenAIResponsesAdapter
// ---------------------------------------------------------------------------

/**
 * Adapter that connects OpenAI models to the SwarmOrchestrator via the
 * Responses API. BYOC: supply an `openai` SDK responses instance, or let the
 * adapter call the REST API directly with an `OPENAI_API_KEY`.
 */
export class OpenAIResponsesAdapter extends BaseAdapter {
  readonly name = 'openai-responses';
  readonly version = '1.0.0';

  private agents: Map<string, ResponsesAgentEntry> = new Map();

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
   * Register an OpenAI Responses-powered agent.
   *
   * @param agentId   Unique identifier used in `delegateTask` calls.
   * @param config    Agent configuration.
   */
  registerAgent(agentId: string, config: OpenAIResponsesAgentConfig = {}): void {
    if (!agentId || typeof agentId !== 'string' || agentId.trim() === '') {
      throw new Error('OpenAIResponsesAdapter: agentId must be a non-empty string');
    }
    if (!this.ready) {
      this.ready = true;
    }

    this.agents.set(agentId, { config });
    this.registeredAgents.set(agentId, {
      id: agentId,
      name: agentId,
      description: `OpenAI Responses agent (model: ${config.model ?? 'gpt-4.1'})`,
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
      throw new Error('OpenAIResponsesAdapter: adapter not initialized. Call initialize() first.');
    }

    const entry = this.agents.get(agentId);
    if (!entry) {
      return {
        success: false,
        error: {
          code: 'AGENT_NOT_FOUND',
          message: `OpenAIResponsesAdapter: no agent registered with id "${agentId}"`,
          recoverable: false,
        },
        metadata: { adapter: this.name },
      };
    }

    const cfg = entry.config;

    try {
      const { output, usage } = await this._createResponse(cfg, payload);

      return {
        success: true,
        data: { output, model: cfg.model ?? 'gpt-4.1' },
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

  async shutdown(): Promise<void> {
    this.agents.clear();
    await super.shutdown();
  }

  // -------------------------------------------------------------------------
  // Private execution
  // -------------------------------------------------------------------------

  private async _createResponse(
    cfg: OpenAIResponsesAgentConfig,
    payload: AgentPayload
  ): Promise<{ output: string; usage?: Record<string, number> }> {
    const input = buildInput(payload);
    const model = cfg.model ?? 'gpt-4.1';

    const params: Parameters<OpenAIResponsesClient['create']>[0] = {
      model,
      input,
      ...(cfg.instructions ? { instructions: cfg.instructions } : {}),
      ...(cfg.maxOutputTokens != null ? { max_output_tokens: cfg.maxOutputTokens } : {}),
      ...(cfg.temperature != null ? { temperature: cfg.temperature } : {}),
      ...(cfg.reasoningEffort ? { reasoning: { effort: cfg.reasoningEffort } } : {}),
    };

    // Bring-your-own SDK client
    if (cfg.client) {
      const resp = await cfg.client.create(params);
      return {
        output: extractOutputText(resp),
        usage: resp.usage as Record<string, number> | undefined,
      };
    }

    // Built-in fetch path
    const apiKey = resolveApiKey(cfg);
    if (!apiKey) {
      throw new Error(
        'OpenAIResponsesAdapter: no API key provided. Set apiKey in config or OPENAI_API_KEY env var.'
      );
    }

    const base = (cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    const url = `${base}/responses`;

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
        body: JSON.stringify(params),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(
        `OpenAIResponsesAdapter: HTTP ${resp.status} from OpenAI API — ${text.slice(0, 200)}`
      );
    }

    const json = await resp.json() as ResponsesApiResult;
    return { output: extractOutputText(json), usage: json.usage as Record<string, number> | undefined };
  }
}
