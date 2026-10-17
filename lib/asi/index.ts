/**
 * ASI Strict Mode — opt-in safety controls for highly capable agents.
 *
 * Enabled with `ASI_STRICT_MODE=audit` (report only) or
 * `ASI_STRICT_MODE=enforce`. Unset or `false` keeps today's behaviour with no
 * extra work on any code path.
 *
 * @module AsiStrictMode
 */

export * from './types';
export {
  createAsiConfig,
  getAsiConfig,
  tightenAsiConfig,
  isAsiActive,
  isAsiEnforcing,
  parseStrictMode,
  emitAsiEvent,
  asiViolation,
  trustRank,
  AsiPolicyError,
} from './config';
export { resolveTrustLevel, createTrustResolver } from './trust';
export type { TrustScoreSource } from './trust';
export { canonicalJson, canonicalHash } from './canonical';
export { bindAction, CapabilityIssuer, SignedAttestationVerifier, ProofGate } from './proof-gate';
export type { CapabilitySigningKey, TrustedSigner, ProofGateRequest } from './proof-gate';
export { geometricMedian, BallotSigner, ConsensusEngine } from './consensus';
export type { ConsensusEngineOptions } from './consensus';
export { ReceiptSigner, createAuditorValidator, claimVerifierCheck, valueHash } from './receipts';
export type { ReceiptSubject, BlackboardValidator } from './receipts';
export { HaltCoordinator, AsiHaltedError, generateShutdownToken, hashShutdownToken } from './shutdown';
export type { HaltTarget, ScreenResult } from './shutdown';
export { CanaryRegistry } from './canary';
export type { CanaryHit } from './canary';
export { HashChainSink, verifyEventChain } from './authority';
export type { ChainedAsiEvent } from './authority';
export { contextPolicyFor, applyContextPolicy, cognitiveBudgetFor, capThinkingBudget } from './policies';
