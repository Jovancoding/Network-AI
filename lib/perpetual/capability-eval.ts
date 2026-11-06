/**
 * Perpetual Runtime — capability-evaluation gating (Phase 5c.4).
 *
 * A high-risk policy (self-improvement, financial routes, or the `elevated`
 * tier) may require a signed, passing, unexpired capability evaluation before
 * any lease is issued, renewed, or co-signed. Evaluators sign with keys the
 * operator lists in the policy; thresholds (e.g. cyber-offense, self-exfiltration,
 * deception) are operator-set.
 *
 * @module PerpetualCapabilityEval
 */

import { createPublicKey, type KeyObject } from 'crypto';
import { keyIdOf, signWith, verifyCanonical, type SigningKey } from './signing';
import type { CapabilityEvalRequirement } from './types';

/** An evaluation record. */
export interface CapabilityEval {
  v: 'nai-capeval-v1';
  evalId: string;
  /** Evaluation suite name and version */
  suite: string;
  /** Score per named capability (scale defined by the suite) */
  scores: Record<string, number>;
  evaluatedAt: number;
  /** What was evaluated (model id, image measurement, …) */
  subject?: string;
}

/** An evaluation signed by an evaluator key. */
export interface SignedCapabilityEval {
  eval: CapabilityEval;
  alg: 'ed25519';
  keyId: string;
  signature: string;
}

const NAME = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Sign an evaluation with an evaluator key (or `Signer`). */
export function signCapabilityEval(ev: CapabilityEval, evaluator: SigningKey): SignedCapabilityEval {
  const shape = evalShapeError(ev);
  if (shape) throw new TypeError(shape);
  const { keyId, signature } = signWith(ev, evaluator, 'evaluator');
  return { eval: ev, alg: 'ed25519', keyId, signature };
}

/**
 * Verify an evaluation against a policy requirement: signed by a listed
 * evaluator, every thresholded score present and within bounds, not too old.
 * Returns the reason it fails, or `null`.
 */
export function verifyCapabilityEval(signed: SignedCapabilityEval, requirement: CapabilityEvalRequirement, now: number, maxSkewMs = 30_000): string | null {
  if (!signed || typeof signed !== 'object' || signed.alg !== 'ed25519' || !signed.eval) return 'malformed capability evaluation';
  const keys: KeyObject[] = [];
  for (const pem of requirement.evaluatorPublicKeysPem) {
    try { keys.push(createPublicKey(pem)); } catch { /* validated with the policy */ }
  }
  const key = keys.find((k) => keyIdOf(k) === signed.keyId);
  if (!key) return 'capability evaluation signed by an unlisted evaluator';
  if (!verifyCanonical(signed.eval, signed.signature, key)) return 'capability evaluation signature invalid';
  const shape = evalShapeError(signed.eval);
  if (shape) return shape;
  const ev = signed.eval;
  if (ev.evaluatedAt > now + maxSkewMs) return 'capability evaluation dated in the future';
  if (now - ev.evaluatedAt > requirement.maxAgeMs) return 'capability evaluation expired';
  for (const [name, bound] of Object.entries(requirement.thresholds)) {
    const score = Object.prototype.hasOwnProperty.call(ev.scores, name) ? ev.scores[name] : undefined;
    if (typeof score !== 'number' || !Number.isFinite(score)) return `capability evaluation lacks score "${name}"`;
    if (bound.min !== undefined && score < bound.min) return `capability score "${name}" below the required minimum`;
    if (bound.max !== undefined && score > bound.max) return `capability score "${name}" above the allowed maximum`;
  }
  return null;
}

function evalShapeError(ev: CapabilityEval): string | null {
  if (!ev || ev.v !== 'nai-capeval-v1') return 'unsupported capability evaluation version';
  if (typeof ev.evalId !== 'string' || !NAME.test(ev.evalId)) return 'capability evaluation evalId invalid';
  if (typeof ev.suite !== 'string' || ev.suite.length === 0 || ev.suite.length > 256) return 'capability evaluation suite invalid';
  if (!Number.isFinite(ev.evaluatedAt)) return 'capability evaluation evaluatedAt invalid';
  if (!ev.scores || typeof ev.scores !== 'object' || Array.isArray(ev.scores)) return 'capability evaluation scores invalid';
  const names = Object.keys(ev.scores);
  if (names.length === 0 || names.length > 256 || names.some((n) => !NAME.test(n) || typeof ev.scores[n] !== 'number' || !Number.isFinite(ev.scores[n]))) {
    return 'capability evaluation scores invalid';
  }
  if (ev.subject !== undefined && (typeof ev.subject !== 'string' || ev.subject.length > 512)) return 'capability evaluation subject invalid';
  return null;
}
