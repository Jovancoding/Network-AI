/**
 * Perpetual Runtime — self-improvement pipeline.
 *
 * Agents propose patches to their own code, prompts, and config; nothing is
 * written until the pipeline has gathered evidence and issued a signed
 * receipt bound to the exact patch hash:
 *
 * 1. static checks — path safety, size limits, risky constructs, dependency diff;
 * 2. tests in a disposable sandbox (`ISandboxRunner`) against a copy of the project;
 * 3. BFT consensus across independent model families (`ConsensusEngine`);
 * 4. an approval tier per path class:
 *    - `auto`     — the agent's own task code/prompts (listed `autoPaths`): tests + consensus;
 *    - `human`    — everything else: a human decision is required;
 *    - `operator` — guarded paths: an operator-signed approval of the exact content, always.
 *
 * @module ImprovementPipeline
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, renameSync, unlinkSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { randomBytes } from 'crypto';
import { canonicalHash } from '../asi/canonical';
import type { ConsensusEngine } from '../asi/consensus';
import type { ConsensusEvaluator } from '../asi/types';
import { keyIdOf, signCanonical, verifyCanonical, type Ed25519KeyPair } from './signing';
import type { GuardedTarget } from './guarded-paths';
import type { ISandboxRunner, SandboxLimits, SandboxReceipt } from './sandbox';

/** One file in a patch; `content: null` deletes it. */
export interface PatchFile {
  path: string;
  content: string | null;
}

/** A self-improvement proposal. */
export interface ImprovementProposal {
  id: string;
  agentId: string;
  description: string;
  files: readonly PatchFile[];
}

/** Approval tier for a proposal. */
export type ImprovementTier = 'auto' | 'human' | 'operator';

/** A static-analysis result; `reject` stops the proposal, `escalate` forces human review. */
export interface StaticFinding {
  path: string;
  rule: string;
  detail: string;
  severity: 'escalate' | 'reject';
}

/** A custom static rule. */
export interface StaticRule {
  name: string;
  check(file: PatchFile, previous: string | null): StaticFinding | null;
}

/** Evidence gathered for one proposal. */
export interface ImprovementEvidence {
  static: StaticFinding[];
  tests?: { exitCode: number; timedOut: boolean; receipt: SandboxReceipt; output: string };
  consensus?: { accepted: boolean; agreement: number; families: number; reason?: string };
  human?: { approved: boolean; approvedBy?: string; reason?: string };
  guarded: string[];
}

/** What the pipeline concluded. */
export interface ImprovementDecision {
  proposalId: string;
  patchHash: string;
  tier: ImprovementTier;
  approved: boolean;
  reason?: string;
  evidence: ImprovementEvidence;
  receipt?: SignedImprovementReceipt;
}

/** Receipt claims; `apply` only writes a patch whose hash matches. */
export interface ImprovementReceipt {
  v: 'nai-improvement-v1';
  proposalId: string;
  agentId: string;
  patchHash: string;
  tier: ImprovementTier;
  evidenceHash: string;
  decidedAt: number;
  expiresAt: number;
  nonce: string;
}

/** A receipt signed by the pipeline key. */
export interface SignedImprovementReceipt {
  receipt: ImprovementReceipt;
  alg: 'ed25519';
  keyId: string;
  signature: string;
}

/** The parts of `GuardedPaths` the pipeline uses. */
export interface PipelineGuard {
  isGuardedPath(p: string): boolean;
  hasApproval(target: GuardedTarget, content: unknown): boolean;
  check(target: GuardedTarget, content: unknown): string | null;
}

