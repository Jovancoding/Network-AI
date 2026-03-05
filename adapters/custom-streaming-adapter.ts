/**
 * CustomStreamingAdapter — CustomAdapter with streaming support.
 *
 * Extends {@link CustomAdapter} so that handlers can yield incremental text
 * by returning an `AsyncIterable<string>` or `AsyncIterable<StreamingChunk>`.
 * Plain `Promise<unknown>` handlers work unchanged (single-chunk fallback).
 *
 * Usage:
 *
 *   const adapter = new CustomStreamingAdapter();
 *
 *   // Streaming handler — yields tokens incrementally
 *   adapter.registerHandler('writer', async function*(payload) {
 *     yield 'Once ';
 *     yield 'upon ';
 *     yield 'a time…';
 *   });
 *
 *   // Non-streaming handler — works exactly as before
 *   adapter.registerHandler('analyze', async (payload) => ({ result: 'done' }));
 *
 *   // Consume the stream
 *   for await (const chunk of adapter.executeAgentStream('writer', payload, ctx)) {
 *     process.stdout.write(chunk.text);
 *   }
 *
 * @module CustomStreamingAdapter
 * @version 1.0.0
 */

import type { AgentPayload, AgentContext, AdapterCapabilities } from '../types/agent-adapter';
import type { IStreamingAdapter, StreamingChunk } from '../types/streaming-adapter';
import { CustomAdapter, AgentHandler } from './custom-adapter';

/**
 * Extended handler type that may also return an async iterable of string tokens
 * or full `StreamingChunk` objects.
 */
export type StreamingAgentHandler =
  | AgentHandler
  | ((payload: AgentPayload, context: AgentContext) => AsyncIterable<string>)
  | ((payload: AgentPayload, context: AgentContext) => AsyncIterable<StreamingChunk>);

/** Type guard — checks whether the return value of a handler is async-iterable. */
function isAsyncIterable(val: unknown): val is AsyncIterable<unknown> {
  return (
    val != null &&
    typeof val === 'object' &&
    Symbol.asyncIterator in (val as object)
  );
}

/** Type guard — checks whether a `StreamingChunk`-shaped object was yielded. */
function isStreamingChunk(val: unknown): val is StreamingChunk {
  return (
    val !== null &&
    typeof val === 'object' &&
    typeof (val as StreamingChunk).text === 'string' &&
    typeof (val as StreamingChunk).done === 'boolean'
  );
}

export class CustomStreamingAdapter extends CustomAdapter implements IStreamingAdapter {

  private streamingHandlers = new Set<string>();

  get capabilities(): AdapterCapabilities {
    return {
      ...super.capabilities,
      streaming: true,
    };
  }

  /**
   * Register a handler. Streaming handlers (functions returning `AsyncIterable`)
   * are detected automatically and exposed through `executeAgentStream()`.
   */
  registerHandler(
    agentId: string,
    handler: StreamingAgentHandler,
    metadata?: { description?: string; capabilities?: string[] },
  ): void {
    // Probe: call the handler with synthetic inputs and check if the return
    // is async-iterable. We do this via a duck-typed try, falling back safely.
    // Instead, infer from the handler's prototype / generator signature:
    const isGenerator =
      handler.constructor?.name === 'AsyncGeneratorFunction' ||
      (Object.prototype.toString.call(handler) === '[object AsyncGeneratorFunction]');

    if (isGenerator) {
      this.streamingHandlers.add(agentId);
    }

    // Cast to base AgentHandler — the broader type is compatible at runtime
    super.registerHandler(agentId, handler as AgentHandler, metadata);
  }

  /**
   * Mark an already-registered handler as streaming.
   * Useful when the handler function is not an async generator but returns
   * an `AsyncIterable` (e.g. a closure around a separate generator).
   */
  markStreaming(agentId: string): void {
    this.streamingHandlers.add(agentId);
  }

  supportsStreaming(agentId: string): boolean {
    return this.streamingHandlers.has(agentId);
  }

  /**
   * Execute a handler with streaming support.
   *
   * - If the handler is registered as streaming (yields tokens), pipes the
   *   async iterable to `StreamingChunk` values.
   * - Otherwise falls back to `executeAgent()` and wraps the result as a
   *   single chunk (same behaviour as the non-streaming `CustomAdapter`).
   */
  async *executeAgentStream(
    agentId: string,
    payload: AgentPayload,
    context: AgentContext,
  ): AsyncIterable<StreamingChunk> {
    this.ensureReady();

    // Access the internal handlers map stored in the parent class
    const handlers: Map<string, AgentHandler> = (this as any).handlers;
    const handler = handlers?.get(agentId);

    if (!handler) {
      // No handler — delegate to base executeAgent (which returns AGENT_NOT_FOUND)
      const result = await this.executeAgent(agentId, payload, context);
      yield {
        text: result.error?.message ?? 'Agent not found',
        done: true,
        metadata: { error: true },
      };
      return;
    }

    // Invoke the handler — may return a Promise or an AsyncIterable
    let returnValue: unknown;
    try {
      returnValue = handler(payload, context);
    } catch (err) {
      yield {
        text: err instanceof Error ? err.message : 'Handler threw synchronously',
        done: true,
        metadata: { error: true },
      };
      return;
    }

    // If the return is a Promise, await it first
    if (returnValue instanceof Promise) {
      let resolved: unknown;
      try {
        resolved = await returnValue;
      } catch (err) {
        yield {
          text: err instanceof Error ? err.message : 'Handler rejected',
          done: true,
          metadata: { error: true },
        };
        return;
      }

      if (isAsyncIterable(resolved)) {
        // Resolved to an async iterable — pipe it through
        yield* this._pipeIterable(resolved);
        return;
      }

      // Plain resolved value — single chunk fallback
      const text =
        typeof resolved === 'string' ? resolved :
        resolved != null             ? JSON.stringify(resolved) :
                                       '';
      yield { text, done: false };
      yield { text: '', done: true };
      return;
    }

    // Returned an AsyncIterable directly (generator function, etc.)
    if (isAsyncIterable(returnValue)) {
      yield* this._pipeIterable(returnValue);
      return;
    }

    // Fallback — single chunk from whatever value was returned
    const text =
      typeof returnValue === 'string' ? returnValue :
      returnValue != null             ? JSON.stringify(returnValue) :
                                        '';
    yield { text, done: false };
    yield { text: '', done: true };
  }

  /** Pipe an `AsyncIterable<string | StreamingChunk>` to `StreamingChunk` values. */
  private async *_pipeIterable(
    iterable: AsyncIterable<unknown>,
  ): AsyncIterable<StreamingChunk> {
    try {
      for await (const item of iterable) {
        if (isStreamingChunk(item)) {
          yield item;
        } else {
          const text = typeof item === 'string' ? item : JSON.stringify(item);
          yield { text, done: false };
        }
      }
      yield { text: '', done: true };
    } catch (err) {
      yield {
        text: err instanceof Error ? err.message : 'Stream iteration failed',
        done: true,
        metadata: { error: true },
      };
    }
  }
}
