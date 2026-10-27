/**
 * Perpetual Runtime — self-healing state.
 *
 * {@link StateSnapshotter} takes verified snapshots of blackboard state: each
 * snapshot is HMAC-signed and hash-chained to the previous one in a manifest,
 * so a tampered, reordered, or deleted snapshot is detected before restore.
 * {@link SelfHealer} runs canary tasks on a schedule; on failure it reports
 * `failing` health (so the lease authority stops renewing), rolls state back
 * to the last verified snapshot, and purges the failed session's credentials.
 *
 * @module SelfHealing
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join, resolve } from 'path';
import { randomBytes } from 'crypto';
import { canonicalHash, canonicalHmac, hexEqual } from '../asi/canonical';

/** The blackboard surface the snapshotter needs (`LockedBlackboard` satisfies it). */
export interface SnapshotBoard {
  listKeys(): string[];
  read(key: string): { value: unknown; source_agent: string; timestamp: string; ttl: number | null } | null;
  write(key: string, value: unknown, sourceAgent: string, ttl?: number): unknown;
  delete(key: string): boolean;
}

/** One entry in the snapshot manifest. */
export interface SnapshotManifestEntry {
  v: 'nai-snapshot-v1';
  id: string;
  label: string;
  createdAt: number;
  keyCount: number;
  entriesHash: string;
  prevHash: string;
  hash: string;
  mac: string;
}

interface SnapshotFile {
  id: string;
  entries: Record<string, { value: unknown; source_agent: string; timestamp: string; ttl: number | null }>;
}

const GENESIS = '0'.repeat(64);
const ID = /^snap_[0-9a-f]{24}$/;

/** Verified, hash-chained blackboard snapshots. */
export class StateSnapshotter {
  private readonly dir: string;
  private readonly manifestPath: string;

  /**
   * @param dir     Snapshot directory (keep it outside the agent's writable paths)
   * @param secret  HMAC key (≥ 32 chars) held by the healer, not the agent
   */
  constructor(dir: string, private readonly secret: string, private readonly now: () => number = Date.now) {
    if (typeof secret !== 'string' || secret.length < 32) throw new TypeError('StateSnapshotter: secret must be at least 32 characters');
    this.dir = resolve(dir);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.manifestPath = join(this.dir, 'manifest.jsonl');
  }

  /** Snapshot every live key. Returns the manifest entry. */
  snapshot(board: SnapshotBoard, label = 'snapshot'): SnapshotManifestEntry {
    const entries: SnapshotFile['entries'] = {};
    for (const key of board.listKeys().sort()) {
      const e = board.read(key);
      if (e) entries[key] = { value: e.value, source_agent: e.source_agent, timestamp: e.timestamp, ttl: e.ttl };
    }
    const id = `snap_${randomBytes(12).toString('hex')}`;
    const file: SnapshotFile = { id, entries };
    const tmp = join(this.dir, `${id}.json.tmp`);
    writeFileSync(tmp, JSON.stringify(file), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, join(this.dir, `${id}.json`));
    const prev = this.manifest().at(-1);
    const body = {
      v: 'nai-snapshot-v1' as const, id, label: String(label).slice(0, 128), createdAt: this.now(),
      keyCount: Object.keys(entries).length, entriesHash: canonicalHash(entries), prevHash: prev?.hash ?? GENESIS,
    };
    const hash = canonicalHash(body);
    const entry: SnapshotManifestEntry = { ...body, hash, mac: canonicalHmac(this.secret, { ...body, hash }) };
    appendFileSync(this.manifestPath, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
    return entry;
  }

  /** Manifest entries in order (malformed lines skipped; verification catches gaps). */
  manifest(): SnapshotManifestEntry[] {
    if (!existsSync(this.manifestPath)) return [];
    const out: SnapshotManifestEntry[] = [];
    for (const line of readFileSync(this.manifestPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as SnapshotManifestEntry); } catch { /* skip */ }
    }
    return out;
  }

  /**
   * Verify one snapshot: its manifest MAC, the hash chain up to it, and the
   * snapshot file contents. Returns the reason it is invalid, or `null`.
   */
  verify(id: string): string | null {
    if (!ID.test(id)) return 'invalid snapshot id';
    let prevHash = GENESIS;
    for (const m of this.manifest()) {
      const { hash, mac, ...body } = m;
      if (m.prevHash !== prevHash) return `manifest chain broken at ${m.id}`;
      if (canonicalHash(body) !== hash) return `manifest entry ${m.id} altered`;
      if (typeof mac !== 'string' || !hexEqual(mac, canonicalHmac(this.secret, { ...body, hash }))) return `manifest entry ${m.id} not signed by this healer`;
      prevHash = hash;
      if (m.id !== id) continue;
      const file = this.load(id);
      if (!file) return 'snapshot file missing or unreadable';
      if (canonicalHash(file.entries) !== m.entriesHash) return 'snapshot contents altered';
      return null;
    }
    return 'snapshot not in manifest';
  }

