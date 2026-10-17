/**
 * ASI Strict Mode — LLM Byzantine-fault-tolerant consensus.
 *
 * High-stakes decisions are judged by several independent evaluators instead
 * of one agent. Each evaluator returns a {@link ConsensusBallot} with a score
 * vector over shared criteria; ballots are aggregated with a robust geometric
 * median (Weiszfeld iteration), which a minority of arbitrary (Byzantine)
 * ballots cannot drag far. `cp-wbft` additionally weights each ballot by its
 * confidence probe.
 *
 * Guarantees hold only when at most `maxFaulty` evaluators are faulty *and*
 * faults are independent — evaluators that share a model family tend to fail
 * together, so `minModelFamilies` can require diversity.
 *
 * @module AsiConsensus
 */

import { canonicalHmac, hexEqual } from './canonical';
import { emitAsiEvent, getAsiConfig, isAsiEnforcing } from './config';
import type {
  AsiStrictConfig,
  ConsensusBallot,
  ConsensusEvaluator,
  ConsensusPolicy,
  ConsensusResult,
  ConsensusSubject,
} from './types';

function distance(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

/**
 * Weighted geometric median of equal-length points (Weiszfeld iteration).
 *
 * @param points   Score vectors.
 * @param weights  Non-negative weights (default all 1).
 */
export function geometricMedian(
  points: readonly (readonly number[])[],
  weights?: readonly number[],
  opts: { maxIterations?: number; tolerance?: number } = {},
): number[] {
  if (points.length === 0) throw new RangeError('geometricMedian: no points');
  const dims = points[0].length;
  const w = weights ?? points.map(() => 1);
  const total = w.reduce((a, b) => a + b, 0);
  if (total <= 0) throw new RangeError('geometricMedian: weights must sum to a positive number');

  let y = new Array<number>(dims).fill(0);
  points.forEach((p, i) => p.forEach((v, d) => { y[d] += (w[i] * v) / total; }));

  const maxIter = opts.maxIterations ?? 200;
  const tol = opts.tolerance ?? 1e-9;
  for (let iter = 0; iter < maxIter; iter++) {
    const num = new Array<number>(dims).fill(0);
    let den = 0;
    for (let i = 0; i < points.length; i++) {
      const d = distance(points[i], y);
      if (d < 1e-12) continue; // y coincides with this point; skip to avoid division by zero
      const k = w[i] / d;
      points[i].forEach((v, dim) => { num[dim] += k * v; });
      den += k;
    }
    if (den === 0) return y;
    const next = num.map((v) => v / den);
    if (distance(next, y) < tol) return next;
    y = next;
  }
  return y;
}

/** Fields covered by a ballot signature. */
function ballotPayload(b: ConsensusBallot): Omit<ConsensusBallot, 'signature'> {
  return { evaluatorId: b.evaluatorId, modelFamily: b.modelFamily, scores: b.scores, confidence: b.confidence, decision: b.decision };
}

/** Signs and verifies ballots with a per-deployment HMAC key, so votes cannot be forged in transit. */
export class BallotSigner {
  constructor(private readonly secret: string | Buffer) {
    if (!secret || secret.length < 16) throw new TypeError('BallotSigner: secret must be at least 16 bytes');
  }

  /** Return a copy of the ballot carrying a signature. */
  sign(ballot: ConsensusBallot): ConsensusBallot {
    return { ...ballot, signature: canonicalHmac(this.secret, ballotPayload(ballot)) };
  }

  /** Whether the ballot's signature is valid. */
  verify(ballot: ConsensusBallot): boolean {
    return typeof ballot.signature === 'string' && hexEqual(ballot.signature, canonicalHmac(this.secret, ballotPayload(ballot)));
  }
}

/** Options for {@link ConsensusEngine}. */
export interface ConsensusEngineOptions {
  /** Reject ballots that fail this check (e.g. `BallotSigner.verify`) */
  verifyBallot?: (ballot: ConsensusBallot) => boolean;
  /** Per-evaluator timeout in {@link ConsensusEngine.decide} (default 30 s) */
  evaluatorTimeoutMs?: number;
  config?: AsiStrictConfig;
}

/** Aggregates evaluator ballots under a {@link ConsensusPolicy}. */
export class ConsensusEngine {
  private readonly config: AsiStrictConfig;

  constructor(private readonly policy: ConsensusPolicy, private readonly options: ConsensusEngineOptions = {}) {
    if (!Number.isInteger(policy.maxFaulty) || policy.maxFaulty < 0) {
      throw new TypeError('ConsensusEngine: maxFaulty must be a non-negative integer');
    }
    this.config = options.config ?? getAsiConfig();
  }

  /** Minimum ballots required: max(3f + 1, minEvaluators). */
  get quorum(): number {
    return Math.max(3 * this.policy.maxFaulty + 1, this.policy.minEvaluators ?? 0);
  }

  /** Ask every evaluator in parallel and aggregate the ballots that arrive in time. */
  async decide(subject: ConsensusSubject, evaluators: readonly ConsensusEvaluator[]): Promise<ConsensusResult> {
    const timeoutMs = this.options.evaluatorTimeoutMs ?? 30_000;
    const settled = await Promise.allSettled(evaluators.map((e) => withTimeout(e.evaluate(subject), timeoutMs)));
    const ballots = settled.flatMap((s, i) => {
      if (s.status !== 'fulfilled') return [];
      // An evaluator may only vote as itself.
      return [{ ...s.value, evaluatorId: evaluators[i].id, modelFamily: evaluators[i].modelFamily }];
    });
    const result = this.aggregate(ballots);
    emitAsiEvent(this.config, {
      kind: 'consensus',
      outcome: result.accepted ? 'allowed' : isAsiEnforcing(this.config) ? 'denied' : 'would-deny',
      agentId: subject.agentId,
      reason: result.reason,
      details: { agreement: result.agreement, outliers: result.outliers, ballots: ballots.length },
      at: Date.now(),
    });
    return result;
  }

  /** Aggregate ballots into a {@link ConsensusResult}. Pure; never throws on bad ballots. */
  aggregate(input: readonly ConsensusBallot[]): ConsensusResult {
    const f = this.policy.maxFaulty;
    const seen = new Set<string>();
    const ballots: ConsensusBallot[] = [];
    for (const b of input) {
      if (!b || seen.has(b.evaluatorId)) continue;
      if (!Array.isArray(b.scores) || b.scores.length === 0 || !b.scores.every((v) => Number.isFinite(v))) continue;
      if (!(b.confidence >= 0 && b.confidence <= 1)) continue;
      if (b.decision !== 'approve' && b.decision !== 'reject' && b.decision !== 'abstain') continue;
      if (this.options.verifyBallot && !this.options.verifyBallot(b)) continue;
      seen.add(b.evaluatorId);
      ballots.push(b);
    }

    const fail = (reason: string, median: readonly number[] = [], agreement = 0, outliers: readonly string[] = []): ConsensusResult =>
      ({ accepted: false, median, agreement, outliers, reason, ballots });

    if (ballots.length < this.quorum) return fail(`quorum not met: ${ballots.length}/${this.quorum} valid ballots`);
    const dims = ballots[0].scores.length;
    if (!ballots.every((b) => b.scores.length === dims)) return fail('ballots use different score dimensions');
    const families = new Set(ballots.map((b) => b.modelFamily)).size;
    if (families < (this.policy.minModelFamilies ?? 1)) {
      return fail(`need ballots from ${this.policy.minModelFamilies} model families, got ${families}`);
    }

    const weights = ballots.map((b) => (this.policy.protocol === 'cp-wbft' ? Math.max(0.01, b.confidence) : 1));
    const median = geometricMedian(ballots.map((b) => b.scores), weights);
    const distances = ballots.map((b) => distance(b.scores, median));
    const sorted = [...distances].sort((a, b) => a - b);
    const typical = sorted[Math.floor(sorted.length / 2)];
    const limit = Math.max((this.policy.outlierFactor ?? 3) * typical, this.policy.minOutlierDistance ?? 0.15);

    const flagged = ballots
      .map((b, i) => ({ b, d: distances[i], w: weights[i] }))
      .filter((x) => x.d > limit);
    const outliers = flagged.map((x) => x.b.evaluatorId);
    if (flagged.length > f) return fail(`disagreement exceeds fault tolerance: ${flagged.length} outliers > f=${f}`, median, 0, outliers);

    const inliers = ballots.map((b, i) => ({ b, w: weights[i] })).filter((x) => !outliers.includes(x.b.evaluatorId));
    let approve = 0;
    let voting = 0;
    for (const { b, w } of inliers) {
      if (b.decision === 'abstain') continue;
      voting += w;
      if (b.decision === 'approve') approve += w;
    }
    const agreement = voting > 0 ? approve / voting : 0;
    const threshold = this.policy.agreementThreshold ?? 2 / 3;
    if (inliers.length < 2 * f + 1) return fail('too few consistent evaluators', median, agreement, outliers);
    if (agreement < threshold) return fail(`agreement ${agreement.toFixed(3)} below ${threshold.toFixed(3)}`, median, agreement, outliers);
    return { accepted: true, median, agreement, outliers, ballots };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`evaluator timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
  });
}
