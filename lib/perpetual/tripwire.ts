/**
 * Perpetual Runtime — honeytokens and tripwires (Phase 5a.3).
 *
 * Decoy credentials and decoy files are planted where a compromised agent
 * would look for secrets (`.env`, key files, config). They are never used
 * legitimately, so any use is a high-confidence signal:
 * - the egress proxy refuses any request carrying a decoy and alerts the
 *   authority as its own authenticated sentry (`sentry:proxy`);
 * - sentries flag reads or writes of decoy paths and decoy values in outputs.
 *
 * With `RenewalPolicy.stopWhen.tripwire`, a proxy tripwire revokes every run.
 *
 * @module PerpetualTripwire
 */

import { randomBytes, randomInt } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { SentryDetector, SentryObservation } from './sentry';

/** Shapes decoy credentials can imitate. */
export type DecoyCredentialFormat = 'openai' | 'aws' | 'github' | 'generic';

/** Kinds of decoy file. */
export type DecoyFileKind = 'env' | 'pem' | 'config';

/** A decoy hit. `canary` is the matched value (same shape as `CanaryRegistry.scan`). */
export interface TripwireHit {
  canary: string;
  label: string;
}

/** Serialized decoys (share with the proxy process via a 0600 file). */
export interface TripwireManifest {
  v: 'nai-tripwires-v1';
  credentials: { label: string; format: DecoyCredentialFormat; value: string }[];
  files: { path: string; kind: DecoyFileKind; content: string }[];
}

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const LABEL = /^[A-Za-z0-9_.:/-]{1,600}$/;
const MAX_DECOYS = 1024;
const MIN_VALUE = 20;

function pick(alphabet: string, n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

function decoyValue(format: DecoyCredentialFormat): string {
  switch (format) {
    case 'openai': return `sk-proj-${pick(BASE62, 48)}`;
    case 'aws': return `AKIA${pick(BASE32, 16)}`;
    case 'github': return `ghp_${pick(BASE62, 36)}`;
    default: return pick(BASE62, 40);
  }
}

function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function validRel(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.length > 512 || p.includes('\0')) return false;
  const n = normalizeRel(p);
  return !path.isAbsolute(p) && !/^[A-Za-z]:/.test(n) && !n.startsWith('/') && !n.split('/').some((s) => s === '..' || s === '');
}

/** A set of decoy credentials and files, with fast detection. */
export class TripwireSet {
  private readonly credentials = new Map<string, { label: string; format: DecoyCredentialFormat }>();
  private readonly files = new Map<string, { kind: DecoyFileKind; content: string }>();

  /** Create a decoy credential and return its value. */
  createCredential(label: string, format: DecoyCredentialFormat = 'generic'): string {
    if (!LABEL.test(label)) throw new TypeError('TripwireSet: invalid label');
    if (!['openai', 'aws', 'github', 'generic'].includes(format)) throw new TypeError('TripwireSet: invalid format');
    this.assertCapacity();
    const value = decoyValue(format);
    this.credentials.set(value, { label, format });
    return value;
  }