  /** The newest snapshot that verifies, or `null`. */
  latestVerified(): SnapshotManifestEntry | null {
    const all = this.manifest();
    for (let i = all.length - 1; i >= 0; i--) if (this.verify(all[i].id) === null) return all[i];
    return null;
  }

  /**
   * Restore a verified snapshot: keys absent from it are deleted, the rest
   * rewritten with their snapshot values. Throws if verification fails.
   */
  restore(board: SnapshotBoard, id: string, restoredBy = 'self-healer'): { restored: number; deleted: number } {
    const reason = this.verify(id);
    if (reason) throw new Error(`restore refused: ${reason}`);
    const file = this.load(id)!;
    let deleted = 0;
    for (const key of board.listKeys()) {
      if (!(key in file.entries) && board.delete(key)) deleted++;
    }
    let restored = 0;
    for (const [key, e] of Object.entries(file.entries)) {
      board.write(key, e.value, `${restoredBy}:${e.source_agent}`.slice(0, 256), e.ttl ?? undefined);
      restored++;
    }
    return { restored, deleted };
  }

  private load(id: string): SnapshotFile | null {
    try {
      const f = JSON.parse(readFileSync(join(this.dir, `${id}.json`), 'utf8')) as SnapshotFile;
      return f && f.id === id && f.entries && typeof f.entries === 'object' ? f : null;
    } catch {
      return null;
    }
  }
}

/** A scheduled health probe. Resolve `true` when healthy. */
export interface CanaryTask {
  name: string;
  run(): Promise<boolean>;
}

/** Outcome of one canary round. */
export interface CanaryReport {
  at: number;
  passed: string[];
  failed: string[];
  rolledBackTo?: string;
  rollbackError?: string;
}

/** Options for {@link SelfHealer}. */
export interface SelfHealerOptions {
  board: SnapshotBoard;
  snapshotter: StateSnapshotter;
  canaries: readonly CanaryTask[];
  /** Per-canary timeout (default 30 s) */
  canaryTimeoutMs?: number;
  /** Take a snapshot after every fully passing round (default true) */
  snapshotOnPass?: boolean;
  /** Roll back on failure (default true) */
  rollbackOnFailure?: boolean;
  /** Revoke the failed session's tokens/credentials (e.g. `SecureTokenManager` revocation) */
  purgeSession?: () => void | Promise<void>;
  onReport?: (report: CanaryReport) => void;
  now?: () => number;
}

/** Canary-driven health, rollback, and session purge. */
export class SelfHealer {
  private state: { health: 'ok' | 'degraded' | 'failing'; canaryFailed: boolean } = { health: 'ok', canaryFailed: false };
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly now: () => number;

  constructor(private readonly options: SelfHealerOptions) {
    if (!options?.board || !options.snapshotter || !Array.isArray(options.canaries)) throw new TypeError('SelfHealer: board, snapshotter, and canaries are required');
    this.now = options.now ?? Date.now;
  }

  /** Health for `LeaseGuard`'s `health` option; a canary failure stays sticky until the operator intervenes. */
  health(): { health: 'ok' | 'degraded' | 'failing'; canaryFailed?: boolean } {
    return { ...this.state };
  }

  /** Run every canary once and react to failures. */
  async runOnce(): Promise<CanaryReport> {
    const report: CanaryReport = { at: this.now(), passed: [], failed: [] };
    for (const c of this.options.canaries) {
      let ok = false;
      try { ok = (await withTimeout(c.run(), this.options.canaryTimeoutMs ?? 30_000)) === true; } catch { ok = false; }
      (ok ? report.passed : report.failed).push(c.name);
    }
    if (report.failed.length === 0) {
      if (this.options.snapshotOnPass !== false && !this.state.canaryFailed) this.options.snapshotter.snapshot(this.options.board, 'canary-pass');
    } else {
      this.state = { health: 'failing', canaryFailed: true };
      if (this.options.rollbackOnFailure !== false) {
        const target = this.options.snapshotter.latestVerified();
        if (target) {
          try {
            this.options.snapshotter.restore(this.options.board, target.id);
            report.rolledBackTo = target.id;
          } catch (err) {
            report.rollbackError = err instanceof Error ? err.message : String(err);
          }
        } else {
          report.rollbackError = 'no verified snapshot';
        }
      }
      try { await this.options.purgeSession?.(); } catch { /* purge is best effort; renewal already stops */ }
    }
    try { this.options.onReport?.(report); } catch { /* audit only */ }
    return report;
  }

  /** Run canaries every `intervalMs`. */
  start(intervalMs: number): void {
    if (!(intervalMs >= 1_000)) throw new RangeError('SelfHealer: intervalMs must be at least 1000');
    this.stop();
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.runOnce().finally(() => { this.running = false; });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const t = setTimeout(() => reject(new Error('canary timed out')), ms);
    p.then((v) => { clearTimeout(t); resolvePromise(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
  });
}
