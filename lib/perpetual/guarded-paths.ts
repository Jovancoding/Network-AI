/**
 * Perpetual Runtime — guarded paths (invariant I2).
 *
 * Agents may change their own task code, prompts, and state, but never the
 * governance layer that limits them: Network-AI core, ASI and lease config,
 * budgets, sentry and proxy rules, audit logs, and this list itself. Writes to
 * a guarded file or blackboard key need a single-use approval signed by the
 * operator's Ed25519 key and bound to the exact content — consensus alone is
 * never enough.
 *
 * @module GuardedPaths
 */

import { randomBytes, type KeyObject } from 'crypto';
import { isAbsolute, relative, resolve, sep } from 'path';
import { canonicalHash } from '../asi/canonical';
import { ensureEd25519, keyIdOf, signCanonical, verifyCanonical, type Ed25519KeyPair } from './signing';
import type { GuardedCheck } from './types';

/** A file path or blackboard key a write targets. */
export interface GuardedTarget {
  kind: 'path' | 'key';
  name: string;
}

/** What the operator approves: one exact write to one guarded target. */
export interface GuardedApproval {
  v: 'nai-guarded-v1';
  target: GuardedTarget;
  /** {@link guardedContentHash} of the content being written (`null` approves a delete) */
  contentHash: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

/** A {@link GuardedApproval} signed by the operator key. */
export interface SignedGuardedApproval {
  approval: GuardedApproval;
  alg: 'ed25519';
  keyId: string;
  signature: string;
}

/** Thrown when a guarded write has no matching operator approval. */
export class GuardedPathError extends Error {
  constructor(message: string, readonly target: GuardedTarget) {
    super(message);
    this.name = 'GuardedPathError';
  }
}

/** Governance files guarded by default (relative to the project root; `/` suffix = directory). */
export const DEFAULT_GUARDED_PATHS: readonly string[] = [
  'lib/perpetual/', 'lib/asi/', 'lib/locked-blackboard.ts', 'lib/auth-guardian.ts', 'lib/agent-runtime.ts',
  'lib/federated-budget.ts', 'lib/model-budget.ts', 'lib/model-gateway.ts', 'security.ts', 'index.ts',
  'bin/', 'dist/', 'node_modules/', '.git/', '.github/', 'package.json', 'package-lock.json',
  'data/perpetual/', 'data/audit_log.jsonl', 'data/perpetual_audit.jsonl', 'data/egress_audit.jsonl', 'data/SYSTEM_PAUSED',
];

/** Governance blackboard keys guarded by default (`*` suffix = prefix match). */
export const DEFAULT_GUARDED_KEYS: readonly string[] = ['perpetual:*', 'asi:*', 'governance:*', 'policy:*', 'budget:*', 'federated-budget*'];

const MAX_TTL_MS = 24 * 60 * 60 * 1000;

/** Hash a write's content for an approval. Deletes use `null`. */
export function guardedContentHash(content: unknown): string {
  return canonicalHash(content === undefined ? null : content);
}

/** Sign a single-use approval for one exact write to a guarded target (operator side). */
export function signGuardedApproval(
  target: GuardedTarget,
  content: unknown,
  operator: Pick<Ed25519KeyPair, 'privateKey'>,
  opts: { ttlMs?: number; now?: number } = {},
): SignedGuardedApproval {
  ensureEd25519(operator.privateKey, 'private', 'operator.privateKey');
  validateTarget(target);
  const ttl = opts.ttlMs ?? 10 * 60 * 1000;
  if (!(ttl > 0 && ttl <= MAX_TTL_MS)) throw new TypeError('ttlMs must be between 1 ms and 24 h');
  const issuedAt = opts.now ?? Date.now();
  const approval: GuardedApproval = {
    v: 'nai-guarded-v1',
    target: { kind: target.kind, name: target.name },
    contentHash: guardedContentHash(content),
    issuedAt,
    expiresAt: issuedAt + ttl,
    nonce: randomBytes(16).toString('hex'),
  };
  return { approval, alg: 'ed25519', keyId: keyIdOf(operator.privateKey), signature: signCanonical(approval, operator.privateKey) };
}

function validateTarget(target: GuardedTarget): void {
  if (!target || (target.kind !== 'path' && target.kind !== 'key')) throw new TypeError('target.kind must be "path" or "key"');
  if (typeof target.name !== 'string' || target.name.length === 0 || target.name.length > 1024 || target.name.includes('\0')) {
    throw new TypeError('target.name must be a non-empty string');
  }
}

/** Options for {@link GuardedPaths}. */
export interface GuardedPathsOptions {
  /** Operator public key; only approvals it signed are accepted */
  operatorPublicKey: KeyObject;
  /** Root guarded paths are relative to (default: cwd) */
  projectRoot?: string;
  /** Guarded path patterns; replaces {@link DEFAULT_GUARDED_PATHS} */
  paths?: readonly string[];
  /** Guarded key patterns; replaces {@link DEFAULT_GUARDED_KEYS} */
  keys?: readonly string[];
  now?: () => number;
  /** Audit callback for every guarded decision */
  onEvent?: (event: { at: number; target: GuardedTarget; outcome: 'approved' | 'allowed' | 'denied'; reason?: string }) => void;
}

/** Which paths and keys are guarded. Needs no key, so sentries can use it too. */
export class GuardedMatcher {
  readonly root: string;
  private readonly pathRules: readonly string[];
  private readonly keyRules: readonly string[];
  private readonly caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

