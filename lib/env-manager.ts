/**
 * EnvironmentManager — Multi-environment isolation for Network-AI
 *
 * Provides strict data directory separation between environments
 * (dev, st, sit, qa, sandbox, preprod, prod) with promotion chain
 * enforcement, approval gates, and automatic backup/restore.
 *
 * Promotion chain: dev → st → sit → qa → preprod → prod
 * Sandbox is a dead-end (non-promotable testing space).
 *
 * Gate types:
 *   - auto:     promotion proceeds without human interaction
 *   - confirm:  promotion requires `confirmedBy` string to be set
 *   - approval: promotion requires `approvedBy` string to be set
 *
 * @module EnvironmentManager
 * @version 1.0.0
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  statSync,
  lstatSync,
  rmSync,
  openSync,
  closeSync,
  constants,
} from 'fs';
import { join, resolve, dirname } from 'path';
import { randomUUID } from 'crypto';

// ============================================================================
// TYPES
// ============================================================================

/** A named environment. The well-known set is dev/st/sit/qa/sandbox/preprod/prod. */
export type EnvName = 'dev' | 'st' | 'sit' | 'qa' | 'sandbox' | 'preprod' | 'prod' | string;

/** Gate type controlling what is required for promotion into an environment. */
export type GateType = 'auto' | 'confirm' | 'approval';

/**
 * Configuration for the EnvironmentManager.
 * Can be overridden via `data/env-config.json`.
 */
export interface EnvConfig {
  /** Ordered promotion chain. Environments not in this list are non-promotable. */
  chain: EnvName[];
  /** Per-environment gate requirements. Defaults applied if not specified. */
  gates: Record<EnvName, GateType>;
  /** How many backups to retain per environment (default: 10). */
  backupRetain: number;
}

/** Result of a promotion operation. */
export interface PromotionResult {
  from: EnvName;
  to: EnvName;
  configsCopied: string[];
  skipped: string[];
  approvedBy?: string;
  confirmedBy?: string;
  timestamp: string;
}

/** A single file difference between two environments. */
export interface EnvFileDiff {
  file: string;
  status: 'added' | 'removed' | 'changed';
}

/** Result of an env diff operation. */
export interface EnvDiff {
  env1: EnvName;
  env2: EnvName;
  differences: EnvFileDiff[];
}

/** Result of a backup operation. */
export interface BackupResult {
  backupId: string;
  env: EnvName;
  path: string;
  filesCount: number;
}

/** Entry in the backup manifest for an environment. */
export interface BackupEntry {
  backupId: string;
  env: EnvName;
  timestamp: string;
  sizeBytes: number;
  path: string;
}

/** Result of a restore operation. */
export interface RestoreResult {
  backupId: string;
  env: EnvName;
  filesRestored: number;
}

/** Options for a promote() call. */
export interface PromoteOptions {
  /** Required for gates of type 'confirm'. */
  confirmedBy?: string;
  /** Required for gates of type 'approval'. */
  approvedBy?: string;
}

// ============================================================================
// DEFAULTS
// ============================================================================

/** Default promotion chain. */
const DEFAULT_CHAIN: EnvName[] = ['dev', 'st', 'sit', 'qa', 'preprod', 'prod'];

/** Default gate configuration. */
const DEFAULT_GATES: Record<string, GateType> = {
  dev: 'auto',
  st: 'auto',
  sit: 'auto',
  qa: 'auto',
  sandbox: 'auto',
  preprod: 'confirm',
  prod: 'approval',
};

/**
 * Files that ARE copied during promotion (config artefacts only).
 * Live operational state is never promoted.
 */
const PROMOTE_INCLUDE = [
  'trust_levels.json',
  'budget_ceilings.json',
  'validation_rules.json',
];

/**
 * Files/directories that are NEVER copied during promotion.
 * Matches by name prefix or exact name.
 */
const PROMOTE_EXCLUDE = [
  'audit_log.jsonl',
  'active_grants.json',
  'pending_changes',
  '.backups',
];

// ============================================================================
// MAIN CLASS
// ============================================================================

