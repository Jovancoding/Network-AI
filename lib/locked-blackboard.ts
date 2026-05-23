/**
 * LockedBlackboard - Atomic Commitment Layer for Multi-Agent Coordination
 * 
 * This module provides file-system mutex locks to ensure atomic writes to the
 * swarm-blackboard.md, preventing split-brain scenarios when multiple agents
 * attempt concurrent updates.
 * 
 * FEATURES:
 * - File-system mutexes (cross-platform)
 * - Atomic propose → validate → commit workflow
 * - Deadlock prevention with lock timeouts
 * - Split-brain detection and recovery
 * 
 * @module LockedBlackboard
 * @version 1.0.0
 * @license MIT
 */

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  openSync,
  closeSync,
  writeSync,
  readdirSync
} from 'fs';
import { join, dirname, resolve } from 'path';
import { randomUUID, createHash } from 'crypto';
import { Logger } from './logger';
import { LockAcquisitionError } from './errors';
import type { SecureAuditLogger } from '../security';

const log = Logger.create('LockedBlackboard');

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/** Conflict resolution strategy for concurrent writes to the same key. */
export type ConflictResolutionStrategy = 'first-commit-wins' | 'priority-wins';

/** Agent priority level (0=low, 1=normal, 2=high, 3=critical). */
export type AgentPriority = 0 | 1 | 2 | 3;

/** Configuration options for LockedBlackboard. */
export interface LockedBlackboardOptions {
  /** How to resolve conflicts when multiple agents write to the same key.
   *  - `'first-commit-wins'` (default): The first validated+committed change wins; later ones are aborted.
   *  - `'priority-wins'`: Higher-priority changes preempt lower-priority pending/committed writes on the same key.
   *    Equal-priority conflicts resolve in favor of the most recent proposal by arrival order (last-writer-wins).
   */
  conflictResolution?: ConflictResolutionStrategy;
  /** Minimum milliseconds between consecutive write/commit operations (0 = no throttle) */
  throttleMs?: number;
  /**
   * Environment name (e.g. `'dev'`, `'prod'`).  When set, all data is scoped
   * to `<basePath>/<env>/` keeping environments completely isolated.
   * Falls back to the `NETWORK_AI_ENV` environment variable when not provided.
   * The value is captured once at construction time — runtime changes to
   * `NETWORK_AI_ENV` after the instance is created have no effect.
   *
   * **Read isolation:** The mutex protects the `commit` step only.
   * Between `propose()` and `validate()`, other agents can read stale data.
   * For read-then-write safety, use `propose()` optimistically and handle
   * `CONFLICT` rejections from `validateChange()` by re-reading and re-proposing.
   */
  env?: string;
  /**
   * When `true` (or when `NETWORK_AI_MINIMAL=1` env var is set), skip WAL
   * replay on startup and disable TTL sweep.  Useful for CI and test
   * environments where fast startup is more important than crash recovery.
   */
  disableWal?: boolean;
}

export interface BlackboardEntry {
  key: string;
  value: unknown;
  source_agent: string;
  timestamp: string;
  ttl: number | null;
  version: number;
}

export interface PendingChange {
  change_id: string;
  key: string;
  value: unknown;
  source_agent: string;
  proposed_at: string;
  ttl: number | null;
  status: 'pending' | 'validated' | 'committed' | 'aborted';
  previous_hash: string | null;
  /** Agent priority (0=low, 1=normal, 2=high, 3=critical). Defaults to 0. */
  priority: AgentPriority;
  validation?: {
    validated_at: string;
    validated_by: string;
  };
  /** Set when this change was preempted by a higher-priority change. */
  preempted_by?: string;
}

export interface LockInfo {
  locked: boolean;
  holder?: string;
  acquired_at?: string;
  timeout_at?: string;
}

export interface CommitResult {
  success: boolean;
  change_id: string;
  message: string;
  entry?: BlackboardEntry;
}

/**
 * Metadata about a blackboard entry — returned by {@link LockedBlackboard.readMetadata}.
 * Deliberately excludes the raw `value` so callers can inspect entry shape
 * without paying the cost of deserializing (or accidentally leaking) large values.
 */
export interface BlackboardEntryMetadata {
  /** Blackboard key. */
  key: string;
  /** JavaScript `typeof` of the stored value. */
  type: string;
  /** Approximate serialised byte size of the value. */
  sizeBytes: number;
  /** Monotonically increasing write counter for this key. */
  version: number;
  /** ISO-8601 timestamp of the last write. */
  timestamp: string;
  /** TTL in milliseconds, or `null` for no expiry. */
  ttl: number | null;
}

/** @internal Write-Ahead Log record for crash recovery. */
interface WALRecord {
  op: 'write' | 'delete' | 'checkpoint';
  opId: string;
  key?: string;
  entry?: BlackboardEntry;
  ts: string;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  lockTimeoutMs: 10000,        // 10 second lock timeout
  lockRetryBaseMs: 50,         // Initial backoff interval
  lockRetryMaxMs: 1000,        // Max backoff interval
  staleLockThresholdMs: 30000, // Consider lock stale after 30s
  maxPendingChanges: 100,      // Prevent memory bloat
};

// ============================================================================
// FILE LOCK IMPLEMENTATION
// ============================================================================

/**
 * Cross-platform file lock using lock files.
 * Works on Windows, Linux, and macOS.
 */
export class FileLock {
  private lockPath: string;
  private lockHolder: string | null = null;
  private lockFd: number | null = null;

