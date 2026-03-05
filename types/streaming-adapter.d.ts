/**
 * Streaming adapter types for Network-AI.
 *
 * Extends the base adapter interface with incremental text streaming support.
 * Compatible with any LangChain `.stream()`, custom async generators, or
 * server-sent event sources.
 */

import type { IAgentAdapter, AgentPayload, AgentContext, AgentResult } from './agent-adapter';

/**
 * A single incremental chunk returned by a streaming agent.
 *
 * Consumers should concatenate `text` across all chunks until `done === true`.
 * `metadata` carries optional per-chunk diagnostics (token counts, tool calls, etc.).
 */
export interface StreamingChunk {
  /** Incremental text fragment — may be empty for the final done-packet. */
  text: string;
  /** True only on the last chunk of a complete response. */
  done: boolean;
  /** Optional adapter-specific metadata (e.g. token usage, finish reason). */
  metadata?: Record<string, unknown>;
}

/**
 * Adapter interface extended with streaming capability.
 *
 * Adapters that do not support real streaming fall back to wrapping the full
 * `executeAgent()` result as a single chunk with `done: true`.
 */
export interface IStreamingAdapter extends IAgentAdapter {
  /**
   * Execute an agent and yield incremental text chunks as an `AsyncIterable`.
   *
   * @param agentId   Registered agent identifier.
   * @param payload   Same `AgentPayload` as `executeAgent()`.
   * @param context   Same `AgentContext` as `executeAgent()`.
   * @returns         `AsyncIterable<StreamingChunk>` — iterate with `for await`.
   */
  executeAgentStream(
    agentId: string,
    payload: AgentPayload,
    context: AgentContext,
  ): AsyncIterable<StreamingChunk>;

  /**
   * Returns `true` when the named agent has a real streaming implementation
   * (i.e. NOT just the single-chunk fallback wrapper).
   */
  supportsStreaming(agentId: string): boolean;
}

/**
 * Convenience helper — accumulates all chunks from a stream into a final
 * `AgentResult` with the fully concatenated text in `data.output`.
 *
 * Usage:
 *   const result = await collectStream(adapter.executeAgentStream(id, payload, ctx));
 */
export type StreamCollector = (
  stream: AsyncIterable<StreamingChunk>,
) => Promise<{ output: string; chunks: StreamingChunk[] }>;
