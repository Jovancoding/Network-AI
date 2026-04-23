/**
 * Hermes Adapter (NousResearch Hermes)
 *
 * Integrates NousResearch Hermes models (Hermes-3, Hermes-2, etc.) with the
 * SwarmOrchestrator. Hermes runs via Ollama, llama.cpp, Together AI, Fireworks,
 * or any OpenAI-compatible endpoint — BYOC, no hard dependency.
 *
 * Usage — Ollama (local):
 *   const adapter = new HermesAdapter();
 *   adapter.registerAgent('assistant', {
 *     model: 'hermes3',
 *     baseUrl: 'http://localhost:11434/v1',
 *     systemPrompt: 'You are a helpful assistant.',
 *   });
 *
 * Usage — Together AI / Fireworks (hosted):
 *   adapter.registerAgent('reasoner', {
 *     model: 'NousResearch/Hermes-3-Llama-3.1-70B',
 *     baseUrl: 'https://api.together.xyz/v1',
 *     apiKey: process.env.TOGETHER_API_KEY,
 *   });
 *
 * Usage — bring-your-own OpenAI-compatible client:
 *   adapter.registerAgent('coder', {
 *     model: 'hermes3:8b',
 *     client: openaiInstance.chat.completions,
 *   });
 *
 * @module HermesAdapter
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
 * Pass any SDK instance that implements this — no hard dependency on openai.
 */
export interface HermesChatClient {
  create(params: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    max_tokens?: number;
    temperature?: number;
    stop?: string[];
  }): Promise<{
    choices: Array<{ message?: { content?: string | null }; text?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  }>;
}

/** Configuration for a registered Hermes agent */
export interface HermesAgentConfig {
  /**
   * Model name — Ollama tag or hosted model ID.
   * Examples: 'hermes3', 'hermes3:8b', 'NousResearch/Hermes-3-Llama-3.1-70B'
   * Default: 'hermes3'
   */
  model?: string;
  /**
   * Base URL for the OpenAI-compatible endpoint.
   * Default: 'http://localhost:11434/v1' (Ollama local)
   */
  baseUrl?: string;
  /**
   * API key — required for hosted providers (Together AI, Fireworks, etc.).
   * Falls back to HERMES_API_KEY env var. Ollama local needs no key.
   */
  apiKey?: string;
  /** System-level prompt prepended to every request */
  systemPrompt?: string;
  /** Maximum tokens in the completion (default: 2048) */
  maxTokens?: number;
  /** Sampling temperature, 0–2 (default: 0.7) */
  temperature?: number;
  /** Stop sequences */
  stop?: string[];
  /**
   * Bring-your-own OpenAI-compatible chat completions instance.
   * When supplied, baseUrl / apiKey are ignored.
   */
  client?: HermesChatClient;
  /** Additional request headers for the built-in fetch transport */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds (default: 120000) */
  timeout?: number;
}

/** Internal storage per registered agent */
interface HermesAgentEntry {
  config: HermesAgentConfig;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the user prompt string from an AgentPayload */
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
    parts.push(`Context:\n${relevant}`);
  }

  return parts.join('\n\n') || 'Complete the task.';
}

/** Resolve API key from config then environment */
function resolveApiKey(config: HermesAgentConfig): string {
  return config.apiKey ?? process.env['HERMES_API_KEY'] ?? '';
}

/**
 * Built-in fetch-based OpenAI-compatible completion.
 * Used when no `client` is supplied.
 */
async function fetchCompletion(
  config: HermesAgentConfig,
  messages: Array<{ role: string; content: string }>
): Promise<{ content: string; usage?: Record<string, number> }> {
  const baseUrl = (config.baseUrl ?? 'http://localhost:11434/v1').replace(/\/$/, '');
  const url = `${baseUrl}/chat/completions`;
  const apiKey = resolveApiKey(config);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(config.headers ?? {}),
  };

  const body = JSON.stringify({
    model: config.model ?? 'hermes3',
    messages,
    ...(config.maxTokens !== undefined ? { max_tokens: config.maxTokens } : {}),
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(config.stop?.length ? { stop: config.stop } : {}),
  });

  const controller = new AbortController();
  const timeoutMs = config.timeout ?? 120_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Hermes API error ${res.status}: ${text}`);
    }
    const json = await res.json() as {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content ?? '';
    const usage = json.usage
      ? {
          prompt_tokens: json.usage.prompt_tokens ?? 0,
          completion_tokens: json.usage.completion_tokens ?? 0,
          total_tokens: json.usage.total_tokens ?? 0,
        }
      : undefined;
    return { content, ...(usage ? { usage } : {}) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class HermesAdapter extends BaseAdapter {
  readonly name = 'hermes';
  readonly version = '1.0.0';
  private agents: Map<string, HermesAgentEntry> = new Map();

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
   * Register a Hermes agent with the given configuration.
   *
   * @param agentId - Unique identifier used to route tasks to this agent
   * @param config  - Model, endpoint, system prompt, and optional BYOC client
   */
  registerAgent(agentId: string, config: HermesAgentConfig): void {
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('HermesAdapter.registerAgent: agentId must be a non-empty string');
    }
    this.agents.set(agentId, { config });
    this.registeredAgents.set(agentId, {
      id: agentId,
      name: agentId,
      description: `Hermes agent — model: ${config.model ?? 'hermes3'}`,
      adapter: 'hermes',
      capabilities: ['text-generation', 'reasoning', 'instruction-following'],
      status: 'available' as const,
    });
  }

  async executeAgent(
    agentId: string,
    payload: AgentPayload,
    _context: AgentContext
  ): Promise<AgentResult> {
    if (!this.ready) {
      return { success: false, error: { code: 'NOT_INITIALIZED', message: 'HermesAdapter not initialized', recoverable: false } };
    }

    const entry = this.agents.get(agentId);
    if (!entry) {
      return { success: false, error: { code: 'AGENT_NOT_FOUND', message: `Hermes agent not found: ${agentId}`, recoverable: false } };
    }

    const { config } = entry;
    const prompt = buildPrompt(payload);
    const messages: Array<{ role: string; content: string }> = [];

    if (config.systemPrompt) {
      messages.push({ role: 'system', content: config.systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    try {
      let content: string;
      let usage: Record<string, number> | undefined;

      if (config.client) {
        // BYOC path
        const resp = await config.client.create({
          model: config.model ?? 'hermes3',
          messages,
          ...(config.maxTokens !== undefined ? { max_tokens: config.maxTokens } : {}),
          ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
          ...(config.stop?.length ? { stop: config.stop } : {}),
        });
        content = resp.choices[0]?.message?.content ?? resp.choices[0]?.text ?? '';
        if (resp.usage) {
          usage = {
            prompt_tokens: resp.usage.prompt_tokens ?? 0,
            completion_tokens: resp.usage.completion_tokens ?? 0,
            total_tokens: resp.usage.total_tokens ?? 0,
          };
        }
      } else {
        // Built-in fetch path
        const result = await fetchCompletion(config, messages);
        content = result.content;
        usage = result.usage;
      }

      return {
        success: true,
        data: {
          response: content,
          model: config.model ?? 'hermes3',
          agentId,
          ...(usage ? { usage } : {}),
        },
      };
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'EXECUTION_ERROR',
          message: err instanceof Error ? err.message : String(err),
          recoverable: true,
          nativeError: err,
        },
      };
    }
  }

  async initialize(config: AdapterConfig): Promise<void> {
    await super.initialize(config);
  }

  async shutdown(): Promise<void> {
    this.agents.clear();
    await super.shutdown();
  }
}
