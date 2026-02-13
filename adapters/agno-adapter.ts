/**
 * Agno Adapter (formerly Phidata)
 * 
 * Integrates Agno agents and teams with the SwarmOrchestrator.
 * Agno is a lightweight framework for building multi-agent systems with
 * tool use, memory, knowledge bases, and structured outputs.
 * 
 * Usage:
 *   const adapter = new AgnoAdapter();
 *   adapter.registerAgent("researcher", myAgnoAgent);
 *   adapter.registerTeam("dev-team", myAgnoTeam);
 *   await registry.addAdapter(adapter);
 * 
 * Then in the orchestrator:
 *   delegateTask({ targetAgent: "agno:researcher", ... })
 * 
 * @module AgnoAdapter
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
// Agno-compatible interfaces (self-contained)
// ---------------------------------------------------------------------------

/** Matches Agno's Agent class */
export interface AgnoAgent {
  /** Agent name */
  name?: string;
  /** Run the agent with a message */
  run(message: string, options?: AgnoRunOptions): Promise<AgnoResponse>;
  /** Print-friendly run (optional) */
  printResponse?(message: string): Promise<void>;
  /** Stream response (optional) */
  runStream?(message: string): AsyncIterable<AgnoStreamChunk>;
}

/** Matches Agno's Team class */
export interface AgnoTeam {
  /** Team name */
  name?: string;
  /** Run the team */
  run(message: string, options?: AgnoRunOptions): Promise<AgnoResponse>;
  /** Members of the team */
  members?: Array<{ name: string; role?: string }>;
}

/** Run options */
export interface AgnoRunOptions {
  /** Stream the response */
  stream?: boolean;
  /** Additional context */
  context?: Record<string, unknown>;
  /** Structured output schema */
  responseModel?: unknown;
  /** Max iterations for reasoning */
  maxIterations?: number;
}

/** Agno response */
export interface AgnoResponse {
  /** The content of the response */
  content?: string;
  /** Messages from the conversation */
  messages?: Array<{ role: string; content: string }>;
  /** Tool calls made */
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; result?: unknown }>;
  /** Structured output (if responseModel was used) */
  structuredOutput?: unknown;
  /** Token usage */
  usage?: { input_tokens?: number; output_tokens?: number };
  /** Which agent responded (in team mode) */
  respondingAgent?: string;
}

/** Stream chunk */
export interface AgnoStreamChunk {
  content?: string;
  done?: boolean;
}

/** A simple function-based agent (for lightweight usage) */
export type AgnoFunction = (
  message: string,
  context?: Record<string, unknown>
) => Promise<string | AgnoResponse>;

type AgnoEntry =
  | { type: 'agent'; agent: AgnoAgent }
  | { type: 'team'; team: AgnoTeam }
  | { type: 'function'; fn: AgnoFunction };

export class AgnoAdapter extends BaseAdapter {
  readonly name = 'agno';
  readonly version = '1.0.0';
  private entries: Map<string, AgnoEntry> = new Map();

  get capabilities(): AdapterCapabilities {
    return {
      streaming: true,
      parallel: true,
      bidirectional: true,
      discovery: true,
      authentication: false,
      statefulSessions: true,
    };
  }

  // --- Registration ---

  registerAgent(
    agentId: string,
    agent: AgnoAgent,
    metadata?: { description?: string; capabilities?: string[] }
  ): void {
    this.entries.set(agentId, { type: 'agent', agent });
    this.registerLocalAgent({
      id: agentId,
      name: agent.name || agentId,
      description: metadata?.description ?? `Agno Agent: ${agent.name || agentId}`,
      capabilities: metadata?.capabilities ?? ['agent', 'tools', 'memory'],
      status: 'available',
    });
  }

  registerTeam(
    agentId: string,
    team: AgnoTeam,
    metadata?: { description?: string; capabilities?: string[] }
  ): void {
    this.entries.set(agentId, { type: 'team', team });
    const memberNames = team.members?.map((m) => m.name).join(', ') || 'unknown';
    this.registerLocalAgent({
      id: agentId,
      name: team.name || agentId,
      description: metadata?.description ?? `Agno Team: ${team.name || agentId} (members: ${memberNames})`,
      capabilities: metadata?.capabilities ?? ['team', 'multi-agent', 'collaboration'],
      status: 'available',
    });
  }

  registerFunction(
    agentId: string,
    fn: AgnoFunction,
    metadata?: { description?: string; capabilities?: string[] }
  ): void {
    this.entries.set(agentId, { type: 'function', fn });
    this.registerLocalAgent({
      id: agentId,
      name: agentId,
      description: metadata?.description ?? `Agno Function: ${agentId}`,
      capabilities: metadata?.capabilities ?? ['function'],
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

    const entry = this.entries.get(agentId);
    if (!entry) {
      return this.errorResult(
        'AGENT_NOT_FOUND',
        `Agno entry "${agentId}" is not registered`,
        false
      );
    }

    const message = this.buildMessage(payload);
    const startTime = Date.now();

    try {
      switch (entry.type) {
        case 'agent':
          return await this.executeAgnoAgent(entry.agent, message, payload, startTime);
        case 'team':
          return await this.executeAgnoTeam(entry.team, message, payload, startTime);
        case 'function':
          return await this.executeAgnoFunction(entry.fn, message, payload, startTime);
        default:
          return this.errorResult('UNKNOWN_TYPE', 'Unknown Agno entry type', false);
      }
    } catch (error) {
      return this.errorResult(
        'AGNO_ERROR',
        error instanceof Error ? error.message : 'Agno execution failed',
        true,
        error
      );
    }
  }

  // --- Private helpers ---

  private buildMessage(payload: AgentPayload): string {
    if (payload.handoff?.instruction) {
      let msg = payload.handoff.instruction;
      if (payload.handoff.constraints?.length) {
        msg += `\n\nConstraints: ${payload.handoff.constraints.join(', ')}`;
      }
      return msg;
    }
    return payload.params?.message as string || JSON.stringify(payload.params);
  }

  private async executeAgnoAgent(
    agent: AgnoAgent,
    message: string,
    payload: AgentPayload,
    startTime: number
  ): Promise<AgentResult> {
    const response = await agent.run(message, {
      context: payload.blackboardSnapshot as Record<string, unknown>,
    });
    return this.successResult(
      this.normalizeResponse(response),
      Date.now() - startTime
    );
  }

  private async executeAgnoTeam(
    team: AgnoTeam,
    message: string,
    payload: AgentPayload,
    startTime: number
  ): Promise<AgentResult> {
    const response = await team.run(message, {
      context: payload.blackboardSnapshot as Record<string, unknown>,
    });
    return this.successResult({
      ...this.normalizeResponse(response),
      team: team.name,
      respondingAgent: response.respondingAgent,
    }, Date.now() - startTime);
  }

  private async executeAgnoFunction(
    fn: AgnoFunction,
    message: string,
    payload: AgentPayload,
    startTime: number
  ): Promise<AgentResult> {
    const result = await fn(message, payload.blackboardSnapshot as Record<string, unknown>);
    if (typeof result === 'string') {
      return this.successResult({ response: result }, Date.now() - startTime);
    }
    return this.successResult(this.normalizeResponse(result), Date.now() - startTime);
  }

  private normalizeResponse(response: AgnoResponse): Record<string, unknown> {
    return {
      response: response.content ?? '',
      messages: response.messages,
      toolCalls: response.toolCalls,
      structuredOutput: response.structuredOutput,
      usage: response.usage,
    };
  }
}
