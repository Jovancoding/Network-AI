/**
 * Perpetual Runtime — Ed25519 signing and validation for policies and leases.
 *
 * @module PerpetualSigning
 */

import { createHash, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'crypto';
import { canonicalHash, canonicalJson } from '../asi/canonical';
import type { LeaseClaims, LeaseScope, LeaseTier, RenewalPolicy, SignedLease, SignedPolicy } from './types';

/** Thrown when a lease is missing, invalid, expired, revoked, or out of scope. */
export class LeaseError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'LeaseError';
  }
}

/** An Ed25519 key pair. Keep `privateKey` outside every agent environment. */
export interface Ed25519KeyPair {
  publicKey: KeyObject;
  privateKey: KeyObject;
  keyId: string;
}

/** Generate an Ed25519 key pair with its key id. */
export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey, privateKey, keyId: keyIdOf(publicKey) };
}

/** Stable key id: first 16 hex chars of SHA-256 over the SPKI DER public key. */
export function keyIdOf(key: KeyObject): string {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  return createHash('sha256').update(pub.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

/** @internal */
export function ensureEd25519(key: KeyObject, type: 'public' | 'private', label: string): void {
  if (!key || key.asymmetricKeyType !== 'ed25519' || key.type !== type) {
    throw new TypeError(`${label} must be an Ed25519 ${type} KeyObject`);
  }
}

/** @internal Hex Ed25519 signature over `canonicalJson(value)`. */
export function signCanonical(value: unknown, privateKey: KeyObject): string {
  return sign(null, Buffer.from(canonicalJson(value), 'utf8'), privateKey).toString('hex');
}

/** @internal */
export function verifyCanonical(value: unknown, signature: string, publicKey: KeyObject): boolean {
  if (typeof signature !== 'string' || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  try {
    return verify(null, Buffer.from(canonicalJson(value), 'utf8'), publicKey, Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

const TIERS: readonly LeaseTier[] = ['observe', 'standard', 'elevated'];
const MIN_TTL_MS = 10_000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const NAME = /^[A-Za-z0-9_.:-]{1,128}$/;

function validateScope(scope: LeaseScope, label: string): void {
  if (!scope || !TIERS.includes(scope.tier)) throw new TypeError(`${label}.tier must be one of ${TIERS.join(', ')}`);
  for (const [field, list] of [['tools', scope.tools], ['paths', scope.paths], ['destinations', scope.destinations]] as const) {
    if (list === undefined && field !== 'tools') continue;
    if (!Array.isArray(list) || list.length > 256) throw new TypeError(`${label}.${field} must be an array of at most 256 entries`);
    for (const item of list) {
      const ok = field === 'paths'
        ? typeof item === 'string' && item.length > 0 && item.length <= 512 && !item.includes('\0') && !item.split(/[\\/]/).includes('..')
        : typeof item === 'string' && NAME.test(item);
      if (!ok) throw new TypeError(`${label}.${field} contains an invalid entry`);
    }
  }
}

/** Validate a policy's shape and bounds. Throws `TypeError` on any problem. */
export function validatePolicy(policy: RenewalPolicy): void {
  if (!policy || policy.v !== 'nai-policy-v1') throw new TypeError('policy.v must be "nai-policy-v1"');
  if (typeof policy.policyId !== 'string' || !NAME.test(policy.policyId)) throw new TypeError('policy.policyId is invalid');
  if (!Number.isFinite(policy.issuedAt)) throw new TypeError('policy.issuedAt must be epoch ms');
  if (!Number.isInteger(policy.leaseTtlMs) || policy.leaseTtlMs < MIN_TTL_MS || policy.leaseTtlMs > MAX_TTL_MS) {
    throw new TypeError(`policy.leaseTtlMs must be between ${MIN_TTL_MS} and ${MAX_TTL_MS}`);
  }
  if (typeof policy.autoRenew !== 'boolean') throw new TypeError('policy.autoRenew must be boolean');
  if (policy.renewUntil !== undefined && !Number.isFinite(policy.renewUntil)) throw new TypeError('policy.renewUntil must be epoch ms');
  if (!Number.isInteger(policy.heartbeatMaxAgeMs) || policy.heartbeatMaxAgeMs < 1_000 || policy.heartbeatMaxAgeMs > policy.leaseTtlMs) {
    throw new TypeError('policy.heartbeatMaxAgeMs must be between 1000 and leaseTtlMs');
  }
  validateScope(policy.scope, 'policy.scope');
  const b = policy.budget;
  if (!b || !(b.runCeilingUsd >= 0) || !(b.runCeilingTokens >= 0) || !Number.isFinite(b.runCeilingUsd) || !Number.isFinite(b.runCeilingTokens)) {
    throw new TypeError('policy.budget ceilings must be finite non-negative numbers');
  }
  if (!policy.stopWhen || typeof policy.stopWhen !== 'object') throw new TypeError('policy.stopWhen is required');
  const q = policy.stopWhen.sentryQuorum;
  if (q !== undefined && !(Number.isInteger(q) && q >= 1 && q <= 16)) throw new TypeError('policy.stopWhen.sentryQuorum must be an integer between 1 and 16');
  const w = policy.stopWhen.sentryWindowMs;
  if (w !== undefined && !(Number.isInteger(w) && w >= 1_000 && w <= MAX_TTL_MS)) throw new TypeError('policy.stopWhen.sentryWindowMs must be between 1000 and 24 h');
}

/** Sign a policy with the operator key. */
export function signPolicy(policy: RenewalPolicy, operator: Pick<Ed25519KeyPair, 'privateKey'>): SignedPolicy {
  validatePolicy(policy);
  ensureEd25519(operator.privateKey, 'private', 'operator.privateKey');
  return { policy, alg: 'ed25519', keyId: keyIdOf(operator.privateKey), signature: signCanonical(policy, operator.privateKey) };
}

/** Verify an operator-signed policy. Returns the reason it is invalid, or `null`. */
export function verifySignedPolicy(signed: SignedPolicy, operatorPublicKey: KeyObject): string | null {
  ensureEd25519(operatorPublicKey, 'public', 'operatorPublicKey');
  if (!signed || signed.alg !== 'ed25519') return 'policy is not Ed25519-signed';
  if (signed.keyId !== keyIdOf(operatorPublicKey)) return 'policy signed by an unknown key';
  if (!verifyCanonical(signed.policy, signed.signature, operatorPublicKey)) return 'policy signature invalid';
  try {
    validatePolicy(signed.policy);
  } catch (err) {
    return err instanceof Error ? err.message : 'policy invalid';
  }
  return null;
}

/** Hash bound into every lease issued under `signed`. */
export function policyHash(signed: SignedPolicy): string {
  return canonicalHash(signed);
}

/** Sign lease claims with the authority key. */
export function signLease(claims: LeaseClaims, authority: Pick<Ed25519KeyPair, 'privateKey'>): SignedLease {
  ensureEd25519(authority.privateKey, 'private', 'authority.privateKey');
  return { claims, alg: 'ed25519', keyId: keyIdOf(authority.privateKey), signature: signCanonical(claims, authority.privateKey) };
}

/**
 * Verify a lease signature and freshness. Returns the reason it is invalid,
 * or `null`. Revocation is checked separately against the authority.
 */
export function verifyLease(lease: SignedLease, authorityPublicKey: KeyObject, now: number = Date.now(), maxSkewMs = 30_000): string | null {
  ensureEd25519(authorityPublicKey, 'public', 'authorityPublicKey');
  if (!lease || lease.alg !== 'ed25519' || !lease.claims) return 'malformed lease';
  if (lease.keyId !== keyIdOf(authorityPublicKey)) return 'lease signed by an unknown key';
  if (!verifyCanonical(lease.claims, lease.signature, authorityPublicKey)) return 'lease signature invalid';
  const c = lease.claims;
  if (c.v !== 'nai-lease-v1') return 'unsupported lease version';
  if (!Number.isFinite(c.issuedAt) || !Number.isFinite(c.expiresAt) || c.expiresAt <= c.issuedAt) return 'lease times invalid';
  if (c.issuedAt > now + maxSkewMs) return 'lease issued in the future';
  if (now >= c.expiresAt) return 'lease expired';
  return null;
}

/** Whether `inner` grants nothing beyond `outer` (used for tighten-only checks). */
export function scopeWithin(inner: LeaseScope, outer: LeaseScope): boolean {
  if (TIERS.indexOf(inner.tier) > TIERS.indexOf(outer.tier)) return false;
  const subset = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean =>
    (a ?? []).every((x) => (b ?? []).includes(x));
  return subset(inner.tools, outer.tools) && subset(inner.paths, outer.paths) && subset(inner.destinations, outer.destinations);
}
