/**
 * ComparisonRunner — Run the same goal across two adapter configurations side-by-side
 *
 * Executes identical tasks through two different adapter setups and produces
 * a structured comparison of results, timing, cost, and quality.
 *
 * Usage:
 *   const runner = new ComparisonRunner();
 *   const result = await runner.compare({
 *     goal: { action: 'review', params: { code: '...' } },
 *     configA: { name: 'GPT-4', adapter: openaiAdapter },
 *     configB: { name: 'Claude', adapter: anthropicAdapter },
 *   });
 *   runner.printReport(result);
 *
 * @module ComparisonRunner
 * @version 1.0.0
 */

// ============================================================================
// TYPES
// ============================================================================

/** A handler that executes a goal payload and returns a result */
export type ComparisonHandler = (
  payload: Record<string, unknown>,
) => Promise<ComparisonOutput>;

/** Output from a single execution */
export interface ComparisonOutput {
  /** Whether execution succeeded */
  success: boolean;
  /** Result data */
  data?: unknown;
  /** Error message if failed */
  error?: string;
  /** Token usage (if available) */
  tokens?: { input?: number; output?: number };
  /** Estimated cost in USD (if available) */
  costUsd?: number;
  /** Any additional metadata */
  metadata?: Record<string, unknown>;
}

/** Configuration for one side of the comparison */
export interface ComparisonConfig {
  /** Human-readable name (e.g. 'GPT-4o', 'Claude Sonnet') */
  name: string;
  /** Handler to execute the goal */
  handler: ComparisonHandler;
}

/** Input to a comparison run */
export interface ComparisonInput {
  /** The goal/task payload to execute */
  goal: Record<string, unknown>;
  /** First configuration */
  configA: ComparisonConfig;
  /** Second configuration */
  configB: ComparisonConfig;
  /** Number of runs per config (default: 1) */
  runs?: number;
  /** Optional quality scorer (0-100) */
  scorer?: (output: ComparisonOutput) => number;
}

/** Result from a single run */
export interface RunResult {
  output: ComparisonOutput;
  durationMs: number;
  runIndex: number;
}

/** Side result (all runs for one config) */
export interface SideResult {
  name: string;
  runs: RunResult[];
  avgDurationMs: number;
  avgScore: number | null;
  avgCostUsd: number | null;
  successRate: number;
}

/** Full comparison result */
export interface ComparisonResult {
  goal: Record<string, unknown>;
  a: SideResult;
  b: SideResult;
  winner: 'A' | 'B' | 'TIE';
  winReason: string;
  comparedAt: number;
}

// ============================================================================
// RUNNER
// ============================================================================

/**
 * ComparisonRunner — Side-by-side adapter comparison.
 */
export class ComparisonRunner {
  /**
   * Run the same goal through two configurations and compare results.
   */
  async compare(input: ComparisonInput): Promise<ComparisonResult> {
    const runs = input.runs ?? 1;

    const [runsA, runsB] = await Promise.all([
      this.runSide(input.configA, input.goal, runs, input.scorer),
      this.runSide(input.configB, input.goal, runs, input.scorer),
    ]);

    const a = this.aggregateSide(input.configA.name, runsA, input.scorer);
    const b = this.aggregateSide(input.configB.name, runsB, input.scorer);

    const { winner, winReason } = this.determineWinner(a, b);

    return {
      goal: input.goal,
      a,
      b,
      winner,
      winReason,
      comparedAt: Date.now(),
    };
  }

  /**
   * Print a human-readable comparison report.
   */
  printReport(result: ComparisonResult): void {
    const { a, b } = result;
    console.log('═'.repeat(60));
    console.log('  COMPARISON REPORT');
    console.log('═'.repeat(60));
    console.log(`  A: ${a.name}`);
    console.log(`  B: ${b.name}`);
    console.log('─'.repeat(60));

    const rows: Array<[string, string, string]> = [
      ['Metric', a.name, b.name],
      ['Success Rate', `${pct(a.successRate)}`, `${pct(b.successRate)}`],
      ['Avg Duration', `${a.avgDurationMs.toFixed(0)}ms`, `${b.avgDurationMs.toFixed(0)}ms`],
    ];

    if (a.avgScore !== null) {
      rows.push(['Avg Score', `${a.avgScore.toFixed(1)}`, `${b.avgScore?.toFixed(1) ?? 'N/A'}`]);
    }
    if (a.avgCostUsd !== null) {
      rows.push(['Avg Cost', `$${a.avgCostUsd.toFixed(4)}`, `$${b.avgCostUsd?.toFixed(4) ?? 'N/A'}`]);
    }

    for (const [label, va, vb] of rows) {
      console.log(`  ${label.padEnd(20)} ${va.padEnd(18)} ${vb}`);
    }

    console.log('─'.repeat(60));
    console.log(`  Winner: ${result.winner === 'TIE' ? 'TIE' : result.winner === 'A' ? a.name : b.name}`);
    console.log(`  Reason: ${result.winReason}`);
    console.log('═'.repeat(60));
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private async runSide(
    config: ComparisonConfig,
    goal: Record<string, unknown>,
    runs: number,
    _scorer?: (output: ComparisonOutput) => number,
  ): Promise<RunResult[]> {
    const results: RunResult[] = [];
    for (let i = 0; i < runs; i++) {
      const start = Date.now();
      let output: ComparisonOutput;
      try {
        output = await config.handler(goal);
      } catch (err: unknown) {
        output = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      results.push({ output, durationMs: Date.now() - start, runIndex: i });
    }
    return results;
  }

  private aggregateSide(
    name: string,
    runs: RunResult[],
    scorer?: (output: ComparisonOutput) => number,
  ): SideResult {
    const avgDurationMs = runs.reduce((s, r) => s + r.durationMs, 0) / runs.length;
    const successRate = runs.filter((r) => r.output.success).length / runs.length;

    let avgScore: number | null = null;
    if (scorer) {
      const scores = runs.map((r) => scorer(r.output));
      avgScore = scores.reduce((s, v) => s + v, 0) / scores.length;
    }

    let avgCostUsd: number | null = null;
    const costs = runs.map((r) => r.output.costUsd).filter((c): c is number => c !== undefined);
    if (costs.length > 0) {
      avgCostUsd = costs.reduce((s, c) => s + c, 0) / costs.length;
    }

    return { name, runs, avgDurationMs, avgScore, avgCostUsd, successRate };
  }

  private determineWinner(a: SideResult, b: SideResult): { winner: 'A' | 'B' | 'TIE'; winReason: string } {
    // Priority: success rate > score > speed > cost
    if (a.successRate !== b.successRate) {
      const w = a.successRate > b.successRate ? 'A' : 'B';
      return { winner: w as 'A' | 'B', winReason: `Higher success rate (${pct(Math.max(a.successRate, b.successRate))})` };
    }

    if (a.avgScore !== null && b.avgScore !== null && Math.abs(a.avgScore - b.avgScore) > 1) {
      const w = a.avgScore > b.avgScore ? 'A' : 'B';
      return { winner: w as 'A' | 'B', winReason: `Higher quality score` };
    }

    const speedDiff = Math.abs(a.avgDurationMs - b.avgDurationMs);
    if (speedDiff > a.avgDurationMs * 0.1) {
      const w = a.avgDurationMs < b.avgDurationMs ? 'A' : 'B';
      return { winner: w as 'A' | 'B', winReason: `Faster execution` };
    }

    return { winner: 'TIE', winReason: 'No significant difference' };
  }
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}
