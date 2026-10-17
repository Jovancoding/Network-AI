/**
 * ASI Strict Mode — shared types.
 *
 * Every field is optional and the whole suite is opt-in: with
 * `ASI_STRICT_MODE` unset (`'off'`) none of these types change runtime
 * behaviour.
 *
 * @module AsiTypes
 */

// ============================================================================
// MODE & TRUST
// ============================================================================

/**
 * `'off'` keeps today's behaviour; `'audit'` evaluates every strict-mode check
 * and reports would-be denials without blocking; `'enforce'` blocks.
 */
export type AsiStrictModeSetting = 'off' | 'audit' | 'enforce';

/**
 * Trust tiers derived from AuthGuardian's 0..1 trust score. `AUDITOR` is never
 * derived from a score — only the operator can assign it, so an agent cannot
 * raise itself to auditor by accumulating trust.
 */
export enum AgentTrustLevel {
  LOW = 'LOW',
  HIGH = 'HIGH',
  AUDITOR = 'AUDITOR',
}

/** Resolves an agent's trust tier (see {@link resolveTrustLevel}). */
export type TrustResolver = (agentId: string | undefined) => AgentTrustLevel;

// ============================================================================
// EVENTS & EXTERNAL AUTHORITY
// ============================================================================

/** A strict-mode decision or violation, emitted to the configured sink. */
export interface AsiEvent {
  /** Which subsystem produced the event */
  kind: 'proof' | 'consensus' | 'blackboard' | 'context' | 'cognitive' | 'shutdown' | 'canary' | 'config' | 'runtime';
  /** `'denied'` = blocked (enforce); `'would-deny'` = audit mode only */
  outcome: 'allowed' | 'denied' | 'would-deny' | 'triggered';
  agentId?: string;
  reason?: string;
  details?: Record<string, unknown>;
  /** Epoch ms */
  at: number;
}

/** Destination for strict-mode events (local log, SIEM, remote append-only store). */
export interface AsiEventSink {
  record(event: AsiEvent): void | Promise<void>;
}

/** Decision returned by an {@link ExternalAuthority}. */
export interface AuthorityDecision {
  approved: boolean;
  reason?: string;
  /** Identifier of the approving principal(s), e.g. quorum members */
  approvedBy?: string[];
}

/**
 * Optional authority that runs outside the agent's process — the "referee
 * outside the ring". Network-AI ships no client: bring your own (HTTP service,
 * HSM-backed signer, human quorum).
 */
export interface ExternalAuthority {
  /** Append-only audit export */
  appendAudit?(event: AsiEvent & { prevHash: string; hash: string }): Promise<void>;
  /** Out-of-process authorization for proof-gated actions */
  authorize?(request: { tool: string; agentId: string; argsHash: string }): Promise<AuthorityDecision>;
}

// ============================================================================
// PROOF-CARRYING ACTIONS
// ============================================================================

/** Binds a proof to one exact action so it cannot be replayed for another. */
export interface ActionBinding {
  /** Tool or action name (e.g. `'shell_exec'`) */
  tool: string;
  /** SHA-256 of the canonical arguments the executor will actually run */
  argsHash: string;
  /** Agent the proof was issued for */
  agentId: string;
  /** Single-use nonce */
  nonce: string;
  /** Epoch ms after which the proof is void */
  expiresAt: number;
  /** Epoch ms the proof was issued */
  issuedAt: number;
}

/** A proof attached to a high-risk action. */
export type FormalProof =
  | { kind: 'zkvm'; system: string; programId: string; receipt: string; binding: ActionBinding }
  | { kind: 'formal-verification'; tool: string; certificate: string; binding: ActionBinding }
  | { kind: 'signed-attestation'; alg: 'hmac-sha256' | 'ed25519'; signer: string; signature: string; binding: ActionBinding };

/** Outcome of a single {@link ProofVerifier.verify} call. */
export interface ProofVerdict {
  valid: boolean;
  reason?: string;
  verifier: string;
}

/**
 * Bring-your-own proof verifier. Network-AI bundles no zkVM or prover — a
 * verifier for RISC Zero, SP1, Lean/Coq certificates, etc. plugs in here.
 */
export interface ProofVerifier {
  /** Human-readable verifier name (reported in verdicts) */
  readonly name: string;
  /** Proof kinds this verifier accepts */
  readonly kinds: readonly FormalProof['kind'][];
  /** Verify `proof` against the binding the gate computed for this action */
  verify(proof: FormalProof, expected: ActionBinding): Promise<ProofVerdict> | ProofVerdict;
}

/** Which actions require a proof and how proofs are checked. */
export interface ProofGatePolicy {
  /** Tool/action names that always require a proof in strict mode */
  gatedTools: readonly string[];
  /** Verifiers consulted by proof kind */
  verifiers: readonly ProofVerifier[];
  /** Reject proofs older than this even if not yet expired (default: 5 min) */
  maxProofAgeMs?: number;
  /** Optional out-of-process co-signer consulted after a proof verifies */
  authority?: ExternalAuthority;
}

/** Result of a proof-gate check. */
export interface ProofGateDecision {
  /** Whether the caller may proceed */
  allowed: boolean;
  /** Whether a proof was required for this action */
  gated: boolean;
  /** Set when the action would have been blocked in enforce mode */
  violation?: string;
  verdict?: ProofVerdict;
}

// ============================================================================
// TRUST-TIERED CONTEXT
// ============================================================================