/** Options for {@link ImprovementPipeline}. */
export interface ImprovementPipelineOptions {
  projectRoot: string;
  guarded: PipelineGuard;
  /** Path prefixes (relative, `/` separated) eligible for the `auto` tier, e.g. `agents/`, `prompts/` */
  autoPaths: readonly string[];
  /** Signs receipts; keep it outside the agent's reach */
  pipelineKey: Ed25519KeyPair;
  sandbox?: {
    runner: ISandboxRunner;
    /** Test command run in the patched copy, e.g. `['npm', 'test']` */
    testArgv: readonly string[];
    limits?: Partial<SandboxLimits>;
    /** Populate the scratch workspace (default: copy the project without node_modules/.git/data/dist) */
    prepareWorkspace?: (dir: string) => void | Promise<void>;
  };
  consensus?: { engine: ConsensusEngine; evaluators: readonly ConsensusEvaluator[]; minFamilies?: number };
  /** Asked for every `human`-tier proposal (and mixed operator patches); no callback means not approved */
  humanApproval?: (proposal: ImprovementProposal, evidence: ImprovementEvidence) => Promise<{ approved: boolean; approvedBy?: string; reason?: string }>;
  staticRules?: readonly StaticRule[];
  maxFiles?: number;
  maxBytes?: number;
  receiptTtlMs?: number;
  now?: () => number;
  onEvent?: (event: { at: number; proposalId: string; stage: string; outcome: string; detail?: string }) => void;
}

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SKIP_COPY = new Set(['node_modules', '.git', 'data', 'dist']);

