/**
 * Gemini Adapter
 *
 * Integrates the Google Gemini Developer API (Google AI Studio /
 * generativelanguage.googleapis.com) with the SwarmOrchestrator. This is the
 * consumer-facing Gemini path — for Gemini on Google Cloud (Vertex AI) use
 * `VertexAIAdapter` instead.
 *
 * Supports Gemini 2.x / 2.5 models with system instructions, generation
 * config (temperature, max output tokens), and thinking budgets.
 *
 * Usage — built-in fetch (Gemini Developer API):
 *   const adapter = new GeminiAdapter();
 *   adapter.registerAgent('researcher', {
 *     model: 'gemini-2.5-flash',
 *     apiKey: process.env.GEMINI_API_KEY,
 *     systemPrompt: 'You are a meticulous researcher.',
 *   });
 *
 * Usage — bring-your-own client (@google/genai or compatible):
 *   import { GoogleGenAI } from '@google/genai';
 *   const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
 *   adapter.registerAgent('pro', {
 *     model: 'gemini-2.5-pro',
 *     client: { generateContent: (params) => genai.models.generateContent(params) },
 *   });
 *
 * @module GeminiAdapter
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

/** A single content part in a Gemini request/response */
export interface GeminiContentPart {
  text?: string;
  /** Inline binary data (images, etc.) — base64 + mime type */
  inlineData?: { mimeType: string; data: string };
}

/** A content turn (role + parts) in a Gemini conversation */
export interface GeminiContent {
  role?: 'user' | 'model';
  parts: GeminiContentPart[];
}

