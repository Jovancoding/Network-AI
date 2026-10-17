/**
 * ASI Strict Mode — proof-carrying actions.
 *
 * In strict mode, tools listed in {@link ProofGatePolicy.gatedTools} run only
 * when the call carries a proof that verifies against a binding to *this exact
 * action*: the tool, a hash of the canonical arguments the executor will run,
 * the agent, a single-use nonce, and an expiry. A proof issued for one command
 * therefore cannot authorize a different command, a different agent, or a
 * second run.
 *
 * Verifiers are bring-your-own (zkVM receipts, formal-verification
 * certificates). For deployments without a prover, {@link CapabilityIssuer}
 * issues short-lived signed capability tokens (HMAC-SHA256 or Ed25519) that
 * {@link SignedAttestationVerifier} checks.
 *
 * @module AsiProofGate
 */

import { randomBytes, sign as edSign, verify as edVerify, type KeyObject } from 'crypto';
import { canonicalHash, canonicalHmac, canonicalJson, hexEqual } from './canonical';
import { asiViolation, emitAsiEvent, getAsiConfig, isAsiActive } from './config';
import type {
  ActionBinding,
  AsiStrictConfig,
  FormalProof,
  ProofGateDecision,
  ProofGatePolicy,
  ProofVerdict,
  ProofVerifier,
} from './types';

const MAX_FUTURE_SKEW_MS = 60_000;

/**
 * Create a binding for one action.
 *
 * @param tool     Tool/action name.
 * @param args     The canonical arguments the executor will run.
 * @param agentId  The agent the proof is for.
 * @param ttlMs    Lifetime (default 60 s).
 */
export function bindAction(tool: string, args: unknown, agentId: string, ttlMs = 60_000): ActionBinding {
  const issuedAt = Date.now();
  return {
    tool,
    argsHash: canonicalHash(args),
    agentId,
    nonce: randomBytes(16).toString('hex'),
    issuedAt,
    expiresAt: issuedAt + ttlMs,
  };
}

/** Bytes covered by a signed-attestation signature. */
function attestationPayload(alg: string, signer: string, binding: ActionBinding): string {
  return canonicalJson({ v: 'nai-capability-v1', alg, signer, binding });
}

/** Signing material for {@link CapabilityIssuer}. */
export type CapabilitySigningKey =
  | { alg: 'hmac-sha256'; secret: string | Buffer }
  | { alg: 'ed25519'; privateKey: KeyObject | string };

/**
 * Issues short-lived signed capability tokens — proofs of kind
 * `'signed-attestation'` — for gated actions. Run the issuer outside the
 * agent's process (approval service, operator CLI) so agents cannot mint
 * their own.
 */
export class CapabilityIssuer {
  constructor(private readonly signer: string, private readonly key: CapabilitySigningKey) {
    if (!signer) throw new TypeError('CapabilityIssuer: signer is required');
    if (key.alg === 'hmac-sha256' && (!key.secret || key.secret.length < 16)) {
      throw new TypeError('CapabilityIssuer: HMAC secret must be at least 16 bytes');
    }
  }

  /** Issue a capability for exactly one run of `tool` with `args` by `agentId`. */
  issue(tool: string, args: unknown, agentId: string, ttlMs = 60_000): FormalProof {
    const binding = bindAction(tool, args, agentId, ttlMs);
    const payload = attestationPayload(this.key.alg, this.signer, binding);
    const signature = this.key.alg === 'hmac-sha256'
      ? canonicalHmac(this.key.secret, payload)
      : edSign(null, Buffer.from(payload, 'utf8'), this.key.privateKey).toString('hex');
    return { kind: 'signed-attestation', alg: this.key.alg, signer: this.signer, signature, binding };
  }
}

/** Trusted signers for {@link SignedAttestationVerifier}. */
export interface TrustedSigner {
  name: string;
  alg: 'hmac-sha256' | 'ed25519';
  /** HMAC secret, or Ed25519 public key */
  key: string | Buffer | KeyObject;
}

/** Verifies `'signed-attestation'` proofs from a fixed set of trusted signers. */
export class SignedAttestationVerifier implements ProofVerifier {
  readonly name = 'signed-attestation';
  readonly kinds = ['signed-attestation'] as const;
  private readonly signers: Map<string, TrustedSigner>;

  constructor(signers: readonly TrustedSigner[]) {
    this.signers = new Map(signers.map((s) => [s.name, s]));
  }