/** Context-pack limits for one trust tier. */
export interface TrustContextPolicy {
  /** Hard cap on the token budget (the smaller of this and the request wins) */
  maxBudgetTokens: number;
  /** Raise the exclusion threshold for this tier */
  minScore?: number;
  /** Cap the number of included items */
  maxItems?: number;
  /** Only items whose key contains one of these tags are eligible */
  allowedScopeTags?: readonly string[];
  /** Items produced by these agents are excluded */
  excludeSourceAgents?: readonly string[];
}

// ============================================================================
// BYZANTINE-FAULT-TOLERANT CONSENSUS
// ============================================================================

/** Consensus requirements for high-stakes model decisions. */
export interface ConsensusPolicy {
  /** `geometric-median` weights ballots equally; `cp-wbft` weights by confidence probe */
  protocol: 'geometric-median' | 'cp-wbft';
  /** Faulty evaluators tolerated (f); at least 3f + 1 ballots are required */
  maxFaulty: number;
  /** Override the 3f + 1 minimum upward */
  minEvaluators?: number;
  /** Require ballots from at least this many distinct model families (default: 1) */
  minModelFamilies?: number;
  /** Weighted approve share among inliers required to accept (0..1, default 2/3) */
  agreementThreshold?: number;
  /** Ballots farther than `outlierFactor` × median distance are outliers (default 3) */
  outlierFactor?: number;
  /** Distances below this are never outliers, whatever the spread (default 0.15) */
  minOutlierDistance?: number;
}

/** One evaluator's vote. */
export interface ConsensusBallot {
  evaluatorId: string;
  /** Model family (e.g. `'claude'`, `'gpt'`, `'gemini'`) — correlated failures share a family */
  modelFamily: string;
  /** Scores on shared criteria; every ballot must use the same length */
  scores: readonly number[];
  /** CP-WBFT confidence probe, 0..1 */
  confidence: number;
  decision: 'approve' | 'reject' | 'abstain';
  /** Optional HMAC over the ballot (see `BallotSigner`) */
  signature?: string;
}

/** Aggregated consensus outcome. */
export interface ConsensusResult {
  accepted: boolean;
  /** Weighted geometric median of the score vectors */
  median: readonly number[];
  /** Weighted approve share among inliers (0..1) */
  agreement: number;
  /** Evaluators whose scores are far from the median (suspected faulty) */
  outliers: readonly string[];
  /** Why consensus was not reached, when it was not */
  reason?: string;
  ballots: readonly ConsensusBallot[];
}

/** An evaluator that scores a candidate decision. */
export interface ConsensusEvaluator {
  readonly id: string;
  readonly modelFamily: string;
  evaluate(subject: ConsensusSubject): Promise<ConsensusBallot>;
}

/** What evaluators are asked to judge. */
export interface ConsensusSubject {
  agentId?: string;
  /** The proposed output or action, rendered as text */
  proposal: string;
  /** Context the proposal was produced from */
  context?: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// BLACKBOARD VALIDATION RECEIPTS
// ============================================================================

/** Signed statement from an auditor that a pending change was reviewed. */
export interface ValidationReceipt {
  changeId: string;
  key: string;
  /** SHA-256 of the canonical proposed value — binds the receipt to that value */
  valueHash: string;
  previousHash: string | null;
  validatorId: string;
  verdict: 'approved' | 'rejected';
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

// ============================================================================
// PASSWORD-ACTIVATED SHUTDOWN
// ============================================================================

/** Kill-switch configuration. Secrets are stored only as salted hashes. */
export interface ShutdownPolicy {
  /** Salted hash of the shutdown token (`hashShutdownToken()`); never the plaintext */
  tokenHash: string;
  /** Salted hash of a separate resume credential; omit to make the halt permanent */
  resumeKeyHash?: string;
  /** Max time each registered component gets to halt (default 5 s) */
  haltTimeoutMs?: number;
}

/** Summary of a completed halt. */
export interface HaltReport {
  haltedAt: number;
  trigger: string;
  /** Components that halted, by registered name */
  halted: readonly string[];
  /** Components that failed or timed out */
  failed: readonly string[];
  /** Connections/tasks reported closed by components */
  closed: number;
}

/** Anything the kill switch can stop. */
export interface Haltable {
  halt(reason: string): number | void | Promise<number | void>;
}

// ============================================================================
// COGNITIVE BANDWIDTH
// ============================================================================

/** Per-tier cap on reasoning spend. */
export interface CognitiveBudget {
  effortCeiling: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Thinking-token budget passed to the model */
  maxThinkingTokens: number;
  /** Output-token cap */
  maxOutputTokens?: number;
  /** Deepest sub-agent nesting allowed (0 = no sub-agents) */
  maxSubAgentDepth?: number;
}

// ============================================================================
// CONFIG
// ============================================================================

/** Resolved, deep-frozen strict-mode configuration. */
export interface AsiStrictConfig {
  readonly mode: AsiStrictModeSetting;
  /** Score below which an agent is `LOW` (default 0.4, matching AuthGuardian) */
  readonly lowTrustBelow: number;
  /** Agents the operator designated as auditors */
  readonly auditors: readonly string[];
  readonly context?: Readonly<Partial<Record<AgentTrustLevel, TrustContextPolicy>>>;
  readonly cognitive?: Readonly<Partial<Record<AgentTrustLevel, CognitiveBudget>>>;
  readonly consensus?: Readonly<ConsensusPolicy>;
  /** Tiers at or below which blackboard commits need an auditor receipt (default `LOW`) */
  readonly requireReceiptAtOrBelow: AgentTrustLevel;
  /** Event destination */
  readonly sink?: AsiEventSink;
}

/** Input accepted by `createAsiConfig()`; every field optional. */
export type AsiStrictConfigInput = Partial<Omit<AsiStrictConfig, 'mode'>> & { mode?: AsiStrictModeSetting };