/**
 * Manages isolated data directories for multiple deployment environments.
 *
 * @example
 * ```typescript
 * const mgr = new EnvironmentManager('/path/to/project/data');
 * mgr.initAll();
 * const devDir = mgr.getDataDir('dev');  // → /path/to/project/data/dev
 * mgr.promote('dev', 'st');              // auto-gate
 * mgr.promote('qa', 'preprod', { confirmedBy: 'ops-lead' });
 * mgr.promote('preprod', 'prod', { approvedBy: 'cto@example.com' });
 * ```
 */
export class EnvironmentManager {
  private readonly baseDir: string;
  private readonly config: EnvConfig;
  private readonly _enforcePromotionChain: boolean;

  /**
   * @param baseDir - Root data directory (e.g. `path.join(process.cwd(), 'data')`).
   * @param config - Optional overrides for chain, gates, backup retention, and strict mode.
   */
  constructor(baseDir: string, config?: Partial<EnvConfig> & { enforcePromotionChain?: boolean }) {
    this.baseDir = resolve(baseDir);
    this._enforcePromotionChain = config?.enforcePromotionChain ?? false;
    this.config = {
      chain: config?.chain ?? DEFAULT_CHAIN,
      gates: { ...DEFAULT_GATES, ...(config?.gates ?? {}) },
      backupRetain: config?.backupRetain ?? 10,
    };
    // Load env-config.json if present (overrides constructor config)
    this._loadEnvConfig();
  }

  // --------------------------------------------------------------------------
  // Path helpers
  // --------------------------------------------------------------------------

  /**
   * Returns the isolated data directory for the given environment.
   * Creates it if it does not exist.
   */
  getDataDir(env: EnvName): string {
    const envPath = join(this.baseDir, env);
    // Normalise and guard against traversal
    const safe = resolve(envPath);
    if (!safe.startsWith(this.baseDir + require('path').sep) && safe !== this.baseDir) {
      throw new Error(`Environment name '${env}' would escape the base directory`);
    }
    return safe;
  }

  // --------------------------------------------------------------------------
  // Init
  // --------------------------------------------------------------------------

  /**
   * Scaffold the standard subdirectory layout for a single environment.
   * Idempotent — safe to call multiple times.
   */
  init(env: EnvName): void {
    const base = this.getDataDir(env);
    const dirs = [
      base,
      join(base, 'blackboard'),
      join(base, 'pending_changes'),
      join(base, '.backups'),
    ];
    for (const d of dirs) {
      mkdirSync(d, { recursive: true, mode: 0o700 });
    }
    // Touch empty state files so downstream code never hits ENOENT
    this._touchJson(join(base, 'trust_levels.json'), {});
    this._touchJson(join(base, 'active_grants.json'), []);
    this._touchJson(join(base, 'project-context.json'), { env });
    this._touchFile(join(base, 'audit_log.jsonl'));
  }

  /** Scaffold all environments in the promotion chain plus sandbox. */
  initAll(): void {
    const envs = new Set([...this.config.chain, 'sandbox']);
    for (const env of envs) {
      this.init(env);
    }
  }

  // --------------------------------------------------------------------------
  // Promotion
  // --------------------------------------------------------------------------