  verify(proof: FormalProof, expected: ActionBinding): ProofVerdict {
    if (proof.kind !== 'signed-attestation') return { valid: false, reason: 'wrong proof kind', verifier: this.name };
    const signer = this.signers.get(proof.signer);
    if (!signer || signer.alg !== proof.alg) {
      return { valid: false, reason: `untrusted signer "${proof.signer}"`, verifier: this.name };
    }
    // The gate already matched the binding to the action; sign over the expected one.
    const payload = attestationPayload(proof.alg, proof.signer, expected);
    let ok = false;
    try {
      if (signer.alg === 'hmac-sha256') {
        ok = hexEqual(proof.signature, canonicalHmac(signer.key as string | Buffer, payload));
      } else {
        ok = /^[0-9a-f]+$/i.test(proof.signature)
          && edVerify(null, Buffer.from(payload, 'utf8'), signer.key as KeyObject | string, Buffer.from(proof.signature, 'hex'));
      }
    } catch {
      ok = false;
    }
    return ok ? { valid: true, verifier: this.name } : { valid: false, reason: 'signature mismatch', verifier: this.name };
  }
}

/** A single gated call presented to {@link ProofGate.check}. */
export interface ProofGateRequest {
  tool: string;
  /** Canonical arguments the executor will actually run */
  args: unknown;
  agentId: string;
  proof?: FormalProof;
}

/**
 * Enforces proof-carrying execution for gated tools. Costs one `Set` lookup
 * when strict mode is off or the tool is not gated.
 */
export class ProofGate {
  private readonly gated: Set<string>;
  private readonly usedNonces = new Map<string, number>();

  constructor(private readonly policy: ProofGatePolicy, private readonly config: AsiStrictConfig = getAsiConfig()) {
    this.gated = new Set(policy.gatedTools);
  }

  /** Whether `tool` needs a proof under the current mode. */
  requiresProof(tool: string): boolean {
    return isAsiActive(this.config) && this.gated.has(tool);
  }

  /** Gate additional tools (e.g. MCP tools marked `requires_formal_proof`). Gating is never removed. */
  gateTools(tools: Iterable<string>): void {
    for (const t of tools) {
      if (typeof t === 'string' && t) this.gated.add(t);
    }
  }

  /** Check a call; in audit mode violations are reported but allowed. */
  async check(request: ProofGateRequest): Promise<ProofGateDecision> {
    if (!this.requiresProof(request.tool)) return { allowed: true, gated: false };

    const reason = await this.evaluate(request);
    if (reason === null) {
      emitAsiEvent(this.config, { kind: 'proof', outcome: 'allowed', agentId: request.agentId, details: { tool: request.tool }, at: Date.now() });
      return { allowed: true, gated: true, verdict: { valid: true, verifier: request.proof?.kind ?? 'unknown' } };
    }
    const block = asiViolation(this.config, { kind: 'proof', agentId: request.agentId, reason, details: { tool: request.tool } });
    return { allowed: !block, gated: true, violation: reason, verdict: { valid: false, reason, verifier: request.proof?.kind ?? 'none' } };
  }

  /** Returns `null` when the proof is valid, otherwise the rejection reason. */
  private async evaluate(request: ProofGateRequest): Promise<string | null> {
    const proof = request.proof;
    if (!proof || typeof proof !== 'object' || !proof.binding) return `tool "${request.tool}" requires a formal proof`;

    const b = proof.binding;
    const now = Date.now();
    const argsHash = canonicalHash(request.args);
    if (b.tool !== request.tool) return 'proof is bound to a different tool';
    if (!hexEqual(b.argsHash, argsHash)) return 'proof is bound to different arguments';
    if (b.agentId !== request.agentId) return 'proof is bound to a different agent';
    if (typeof b.expiresAt !== 'number' || now > b.expiresAt) return 'proof expired';
    if (typeof b.issuedAt !== 'number' || b.issuedAt - now > MAX_FUTURE_SKEW_MS) return 'proof issued in the future';
    if (now - b.issuedAt > (this.policy.maxProofAgeMs ?? 300_000)) return 'proof too old';
    if (typeof b.nonce !== 'string' || b.nonce.length < 16) return 'proof nonce missing';

    this.pruneNonces(now);
    if (this.usedNonces.has(b.nonce)) return 'proof already used (replay)';

    const verifier = this.policy.verifiers.find((v) => v.kinds.includes(proof.kind));
    if (!verifier) return `no verifier configured for proof kind "${proof.kind}"`;

    const expected: ActionBinding = { ...b, tool: request.tool, argsHash, agentId: request.agentId };
    let verdict: ProofVerdict;
    try {
      verdict = await verifier.verify(proof, expected);
    } catch (err) {
      return `verifier "${verifier.name}" failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (!verdict.valid) return `proof rejected by ${verdict.verifier}: ${verdict.reason ?? 'invalid'}`;

    if (this.policy.authority?.authorize) {
      try {
        const decision = await this.policy.authority.authorize({ tool: request.tool, agentId: request.agentId, argsHash });
        if (!decision.approved) return `external authority denied: ${decision.reason ?? 'no reason'}`;
      } catch {
        return 'external authority unavailable';
      }
    }

    this.usedNonces.set(b.nonce, b.expiresAt);
    return null;
  }

  private pruneNonces(now: number): void {
    for (const [nonce, expiry] of this.usedNonces) {
      if (expiry < now) this.usedNonces.delete(nonce);
    }
  }
}
