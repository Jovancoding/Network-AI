/**
 * AgentDebate — Adversarial multi-agent debate and self-critique.
 *
 * A proposer agent generates a proposal, then one or more critic agents
 * challenge it across configurable rounds. The debate continues until
 * consensus, a round limit, or a confidence threshold is met.
 *
 * @module AgentDebate
 */

// ============================================================================
// TYPES
// ============================================================================

/** A single turn in a debate */
export interface DebateTurn {
  round: number;
  role: 'proposer' | 'critic';
  agentId: string;
  content: string;
  confidence: number;
  timestamp: number;
}

/** Configuration for a debate session */
export interface DebateConfig {
  /** Maximum number of debate rounds (default 3) */
  maxRounds?: number;
  /** Confidence threshold to accept a proposal without further critique (0-100, default 85) */
  acceptanceThreshold?: number;
  /** Minimum confidence from all critics to reach consensus (0-100, default 70) */
  consensusThreshold?: number;
  /** Timeout per turn in ms (default 30000) */
  turnTimeoutMs?: number;
}

/** Final outcome of a debate */
export interface DebateOutcome {
  /** Whether the proposal was accepted */
  accepted: boolean;
  /** Reason for acceptance or rejection */
  reason: 'consensus' | 'threshold' | 'max_rounds' | 'proposer_withdrew';
  /** The final (possibly revised) proposal */
  finalProposal: string;
  /** Confidence of the final proposal */
  finalConfidence: number;
  /** Full debate transcript */
  transcript: DebateTurn[];
  /** Number of rounds conducted */
  rounds: number;
  /** Total duration in ms */
  durationMs: number;
}

/** Critique result from a critic agent */
export interface CritiqueResult {
  /** The critique text */
  critique: string;
  /** Critic's confidence in the proposal (0-100, higher = more approving) */
  confidence: number;
  /** Whether the critic approves the proposal as-is */
  approves: boolean;
}

/** Revised proposal from the proposer after critique */
export interface RevisionResult {
  /** The revised proposal */
  proposal: string;
  /** Proposer's confidence in the revised version */
  confidence: number;
  /** Whether the proposer wants to withdraw (give up) */
  withdrawn: boolean;
}

/**
 * Function that a proposer calls to generate or revise a proposal.
 * Round 0 = initial proposal. Round > 0 = revision after critique.
 */
export type ProposerFn = (
  instruction: string,
  previousCritiques: DebateTurn[],
  round: number,
) => Promise<RevisionResult>;

/**
 * Function that a critic calls to evaluate a proposal.
 */
export type CriticFn = (
  proposal: string,
  instruction: string,
  round: number,
) => Promise<CritiqueResult>;

// ============================================================================
// AGENT DEBATE
// ============================================================================

/**
 * Orchestrate a multi-round adversarial debate.
 *
 * @example
 * ```ts
 * const debate = new AgentDebate({
 *   proposer: { agentId: 'writer', fn: writerFn },
 *   critics: [
 *     { agentId: 'reviewer', fn: reviewerFn },
 *     { agentId: 'security-checker', fn: securityFn },
 *   ],
 *   config: { maxRounds: 3, acceptanceThreshold: 90 },
 * });
 *
 * const outcome = await debate.run('Write a secure login handler');
 * if (outcome.accepted) {
 *   console.log('Final proposal:', outcome.finalProposal);
 * }
 * ```
 */
export class AgentDebate {
  private proposer: { agentId: string; fn: ProposerFn };
  private critics: Array<{ agentId: string; fn: CriticFn }>;
  private config: Required<DebateConfig>;

  constructor(options: {
    proposer: { agentId: string; fn: ProposerFn };
    critics: Array<{ agentId: string; fn: CriticFn }>;
    config?: DebateConfig;
  }) {
    this.proposer = options.proposer;
    this.critics = options.critics;
    this.config = {
      maxRounds: options.config?.maxRounds ?? 3,
      acceptanceThreshold: options.config?.acceptanceThreshold ?? 85,
      consensusThreshold: options.config?.consensusThreshold ?? 70,
      turnTimeoutMs: options.config?.turnTimeoutMs ?? 30_000,
    };
  }

  /**
   * Run the full debate for a given instruction.
   */
  async run(instruction: string): Promise<DebateOutcome> {
    const startMs = Date.now();
    const transcript: DebateTurn[] = [];
    let currentProposal = '';
    let proposalConfidence = 0;

    for (let round = 0; round < this.config.maxRounds; round++) {
      // --- Proposer turn ---
      const previousCritiques = transcript.filter(t => t.role === 'critic');
      const revision = await this.withTimeout(
        this.proposer.fn(instruction, previousCritiques, round),
        this.config.turnTimeoutMs,
        { proposal: currentProposal || '(timeout)', confidence: 0, withdrawn: true },
      );

      if (revision.withdrawn) {
        return {
          accepted: false,
          reason: 'proposer_withdrew',
          finalProposal: currentProposal,
          finalConfidence: proposalConfidence,
          transcript,
          rounds: round + 1,
          durationMs: Date.now() - startMs,
        };
      }

      currentProposal = revision.proposal;
      proposalConfidence = revision.confidence;

      transcript.push({
        round,
        role: 'proposer',
        agentId: this.proposer.agentId,
        content: currentProposal,
        confidence: proposalConfidence,
        timestamp: Date.now(),
      });

      // Early accept if proposer confidence exceeds threshold
      if (proposalConfidence >= this.config.acceptanceThreshold) {
        return {
          accepted: true,
          reason: 'threshold',
          finalProposal: currentProposal,
          finalConfidence: proposalConfidence,
          transcript,
          rounds: round + 1,
          durationMs: Date.now() - startMs,
        };
      }

      // --- Critic turns ---
      const critiqueResults: CritiqueResult[] = [];
      for (const critic of this.critics) {
        const critique = await this.withTimeout(
          critic.fn(currentProposal, instruction, round),
          this.config.turnTimeoutMs,
          { critique: '(timeout)', confidence: 0, approves: false },
        );

        critiqueResults.push(critique);
        transcript.push({
          round,
          role: 'critic',
          agentId: critic.agentId,
          content: critique.critique,
          confidence: critique.confidence,
          timestamp: Date.now(),
        });
      }

      // Check consensus — all critics approve with sufficient confidence
      const allApprove = critiqueResults.every(c => c.approves);
      const minCriticConfidence = critiqueResults.length > 0
        ? Math.min(...critiqueResults.map(c => c.confidence))
        : 0;

      if (allApprove && minCriticConfidence >= this.config.consensusThreshold) {
        return {
          accepted: true,
          reason: 'consensus',
          finalProposal: currentProposal,
          finalConfidence: Math.min(proposalConfidence, minCriticConfidence),
          transcript,
          rounds: round + 1,
          durationMs: Date.now() - startMs,
        };
      }
    }

    // Max rounds reached — return the latest proposal
    return {
      accepted: false,
      reason: 'max_rounds',
      finalProposal: currentProposal,
      finalConfidence: proposalConfidence,
      transcript,
      rounds: this.config.maxRounds,
      durationMs: Date.now() - startMs,
    };
  }

  // --------------------------------------------------------------------------
  // INTERNAL
  // --------------------------------------------------------------------------

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
    const timer = new Promise<T>((resolve) =>
      setTimeout(() => resolve(fallback), timeoutMs),
    );
    return Promise.race([promise, timer]);
  }
}
