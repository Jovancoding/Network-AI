/**
 * Perpetual Runtime — Ed25519 signing and validation for policies and leases.
 *
 * @module PerpetualSigning
 */

import { createHash, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'crypto';
import { spawnSync } from 'child_process';
import { canonicalHash, canonicalJson } from '../asi/canonical';
import { SELF_IMPROVE_TOOL } from './types';
import type { AcceptedRisk, AttestationKind, LeaseClaims, LeaseScope, LeaseTier, RenewalPolicy, SignedLease, SignedPolicy } from './types';

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

// ── Signers (Phase 5b.2) ──────────────────────────────────────────────────────

/**
 * Anything that can produce Ed25519 signatures for a known public key.
 * Implement this over an HSM, YubiKey, TPM, or cloud KMS so the private key
 * never enters this process. `sign` is synchronous; wrap async devices with a
 * helper program and {@link CommandSigner}.
 */
export interface Signer {
  readonly keyId: string;
  readonly publicKey: KeyObject;
  /** Raw 64-byte Ed25519 signature over `data` */
  sign(data: Buffer): Buffer;
}

/** A key pair or a {@link Signer}; accepted by every `sign*` helper. */
export type SigningKey = Pick<Ed25519KeyPair, 'privateKey'> | Signer;

/** {@link Signer} over an in-memory Ed25519 private key. */
export class KeyObjectSigner implements Signer {
  readonly keyId: string;
  readonly publicKey: KeyObject;

  constructor(private readonly privateKey: KeyObject) {
    ensureEd25519(privateKey, 'private', 'privateKey');
    this.publicKey = createPublicKey(privateKey);
    this.keyId = keyIdOf(this.publicKey);
  }

  sign(data: Buffer): Buffer {
    return sign(null, data, this.privateKey);
  }
}

/** Options for {@link CommandSigner}. */
export interface CommandSignerOptions {
  /** Program that reads the message on stdin and writes the signature (raw 64 bytes or 128 hex chars) on stdout */
  command: string;
  args?: readonly string[];
  /** Public key the program signs for; every signature is verified against it */
  publicKey: KeyObject;
  /** Default 10 s */
  timeoutMs?: number;
}

/**
 * {@link Signer} that delegates to an external program over stdin/stdout, so
 * the private key never enters Node memory. No shell is used. Each signature
 * is verified before it is returned; a wrong or missing signature throws.
 */
export class CommandSigner implements Signer {
  readonly keyId: string;
  readonly publicKey: KeyObject;
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly timeoutMs: number;

  constructor(options: CommandSignerOptions) {
    if (typeof options?.command !== 'string' || options.command.length === 0 || options.command.includes('\0')) {
      throw new TypeError('CommandSigner: command is required');
    }
    const args = options.args ?? [];
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || a.includes('\0'))) {
      throw new TypeError('CommandSigner: args must be strings');
    }
    ensureEd25519(options.publicKey, 'public', 'CommandSigner.publicKey');
    this.command = options.command;
    this.args = [...args];
    this.publicKey = options.publicKey;
    this.keyId = keyIdOf(options.publicKey);
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  sign(data: Buffer): Buffer {
    const r = spawnSync(this.command, this.args, {
      input: data,
      timeout: this.timeoutMs,
      maxBuffer: 4096,
      windowsHide: true,
      shell: false,
    });
    if (r.error || r.status !== 0) throw new Error(`CommandSigner: signer exited ${r.error ? r.error.message : `with status ${r.status}`}`);
    const out = r.stdout as Buffer;
    const text = out.toString('utf8').trim();
    const sig = /^[0-9a-f]{128}$/i.test(text) ? Buffer.from(text, 'hex') : out;
    if (sig.length !== 64) throw new Error('CommandSigner: signer returned a malformed signature');
    let ok = false;
    try {
      ok = verify(null, data, this.publicKey, sig);
    } catch {
      ok = false;
    }
    if (!ok) throw new Error('CommandSigner: signer returned a signature that does not verify');
    return sig;
  }
}

