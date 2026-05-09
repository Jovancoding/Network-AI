/**
 * Route Classifier — Short-Circuit Routing for Network-AI
 *
 * Classifies an incoming goal into one of three categories before any
 * DAG planning occurs. Simple factual lookups are routed directly to a
 * single agent, bypassing the Blackboard/locking layer entirely to save
 * latency and token cost. Complex synthesis uses the full DAG pipeline.
 * System failures are surfaced immediately.
 *
 * Zero external dependencies — the classifier function is pluggable so
 * callers can use any model (Haiku, Llama-3-8B, rule-based heuristic, …).
 *
 * @module RouteClassifier
 * @version 1.0.0
 */

// ============================================================================
// TYPES
// ============================================================================

/** The three routing categories. */
export type RouteCategory =
  | 'FACTUAL_LOOKUP'     // Simple, single-turn answer — bypass DAG + Blackboard
  | 'COMPLEX_SYNTHESIS'  // Requires full DAG decomposition + multi-agent execution
  | 'SYSTEM_FAILURE';    // Unrecoverable input problem — surface error immediately

/** Result produced by the classifier. */
export interface ClassificationResult {
  /** The routing decision. */
  category: RouteCategory;
  /** Human-readable explanation from the classifier. */
  rationale: string;
  /** Confidence score 0–1 (optional — classifiers may omit this). */
  confidence?: number;
  /** When classification completed (epoch ms). */
  classifiedAt: number;
}

/**
 * A function that classifies a goal string.
 *
 * Implement this with a fast model call, a rule-based heuristic, or a
 * combination.  Must resolve — never reject — returning SYSTEM_FAILURE
 * instead of throwing when the input is unclassifiable.
 */
export type ClassifierFunction = (goal: string) => Promise<ClassificationResult>;

/**
 * Result of a routed execution attempt (FACTUAL_LOOKUP path).
 * For COMPLEX_SYNTHESIS the caller handles execution via the normal DAG pipeline.
 */
export interface RouteResult {
  /** The classification that drove this route. */
  classification: ClassificationResult;
  /** True when the request was short-circuited (FACTUAL_LOOKUP). */
  shortCircuited: boolean;
  /** Agent output for the short-circuit path, undefined otherwise. */
  answer?: unknown;
  /** Error message for SYSTEM_FAILURE. */
  error?: string;
}

/** Options for {@link RouteClassifier}. */
export interface RouteClassifierOptions {
  /**
   * Agent ID to call for FACTUAL_LOOKUP responses.
   * Required when `executor` is provided.
   */
  lookupAgentId?: string;
}

// ============================================================================
// RULE-BASED HEURISTIC CLASSIFIER (built-in, zero model cost)
// ============================================================================

/**
 * A simple keyword / length heuristic classifier for when you don't want to
 * spend tokens on a model call for every request.
 *
 * Treats goals of ≤ 15 words with question-like phrasing as FACTUAL_LOOKUP
 * and everything else as COMPLEX_SYNTHESIS.
 */
export function createHeuristicClassifier(): ClassifierFunction {
  const LOOKUP_STARTERS = [
    'what is', 'what are', 'who is', 'who are', 'when is', 'when was',
    'where is', 'where was', 'how many', 'how much', 'define ', 'list ',
    'name ', 'tell me', 'give me', 'show me',
  ];

  return async (goal: string): Promise<ClassificationResult> => {
    const normalized = goal.trim().toLowerCase();

    if (!normalized) {
      return {
        category: 'SYSTEM_FAILURE',
        rationale: 'Goal is empty',
        confidence: 1,
        classifiedAt: Date.now(),
      };
    }

    const wordCount = normalized.split(/\s+/).length;
    const isShort = wordCount <= 15;
    const startsLikeQuestion = LOOKUP_STARTERS.some((s) => normalized.startsWith(s));
    const endsWithQuestion = normalized.endsWith('?');

    if (isShort && (startsLikeQuestion || endsWithQuestion)) {
      return {
        category: 'FACTUAL_LOOKUP',
        rationale: `Short goal (${wordCount} words) with question-like phrasing.`,
        confidence: 0.8,
        classifiedAt: Date.now(),
      };
    }

    return {
      category: 'COMPLEX_SYNTHESIS',
      rationale: `Goal requires multi-step reasoning (${wordCount} words).`,
      confidence: 0.75,
      classifiedAt: Date.now(),
    };
  };
}

/**
 * Build a classifier backed by an LLM via the Network-AI executor API.
 *
 * @param executor - The executor function from the adapter system
 * @param classifierAgentId - Agent ID for the fast classification model
 */
