/**
 * Claude Agent SDK Adapter
 *
 * Integrates agents built with Anthropic's Claude Agent SDK
 * (`@anthropic-ai/claude-agent-sdk`) with the SwarmOrchestrator. The SDK's
 * `query()` function runs a full agentic loop (tool use, file edits, shell)
 * and streams SDK messages; this adapter drives that loop and returns the
 * final result to the swarm.
 *
 * Strictly BYOC: the SDK is never imported here. Callers pass the SDK's
 * `query` function (or any compatible implementation) at registration time.
 *
 * Usage:
 *   import { query } from '@anthropic-ai/claude-agent-sdk';
 *
 *   const adapter = new ClaudeAgentSDKAdapter();
 *   await adapter.initialize({});
 *   adapter.registerAgent('coder', {
 *     query,                                  // the SDK's query function
 *     options: { maxTurns: 10, allowedTools: ['Read', 'Grep'] },
 *     systemPrompt: 'You are a careful refactoring agent.',
 *   });
 *
 *   await registry.addAdapter(adapter);
 *   // orchestrator: delegateTask({ targetAgent: 'claude-agent-sdk:coder', ... })
 *
 * @module ClaudeAgentSDKAdapter
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

/**
 * A message yielded by the Claude Agent SDK's query loop. Only the fields
 * this adapter consumes are modeled; extra fields pass through untouched.
 */
export interface ClaudeSDKMessage {
  /** Message kind — 'assistant', 'user', 'system', 'result', ... */
  type: string;
  /** For result messages: 'success' or an error subtype */
  subtype?: string;
  /** For result messages: the final result text */
  result?: string;
  /** Total cost in USD, when reported */
  total_cost_usd?: number;
  /** Number of agentic turns taken */
  num_turns?: number;
  /** Session identifier assigned by the SDK */
  session_id?: string;
  /** Token usage, when reported */
  usage?: Record<string, unknown>;
  /** Whether the run ended in an error */
  is_error?: boolean;
}

/**
 * The Claude Agent SDK `query` function shape. Matches
 * `@anthropic-ai/claude-agent-sdk`'s `query({ prompt, options })`, which
 * returns an async iterable of SDK messages.
 */
export type ClaudeAgentQueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncIterable<ClaudeSDKMessage>;

/** Configuration for a registered Claude Agent SDK agent */
export interface ClaudeAgentSDKConfig {
  /** The SDK's query function (BYOC — required) */
  query: ClaudeAgentQueryFn;
  /**
   * Options forwarded to the SDK on every run — e.g. `maxTurns`,
   * `allowedTools`, `permissionMode`, `cwd`, `model`.
   */
  options?: Record<string, unknown>;
  /** System prompt override — forwarded as `options.systemPrompt` */
  systemPrompt?: string;
  /**
   * Called for every intermediate SDK message (assistant turns, tool use)
   * before the final result — useful for progress reporting.
   */
  onMessage?: (message: ClaudeSDKMessage) => void;
}

/** Internal entry stored per registered agent */
interface ClaudeAgentEntry {
  config: ClaudeAgentSDKConfig;
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

// ---------------------------------------------------------------------------
// ClaudeAgentSDKAdapter
// ---------------------------------------------------------------------------

/**
 * Adapter that runs Claude Agent SDK agentic loops as swarm agents.
 * The final `result` message becomes the AgentResult; intermediate messages
 * are surfaced through the per-agent `onMessage` callback.
 */
export class ClaudeAgentSDKAdapter extends BaseAdapter {
  readonly name = 'claude-agent-sdk';
  readonly version = '1.0.0';

  private agents: Map<string, ClaudeAgentEntry> = new Map();

  get capabilities(): AdapterCapabilities {
    return {
      streaming: false,
      parallel: true,
      bidirectional: false,
      discovery: true,
      authentication: false,
      statefulSessions: true,
    };
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Register a Claude Agent SDK-powered agent.
   *
   * @param agentId   Unique identifier used in `delegateTask` calls.
   * @param config    Agent configuration — `query` is required.
   */
  registerAgent(agentId: string, config: ClaudeAgentSDKConfig): void {
    if (!agentId || typeof agentId !== 'string' || agentId.trim() === '') {
      throw new Error('ClaudeAgentSDKAdapter: agentId must be a non-empty string');
    }
    if (!config || typeof config.query !== 'function') {
      throw new Error(
        'ClaudeAgentSDKAdapter: config.query is required — pass the SDK\'s query function ' +
        '(BYOC; e.g. `import { query } from "@anthropic-ai/claude-agent-sdk"`).'
      );
    }
    if (!this.ready) {
      this.ready = true;
    }

    this.agents.set(agentId, { config });
    this.registeredAgents.set(agentId, {
      id: agentId,
      name: agentId,
      description: 'Claude Agent SDK agent (agentic loop with tools)',
      capabilities: ['chat', 'code-generation', 'tool-use', 'file-edit', 'agentic-loop'],
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
      throw new Error('ClaudeAgentSDKAdapter: adapter not initialized. Call initialize() first.');
    }

    const entry = this.agents.get(agentId);
    if (!entry) {
      return {
        success: false,
        error: {
          code: 'AGENT_NOT_FOUND',
          message: `ClaudeAgentSDKAdapter: no agent registered with id "${agentId}"`,
          recoverable: false,
        },
        metadata: { adapter: this.name },
      };
    }

    const cfg = entry.config;
    const prompt = buildPrompt(payload);

    const options: Record<string, unknown> = { ...cfg.options };
    if (cfg.systemPrompt && options['systemPrompt'] === undefined) {
      options['systemPrompt'] = cfg.systemPrompt;
    }

    try {
      let resultMessage: ClaudeSDKMessage | undefined;
      let turns = 0;

      for await (const message of cfg.query({ prompt, options })) {
        if (message.type === 'result') {
          resultMessage = message;
          break;
        }
        turns++;
        cfg.onMessage?.(message);
      }

      if (!resultMessage) {
        return {
          success: false,
          error: {
            code: 'NO_RESULT',
            message: 'ClaudeAgentSDKAdapter: query loop ended without a result message',
            recoverable: true,
          },
          metadata: { adapter: this.name },
        };
      }

      if (resultMessage.is_error || (resultMessage.subtype && resultMessage.subtype !== 'success')) {
        return {
          success: false,
          error: {
            code: 'AGENT_ERROR',
            message: `ClaudeAgentSDKAdapter: run failed (${resultMessage.subtype ?? 'error'})` +
              (resultMessage.result ? ` — ${resultMessage.result.slice(0, 300)}` : ''),
            recoverable: true,
          },
          metadata: { adapter: this.name },
        };
      }

      return {
        success: true,
        data: {
          output: resultMessage.result ?? '',
          sessionId: resultMessage.session_id,
          numTurns: resultMessage.num_turns ?? turns,
          ...(resultMessage.total_cost_usd != null ? { costUsd: resultMessage.total_cost_usd } : {}),
        },
        metadata: {
          adapter: this.name,
          trace: {
            taskId: context.taskId,
            ...(resultMessage.usage ? { usage: resultMessage.usage } : {}),
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
}