/** Whether `key` is a {@link Signer}. */
export function isSigner(key: unknown): key is Signer {
  return !!key && typeof (key as Signer).sign === 'function' && typeof (key as Signer).keyId === 'string' && !!(key as Signer).publicKey;
}

/** Normalize a key pair or signer to a {@link Signer}. */
export function toSigner(key: SigningKey, label = 'signing key'): Signer {
  if (isSigner(key)) {
    ensureEd25519(key.publicKey, 'public', `${label}.publicKey`);
    if (key.keyId !== keyIdOf(key.publicKey)) throw new TypeError(`${label}: keyId does not match its public key`);
    return key;
  }
  const privateKey = (key as Pick<Ed25519KeyPair, 'privateKey'> | undefined)?.privateKey;
  ensureEd25519(privateKey as KeyObject, 'private', `${label}.privateKey`);
  return new KeyObjectSigner(privateKey as KeyObject);
}

/** @internal Sign `canonicalJson(value)` with a key pair or signer. */
export function signWith(value: unknown, key: SigningKey, label?: string): { keyId: string; signature: string } {
  const signer = toSigner(key, label);
  const signature = signer.sign(Buffer.from(canonicalJson(value), 'utf8'));
  if (!Buffer.isBuffer(signature) || signature.length !== 64) throw new Error(`${label ?? 'signer'}: malformed signature`);
  return { keyId: signer.keyId, signature: signature.toString('hex') };
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
  if (policy.stopWhen.tripwire !== undefined && typeof policy.stopWhen.tripwire !== 'boolean') throw new TypeError('policy.stopWhen.tripwire must be boolean');
  validatePhase5Fields(policy);
}

const MIN_CHECKPOINT_MS = 60 * 60 * 1000;
const MAX_CHECKPOINT_MS = 7 * 24 * 60 * 60 * 1000;
const ACCEPTED_RISKS: readonly AcceptedRisk[] = ['single-authority', 'no-capability-eval'];
const ATTESTATION_KINDS: readonly AttestationKind[] = ['tpm-quote', 'sev-snp', 'tdx', 'nitro', 'custom'];
const KEY_ID = /^[0-9a-f]{16}$/;
const MEASUREMENT = /^[A-Za-z0-9+/=_-]{16,256}$/;