  /**
   * Promotes configuration artefacts from one environment to the next.
   * Live state (audit log, active grants, pending changes, blackboard entries)
   * is never promoted.
   *
   * When `enforcePromotionChain: true` was passed at construction, each environment
   * (except the first in the chain) must have a `.promotion-record.json` proving it
   * was previously promoted to via this manager before it can be promoted from.
   * This creates a verifiable chain-of-custody for config artefacts.
   *
   * @throws {Error} If gate requirements are not met, or sandbox is the source.
   */
  promote(from: EnvName, to: EnvName, options: PromoteOptions = {}): PromotionResult {
    if (!this.isPromotable(from)) {
      throw new Error(`Environment '${from}' is not promotable (sandbox is a dead-end)`);
    }

    const chain = this.config.chain;
    const fromIdx = chain.indexOf(from);
    const toIdx = chain.indexOf(to);
    if (fromIdx === -1) throw new Error(`Environment '${from}' is not in the promotion chain`);
    if (toIdx === -1) throw new Error(`Environment '${to}' is not in the promotion chain`);
    if (toIdx !== fromIdx + 1) {
      throw new Error(`Can only promote one step at a time (${from} → ${chain[fromIdx + 1]}, not ${to})`);
    }

    // Strict chain enforcement: environments beyond the first must have a promotion record
    if (this._enforcePromotionChain && fromIdx > 0) {
      const recordPath = join(this.getDataDir(from), '.promotion-record.json');
      if (!existsSync(recordPath)) {
        throw new Error(
          `enforcePromotionChain: environment '${from}' has no promotion record. ` +
          `Promote from '${chain[fromIdx - 1]}' to '${from}' first, or disable enforcePromotionChain.`,
        );
      }
    }

    // Gate enforcement
    const gate = this.getGateType(to);
    if (gate === 'confirm' && !options.confirmedBy) {
      throw new Error(`Promotion to '${to}' requires confirmedBy (gate: confirm)`);
    }
    if (gate === 'approval' && !options.approvedBy) {
      throw new Error(`Promotion to '${to}' requires approvedBy (gate: approval)`);
    }

    // Auto-backup destination before overwriting
    if (existsSync(this.getDataDir(to))) {
      this.backup(to);
    }

    const fromDir = this.getDataDir(from);
    const toDir = this.getDataDir(to);
    this.init(to);

    const copied: string[] = [];
    const skipped: string[] = [];

    // Copy only promotion-safe config files
    for (const file of PROMOTE_INCLUDE) {
      const src = join(fromDir, file);
      const dst = join(toDir, file);
      if (existsSync(src)) {
        copyFileSync(src, dst);
        copied.push(file);
      } else {
        skipped.push(file);
      }
    }

    const result: PromotionResult = {
      from,
      to,
      configsCopied: copied,
      skipped,
      timestamp: new Date().toISOString(),
    };
    if (options.approvedBy) result.approvedBy = options.approvedBy;
    if (options.confirmedBy) result.confirmedBy = options.confirmedBy;

    // Write promotion record so enforcePromotionChain can verify this hop later
    const record = { from, to, timestamp: result.timestamp, approvedBy: options.approvedBy, confirmedBy: options.confirmedBy };
    writeFileSync(join(toDir, '.promotion-record.json'), JSON.stringify(record, null, 2));

    return result;
  }

  // --------------------------------------------------------------------------
  // Diff
  // --------------------------------------------------------------------------

  /**
   * Compares configuration artefacts between two environments.
   * Only compares promotion-safe files.
   */
  diff(env1: EnvName, env2: EnvName): EnvDiff {
    const dir1 = this.getDataDir(env1);
    const dir2 = this.getDataDir(env2);
    const differences: EnvFileDiff[] = [];

    const files1 = this._listConfigFiles(dir1);
    const files2 = this._listConfigFiles(dir2);
    const allFiles = new Set([...files1, ...files2]);

    for (const file of allFiles) {
      const p1 = join(dir1, file);
      const p2 = join(dir2, file);
      const has1 = existsSync(p1);
      const has2 = existsSync(p2);

      if (has1 && !has2) {
        differences.push({ file, status: 'removed' });
      } else if (!has1 && has2) {
        differences.push({ file, status: 'added' });
      } else if (has1 && has2) {
        const c1 = readFileSync(p1, 'utf-8');
        const c2 = readFileSync(p2, 'utf-8');
        if (c1 !== c2) {
          differences.push({ file, status: 'changed' });
        }
      }
    }

    return { env1, env2, differences };
  }

  // --------------------------------------------------------------------------
  // Listing
  // --------------------------------------------------------------------------

  /** List all environments, whether they exist, and how many blackboard keys each has. */
  list(): Array<{ name: EnvName; exists: boolean; keyCount: number }> {
    const envs = new Set([...this.config.chain, 'sandbox']);
    return Array.from(envs).map(name => {
      const dir = join(this.baseDir, name);
      const exists = existsSync(dir);
      let keyCount = 0;
      if (exists) {
        const bbDir = join(dir, 'blackboard');
        if (existsSync(bbDir)) {
          try {
            keyCount = readdirSync(bbDir).filter(f => f.endsWith('.json')).length;
          } catch { /* ignore */ }
        }
      }
      return { name, exists, keyCount };
    });
  }