  constructor(opts: { projectRoot?: string; paths?: readonly string[]; keys?: readonly string[] } = {}) {
    this.root = resolve(opts.projectRoot ?? process.cwd());
    this.pathRules = (opts.paths ?? DEFAULT_GUARDED_PATHS).map((p) => this.fold(p.replace(/\\/g, '/').replace(/^\.\//, '')));
    this.keyRules = opts.keys ?? DEFAULT_GUARDED_KEYS;
  }

  /** Whether `p` (absolute, or relative to the project root) is guarded. Paths outside the root count as guarded. */
  isGuardedPath(p: string): boolean {
    const rel = this.relativePath(p);
    if (rel === null) return true;
    const folded = this.fold(rel);
    return this.pathRules.some((rule) => (rule.endsWith('/') ? folded === rule.slice(0, -1) || folded.startsWith(rule) : folded === rule));
  }

  /** Whether a blackboard key is guarded. */
  isGuardedKey(key: string): boolean {
    return this.keyRules.some((rule) => (rule.endsWith('*') ? key.startsWith(rule.slice(0, -1)) : key === rule));
  }

  /** Root-relative `/`-separated path, case-folded where the file system is; `null` if outside the root. */
  normalize(p: string): string | null {
    const rel = this.relativePath(p);
    return rel === null ? null : this.fold(rel);
  }

  private relativePath(p: string): string | null {
    if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) return null;
    const abs = isAbsolute(p) ? resolve(p) : resolve(this.root, p);
    const rel = relative(this.root, abs);
    if (rel === '') return '';
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    return rel.split(sep).join('/');
  }

  private fold(s: string): string {
    return this.caseInsensitive ? s.toLowerCase() : s;
  }
}

/** Decides whether a write touches the governance layer and whether the operator approved it. */
export class GuardedPaths implements GuardedCheck {
  readonly matcher: GuardedMatcher;
  private readonly approvals = new Map<string, number>();
  private readonly usedNonces = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly options: GuardedPathsOptions) {
    ensureEd25519(options.operatorPublicKey, 'public', 'operatorPublicKey');
    this.matcher = new GuardedMatcher(options);
    this.now = options.now ?? Date.now;
  }

  /** Whether `p` (absolute, or relative to the project root) is guarded. Paths outside the root count as guarded. */
  isGuardedPath(p: string): boolean {
    return this.matcher.isGuardedPath(p);
  }

  /** Whether a blackboard key is guarded. */
  isGuardedKey(key: string): boolean {
    return this.matcher.isGuardedKey(key);
  }

  /** Whether a target is guarded. */
  isGuarded(target: GuardedTarget): boolean {
    return target.kind === 'path' ? this.isGuardedPath(target.name) : this.isGuardedKey(target.name);
  }

  /** Register an operator-signed approval. Throws if it is invalid, expired, or replayed. */
  approve(signed: SignedGuardedApproval): void {
    const reason = this.verify(signed);
    if (reason) {
      this.emit(signed?.approval?.target ?? { kind: 'path', name: '?' }, 'denied', reason);
      throw new GuardedPathError(`approval rejected: ${reason}`, signed?.approval?.target ?? { kind: 'path', name: '?' });
    }
    const a = signed.approval;
    this.usedNonces.set(a.nonce, a.expiresAt);
    this.approvals.set(this.slot(a.target, a.contentHash), a.expiresAt);
    this.emit(a.target, 'approved');
  }

  /**
   * Check a write. Returns `null` when allowed (not guarded, or an approval
   * matched and was consumed), otherwise the reason it is refused.
   */
  check(target: GuardedTarget, content: unknown): string | null {
    if (!this.isGuarded(target)) return null;
    const slot = this.slot(target, guardedContentHash(content));
    const expiresAt = this.approvals.get(slot);
    this.prune();
    if (expiresAt === undefined || expiresAt <= this.now()) {
      const reason = `${target.kind} "${target.name}" is guarded; it needs an operator-signed approval for this exact content`;
      this.emit(target, 'denied', reason);
      return reason;
    }
    this.approvals.delete(slot);
    this.emit(target, 'allowed');
    return null;
  }

  /** Like {@link check}, but throws {@link GuardedPathError}. */
  assertWritable(target: GuardedTarget, content: unknown): void {
    const reason = this.check(target, content);
    if (reason) throw new GuardedPathError(reason, target);
  }

  /** Whether an unexpired approval for this exact write is registered (does not consume it). */
  hasApproval(target: GuardedTarget, content: unknown): boolean {
    const expiresAt = this.approvals.get(this.slot(target, guardedContentHash(content)));
    return expiresAt !== undefined && expiresAt > this.now();
  }

  private verify(signed: SignedGuardedApproval): string | null {
    if (!signed || signed.alg !== 'ed25519' || !signed.approval) return 'malformed approval';
    const a = signed.approval;
    if (a.v !== 'nai-guarded-v1') return 'unsupported approval version';
    try { validateTarget(a.target); } catch (err) { return err instanceof Error ? err.message : 'invalid target'; }
    if (signed.keyId !== keyIdOf(this.options.operatorPublicKey)) return 'approval signed by an unknown key';
    if (!verifyCanonical(a, signed.signature, this.options.operatorPublicKey)) return 'approval signature invalid';
    const now = this.now();
    if (!(a.expiresAt > now) || a.expiresAt - a.issuedAt > MAX_TTL_MS) return 'approval expired';
    if (a.issuedAt > now + 30_000) return 'approval issued in the future';
    if (typeof a.nonce !== 'string' || this.usedNonces.has(a.nonce)) return 'approval already used';
    if (!this.isGuarded(a.target)) return 'target is not guarded';
    return null;
  }

  private slot(target: GuardedTarget, contentHash: string): string {
    const name = target.kind === 'path' ? (this.matcher.normalize(target.name) ?? `\0${target.name}`) : target.name;
    return `${target.kind}\0${name}\0${contentHash}`;
  }

  private prune(): void {
    const now = this.now();
    for (const [k, exp] of this.approvals) if (exp <= now) this.approvals.delete(k);
    for (const [k, exp] of this.usedNonces) if (exp <= now) this.usedNonces.delete(k);
  }

  private emit(target: GuardedTarget, outcome: 'approved' | 'allowed' | 'denied', reason?: string): void {
    try {
      this.options.onEvent?.({ at: this.now(), target, outcome, reason });
    } catch {
      // Audit delivery must never change the decision.
    }
  }
}
