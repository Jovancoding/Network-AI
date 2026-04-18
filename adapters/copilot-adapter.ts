/**
 * CopilotAdapter — Register VS Code Copilot as an agent node.
 *
 * Routes tasks to GitHub Copilot via MCP tool calls, enabling
 * Copilot to participate in multi-agent orchestration as a
 * code generation, review, or analysis agent.
 *
 * BYOC: Requires an MCPServerConnection pointing at a Copilot-compatible
 * MCP endpoint (e.g., VS Code's built-in MCP server or Copilot Extensions).
 *
 * @module CopilotAdapter
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

// ============================================================================
// TYPES
// ============================================================================

/** Copilot task type — maps to different Copilot capabilities */
export type CopilotTaskType = 'generate' | 'review' | 'explain' | 'fix' | 'test' | 'refactor' | 'chat';

/** Copilot-specific execution options */
export interface CopilotOptions {
  /** The type of task to perform (default: 'chat') */
  taskType?: CopilotTaskType;
  /** Programming language context */
  language?: string;
  /** File path context */
  filePath?: string;
  /** Model preference (e.g., 'gpt-4', 'claude-sonnet') */
  model?: string;
  /** Maximum tokens for the response */
  maxTokens?: number;
}

/** Connection interface for Copilot communication */
export interface CopilotConnection {
  /** Send a request and get a response */
  chat(prompt: string, options?: CopilotOptions): Promise<{
    content: string;
    model?: string;
    tokensUsed?: number;
    finishReason?: string;
  }>;
  /** Check if the connection is active */
  isConnected(): boolean;
  /** Close the connection */
  close(): Promise<void>;
}

// ============================================================================
// COPILOT ADAPTER
// ============================================================================

export class CopilotAdapter extends BaseAdapter {
  readonly name = 'copilot';
  readonly version = '1.0.0';

  private connection: CopilotConnection | null = null;
  private defaultModel: string = 'gpt-4';

  get capabilities(): AdapterCapabilities {
    return {
      streaming: false,
      parallel: true,
      bidirectional: false,
      discovery: false,
      authentication: true,
      statefulSessions: false,
    };
  }

  async initialize(config: AdapterConfig): Promise<void> {
    await super.initialize(config);

    const options = config.options as Record<string, unknown> | undefined;
    if (options?.connection) {
      this.connection = options.connection as CopilotConnection;
    }
    if (options?.model && typeof options.model === 'string') {
      this.defaultModel = options.model;
    }

    // Register standard Copilot agent capabilities
    const capabilities: CopilotTaskType[] = ['generate', 'review', 'explain', 'fix', 'test', 'refactor', 'chat'];
    for (const cap of capabilities) {
      this.registerLocalAgent({
        id: `copilot:${cap}`,
        name: `Copilot ${cap}`,
        status: 'available',
        capabilities: [cap],
        metadata: { adapter: 'copilot', taskType: cap },
      });
    }
  }

  async executeAgent(
    agentId: string,
    payload: AgentPayload,
    context: AgentContext,
  ): Promise<AgentResult> {
    this.ensureReady();

    if (!this.connection) {
      return this.errorResult(
        'COPILOT_NO_CONNECTION',
        'No CopilotConnection configured. Pass connection in adapter options.',
      );
    }

    if (!this.connection.isConnected()) {
      return this.errorResult(
        'COPILOT_DISCONNECTED',
        'Copilot connection is not active.',
      );
    }

    // Parse task type from agent ID (e.g., 'copilot:review' → 'review')
    const taskType = this.parseTaskType(agentId);
    const prompt = this.buildPrompt(payload, taskType);

    const options: CopilotOptions = {
      taskType,
      language: payload.params?.language as string | undefined,
      filePath: payload.params?.filePath as string | undefined,
      model: (payload.params?.model as string) ?? this.defaultModel,
      maxTokens: payload.params?.maxTokens as number | undefined,
    };

    try {
      const startMs = Date.now();
      const response = await this.connection.chat(prompt, options);
      const durationMs = Date.now() - startMs;

      return this.successResult({
        content: response.content,
        taskType,
        model: response.model ?? this.defaultModel,
        tokensUsed: response.tokensUsed,
        finishReason: response.finishReason,
      }, durationMs);
    } catch (err) {
      return this.errorResult(
        'COPILOT_EXECUTION_FAILED',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async shutdown(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
      this.connection = null;
    }
    await super.shutdown();
  }

  /** Set or replace the Copilot connection */
  setConnection(connection: CopilotConnection): void {
    this.connection = connection;
  }

  // --------------------------------------------------------------------------
  // INTERNAL
  // --------------------------------------------------------------------------

  private parseTaskType(agentId: string): CopilotTaskType {
    const parts = agentId.split(':');
    const type = parts[parts.length - 1];
    const valid: CopilotTaskType[] = ['generate', 'review', 'explain', 'fix', 'test', 'refactor', 'chat'];
    return valid.includes(type as CopilotTaskType) ? (type as CopilotTaskType) : 'chat';
  }

  private buildPrompt(payload: AgentPayload, taskType: CopilotTaskType): string {
    const instruction = payload.handoff?.instruction ?? payload.params?.instruction as string ?? payload.action;
    const codeContext = payload.params?.code as string | undefined;

    const prefixes: Record<CopilotTaskType, string> = {
      generate: 'Generate code for the following:',
      review: 'Review the following code and provide feedback:',
      explain: 'Explain the following code:',
      fix: 'Fix the issues in the following code:',
      test: 'Write tests for the following code:',
      refactor: 'Refactor the following code:',
      chat: '',
    };

    const prefix = prefixes[taskType];
    let prompt = prefix ? `${prefix}\n\n${instruction}` : instruction;
    if (codeContext) {
      prompt += `\n\n\`\`\`\n${codeContext}\n\`\`\``;
    }
    return prompt;
  }
}
