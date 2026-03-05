/**
 * StreamingBaseAdapter — Abstract base for all streaming-capable adapters.
 *
 * Extends {@link BaseAdapter} with a default `executeAgentStream()` that wraps
 * the non-streaming `executeAgent()` result as a single `StreamingChunk`.
 * Subclasses override `executeAgentStream()` and/or `supportsStreaming()` to
 * provide genuine incremental streaming.
 *
 * @module StreamingBaseAdapter
 * @version 1.0.0
 */

import type { AgentPayload, AgentContext } from '../types/agent-adapter';
import type { IStreamingAdapter, StreamingChunk } from '../types/streaming-adapter';
import { BaseAdapter } from './base-adapter';

export abstract class StreamingBaseAdapter extends BaseAdapter implements IStreamingAdapter {

  /**
   * Returns `true` when the named agent has a real streaming implementation.
   * Default: `false` (fallback single-chunk wrapper is used).
   * Override in subclasses that register streaming agents.
   */
  supportsStreaming(_agentId: string): boolean {
    return false;
  }

  /**
   * Default streaming implementation — wraps `executeAgent()` as a single chunk.
   *
   * Subclasses that support genuine streaming should override this method.
   * The overriding implementation should:
   *  1. yield partial text chunks as they arrive
   *  2. yield a final chunk with `done: true` and `text: ''`
   */
  async *executeAgentStream(
    agentId: string,
    payload: AgentPayload,
    context: AgentContext,
  ): AsyncIterable<StreamingChunk> {
    const result = await this.executeAgent(agentId, payload, context);

    if (!result.success) {
      // Propagate the error as a single done-chunk with error text
      const msg = result.error?.message ?? 'Agent execution failed';
      yield { text: msg, done: true, metadata: { error: true, code: result.error?.code } };
      return;
    }

    // Flatten data to a string for the streaming consumer
    const data = result.data;
    const text =
      typeof data === 'string' ? data :
      data != null             ? JSON.stringify(data) :
                                 '';

    yield { text, done: false, metadata: result.metadata };
    yield { text: '', done: true, metadata: { adapter: this.name } };
  }
}

/**
 * Utility: drain a streaming adapter into a single accumulated result.
 *
 * @example
 *   const { output } = await collectStream(adapter.executeAgentStream('my-agent', payload, ctx));
 */
export async function collectStream(
  stream: AsyncIterable<StreamingChunk>,
): Promise<{ output: string; chunks: StreamingChunk[] }> {
  const chunks: StreamingChunk[] = [];
  let output = '';
  for await (const chunk of stream) {
    chunks.push(chunk);
    if (chunk.text) output += chunk.text;
  }
  return { output, chunks };
}
