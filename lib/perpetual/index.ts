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
  signPolicy,
  verifySignedPolicy,
  policyHash,
  signLease,
  verifyLease,
  scopeWithin,
} from './signing';
export type { Ed25519KeyPair } from './signing';
export { LeaseAuthority } from './lease-authority';
export type { AlertLevel, TightenDelta, AuthorityEvent, LeaseAuthorityOptions, AuthoritySecrets } from './lease-authority';
export { LeaseGuard, HttpLeaseTransport } from './lease-guard';
export type { LeaseTransport, HaltTrigger, LeaseGuardOptions } from './lease-guard';
export { EgressProxy, encodeLeaseHeader } from './egress-proxy';
export type { EgressRoute, EgressEvent, EgressProxyOptions } from './egress-proxy';
export { writeKeyPair, readPublicKey, readKeyPair, readJsonFile, loadRoutes, readRoleSecrets, ROLE_SECRET_ENV, SENTRY_SECRET_ENV_PREFIX } from './files';
export type { WrittenKeyPair } from './files';

// Phase 2 — containment, guarded paths, sentry swarm
export {
  GuardedPaths, GuardedMatcher, GuardedPathError, signGuardedApproval, guardedContentHash, DEFAULT_GUARDED_PATHS, DEFAULT_GUARDED_KEYS,
} from './guarded-paths';
export type { GuardedTarget, GuardedApproval, SignedGuardedApproval, GuardedPathsOptions } from './guarded-paths';
export { ContainerSandboxRunner, normalizeSandboxRequest, makeSandboxReceipt, DEFAULT_SANDBOX_LIMITS } from './sandbox';
export type {
  ISandboxRunner, SandboxRequest, SandboxResult, SandboxReceipt, SandboxLimits, SandboxNetwork, NormalizedSandboxRequest, ContainerSandboxOptions,
} from './sandbox';
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
