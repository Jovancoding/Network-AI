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
  existsSync,
  mkdirSync,
  unlinkSync,
  openSync,
  closeSync,
  statSync,
  readdirSync
} from 'fs';
import { join, dirname } from 'path';
import { randomUUID, createHash } from 'crypto';
import { Logger } from './logger';
import { LockAcquisitionError } from './errors';
import type { SecureAuditLogger } from '../security';

const log = Logger.create('LockedBlackboard');

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

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
  validation?: {
    validated_at: string;
    validated_by: string;
  };
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

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  lockTimeoutMs: 10000,        // 10 second lock timeout
  lockRetryIntervalMs: 100,    // Retry every 100ms
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
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Attempt to acquire the lock with timeout.
   * @param holderId Unique identifier for the lock holder
   * @param timeoutMs Maximum time to wait for lock (default: CONFIG.lockTimeoutMs)
   * @returns true if lock acquired, false if timeout
   */
  acquire(holderId: string, timeoutMs: number = CONFIG.lockTimeoutMs): boolean {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      // Check for stale lock
      if (existsSync(this.lockPath)) {
        try {
          const lockData = JSON.parse(readFileSync(this.lockPath, 'utf-8'));
          const lockAge = Date.now() - new Date(lockData.acquired_at).getTime();
          
          // If lock is stale, force release it
          if (lockAge > CONFIG.staleLockThresholdMs) {
            log.warn('Stale lock detected, force releasing', { lockAgeMs: lockAge });
            this.forceRelease();
          } else {
            // Lock is held by someone else, wait and retry
            this.sleep(CONFIG.lockRetryIntervalMs);
            continue;
          }
        } catch {
          // Corrupted lock file, remove it
          this.forceRelease();
        }
      }

      // Try to create lock file atomically
      try {
        // Use exclusive flag to prevent race conditions
        this.lockFd = openSync(this.lockPath, 'wx');
        
        const lockData = {
          holder: holderId,
          acquired_at: new Date().toISOString(),
          timeout_at: new Date(Date.now() + CONFIG.lockTimeoutMs).toISOString(),
          pid: process.pid
        };
        
        writeFileSync(this.lockPath, JSON.stringify(lockData, null, 2));
        this.lockHolder = holderId;
        
        return true;
      } catch (error: any) {
        if (error.code === 'EEXIST') {
          // Lock file already exists, retry
          this.sleep(CONFIG.lockRetryIntervalMs);
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

  constructor(basePath: string = '.', auditLogger?: SecureAuditLogger) {
    this.basePath = basePath;
    this.blackboardPath = join(basePath, 'swarm-blackboard.md');
    this.lockPath = join(basePath, 'data', '.blackboard.lock');
    this.pendingDir = join(basePath, 'data', 'pending_changes');
    this.lock = new FileLock(this.lockPath);
    this.auditLogger = auditLogger;
    
    this.initialize();
  }

  private initialize(): void {
    // Ensure directories exist
    if (!existsSync(dirname(this.blackboardPath))) {
      mkdirSync(dirname(this.blackboardPath), { recursive: true });
    }
    if (!existsSync(this.pendingDir)) {
      mkdirSync(this.pendingDir, { recursive: true });
    }

    // Initialize blackboard file if needed
    if (!existsSync(this.blackboardPath)) {
      this.writeInitialBlackboard();
    }

    // Load existing data
    this.loadFromDisk();
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
    writeFileSync(this.blackboardPath, content, 'utf-8');
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
      writeFileSync(this.blackboardPath, content, 'utf-8');
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
    writeFileSync(filePath, JSON.stringify(change, null, 2));
  }

  private archivePendingChange(change: PendingChange): void {
    const archiveDir = join(this.pendingDir, 'archive');
    if (!existsSync(archiveDir)) {
      mkdirSync(archiveDir, { recursive: true });
    }

    const sourcePath = join(this.pendingDir, `${change.change_id}.json`);
    const archivePath = join(archiveDir, `${change.change_id}.${change.status}.json`);

    try {
      if (existsSync(sourcePath)) {
        writeFileSync(archivePath, JSON.stringify(change, null, 2));
        unlinkSync(sourcePath);
      }
    } catch (error) {
      log.error('Failed to archive change', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  // ==========================================================================
  // PUBLIC API: ATOMIC COMMIT WORKFLOW
  // ==========================================================================

  /**
   * STEP 1: Propose a change (does NOT modify blackboard yet).
   * @returns change_id for use in validate/commit/abort
   */
  propose(key: string, value: unknown, sourceAgent: string, ttl?: number): string {
    const changeId = `chg_${randomUUID().substring(0, 8)}`;
    
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
      previous_hash: previousHash
    };

    this.pendingChanges.set(changeId, change);
    this.savePendingChange(change);

    return changeId;
  }

  /**
   * STEP 2: Validate a proposed change (check for conflicts).
   * Typically called by the orchestrator before committing.
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
      log.warn('CONFLICT DETECTED', { key: change.key, expectedHash: change.previous_hash, actualHash: currentHash });
      return false;
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
      
      // Persist to disk (still under lock)
      this.persistToDiskInternal();
      
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
    writeFileSync(this.blackboardPath, content, 'utf-8');
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
      this.persistToDiskInternal();

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
        this.persistToDiskInternal();
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
}

// ============================================================================
// EXPORTS
// ============================================================================

export default LockedBlackboard;
