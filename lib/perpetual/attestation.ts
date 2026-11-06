/**
 * Perpetual Runtime — attestation-gated renewal (Phase 5c.1).
 *
 * With `RenewalPolicy.attestation`, every lease carries a fresh
 * `attestationNonce`; the next renewal must present evidence bound to that
 * nonce whose measurement is on the operator-signed list. Modifying the agent
 * image or binaries changes the measurement, so renewal fails and the run
 * stops at lease expiry — no detection needed.
 *
 * Verifiers are bring-your-own (TPM quote, SEV-SNP, TDX, Nitro). A reference
 * {@link SignedQuoteVerifier} (`kind: 'custom'`) covers tests and
 * software-measured boot where a separate key signs the measurement.
 *
 * @module PerpetualAttestation
 */

import { createPublicKey, type KeyObject } from 'crypto';
import { canonicalJson } from '../asi/canonical';
import { ensureEd25519, keyIdOf, signWith, verifyCanonical, type SigningKey } from './signing';
import type { AttestationEvidence, AttestationKind, AttestationRequirement } from './types';

/** Result of checking attestation evidence. */
export interface AttestationResult {
  ok: boolean;
  /** Measurement the evidence attests to (compared against the policy list by the caller) */
  measurement?: string;
  reason?: string;
}

/** Bring-your-own attestation verifier. Must check the evidence is bound to `nonce`. */
export interface AttestationVerifier {
  readonly kind: AttestationKind;
  verify(evidence: string, nonce: string): AttestationResult;
}

/**
 * Check evidence against the policy: right kind, a verifier for it, bound to
 * `expectedNonce`, and a listed measurement. Returns the reason it fails, or `null`.
 */
export function checkAttestation(
  requirement: AttestationRequirement,
  verifiers: readonly AttestationVerifier[],
  evidence: AttestationEvidence | undefined,
  expectedNonce: string | undefined,
): string | null {
  if (!evidence || typeof evidence !== 'object') return 'attestation evidence missing';
  if (evidence.kind !== requirement.kind) return 'attestation kind does not match the policy';
  if (typeof expectedNonce !== 'string' || evidence.nonce !== expectedNonce) return 'attestation nonce is stale or replayed';
  if (typeof evidence.evidence !== 'string' || evidence.evidence.length === 0 || evidence.evidence.length > 32_768) return 'attestation evidence malformed';
  const verifier = verifiers.find((v) => v.kind === requirement.kind);
  if (!verifier) return `no verifier configured for ${requirement.kind}`;
  let result: AttestationResult;
  try {
    result = verifier.verify(evidence.evidence, expectedNonce);
  } catch {
    return 'attestation verifier failed';
  }
  if (!result?.ok) return `attestation invalid: ${result?.reason ?? 'rejected'}`;
  if (typeof result.measurement !== 'string' || !requirement.expectedMeasurements.includes(result.measurement)) return 'attested measurement is not on the policy list';
  return null;
}

interface Quote {
  v: 'nai-quote-v1';
  measurement: string;
  nonce: string;
}

/**
 * Reference quote: a key outside the agent's control (e.g. held by a
 * measured-boot agent or TPM wrapper) signs `{ measurement, nonce }`.
 */
export function signQuote(measurement: string, nonce: string, key: SigningKey): string {
  const quote: Quote = { v: 'nai-quote-v1', measurement, nonce };
  const { keyId, signature } = signWith(quote, key, 'attestation key');
  return Buffer.from(canonicalJson({ ...quote, keyId, signature }), 'utf8').toString('base64url');
}

/** Verifies {@link signQuote} evidence against a fixed attestation public key. */
export class SignedQuoteVerifier implements AttestationVerifier {
  readonly kind = 'custom' as const;
  private readonly keyId: string;

  constructor(private readonly publicKey: KeyObject) {
    ensureEd25519(publicKey, 'public', 'attestation publicKey');
    this.keyId = keyIdOf(publicKey);
  }

  /** Build from a PEM SPKI public key. */
  static fromPem(pem: string): SignedQuoteVerifier {
    return new SignedQuoteVerifier(createPublicKey(pem));
  }

  verify(evidence: string, nonce: string): AttestationResult {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(Buffer.from(evidence, 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: 'evidence is not a quote' };
    }
    if (!parsed || parsed['v'] !== 'nai-quote-v1' || typeof parsed['measurement'] !== 'string' || typeof parsed['nonce'] !== 'string') return { ok: false, reason: 'evidence is not a quote' };
    if (parsed['keyId'] !== this.keyId) return { ok: false, reason: 'quote signed by an unknown key' };
    const quote: Quote = { v: 'nai-quote-v1', measurement: parsed['measurement'], nonce: parsed['nonce'] };
    if (!verifyCanonical(quote, String(parsed['signature']), this.publicKey)) return { ok: false, reason: 'quote signature invalid' };
    if (quote.nonce !== nonce) return { ok: false, reason: 'quote nonce mismatch' };
    return { ok: true, measurement: quote.measurement };
  }
}
