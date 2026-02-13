/**
 * LlamaIndex Adapter
 * 
 * Integrates LlamaIndex agents (QueryEngine, ChatEngine, AgentRunner)
 * with the SwarmOrchestrator. LlamaIndex specialises in retrieval-augmented
 * generation (RAG) and agent-based reasoning over data.
 * 
 * Usage:
 *   const adapter = new LlamaIndexAdapter();
 *   adapter.registerQueryEngine("rag-search", myQueryEngine);
 *   adapter.registerChatEngine("assistant", myChatEngine);
 *   adapter.registerAgentRunner("researcher", myAgentRunner);
 *   await registry.addAdapter(adapter);
 * 
 * Then in the orchestrator:
 *   delegateTask({ targetAgent: "llamaindex:rag-search", ... })
 * 
 * @module LlamaIndexAdapter
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
// LlamaIndex-compatible interfaces (self-contained, no npm dependency)
// ---------------------------------------------------------------------------

/** Matches LlamaIndex's BaseQueryEngine */
export interface LlamaIndexQueryEngine {
  query(query: string): Promise<LlamaIndexResponse>;
}

/** Matches LlamaIndex's BaseChatEngine */
export interface LlamaIndexChatEngine {
  chat(
    message: string,
    chatHistory?: Array<{ role: string; content: string }>
  ): Promise<LlamaIndexResponse>;
  reset?(): void;
}

/** Matches LlamaIndex's AgentRunner / OpenAIAgent / ReActAgent */
export interface LlamaIndexAgentRunner {
  chat(message: string): Promise<LlamaIndexResponse>;
  /** Stream response (optional) */
  streamChat?(message: string): AsyncIterable<{ response: string }>;
  /** Step-by-step execution (optional) */
  runStep?(taskId: string, input?: string): Promise<{ output: unknown; isLast: boolean }>;
  createTask?(input: string): Promise<{ taskId: string }>;
  reset?(): void;
}

/** LlamaIndex response object */
export interface LlamaIndexResponse {
  response?: string;
  toString?(): string;
  sourceNodes?: Array<{
    node?: { text?: string; metadata?: Record<string, unknown> };
    score?: number;
  }>;
  metadata?: Record<string, unknown>;
}

type LlamaIndexEngine =
  | { type: 'query'; engine: LlamaIndexQueryEngine }
  | { type: 'chat'; engine: LlamaIndexChatEngine }
  | { type: 'agent'; engine: LlamaIndexAgentRunner };

export class LlamaIndexAdapter extends BaseAdapter {
  readonly name = 'llamaindex';
  readonly version = '1.0.0';
  private engines: Map<string, LlamaIndexEngine> = new Map();

  get capabilities(): AdapterCapabilities {
    return {
      streaming: true,
      parallel: true,
      bidirectional: false,
      discovery: true,
      authentication: false,
      statefulSessions: true,
    };
  }

  // --- Registration ---

  registerQueryEngine(
    agentId: string,
    engine: LlamaIndexQueryEngine,
    metadata?: { description?: string; capabilities?: string[] }
  ): void {
    this.engines.set(agentId, { type: 'query', engine });
    this.registerLocalAgent({
      id: agentId,
      name: agentId,
      description: metadata?.description ?? `LlamaIndex QueryEngine: ${agentId}`,
      capabilities: metadata?.capabilities ?? ['query', 'rag'],
      status: 'available',
    });
  }

  registerChatEngine(
    agentId: string,
    engine: LlamaIndexChatEngine,
    metadata?: { description?: string; capabilities?: string[] }
  ): void {
    this.engines.set(agentId, { type: 'chat', engine });
    this.registerLocalAgent({
      id: agentId,
      name: agentId,
      description: metadata?.description ?? `LlamaIndex ChatEngine: ${agentId}`,
      capabilities: metadata?.capabilities ?? ['chat', 'rag'],
      status: 'available',
    });
  }

  registerAgentRunner(
    agentId: string,
    engine: LlamaIndexAgentRunner,
    metadata?: { description?: string; capabilities?: string[] }
  ): void {
    this.engines.set(agentId, { type: 'agent', engine });
    this.registerLocalAgent({
      id: agentId,
      name: agentId,
      description: metadata?.description ?? `LlamaIndex AgentRunner: ${agentId}`,
      capabilities: metadata?.capabilities ?? ['agent', 'reasoning', 'tools'],
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

    const entry = this.engines.get(agentId);
    if (!entry) {
      return this.errorResult(
        'AGENT_NOT_FOUND',
        `LlamaIndex engine "${agentId}" is not registered`,
        false
      );
    }

    const query = this.extractQuery(payload);
    const startTime = Date.now();

    try {
      switch (entry.type) {
        case 'query':
          return await this.executeQuery(entry.engine, query, startTime);
        case 'chat':
          return await this.executeChat(entry.engine, query, payload, startTime);
        case 'agent':
          return await this.executeAgentRunner(entry.engine, query, startTime);
        default:
          return this.errorResult('UNKNOWN_TYPE', 'Unknown engine type', false);
      }
    } catch (error) {
      return this.errorResult(
        'LLAMAINDEX_ERROR',
        error instanceof Error ? error.message : 'LlamaIndex execution failed',
        true,
        error
      );
    }
  }

  // --- Private helpers ---

  private extractQuery(payload: AgentPayload): string {
    if (payload.handoff?.instruction) return payload.handoff.instruction;
    if (payload.params?.query) return String(payload.params.query);
    if (payload.params?.message) return String(payload.params.message);
    return JSON.stringify(payload.params);
  }

  private async executeQuery(
    engine: LlamaIndexQueryEngine,
    query: string,
    startTime: number
  ): Promise<AgentResult> {
    const response = await engine.query(query);
    return this.successResult(this.normalizeResponse(response), Date.now() - startTime);
  }

  private async executeChat(
    engine: LlamaIndexChatEngine,
    message: string,
    payload: AgentPayload,
    startTime: number
  ): Promise<AgentResult> {
    const history = payload.params?.chatHistory as Array<{ role: string; content: string }> | undefined;
    const response = await engine.chat(message, history);
    return this.successResult(this.normalizeResponse(response), Date.now() - startTime);
  }

  private async executeAgentRunner(
    engine: LlamaIndexAgentRunner,
    message: string,
    startTime: number
  ): Promise<AgentResult> {
    const response = await engine.chat(message);
    return this.successResult(this.normalizeResponse(response), Date.now() - startTime);
  }

  private normalizeResponse(response: LlamaIndexResponse): Record<string, unknown> {
    const text = response.response ?? response.toString?.() ?? '';
    const result: Record<string, unknown> = { response: text };

    if (response.sourceNodes?.length) {
      result.sources = response.sourceNodes.map((sn) => ({
        text: sn.node?.text?.slice(0, 200),
        score: sn.score,
        metadata: sn.node?.metadata,
      }));
    }
    if (response.metadata) {
      result.metadata = response.metadata;
    }
    return result;
  }
}
