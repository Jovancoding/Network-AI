/**
 * ClaimVerifier — Tier 1 Agent Honesty / Lie Detector
 *
 * Reconciles agent-declared action manifests against runtime-witnessed
 * audit entries and validates outcome-bound execution receipts.
 *
 * Design contract:
 *   - Outcome is read ONLY from inside the signed receipt — never from
 *     caller-supplied values. An agent cannot forge a receipt.
 *   - Undisclosed-action detection uses RuntimeAuditEntry (already exclusively
 *     agent-initiated by construction) — no extra tagging required.
 *   - Verification runs per-session (audit log is in-memory in AgentRuntime).
 *
 * Scope ceiling (documented, not hidden):
 *   - Catches fabricated actions and fabricated/misrepresented outcomes.
 *   - Does NOT catch misleading interpretation of true outcomes
 *     (exit 0 → "production-ready").
 *   - BYOC adapter network calls are unmediated (Tier 2 concern).
 *
 * @module claim-verifier
 */

import type { ExecutionReceipt } from '../security';
import { SecureTokenManager } from '../security';
import type { AgentRuntime, RuntimeAuditEntry } from './agent-runtime';
import type { ComplianceMonitor } from './compliance-monitor';

// ============================================================================
// TYPES
// ============================================================================

/**
 * A single action claim declared by the agent in its structured manifest.
 * Prose output is untrusted — claims must be declared here to be verified.
 */
export interface ActionManifest {
  /** Action type: 'shell_execute' | 'file_write' */
  action: string;
  /** Command or file path acted on */
  target: string;
  /** Runtime-issued receipt returned to the agent alongside the result */
  receipt: ExecutionReceipt;
}

/** Outcome of verifying a single manifest entry */
export interface VerificationOutcome {
  manifest: ActionManifest;
  /** Whether the receipt signature is valid and the audit entry is present */
  corroborated: boolean;
  reason?: string;
}

/** Full result of a verify() call */
export interface VerificationResult {
  agentId: string;
  windowMs: number;
  outcomes: VerificationOutcome[];
  /** Audit entries within the window that have no matching manifest (potential deception) */
  undisclosedActions: RuntimeAuditEntry[];
  /** Number of valid, corroborated claims */
  corroboratedCount: number;
  /** Number of claims that could not be validated */
  unsupportedCount: number;
}

/** Options for ClaimVerifier */
export interface ClaimVerifierOptions {
  /** AgentRuntime instance — provides the in-memory audit log */
  runtime: AgentRuntime;
  /** ComplianceMonitor to emit violations through (optional) */
  monitor?: ComplianceMonitor;
  /**
   * SecureTokenManager used to validate receipts.
   * Must be the SAME instance that issued the receipts (shared secret).
   * If omitted, creates a new instance — only use when testing receipt
   * generation and validation in isolation (shared instance recommended).
   */
  receiptManager?: SecureTokenManager;
}

// ============================================================================
// CLAIM VERIFIER
// ============================================================================

/**
 * Reconciles agent action manifests against witnessed runtime audit entries.
 *
 * @example
 * ```typescript
 * const verifier = new ClaimVerifier({ runtime, monitor });
 *
 * // After an agent turn completes, verify its declared manifests:
 * const result = verifier.verify(
 *   [{ action: 'shell_execute', target: 'npm test', receipt: shellResult.receipt! }],
 *   'agent-1',
 *   60_000, // look back 60 seconds
 * );
 *
 * console.log('unsupported:', result.unsupportedCount);
 * console.log('undisclosed:', result.undisclosedActions.length);
 * ```
 */
export class ClaimVerifier {
  private readonly runtime: AgentRuntime;
  private readonly monitor: ComplianceMonitor | undefined;
  private readonly receiptManager: SecureTokenManager;

  /** Per-agent consecutive unsupported-claim counters */
  private consecutiveUnsupported: Map<string, number> = new Map();

  constructor(opts: ClaimVerifierOptions) {
    this.runtime = opts.runtime;
    this.monitor = opts.monitor;
    this.receiptManager = opts.receiptManager ?? new SecureTokenManager();
  }

