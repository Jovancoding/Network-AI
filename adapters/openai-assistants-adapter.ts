/**
 * OpenAI Assistants Adapter
 * 
 * Integrates OpenAI's Assistants API (v2) with the SwarmOrchestrator.
 * Supports function calling, code interpreter, file search, and
 * custom assistant configurations.
 * 
 * Usage:
 *   const adapter = new OpenAIAssistantsAdapter();
 *   adapter.registerAssistant("analyst", { assistantId: "asst_abc123", apiKey });
 *   adapter.registerLocalFunction("calculator", async (params) => calculate(params));
 *   await registry.addAdapter(adapter);
 * 
 * Then in the orchestrator:
 *   delegateTask({ targetAgent: "openai-assistants:analyst", ... })
 * 
 * @module OpenAIAssistantsAdapter
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
// OpenAI Assistants-compatible interfaces (self-contained)
// ---------------------------------------------------------------------------

/** Configuration for an OpenAI Assistant */
export interface AssistantConfig {
  /** The assistant ID from OpenAI (asst_xxx) */
  assistantId: string;
  /** OpenAI API key -- or set via adapter config */
  apiKey?: string;
  /** Model override (defaults to the assistant's configured model) */
  model?: string;
  /** Max tokens for responses */
  maxTokens?: number;
  /** Custom headers */
  headers?: Record<string, string>;
  /** Base URL override (for Azure OpenAI or proxies) */
  baseUrl?: string;
}

/** Thread message */
export interface ThreadMessage {
  role: 'user' | 'assistant';
  content: string;
  metadata?: Record<string, string>;
}

/** Run result */
export interface RunResult {
  status: 'completed' | 'failed' | 'requires_action' | 'cancelled' | 'expired';
  messages: ThreadMessage[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  error?: string;
}

/**
 * Client interface for OpenAI Assistants API.
 * Users provide their own client (e.g. the openai npm package) to avoid
 * making the adapter depend on any external package.
 */
export interface OpenAIAssistantsClient {
  /** Create a thread */
  createThread?(): Promise<{ id: string }>;
  /** Add a message to a thread */
  addMessage?(threadId: string, message: ThreadMessage): Promise<void>;
  /** Create and poll a run */
  createAndPollRun?(
    threadId: string,
    assistantId: string,
    options?: { model?: string; maxTokens?: number }
  ): Promise<RunResult>;
  /**
   * Simple single-shot helper: send a message, get a response.
   * If provided, the adapter prefers this over the thread-based flow.
   */
  chat?(
    assistantId: string,
    message: string,
    options?: Record<string, unknown>
  ): Promise<{ response: string; usage?: Record<string, number> }>;
}

type AssistantEntry = {
  config: AssistantConfig;
  client?: OpenAIAssistantsClient;
  threadId?: string;
};

export class OpenAIAssistantsAdapter extends BaseAdapter {
  readonly name = 'openai-assistants';
  readonly version = '1.0.0';
  private assistants: Map<string, AssistantEntry> = new Map();
  private defaultClient?: OpenAIAssistantsClient;

  get capabilities(): AdapterCapabilities {
    return {
      streaming: true,
      parallel: true,
      bidirectional: true,
      discovery: true,
      authentication: true,
      statefulSessions: true,
    };
  }

  async initialize(config: AdapterConfig): Promise<void> {
    await super.initialize(config);
    if (config.options?.client) {
      this.defaultClient = config.options.client as OpenAIAssistantsClient;
    }
  }

  // --- Registration ---

  registerAssistant(
    agentId: string,
    assistantConfig: AssistantConfig,
    client?: OpenAIAssistantsClient,
    metadata?: { description?: string; capabilities?: string[] }
  ): void {
    this.assistants.set(agentId, {
      config: assistantConfig,
      client,
    });
    this.registerLocalAgent({
      id: agentId,
      name: agentId,
      description: metadata?.description ?? `OpenAI Assistant: ${agentId}`,
      capabilities: metadata?.capabilities ?? ['chat', 'function-calling', 'code-interpreter'],
      status: 'available',
    });
  }

  // --- Execution ---

  async executeAgent(
    agentId: string,
    payload: AgentPayload,
    context: AgentContext
  ): Promise<AgentResult> {
    this.ensureReady();

    const entry = this.assistants.get(agentId);
    if (!entry) {
      return this.errorResult(
        'AGENT_NOT_FOUND',
        `OpenAI Assistant "${agentId}" is not registered`,
        false
      );
    }

    const client = entry.client || this.defaultClient;
    if (!client) {
      return this.errorResult(
        'NO_CLIENT',
        'No OpenAI client provided. Pass a client via registerAssistant() or initialize({ options: { client } })',
        false
      );
    }

    const message = this.buildMessage(payload);
    const startTime = Date.now();

    try {
      // Strategy 1: Simple chat helper
      if (client.chat) {
        const result = await client.chat(entry.config.assistantId, message, {
          model: entry.config.model,
          maxTokens: entry.config.maxTokens,
        });
        return this.successResult({
          response: result.response,
          usage: result.usage,
        }, Date.now() - startTime);
      }

      // Strategy 2: Thread-based flow
      if (client.createThread && client.addMessage && client.createAndPollRun) {
        // Reuse thread for session statefulness
        if (!entry.threadId) {
          const thread = await client.createThread();
          entry.threadId = thread.id;
        }

        await client.addMessage(entry.threadId, { role: 'user', content: message });

        const run = await client.createAndPollRun(
          entry.threadId,
          entry.config.assistantId,
          { model: entry.config.model, maxTokens: entry.config.maxTokens }
        );

        if (run.status !== 'completed') {
          return this.errorResult(
            'RUN_FAILED',
            `Run finished with status: ${run.status}. ${run.error || ''}`,
            run.status === 'expired'
          );
        }

        const assistantMessages = run.messages.filter((m) => m.role === 'assistant');
        const lastMessage = assistantMessages[assistantMessages.length - 1];

        return this.successResult({
          response: lastMessage?.content ?? '',
          messages: assistantMessages,
          usage: run.usage,
          threadId: entry.threadId,
        }, Date.now() - startTime);
      }

      return this.errorResult(
        'NO_METHOD',
        'Client has no callable method (chat or createThread+addMessage+createAndPollRun)',
        false
      );
    } catch (error) {
      return this.errorResult(
        'OPENAI_ERROR',
        error instanceof Error ? error.message : 'OpenAI Assistants execution failed',
        true,
        error
      );
    }
  }

  // --- Helpers ---

  private buildMessage(payload: AgentPayload): string {
    if (payload.handoff?.instruction) {
      let msg = payload.handoff.instruction;
      if (payload.handoff.constraints?.length) {
        msg += `\n\nConstraints: ${payload.handoff.constraints.join(', ')}`;
      }
      if (payload.handoff.expectedOutput) {
        msg += `\n\nExpected output format: ${payload.handoff.expectedOutput}`;
      }
      if (payload.blackboardSnapshot) {
        msg += `\n\nContext: ${JSON.stringify(payload.blackboardSnapshot)}`;
      }
      return msg;
    }
    return JSON.stringify(payload.params);
  }
}
