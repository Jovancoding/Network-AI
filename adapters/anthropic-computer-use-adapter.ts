/**
 * Anthropic Computer Use Adapter
 *
 * Integrates Anthropic's Computer Use API (Claude with screen/keyboard/mouse
 * tool use) with the SwarmOrchestrator.
 *
 * This adapter wraps the Anthropic Messages API with computer_use tool
 * definitions, executing multi-step tool-use loops where Claude controls
 * a virtual desktop via user-supplied action handlers.
 *
 * Usage:
 *   const adapter = new AnthropicComputerUseAdapter();
 *   adapter.registerAgent('browser-agent', {
 *     model: 'claude-sonnet-4-20250514',
 *     client: anthropicInstance,
 *     actionHandler: myScreenHandler,
 *   });
 *
 * @module AnthropicComputerUseAdapter
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

/** Anthropic tool use action types */
export type ComputerAction =
  | 'screenshot'
  | 'click'
  | 'double_click'
  | 'type'
  | 'key'
  | 'scroll'
  | 'move'
  | 'drag'
  | 'wait';

/** A tool use request from Claude */
export interface ComputerToolCall {
  /** Tool use ID from the API */
  toolUseId: string;
  /** Action to perform */
  action: ComputerAction;
  /** Coordinates for click/move/drag */
  coordinate?: [number, number];
  /** End coordinates for drag */
  endCoordinate?: [number, number];
  /** Text for type action */
  text?: string;
  /** Key combination for key action */
  key?: string;
  /** Scroll direction and amount */
  scrollDelta?: { x: number; y: number };
  /** Wait duration in ms */
  waitMs?: number;
}

/** Result from executing a tool call */
export interface ComputerToolResult {
  /** Base64-encoded screenshot after action */
  screenshot?: string;
  /** Text content if applicable */
  text?: string;
  /** Whether the action succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * User-supplied handler that executes computer actions.
 * Receives a tool call and returns the result (typically a screenshot).
 */
export type ComputerActionHandler = (call: ComputerToolCall) => Promise<ComputerToolResult>;

/**
 * Minimal interface for the Anthropic SDK messages endpoint.
 * Compatible with `new Anthropic().messages`.
 */
export interface AnthropicMessagesClient {
  create(params: {
    model: string;
    max_tokens: number;
    system?: string;
    messages: Array<{ role: string; content: unknown }>;
    tools?: Array<Record<string, unknown>>;
  }): Promise<{
    id: string;
    content: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
    stop_reason: string | null;
    usage?: { input_tokens: number; output_tokens: number };
  }>;
}

/** Configuration for a registered computer-use agent */
export interface ComputerUseAgentConfig {
  /** Anthropic model (default: 'claude-sonnet-4-20250514') */
  model?: string;
  /** The Anthropic messages client instance */
  client: AnthropicMessagesClient;
  /** Handler that executes computer actions */
  actionHandler: ComputerActionHandler;
  /** System prompt for the agent */
  systemPrompt?: string;
  /** Maximum tool-use loop iterations (default: 20) */
  maxIterations?: number;
  /** Max tokens per API call (default: 4096) */
  maxTokens?: number;
  /** Screen dimensions for the computer_use tool */
  screenSize?: { width: number; height: number };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Adapter for Anthropic Computer Use (Claude controlling a virtual desktop).
 *
 * Runs a tool-use loop: send prompt → Claude returns tool calls →
 * execute via actionHandler → send results back → repeat until done.
 */
export class AnthropicComputerUseAdapter extends BaseAdapter {
  readonly name = 'anthropic-computer-use';
  readonly version = '1.0.0';

  private agents = new Map<string, ComputerUseAgentConfig>();

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

  // -----------------------------------------------------------------------
  // Agent registration
  // -----------------------------------------------------------------------