  /**
   * Verify agent manifests against the runtime audit log.
   *
   * For each manifest entry:
   *   1. Validate receipt signature (tamper detection).
   *   2. Confirm agentId in receipt matches claimed agentId.
   *   3. Find a matching audit entry within the window.
   *   → UNSUPPORTED_CLAIM if any step fails.
   *
   * Additionally, all agent-initiated audit entries within the window that
   * have no matching manifest entry are reported as UNDISCLOSED_ACTION.
   *
   * @param manifests   - Action manifests declared by the agent
   * @param agentId     - The agent making the claims
   * @param windowMs    - How far back (ms) to look in the audit log
   */
  verify(manifests: ActionManifest[], agentId: string, windowMs: number): VerificationResult {
    const now = Date.now();
    const cutoff = now - windowMs;

    // Scope audit entries to this agent within the window
    const windowEntries = this.runtime.getAuditLog().filter(
      e => e.agentId === agentId && new Date(e.timestamp).getTime() >= cutoff,
    );

    const outcomes: VerificationOutcome[] = [];
    const matchedEntryTimestamps = new Set<string>();

    for (const manifest of manifests) {
      const outcome = this._verifyOne(manifest, agentId, windowEntries, matchedEntryTimestamps);
      outcomes.push(outcome);

      if (!outcome.corroborated && this.monitor) {
        this.monitor.recordAction({ agentId, action: manifest.action, tool: 'claim_verifier' });
        // Emit via the public API — use a cast since emitViolation is the internal path
        (this.monitor as unknown as { _emit: (v: {
          type: string; agentId: string; message: string;
          severity: 'low'|'medium'|'high'|'critical'; metadata?: Record<string, unknown>;
        }) => void })._emit({
          type: 'UNSUPPORTED_CLAIM',
          agentId,
          message: `Agent "${agentId}" declared action "${manifest.action}" on "${manifest.target}" but no valid receipt + audit entry found: ${outcome.reason}`,
          severity: 'high',
          metadata: { action: manifest.action, target: manifest.target, reason: outcome.reason },
        });
      }
    }

    // Undisclosed actions: audit entries with no matching manifest
    const undisclosedActions = windowEntries.filter(
      e => !matchedEntryTimestamps.has(e.timestamp),
    );

    for (const entry of undisclosedActions) {
      if (this.monitor) {
        (this.monitor as unknown as { _emit: (v: {
          type: string; agentId: string; message: string;
          severity: 'low'|'medium'|'high'|'critical'; metadata?: Record<string, unknown>;
        }) => void })._emit({
          type: 'UNDISCLOSED_ACTION',
          agentId,
          message: `Agent "${agentId}" performed "${entry.action}" on "${entry.target}" without declaring it in the manifest`,
          severity: 'high',
          metadata: { action: entry.action, target: entry.target, result: entry.result },
        });
      }
    }

    const unsupportedCount = outcomes.filter(o => !o.corroborated).length;
    const corroboratedCount = outcomes.length - unsupportedCount;

    return {
      agentId,
      windowMs,
      outcomes,
      undisclosedActions,
      corroboratedCount,
      unsupportedCount,
    };
  }

  /**
   * Return the current consecutive unsupported-claim count for an agent.
   * Used by trust decay to check whether the threshold has been reached.
   */
  getConsecutiveUnsupported(agentId: string): number {
    return this.consecutiveUnsupported.get(agentId) ?? 0;
  }

  /** Reset the consecutive counter (call after a corroborated turn). */
  resetConsecutive(agentId: string): void {
    this.consecutiveUnsupported.set(agentId, 0);
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private _verifyOne(
    manifest: ActionManifest,
    agentId: string,
    windowEntries: ReadonlyArray<RuntimeAuditEntry>,
    matchedTimestamps: Set<string>,
  ): VerificationOutcome {
    const { receipt } = manifest;

    // 1. Validate receipt signature — outcome read only from inside the signed receipt
    const validation = this.receiptManager.validateReceipt(receipt);
    if (!validation.valid) {
      this._incrementConsecutive(agentId);
      return { manifest, corroborated: false, reason: `Invalid receipt: ${validation.reason}` };
    }

    // 2. Agent identity must match receipt — prevents cross-agent weaponisation
    if (receipt.agentId !== agentId) {
      this._incrementConsecutive(agentId);
      return { manifest, corroborated: false, reason: `Receipt agentId "${receipt.agentId}" does not match claimed agentId "${agentId}"` };
    }

    // 3. Action and target must match (guards against receipt reuse)
    if (receipt.action !== manifest.action || receipt.target !== manifest.target) {
      this._incrementConsecutive(agentId);
      return { manifest, corroborated: false, reason: `Receipt action/target mismatch` };
    }

    // 4. Find matching audit entry within the window
    const match = windowEntries.find(
      e =>
        e.agentId === agentId &&
        e.action === manifest.action &&
        e.target === manifest.target &&
        !matchedTimestamps.has(e.timestamp),
    );

    if (!match) {
      this._incrementConsecutive(agentId);
      return { manifest, corroborated: false, reason: `No matching audit entry found in window` };
    }

    matchedTimestamps.add(match.timestamp);
    this._resetConsecutive(agentId);
    return { manifest, corroborated: true };
  }

  private _incrementConsecutive(agentId: string): void {
    this.consecutiveUnsupported.set(agentId, (this.consecutiveUnsupported.get(agentId) ?? 0) + 1);
  }

  private _resetConsecutive(agentId: string): void {
    this.consecutiveUnsupported.set(agentId, 0);
  }
}
