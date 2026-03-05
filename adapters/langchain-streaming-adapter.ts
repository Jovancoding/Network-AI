/**
 * LangChainStreamingAdapter — LangChainAdapter with real incremental streaming.
 *
 * Extends {@link LangChainAdapter} with genuine streaming via the LangChain
 * Runnable `.stream()` interface. Falls back gracefully to `.invoke()` for
 * agents whose Runnable does not expose `.stream()`.
 *
 * Usage (drop-in replacement for LangChainAdapter):
 *
 *   const adapter = new LangChainStreamingAdapter();
 *   adapter.registerAgent('analyst', myChain);        // same API
 *   await registry.addAdapter(adapter);
 *
 *   // Stream the response
 *   for await (const chunk of adapter.executeAgentStream('analyst', payload, ctx)) {
 *     process.stdout.write(chunk.text);
 *     if (chunk.done) break;
 *   }
 *
 * @module LangChainStreamingAdapter
 * @version 1.0.0
 */

import type { AgentPayload, AgentContext, AdapterCapabilities } from '../types/agent-adapter';
import type { StreamingChunk } from '../types/streaming-adapter';
import type { IStreamingAdapter } from '../types/streaming-adapter';
import { LangChainAdapter, LangChainRunnable } from './langchain-adapter';

/**
 * A LangChain Runnable that also exposes the `.stream()` method used by
 * LCEL (LangChain Expression Language) chains, agents, and graphs.
 */
type StreamableRunnable = {
  invoke: (input: unknown, config?: unknown) => Promise<unknown>;
  getName?: () => string;
  stream: (input: unknown, config?: unknown) => AsyncIterable<unknown>;
};

function isStreamable(runnable: LangChainRunnable): runnable is StreamableRunnable {
  return (
    typeof runnable === 'object' &&
    runnable !== null &&
    typeof (runnable as StreamableRunnable).stream === 'function'
  );
}

/** Coerce any chunk value yielded by a LangChain stream to a string. */
function chunkToText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw == null) return '';
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    // AIMessage / BaseMessage pattern
    if (typeof obj.content === 'string') return obj.content;
    // { output: "..." } pattern
    if (typeof obj.output === 'string') return obj.output;
    // { result: "..." } pattern
    if (typeof obj.result === 'string') return obj.result;
    // Generic object — stringify
    return JSON.stringify(obj);
  }
  return String(raw);
}

export class LangChainStreamingAdapter extends LangChainAdapter implements IStreamingAdapter {

  // Internal registry of agents that have a real .stream() method
  private streamableAgentIds = new Set<string>();

  get capabilities(): AdapterCapabilities {
    return {
      ...super.capabilities,
      streaming: true,
    };
  }

  /**
   * Register a LangChain agent. Automatically detects `.stream()` support.
   */
  registerAgent(
    agentId: string,
    runnable: LangChainRunnable,
    metadata?: { description?: string; capabilities?: string[] },
  ): void {
    super.registerAgent(agentId, runnable, metadata);
    if (isStreamable(runnable)) {
      this.streamableAgentIds.add(agentId);
    }
  }

  /** Returns `true` when the agent exposes LangChain's `.stream()` method. */
  supportsStreaming(agentId: string): boolean {
    return this.streamableAgentIds.has(agentId);
  }

  /**
   * Stream agent execution as incremental `StreamingChunk` values.
   *
   * - If the registered Runnable exposes `.stream()`, emits tokens incrementally.
   * - Otherwise falls back to `.invoke()` and emits a single chunk.
   */
  async *executeAgentStream(
    agentId: string,
    payload: AgentPayload,
    context: AgentContext,
  ): AsyncIterable<StreamingChunk> {
    this.ensureReady();

    // Access the internal runnables map via the parent's execute path.
    // We override at the stream level; non-streamable agents fall through
    // to the single-chunk wrapper in the base non-streaming path.
    if (!this.streamableAgentIds.has(agentId)) {
      // Fall back: executeAgent → single chunk
      const result = await this.executeAgent(agentId, payload, context);
      if (!result.success) {
        yield {
          text: result.error?.message ?? 'Agent execution failed',
          done: true,
          metadata: { error: true, code: result.error?.code },
        };
        return;
      }
      const data = result.data;
      const text =
        typeof data === 'string' ? data :
        data != null             ? JSON.stringify(data) :
                                   '';
      yield { text, done: false, metadata: result.metadata };
      yield { text: '', done: true, metadata: { adapter: this.name } };
      return;
    }

    // Build the same input the non-streaming path would use
    const input = (this as any).buildInput(payload, context);

    // We need the runnable — access it via executeAgent's path by delegating
    // through a custom approach: re-invoke via the known runnables map.
    // The parent stores runnables as a private field; we get it via symbol.
    const runnables: Map<string, LangChainRunnable> = (this as any).runnables;
    const runnable = runnables?.get(agentId);

    if (!runnable || !isStreamable(runnable)) {
      // Shouldn't happen — fallback anyway
      yield* this._fallbackStream(agentId, payload, context);
      return;
    }

    const langchainConfig = {
      metadata: {
        taskId: context.taskId,
        sessionId: context.sessionId,
        sourceAgent: context.agentId,
      },
    };

    try {
      for await (const rawChunk of runnable.stream(input, langchainConfig)) {
        const text = chunkToText(rawChunk);
        if (text) yield { text, done: false };
      }
      yield { text: '', done: true, metadata: { adapter: this.name } };
    } catch (error) {
      yield {
        text: error instanceof Error ? error.message : 'Streaming failed',
        done: true,
        metadata: { error: true },
      };
    }
  }

  // Private helper used for fallback path
  private async *_fallbackStream(
    agentId: string,
    payload: AgentPayload,
    context: AgentContext,
  ): AsyncIterable<StreamingChunk> {
    const result = await this.executeAgent(agentId, payload, context);
    if (!result.success) {
      yield {
        text: result.error?.message ?? 'Agent execution failed',
        done: true,
        metadata: { error: true },
      };
      return;
    }
    const data = result.data;
    const text =
      typeof data === 'string' ? data :
      data != null             ? JSON.stringify(data) :
                                 '';
    yield { text, done: false };
    yield { text: '', done: true };
  }
}
