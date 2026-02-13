/**
 * AutoGen / AG2 Adapter
 * 
 * Allows Microsoft AutoGen (AG2) agents to plug into the SwarmOrchestrator.
 * AutoGen agents communicate via message-passing conversations, so this
 * adapter translates the orchestrator's task payloads into AutoGen messages.
 * 
 * Usage:
 *   const adapter = new AutoGenAdapter();
 *   adapter.registerAgent("coder", myAutoGenAgent);
 *   adapter.registerAgent("critic", myCriticAgent);
 *   await registry.addAdapter(adapter);
 * 
 * Then in the orchestrator:
 *   delegateTask({ targetAgent: "autogen:coder", ... })
 * 
 * @module AutoGenAdapter
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

/**
 * AutoGen-compatible agent interface.
 * Matches the core methods of AutoGen's ConversableAgent.
 */
export interface AutoGenAgent {
  /** Agent name */
  name: string;
  /** Send a message and get a reply */
  generateReply?: (
    messages: Array<{ role: string; content: string; name?: string }>,
    sender?: unknown
  ) => Promise<string | { content: string; [key: string]: unknown } | null>;
  /** Run the agent with a task (simplified interface) */
  run?: (task: string, context?: Record<string, unknown>) => Promise<unknown>;
  /** Initiate a chat (AutoGen 0.2+ style) */
  initiateChat?: (
    recipient: unknown,
    message: string,
    config?: Record<string, unknown>
  ) => Promise<{ chat_history: Array<{ role: string; content: string }>; summary?: string }>;
}

export class AutoGenAdapter extends BaseAdapter {
  readonly name = 'autogen';
  readonly version = '1.0.0';
  private agents: Map<string, AutoGenAgent> = new Map();

  get capabilities(): AdapterCapabilities {
    return {
      streaming: false,
      parallel: true,
      bidirectional: true,
      discovery: true,
      authentication: false,
      statefulSessions: true,
    };
  }

  /**
   * Register an AutoGen agent.
   * The agent should implement at least one of: generateReply, run, or initiateChat.
   */
  registerAgent(
    agentId: string,
    agent: AutoGenAgent,
    metadata?: { description?: string; capabilities?: string[] }
  ): void {
    this.agents.set(agentId, agent);
    this.registerLocalAgent({
      id: agentId,
      name: agent.name || agentId,
      description: metadata?.description ?? `AutoGen agent: ${agent.name || agentId}`,
      capabilities: metadata?.capabilities,
      status: 'available',
    });
  }

  async executeAgent(
    agentId: string,
    payload: AgentPayload,
    context: AgentContext
  ): Promise<AgentResult> {
    this.ensureReady();

    const agent = this.agents.get(agentId);
    if (!agent) {
      return this.errorResult(
        'AGENT_NOT_FOUND',
        `AutoGen agent "${agentId}" is not registered`,
        false
      );
    }

    const startTime = Date.now();

    try {
      let result: unknown;

      // Strategy 1: Use .run() if available (simplest interface)
      if (agent.run) {
        const task = this.buildTaskString(payload);
        result = await agent.run(task, {
          agentId: context.agentId,
          taskId: context.taskId,
          blackboard: payload.blackboardSnapshot,
        });
      }
      // Strategy 2: Use .generateReply() with message format
      else if (agent.generateReply) {
        const messages = this.buildMessages(payload, context);
        result = await agent.generateReply(messages);
      }
      // Strategy 3: Fallback error
      else {
        return this.errorResult(
          'NO_METHOD',
          `AutoGen agent "${agentId}" has no callable method (run, generateReply, or initiateChat)`,
          false
        );
      }

      return this.normalizeResult(result, startTime);
    } catch (error) {
      return this.errorResult(
        'AUTOGEN_ERROR',
        error instanceof Error ? error.message : 'AutoGen execution failed',
        true,
        error
      );
    }
  }

  private buildTaskString(payload: AgentPayload): string {
    if (payload.handoff?.instruction) {
      let task = payload.handoff.instruction;
      if (payload.handoff.constraints?.length) {
        task += `\n\nConstraints: ${payload.handoff.constraints.join(', ')}`;
      }
      if (payload.handoff.expectedOutput) {
        task += `\n\nExpected output: ${payload.handoff.expectedOutput}`;
      }
      return task;
    }
    return JSON.stringify(payload.params);
  }

  private buildMessages(
    payload: AgentPayload,
    context: AgentContext
  ): Array<{ role: string; content: string; name?: string }> {
    const messages: Array<{ role: string; content: string; name?: string }> = [];

    // System context
    if (payload.blackboardSnapshot) {
      messages.push({
        role: 'system',
        content: `Shared state: ${JSON.stringify(payload.blackboardSnapshot)}`,
      });
    }

    // The actual task
    const taskContent = payload.handoff?.instruction || JSON.stringify(payload.params);
    messages.push({
      role: 'user',
      content: taskContent,
      name: context.agentId,
    });

    return messages;
  }

  private normalizeResult(result: unknown, startTime: number): AgentResult {
    if (result === null || result === undefined) {
      return this.successResult({ response: 'No response generated' }, Date.now() - startTime);
    }

    if (typeof result === 'string') {
      return this.successResult({ response: result }, Date.now() - startTime);
    }

    if (typeof result === 'object') {
      const obj = result as Record<string, unknown>;
      // AutoGen chat result format
      if ('chat_history' in obj) {
        return this.successResult({
          response: obj.summary || obj.chat_history,
          chatHistory: obj.chat_history,
        }, Date.now() - startTime);
      }
      // generateReply format
      if ('content' in obj) {
        return this.successResult(obj.content, Date.now() - startTime);
      }
    }

    return this.successResult(result, Date.now() - startTime);
  }
}
