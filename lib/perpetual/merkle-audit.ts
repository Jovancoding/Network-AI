/**
 * Perpetual Runtime — Merkle audit log and proof-carrying claims (Phase 5c.2).
 *
 * An RFC 9162-style append-only Merkle tree over audit entries:
 * - leaf hash `SHA-256(0x00 || entry)`, node hash `SHA-256(0x01 || left || right)`;
 * - inclusion proofs (an entry is in the log) and consistency proofs (a later
 *   tree extends an earlier one — nothing was dropped, edited, or reordered);
 * - signed tree heads (STH) under a dedicated log key;
 * - a witness that only accepts consistent, newer heads (rollback and forks fail).
 *
 * Claims that carry an inclusion proof against a signed head are classified
 * `proven`; claims without one `unproven`; claims whose proof fails `failed`.
 *
 * @module MerkleAuditLog
 */

import { createHash, type KeyObject } from 'crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'fs';
import { dirname, join, basename } from 'path';
import { canonicalJson } from '../asi/canonical';
import { ensureEd25519, keyIdOf, signWith, toSigner, verifyCanonical, type SigningKey } from './signing';

const HEX32 = /^[0-9a-f]{64}$/;

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

/** RFC 9162 leaf hash of an entry (canonical JSON). */
export function leafHashOf(entry: unknown): string {
  return sha256(Buffer.from([0x00]), Buffer.from(canonicalJson(entry), 'utf8')).toString('hex');
}

function nodeHash(left: Buffer, right: Buffer): Buffer {
  return sha256(Buffer.from([0x01]), left, right);
}

function largestPow2Below(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** A tree head: size and root at a time, bound to one log key. */
export interface TreeHead {
  v: 'nai-sth-v1';
  size: number;
  root: string;
  timestamp: number;
  logId: string;
}

/** A tree head signed by the log key. */
export interface SignedTreeHead {
  sth: TreeHead;
  alg: 'ed25519';
  keyId: string;
  signature: string;
}

/** Append-only Merkle log of audit entries (in memory; mirror heads and entries to a witness). */
export class MerkleAuditLog {
  private readonly leaves: Buffer[] = [];

  /** Number of entries. */
  get size(): number {
    return this.leaves.length;
  }

  /** Append an entry; returns its index and leaf hash. */
  append(entry: unknown): { index: number; leafHash: string } {
    const leafHash = leafHashOf(entry);
    this.leaves.push(Buffer.from(leafHash, 'hex'));
    return { index: this.leaves.length - 1, leafHash };
  }

  /** Root hash of the first `size` entries (hex). */
  root(size = this.size): string {
    this.assertSize(size);
    return this.mth(0, size).toString('hex');
  }

  /** Inclusion proof for entry `index` in the tree of `size` entries. */
  inclusionProof(index: number, size = this.size): string[] {
    this.assertSize(size);
    if (!Number.isInteger(index) || index < 0 || index >= size) throw new RangeError('index outside the tree');
    return this.path(index, 0, size).map((b) => b.toString('hex'));
  }

  /** Consistency proof that the tree of `second` entries extends the tree of `first`. */
  consistencyProof(first: number, second = this.size): string[] {
    this.assertSize(second);
    if (!Number.isInteger(first) || first < 1 || first > second) throw new RangeError('first must be between 1 and second');
    if (first === second) return [];
    return this.subproof(first, 0, second, true).map((b) => b.toString('hex'));
  }

  /** Sign the current head with the log key (keep it apart from authority and operator keys). */
  signTreeHead(key: SigningKey, now = Date.now()): SignedTreeHead {
    const signer = toSigner(key, 'log key');
    const sth: TreeHead = { v: 'nai-sth-v1', size: this.size, root: this.root(), timestamp: now, logId: signer.keyId };
    const signed = signWith(sth, signer, 'log key');
    return { sth, alg: 'ed25519', keyId: signed.keyId, signature: signed.signature };
  }

  private assertSize(size: number): void {
    if (!Number.isInteger(size) || size < 0 || size > this.leaves.length) throw new RangeError('size outside the log');
  }

  private mth(start: number, end: number): Buffer {
    const n = end - start;
    if (n === 0) return sha256(Buffer.alloc(0));
    if (n === 1) return this.leaves[start];
    const k = largestPow2Below(n);
    return nodeHash(this.mth(start, start + k), this.mth(start + k, end));
  }

  private path(m: number, start: number, end: number): Buffer[] {
    const n = end - start;
    if (n <= 1) return [];
    const k = largestPow2Below(n);
    return m < k
      ? [...this.path(m, start, start + k), this.mth(start + k, end)]
      : [...this.path(m - k, start + k, end), this.mth(start, start + k)];
  }

  private subproof(m: number, start: number, end: number, b: boolean): Buffer[] {
    const n = end - start;
    if (m === n) return b ? [] : [this.mth(start, end)];
    const k = largestPow2Below(n);
    return m <= k
      ? [...this.subproof(m, start, start + k, b), this.mth(start + k, end)]
      : [...this.subproof(m - k, start + k, end, false), this.mth(start, start + k)];
  }
}

function hexList(proof: unknown): Buffer[] | null {
  if (!Array.isArray(proof) || proof.length > 64) return null;
  const out: Buffer[] = [];
  for (const p of proof) {
    if (typeof p !== 'string' || !HEX32.test(p)) return null;
    out.push(Buffer.from(p, 'hex'));
  }
  return out;
}

/** RFC 9162 §2.1.3.2: verify an inclusion proof. */
export function verifyInclusion(leafHash: string, index: number, size: number, proof: readonly string[], root: string): boolean {
  if (typeof leafHash !== 'string' || !HEX32.test(leafHash) || typeof root !== 'string' || !HEX32.test(root)) return false;
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(size) || index < 0 || index >= size) return false;
  const path = hexList(proof);
  if (!path) return false;
  let fn = index;
  let sn = size - 1;
  let r: Buffer = Buffer.from(leafHash, 'hex');
  for (const p of path) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = nodeHash(p, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && r.equals(Buffer.from(root, 'hex'));
}

/** RFC 9162 §2.1.4.2: verify a consistency proof between two tree heads. */
export function verifyConsistency(first: number, second: number, firstRoot: string, secondRoot: string, proof: readonly string[]): boolean {
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second) || first < 1 || first > second) return false;
  if (typeof firstRoot !== 'string' || !HEX32.test(firstRoot) || typeof secondRoot !== 'string' || !HEX32.test(secondRoot)) return false;
  const path = hexList(proof);
  if (!path) return false;
  if (first === second) return path.length === 0 && firstRoot === secondRoot;
  const firstHash = Buffer.from(firstRoot, 'hex');
  const p = (first & (first - 1)) === 0 ? [firstHash, ...path] : path;
  if (p.length === 0) return false;
  let fn = first - 1;
  let sn = second - 1;
  while (fn % 2 === 1) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
  let fr: Buffer = p[0];
  let sr: Buffer = p[0];
  for (const c of p.slice(1)) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
      }
    } else {
      sr = nodeHash(sr, c);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && fr.equals(firstHash) && sr.equals(Buffer.from(secondRoot, 'hex'));
}

