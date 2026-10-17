/**
 * ASI Strict Mode — blackboard validation receipts.
 *
 * In strict mode, a LOW-trust agent's proposed change commits only with a
 * signed {@link ValidationReceipt} from an operator-designated AUDITOR. The
 * receipt commits to the change id, the key, the hash of the exact proposed
 * value, and the hash the change was proposed against, so a receipt cannot be
 * reused for a different value or a later change.
 *
 * @module AsiReceipts
 */

import { canonicalHash, canonicalHmac, hexEqual } from './canonical';
import type { ValidationReceipt } from './types';

/** The parts of a pending change a receipt covers (structurally a `PendingChange`). */
export interface ReceiptSubject {
  change_id: string;
  key: string;
  value: unknown;
  previous_hash: string | null;
  source_agent: string;
}

/** An auditor's review function: given the change, approve or reject it. */
export type BlackboardValidator = (change: ReceiptSubject) => Promise<ValidationReceipt> | ValidationReceipt;

/** Hash of the canonical proposed value. */
export function valueHash(value: unknown): string {
  return canonicalHash(value === undefined ? null : value);
}

/**
 * Issues and verifies receipts with a deployment HMAC key. Keep the key
 * outside the agents' reach (strict mode's `sourceProtection` blocks reads of
 * the repo and config files).
 */
export class ReceiptSigner {
  constructor(private readonly secret: string | Buffer, private readonly ttlMs = 300_000) {
    if (!secret || secret.length < 16) throw new TypeError('ReceiptSigner: secret must be at least 16 bytes');
  }

  /** Issue a receipt for `change` from `validatorId`. */
  issue(change: ReceiptSubject, validatorId: string, verdict: ValidationReceipt['verdict']): ValidationReceipt {
    const issuedAt = Date.now();
    const body = {
      changeId: change.change_id,
      key: change.key,
      valueHash: valueHash(change.value),
      previousHash: change.previous_hash,
      validatorId,
      verdict,
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
    };
    return { ...body, signature: canonicalHmac(this.secret, body) };
  }

  /**
   * Verify `receipt` against `change`. Returns `null` when valid, otherwise the
   * rejection reason. Auditor membership is checked separately by the caller.
   */
  check(receipt: ValidationReceipt | undefined, change: ReceiptSubject): string | null {
    if (!receipt || typeof receipt !== 'object') return 'validation receipt required';
    const { signature, ...body } = receipt;
    if (!hexEqual(signature, canonicalHmac(this.secret, body))) return 'receipt signature invalid';
    if (receipt.changeId !== change.change_id || receipt.key !== change.key) return 'receipt is for a different change';
    if (!hexEqual(receipt.valueHash, valueHash(change.value))) return 'receipt is for a different value';
    if (receipt.previousHash !== change.previous_hash) return 'receipt is for a different base version';
    if (receipt.verdict !== 'approved') return 'auditor rejected the change';
    if (Date.now() > receipt.expiresAt) return 'receipt expired';
    return null;
  }
}

/**
 * Build a validator for an auditor agent. `check` decides; the signer turns
 * the decision into a receipt.
 */
export function createAuditorValidator(opts: {
  auditorId: string;
  signer: ReceiptSigner;
  check: (change: ReceiptSubject) => boolean | Promise<boolean>;
}): BlackboardValidator {
  return async (change) => {
    let approved = false;
    try {
      approved = await opts.check(change);
    } catch {
      approved = false;
    }
    return opts.signer.issue(change, opts.auditorId, approved ? 'approved' : 'rejected');
  };
}

/**
 * Use `ClaimVerifier` as the auditor's check: approve only when every action
 * the proposing agent claimed is backed by a runtime receipt and it took no
 * undisclosed actions in the window.
 *
 * @param verifier       A `ClaimVerifier` instance.
 * @param manifestsFor   Returns the action manifests the agent submitted for this change.
 * @param windowMs       Audit window to reconcile (default 10 min).
 */
export function claimVerifierCheck<M>(
  verifier: { verify(manifests: M[], agentId: string, windowMs: number): { unsupportedCount: number; undisclosedActions: readonly unknown[] } },
  manifestsFor: (change: ReceiptSubject) => M[],
  windowMs = 600_000,
): (change: ReceiptSubject) => boolean {
  return (change) => {
    const result = verifier.verify(manifestsFor(change), change.source_agent, windowMs);
    return result.unsupportedCount === 0 && result.undisclosedActions.length === 0;
  };
}