export function createLLMClassifier(
  executor: (
    agentId: string,
    payload: { action: string; params: Record<string, unknown> },
    context: { agentId: string; taskId: string; metadata?: Record<string, unknown> },
  ) => Promise<{ success: boolean; data?: unknown; error?: { message: string } }>,
  classifierAgentId: string,
): ClassifierFunction {
  return async (goal: string): Promise<ClassificationResult> => {
    const prompt = [
      'Classify the following goal into exactly one category:',
      '  FACTUAL_LOOKUP    — simple factual question answerable in one step',
      '  COMPLEX_SYNTHESIS — requires multi-step research/reasoning/execution',
      '  SYSTEM_FAILURE    — invalid, malformed, or unclassifiable input',
      '',
      `GOAL: ${goal}`,
      '',
      'Respond with ONLY valid JSON matching this schema:',
      '{"category":"FACTUAL_LOOKUP|COMPLEX_SYNTHESIS|SYSTEM_FAILURE","rationale":"...","confidence":0.0-1.0}',
    ].join('\n');

    try {
      const result = await executor(
        classifierAgentId,
        { action: 'classify', params: { prompt } },
        { agentId: classifierAgentId, taskId: `classify-${Date.now()}`, metadata: { type: 'route-classification' } },
      );

      if (!result.success || !result.data) {
        return {
          category: 'COMPLEX_SYNTHESIS',
          rationale: 'Classifier returned no data — defaulting to COMPLEX_SYNTHESIS',
          confidence: 0.5,
          classifiedAt: Date.now(),
        };
      }

      // Parse response
      let parsed: { category: RouteCategory; rationale: string; confidence?: number };
      const raw = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
      try {
        // Strip markdown fences
        const cleaned = raw.replace(/```[a-z]*\n?/g, '').replace(/```/g, '').trim();
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        parsed = JSON.parse(cleaned.substring(start, end + 1));
      } catch {
        return {
          category: 'COMPLEX_SYNTHESIS',
          rationale: 'Classifier response parse failed — defaulting to COMPLEX_SYNTHESIS',
          confidence: 0.4,
          classifiedAt: Date.now(),
        };
      }

      const validCategories: RouteCategory[] = ['FACTUAL_LOOKUP', 'COMPLEX_SYNTHESIS', 'SYSTEM_FAILURE'];
      const category = validCategories.includes(parsed.category) ? parsed.category : 'COMPLEX_SYNTHESIS';

      return {
        category,
        rationale: parsed.rationale ?? '',
        confidence: typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : undefined,
        classifiedAt: Date.now(),
      };
    } catch (err) {
      return {
        category: 'COMPLEX_SYNTHESIS',
        rationale: `Classifier error (${(err as Error).message}) — defaulting to COMPLEX_SYNTHESIS`,
        confidence: 0.3,
        classifiedAt: Date.now(),
      };
    }
  };
}

// ============================================================================
// ROUTE CLASSIFIER
// ============================================================================

/**
 * RouteClassifier evaluates a goal before DAG planning begins and decides
 * whether to short-circuit to a single agent (FACTUAL_LOOKUP) or proceed
 * with the full multi-agent pipeline (COMPLEX_SYNTHESIS).
 *
 * @example
 * ```typescript
 * const classifier = new RouteClassifier(createHeuristicClassifier());
 * const { category } = await classifier.classify('What is the capital of France?');
 * // category === 'FACTUAL_LOOKUP'
 * ```
 */
export class RouteClassifier {
  private classifierFn: ClassifierFunction;
  private options: RouteClassifierOptions;

  constructor(classifierFn: ClassifierFunction, options: RouteClassifierOptions = {}) {
    this.classifierFn = classifierFn;
    this.options = options;
  }

  /**
   * Classify a goal.
   */
  async classify(goal: string): Promise<ClassificationResult> {
    if (!goal || typeof goal !== 'string') {
      return {
        category: 'SYSTEM_FAILURE',
        rationale: 'Goal must be a non-empty string',
        confidence: 1,
        classifiedAt: Date.now(),
      };
    }
    return this.classifierFn(goal);
  }

  /**
   * Classify a goal and, if FACTUAL_LOOKUP, short-circuit to a single agent.
   *
   * Returns the classification result and, when short-circuited, the agent's
   * direct answer. The caller should check `result.shortCircuited` — if false,
   * proceed with the normal DAG pipeline.
   *
   * @param goal - Natural language goal
   * @param executor - Agent executor (required for FACTUAL_LOOKUP short-circuit)
   * @param fallbackAgentId - Agent to call on FACTUAL_LOOKUP (overrides options.lookupAgentId)
   */
  async route(
    goal: string,
    executor?: (
      agentId: string,
      payload: { action: string; params: Record<string, unknown> },
      context: { agentId: string; taskId: string; metadata?: Record<string, unknown> },
    ) => Promise<{ success: boolean; data?: unknown; error?: { message: string } }>,
    fallbackAgentId?: string,
  ): Promise<RouteResult> {
    const classification = await this.classify(goal);

    if (classification.category === 'SYSTEM_FAILURE') {
      return {
        classification,
        shortCircuited: true,
        error: `System failure: ${classification.rationale}`,
      };
    }

    if (classification.category === 'FACTUAL_LOOKUP') {
      const agentId = fallbackAgentId ?? this.options.lookupAgentId;

      if (!executor || !agentId) {
        // No executor configured — fall through to DAG pipeline
        return { classification, shortCircuited: false };
      }

      try {
        const result = await executor(
          agentId,
          { action: 'answer', params: { goal } },
          { agentId, taskId: `lookup-${Date.now()}`, metadata: { type: 'factual-lookup' } },
        );
        return {
          classification,
          shortCircuited: true,
          answer: result.data,
          error: result.success ? undefined : result.error?.message,
        };
      } catch (err) {
        return {
          classification,
          shortCircuited: true,
          error: (err as Error).message,
        };
      }
    }

    // COMPLEX_SYNTHESIS — proceed with DAG
    return { classification, shortCircuited: false };
  }
}
