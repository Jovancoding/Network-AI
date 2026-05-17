/**
 * TransportAgent — SAP Basis-inspired configuration transport layer
 *
 * Manages the safe promotion of configuration artefacts between deployment
 * environments. Enforces the AuthGuardian permission wall, drains in-flight
 * agent pools before promoting, runs an optional canary window, and rolls
 * back on a violation spike.
 *
 * State machine:
 *   pending → draining → promoting → canary → complete
 *                                           ↘ rolled_back
 *                       ↘ failed (auth denied / prerequisite missing / lock conflict)
 *
 * Blackboard keys (written by TransportAgent only):
 *   transport:request:<trId>  — original request (written once by submitRequest)
 *   transport:status:<trId>   — mutable status record (updated each state change)
 *   transport:lock:<toEnv>    — advisory lock preventing concurrent promotions
 *
 * @module TransportAgent
 * @version 1.0.0
 */

import { appendFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

import type { LockedBlackboard } from './locked-blackboard';
import type { EnvironmentManager, EnvName, PromotionResult } from './env-manager';
import type { ComplianceMonitor } from './compliance-monitor';
import type { AuthGuardian } from './auth-guardian';
import type { AgentPool } from './strategy-agent';

// ============================================================================
// TYPES
// ============================================================================

/** Lifecycle states of a transport request. */
export type TransportStatus =
  | 'pending'
  | 'draining'
  | 'promoting'
  | 'canary'
  | 'complete'
  | 'rolled_back'
  | 'failed';

/**
 * A request to promote configuration artefacts from one environment to another.
 * Submit via {@link TransportAgent.submitRequest}.
 */
export interface TransportRequest {
  /** Source environment name. */
  fromEnv: EnvName;
  /** Destination environment name. */
  toEnv: EnvName;
  /** Human-readable reason for this promotion (logged to audit trail). */
  reason: string;
  /** Operator identity used for confirm/approval gates (e.g. 'ops-lead'). */
  operator?: string;
  /** TR IDs that must be in 'complete' state before this TR can start. */
  prerequisites?: string[];
  /** Canary window in milliseconds. 0 = skip canary phase. Default: 30 000. */
  canaryWindowMs?: number;
  /** Maximum new compliance violations tolerated during canary. Default: 0. */
  canaryMaxViolations?: number;
  /** Percentage of pool slots to re-open during canary (1–100). Default: 20. */
  canaryPercent?: number;
}

/** Live snapshot of a transport request written to the blackboard. */
export interface TransportStatusRecord {
  trId: string;
  status: TransportStatus;
  fromEnv: EnvName;
  toEnv: EnvName;
  reason: string;
  operator?: string;
  submittedAt: string;
  startedAt?: string;
  completedAt?: string;
  /** Backup ID captured before promotion — used for rollback. */
  backupId?: string;
  promotionResult?: PromotionResult;
  /** Number of new compliance violations detected during the canary window. */
  violationsDetected?: number;
  error?: string;
}

/** Options for constructing a {@link TransportAgent}. */
export interface TransportAgentOptions {
  /** Blackboard used as the coordination medium. */
  blackboard: LockedBlackboard;
  /** Environment manager for promote/backup/restore operations. */
  envManager: EnvironmentManager;
  /** AuthGuardian that gates every ENVIRONMENT_PROMOTE request. */
  authGuardian: AuthGuardian;
  /** Agent pools to drain before each promotion. Optional — pass all active pools. */
  pools?: AgentPool[];
  /** ComplianceMonitor for canary violation detection. Optional. */
  complianceMonitor?: ComplianceMonitor;
  /** Agent ID used for blackboard writes. Default: `'basis:transport'`. */
  agentId?: string;
  /** Poll interval in ms for new pending TRs. Default: 5 000. */
  pollIntervalMs?: number;
  /** Maximum ms to wait for in-flight pool agents to finish draining. Default: 60 000. */
  drainTimeoutMs?: number;
  /** Path to append JSON-L audit entries. Default: `data/audit_log.jsonl`. */
  auditLogPath?: string;
}

// ============================================================================
// HELPERS
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// TRANSPORT AGENT
// ============================================================================

/**
 * SAP Basis-inspired transport agent for environment promotion.
 *
 * @example
 * ```typescript
 * const agent = new TransportAgent({ blackboard, envManager, authGuardian, pools });
 * agent.start();
 *
 * // From any agent — submit a transport request:
 * const trId = TransportAgent.submitRequest(blackboard, {
 *   fromEnv: 'dev', toEnv: 'st', reason: 'Sprint 42 config', operator: 'dev-lead',
 * });
 * ```
 */
export class TransportAgent {
  private readonly _blackboard: LockedBlackboard;
  private readonly _envManager: EnvironmentManager;
  private readonly _authGuardian: AuthGuardian;
  private readonly _pools: AgentPool[];
  private readonly _complianceMonitor: ComplianceMonitor | undefined;
  private readonly _agentId: string;
  private readonly _pollIntervalMs: number;
  private readonly _drainTimeoutMs: number;
  private readonly _auditLogPath: string;
  private _pollHandle: NodeJS.Timeout | null = null;
  private _running = false;
  private _processing = false;

  constructor(options: TransportAgentOptions) {
    this._blackboard = options.blackboard;
    this._envManager = options.envManager;
    this._authGuardian = options.authGuardian;
    this._pools = options.pools ?? [];
    this._complianceMonitor = options.complianceMonitor;
    this._agentId = options.agentId ?? 'basis:transport';
    this._pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this._drainTimeoutMs = options.drainTimeoutMs ?? 60_000;
    this._auditLogPath = options.auditLogPath ?? join(process.cwd(), 'data', 'audit_log.jsonl');
  }

  // --------------------------------------------------------------------------
  // Public lifecycle
  // --------------------------------------------------------------------------

  /**
   * Start the transport agent's poll loop.
   * Processes pending transport requests at `pollIntervalMs` intervals.
   */
  start(): void {
    if (this._running) return;
    this._running = true;
    this._pollHandle = setInterval(() => {
      void this._pollOnce();
    }, this._pollIntervalMs);
  }

  /**
   * Stop the poll loop.
   * In-flight transports already in progress will run to completion.
   */
  stop(): void {
    this._running = false;
    if (this._pollHandle) {
      clearInterval(this._pollHandle);
      this._pollHandle = null;
    }
  }

  /** Whether the agent is currently running. */
  get isRunning(): boolean { return this._running; }

  /**
   * Manually execute a single transport request by ID (one-shot).
   * Useful for testing and CLI invocation.
   *
   * @param trId - Transport request ID as returned by {@link TransportAgent.submitRequest}.
   * @throws if the TR does not exist on the blackboard.
   */
  async execute(trId: string): Promise<TransportStatusRecord> {
    const entry = this._blackboard.read(`transport:request:${trId}`);
    if (!entry) {
      throw new Error(`Transport request '${trId}' not found on blackboard`);
    }
    return this._runTransport(trId, entry.value as TransportRequest);
  }

  // --------------------------------------------------------------------------
  // Static helpers
  // --------------------------------------------------------------------------

  /**
   * Submit a new transport request to the blackboard.
   * Any agent may call this; only {@link TransportAgent} will execute it.
   *
   * @returns The generated transport request ID (`trId`).
   */
  static submitRequest(blackboard: LockedBlackboard, request: TransportRequest): string {
    if (!request.fromEnv || !request.toEnv) {
      throw new Error('TransportRequest must have fromEnv and toEnv');
    }
    if (!request.reason) {
      throw new Error('TransportRequest must have a reason');
    }
    const trId = `tr-${randomUUID()}`;
    blackboard.write(`transport:request:${trId}`, request, 'basis:transport');
    const status: TransportStatusRecord = {
      trId,
      status: 'pending',
      fromEnv: request.fromEnv,
      toEnv: request.toEnv,
      reason: request.reason,
      operator: request.operator,
      submittedAt: new Date().toISOString(),
    };
    blackboard.write(`transport:status:${trId}`, status, 'basis:transport');
    return trId;
  }

  // --------------------------------------------------------------------------
  // Internal poll loop
  // --------------------------------------------------------------------------

  private async _pollOnce(): Promise<void> {
    if (this._processing) return;
    this._processing = true;
    try {
      const keys = this._blackboard.listKeys().filter(k => k.startsWith('transport:request:'));
      for (const key of keys) {
        const trId = key.replace('transport:request:', '');
        const statusEntry = this._blackboard.read(`transport:status:${trId}`);
        if (!statusEntry) continue;
        if ((statusEntry.value as TransportStatusRecord).status !== 'pending') continue;
        const requestEntry = this._blackboard.read(key);
        if (!requestEntry) continue;
        await this._runTransport(trId, requestEntry.value as TransportRequest);
      }
    } finally {
      this._processing = false;
    }
  }

  // --------------------------------------------------------------------------
  // Transport lifecycle
  // --------------------------------------------------------------------------

  private async _runTransport(trId: string, request: TransportRequest): Promise<TransportStatusRecord> {
    const now = (): string => new Date().toISOString();

    const updateStatus = (patch: Partial<TransportStatusRecord>): TransportStatusRecord => {
      const existing = this._blackboard.read(`transport:status:${trId}`)?.value as TransportStatusRecord | undefined;
      const updated: TransportStatusRecord = {
        ...(existing ?? {
          trId,
          status: 'pending',
          fromEnv: request.fromEnv,
          toEnv: request.toEnv,
          reason: request.reason,
          operator: request.operator,
          submittedAt: now(),
        }),
        ...patch,
      };
      this._blackboard.write(`transport:status:${trId}`, updated, this._agentId);
      return updated;
    };

    let status = updateStatus({ startedAt: now() });

    // ------------------------------------------------------------------
    // 1. Prerequisite check
    // ------------------------------------------------------------------
    for (const prereqId of (request.prerequisites ?? [])) {
      const prereqEntry = this._blackboard.read(`transport:status:${prereqId}`);
      if (!prereqEntry) {
        status = updateStatus({ status: 'failed', error: `Prerequisite TR '${prereqId}' not found`, completedAt: now() });
        this._writeAudit('transport:prereq_failed', { trId, prereqId });
        return status;
      }
      const prereqState = (prereqEntry.value as TransportStatusRecord).status;
      if (prereqState !== 'complete') {
        status = updateStatus({ status: 'failed', error: `Prerequisite TR '${prereqId}' is in state '${prereqState}' (expected 'complete')`, completedAt: now() });
        this._writeAudit('transport:prereq_failed', { trId, prereqId, prereqState });
        return status;
      }
    }

    // ------------------------------------------------------------------
    // 2. Advisory lock — prevent concurrent promotions to the same env
    // ------------------------------------------------------------------
    const lockKey = `transport:lock:${request.toEnv}`;
    const existingLock = this._blackboard.read(lockKey);
    if (existingLock) {
      const lockData = existingLock.value as { trId: string; lockedAt: string };
      status = updateStatus({ status: 'failed', error: `Environment '${request.toEnv}' is locked by TR '${lockData.trId}'`, completedAt: now() });
      this._writeAudit('transport:lock_conflict', { trId, lockedBy: lockData.trId, toEnv: request.toEnv });
      return status;
    }
    this._blackboard.write(lockKey, { trId, lockedAt: now() }, this._agentId);

    try {
      // ----------------------------------------------------------------
      // 3. Auth check
      // ----------------------------------------------------------------
      const grant = await this._authGuardian.requestPermission(
        this._agentId,
        'ENVIRONMENT_PROMOTE',
        `Transport ${trId}: ${request.reason}`,
        `${request.fromEnv}→${request.toEnv}`,
      );
      if (!grant.granted) {
        status = updateStatus({ status: 'failed', error: `Permission denied: ${grant.reason ?? 'AuthGuardian rejected ENVIRONMENT_PROMOTE'}`, completedAt: now() });
        this._writeAudit('transport:auth_denied', { trId, reason: grant.reason });
        return status;
      }

      // ----------------------------------------------------------------
      // 4. Drain pools tagged for the destination environment
      // ----------------------------------------------------------------
      status = updateStatus({ status: 'draining' });
      const drainedPools = this._drainPools(request.toEnv);
      await this._waitForDrain(drainedPools);

      // ----------------------------------------------------------------
      // 5. Backup destination environment before overwriting
      // ----------------------------------------------------------------
      let backupId: string | undefined;
      try {
        const backupResult = this._envManager.backup(request.toEnv);
        backupId = backupResult.backupId;
      } catch {
        // Destination env may not exist yet — nothing to back up
      }

      // ----------------------------------------------------------------
      // 6. Promote
      // ----------------------------------------------------------------
      status = updateStatus({ status: 'promoting', backupId });
      let promotionResult: PromotionResult;
      try {
        promotionResult = this._envManager.promote(request.fromEnv, request.toEnv, {
          confirmedBy: request.operator,
          approvedBy: request.operator,
        });
      } catch (err) {
        status = updateStatus({ status: 'failed', error: `Promote failed: ${String(err)}`, completedAt: now() });
        this._writeAudit('transport:promote_failed', { trId, error: String(err) });
        this._resumePools(drainedPools, 100);
        return status;
      }

      // ----------------------------------------------------------------
      // 7. Canary phase
      // ----------------------------------------------------------------
      const canaryWindowMs = request.canaryWindowMs ?? 30_000;
      const canaryMaxViolations = request.canaryMaxViolations ?? 0;

      if (canaryWindowMs > 0 && this._complianceMonitor) {
        status = updateStatus({ status: 'canary', promotionResult });
        this._resumePools(drainedPools, request.canaryPercent ?? 20);

        const violationsBefore = this._complianceMonitor.getViolations().length;
        await sleep(canaryWindowMs);
        const violationsAfter = this._complianceMonitor.getViolations().length;
        const violationsDelta = Math.max(0, violationsAfter - violationsBefore);

        if (violationsDelta > canaryMaxViolations) {
          // Canary failed — roll back
          status = updateStatus({ status: 'rolled_back', violationsDetected: violationsDelta, completedAt: now() });
          this._writeAudit('transport:canary_failed', { trId, violationsDelta, canaryMaxViolations });
          this._resumePools(drainedPools, 100);
          if (backupId) {
            try {
              this._envManager.restore(request.toEnv, backupId);
              this._writeAudit('transport:rollback_complete', { trId, backupId, toEnv: request.toEnv });
            } catch (rollbackErr) {
              this._writeAudit('transport:rollback_failed', { trId, backupId, error: String(rollbackErr) });
            }
          }
          return status;
        }

        status = updateStatus({ status: 'complete', violationsDetected: violationsDelta, promotionResult, completedAt: now() });
        this._resumePools(drainedPools, 100);
      } else {
        // No canary — complete immediately
        status = updateStatus({ status: 'complete', promotionResult, completedAt: now() });
        this._resumePools(drainedPools, 100);
      }

      this._writeAudit('transport:complete', {
        trId,
        fromEnv: request.fromEnv,
        toEnv: request.toEnv,
        operator: request.operator ?? null,
      });
      return status;
    } finally {
      // Always release the advisory lock regardless of outcome
      this._blackboard.delete(lockKey);
    }
  }

  // --------------------------------------------------------------------------
  // Pool helpers
  // --------------------------------------------------------------------------

  /** Pause dispatch on all pools tagged for `env`. Returns the paused pools. */
  private _drainPools(env: EnvName): AgentPool[] {
    const tagged = this._pools.filter(p => Array.isArray(p.template.tags) && p.template.tags.includes(env));
    for (const pool of tagged) {
      pool.setDispatchPause(true);
    }
    return tagged;
  }

  /** Resume dispatch on `pools` at `percent` capacity. */
  private _resumePools(pools: AgentPool[], percent: number): void {
    for (const pool of pools) {
      pool.setDispatchPause(false, { percent });
    }
  }

  /**
   * Wait for all actively-running agents in the given pools to finish,
   * up to `_drainTimeoutMs`. Proceeds even if timeout is reached
   * (pools remain paused — only newly spawned agents are blocked).
   */
  private async _waitForDrain(pools: AgentPool[]): Promise<void> {
    if (pools.length === 0) return;
    const deadline = Date.now() + this._drainTimeoutMs;
    while (Date.now() < deadline) {
      const anyActive = pools.some(p => p.active > 0);
      if (!anyActive) return;
      await sleep(500);
    }
  }

  // --------------------------------------------------------------------------
  // Audit helper
  // --------------------------------------------------------------------------

  private _writeAudit(event: string, details: Record<string, unknown>): void {
    try {
      const entry = JSON.stringify({ timestamp: new Date().toISOString(), event, ...details });
      appendFileSync(this._auditLogPath, entry + '\n', 'utf-8');
    } catch {
      // Audit log is best-effort — never interrupt a transport for logging failures
    }
  }
}
