/**
 * Perpetual Runtime — opt-in long-running execution under human control.
 *
 * Runs continue only while an operator-signed policy keeps renewing their
 * lease; without a valid lease every guarded action halts.
 *
 * @module Perpetual
 */

export * from './types';
export {
  LeaseError,
  generateEd25519KeyPair,
  keyIdOf,
  validatePolicy,
  isHighRiskPolicy,
  signPolicy,
  verifySignedPolicy,
  policyHash,
  signLease,
  verifyLease,
  verifyLeaseQuorum,
  cosignLease,
  scopeWithin,
  KeyObjectSigner,
  CommandSigner,
  isSigner,
  toSigner,
} from './signing';
export type { Ed25519KeyPair, Signer, SigningKey, CommandSignerOptions } from './signing';
export { LeaseAuthority, TRIPWIRE_SOURCE } from './lease-authority';
export type { CosignDecision } from './lease-authority';
export { TripwireSet, tripwireDetector } from './tripwire';
export type { DecoyCredentialFormat, DecoyFileKind, TripwireHit, TripwireManifest } from './tripwire';
export { runPostureChecks, postureVerdict, formatPosture, POSTURE_CHECK_IDS } from './posture';
export type { PostureCheckId, PostureCheck, PostureInput, PostureReport } from './posture';
export { signCheckpoint, verifyCheckpoint, MAX_CHECKPOINT_VALIDITY_MS } from './checkpoint';
export type { Checkpoint, CheckpointScope, SignedCheckpoint } from './checkpoint';
export type { AlertLevel, TightenDelta, AuthorityEvent, LeaseAuthorityOptions, AuthoritySecrets } from './lease-authority';
export { LeaseGuard, HttpLeaseTransport, QuorumLeaseTransport, verifyLeaseWith } from './lease-guard';
export type { LeaseTransport, CosignTransport, HaltTrigger, LeaseGuardOptions } from './lease-guard';
export { EgressProxy, encodeLeaseHeader } from './egress-proxy';
export type { EgressRoute, EgressEvent, EgressProxyOptions } from './egress-proxy';
export { writeKeyPair, readPublicKey, readKeyPair, readJsonFile, loadRoutes, readRoleSecrets, ROLE_SECRET_ENV, SENTRY_SECRET_ENV_PREFIX } from './files';
export type { WrittenKeyPair } from './files';

// Phase 2 — containment, guarded paths, sentry swarm
export {
  GuardedPaths, GuardedMatcher, GuardedPathError, signGuardedApproval, guardedContentHash, DEFAULT_GUARDED_PATHS, DEFAULT_GUARDED_KEYS,
} from './guarded-paths';
export type { GuardedTarget, GuardedApproval, SignedGuardedApproval, GuardedPathsOptions } from './guarded-paths';
export { ContainerSandboxRunner, normalizeSandboxRequest, makeSandboxReceipt, DEFAULT_SANDBOX_LIMITS, hardenedNodeArgs, checkHardenedNode, RELAY_SOCKET_IN_SANDBOX } from './sandbox';
export type {
  ISandboxRunner, SandboxRequest, SandboxResult, SandboxReceipt, SandboxLimits, SandboxNetwork, NormalizedSandboxRequest, ContainerSandboxOptions, HardenedNodeOptions,
} from './sandbox';
export { KataSandboxRunner, FirecrackerSandboxRunner, firecrackerRelayListenPath, DEFAULT_RELAY_VSOCK_PORT } from './microvm';
export type { FirecrackerSandboxOptions } from './microvm';
export { VsockRelay, FramedLeaseTransport, FrameDecoder, FrameError, encodeFrame, parseRelayRequest } from './vsock-relay';
export type { RelayRequest, RelayResponse, RelayEgressResult, VsockRelayOptions } from './vsock-relay';
export { SpoolLeaseTransport, SpoolPuller } from './spool';
export type { SpoolPullerOptions } from './spool';
export { SignedQuoteVerifier, signQuote, checkAttestation } from './attestation';
export type { AttestationVerifier, AttestationResult } from './attestation';
export { signCapabilityEval, verifyCapabilityEval } from './capability-eval';
export type { CapabilityEval, SignedCapabilityEval } from './capability-eval';
export { MerkleAuditLog, FileWitness, leafHashOf, verifyInclusion, verifyConsistency, verifyTreeHead, classifyClaim } from './merkle-audit';
export type { TreeHead, SignedTreeHead, ClaimProof, ClaimStatus } from './merkle-audit';
export { nextRunState, recordSpend, scopeWithinCore, tightenError, applyTighten, quorumGrant, quorumActive } from './core';
export type { RunEvent, TightenablePolicy, TightenRequest, AuthorityStatus } from './core';
export { LeanCertificateVerifier } from './lean-verifier';
export type { LeanObligation, LeanCertificate, LeanCertificateVerifierOptions } from './lean-verifier';
export {
  Sentry, HttpSentryControl, localSentryControl, AuditTail, observationFromAudit, lexicalSimilarity,
  velocityDetector, deniedAccessDetector, promptInjectionDetector, blackboardPoisoningDetector,
  guardedTouchDetector, canaryLeakDetector, goalDriftDetector,
} from './sentry';
export type { SentryObservation, SentryFinding, SentryDetector, SentryControl, SentryOptions } from './sentry';

// Phase 3 — self-improvement pipeline, self-healing state
export { ImprovementPipeline } from './improvement-pipeline';
export type {
  PatchFile, ImprovementProposal, ImprovementTier, StaticFinding, StaticRule, ImprovementEvidence, ImprovementDecision,
  ImprovementReceipt, SignedImprovementReceipt, PipelineGuard, ImprovementPipelineOptions,
} from './improvement-pipeline';
export { StateSnapshotter, SelfHealer } from './self-healing';
export type { SnapshotBoard, SnapshotManifestEntry, CanaryTask, CanaryReport, SelfHealerOptions } from './self-healing';

// Phase 4 — budget auto-balancer
export { BudgetBalancer, signBudgetPolicy, validateBudgetPolicy } from './budget-balancer';
export type { FundingSource, BudgetPolicy, SignedBudgetPolicy, EffortLevel, SpendDecision, BudgetBalancerOptions } from './budget-balancer';
