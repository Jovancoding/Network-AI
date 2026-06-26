/**
 * AnthropicMessagesAdapter — governed Anthropic Messages binding.
 *
 * The concrete provider binding for {@link ../lib/model-gateway!GovernedModelGateway}.
 * It maps the Anthropic Messages API (refusals, `output_config.effort`,
 * fallback-credit redemption) to the gateway's normalized shapes, then exposes
 * one governed `executeAgent` that absorbs the refusal → fallback → billing
 * chain behind the standard adapter interface.
 *
 * Dependency-free (BYOC): you inject an `AnthropicMessagesClient`; the adapter
 * never imports the Anthropic SDK. Build and test it against Claude Opus 4.8,
 * which is also Claude Fable 5's fallback target.
 *
 * @module AnthropicMessagesAdapter
 * @version 1.0.0
 */

import type { AgentPayload, AgentContext, AgentResult, AdapterCapabilities } from '../types/agent-adapter';
import { BaseAdapter } from './base-adapter';
import { ThinkingBlockManager } from '../lib/thinking-blocks';
import {
  GovernedModelGateway,
  type ModelCaller,
  type ModelResponse,
  type ModelContentBlock,
  type EffortLevel,
  type BudgetSink,
  type AuditSink,
  type RefusalTelemetrySink,
  type ThinkingSink,
  type EffortSink,
  type RefusalCategory,
} from '../lib/model-gateway';

// ---------------------------------------------------------------------------
// BYOC client shapes (Anthropic Messages API)
// ---------------------------------------------------------------------------

