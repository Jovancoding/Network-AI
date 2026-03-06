/**
 * Codex Adapter
 *
 * Integrates OpenAI Codex (code-davinci-002, gpt-4o, o4-mini, or any
 * completions/chat-completions endpoint) with the SwarmOrchestrator.
 *
 * Supports three modes:
 *  - `completion`  — legacy /v1/completions (code-davinci-002 style)
 *  - `chat`        — /v1/chat/completions (gpt-4o, o4-mini, etc.)
 *  - `cli`         — wraps an OpenAI Codex CLI process via a user-supplied
 *                    executor function (for the codex CLI tool)
 *
 * Usage — chat mode:
 *   const adapter = new CodexAdapter();
 *   adapter.registerCodexAgent('refactor', {
 *     mode: 'chat',
 *     model: 'gpt-4o',
 *     systemPrompt: 'You are a refactoring assistant.',
 *     apiKey: process.env.OPENAI_API_KEY,
 *   });
 *
 * Usage — CLI mode (Codex CLI tool):
 *   adapter.registerCodexAgent('codex-cli', {
 *     mode: 'cli',
 *     executor: async (prompt) => myCodexCLIWrapper(prompt),
 *   });
 *
 * Usage — custom client (bring-your-own OpenAI SDK):
 *   adapter.registerCodexAgent('analyst', {
 *     mode: 'chat',
 *     model: 'gpt-4o',
 *     client: openaiInstance,   // any object with .chat.completions.create()
 *   });
 *
 * @module CodexAdapter
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

/** Execution mode for a Codex agent */
export type CodexMode = 'completion' | 'chat' | 'cli';

/**
 * Minimal interface for the OpenAI SDK's chat completions —
 * compatible with `new OpenAI().chat.completions`.
 * Users supply their own SDK instance; no hard dependency.
 */
export interface CodexChatClient {
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

/**
 * Minimal interface for the OpenAI SDK's legacy completions —
 * compatible with `new OpenAI().completions`.
 */
export interface CodexCompletionClient {
  create(params: {
    model: string;
    prompt: string;
    max_tokens?: number;
    temperature?: number;
    stop?: string[];
  }): Promise<{
    choices: Array<{ text?: string }>;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  }>;
}

/**
 * A user-supplied executor for Codex CLI mode.
 * Receives the assembled prompt, returns the CLI output string.
 */
export type CodexCLIExecutor = (prompt: string, options?: Record<string, unknown>) => Promise<string>;

/** Configuration for a registered Codex agent */
export interface CodexAgentConfig {
  /** Execution mode (default: 'chat') */
  mode?: CodexMode;
  /** Model name — e.g. 'gpt-4o', 'o4-mini', 'code-davinci-002' */
  model?: string;
  /** OpenAI API key — falls back to OPENAI_API_KEY env var */
  apiKey?: string;
  /** Base URL override for Azure OpenAI, proxies, or self-hosted endpoints */
  baseUrl?: string;
  /** System-level prompt prepended to every request (chat mode only) */
  systemPrompt?: string;
  /** Maximum tokens in the completion */
  maxTokens?: number;
  /** Temperature (0–2). Default: 0 for code tasks */
  temperature?: number;
  /** Stop sequences */
  stop?: string[];
  /**
   * Bring-your-own OpenAI SDK chat completions instance.
   * If supplied, apiKey / baseUrl are ignored and this client is used directly.
   * Typically `new OpenAI().chat.completions` or `openai.chat.completions`.
   */
  client?: CodexChatClient | CodexCompletionClient;
  /**
   * Executor function for CLI mode.
   * Required when mode === 'cli'.
   */
  executor?: CodexCLIExecutor;
  /** Additional headers to send with fetch-based requests */
  headers?: Record<string, string>;
}

/** Internal entry stored per registered agent */
interface CodexAgentEntry {
  config: CodexAgentConfig;
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

/** Safely extract text from a completion/chat response */
function extractText(
  choice: { message?: { content?: string | null }; text?: string }
): string {
  if (choice.message?.content != null) return choice.message.content;
  if (choice.text != null) return choice.text;
  return '';
}

/** Resolve API key — config first, then env */
function resolveApiKey(config: CodexAgentConfig): string {
  const key = config.apiKey ?? process.env['OPENAI_API_KEY'] ?? '';
  return key;
}

// ---------------------------------------------------------------------------
// CodexAdapter
// ---------------------------------------------------------------------------

/**
 * Adapter that connects OpenAI Codex / code-focused models to the
 * SwarmOrchestrator. Supports chat completions, legacy completions,
 * and the Codex CLI executor interface.
 */
export class CodexAdapter extends BaseAdapter {
  readonly name = 'codex';
  readonly version = '1.0.0';