  constructor(lockPath: string) {
    this.lockPath = lockPath;
    this.ensureDir();
  }

  private ensureDir(): void {
    const dir = dirname(this.lockPath);
    // recursive: true is idempotent — no existsSync check needed
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /**
   * Attempt to acquire the lock with timeout.
   * @param holderId Unique identifier for the lock holder
   * @param timeoutMs Maximum time to wait for lock (default: CONFIG.lockTimeoutMs)
   * @returns true if lock acquired, false if timeout
   */
  acquire(holderId: string, timeoutMs: number = CONFIG.lockTimeoutMs): boolean {
    const startTime = Date.now();
    let retryMs = CONFIG.lockRetryBaseMs;

    while (Date.now() - startTime < timeoutMs) {
      // Check for stale lock — read directly to avoid existsSync+readFileSync TOCTOU
      try {
        const lockData = JSON.parse(readFileSync(this.lockPath, 'utf-8'));
        const lockAge = Date.now() - new Date(lockData.acquired_at).getTime();
        
        // If lock is stale, force release it
        if (lockAge > CONFIG.staleLockThresholdMs) {
          log.warn('Stale lock detected, force releasing', { lockAgeMs: lockAge });
          this.forceRelease();
        } else {
          // Lock is held by someone else, wait and retry with backoff
          this.sleep(retryMs);
          retryMs = Math.min(retryMs * 2, CONFIG.lockRetryMaxMs);
          continue;
        }
      } catch (e: any) {
        if (e.code !== 'ENOENT') {
          // Corrupted lock file, remove it
          this.forceRelease();
        }
        // ENOENT: no lock file yet, fall through to create
      }

      // Try to create lock file atomically
      try {
        // Use exclusive flag to prevent race conditions
        this.lockFd = openSync(this.lockPath, 'wx', 0o600);
        
        const lockData = {
          holder: holderId,
          acquired_at: new Date().toISOString(),
          timeout_at: new Date(Date.now() + CONFIG.lockTimeoutMs).toISOString(),
          pid: process.pid
        };
        
        // Write via fd to avoid TOCTOU — no second path-based open
        writeSync(this.lockFd, JSON.stringify(lockData, null, 2));
        this.lockHolder = holderId;
        
        return true;
      } catch (error: any) {
        if (error.code === 'EEXIST') {
          // Lock file already exists, retry with backoff
          this.sleep(retryMs);
          retryMs = Math.min(retryMs * 2, CONFIG.lockRetryMaxMs);
          continue;
        }
        throw error;
      }
    }

    return false; // Timeout
  }

  /**
   * Release the lock if we hold it.
   */
  release(): boolean {
    if (!this.lockHolder) {
      return false;
    }

    try {
      if (this.lockFd !== null) {
        closeSync(this.lockFd);
        this.lockFd = null;
      }
      
      if (existsSync(this.lockPath)) {
        unlinkSync(this.lockPath);
      }
      
      this.lockHolder = null;
      return true;
    } catch (error) {
      log.error('Failed to release lock', { error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  /**
   * Force release a stale lock (use with caution).
   */
  forceRelease(): void {
    try {
      if (existsSync(this.lockPath)) {
        unlinkSync(this.lockPath);
      }
    } catch {
      // Ignore errors during force release
    }
    this.lockHolder = null;
    this.lockFd = null;
  }

  /**
   * Check current lock status.
   */
  getStatus(): LockInfo {
    if (!existsSync(this.lockPath)) {
      return { locked: false };
    }

    try {
      const lockData = JSON.parse(readFileSync(this.lockPath, 'utf-8'));
      return {
        locked: true,
        holder: lockData.holder,
        acquired_at: lockData.acquired_at,
        timeout_at: lockData.timeout_at
      };
    } catch {
      return { locked: false };
    }
  }

  /**
   * Check if we hold the lock.
   */
  isHeldByMe(): boolean {
    return this.lockHolder !== null;
  }

  private sleep(ms: number): void {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // Busy wait (Node.js doesn't have sync sleep)
    }
  }
}

// ============================================================================
// LOCKED BLACKBOARD IMPLEMENTATION
// ============================================================================

/**
 * LockedBlackboard - Thread-safe blackboard with atomic commits and audit trail.
 * 
 * Every mutating operation (write, delete, commit) records an audit entry
 * capturing the lock holder, operation duration, and change details when
 * an optional {@link SecureAuditLogger} is provided.
 * 
 * Usage:
 * ```typescript
 * const blackboard = new LockedBlackboard('./');
 * 
 * // Atomic write workflow
 * const changeId = blackboard.propose('task:123', { status: 'done' }, 'agent-1');
 * const isValid = blackboard.validate(changeId, 'orchestrator');
 * if (isValid) {
 *   blackboard.commit(changeId);
 * } else {
 *   blackboard.abort(changeId);
 * }
 * ```
 */
export class LockedBlackboard {
  private basePath: string;
  private blackboardPath: string;
  private lockPath: string;
  private pendingDir: string;
  private lock: FileLock;
  private cache: Map<string, BlackboardEntry> = new Map();
  private pendingChanges: Map<string, PendingChange> = new Map();
  private auditLogger?: SecureAuditLogger;
  private conflictResolution: ConflictResolutionStrategy;
  private paused = false;
  private throttleMs = 0;
  private lastWriteTime = 0;
  private walPath: string = '';
  private walOpCounter = 0;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private disableWal = false;

  constructor(basePath: string = '.', auditLoggerOrOptions?: SecureAuditLogger | LockedBlackboardOptions, options?: LockedBlackboardOptions) {
    // Resolve to an absolute path to prevent insecure relative/temp-dir path propagation
    const resolvedBase = resolve(basePath);
    this.basePath = resolvedBase;

    // Support both signatures:
    //   new LockedBlackboard(path, auditLogger, options)
    //   new LockedBlackboard(path, options)
    let env: string | undefined;
    if (auditLoggerOrOptions && typeof auditLoggerOrOptions === 'object' && ('conflictResolution' in auditLoggerOrOptions || 'throttleMs' in auditLoggerOrOptions || 'env' in auditLoggerOrOptions || 'disableWal' in auditLoggerOrOptions)) {
      const opts = auditLoggerOrOptions as LockedBlackboardOptions;
      this.conflictResolution = opts.conflictResolution ?? 'first-commit-wins';
      this.throttleMs = opts.throttleMs ?? 0;
      env = opts.env;
      this.disableWal = opts.disableWal ?? false;
    } else {
      this.auditLogger = auditLoggerOrOptions as SecureAuditLogger | undefined;
      this.conflictResolution = options?.conflictResolution ?? 'first-commit-wins';
      this.throttleMs = options?.throttleMs ?? 0;
      env = options?.env;
      this.disableWal = options?.disableWal ?? false;
    }

    // Respect NETWORK_AI_MINIMAL env var for CI/test fast startup
    if (process.env['NETWORK_AI_MINIMAL'] === '1') {
      this.disableWal = true;
    }

    // Fall back to NETWORK_AI_ENV environment variable when env not supplied
    const activeEnv = env ?? process.env['NETWORK_AI_ENV'] ?? '';

    // Validate env name to prevent path traversal (CWE-22)
    if (activeEnv && !/^[a-zA-Z0-9_-]+$/.test(activeEnv)) {
      throw new Error(`Invalid environment name '${activeEnv}': only alphanumeric, dash, and underscore are allowed`);
    }

    if (activeEnv) {
      // Scope all data to <basePath>/<env>/ for full environment isolation
      const envBase = join(resolvedBase, activeEnv);
      this.blackboardPath = join(envBase, 'swarm-blackboard.md');
      this.lockPath = join(envBase, '.blackboard.lock');
      this.pendingDir = join(envBase, 'pending_changes');
      this.walPath = join(envBase, '.wal.jsonl');
    } else {
      // Legacy paths — backward compatible with existing deployments
      this.blackboardPath = join(resolvedBase, 'swarm-blackboard.md');
      this.lockPath = join(resolvedBase, 'data', '.blackboard.lock');
      this.pendingDir = join(resolvedBase, 'data', 'pending_changes');
      this.walPath = join(resolvedBase, 'data', '.wal.jsonl');
    }

    this.lock = new FileLock(this.lockPath);
    this.initialize();
  }

  private initialize(): void {
    // Ensure directories exist
    if (!existsSync(dirname(this.blackboardPath))) {
      mkdirSync(dirname(this.blackboardPath), { recursive: true, mode: 0o700 });
    }
    if (!existsSync(this.pendingDir)) {
      mkdirSync(this.pendingDir, { recursive: true, mode: 0o700 });
    }

    // Initialize blackboard file if needed
    if (!existsSync(this.blackboardPath)) {
      this.writeInitialBlackboard();
    }

    // Load existing data
    this.loadFromDisk();
    if (!this.disableWal) {
      this.replayWAL();
    }
    this.loadPendingChanges();
  }

  private writeInitialBlackboard(): void {
    const content = `# Swarm Blackboard
Last Updated: ${new Date().toISOString()}
Content Hash: ${this.computeHash('')}

## Active Tasks
| TaskID | Agent | Status | Started | Description |
|--------|-------|--------|---------|-------------|

## Knowledge Cache
<!-- Cached results from agent operations -->

## Coordination Signals
<!-- Agent availability status -->

## Execution History
<!-- Chronological log of completed tasks -->
`;
    writeFileSync(this.blackboardPath, content, { encoding: 'utf-8', mode: 0o600 });
  }

  private computeHash(content: string): string {
    return createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  private loadFromDisk(): void {
    try {
      const content = readFileSync(this.blackboardPath, 'utf-8');
      const cacheSection = content.match(/## Knowledge Cache\n([\s\S]*?)(?=\n## |$)/);
      
      if (cacheSection) {
        const entries = Array.from(cacheSection[1].matchAll(/### (\S+)\n```json\n([\s\S]*?)\n```/g));
        for (const entry of entries) {
          const key = entry[1];
          try {
            const data = JSON.parse(entry[2]);
            this.cache.set(key, data);
          } catch {
            // Skip malformed entries
          }
        }
      }
    } catch (error) {
      log.error('Failed to load from disk', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private loadPendingChanges(): void {
    try {
      if (!existsSync(this.pendingDir)) return;
      
      const files = readdirSync(this.pendingDir);
      for (const file of files) {
        if (!file.endsWith('.json') || file.includes('.committed') || file.includes('.aborted')) {
          continue;
        }
        
        try {
          const content = readFileSync(join(this.pendingDir, file), 'utf-8');
          const change: PendingChange = JSON.parse(content);
          if (change.status === 'pending' || change.status === 'validated') {
            this.pendingChanges.set(change.change_id, change);
          }
        } catch {
          // Skip corrupted files
        }
      }

      // Enforce max pending changes limit
      if (this.pendingChanges.size > CONFIG.maxPendingChanges) {
        log.warn('Too many pending changes, cleaning up old ones', { count: this.pendingChanges.size });
        this.cleanupOldPendingChanges();
      }
    } catch (error) {
      log.error('Failed to load pending changes', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private cleanupOldPendingChanges(): void {
    const sorted = Array.from(this.pendingChanges.entries())
      .sort((a, b) => new Date(a[1].proposed_at).getTime() - new Date(b[1].proposed_at).getTime());
    
    // Keep only the newest half
    const toRemove = sorted.slice(0, Math.floor(sorted.length / 2));
    for (const [changeId] of toRemove) {
      this.abort(changeId);
    }
  }

  private persistToDisk(): void {
    const holderId = `writer-${randomUUID().substring(0, 8)}`;
    
    if (!this.lock.acquire(holderId)) {
      throw new LockAcquisitionError('writing to blackboard');
    }

    try {
      const cacheContent = Array.from(this.cache.entries())
        .filter(([, entry]) => !this.isExpired(entry))
        .map(([key, entry]) => `### ${key}\n\`\`\`json\n${JSON.stringify(entry, null, 2)}\n\`\`\``)
        .join('\n\n');

      const content = `# Swarm Blackboard
Last Updated: ${new Date().toISOString()}
Content Hash: ${this.computeHash(cacheContent)}

## Active Tasks
| TaskID | Agent | Status | Started | Description |
|--------|-------|--------|---------|-------------|

## Knowledge Cache
${cacheContent}

## Coordination Signals
<!-- Agent availability status -->

## Execution History
<!-- Chronological log of completed tasks -->
`;
      writeFileSync(this.blackboardPath, content, { encoding: 'utf-8', mode: 0o600 });
    } finally {
      this.lock.release();
    }
  }

  private isExpired(entry: BlackboardEntry): boolean {
    if (!entry.ttl) return false;
    const expiresAt = new Date(entry.timestamp).getTime() + entry.ttl * 1000;
    return Date.now() > expiresAt;
  }

  private savePendingChange(change: PendingChange): void {
    const filePath = join(this.pendingDir, `${change.change_id}.json`);
    writeFileSync(filePath, JSON.stringify(change, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  private archivePendingChange(change: PendingChange): void {
    const archiveDir = join(this.pendingDir, 'archive');
    if (!existsSync(archiveDir)) {
      mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    }

    const sourcePath = join(this.pendingDir, `${change.change_id}.json`);
    const archivePath = join(archiveDir, `${change.change_id}.${change.status}.json`);

    try {
      if (existsSync(sourcePath)) {
        writeFileSync(archivePath, JSON.stringify(change, null, 2), { encoding: 'utf-8', mode: 0o600 });
        unlinkSync(sourcePath);
      }
    } catch (error) {
      log.error('Failed to archive change', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  // ==========================================================================
  // FLOW CONTROL: PAUSE / RESUME / THROTTLE
  // ==========================================================================

  /**
   * Pause all write and commit operations.
   * Read operations continue to work while paused.
   */
  pause(): void {
    this.paused = true;
  }

  /**
   * Resume write and commit operations after a pause.
   */
  resume(): void {
    this.paused = false;
  }

  /**
   * Check if the blackboard is currently paused.
   */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Set the minimum interval between write/commit operations.
   * @param ms Milliseconds between writes (0 to disable throttling)
   */
  setThrottle(ms: number): void {
    this.throttleMs = Math.max(0, Math.floor(ms));
  }

  /**
   * Get the current throttle interval.
   */
  getThrottle(): number {
    return this.throttleMs;
  }

  /**
   * Guard called before any mutating operation.
   * Throws if paused; enforces throttle delay.
   */
  private enforceFlowControl(): void {
    if (this.paused) {
      throw new LockAcquisitionError('blackboard is paused');
    }
    if (this.throttleMs > 0) {
      const elapsed = Date.now() - this.lastWriteTime;
      if (elapsed < this.throttleMs) {
        throw new LockAcquisitionError(`throttled — retry after ${this.throttleMs - elapsed}ms`);
      }
    }
  }

  /**
   * Record the timestamp of a successful mutating operation.
   */
  private recordWrite(): void {
    this.lastWriteTime = Date.now();
  }

  // ==========================================================================
  // PUBLIC API: ATOMIC COMMIT WORKFLOW
  // ==========================================================================

  /**
   * STEP 1: Propose a change (does NOT modify blackboard yet).
   * @param key Blackboard key to write
   * @param value Value to store
   * @param sourceAgent Agent proposing the change
   * @param ttl Optional time-to-live in seconds
   * @param priority Agent priority (0=low, 1=normal, 2=high, 3=critical). Defaults to 0.
   * @returns change_id for use in validate/commit/abort
   */
  propose(key: string, value: unknown, sourceAgent: string, ttl?: number, priority?: AgentPriority): string {
    const changeId = `chg_${randomUUID().substring(0, 8)}`;

    // Validate priority
    const resolvedPriority = this.validatePriority(priority);
    
    // Get current hash for conflict detection
    const currentEntry = this.cache.get(key);
    const previousHash = currentEntry 
      ? this.computeHash(JSON.stringify(currentEntry))
      : null;

    const change: PendingChange = {
      change_id: changeId,
      key,
      value,
      source_agent: sourceAgent,
      proposed_at: new Date().toISOString(),
      ttl: ttl ?? null,
      status: 'pending',
      previous_hash: previousHash,
      priority: resolvedPriority
    };

    this.pendingChanges.set(changeId, change);
    this.savePendingChange(change);

    return changeId;
  }

  /**
   * Validate and clamp priority to the AgentPriority range.
   */
  private validatePriority(priority?: number): AgentPriority {
    if (priority === undefined || priority === null) return 0;
    if (typeof priority !== 'number' || !Number.isInteger(priority)) return 0;
    return Math.max(0, Math.min(3, priority)) as AgentPriority;
  }

  /**
   * STEP 2: Validate a proposed change (check for conflicts).
   * 
   * In `'first-commit-wins'` mode (default): fails if the key was modified since proposal.
   * In `'priority-wins'` mode: allows higher-priority changes to preempt lower-priority
   * pending/validated changes on the same key.
   * 
   * @returns true if change can be safely committed
   */
  validate(changeId: string, validatorAgent: string): boolean {
    const change = this.pendingChanges.get(changeId);
    
    if (!change) {
      log.error('Change not found', { changeId });
      return false;
    }

    if (change.status !== 'pending') {
      log.error('Change cannot be validated', { changeId, status: change.status });
      return false;
    }

    // Check for conflicts (has the key been modified since proposal?)
    const currentEntry = this.cache.get(change.key);
    const currentHash = currentEntry 
      ? this.computeHash(JSON.stringify(currentEntry))
      : null;

    if (change.previous_hash !== currentHash) {
      // Conflict detected — check if priority-wins can resolve it
      if (this.conflictResolution === 'priority-wins') {
        const conflicting = this.findConflictingPendingChanges(change.key, changeId);
        
        // Preempt any lower-priority pending changes
        const lowerPriorityPending = conflicting.filter(c => c.priority < change.priority);
        for (const victim of lowerPriorityPending) {
          this.preempt(victim.change_id, changeId, change.priority, victim.priority);
        }

        // Check if any equal-or-higher-priority pending changes remain
        const blockers = conflicting.filter(c => c.priority >= change.priority);

        if (blockers.length > 0) {
          // Blocked by equal/higher priority pending changes
          log.warn('CONFLICT DETECTED (blocked by equal/higher priority pending)', {
            key: change.key, priority: change.priority,
            blockerPriorities: blockers.map(b => b.priority),
          });
          return false;
        }

        // No pending blockers — check against last committed priority
        const lastCommittedPriority = this.getLastCommittedPriority(change.key);
        if (change.priority > lastCommittedPriority) {
          // Higher priority wins over committed value
          change.previous_hash = currentHash;
          log.info('Priority preemption during validate', {
            changeId, key: change.key, priority: change.priority,
            preemptedPending: lowerPriorityPending.length,
            lastCommittedPriority,
          });
        } else {
          // Same or lower priority cannot overwrite committed value
          log.warn('CONFLICT DETECTED (priority insufficient vs committed)', {
            key: change.key, incomingPriority: change.priority,
            committedPriority: lastCommittedPriority,
          });
          return false;
        }
      } else {
        log.warn('CONFLICT DETECTED', { key: change.key, expectedHash: change.previous_hash, actualHash: currentHash });
        return false;
      }
    }

    // Mark as validated
    change.status = 'validated';
    change.validation = {
      validated_at: new Date().toISOString(),
      validated_by: validatorAgent
    };

    this.savePendingChange(change);
    return true;
  }

  /**
   * STEP 3a: Commit a validated change (applies to blackboard).
   * @returns CommitResult with success status
   */
  commit(changeId: string): CommitResult {
    this.enforceFlowControl();
    const change = this.pendingChanges.get(changeId);
    const lockStart = Date.now();

    if (!change) {
      return {
        success: false,
        change_id: changeId,
        message: `Change ${changeId} not found`
      };
    }

    if (change.status !== 'validated') {
      return {
        success: false,
        change_id: changeId,
        message: `Change ${changeId} is ${change.status}, must be validated first`
      };
    }

    // Acquire lock and apply change atomically
    const holderId = `commit-${changeId}`;
    
    if (!this.lock.acquire(holderId)) {
      this.audit('BLACKBOARD_COMMIT', change.source_agent, 'commit', 'failure', {
        changeId, key: change.key, reason: 'lock_timeout', lockHolder: holderId,
      });
      return {
        success: false,
        change_id: changeId,
        message: 'Failed to acquire lock for commit'
      };
    }

    try {
      // Double-check for conflicts under lock
      const currentEntry = this.cache.get(change.key);
      const currentHash = currentEntry 
        ? this.computeHash(JSON.stringify(currentEntry))
        : null;

      if (change.previous_hash !== currentHash) {
        // Conflict under lock — check priority-wins
        if (this.conflictResolution === 'priority-wins') {
          // Check if the current entry was written by a lower-priority agent
          const currentPriority = this.getLastCommittedPriority(change.key);
          if (change.priority > currentPriority) {
            // Higher priority wins — update hash and proceed
            log.info('Priority preemption during commit (under lock)', {
              changeId, key: change.key,
              incomingPriority: change.priority,
              existingPriority: currentPriority
            });
            this.audit('BLACKBOARD_PREEMPT', change.source_agent, 'preempt_commit', 'success', {
              changeId, key: change.key,
              winnerPriority: change.priority,
              loserPriority: currentPriority,
              lockHolder: holderId, lockDurationMs: Date.now() - lockStart,
            });
          } else {
            // Same or lower priority — abort
            change.status = 'aborted';
            this.savePendingChange(change);
            this.archivePendingChange(change);
            this.pendingChanges.delete(changeId);

            this.audit('BLACKBOARD_COMMIT', change.source_agent, 'commit', 'failure', {
              changeId, key: change.key, reason: 'conflict_priority_insufficient',
              incomingPriority: change.priority, existingPriority: currentPriority,
              lockHolder: holderId, lockDurationMs: Date.now() - lockStart,
            });

            return {
              success: false,
              change_id: changeId,
              message: `CONFLICT: Key ${change.key} was modified by equal/higher priority agent`
            };
          }
        } else {
          change.status = 'aborted';
          this.savePendingChange(change);
          this.archivePendingChange(change);
          this.pendingChanges.delete(changeId);

          this.audit('BLACKBOARD_COMMIT', change.source_agent, 'commit', 'failure', {
            changeId, key: change.key, reason: 'conflict',
            lockHolder: holderId, lockDurationMs: Date.now() - lockStart,
          });
          
          return {
            success: false,
            change_id: changeId,
            message: `CONFLICT: Key ${change.key} was modified since validation`
          };
        }
      }

      // Apply the change
      const newVersion = (currentEntry?.version ?? 0) + 1;
      const entry: BlackboardEntry = {
        key: change.key,
        value: change.value,
        source_agent: change.source_agent,
        timestamp: new Date().toISOString(),
        ttl: change.ttl,
        version: newVersion
      };

      this.cache.set(change.key, entry);
      change.status = 'committed';

      // WAL: record before disk write for crash recovery
      const walOpId = `wal_${++this.walOpCounter}`;
      this.appendToWAL({ op: 'write', opId: walOpId, key: change.key, entry });
      
      // Persist to disk (still under lock)
      this.persistToDiskInternal();
      // WAL: checkpoint after successful disk write
      this.checkpointWAL(walOpId);
      this.recordWrite();
      
      // Archive the change
      this.archivePendingChange(change);
      this.pendingChanges.delete(changeId);

      this.audit('BLACKBOARD_COMMIT', change.source_agent, 'commit', 'success', {
        changeId, key: change.key, version: newVersion,
        lockHolder: holderId, lockDurationMs: Date.now() - lockStart,
        validatedBy: change.validation?.validated_by,
      });

      return {
        success: true,
        change_id: changeId,
        message: `Successfully committed ${change.key} (v${newVersion})`,
        entry
      };
    } finally {
      this.lock.release();
    }
  }

  /**
   * STEP 3b: Abort a proposed/validated change.
   */
  abort(changeId: string): boolean {
    const change = this.pendingChanges.get(changeId);
    
    if (!change) {
      return false;
    }

    change.status = 'aborted';
    this.archivePendingChange(change);
    this.pendingChanges.delete(changeId);

    return true;
  }

  // ==========================================================================
  // PRIORITY & PREEMPTION HELPERS
  // ==========================================================================

  /**
   * Find all pending/validated changes targeting the same key, excluding the given changeId.
   */
  findConflictingPendingChanges(key: string, excludeChangeId: string): PendingChange[] {
    return Array.from(this.pendingChanges.values()).filter(
      c => c.key === key && c.change_id !== excludeChangeId && (c.status === 'pending' || c.status === 'validated')
    );
  }

  /**
   * Preempt a lower-priority change: abort it and emit an audit event.
   */
  private preempt(victimChangeId: string, winnerChangeId: string, winnerPriority: AgentPriority, victimPriority: AgentPriority): void {
    const victim = this.pendingChanges.get(victimChangeId);
    if (!victim) return;

    victim.status = 'aborted';
    victim.preempted_by = winnerChangeId;
    this.savePendingChange(victim);
    this.archivePendingChange(victim);
    this.pendingChanges.delete(victimChangeId);

    log.info('Change preempted', {
      victimChangeId, winnerChangeId, key: victim.key,
      victimPriority, winnerPriority
    });

    this.audit('BLACKBOARD_PREEMPT', victim.source_agent, 'preempted', 'failure', {
      victimChangeId, winnerChangeId, key: victim.key,
      victimPriority, winnerPriority,
      victimAgent: victim.source_agent,
    });
  }

  /**
   * Get the priority of the last committed change to a key.
   * Falls back to 0 if unknown (legacy data without priority).
   */
  private getLastCommittedPriority(key: string): AgentPriority {
    // Check archived committed changes for this key (most recent first)
    try {
      const archiveDir = join(this.pendingDir, 'archive');
      if (!existsSync(archiveDir)) return 0;

      const files = readdirSync(archiveDir)
        .filter(f => f.endsWith('.committed.json'))
        .sort()
        .reverse();

      for (const file of files) {
        try {
          const content = readFileSync(join(archiveDir, file), 'utf-8');
          const archived: PendingChange = JSON.parse(content);
          if (archived.key === key) {
            return this.validatePriority(archived.priority);
          }
        } catch {
          // Skip corrupted archive files
        }
      }
    } catch {
      // Archive dir doesn't exist or read error
    }
    return 0;
  }

  /**
   * Get the current conflict resolution strategy.
   */
  getConflictResolution(): ConflictResolutionStrategy {
    return this.conflictResolution;
  }

  // Internal persist without acquiring lock (called when already holding lock)
  private persistToDiskInternal(): void {
    const cacheContent = Array.from(this.cache.entries())
      .filter(([, entry]) => !this.isExpired(entry))
      .map(([key, entry]) => `### ${key}\n\`\`\`json\n${JSON.stringify(entry, null, 2)}\n\`\`\``)
      .join('\n\n');

    const content = `# Swarm Blackboard
Last Updated: ${new Date().toISOString()}
Content Hash: ${this.computeHash(cacheContent)}

## Active Tasks
| TaskID | Agent | Status | Started | Description |
|--------|-------|--------|---------|-------------|

## Knowledge Cache
${cacheContent}

## Coordination Signals
<!-- Agent availability status -->

## Execution History
<!-- Chronological log of completed tasks -->
`;
    writeFileSync(this.blackboardPath, content, { encoding: 'utf-8', mode: 0o600 });
  }

  // ==========================================================================
  // PUBLIC API: SIMPLE READ/WRITE (with automatic locking)
  // ==========================================================================

  /**
   * Read a value from the blackboard.
   */
  read(key: string): BlackboardEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (this.isExpired(entry)) {
      this.cache.delete(key);
      this.persistToDisk();
      return null;
    }

    return entry;
  }

  /**
   * Direct write with automatic locking (use propose/validate/commit for multi-agent safety).
   */
  write(key: string, value: unknown, sourceAgent: string, ttl?: number): BlackboardEntry {
    this.enforceFlowControl();
    const holderId = `write-${randomUUID().substring(0, 8)}`;
    const lockStart = Date.now();
    
    if (!this.lock.acquire(holderId)) {
      this.audit('BLACKBOARD_WRITE', sourceAgent, 'write', 'failure', {
        key, reason: 'lock_timeout', lockHolder: holderId,
      });
      throw new LockAcquisitionError('write');
    }

    try {
      const currentEntry = this.cache.get(key);
      const newVersion = (currentEntry?.version ?? 0) + 1;

      const entry: BlackboardEntry = {
        key,
        value,
        source_agent: sourceAgent,
        timestamp: new Date().toISOString(),
        ttl: ttl ?? null,
        version: newVersion
      };

      this.cache.set(key, entry);
      const walWriteId = `wal_${++this.walOpCounter}`;
      this.appendToWAL({ op: 'write', opId: walWriteId, key, entry });
      this.persistToDiskInternal();
      this.checkpointWAL(walWriteId);
      this.recordWrite();

      this.audit('BLACKBOARD_WRITE', sourceAgent, 'write', 'success', {
        key, version: newVersion, lockHolder: holderId,
        lockDurationMs: Date.now() - lockStart,
        hadPreviousValue: !!currentEntry,
      });
      
      return entry;
    } finally {
      this.lock.release();
    }
  }

  /**
   * Delete a key from the blackboard.
   */
  delete(key: string): boolean {
    this.enforceFlowControl();
    const holderId = `delete-${randomUUID().substring(0, 8)}`;
    const lockStart = Date.now();
    
    if (!this.lock.acquire(holderId)) {
      this.audit('BLACKBOARD_DELETE', 'system', 'delete', 'failure', {
        key, reason: 'lock_timeout', lockHolder: holderId,
      });
      throw new LockAcquisitionError('delete');
    }

    try {
      if (this.cache.has(key)) {
        this.cache.delete(key);
        const walDelId = `wal_${++this.walOpCounter}`;
        this.appendToWAL({ op: 'delete', opId: walDelId, key });
        this.persistToDiskInternal();
        this.checkpointWAL(walDelId);
        this.audit('BLACKBOARD_DELETE', 'system', 'delete', 'success', {
          key, lockHolder: holderId,
          lockDurationMs: Date.now() - lockStart,
        });
        return true;
      }
      return false;
    } finally {
      this.lock.release();
    }
  }

  /**
   * List all valid keys.
   */
  listKeys(): string[] {
    return Array.from(this.cache.keys()).filter(key => {
      const entry = this.cache.get(key);
      return entry && !this.isExpired(entry);
    });
  }

  /**
   * Return metadata for a single blackboard entry without exposing its value.
   *
   * Useful for orchestrators that need to inspect entry shape, age, or size
   * before deciding whether to read the full value.
   *
   * @param key - Blackboard key to query.
   * @returns   Metadata object, or `null` if the key does not exist / has expired.
   */
  readMetadata(key: string): BlackboardEntryMetadata | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.cache.delete(key);
      this.persistToDisk();
      return null;
    }
    return this._entryToMetadata(entry);
  }

  /**
   * Return metadata for all live (non-expired) blackboard entries.
   *
   * @returns Array of metadata objects — one per live key, in insertion order.
   */
  listMetadata(): BlackboardEntryMetadata[] {
    const out: BlackboardEntryMetadata[] = [];
    for (const [, entry] of Array.from(this.cache.entries())) {
      if (!this.isExpired(entry)) {
        out.push(this._entryToMetadata(entry));
      }
    }
    return out;
  }

  /** @internal */
  private _entryToMetadata(entry: BlackboardEntry): BlackboardEntryMetadata {
    let sizeBytes = 0;
    try {
      sizeBytes = Buffer.byteLength(JSON.stringify(entry.value), 'utf8');
    } catch {
      sizeBytes = 0;
    }
    return {
      key: entry.key,
      type: Array.isArray(entry.value) ? 'array' : typeof entry.value,
      sizeBytes,
      version: entry.version,
      timestamp: entry.timestamp,
      ttl: entry.ttl,
    };
  }

  /**
   * Get full snapshot of blackboard state.
   */
  getSnapshot(): Record<string, BlackboardEntry> {
    const snapshot: Record<string, BlackboardEntry> = {};
    for (const [key, entry] of Array.from(this.cache.entries())) {
      if (!this.isExpired(entry)) {
        snapshot[key] = entry;
      }
    }
    return snapshot;
  }

  /**
   * List all pending changes.
   */
  listPendingChanges(): PendingChange[] {
    return Array.from(this.pendingChanges.values());
  }

  /**
   * Get lock status.
   */
  getLockStatus(): LockInfo {
    return this.lock.getStatus();
  }

  /**
   * Attach an audit logger at runtime (useful when the logger is created
   * after the blackboard, e.g., in the orchestrator constructor).
   */
  setAuditLogger(logger: SecureAuditLogger): void {
    this.auditLogger = logger;
  }

  // ---------- Internal audit helper ----------

  /**
   * Log an audit entry if an audit logger is attached.
   * Non-fatal: failures are swallowed so auditing never blocks operations.
   */
  private audit(
    eventType: string,
    agentId: string,
    action: string,
    outcome: 'success' | 'failure' | 'denied',
    details: Record<string, unknown>,
  ): void {
    if (!this.auditLogger) return;
    try {
      this.auditLogger.log(eventType, agentId, action, outcome, details);
    } catch {
      // Audit logging must never block blackboard operations
    }
  }

  // ==========================================================================
  // TTL SWEEP
  // ==========================================================================

  /**
   * Evict all expired entries from the in-memory cache and persist to disk.
   * Called automatically by `startSweep()` at the configured interval.
   *
   * @returns Number of entries evicted.
   */
  purgeExpired(): number {
    let evicted = 0;
    for (const [key, entry] of Array.from(this.cache.entries())) {
      if (this.isExpired(entry)) {
        this.cache.delete(key);
        evicted++;
      }
    }
    if (evicted > 0) {
      this.persistToDisk();
    }
    return evicted;
  }

  /**
   * Start a background sweep timer that calls `purgeExpired()` periodically.
   * Safe to call multiple times — stops any existing timer first.
   *
   * The timer is unref'd so it does not prevent process exit.
   *
   * @param intervalMs Sweep interval in milliseconds (default 60 000 = 1 min).
   */
  startSweep(intervalMs = 60_000): void {
    this.stopSweep();
    this.sweepTimer = setInterval(() => { this.purgeExpired(); }, Math.max(1, intervalMs));
    // Don't prevent process exit
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
  }

  /**
   * Stop the background sweep timer started by `startSweep()`.
   * Safe to call even if no sweep is running.
   */
  stopSweep(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  // ==========================================================================
  // WRITE-AHEAD LOG (WAL)
  // ==========================================================================

  /**
   * Append a WAL record for crash recovery.
   * Failures are logged but never propagate — WAL writes must not block ops.
   * @internal
   */
  private appendToWAL(record: Omit<WALRecord, 'ts'>): void {
    try {
      const line = JSON.stringify({ ...record, ts: new Date().toISOString() } as WALRecord) + '\n';
      appendFileSync(this.walPath, line, { encoding: 'utf-8', mode: 0o600 });
    } catch (err) {
      log.warn('WAL append failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Append a checkpoint record — signals that the matching op reached disk.
   * @internal
   */
  private checkpointWAL(opId: string): void {
    try {
      const line = JSON.stringify({ op: 'checkpoint', opId, ts: new Date().toISOString() } as WALRecord) + '\n';
      appendFileSync(this.walPath, line, { encoding: 'utf-8', mode: 0o600 });
    } catch (err) {
      log.warn('WAL checkpoint failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Replay uncommitted WAL entries after a crash.
   *
   * Called automatically during construction (after `loadFromDisk()`).
   * Any WAL record without a matching `checkpoint` is replayed into the cache,
   * then the full state is persisted and the WAL is compacted.
   *
   * Malformed tail lines are silently skipped — partial writes at crash time
   * leave incomplete JSON that we must tolerate.
   */
  replayWAL(): void {
    if (!existsSync(this.walPath)) return;

    try {
      const raw = readFileSync(this.walPath, 'utf-8');
      const lines = raw.split('\n').filter(l => l.trim().length > 0);

      const checkpointed = new Set<string>();
      const pending = new Map<string, WALRecord>();

      for (const line of lines) {
        try {
          const record: WALRecord = JSON.parse(line);
          if (record.op === 'checkpoint') {
            if (record.opId) checkpointed.add(record.opId);
          } else if (record.op === 'write' || record.op === 'delete') {
            pending.set(record.opId, record);
          }
        } catch {
          // Skip malformed / truncated tail lines — expected on crash
        }
      }

      let replayed = 0;
      for (const [opId, record] of pending.entries()) {
        if (checkpointed.has(opId)) continue;
        if (record.op === 'write' && record.entry && record.key) {
          this.cache.set(record.key, record.entry);
          replayed++;
        } else if (record.op === 'delete' && record.key) {
          this.cache.delete(record.key);
          replayed++;
        }
      }

      if (replayed > 0) {
        log.warn(`WAL replay: recovered ${replayed} uncommitted operation(s) after crash`, { replayed });
        this.persistToDiskInternal();
        this.compactWAL();
      }
    } catch (err) {
      log.error('WAL replay failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Truncate the WAL file.
   *
   * Call after a full-state snapshot has been flushed to disk to prevent
   * unbounded WAL growth during long-running processes.
   */
  compactWAL(): void {
    try {
      // Use a file descriptor to avoid TOCTOU (js/file-system-race).
      // openSync 'w' = O_WRONLY | O_CREAT | O_TRUNC — atomically truncates or creates.
      const fd = openSync(this.walPath, 'w', 0o600);
      closeSync(fd);
    } catch (err) {
      log.warn('WAL compact failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export default LockedBlackboard;