/** Raw Anthropic Messages response (the subset this adapter reads). */
export interface AnthropicRawResponse {
  id?: string;
  model: string;
  content: Array<{ type: string; text?: string; thinking?: string; signature?: string; [k: string]: unknown }>;
  stop_reason: string | null;
  stop_details?: {
    type?: string;
    category?: string | null;
    explanation?: string;
    fallback_credit_token?: string | null;
    fallback_has_prefill_claim?: boolean | null;
    recommended_model?: string | null;
  } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/** Bring-your-own Anthropic Messages client (e.g. `client.beta.messages`). */
export interface AnthropicMessagesApiClient {
  create(params: {
    model: string;
    max_tokens: number;
    system?: string;
    messages: Array<{ role: string; content: unknown }>;
    tools?: Array<Record<string, unknown>>;
    output_config?: { effort?: string };
    fallback_credit_token?: string;
    betas?: string[];
  }): Promise<AnthropicRawResponse>;
}

/** Per-agent configuration for {@link AnthropicMessagesAdapter.registerModelAgent}. */
export interface AnthropicMessagesAgentConfig {
  /** The injected Anthropic Messages client. */
  client: AnthropicMessagesApiClient;
  /** Primary model (default: `claude-fable-5`). */
  model?: string;
  /** Ordered fallback models (default: `['claude-opus-4-8']`). */
  fallbackModels?: string[];
  /** System prompt. */
  systemPrompt?: string;
  /** Max tokens per call (default: 1024). */
  maxTokens?: number;
  /** Default effort level. */
  effort?: EffortLevel;
  /** Cross-model budget. */
  budget?: BudgetSink;
  /** Audit destination. */
  audit?: AuditSink;
  /** Refusal/fallback telemetry. */
  telemetry?: RefusalTelemetrySink;
  /** Thinking-block lifecycle manager. */
  thinking?: ThinkingSink;
  /** Effort governance policy. */
  effortPolicy?: EffortSink;
}

// ---------------------------------------------------------------------------
// Beta header for fallback-credit redemption
// ---------------------------------------------------------------------------

const FALLBACK_CREDIT_BETA = 'fallback-credit-2026-06-01';

/**
 * Map a raw Anthropic response to the gateway's normalized {@link ModelResponse}.
 *
 * @param raw             The native response.
 * @param requestedModel  The model that was requested (fallback when `raw.model` is absent).
 */
export function normalizeAnthropicResponse(raw: AnthropicRawResponse, requestedModel: string): ModelResponse {
  const content: ModelContentBlock[] = (raw.content ?? []).map((b) => ({ ...b }));
  const isRefusal = raw.stop_reason === 'refusal';
  const usage = raw.usage ?? {};

  const response: ModelResponse = {
    id: raw.id,
    model: raw.model || requestedModel,
    content,
    stopReason: raw.stop_reason,
    usage: {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    },
  };

  if (isRefusal) {
    const d = raw.stop_details ?? {};
    response.refusal = {
      category: (d.category ?? null) as RefusalCategory,
      explanation: d.explanation,
      fallbackCreditToken: d.fallback_credit_token ?? null,
      fallbackHasPrefillClaim: d.fallback_has_prefill_claim ?? null,
      recommendedModel: d.recommended_model ?? null,
    };
  } else {
    response.refusal = null;
  }

  return response;
}

/**
 * Build a normalized {@link ModelCaller} from an Anthropic Messages client.
 *
 * Uses **client-side** fallback (the gateway drives the chain), so it never
 * sets the server-side `fallbacks` parameter. When a fallback-credit token is
 * present it is forwarded with the `fallback-credit-2026-06-01` beta header so
 * the retry is repriced as a cache read.
 *
 * @param client  The injected Anthropic Messages client.
 * @returns       A `ModelCaller` the gateway can drive.
 */
export function createAnthropicCaller(client: AnthropicMessagesApiClient): ModelCaller {
  return async (req) => {
    const params: Parameters<AnthropicMessagesApiClient['create']>[0] = {
      model: req.model,
      max_tokens: req.maxTokens ?? 1024,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (req.system) params.system = req.system;
    if (req.tools) params.tools = req.tools as Array<Record<string, unknown>>;
    if (req.effort) params.output_config = { effort: req.effort };
    if (req.fallbackCreditToken) {
      params.fallback_credit_token = req.fallbackCreditToken;
      params.betas = [FALLBACK_CREDIT_BETA];
    }
    const raw = await client.create(params);
    return normalizeAnthropicResponse(raw, req.model);
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Governed Anthropic Messages adapter.
 *
 * Each registered agent runs through its own {@link GovernedModelGateway}, so a
 * single `executeAgent` call transparently handles refusals, cross-model
 * fallback, fallback-credit billing, and thinking-block handoff.
 *
 * @example
 * ```typescript
 * const adapter = new AnthropicMessagesAdapter();
 * await adapter.initialize({});
 * adapter.registerModelAgent('analyst', {
 *   client,                                  // your Anthropic client
 *   model: 'claude-fable-5',
 *   fallbackModels: ['claude-opus-4-8'],
 *   budget, audit, telemetry,
 * });
 * const result = await adapter.executeAgent('analyst', { action: 'Summarize…', params: {} }, ctx);
 * ```
 */
export class AnthropicMessagesAdapter extends BaseAdapter {
  readonly name = 'anthropic-messages';
  readonly version = '1.0.0';

  private agents = new Map<string, { gateway: GovernedModelGateway; config: AnthropicMessagesAgentConfig }>();

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

  /**
   * Register a model-backed agent. Builds a {@link GovernedModelGateway} wired
   * with the supplied budget/audit/telemetry/thinking/effort collaborators.
   */
  registerModelAgent(agentId: string, config: AnthropicMessagesAgentConfig): void {
    if (!agentId || typeof agentId !== 'string') {
      throw new TypeError('AnthropicMessagesAdapter.registerModelAgent: agentId must be a non-empty string');
    }
    if (!config || typeof config.client?.create !== 'function') {
      throw new TypeError('AnthropicMessagesAdapter.registerModelAgent: config.client.create must be a function');
    }

    const primaryModel = config.model ?? 'claude-fable-5';
    const gateway = new GovernedModelGateway({
      caller: createAnthropicCaller(config.client),
      primaryModel,
      fallbackModels: config.fallbackModels ?? ['claude-opus-4-8'],
      defaultEffort: config.effort,
      budget: config.budget,
      audit: config.audit,
      telemetry: config.telemetry,
      thinking: config.thinking ?? new ThinkingBlockManager(),
      effort: config.effortPolicy,
    });

    this.agents.set(agentId, { gateway, config });
    this.registerLocalAgent({
      id: agentId,
      name: agentId,
      status: 'available',
      capabilities: ['text', 'governed-fallback'],
      metadata: { adapter: this.name, model: primaryModel },
    });
  }

  async executeAgent(agentId: string, payload: AgentPayload, _context: AgentContext): Promise<AgentResult> {
    this.ensureReady();

    const entry = this.agents.get(agentId);
    if (!entry) {
      return this.errorResult('MODEL_AGENT_NOT_FOUND', `No agent registered as '${agentId}'`, false);
    }

    const instruction =
      payload.handoff?.instruction ?? (payload.params?.['instruction'] as string) ?? payload.action;
    const start = Date.now();

    try {
      const result = await entry.gateway.send({
        messages: [{ role: 'user', content: instruction }],
        system: entry.config.systemPrompt,
        maxTokens: entry.config.maxTokens,
        effort: entry.config.effort,
        agentId,
      });

      const durationMs = Date.now() - start;
      const text = result.response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n');

      const data = {
        response: text,
        servedModel: result.servedModel,
        servedByFallback: result.servedByFallback,
        refused: result.refused,
        refusalCategories: result.refusalCategories,
        attempts: result.attempts,
        totalCostUsd: result.totalCostUsd,
      };

      if (result.refused) {
        const category = result.refusalCategories[result.refusalCategories.length - 1] ?? null;
        return {
          success: false,
          data,
          error: {
            code: 'MODEL_REFUSED',
            message: `All models declined the request${category ? ` (category: ${category})` : ''}`,
            recoverable: false,
          },
          metadata: { adapter: this.name, executionTimeMs: durationMs },
        };
      }

      return this.successResult(data, durationMs);
    } catch (error) {
      return this.errorResult(
        'MODEL_EXECUTION_ERROR',
        error instanceof Error ? error.message : String(error),
        true,
        error,
      );
    }
  }
}
