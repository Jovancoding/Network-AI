/**
 * Perpetual Runtime — operator-signed human checkpoints (Phase 5a.2).
 *
 * With `RenewalPolicy.humanCheckpointEveryMs` set, the authority stops
 * renewing once the newest operator checkpoint is older than the interval.
 * Even a fully compromised run therefore ends at the next checkpoint unless a
 * human actively decides to continue it.
 *
 * @module PerpetualCheckpoint
 */

import { randomBytes, type KeyObject } from 'crypto';
import { ensureEd25519, keyIdOf, signWith, verifyCanonical, type SigningKey } from './signing';

/** Which runs a checkpoint covers. */
export type CheckpointScope = { runId: string } | { all: true };

/** The claims inside a checkpoint. */
export interface Checkpoint {
  v: 'nai-checkpoint-v1';
  /** `policyHash()` of the policy the operator reviewed */
  policyHash: string;
  scope: CheckpointScope;
  issuedAt: number;
  /** The authority rejects the checkpoint after this time (max 1 h after `issuedAt`) */
  notAfter: number;
  nonce: string;
}

/** A checkpoint signed by the operator key. */
export interface SignedCheckpoint {
  checkpoint: Checkpoint;
  alg: 'ed25519';
  keyId: string;
  signature: string;
}

/** Longest window between signing and submitting a checkpoint. */
export const MAX_CHECKPOINT_VALIDITY_MS = 60 * 60 * 1000;
const RUN_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const HASH = /^[0-9a-f]{64}$/;

/** Create and sign a checkpoint (operator side). */
export function signCheckpoint(
  input: { policyHash: string; scope: CheckpointScope; now?: number; validForMs?: number },
  operator: SigningKey,
): SignedCheckpoint {
  const issuedAt = input.now ?? Date.now();
  const validFor = input.validForMs ?? 10 * 60 * 1000;
  if (!(Number.isInteger(validFor) && validFor > 0 && validFor <= MAX_CHECKPOINT_VALIDITY_MS)) {
    throw new TypeError(`validForMs must be between 1 ms and ${MAX_CHECKPOINT_VALIDITY_MS}`);
  }
  const checkpoint: Checkpoint = {
    v: 'nai-checkpoint-v1',
    policyHash: input.policyHash,
    scope: 'all' in input.scope && input.scope.all === true ? { all: true } : { runId: (input.scope as { runId: string }).runId },
    issuedAt,
    notAfter: issuedAt + validFor,
    nonce: randomBytes(16).toString('hex'),
  };
  const shape = checkpointShapeError(checkpoint);
  if (shape) throw new TypeError(shape);
  const { keyId, signature } = signWith(checkpoint, operator, 'operator');
  return { checkpoint, alg: 'ed25519', keyId, signature };
}

/**
 * Verify a checkpoint's signature, shape, policy binding, and freshness.
 * Returns the reason it is invalid, or `null`. Replay and ordering checks are
 * the caller's (the authority keeps that state).
 */
export function verifyCheckpoint(
  signed: SignedCheckpoint,
  operatorPublicKey: KeyObject,
  expectedPolicyHash: string,
  now: number,
  maxSkewMs = 30_000,
): string | null {
  ensureEd25519(operatorPublicKey, 'public', 'operatorPublicKey');
  if (!signed || typeof signed !== 'object' || signed.alg !== 'ed25519' || !signed.checkpoint) return 'malformed checkpoint';
  if (signed.keyId !== keyIdOf(operatorPublicKey)) return 'checkpoint signed by an unknown key';
  if (!verifyCanonical(signed.checkpoint, signed.signature, operatorPublicKey)) return 'checkpoint signature invalid';
  const shape = checkpointShapeError(signed.checkpoint);
  if (shape) return shape;
  const c = signed.checkpoint;
  if (c.policyHash !== expectedPolicyHash) return 'checkpoint is for a different policy';
  if (c.issuedAt > now + maxSkewMs) return 'checkpoint issued in the future';
  if (now > c.notAfter) return 'checkpoint expired';
  return null;
}

function checkpointShapeError(c: Checkpoint): string | null {
  if (!c || c.v !== 'nai-checkpoint-v1') return 'unsupported checkpoint version';
  if (typeof c.policyHash !== 'string' || !HASH.test(c.policyHash)) return 'checkpoint.policyHash is invalid';
  if (!Number.isFinite(c.issuedAt) || !Number.isFinite(c.notAfter)) return 'checkpoint times invalid';
  if (c.notAfter <= c.issuedAt || c.notAfter - c.issuedAt > MAX_CHECKPOINT_VALIDITY_MS) return 'checkpoint validity window invalid';
  if (typeof c.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(c.nonce)) return 'checkpoint.nonce is invalid';
  const s = c.scope as Record<string, unknown> | undefined;
  if (!s || typeof s !== 'object') return 'checkpoint.scope is invalid';
  const keys = Object.keys(s);
  if (keys.length === 1 && s['all'] === true) return null;
  if (keys.length === 1 && typeof s['runId'] === 'string' && RUN_ID.test(s['runId'])) return null;
  return 'checkpoint.scope must be { runId } or { all: true }';
}