/** Verify a signed tree head. Returns the reason it is invalid, or `null`. */
export function verifyTreeHead(signed: SignedTreeHead, logPublicKey: KeyObject): string | null {
  ensureEd25519(logPublicKey, 'public', 'logPublicKey');
  if (!signed || typeof signed !== 'object' || signed.alg !== 'ed25519' || !signed.sth) return 'malformed tree head';
  const id = keyIdOf(logPublicKey);
  if (signed.keyId !== id || signed.sth.logId !== id) return 'tree head signed by an unknown log key';
  if (!verifyCanonical(signed.sth, signed.signature, logPublicKey)) return 'tree head signature invalid';
  const s = signed.sth;
  if (s.v !== 'nai-sth-v1' || !Number.isSafeInteger(s.size) || s.size < 0 || typeof s.root !== 'string' || !HEX32.test(s.root) || !Number.isFinite(s.timestamp)) return 'tree head malformed';
  return null;
}

/**
 * A witness that persists the newest accepted tree head and only accepts
 * heads that are signed, newer, and consistent with it. Put the file on
 * storage the log operator cannot rewrite (object lock, separate host).
 */
export class FileWitness {
  constructor(private readonly file: string, private readonly logPublicKey: KeyObject) {
    ensureEd25519(logPublicKey, 'public', 'logPublicKey');
  }

  /** Newest accepted head, or `null`. */
  latest(): SignedTreeHead | null {
    if (!existsSync(this.file)) return null;
    try {
      const head = JSON.parse(readFileSync(this.file, 'utf8')) as SignedTreeHead;
      return verifyTreeHead(head, this.logPublicKey) === null ? head : null;
    } catch {
      return null;
    }
  }

  /**
   * Accept `head` if it is validly signed and extends the stored head
   * (consistency proof from the stored size to `head.sth.size`).
   * Returns the reason it is refused, or `null`.
   */
  observe(head: SignedTreeHead, consistencyProof: readonly string[]): string | null {
    const bad = verifyTreeHead(head, this.logPublicKey);
    if (bad) return bad;
    const prev = this.latest();
    if (prev) {
      if (head.sth.size < prev.sth.size) return 'tree head is older than the witnessed head (rollback)';
      if (head.sth.timestamp < prev.sth.timestamp) return 'tree head timestamp went backwards';
      if (prev.sth.size > 0 && !verifyConsistency(prev.sth.size, head.sth.size, prev.sth.root, head.sth.root, consistencyProof)) {
        return 'tree head is not consistent with the witnessed head (fork or rewrite)';
      }
      if (prev.sth.size === head.sth.size && prev.sth.root !== head.sth.root) return 'same size, different root (fork)';
    }
    const tmp = join(dirname(this.file), `.${basename(this.file)}.${process.pid}.tmp`);
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify(head));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file);
    return null;
  }
}

/** Evidence attached to a claim (blackboard entry, inter-agent message). */
export interface ClaimProof {
  index: number;
  proof: string[];
  sth: SignedTreeHead;
}

/** How much a claim can be trusted. */
export type ClaimStatus = 'proven' | 'unproven' | 'failed';

/**
 * Classify a claim: `proven` when `entry` is included in a validly signed
 * tree head, `unproven` without evidence, `failed` when the evidence does not
 * check out (fabricated or altered claims). Policies can require `proven`
 * for high-stakes facts.
 */
export function classifyClaim(entry: unknown, evidence: ClaimProof | undefined, logPublicKey: KeyObject): ClaimStatus {
  if (evidence === undefined || evidence === null) return 'unproven';
  try {
    if (verifyTreeHead(evidence.sth, logPublicKey) !== null) return 'failed';
    return verifyInclusion(leafHashOf(entry), evidence.index, evidence.sth.sth.size, evidence.proof, evidence.sth.sth.root) ? 'proven' : 'failed';
  } catch {
    return 'failed';
  }
}