function validatePhase5Fields(policy: RenewalPolicy): void {
  const every = policy.humanCheckpointEveryMs;
  if (every !== undefined && !(Number.isInteger(every) && every >= MIN_CHECKPOINT_MS && every <= MAX_CHECKPOINT_MS)) {
    throw new TypeError('policy.humanCheckpointEveryMs must be between 1 h and 7 d');
  }
  const fin = policy.financialDestinations;
  if (fin !== undefined) {
    if (!Array.isArray(fin) || fin.length > 256 || fin.some((d) => typeof d !== 'string' || !NAME.test(d))) {
      throw new TypeError('policy.financialDestinations must be an array of route names');
    }
    if (fin.some((d) => !(policy.scope.destinations ?? []).includes(d))) {
      throw new TypeError('policy.financialDestinations must be a subset of scope.destinations');
    }
  }
  const q = policy.authorityQuorum;
  if (q !== undefined) {
    if (!q || !Number.isInteger(q.threshold) || q.threshold < 1 || q.threshold > 16) throw new TypeError('policy.authorityQuorum.threshold must be an integer between 1 and 16');
    if (!Array.isArray(q.keyIds) || q.keyIds.length > 16 || q.keyIds.some((k) => typeof k !== 'string' || !KEY_ID.test(k))) {
      throw new TypeError('policy.authorityQuorum.keyIds must be up to 16 key ids');
    }
    if (new Set(q.keyIds).size !== q.keyIds.length) throw new TypeError('policy.authorityQuorum.keyIds must be distinct');
    if (q.keyIds.length < q.threshold) throw new TypeError('policy.authorityQuorum needs at least `threshold` key ids');
  }
  const accept = policy.acceptRisk;
  if (accept !== undefined) {
    if (!Array.isArray(accept) || accept.some((r) => !ACCEPTED_RISKS.includes(r)) || new Set(accept).size !== accept.length) {
      throw new TypeError(`policy.acceptRisk entries must be distinct values from: ${ACCEPTED_RISKS.join(', ')}`);
    }
  }
  const att = policy.attestation;
  if (att !== undefined) {
    if (!att || !ATTESTATION_KINDS.includes(att.kind)) throw new TypeError(`policy.attestation.kind must be one of ${ATTESTATION_KINDS.join(', ')}`);
    const m = att.expectedMeasurements;
    if (!Array.isArray(m) || m.length === 0 || m.length > 64 || m.some((x) => typeof x !== 'string' || !MEASUREMENT.test(x))) {
      throw new TypeError('policy.attestation.expectedMeasurements must list 1–64 measurements');
    }
  }
  if (policy.requires !== undefined) {
    if (!policy.requires || typeof policy.requires !== 'object') throw new TypeError('policy.requires must be an object');
    const ce = policy.requires.capabilityEval;
    if (ce !== undefined) validateCapabilityEvalRequirement(ce);
  }
  if (isHighRiskPolicy(policy)) {
    const risks = policy.acceptRisk ?? [];
    if (!((policy.authorityQuorum?.threshold ?? 1) >= 2 || risks.includes('single-authority'))) {
      throw new TypeError('high-risk policy needs authorityQuorum.threshold >= 2 or acceptRisk "single-authority"');
    }
    if (!(policy.requires?.capabilityEval || risks.includes('no-capability-eval'))) {
      throw new TypeError('high-risk policy needs requires.capabilityEval or acceptRisk "no-capability-eval"');
    }
  }
}

function validateCapabilityEvalRequirement(ce: NonNullable<NonNullable<RenewalPolicy['requires']>['capabilityEval']>): void {
  if (!ce || typeof ce !== 'object') throw new TypeError('policy.requires.capabilityEval must be an object');
  const keys = ce.evaluatorPublicKeysPem;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 8) throw new TypeError('capabilityEval.evaluatorPublicKeysPem must list 1–8 keys');
  for (const pem of keys) {
    if (typeof pem !== 'string' || pem.length > 4096) throw new TypeError('capabilityEval.evaluatorPublicKeysPem contains an invalid key');
    let key: KeyObject;
    try {
      key = createPublicKey(pem);
    } catch {
      throw new TypeError('capabilityEval.evaluatorPublicKeysPem contains an invalid key');
    }
    if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('capabilityEval evaluator keys must be Ed25519');
  }
  const t = ce.thresholds;
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new TypeError('capabilityEval.thresholds must be an object');
  const names = Object.keys(t);
  if (names.length === 0 || names.length > 64) throw new TypeError('capabilityEval.thresholds must name 1–64 scores');
  for (const name of names) {
    const b = t[name];
    if (!NAME.test(name) || !b || typeof b !== 'object') throw new TypeError(`capabilityEval.thresholds.${name} is invalid`);
    if (b.min === undefined && b.max === undefined) throw new TypeError(`capabilityEval.thresholds.${name} needs min or max`);
    for (const v of [b.min, b.max]) if (v !== undefined && !Number.isFinite(v)) throw new TypeError(`capabilityEval.thresholds.${name} bounds must be finite`);
    if (b.min !== undefined && b.max !== undefined && b.min > b.max) throw new TypeError(`capabilityEval.thresholds.${name} min exceeds max`);
  }
  if (!Number.isInteger(ce.maxAgeMs) || ce.maxAgeMs < 60_000 || ce.maxAgeMs > 90 * 24 * 60 * 60 * 1000) {
    throw new TypeError('capabilityEval.maxAgeMs must be between 1 min and 90 d');
  }
}