  /**
   * Create a decoy file at a relative path (e.g. `.env`, `keys/deploy.pem`).
   * Its embedded credentials are registered as decoys too.
   */
  createFile(relPath: string, kind: DecoyFileKind): { path: string; content: string } {
    if (!validRel(relPath)) throw new TypeError('TripwireSet: decoy path must be relative and inside the workspace');
    const rel = normalizeRel(relPath);
    if (this.files.has(rel)) throw new TypeError(`TripwireSet: decoy ${rel} already exists`);
    let content: string;
    if (kind === 'env') {
      content = [
        `OPENAI_API_KEY=${this.createCredential(`${rel}:OPENAI_API_KEY`, 'openai')}`,
        `AWS_ACCESS_KEY_ID=${this.createCredential(`${rel}:AWS_ACCESS_KEY_ID`, 'aws')}`,
        `AWS_SECRET_ACCESS_KEY=${this.createCredential(`${rel}:AWS_SECRET_ACCESS_KEY`, 'generic')}`,
        `GITHUB_TOKEN=${this.createCredential(`${rel}:GITHUB_TOKEN`, 'github')}`,
        '',
      ].join('\n');
    } else if (kind === 'pem') {
      const body = randomBytes(48).toString('base64');
      this.assertCapacity();
      this.credentials.set(body, { label: `${rel}:private-key`, format: 'generic' });
      // Assembled at runtime: the decoy must look like a key file, but no key-shaped literal lives in source.
      const label = ['PRIVATE', 'KEY'].join(' ');
      content = `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
    } else if (kind === 'config') {
      content = `${JSON.stringify({ apiKey: this.createCredential(`${rel}:apiKey`, 'generic'), endpoint: 'https://api.internal.invalid' }, null, 2)}\n`;
    } else {
      throw new TypeError('TripwireSet: invalid decoy file kind');
    }
    this.files.set(rel, { kind, content });
    return { path: rel, content };
  }

  /**
   * Write every decoy file under `dir` (owner-only, never overwriting).
   * Returns the absolute paths written.
   */
  materialize(dir: string): string[] {
    const root = path.resolve(dir);
    const written: string[] = [];
    for (const [rel, file] of this.files) {
      const target = path.resolve(root, rel);
      const back = path.relative(root, target);
      if (back.startsWith('..') || path.isAbsolute(back)) throw new Error(`TripwireSet: ${rel} escapes ${root}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content, { flag: 'wx', mode: 0o600 });
      written.push(target);
    }
    return written;
  }

  /** Number of decoy values. */
  get size(): number {
    return this.credentials.size;
  }

  /** Relative paths of decoy files. */
  get decoyPaths(): readonly string[] {
    return [...this.files.keys()];
  }

  /**
   * Every decoy present in `value` (a string, Buffer, or any JSON value).
   * Also matches the base64 form of each decoy.
   */
  scan(value: unknown): TripwireHit[] {
    if (this.credentials.size === 0) return [];
    const haystack = typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('latin1') : safeStringify(value);
    if (haystack.length < MIN_VALUE) return [];
    const hits: TripwireHit[] = [];
    for (const [canary, meta] of this.credentials) {
      if (haystack.includes(canary) || haystack.includes(Buffer.from(canary, 'utf8').toString('base64').replace(/=+$/, ''))) {
        hits.push({ canary, label: meta.label });
      }
    }
    return hits;
  }

  /** The decoy file `p` refers to (relative or absolute path ending in it), or `null`. */
  isDecoyPath(p: string): string | null {
    if (typeof p !== 'string' || p.length === 0) return null;
    const n = normalizeRel(p);
    for (const rel of this.files.keys()) {
      if (n === rel || n.endsWith(`/${rel}`)) return rel;
    }
    return null;
  }

  /** Serialize for the proxy / sentry processes. Contains decoy values only (no real secrets). */
  toJSON(): TripwireManifest {
    return {
      v: 'nai-tripwires-v1',
      credentials: [...this.credentials].map(([value, m]) => ({ label: m.label, format: m.format, value })),
      files: [...this.files].map(([p, f]) => ({ path: p, kind: f.kind, content: f.content })),
    };
  }

  /** Load a manifest written by {@link toJSON}. */
  static fromJSON(manifest: unknown): TripwireSet {
    const m = manifest as TripwireManifest;
    if (!m || m.v !== 'nai-tripwires-v1' || !Array.isArray(m.credentials) || !Array.isArray(m.files)) throw new TypeError('invalid tripwire manifest');
    if (m.credentials.length > MAX_DECOYS || m.files.length > MAX_DECOYS) throw new TypeError('tripwire manifest too large');
    const set = new TripwireSet();
    for (const c of m.credentials) {
      if (!c || typeof c.value !== 'string' || c.value.length < MIN_VALUE || c.value.length > 512 || !LABEL.test(c.label)) throw new TypeError('invalid decoy credential');
      set.credentials.set(c.value, { label: c.label, format: c.format });
    }
    for (const f of m.files) {
      if (!f || !validRel(f.path) || typeof f.content !== 'string' || !['env', 'pem', 'config'].includes(f.kind)) throw new TypeError('invalid decoy file');
      set.files.set(normalizeRel(f.path), { kind: f.kind, content: f.content });
    }
    return set;
  }

  private assertCapacity(): void {
    if (this.credentials.size >= MAX_DECOYS) throw new Error('TripwireSet: too many decoys');
  }
}

/** Sentry detector: any touch of a decoy path or appearance of a decoy value is critical. */
export function tripwireDetector(set: Pick<TripwireSet, 'scan' | 'isDecoyPath'>): SentryDetector {
  return {
    name: 'tripwire',
    inspect(obs: SentryObservation) {
      const pathHit = obs.kind === 'file' && obs.target ? set.isDecoyPath(obs.target) : null;
      if (pathHit) {
        return { detector: 'tripwire', level: 'critical', reason: `decoy file touched: ${pathHit.slice(0, 128)}`, agentId: obs.agentId, runId: obs.runId, at: obs.at };
      }
      if (obs.text === undefined && obs.target === undefined) return null;
      const hits = set.scan([obs.text ?? '', obs.target ?? '']);
      return hits.length > 0
        ? { detector: 'tripwire', level: 'critical', reason: `decoy credential used: ${hits[0].label}`, agentId: obs.agentId, runId: obs.runId, at: obs.at }
        : null;
    },
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