  private agents: Map<string, CodexAgentEntry> = new Map();

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
   * Register a Codex-powered agent.
   *
   * @param agentId   Unique identifier used in `delegateTask` calls.
   * @param config    Codex agent configuration.
   */
  registerCodexAgent(agentId: string, config: CodexAgentConfig = {}): void {
    if (!this.ready) {
      // Allow pre-initialize registration; initialize() is called lazily
      this.ready = true;
    }

    const mode = config.mode ?? 'chat';
    if (mode === 'cli' && !config.executor) {
      throw new Error(
        `CodexAdapter: agent "${agentId}" uses mode "cli" but no executor function was provided.`
      );
    }

    this.agents.set(agentId, { config: { mode, ...config } });
    this.registeredAgents.set(agentId, {
      id: agentId,
      name: agentId,
      description: `Codex agent (${mode}, model: ${config.model ?? 'gpt-4o'})`,
      capabilities: ['code-generation', 'code-review', 'refactoring', 'explanation'],
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
      throw new Error('CodexAdapter: adapter not initialized. Call initialize() first.');
    }

    const entry = this.agents.get(agentId);
    if (!entry) {
      return {
        success: false,
        error: {
          code: 'AGENT_NOT_FOUND',
          message: `CodexAdapter: no agent registered with id "${agentId}"`,
          recoverable: false,
        },
        metadata: { adapter: this.name },
      };
    }

    const cfg = entry.config;
    const mode = cfg.mode ?? 'chat';

    try {
      let output: string;
      let usage: Record<string, number> | undefined;

      if (mode === 'cli') {
        ({ output, usage } = await this._executeCLI(cfg, payload));
      } else if (mode === 'completion') {
        ({ output, usage } = await this._executeCompletion(cfg, payload));
      } else {
        ({ output, usage } = await this._executeChat(cfg, payload));
      }

      return {
        success: true,
        data: { output, mode, model: cfg.model ?? 'gpt-4o' },
        metadata: {
          adapter: this.name,
          trace: {
            mode,
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
        metadata: { adapter: this.name, trace: { mode } },
      };
    }
  }

  // -------------------------------------------------------------------------
  // Private execution paths
  // -------------------------------------------------------------------------

  private async _executeChat(
    cfg: CodexAgentConfig,
    payload: AgentPayload
  ): Promise<{ output: string; usage?: Record<string, number> }> {
    const prompt = buildPrompt(payload);
    const model = cfg.model ?? 'gpt-4o';

    // Bring-your-own SDK client
    if (cfg.client) {
      const client = cfg.client as CodexChatClient;
      const messages: Array<{ role: string; content: string }> = [];
      if (cfg.systemPrompt) messages.push({ role: 'system', content: cfg.systemPrompt });
      messages.push({ role: 'user', content: prompt });

      const resp = await client.create({
        model,
        messages,
        max_tokens: cfg.maxTokens,
        temperature: cfg.temperature ?? 0,
        stop: cfg.stop,
      });

      const output = resp.choices[0] ? extractText(resp.choices[0]) : '';
      return { output, usage: resp.usage as Record<string, number> | undefined };
    }

    // Built-in fetch path
    const apiKey = resolveApiKey(cfg);
    if (!apiKey) {
      throw new Error(
        'CodexAdapter: no API key provided. Set apiKey in config or OPENAI_API_KEY env var.'
      );
    }

    const base = cfg.baseUrl ?? 'https://api.openai.com';
    const url = `${base}/v1/chat/completions`;

    const messages: Array<{ role: string; content: string }> = [];
    if (cfg.systemPrompt) messages.push({ role: 'system', content: cfg.systemPrompt });
    messages.push({ role: 'user', content: prompt });

    const body = {
      model,
      messages,
      ...(cfg.maxTokens != null ? { max_tokens: cfg.maxTokens } : {}),
      temperature: cfg.temperature ?? 0,
      ...(cfg.stop ? { stop: cfg.stop } : {}),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);

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
      throw new Error(`CodexAdapter: HTTP ${resp.status} from OpenAI — ${text.slice(0, 200)}`);
    }

    const json = await resp.json() as {
      choices: Array<{ message?: { content?: string | null } }>;
      usage?: Record<string, number>;
    };

    const output = json.choices[0]?.message?.content ?? '';
    return { output, usage: json.usage };
  }

  private async _executeCompletion(
    cfg: CodexAgentConfig,
    payload: AgentPayload
  ): Promise<{ output: string; usage?: Record<string, number> }> {
    const prompt = buildPrompt(payload);
    const model = cfg.model ?? 'code-davinci-002';

    // Bring-your-own SDK client
    if (cfg.client) {
      const client = cfg.client as CodexCompletionClient;
      const resp = await client.create({
        model,
        prompt,
        max_tokens: cfg.maxTokens ?? 1024,
        temperature: cfg.temperature ?? 0,
        stop: cfg.stop,
      });
      const output = resp.choices[0]?.text ?? '';
      return { output, usage: resp.usage as Record<string, number> | undefined };
    }

    // Built-in fetch path
    const apiKey = resolveApiKey(cfg);
    if (!apiKey) {
      throw new Error(
        'CodexAdapter: no API key provided. Set apiKey in config or OPENAI_API_KEY env var.'
      );
    }

    const base = cfg.baseUrl ?? 'https://api.openai.com';
    const url = `${base}/v1/completions`;

    const body = {
      model,
      prompt,
      max_tokens: cfg.maxTokens ?? 1024,
      temperature: cfg.temperature ?? 0,
      ...(cfg.stop ? { stop: cfg.stop } : {}),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);

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
      throw new Error(`CodexAdapter: HTTP ${resp.status} from OpenAI — ${text.slice(0, 200)}`);
    }

    const json = await resp.json() as {
      choices: Array<{ text?: string }>;
      usage?: Record<string, number>;
    };

    const output = json.choices[0]?.text ?? '';
    return { output, usage: json.usage };
  }

  private async _executeCLI(
    cfg: CodexAgentConfig,
    payload: AgentPayload
  ): Promise<{ output: string; usage?: undefined }> {
    const executor = cfg.executor!;
    const prompt = buildPrompt(payload);
    const output = await executor(prompt, { model: cfg.model });
    return { output };
  }
}
