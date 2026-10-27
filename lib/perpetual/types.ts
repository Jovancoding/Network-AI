/**
 * Perpetual Runtime — shared types.
 *
 * Long-running agent swarms stay under human control through short-lived,
 * signed **leases**. A run may continue indefinitely only while an
 * operator-signed {@link RenewalPolicy} keeps renewing its lease; without a
 * valid lease every guarded action halts (dead-man switch).
 *
 * Key separation:
 * - **Operator key** (Ed25519, held by a human / offline): signs policies.
 * - **Authority key** (Ed25519, held only by the `LeaseAuthority` process):
 *   signs leases under the current policy.
 * - Agents hold neither; they only ever see public keys and signed leases.
 *
 * @module PerpetualTypes
 */

/** Risk tier a lease authorizes; higher tiers are never implied by lower ones. */
export type LeaseTier = 'observe' | 'standard' | 'elevated';

/** What a lease permits. Empty or missing lists mean "nothing" (fail closed). */
export interface LeaseScope {
  tier: LeaseTier;
  /** Tool/action names the run may use (e.g. `shell_exec`, `file_write`, `model_call`) */
  tools: readonly string[];
  /** Path prefixes (relative to the project root) the run may write */
  paths?: readonly string[];
  /** Egress route names the run may call through `EgressProxy` */
  destinations?: readonly string[];
}

/** Spend ceilings for one lease period and for the run as a whole. */
export interface LeaseBudget {
  /** USD the whole run may spend (across all renewals) */
  runCeilingUsd: number;
  /** Tokens the whole run may spend (across all renewals) */
  runCeilingTokens: number;
}

/** The claims inside a lease. */
export interface LeaseClaims {
  v: 'nai-lease-v1';
  leaseId: string;
  runId: string;
  /** 1 for the first lease of a run, +1 per renewal */
  sequence: number;
  issuedAt: number;
  expiresAt: number;
  scope: LeaseScope;
  budget: LeaseBudget;
  /** SHA-256 of the canonical signed policy the lease was issued under */
  policyHash: string;
  nonce: string;
}

/** A lease signed by the authority key. */
export interface SignedLease {
  claims: LeaseClaims;
  alg: 'ed25519';
  keyId: string;
  /** Hex Ed25519 signature over `canonicalJson(claims)` */
  signature: string;
}

/** Conditions under which the authority stops renewing. */
export interface RenewalStopConditions {
  /** Stop when a sentry reports an alert at or above this level */
  sentryAlertAtOrAbove?: 'warning' | 'critical';
  /** Distinct authenticated sentries that must agree before an alert stops renewal (default 1; operator alerts always count) */
  sentryQuorum?: number;
  /** Window in which sentry alerts count toward the quorum (default 5 min) */
  sentryWindowMs?: number;
  /** Stop when a heartbeat reports canary failure */
  onCanaryFailure?: boolean;
  /** Stop when a heartbeat reports health `failing` */
  onHealthFailing?: boolean;
}

/** Operator-authored renewal policy. Signed by the operator key. */
export interface RenewalPolicy {
  v: 'nai-policy-v1';
  policyId: string;
  issuedAt: number;
  /** Lifetime of each lease (ms). Bounded to [10 s, 24 h]. */
  leaseTtlMs: number;
  /** Renew automatically while the stop conditions are not met */
  autoRenew: boolean;
  /** Epoch ms after which no lease is issued or renewed (optional end date) */
  renewUntil?: number;
  /** Max heartbeat age accepted for a renewal (ms) */
  heartbeatMaxAgeMs: number;
  scope: LeaseScope;
  budget: LeaseBudget;
  stopWhen: RenewalStopConditions;
}

/** A policy signed by the operator key. */
export interface SignedPolicy {
  policy: RenewalPolicy;
  alg: 'ed25519';
  keyId: string;
  signature: string;
}

/** Status a run reports when asking for renewal. The authority decides. */
export interface Heartbeat {
  leaseId: string;
  runId: string;
  at: number;
  spentUsd: number;
  spentTokens: number;
  health: 'ok' | 'degraded' | 'failing';
  canaryFailed?: boolean;
}

/** Result of an issue/renew request. */
export interface LeaseDecision {
  granted: boolean;
  lease?: SignedLease;
  /** Why the request was refused */
  reason?: string;
}

/** Externally visible state of a run. */
export type RunState = 'active' | 'paused' | 'revoked' | 'stopped';

/** Snapshot returned by `LeaseAuthority.status()`. */
export interface RunStatus {
  runId: string;
  state: RunState;
  currentLeaseId?: string;
  expiresAt?: number;
  sequence: number;
  spentUsd: number;
  spentTokens: number;
  reason?: string;
}

/**
 * Who may call which control operation.
 * - `operator`: everything, including resume and installing a new signed policy.
 * - `sentry`: only tighten, stop renewal, pause, revoke (never loosen or resume).
 * - `runner`: only issue/renew for its run and read its own status.
 */
export type ControlRole = 'operator' | 'sentry' | 'runner';

/** An action checked against the current lease. */
export interface LeaseAction {
  tool: string;
  /** Project-relative path for file writes */
  path?: string;
  /** Egress route name for outbound calls */
  destination?: string;
}

/** Anything that can veto an action for lack of a valid lease (`LeaseGuard` satisfies this). */
export interface LeaseCheck {
  /** Throws `LeaseError` when there is no valid lease or the action is out of scope. */
  assertActive(action: LeaseAction): void;
}

/** Vetoes writes to the governance layer without operator approval (`GuardedPaths` satisfies this). */
export interface GuardedCheck {
  /** `null` when the write is allowed, otherwise why it is refused. */
  check(target: { kind: 'path' | 'key'; name: string }, content: unknown): string | null;
}
