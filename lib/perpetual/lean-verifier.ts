/**
 * Perpetual Runtime — Lean 4 certificate verifier (Phase 5c.3).
 *
 * A `ProofVerifier` for `kind: 'formal-verification'` proofs of **narrow,
 * operator-fixed obligations** (policy objects, budget arithmetic, scope
 * relations). The operator fixes each theorem statement; the agent supplies
 * only the proof. The proof text is screened for escapes (`sorry`, new
 * axioms, extra declarations, elaboration-time code), compiled with a
 * bring-your-own `lean` inside an `ISandboxRunner`, and `#print axioms` must
 * list only Lean's standard axioms.
 *
 * Not a goal: proving arbitrary agent actions safe. Plug it into `ProofGate`
 * or use it as `ImprovementPipeline` evidence; operator-tier changes still
 * need the operator signature.
 *
 * @module LeanCertificateVerifier
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ActionBinding, FormalProof, ProofVerdict, ProofVerifier } from '../asi/types';
import type { ISandboxRunner, SandboxLimits } from './sandbox';

/** An operator-fixed proof obligation. */
export interface LeanObligation {
  /** Definitions the statement refers to (operator-written, trusted) */
  preamble?: string;
  /** The theorem statement (Lean term of type `Prop`) */
  statement: string;
}

/** Options for {@link LeanCertificateVerifier}. */
export interface LeanCertificateVerifierOptions {
  runner: ISandboxRunner;
  /** Obligation id → fixed statement */
  obligations: Readonly<Record<string, LeanObligation>>;
  /** Command that checks a file (default `['lean']`) */
  leanArgv?: readonly string[];
  /** Sandbox limits (default 120 s, 2 GiB) */
  limits?: Partial<SandboxLimits>;
  /** `FormalProof.tool` this verifier accepts (default `lean4`) */
  tool?: string;
}

/** Certificate carried in `FormalProof.certificate` (JSON). */
export interface LeanCertificate {
  obligation: string;
  /** Proof term, or `by` followed by tactics; inserted after `:=` */
  proof: string;
}

const MAX_PROOF = 64 * 1024;
const STANDARD_AXIOMS = new Set(['propext', 'Classical.choice', 'Quot.sound']);
/** Constructs that could change what is being proved, add axioms, or run code at elaboration time. */
const BANNED = /\b(sorry|admit|axiom|axioms|unsafe|opaque|partial|native_decide|native|implemented_by|extern|import|theorem|lemma|def|abbrev|instance|example|structure|inductive|class|attribute|variable|universe|namespace|section|end|open|export|macro|macro_rules|syntax|elab|elab_rules|notation|infix|infixl|infixr|prefix|postfix|initialize|builtin_initialize|set_option|mutual|deriving|private|protected|noncomputable|decreasing_by|termination_by|trace|dbg_trace|trace_state|logInfo|IO)\b|#[A-Za-z_]+|run_cmd|run_tac|run_elab|@\[|\bLean\.|\bunsafeCast\b|\bofReduceBool\b|\btrustCompiler\b|\+native/;

/** Verifies Lean 4 proofs of operator-fixed obligations inside a sandbox. */
export class LeanCertificateVerifier implements ProofVerifier {
  readonly name = 'lean-certificate';
  readonly kinds = ['formal-verification'] as const;

