/**
 * Coverage Gate — Recursive Refinement Loop for Network-AI
 *
 * Prevents the system from finishing with incomplete data by acting as a
 * gatekeeper before the `submit_final` action is allowed. An evaluator LLM
 * scores the current Blackboard state against the original user goal and
 * produces a gap list. If the score is below the configured threshold the
 * orchestrator feeds the gaps back into GoalDecomposer to generate new
 * sub-tasks. Execution only reaches the COMPLETE state when the score
 * clears the threshold (or the maximum refinement count is reached).
 *
 * The EVALUATING FSM state (added to WORKFLOW_STATES) signals that a
 * refinement loop is in progress.
 *
 * Zero external dependencies — the evaluator function is pluggable.
 *
 * @module CoverageGate
 * @version 1.0.0
 */

// ============================================================================
// TYPES
// ============================================================================

/** Output from a coverage evaluation call. */
export interface CoverageResult {
  /** 0–100 completeness score. */
  score: number;
  /** List of topics / questions the current state does NOT yet cover. */
  gaps: string[];
  /** Human-readable evaluation summary. */
  summary: string;
  /** When the evaluation was completed (epoch ms). */
  evaluatedAt: number;
}

/**
 * A function that evaluates the current blackboard state against the original
 * goal and returns a CoverageResult.
 *
 * Implement with an LLM call (Claude, GPT-4o, …) or a deterministic
 * heuristic. Must always resolve — never reject.
 *
 * @param goal - The original user goal
 * @param blackboardSummary - A serialisable snapshot of the current blackboard
 */
export type CoverageEvaluatorFunction = (
  goal: string,
  blackboardSummary: Record<string, unknown>,
) => Promise<CoverageResult>;

/** Options for {@link CoverageGate}. */
export interface CoverageGateOptions {
  /**
   * Minimum score (0–100) needed to pass the gate.
   * Default: 90.
   */
  threshold?: number;
  /**
   * Maximum number of refinement rounds before accepting the result even if
   * the threshold is not met. Prevents infinite loops.
   * Default: 3.
   */
  maxRefinements?: number;
}

/** Outcome of a single {@link CoverageGate.evaluate} call. */
export interface CoverageGateResult {
  /** Whether the gate was passed (score ≥ threshold). */
  passed: boolean;
  /** The evaluation result from the evaluator. */
  evaluation: CoverageResult;
  /** The threshold that was applied. */
  threshold: number;
  /** Number of refinement rounds that have been run so far. */
  refinementsUsed: number;
  /** Whether the maximum refinements limit was reached. */
  maxRefinementsReached: boolean;
}

/** Describes one pass through the coverage refinement loop. */
export interface RefinementRound {
  round: number;
  evaluation: CoverageResult;
  passed: boolean;
  gapsRequeued: string[];
}

// ============================================================================
// BUILT-IN EVALUATORS
// ============================================================================

/**
 * A simple keyword-gap evaluator that checks whether each expected topic
 * keyword appears anywhere in the stringified blackboard values.
 *
 * Useful for deterministic tests and quick smoke-tests without an LLM.
 *
 * @param expectedTopics - List of keywords/phrases that must appear in the board
 */
export function createKeywordEvaluator(expectedTopics: string[]): CoverageEvaluatorFunction {
  return async (goal: string, blackboardSummary: Record<string, unknown>): Promise<CoverageResult> => {
    const stateText = JSON.stringify(blackboardSummary).toLowerCase();
    const gaps: string[] = [];

    for (const topic of expectedTopics) {
      if (!stateText.includes(topic.toLowerCase())) {
        gaps.push(topic);
      }
    }

    const covered = expectedTopics.length - gaps.length;
    const score = expectedTopics.length === 0
      ? 100
      : Math.round((covered / expectedTopics.length) * 100);

    return {
      score,
      gaps,
      summary: `Covered ${covered}/${expectedTopics.length} expected topics. Missing: ${gaps.length === 0 ? 'none' : gaps.join(', ')}.`,
      evaluatedAt: Date.now(),
    };
  };
}

/**
 * Build an evaluator backed by an LLM via the Network-AI executor API.
 *
 * @param executor - Network-AI executor function
 * @param evaluatorAgentId - Agent ID for the evaluator model
 */
