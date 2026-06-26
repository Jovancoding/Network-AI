/**
 * GovernedModelGateway — model-interaction lifecycle governance.
 *
 * Absorbs a frontier model's refusal → fallback → billing complexity and
 * presents one governed, budgeted, audited interface. When the primary model
 * declines a request with a classifier refusal (`stop_reason: "refusal"`), the
 * gateway:
 *
 *   1. records the refusal (which classifier `category` fired) to the audit sink,
 *   2. emits a refusal signal to telemetry (a refusal is an HTTP 200, *not* an
 *      error — it is invisible to error-rate monitoring),
 *   3. retries on the next model in the fallback chain, redeeming the one-time
 *      fallback-credit token so the retry is repriced as a cache read,
 *   4. strips model-specific thinking blocks when it switches models (unless a
 *      credit is being redeemed, which requires an exact body match),
 *   5. accounts each attempt's cost against the cross-model budget.
 *
 * This layer is **provider-agnostic**. It operates on a normalized
 * {@link ModelCaller}; the concrete provider binding (e.g. the Anthropic
 * Messages adapter) maps the native API to these shapes. Unlike
 * `AdapterRegistry.fallbackChain` — which fails over on adapter *health*
 * (`CircuitOpenError`) — this gateway falls over on a *classifier refusal*.
 *
 * @module GovernedModelGateway
 * @version 1.0.0
 * @license MIT
 */

// ============================================================================
// NORMALIZED MODEL I/O (provider-agnostic)
// ============================================================================

/** Effort levels, lowest to highest cost/depth. Mirrors `output_config.effort`. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Classifier categories a refusal can carry. `null` when the refusal does not
 * map to a named category (a normal, permanent value — not a placeholder).
 */
export type RefusalCategory = 'cyber' | 'bio' | 'frontier_llm' | 'reasoning_extraction' | null;

/** A single conversation message in normalized form. */
export interface ModelMessage {
  role: string;
  content: unknown;
}

/** A normalized content block. `thinking`/`signature` appear on thinking blocks. */
export interface ModelContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  [key: string]: unknown;
}

/** Per-attempt token usage, normalized across providers. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/**
 * Refusal metadata extracted from a declined response. Present only when
 * `stopReason === 'refusal'`.
 */
export interface RefusalDetails {
  /** Policy area that triggered the classifier, or `null` if unnamed. */
  category: RefusalCategory;
  /** Human-readable description. Display it; do not parse it (text is unstable). */
  explanation?: string;
  /** One-time credit token that reprices the fallback retry. ~5-minute TTL. */
  fallbackCreditToken?: string | null;
  /** Whether the retry may continue the refused model's partial output. */
  fallbackHasPrefillClaim?: boolean | null;
  /** Model to retry directly when a configured fallback could not run. */
  recommendedModel?: string | null;
}

/** A normalized request to a single model. */
export interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  system?: string;
  maxTokens?: number;
  tools?: unknown[];
  /** Soft cost/depth signal; the primary lever on per-token spend. */
  effort?: EffortLevel;
  /** When set, the caller should redeem this credit on the retry. */
  fallbackCreditToken?: string;
  metadata?: Record<string, unknown>;
}

/** A normalized response from a single model. */
export interface ModelResponse {
  id?: string;
  /** The model that actually produced this response. */
  model: string;
  content: ModelContentBlock[];
  stopReason: string | null;
  /** Refusal metadata when `stopReason === 'refusal'`, else `null`/absent. */
  refusal?: RefusalDetails | null;
  usage: ModelUsage;
}

/**
 * Provider-agnostic model invocation. A concrete adapter (Anthropic, etc.)
 * implements this by mapping the native API to {@link ModelRequest} /
 * {@link ModelResponse}.
 */
export type ModelCaller = (request: ModelRequest) => Promise<ModelResponse>;

// ============================================================================
// OPTIONAL COLLABORATORS (structural — no hard dependency on concrete classes)
// ============================================================================

