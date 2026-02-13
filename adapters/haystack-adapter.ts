/**
 * Haystack Adapter
 * 
 * Integrates deepset Haystack pipelines and agents with the SwarmOrchestrator.
 * Haystack is a production-grade framework for building RAG and search
 * pipelines with customisable components.
 * 
 * Usage:
 *   const adapter = new HaystackAdapter();
 *   adapter.registerPipeline("search", myPipeline);
 *   adapter.registerAgent("qa-agent", myHaystackAgent);
 *   await registry.addAdapter(adapter);
 * 
 * Then in the orchestrator:
 *   delegateTask({ targetAgent: "haystack:search", ... })
 * 
 * @module HaystackAdapter
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
// Haystack-compatible interfaces (self-contained)
// ---------------------------------------------------------------------------

/** Matches Haystack's Pipeline.run() interface */
export interface HaystackPipeline {
  /** Run the pipeline with inputs */
  run(inputs: Record<string, unknown>): Promise<HaystackPipelineResult>;
  /** Get pipeline metadata */
  getMetadata?(): { name?: string; components?: string[] };
}

/** Pipeline result */
export interface HaystackPipelineResult {
  [componentName: string]: Record<string, unknown>;
}

/** Matches Haystack Agent interface */
export interface HaystackAgent {
  /** Run the agent with a query */
  run(query: string, params?: Record<string, unknown>): Promise<HaystackAgentResult>;
}

/** Agent result */
export interface HaystackAgentResult {
  answer?: string;
  transcript?: Array<{ role: string; content: string }>;
  documents?: Array<{
    content?: string;
    meta?: Record<string, unknown>;
    score?: number;
  }>;
}

/** Haystack component (individual node in a pipeline) */
export interface HaystackComponent {
  /** Run the component */
  run(inputs: Record<string, unknown>): Promise<Record<string, unknown>>;
}

type HaystackEntry =
  | { type: 'pipeline'; pipeline: HaystackPipeline }
  | { type: 'agent'; agent: HaystackAgent }
  | { type: 'component'; component: HaystackComponent };

export class HaystackAdapter extends BaseAdapter {
  readonly name = 'haystack';
  readonly version = '1.0.0';
  private entries: Map<string, HaystackEntry> = new Map();

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

  // --- Registration ---

  registerPipeline(
    agentId: string,
    pipeline: HaystackPipeline,
    metadata?: { description?: string; capabilities?: string[] }
  ): void {
    this.entries.set(agentId, { type: 'pipeline', pipeline });

    const pipelineMeta = pipeline.getMetadata?.();
    this.registerLocalAgent({
      id: agentId,
      name: pipelineMeta?.name || agentId,
      description: metadata?.description ?? `Haystack Pipeline: ${agentId}`,
      capabilities: metadata?.capabilities ?? ['pipeline', 'rag'],
      status: 'available',
    });
  }

  registerAgent(
    agentId: string,
    agent: HaystackAgent,
    metadata?: { description?: string; capabilities?: string[] }
  ): void {
    this.entries.set(agentId, { type: 'agent', agent });
    this.registerLocalAgent({
      id: agentId,
      name: agentId,
      description: metadata?.description ?? `Haystack Agent: ${agentId}`,
      capabilities: metadata?.capabilities ?? ['agent', 'qa'],
      status: 'available',
    });
  }

  registerComponent(
    agentId: string,
    component: HaystackComponent,
    metadata?: { description?: string; capabilities?: string[] }
  ): void {
    this.entries.set(agentId, { type: 'component', component });
    this.registerLocalAgent({
      id: agentId,
      name: agentId,
      description: metadata?.description ?? `Haystack Component: ${agentId}`,
      capabilities: metadata?.capabilities ?? ['component'],
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
        `Haystack entry "${agentId}" is not registered`,
        false
      );
    }

    const startTime = Date.now();

    try {
      switch (entry.type) {
        case 'pipeline':
          return await this.executePipeline(entry.pipeline, payload, startTime);
        case 'agent':
          return await this.executeHaystackAgent(entry.agent, payload, startTime);
        case 'component':
          return await this.executeComponent(entry.component, payload, startTime);
        default:
          return this.errorResult('UNKNOWN_TYPE', 'Unknown entry type', false);
      }
    } catch (error) {
      return this.errorResult(
        'HAYSTACK_ERROR',
        error instanceof Error ? error.message : 'Haystack execution failed',
        true,
        error
      );
    }
  }

  // --- Private helpers ---

  private async executePipeline(
    pipeline: HaystackPipeline,
    payload: AgentPayload,
    startTime: number
  ): Promise<AgentResult> {
    const inputs = this.buildPipelineInputs(payload);
    const result = await pipeline.run(inputs);
    return this.successResult(this.normalizePipelineResult(result), Date.now() - startTime);
  }

  private async executeHaystackAgent(
    agent: HaystackAgent,
    payload: AgentPayload,
    startTime: number
  ): Promise<AgentResult> {
    const query = payload.handoff?.instruction
      || payload.params?.query as string
      || JSON.stringify(payload.params);
    const result = await agent.run(query, payload.params);
    return this.successResult({
      response: result.answer ?? '',
      transcript: result.transcript,
      documents: result.documents?.map((d) => ({
        content: d.content?.slice(0, 300),
        score: d.score,
        meta: d.meta,
      })),
    }, Date.now() - startTime);
  }

  private async executeComponent(
    component: HaystackComponent,
    payload: AgentPayload,
    startTime: number
  ): Promise<AgentResult> {
    const inputs = this.buildPipelineInputs(payload);
    const result = await component.run(inputs);
    return this.successResult(result, Date.now() - startTime);
  }

  private buildPipelineInputs(payload: AgentPayload): Record<string, unknown> {
    const inputs: Record<string, unknown> = { ...payload.params };
    if (payload.handoff?.instruction) {
      inputs.query = payload.handoff.instruction;
    }
    if (payload.blackboardSnapshot) {
      inputs.context = payload.blackboardSnapshot;
    }
    return inputs;
  }

  private normalizePipelineResult(
    result: HaystackPipelineResult
  ): Record<string, unknown> {
    // Haystack pipeline results are keyed by component name.
    // Try to find an answer/reply in the output.
    const keys = Object.keys(result);
    for (const key of keys) {
      const component = result[key];
      if (component && typeof component === 'object') {
        if ('replies' in component) return { response: (component as any).replies, components: result };
        if ('answers' in component) return { response: (component as any).answers, components: result };
        if ('documents' in component) return { documents: (component as any).documents, components: result };
      }
    }
    return { response: result };
  }
}