  /**
   * Register an agent that uses Anthropic Computer Use.
   */
  registerComputerAgent(agentId: string, config: ComputerUseAgentConfig): void {
    this.agents.set(agentId, config);
    this.registerLocalAgent({
      id: agentId,
      name: agentId,
      status: 'available',
      capabilities: ['computer-use', 'tool-use', 'vision'],
      metadata: {
        adapter: 'anthropic-computer-use',
        model: config.model ?? 'claude-sonnet-4-20250514',
      },
    });
  }

  // -----------------------------------------------------------------------
  // Execution
  // -----------------------------------------------------------------------

  async executeAgent(agentId: string, payload: AgentPayload, _context: AgentContext): Promise<AgentResult> {
    this.ensureReady();

    const config = this.agents.get(agentId);
    if (!config) {
      return this.errorResult('COMPUTER_USE_AGENT_NOT_FOUND', `No agent registered as '${agentId}'`);
    }

    const model = config.model ?? 'claude-sonnet-4-20250514';
    const maxIterations = config.maxIterations ?? 20;
    const maxTokens = config.maxTokens ?? 4096;
    const screenSize = config.screenSize ?? { width: 1920, height: 1080 };

    const instruction = payload.handoff?.instruction ?? (payload.params?.instruction as string) ?? payload.action;
    const systemPrompt = config.systemPrompt ?? 'You are a computer-use agent. Complete the requested task using the available tools.';

    // Computer use tool definition
    const computerTool = {
      type: 'computer_20250124',
      name: 'computer',
      display_width_px: screenSize.width,
      display_height_px: screenSize.height,
    };

    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: instruction },
    ];

    const start = Date.now();
    let iterations = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    try {
      while (iterations < maxIterations) {
        iterations++;

        const response = await config.client.create({
          model,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages,
          tools: [computerTool],
        });

        if (response.usage) {
          totalInputTokens += response.usage.input_tokens;
          totalOutputTokens += response.usage.output_tokens;
        }

        // Check if Claude is done (no tool use)
        const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
        if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
          const textBlocks = response.content.filter((b) => b.type === 'text');
          const finalText = textBlocks.map((b) => b.text ?? '').join('\n');
          const durationMs = Date.now() - start;

          return this.successResult({
            response: finalText,
            iterations,
            tokensUsed: { input: totalInputTokens, output: totalOutputTokens },
          }, durationMs);
        }

        // Execute tool calls and build result messages
        messages.push({ role: 'assistant', content: response.content });

        const toolResults: Array<{ type: string; tool_use_id: string; content: unknown }> = [];
        for (const block of toolUseBlocks) {
          const input = block.input ?? {};
          const call: ComputerToolCall = {
            toolUseId: block.id ?? '',
            action: (input['action'] as ComputerAction) ?? 'screenshot',
            coordinate: input['coordinate'] as [number, number] | undefined,
            endCoordinate: input['end_coordinate'] as [number, number] | undefined,
            text: input['text'] as string | undefined,
            key: input['key'] as string | undefined,
          };

          const result = await config.actionHandler(call);
          const content: Array<Record<string, unknown>> = [];

          if (result.screenshot) {
            content.push({
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: result.screenshot },
            });
          }
          if (result.text) {
            content.push({ type: 'text', text: result.text });
          }
          if (result.error) {
            content.push({ type: 'text', text: `Error: ${result.error}` });
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: call.toolUseId,
            content: content.length > 0 ? content : [{ type: 'text', text: 'Done' }],
          });
        }

        messages.push({ role: 'user', content: toolResults });
      }

      // Max iterations reached
      const durationMs = Date.now() - start;
      return this.successResult({
        response: 'Max iterations reached',
        iterations,
        tokensUsed: { input: totalInputTokens, output: totalOutputTokens },
        exhausted: true,
      }, durationMs);
    } catch (err) {
      return this.errorResult(
        'COMPUTER_USE_EXECUTION_FAILED',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async shutdown(): Promise<void> {
    this.agents.clear();
    await super.shutdown();
  }
}