/** Records one attempt's cost. {@link ../lib/model-budget!ModelBudget} satisfies this. */
export interface BudgetSink {
  recordAttempt(
    model: string,
    usage: ModelUsage,
    opts?: { creditRedeemed?: boolean; agentId?: string },
  ): { costUsd: number; remainingUsd: number; allowed: boolean };
}

/** Append-only audit destination. */
export interface AuditSink {
  log(event: Record<string, unknown>): void | Promise<void>;
}

/** Thinking-block lifecycle hook. {@link ThinkingBlockManager} satisfies this. */
export interface ThinkingSink {
  /** Strip thinking blocks from prior turns before a cross-model retry. */
  stripForModelSwitch(messages: ModelMessage[]): ModelMessage[];
}

/** Effort governance hook. {@link EffortPolicy} satisfies this. */
export interface EffortSink {
  resolve(requested: EffortLevel | undefined, ctx: { agentId?: string }): EffortLevel | undefined;
}

/** Refusal observability hook. {@link RefusalTelemetry} satisfies this. */
export interface RefusalTelemetrySink {
  recordRefusal(info: { model: string; category: RefusalCategory; agentId?: string }): void;
  recordFallbackServed(info: { requestedModel: string; servedModel: string; agentId?: string }): void;
}

// ============================================================================
// GATEWAY CONFIG & RESULT
// ============================================================================

/** Construction options for {@link GovernedModelGateway}. */
export interface GovernedModelGatewayConfig {
  /** Normalized model invocation. Required. */
  caller: ModelCaller;
  /** Model tried first. Required, non-empty. */
  primaryModel: string;
  /** Ordered fallback models, tried after a refusal. */
  fallbackModels?: string[];
  /** Default effort applied when a request omits one. */
  defaultEffort?: EffortLevel;
  /** Maximum number of fallback attempts (default: `fallbackModels.length`). */
  maxFallbacks?: number;
  /** Permitted fallback targets per model (mirrors `allowed_fallback_models`). */
  allowedFallbacks?: Record<string, string[]>;
  /** Cross-model cost accounting. */
  budget?: BudgetSink;
  /** Audit destination for every attempt and refusal. */
  audit?: AuditSink;
  /** Refusal / fallback observability. */
  telemetry?: RefusalTelemetrySink;
  /** Thinking-block lifecycle manager. */
  thinking?: ThinkingSink;
  /** Effort governance policy. */
  effort?: EffortSink;
}

/** A single attempt in the fallback chain — the source of truth for billing. */
export interface GatewayAttempt {
  model: string;
  stopReason: string | null;
  refusalCategory: RefusalCategory;
  usage: ModelUsage;
  costUsd?: number;
  servedByFallback: boolean;
  creditRedeemed: boolean;
}

/** A request to the gateway. The gateway, not the caller, picks the model. */
export interface GovernedSendRequest {
  messages: ModelMessage[];
  system?: string;
  maxTokens?: number;
  tools?: unknown[];
  effort?: EffortLevel;
  /** Used for audit/telemetry/budget attribution. */
  agentId?: string;
  metadata?: Record<string, unknown>;
}

/** The governed outcome of a {@link GovernedModelGateway.send} call. */
export interface GovernedModelResult {
  /** The response that served the turn, or the final refusal if all declined. */
  response: ModelResponse;
  /** Model that ultimately served (or was last attempted). */
  servedModel: string;
  /** `true` when every model in the chain refused. */
  refused: boolean;
  /** `true` when a fallback (not the primary) served the response. */
  servedByFallback: boolean;
  /** Per-attempt record. Use this for billing and serving-model analytics. */
  attempts: GatewayAttempt[];
  /** Distinct refusal categories encountered across attempts. */
  refusalCategories: RefusalCategory[];
  /** Sum of attempt costs when a budget is configured. */
  totalCostUsd?: number;
}

// ============================================================================
// HELPERS
// ============================================================================