  constructor(private readonly options: LeanCertificateVerifierOptions) {
    if (!options?.runner || !options.obligations || typeof options.obligations !== 'object') throw new TypeError('LeanCertificateVerifier: runner and obligations are required');
    for (const [id, o] of Object.entries(options.obligations)) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id) || typeof o?.statement !== 'string' || o.statement.length === 0) throw new TypeError(`LeanCertificateVerifier: invalid obligation ${id}`);
    }
  }

  /** Screen proof text; returns why it is refused, or `null`. Exposed for tests and pre-checks. */
  static screen(proof: string): string | null {
    if (typeof proof !== 'string' || proof.trim().length === 0) return 'empty proof';
    if (proof.length > MAX_PROOF) return 'proof too large';
    if (/[^\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]/.test(proof)) return 'proof contains control characters';
    // Comments could hide text from this screen while still being parsed differently; refuse them.
    if (/--|\/-/.test(proof)) return 'comments are not allowed in proofs';
    // No string literals or escapes: proofs of these obligations never need them, and they could fake tool output.
    if (/["\\]/.test(proof)) return 'string literals and escapes are not allowed in proofs';
    const m = BANNED.exec(proof);
    return m ? `proof uses a forbidden construct: ${m[0]}` : null;
  }

  async verify(proof: FormalProof, _expected: ActionBinding): Promise<ProofVerdict> {
    const verdict = (valid: boolean, reason?: string): ProofVerdict => ({ valid, reason, verifier: this.name });
    if (proof.kind !== 'formal-verification') return verdict(false, 'not a formal-verification proof');
    if (proof.tool !== (this.options.tool ?? 'lean4')) return verdict(false, `unsupported tool ${String(proof.tool).slice(0, 32)}`);
    let cert: LeanCertificate;
    try {
      cert = JSON.parse(proof.certificate) as LeanCertificate;
    } catch {
      return verdict(false, 'certificate is not JSON');
    }
    if (!cert || typeof cert.obligation !== 'string' || !Object.prototype.hasOwnProperty.call(this.options.obligations, cert.obligation)) {
      return verdict(false, 'unknown obligation');
    }
    const screened = LeanCertificateVerifier.screen(cert.proof);
    if (screened) return verdict(false, screened);
    const ob = this.options.obligations[cert.obligation];
    // A per-run marker the proof cannot know: only the axioms report printed after it counts.
    const marker = `NAI_AXIOMS_${randomBytes(12).toString('hex')}`;
    const source = [
      ob.preamble ?? '',
      '',
      `theorem nai_obligation : ${ob.statement} :=`,
      `  ${cert.proof.replace(/\r?\n/g, '\n  ')}`,
      '',
      `#print "${marker}"`,
      '#print axioms nai_obligation',
      '',
    ].join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'nai-lean-'));
    try {
      writeFileSync(join(dir, 'Obligation.lean'), source, { mode: 0o600 });
      const result = await this.options.runner.run({
        argv: [...(this.options.leanArgv ?? ['lean']), 'Obligation.lean'],
        workspace: dir,
        network: 'none',
        limits: { timeoutMs: 120_000, memoryMb: 2048, ...this.options.limits },
      });
      const out = `${result.stdout}\n${result.stderr}`;
      if (result.timedOut) return verdict(false, 'lean timed out');
      if (result.exitCode !== 0 || /\berror\b/i.test(out)) return verdict(false, 'lean rejected the proof');
      if (/declaration uses 'sorry'|sorryAx/.test(out)) return verdict(false, 'proof uses sorry');
      const axioms = parseAxioms(out, marker);
      if (axioms === null) return verdict(false, 'could not read the axioms report');
      const extra = axioms.filter((a) => !STANDARD_AXIOMS.has(a));
      if (extra.length > 0) return verdict(false, `proof depends on non-standard axioms: ${extra.join(', ')}`);
      return verdict(true);
    } catch (err) {
      return verdict(false, `verifier error: ${err instanceof Error ? err.message.slice(0, 200) : 'failed'}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/**
 * Axioms listed by `#print axioms nai_obligation` after `marker`, or `null`
 * if the marker or a single report after it is missing. Anything the proof
 * printed before the marker is ignored.
 */
function parseAxioms(out: string, marker: string): string[] | null {
  const at = out.indexOf(marker);
  if (at < 0 || out.indexOf(marker, at + marker.length) >= 0) return null;
  const tail = out.slice(at + marker.length);
  const reports = tail.match(/'nai_obligation' (does not depend on any axioms|depends on axioms:)/g) ?? [];
  if (reports.length !== 1) return null;
  if (/'nai_obligation' does not depend on any axioms/.test(tail)) return [];
  const m = /'nai_obligation' depends on axioms:\s*\[([^\]]*)\]/.exec(tail);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}