export function createLLMEvaluator(
  executor: (
    agentId: string,
    payload: { action: string; params: Record<string, unknown> },
    context: { agentId: string; taskId: string; metadata?: Record<string, unknown> },
  ) => Promise<{ success: boolean; data?: unknown; error?: { message: string } }>,
  evaluatorAgentId: string,
): CoverageEvaluatorFunction {
  return async (goal: string, blackboardSummary: Record<string, unknown>): Promise<CoverageResult> => {
    const prompt = [
      'You are a coverage evaluator for a multi-agent AI system.',
      'Evaluate how completely the current state addresses the original goal.',
      '',
      `ORIGINAL GOAL: ${goal}`,
      '',
      'CURRENT STATE (Blackboard summary):',
      JSON.stringify(blackboardSummary, null, 2),
      '',
      'Score the completeness from 0 to 100 and list any remaining gaps.',
      '',
      'Respond with ONLY valid JSON:',
      '{"score":0-100,"gaps":["gap 1","gap 2"],"summary":"..."}',
    ].join('\n');

    try {
      const result = await executor(
        evaluatorAgentId,
        { action: 'evaluate', params: { prompt, goal } },
        { agentId: evaluatorAgentId, taskId: `coverage-eval-${Date.now()}`, metadata: { type: 'coverage-evaluation' } },
      );

      if (!result.success || !result.data) {
        return {
          score: 0,
          gaps: [result.error?.message ?? 'Evaluator returned no data'],
          summary: 'Evaluation failed — treating as incomplete',
          evaluatedAt: Date.now(),
        };
      }

      const raw = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
      // Strip markdown fences
      let cleaned = raw.trim().replace(/```[a-z]*\n?/g, '').replace(/```/g, '').trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start !== -1 && end > start) cleaned = cleaned.substring(start, end + 1);

      let parsed: { score: number; gaps: string[]; summary: string };
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        return {
          score: 50,
          gaps: ['Could not parse evaluator response'],
          summary: 'Parse error — defaulting to score 50',
          evaluatedAt: Date.now(),
        };
      }

      return {
        score: Math.min(100, Math.max(0, Number(parsed.score) || 0)),
        gaps: Array.isArray(parsed.gaps) ? parsed.gaps.map(String) : [],
        summary: String(parsed.summary ?? ''),
        evaluatedAt: Date.now(),
      };
    } catch (err) {
      return {
        score: 0,
        gaps: [(err as Error).message],
        summary: `Evaluator threw: ${(err as Error).message}`,
        evaluatedAt: Date.now(),
      };
    }
  };
}

// ============================================================================
// COVERAGE GATE (OOP interface)
// ============================================================================

/**
 * CoverageGate is the final gatekeeper before `submit_final`.
 *
 * Call `evaluate()` after each execution round. If it returns `passed: false`,
 * use `result.evaluation.gaps` to generate additional sub-tasks via
 * GoalDecomposer, then re-run and evaluate again.
 *
 * @example
 * ```typescript
 * const gate = new CoverageGate(myLLMEvaluator, { threshold: 90, maxRefinements: 3 });
 *
 * let boardSnapshot = blackboard.snapshot();
 * let gateResult = await gate.evaluate(goal, boardSnapshot);
 *
 * while (!gateResult.passed && !gateResult.maxRefinementsReached) {
 *   const gapGoal = `Fill these gaps: ${gateResult.evaluation.gaps.join(', ')}`;
 *   const gapDag  = await decomposer.decompose(gapGoal, agents);
 *   await runner.run(gapDag, runOptions);
 *   boardSnapshot = blackboard.snapshot();
 *   gateResult = await gate.evaluate(goal, boardSnapshot);
 * }
 * ```
 */
export class CoverageGate {
  private evaluatorFn: CoverageEvaluatorFunction;
  private threshold: number;
  private maxRefinements: number;
  private _refinementsUsed = 0;
  private _history: RefinementRound[] = [];

  constructor(evaluatorFn: CoverageEvaluatorFunction, options: CoverageGateOptions = {}) {
    this.evaluatorFn = evaluatorFn;
    this.threshold = Math.min(100, Math.max(0, options.threshold ?? 90));
    this.maxRefinements = Math.max(0, options.maxRefinements ?? 3);
  }

  /**
   * Evaluate the current blackboard state against the original goal.
   *
   * Each call increments the internal refinement counter. When
   * `maxRefinements` is reached the gate is treated as passed (fail-open)
   * to prevent infinite loops, and `maxRefinementsReached` is set to true.
   *
   * @param goal - Original user goal
   * @param blackboardSummary - Current blackboard snapshot (key → value)
   */
  async evaluate(
    goal: string,
    blackboardSummary: Record<string, unknown>,
  ): Promise<CoverageGateResult> {
    const evaluation = await this.evaluatorFn(goal, blackboardSummary);
    const maxRefinementsReached = this._refinementsUsed >= this.maxRefinements;
    const passed = evaluation.score >= this.threshold || maxRefinementsReached;

    const round: RefinementRound = {
      round: this._refinementsUsed + 1,
      evaluation,
      passed,
      gapsRequeued: passed ? [] : evaluation.gaps,
    };
    this._history.push(round);

    if (!passed) {
      this._refinementsUsed++;
    }

    return {
      passed,
      evaluation,
      threshold: this.threshold,
      refinementsUsed: this._refinementsUsed,
      maxRefinementsReached,
    };
  }

  /** Reset the refinement counter and history (allows reuse across separate goals). */
  reset(): void {
    this._refinementsUsed = 0;
    this._history = [];
  }

  /** History of all refinement rounds evaluated so far. */
  get history(): readonly RefinementRound[] {
    return this._history;
  }

  /** Current refinement count (before this becomes a pass-through). */
  get refinementsUsed(): number {
    return this._refinementsUsed;
  }

  /** The configured threshold (0–100). */
  get scoreThreshold(): number {
    return this.threshold;
  }
}