/** Whether a response is a classifier refusal. Branch on this, not on content. */
export function isRefusal(response: ModelResponse): boolean {
  return response.stopReason === 'refusal';
}

// ============================================================================
// GATEWAY
// ============================================================================

/**
 * Governs the full model-interaction lifecycle: refusal detection, cross-model
 * fallback, fallback-credit redemption, thinking-block handoff, and per-attempt
 * cost accounting — behind one {@link GovernedModelGateway.send} call.
 *
 * @example
 * ```typescript
 * const gateway = new GovernedModelGateway({
 *   caller,                       // provider binding (e.g. Anthropic adapter)
 *   primaryModel: 'claude-fable-5',
 *   fallbackModels: ['claude-opus-4-8'],
 *   budget, audit, telemetry, thinking, effort,
 * });
 *
 * const r = await gateway.send({ messages: [{ role: 'user', content: 'hi' }] });
 * console.log(r.servedModel, r.servedByFallback, r.totalCostUsd);
 * ```
 */
export class GovernedModelGateway {
  private readonly caller: ModelCaller;
  private readonly primaryModel: string;
  private readonly fallbackModels: string[];
  private readonly defaultEffort: EffortLevel | undefined;
  private readonly maxFallbacks: number;
  private readonly allowedFallbacks: Record<string, string[]> | undefined;
  private readonly budget: BudgetSink | undefined;
  private readonly audit: AuditSink | undefined;
  private readonly telemetry: RefusalTelemetrySink | undefined;
  private readonly thinking: ThinkingSink | undefined;
  private readonly effortPolicy: EffortSink | undefined;

  constructor(config: GovernedModelGatewayConfig) {
    if (typeof config.caller !== 'function') {
      throw new TypeError('GovernedModelGateway: caller must be a function');
    }
    if (!config.primaryModel || typeof config.primaryModel !== 'string') {
      throw new TypeError('GovernedModelGateway: primaryModel must be a non-empty string');
    }
    this.caller = config.caller;
    this.primaryModel = config.primaryModel;
    this.fallbackModels = (config.fallbackModels ?? []).filter((m) => m && m !== config.primaryModel);
    this.defaultEffort = config.defaultEffort;
    this.maxFallbacks = config.maxFallbacks ?? this.fallbackModels.length;
    this.allowedFallbacks = config.allowedFallbacks;
    this.budget = config.budget;
    this.audit = config.audit;
    this.telemetry = config.telemetry;
    this.thinking = config.thinking;
    this.effortPolicy = config.effort;
  }