  /** Returns the configured promotion chain. */
  getChain(): EnvName[] {
    return [...this.config.chain];
  }

  /**
   * Returns true if the environment can be used as a promotion source.
   * 'sandbox' is always false.
   */
  isPromotable(env: EnvName): boolean {
    if (env === 'sandbox') return false;
    return this.config.chain.includes(env);
  }

  /**
   * Returns the next environment in the chain after `env`, or null if `env`
   * is the last in the chain or not in the chain.
   */
  getNextEnv(env: EnvName): EnvName | null {
    const idx = this.config.chain.indexOf(env);
    if (idx === -1 || idx === this.config.chain.length - 1) return null;
    return this.config.chain[idx + 1];
  }

  /** Returns the gate type controlling promotion INTO the given environment. */
  getGateType(env: EnvName): GateType {
    return this.config.gates[env] ?? 'auto';
  }

  // --------------------------------------------------------------------------
  // Backup / Restore
  // --------------------------------------------------------------------------

  /**
   * Creates a timestamped backup of an environment's data directory.
   * Stored at `data/<env>/.backups/<backupId>/`.
   * Automatically prunes old backups to retain at most `backupRetain` copies.
   */
  backup(env: EnvName): BackupResult {
    const envDir = this.getDataDir(env);
    const backupsDir = join(envDir, '.backups');
    mkdirSync(backupsDir, { recursive: true, mode: 0o700 });

    const backupId = new Date().toISOString().replace(/[:.]/g, '-') + '_' + randomUUID().slice(0, 8);
    const backupPath = join(backupsDir, backupId);
    mkdirSync(backupPath, { recursive: true, mode: 0o700 });

    const files = this._collectBackupFiles(envDir);
    for (const rel of files) {
      const src = join(envDir, rel);
      const dst = join(backupPath, rel);
      mkdirSync(join(backupPath, rel.includes('/') ? rel.substring(0, rel.lastIndexOf('/')) : '.'), { recursive: true });
      try { copyFileSync(src, dst); } catch { /* skip unreadable */ }
    }

    // Write manifest
    const manifest: BackupEntry = {
      backupId,
      env,
      timestamp: new Date().toISOString(),
      sizeBytes: this._dirSize(backupPath),
      path: backupPath,
    };
    writeFileSync(join(backupPath, '_manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

    // Prune old backups
    this.pruneBackups(env, this.config.backupRetain);

    return { backupId, env, path: backupPath, filesCount: files.length };
  }

  /**
   * Restores an environment from a previously created backup.
   *
   * @param env - The environment to restore into.
   * @param backupId - The backup ID (from `listBackups()`).
   */
  restore(env: EnvName, backupId: string): RestoreResult {
    const envDir = this.getDataDir(env);
    const backupsDir = join(envDir, '.backups');

    // Reject IDs with path separators, dots, or other traversal characters (GHSA-48x2-6pr9-2jjf)
    if (!/^[\w\-]+$/.test(backupId)) {
      throw new Error(`Invalid backup ID: '${backupId}'`);
    }
    const backupPath = resolve(join(backupsDir, backupId));
    if (dirname(backupPath) !== resolve(backupsDir)) {
      throw new Error(`Backup ID '${backupId}' would escape the backups directory`);
    }

    if (!existsSync(backupPath)) {
      throw new Error(`Backup '${backupId}' not found for environment '${env}'`);
    }

    // Create a safety backup of the current state before restoring
    this.backup(env);

    const files = this._collectBackupFiles(backupPath);
    let restored = 0;
    for (const rel of files) {
      if (rel === '_manifest.json') continue;
      const src = join(backupPath, rel);
      const dst = join(envDir, rel);
      try {
        mkdirSync(join(envDir, rel.includes('/') ? rel.substring(0, rel.lastIndexOf('/')) : '.'), { recursive: true });
        copyFileSync(src, dst);
        restored++;
      } catch { /* skip */ }
    }

    return { backupId, env, filesRestored: restored };
  }

  /**
   * Lists all backups for an environment, newest first.
   */
  listBackups(env: EnvName): BackupEntry[] {
    const envDir = this.getDataDir(env);
    const backupsDir = join(envDir, '.backups');
    if (!existsSync(backupsDir)) return [];

    const entries: BackupEntry[] = [];
    for (const name of readdirSync(backupsDir)) {
      const manifest = join(backupsDir, name, '_manifest.json');
      if (existsSync(manifest)) {
        try {
          const entry = JSON.parse(readFileSync(manifest, 'utf-8')) as BackupEntry;
          entries.push(entry);
        } catch { /* corrupt manifest, skip */ }
      }
    }

    // Sort newest first
    return entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  /**
   * Removes old backups for an environment, keeping only the `keep` most recent.
   * @returns Number of backups deleted.
   */
  pruneBackups(env: EnvName, keep: number): number {
    const all = this.listBackups(env);
    if (all.length <= keep) return 0;

    const toDelete = all.slice(keep);
    const resolvedBackupsDir = resolve(join(this.getDataDir(env), '.backups'));
    let deleted = 0;
    for (const entry of toDelete) {
      try {
        // Recompute the deletion path from backupId instead of trusting entry.path from
        // the manifest — a poisoned manifest could set path to '/' and cause arbitrary
        // recursive deletion (GHSA-2fmp-9rvw-hc96).
        if (!/^[\w\-]+$/.test(entry.backupId)) continue;
        const safePath = resolve(join(resolvedBackupsDir, entry.backupId));
        if (dirname(safePath) !== resolvedBackupsDir) continue;
        rmSync(safePath, { recursive: true, force: true });
        deleted++;
      } catch { /* ignore */ }
    }
    return deleted;
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private _loadEnvConfig(): void {
    const configPath = join(this.baseDir, 'env-config.json');
    if (!existsSync(configPath)) return;
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<EnvConfig>;
      if (Array.isArray(raw.chain)) this.config.chain = raw.chain;
      if (raw.gates && typeof raw.gates === 'object') {
        Object.assign(this.config.gates, raw.gates);
      }
      if (typeof raw.backupRetain === 'number') this.config.backupRetain = raw.backupRetain;
    } catch { /* malformed config — silently ignore */ }
  }

  private _touchJson(filePath: string, defaultValue: unknown): void {
    try {
      const fd = openSync(filePath, (constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY) as number, 0o600);
      try {
        writeFileSync(fd, JSON.stringify(defaultValue, null, 2));
      } finally {
        closeSync(fd);
      }
    } catch { /* file already exists — that's fine */ }
  }

  private _touchFile(filePath: string): void {
    try {
      const fd = openSync(filePath, (constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY) as number, 0o600);
      closeSync(fd);
    } catch { /* file already exists — that's fine */ }
  }

  private _listConfigFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir).filter(f => {
        if (PROMOTE_EXCLUDE.some(ex => f === ex || f.startsWith(ex))) return false;
        // Only include regular files, not directories
        try {
          return statSync(join(dir, f)).isFile();
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  }

  private _collectBackupFiles(dir: string): string[] {
    const results: string[] = [];
    const walk = (current: string, prefix: string): void => {
      let entries: string[];
      try { entries = readdirSync(current); } catch { return; }
      for (const entry of entries) {
        if (entry === '.backups') continue; // don't back up backups
        const full = join(current, entry);
        const rel = prefix ? `${prefix}/${entry}` : entry;
        try {
          const info = lstatSync(full); // lstat: never follow symlinks out of backup root (GHSA-6x2m-p4xp-wg22)
          if (info.isSymbolicLink()) continue; // skip symlinks entirely
          if (info.isDirectory()) {
            walk(full, rel);
          } else if (info.isFile()) {
            results.push(rel);
          }
        } catch { /* skip */ }
      }
    };
    walk(dir, '');
    return results;
  }

  private _dirSize(dir: string): number {
    let size = 0;
    const files = this._collectBackupFiles(dir);
    for (const rel of files) {
      try { size += statSync(join(dir, rel)).size; } catch { /* skip */ }
    }
    return size;
  }
}