/** Response shape returned by generateContent (SDK and REST are compatible) */
export interface GeminiGenerateResponse {
  /** SDK convenience accessor — full concatenated text, when available */
  text?: string;
  candidates?: Array<{
    content?: GeminiContent;
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

/**
 * Minimal interface for a Gemini generateContent client. Matches the
 * `@google/genai` SDK's `models.generateContent` signature; users supply
 * their own SDK instance — no hard dependency (BYOC).
 */
export interface GeminiGenerateClient {
  generateContent(params: {
    model: string;
    contents: GeminiContent[] | string;
    config?: Record<string, unknown>;
  }): Promise<GeminiGenerateResponse>;
}

/** Configuration for a registered Gemini agent */
export interface GeminiAgentConfig {
  /** Model name — e.g. 'gemini-2.5-flash', 'gemini-2.5-pro' (default: 'gemini-2.5-flash') */
  model?: string;
  /** Gemini API key — falls back to GEMINI_API_KEY env var */
  apiKey?: string;
  /** Base URL override (default: 'https://generativelanguage.googleapis.com/v1beta') */
  baseUrl?: string;
  /** System instruction prepended to every request */
  systemPrompt?: string;
  /** Maximum output tokens */
  maxOutputTokens?: number;
  /** Temperature (0.0 – 2.0 for Gemini). Default: model default */
  temperature?: number;
  /**
   * Thinking budget in tokens for thinking-capable models
   * (e.g. gemini-2.5-*). 0 disables thinking; omit for model default.
   */
  thinkingBudget?: number;
  /**
   * Bring-your-own `@google/genai`-compatible client. If supplied,
   * apiKey / baseUrl are ignored and this client is used directly.
   */
  client?: GeminiGenerateClient;
  /** Additional headers to send with fetch-based requests */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds (default: 120000) */
  timeout?: number;
}

/** Internal entry stored per registered agent */
interface GeminiAgentEntry {
  config: GeminiAgentConfig;
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
function resolveApiKey(config: GeminiAgentConfig): string {
  return config.apiKey ?? process.env['GEMINI_API_KEY'] ?? '';
}

/** Extract the response text from a GeminiGenerateResponse (SDK or REST shape) */
function extractText(resp: GeminiGenerateResponse): string {
  if (typeof resp.text === 'string' && resp.text.length > 0) return resp.text;
  const parts = resp.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? '').join('');
}

// ---------------------------------------------------------------------------
// GeminiAdapter
// ---------------------------------------------------------------------------

/**
 * Adapter that connects Google Gemini models (Gemini Developer API) to the
 * SwarmOrchestrator. BYOC: supply a `@google/genai`-compatible client, or
 * let the adapter call the REST API directly with a `GEMINI_API_KEY`.
 */
export class GeminiAdapter extends BaseAdapter {
  readonly name = 'gemini';
  readonly version = '1.0.0';

  private agents: Map<string, GeminiAgentEntry> = new Map();

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
   * Register a Gemini-powered agent.
   *
   * @param agentId   Unique identifier used in `delegateTask` calls.
   * @param config    Gemini agent configuration.
   */
  registerAgent(agentId: string, config: GeminiAgentConfig = {}): void {
    if (!agentId || typeof agentId !== 'string' || agentId.trim() === '') {
      throw new Error('GeminiAdapter: agentId must be a non-empty string');
    }
    if (!this.ready) {
      this.ready = true;
    }

    this.agents.set(agentId, { config });
    this.registeredAgents.set(agentId, {
      id: agentId,
      name: agentId,
      description: `Gemini agent (model: ${config.model ?? 'gemini-2.5-flash'})`,
      capabilities: ['chat', 'analysis', 'code-generation', 'reasoning', 'multi-modal'],
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
      throw new Error('GeminiAdapter: adapter not initialized. Call initialize() first.');
    }

    const entry = this.agents.get(agentId);
    if (!entry) {
      return {
        success: false,
        error: {
          code: 'AGENT_NOT_FOUND',
          message: `GeminiAdapter: no agent registered with id "${agentId}"`,
          recoverable: false,
        },
        metadata: { adapter: this.name },
      };
    }

    const cfg = entry.config;

    try {
      const { output, usage } = await this._generate(cfg, payload);

      return {
        success: true,
        data: { output, model: cfg.model ?? 'gemini-2.5-flash' },
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

  private async _generate(
    cfg: GeminiAgentConfig,
    payload: AgentPayload
  ): Promise<{ output: string; usage?: Record<string, number> }> {
    const prompt = buildPrompt(payload);
    const model = cfg.model ?? 'gemini-2.5-flash';

    const generationConfig: Record<string, unknown> = {};
    if (cfg.maxOutputTokens != null) generationConfig['maxOutputTokens'] = cfg.maxOutputTokens;
    if (cfg.temperature != null) generationConfig['temperature'] = cfg.temperature;
    if (cfg.thinkingBudget != null) {
      generationConfig['thinkingConfig'] = { thinkingBudget: cfg.thinkingBudget };
    }

    // Bring-your-own SDK client (@google/genai compatible)
    if (cfg.client) {
      const config: Record<string, unknown> = { ...generationConfig };
      if (cfg.systemPrompt) config['systemInstruction'] = cfg.systemPrompt;

      const resp = await cfg.client.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        ...(Object.keys(config).length > 0 ? { config } : {}),
      });

      const output = extractText(resp);
      const usage = resp.usageMetadata as Record<string, number> | undefined;
      return { output, usage };
    }

    // Built-in fetch path (Gemini Developer API REST)
    const apiKey = resolveApiKey(cfg);
    if (!apiKey) {
      throw new Error(
        'GeminiAdapter: no API key provided. Set apiKey in config or GEMINI_API_KEY env var.'
      );
    }

    const base = (cfg.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    const url = `${base}/models/${encodeURIComponent(model)}:generateContent`;

    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
    };
    if (cfg.systemPrompt) {
      body['systemInstruction'] = { parts: [{ text: cfg.systemPrompt }] };
    }

    const timeoutMs = cfg.timeout ?? 120_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
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
      throw new Error(`GeminiAdapter: HTTP ${resp.status} from Gemini API — ${text.slice(0, 200)}`);
    }

    const json = await resp.json() as GeminiGenerateResponse;
    const output = extractText(json);
    return { output, usage: json.usageMetadata as Record<string, number> | undefined };
  }
}