  /**
   * Send a request through the governed lifecycle.
   *
   * Tries the primary model, then walks the fallback chain on each refusal,
   * redeeming fallback credit and stripping cross-model thinking blocks as it
   * goes. Returns once a model serves the turn or the chain is exhausted.
   *
   * @param request  The request. The gateway selects the model(s).
   * @returns        A {@link GovernedModelResult} describing every attempt.
   */
  async send(request: GovernedSendRequest): Promise<GovernedModelResult> {
    if (!request || !Array.isArray(request.messages)) {
      throw new TypeError('GovernedModelGateway.send: request.messages must be an array');
    }

    const agentId = request.agentId;
    const effort = this.resolveEffort(request.effort, agentId);
    const chain = this.buildChain();

    const attempts: GatewayAttempt[] = [];
    const categories: RefusalCategory[] = [];
    let totalCostUsd: number | undefined;
    let lastResponse: ModelResponse | undefined;
    let creditToken: string | undefined;

    for (let i = 0; i < chain.length; i++) {
      const model = chain[i];
      const isFallback = i > 0;
      const redeeming = Boolean(creditToken);

      // When redeeming a credit the body must match the refused request exactly,
      // so thinking blocks stay. Otherwise, strip them on a model switch.
      const messages =
        isFallback && !redeeming && this.thinking
          ? this.thinking.stripForModelSwitch(request.messages)
          : request.messages;

      const req: ModelRequest = {
        model,
        messages,
        system: request.system,
        maxTokens: request.maxTokens,
        tools: request.tools,
        effort,
        fallbackCreditToken: creditToken,
        metadata: request.metadata,
      };

      const response = await this.caller(req);
      lastResponse = response;

      const refusal = isRefusal(response);
      const category: RefusalCategory = refusal ? response.refusal?.category ?? null : null;

      // Cost accounting (per attempt — never sum tokens across models).
      let costUsd: number | undefined;
      let budgetAllowed = true;
      if (this.budget) {
        const rec = this.budget.recordAttempt(response.model, response.usage, {
          creditRedeemed: redeeming,
          agentId,
        });
        costUsd = rec.costUsd;
        budgetAllowed = rec.allowed;
        totalCostUsd = (totalCostUsd ?? 0) + rec.costUsd;
      }

      attempts.push({
        model: response.model,
        stopReason: response.stopReason,
        refusalCategory: category,
        usage: response.usage,
        costUsd,
        servedByFallback: isFallback,
        creditRedeemed: redeeming,
      });

      await this.auditAttempt(agentId, response, isFallback, redeeming, costUsd);

      if (!refusal) {
        // A model served the turn.
        if (isFallback) {
          this.telemetry?.recordFallbackServed({
            requestedModel: this.primaryModel,
            servedModel: response.model,
            agentId,
          });
        }
        return {
          response,
          servedModel: response.model,
          refused: false,
          servedByFallback: isFallback,
          attempts,
          refusalCategories: categories,
          totalCostUsd,
        };
      }

      // Refusal: record the signal (refusal !== error), capture credit, continue.
      categories.push(category);
      this.telemetry?.recordRefusal({ model: response.model, category, agentId });
      creditToken = response.refusal?.fallbackCreditToken ?? undefined;

      if (!budgetAllowed) break; // budget exhausted — stop trying fallbacks
    }

    // Every model in the chain refused (or the budget stopped us).
    const finalResponse: ModelResponse = lastResponse ?? {
      model: this.primaryModel,
      content: [],
      stopReason: 'refusal',
      usage: { inputTokens: 0, outputTokens: 0 },
    };

    return {
      response: finalResponse,
      servedModel: finalResponse.model,
      refused: true,
      servedByFallback: false,
      attempts,
      refusalCategories: categories,
      totalCostUsd,
    };
  }

  /** The ordered model chain: primary followed by permitted fallbacks. */
  private buildChain(): string[] {
    let fallbacks = this.fallbackModels;
    if (this.allowedFallbacks) {
      const permitted = this.allowedFallbacks[this.primaryModel];
      if (permitted) {
        fallbacks = fallbacks.filter((m) => permitted.includes(m));
      }
    }
    return [this.primaryModel, ...fallbacks.slice(0, Math.max(0, this.maxFallbacks))];
  }

  private resolveEffort(requested: EffortLevel | undefined, agentId?: string): EffortLevel | undefined {
    if (this.effortPolicy) {
      return this.effortPolicy.resolve(requested ?? this.defaultEffort, { agentId });
    }
    return requested ?? this.defaultEffort;
  }

  private async auditAttempt(
    agentId: string | undefined,
    response: ModelResponse,
    isFallback: boolean,
    creditRedeemed: boolean,
    costUsd: number | undefined,
  ): Promise<void> {
    if (!this.audit) return;
    const refusal = isRefusal(response);
    try {
      await this.audit.log({
        event: refusal ? 'model.refusal' : 'model.attempt',
        agentId: agentId ?? null,
        model: response.model,
        stopReason: response.stopReason,
        refusalCategory: refusal ? response.refusal?.category ?? null : null,
        refusalExplanation: refusal ? response.refusal?.explanation ?? null : undefined,
        servedByFallback: isFallback,
        creditRedeemed,
        costUsd: costUsd ?? null,
        usage: response.usage,
        ts: new Date().toISOString(),
      });
    } catch {
      // Audit is best-effort — never break the model lifecycle for logging.
    }
  }
}