const RISKY: readonly { rule: string; re: RegExp; detail: string }[] = [
  { rule: 'child-process', re: /\bchild_process\b/, detail: 'spawns processes' },
  { rule: 'dynamic-code', re: /\beval\s*\(|\bnew\s+Function\s*\(/, detail: 'evaluates dynamic code' },
  { rule: 'env-access', re: /\bprocess\.env\b/, detail: 'reads environment variables' },
  { rule: 'destructive-fs', re: /\b(rmSync|rmdirSync|unlinkSync|chmodSync|chownSync)\b|\bfs\.(rm|rmdir|unlink|chmod|chown)\b/, detail: 'destructive file-system call' },
  { rule: 'outbound-url', re: /https?:\/\/(?!localhost\b|127\.0\.0\.1\b|\[::1\])[A-Za-z0-9.-]+/, detail: 'references an external URL' },
  { rule: 'control-plane', re: /\b(LeaseAuthority|LeaseGuard|EgressProxy|GuardedPaths|HaltCoordinator|tightenAsiConfig|ASI_STRICT_MODE|NETWORK_AI_LEASE_)\b/, detail: 'references the control plane' },
];

/**
 * Gathers evidence for self-improvement patches and issues receipts.
 * Run it outside the agent process (it holds the receipt-signing key); guarded
 * files still need operator approvals even if this key were compromised.
 */
export class ImprovementPipeline {
  private readonly root: string;
  private readonly now: () => number;
  private readonly usedNonces = new Map<string, number>();

  constructor(private readonly options: ImprovementPipelineOptions) {
    if (!options?.projectRoot || !options.guarded || !options.pipelineKey) throw new TypeError('ImprovementPipeline: projectRoot, guarded, and pipelineKey are required');
    this.root = realpathSync(resolve(options.projectRoot));
    this.now = options.now ?? Date.now;
  }

  /** Hash bound into receipts: canonical hash of the files, sorted by path. */
  static patchHash(files: readonly PatchFile[]): string {
    return canonicalHash([...files].map((f) => ({ path: f.path.replace(/\\/g, '/'), content: f.content })).sort((a, b) => (a.path < b.path ? -1 : 1)));
  }

  /** Run every stage and decide. Never writes to the project. */
  async evaluate(proposal: ImprovementProposal): Promise<ImprovementDecision> {
    const evidence: ImprovementEvidence = { static: [], guarded: [] };
    const shapeError = this.validateShape(proposal);
    const patchHash = shapeError ? '' : ImprovementPipeline.patchHash(proposal.files);
    const decide = (tier: ImprovementTier, approved: boolean, reason?: string): ImprovementDecision => {
      this.emit(proposal?.id ?? '?', 'decision', approved ? 'approved' : 'rejected', reason ?? tier);
      return { proposalId: proposal?.id ?? '', patchHash, tier, approved, reason, evidence, receipt: approved ? this.sign(proposal, patchHash, tier, evidence) : undefined };
    };
    if (shapeError) return decide('human', false, shapeError);

    // 1. Static checks.
    for (const file of proposal.files) {
      const previous = this.readCurrent(file.path);
      evidence.static.push(...this.staticChecks(file, previous));
    }
    const rejected = evidence.static.find((f) => f.severity === 'reject');
    if (rejected) return decide('human', false, `static check failed: ${rejected.rule} (${rejected.path})`);

    // 2. Tier.
    const guardedFiles = proposal.files.filter((f) => this.options.guarded.isGuardedPath(this.abs(f.path)));
    evidence.guarded = guardedFiles.map((f) => f.path);
    const isAuto = (p: string) => this.options.autoPaths.some((prefix) => normalizeRel(p).startsWith(prefix.replace(/\\/g, '/')));
    const escalated = evidence.static.some((f) => f.severity === 'escalate');
    const tier: ImprovementTier = guardedFiles.length > 0 ? 'operator' : !escalated && proposal.files.every((f) => isAuto(f.path)) ? 'auto' : 'human';
    this.emit(proposal.id, 'tier', tier);

    if (tier === 'operator') {
      const missing = guardedFiles.filter((f) => !this.options.guarded.hasApproval({ kind: 'path', name: this.abs(f.path) }, f.content));
      if (missing.length > 0) return decide(tier, false, `awaiting operator-signed approval for ${missing.map((f) => f.path).join(', ')}`);
    }

    // 3. Sandbox tests.
    if (this.options.sandbox) {
      evidence.tests = await this.runTests(proposal);
      if (evidence.tests.exitCode !== 0 || evidence.tests.timedOut) return decide(tier, false, `tests failed (exit ${evidence.tests.exitCode}${evidence.tests.timedOut ? ', timed out' : ''})`);
    }

    // 4. Consensus (evidence for every tier; required for auto).
    if (this.options.consensus) {
      const { engine, evaluators } = this.options.consensus;
      const result = await engine.decide({
        agentId: proposal.agentId,
        proposal: renderPatch(proposal),
        context: proposal.description,
        metadata: { proposalId: proposal.id, patchHash, tier },
      }, evaluators);
      const families = new Set(result.ballots.map((b) => b.modelFamily)).size;
      evidence.consensus = { accepted: result.accepted, agreement: result.agreement, families, reason: result.reason };
    }

    if (tier === 'auto') {
      const minFamilies = this.options.consensus?.minFamilies ?? 3;
      if (!evidence.tests) return this.escalate(proposal, evidence, decide, 'auto tier needs sandbox tests');
      if (!evidence.consensus) return this.escalate(proposal, evidence, decide, 'auto tier needs consensus');
      if (!evidence.consensus.accepted) return decide(tier, false, `consensus rejected: ${evidence.consensus.reason ?? 'no agreement'}`);
      if (evidence.consensus.families < minFamilies) return this.escalate(proposal, evidence, decide, `consensus spans ${evidence.consensus.families} model families (need ${minFamilies})`);
      return decide(tier, true);
    }

    const needsHuman = tier === 'human' || proposal.files.some((f) => !this.options.guarded.isGuardedPath(this.abs(f.path)) && (!isAuto(f.path) || escalated));
    if (!needsHuman) return decide(tier, true);
    return this.askHuman(proposal, evidence, (approved, reason) => decide(tier, approved, reason));
  }

  /** Verify a receipt for a proposal. Returns the reason it is invalid, or `null`. */
  verifyReceipt(proposal: ImprovementProposal, signed: SignedImprovementReceipt): string | null {
    if (!signed || signed.alg !== 'ed25519' || !signed.receipt) return 'malformed receipt';
    const r = signed.receipt;
    if (r.v !== 'nai-improvement-v1') return 'unsupported receipt version';
    if (signed.keyId !== this.options.pipelineKey.keyId || !verifyCanonical(r, signed.signature, this.options.pipelineKey.publicKey)) return 'receipt signature invalid';
    if (r.proposalId !== proposal.id || r.agentId !== proposal.agentId) return 'receipt is for a different proposal';
    if (r.patchHash !== ImprovementPipeline.patchHash(proposal.files)) return 'patch changed after approval';
    if (r.expiresAt <= this.now()) return 'receipt expired';
    if (this.usedNonces.has(r.nonce)) return 'receipt already used';
    return null;
  }

  /**
   * Write an approved patch. Verifies the receipt, consumes it, consumes the
   * operator approvals for guarded files, and writes each file atomically.
   */
  apply(proposal: ImprovementProposal, signed: SignedImprovementReceipt): { written: string[]; deleted: string[] } {
    const invalid = this.verifyReceipt(proposal, signed);
    if (invalid) throw new Error(`apply: ${invalid}`);
    const shape = this.validateShape(proposal);
    if (shape) throw new Error(`apply: ${shape}`);
    for (const f of proposal.files) {
      const reason = this.options.guarded.check({ kind: 'path', name: this.abs(f.path) }, f.content);
      if (reason) throw new Error(`apply: ${reason}`);
    }
    this.usedNonces.set(signed.receipt.nonce, signed.receipt.expiresAt);
    const written: string[] = [];
    const deleted: string[] = [];
    for (const f of proposal.files) {
      const target = this.abs(f.path);
      this.assertInsideRoot(dirname(target));
      if (f.content === null) {
        if (existsSync(target)) { unlinkSync(target); deleted.push(f.path); }
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
      writeFileSync(tmp, f.content, { encoding: 'utf8', mode: 0o644 });
      renameSync(tmp, target);
      written.push(f.path);
    }
    this.emit(proposal.id, 'apply', 'written', `${written.length} written, ${deleted.length} deleted`);
    return { written, deleted };
  }

  private async askHuman(
    proposal: ImprovementProposal,
    evidence: ImprovementEvidence,
    done: (approved: boolean, reason?: string) => ImprovementDecision,
  ): Promise<ImprovementDecision> {
    if (!this.options.humanApproval) return done(false, 'awaiting human approval (no approver configured)');
    try {
      evidence.human = await this.options.humanApproval(proposal, evidence);
    } catch (err) {
      evidence.human = { approved: false, reason: err instanceof Error ? err.message : 'approver failed' };
    }
    return evidence.human.approved === true ? done(true) : done(false, `human declined: ${evidence.human.reason ?? 'no reason'}`);
  }

  private escalate(
    proposal: ImprovementProposal,
    evidence: ImprovementEvidence,
    decide: (tier: ImprovementTier, approved: boolean, reason?: string) => ImprovementDecision,
    why: string,
  ): Promise<ImprovementDecision> {
    this.emit(proposal.id, 'escalate', 'human', why);
    return this.askHuman(proposal, evidence, (approved, reason) => decide('human', approved, approved ? undefined : `${why}; ${reason}`));
  }

  private validateShape(p: ImprovementProposal): string | null {
    if (!p || typeof p.id !== 'string' || !ID.test(p.id)) return 'invalid proposal id';
    if (typeof p.agentId !== 'string' || !ID.test(p.agentId)) return 'invalid agentId';
    if (typeof p.description !== 'string' || p.description.length > 10_000) return 'invalid description';
    if (!Array.isArray(p.files) || p.files.length === 0) return 'proposal has no files';
    if (p.files.length > (this.options.maxFiles ?? 50)) return 'too many files';
    let bytes = 0;
    const seen = new Set<string>();
    for (const f of p.files) {
      if (!f || typeof f.path !== 'string' || (f.content !== null && typeof f.content !== 'string')) return 'malformed file entry';
      const rel = normalizeRel(f.path);
      if (!rel || isAbsolute(f.path) || /^[A-Za-z]:/.test(f.path) || rel.split('/').some((s) => s === '..' || s === '') || f.path.includes('\0')) return `unsafe path: ${f.path.slice(0, 200)}`;
      if (seen.has(rel.toLowerCase())) return `duplicate path: ${rel}`;
      seen.add(rel.toLowerCase());
      bytes += f.content?.length ?? 0;
    }
    if (bytes > (this.options.maxBytes ?? 1024 * 1024)) return 'patch too large';
    for (const f of p.files) {
      try { this.assertInsideRoot(dirname(this.abs(f.path))); } catch (err) { return err instanceof Error ? err.message : 'path escapes the project'; }
    }
    return null;
  }

  private staticChecks(file: PatchFile, previous: string | null): StaticFinding[] {
    const out: StaticFinding[] = [];
    const rel = normalizeRel(file.path);
    if (file.content !== null) {
      for (const r of RISKY) {
        if (r.re.test(file.content) && !(previous !== null && r.re.test(previous))) {
          out.push({ path: rel, rule: r.rule, detail: r.detail, severity: 'escalate' });
        }
      }
      if (/(^|\/)package(-lock)?\.json$/.test(rel)) {
        const added = addedDependencies(previous, file.content);
        if (added === null) out.push({ path: rel, rule: 'dependency-diff', detail: 'package manifest is not valid JSON', severity: 'reject' });
        else if (added.length > 0) out.push({ path: rel, rule: 'dependency-diff', detail: `adds dependencies: ${added.join(', ')}`, severity: 'escalate' });
      }
      if (/\.(sh|ps1|bat|cmd|exe|dll|so|dylib)$/i.test(rel)) out.push({ path: rel, rule: 'executable', detail: 'adds or changes an executable/script', severity: 'escalate' });
    }
    for (const rule of this.options.staticRules ?? []) {
      try {
        const f = rule.check(file, previous);
        if (f) out.push(f);
      } catch {
        out.push({ path: rel, rule: rule.name, detail: 'rule failed', severity: 'escalate' });
      }
    }
    return out;
  }

  private async runTests(proposal: ImprovementProposal): Promise<NonNullable<ImprovementEvidence['tests']>> {
    const sb = this.options.sandbox!;
    const dir = mkdtempSync(join(tmpdir(), 'nai-improve-'));
    try {
      if (sb.prepareWorkspace) await sb.prepareWorkspace(dir);
      else cpSync(this.root, dir, { recursive: true, filter: (src) => !SKIP_COPY.has(relative(this.root, src).split(sep)[0]) });
      for (const f of proposal.files) {
        const target = join(dir, normalizeRel(f.path));
        if (f.content === null) { rmSync(target, { force: true }); continue; }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, f.content, 'utf8');
      }
      const r = await sb.runner.run({ argv: sb.testArgv, workspace: dir, limits: sb.limits, network: 'none' });
      this.emit(proposal.id, 'tests', r.exitCode === 0 && !r.timedOut ? 'passed' : 'failed', `exit ${r.exitCode}`);
      return { exitCode: r.exitCode, timedOut: r.timedOut, receipt: r.receipt, output: (r.stdout + r.stderr).slice(-4_000) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private sign(proposal: ImprovementProposal, patchHash: string, tier: ImprovementTier, evidence: ImprovementEvidence): SignedImprovementReceipt {
    const decidedAt = this.now();
    const receipt: ImprovementReceipt = {
      v: 'nai-improvement-v1', proposalId: proposal.id, agentId: proposal.agentId, patchHash, tier,
      evidenceHash: canonicalHash(evidence), decidedAt, expiresAt: decidedAt + (this.options.receiptTtlMs ?? 60 * 60 * 1000),
      nonce: randomBytes(16).toString('hex'),
    };
    return { receipt, alg: 'ed25519', keyId: keyIdOf(this.options.pipelineKey.publicKey), signature: signCanonical(receipt, this.options.pipelineKey.privateKey) };
  }

  private abs(p: string): string {
    return resolve(this.root, normalizeRel(p));
  }

  private assertInsideRoot(dir: string): void {
    let probe = resolve(dir);
    while (!existsSync(probe) && probe !== dirname(probe)) probe = dirname(probe);
    const real = realpathSync(probe);
    if (real !== this.root && !real.startsWith(this.root + sep)) throw new Error('path escapes the project root');
  }

  private readCurrent(p: string): string | null {
    try { return readFileSync(this.abs(p), 'utf8'); } catch { return null; }
  }

  private emit(proposalId: string, stage: string, outcome: string, detail?: string): void {
    try { this.options.onEvent?.({ at: this.now(), proposalId, stage, outcome, detail }); } catch { /* audit only */ }
  }
}

function normalizeRel(p: string): string {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

function renderPatch(p: ImprovementProposal): string {
  return p.files.map((f) => `--- ${normalizeRel(f.path)}\n${f.content === null ? '(deleted)' : f.content.slice(0, 20_000)}`).join('\n\n').slice(0, 100_000);
}

function addedDependencies(previous: string | null, next: string): string[] | null {
  const deps = (text: string | null): Set<string> | null => {
    if (text === null) return new Set();
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const out = new Set<string>();
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies', 'packages']) {
        const v = j[field];
        if (v && typeof v === 'object') for (const k of Object.keys(v)) out.add(k);
      }
      return out;
    } catch {
      return null;
    }
  };
  const before = deps(previous) ?? new Set<string>();
  const after = deps(next);
  if (after === null) return null;
  return [...after].filter((d) => !before.has(d)).slice(0, 50);
}