/**
 * A policy is high-risk when it grants the `elevated` tier, the
 * self-improvement tool, or any financial egress route. High-risk policies
 * need k ≥ 2 authorities and a capability evaluation unless the operator
 * signs an explicit `acceptRisk` entry.
 */
export function isHighRiskPolicy(policy: Pick<RenewalPolicy, 'scope' | 'financialDestinations'>): boolean {
  const scope = policy.scope;
  if (!scope) return false;
  if (scope.tier === 'elevated') return true;
  if ((scope.tools ?? []).includes(SELF_IMPROVE_TOOL)) return true;
  const dest = scope.destinations ?? [];
  return (policy.financialDestinations ?? []).some((d) => dest.includes(d));
}

/** Sign a policy with the operator key (or an operator {@link Signer}). */
export function signPolicy(policy: RenewalPolicy, operator: SigningKey): SignedPolicy {
  validatePolicy(policy);
  const { keyId, signature } = signWith(policy, operator, 'operator');
  return { policy, alg: 'ed25519', keyId, signature };
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

/** Sign lease claims with the authority key (or an authority {@link Signer}). */
export function signLease(claims: LeaseClaims, authority: SigningKey): SignedLease {
  const { keyId, signature } = signWith(claims, authority, 'authority');
  return { claims, alg: 'ed25519', keyId, signature };
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

/** Add an authority co-signature over the same claims (k-of-n). */
export function cosignLease(lease: SignedLease, authority: SigningKey): SignedLease {
  const { keyId, signature } = signWith(lease.claims, authority, 'authority');
  if (keyId === lease.keyId || (lease.cosignatures ?? []).some((c) => c.keyId === keyId)) return lease;
  return { ...lease, cosignatures: [...(lease.cosignatures ?? []), { keyId, signature }] };
}

/**
 * Verify that at least `threshold` distinct known authorities signed the
 * lease claims, plus freshness. Unknown or invalid signatures are ignored
 * (they never count). Returns the reason it is invalid, or `null`.
 */
export function verifyLeaseQuorum(
  lease: SignedLease,
  authorityPublicKeys: readonly KeyObject[],
  threshold: number,
  now: number = Date.now(),
  maxSkewMs = 30_000,
): string | null {
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 16) throw new TypeError('threshold must be an integer between 1 and 16');
  if (!Array.isArray(authorityPublicKeys) || authorityPublicKeys.length < threshold) throw new TypeError('fewer authority keys than the threshold');
  const keys = new Map<string, KeyObject>();
  for (const k of authorityPublicKeys) {
    ensureEd25519(k, 'public', 'authorityPublicKey');
    keys.set(keyIdOf(k), k);
  }
  if (!lease || typeof lease !== 'object' || lease.alg !== 'ed25519' || !lease.claims || typeof lease.claims !== 'object') return 'malformed lease';
  const sigs = [{ keyId: lease.keyId, signature: lease.signature }, ...(Array.isArray(lease.cosignatures) ? lease.cosignatures.slice(0, 32) : [])];
  const valid = new Set<string>();
  for (const s of sigs) {
    if (!s || typeof s.keyId !== 'string' || valid.has(s.keyId)) continue;
    const key = keys.get(s.keyId);
    if (key && verifyCanonical(lease.claims, s.signature, key)) valid.add(s.keyId);
  }
  if (valid.size < threshold) return `lease has ${valid.size} valid authority signature(s); ${threshold} required`;
  // The issuing authority's own signature must be among them, so co-signatures alone never make a lease.
  const issuer = (lease.claims as { issuer?: unknown }).issuer;
  if (issuer !== undefined || threshold >= 2) {
    if (typeof issuer !== 'string' || !valid.has(issuer)) return 'lease is not signed by its issuing authority';
  }
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
