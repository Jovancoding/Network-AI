/**
 * LandscapeAgent — Environment topology tracker
 *
 * Polls {@link EnvironmentManager.list} on a fixed interval and writes a
 * health record for each known environment to the blackboard under
 * `landscape:health:<env>`.  TransportAgent reads these records before
 * starting a DRAINING phase to detect degraded destinations early.
 *
 * Health logic:
 *   - `missing`  — environment directory does not exist
 *   - `degraded` — last transport targeting this env failed or rolled back
 *   - `healthy`  — otherwise
 *
 * Blackboard keys written:
 *   landscape:health:<env>  — {@link EnvironmentHealth} record (overwritten each poll)
 *
 * @module LandscapeAgent
 * @version 1.0.0
 */

import type { LockedBlackboard } from './locked-blackboard';
import type { EnvironmentManager, EnvName } from './env-manager';
import type { TransportStatusRecord } from './transport-agent';

// ============================================================================
// TYPES
// ============================================================================

/** Status of a single environment as seen by {@link LandscapeAgent}. */
export type EnvironmentHealthStatus = 'healthy' | 'degraded' | 'missing';

/** Health record written to `landscape:health:<env>`. */
export interface EnvironmentHealth {
  env: EnvName;
  status: EnvironmentHealthStatus;
  /** Number of config keys present in the environment directory. */
  keyCount: number;
  /** ISO-8601 timestamp of the last successful poll. */
  lastChecked: string;
  /** Status of the most recent transport that targeted this environment. */
  lastTransportStatus?: TransportStatusRecord['status'];
  /** Transport request ID of the most recent completed transport. */
  lastTransportId?: string;
}

/** Options for constructing a {@link LandscapeAgent}. */
export interface LandscapeAgentOptions {
  /** Blackboard used to publish health records. */
  blackboard: LockedBlackboard;
  /** Environment manager for querying known environments. */
  envManager: EnvironmentManager;
  /** Agent ID used for blackboard writes. Default: `'basis:landscape'`. */
  agentId?: string;
  /** Poll interval in milliseconds. Default: 30 000. */
  pollIntervalMs?: number;
}

// ============================================================================
// LANDSCAPE AGENT
// ============================================================================

/**
 * Slow-poll environment topology tracker.
 *
 * @example
 * ```typescript
 * const landscape = new LandscapeAgent({ blackboard, envManager });
 * landscape.start();
 *
 * // Read health for a specific environment:
 * const entry = blackboard.read('landscape:health:prod');
 * const health = entry?.value as EnvironmentHealth;
 * ```
 */
export class LandscapeAgent {
  private readonly _blackboard: LockedBlackboard;
  private readonly _envManager: EnvironmentManager;
  private readonly _agentId: string;
  private readonly _pollIntervalMs: number;
  private _pollHandle: NodeJS.Timeout | null = null;
  private _running = false;

  constructor(options: LandscapeAgentOptions) {
    this._blackboard = options.blackboard;
    this._envManager = options.envManager;
    this._agentId = options.agentId ?? 'basis:landscape';
    this._pollIntervalMs = options.pollIntervalMs ?? 30_000;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Start the poll loop.  The first poll fires immediately.
   */
  start(): void {
    if (this._running) return;
    this._running = true;
    void this._poll(); // immediate first run
    this._pollHandle = setInterval(() => void this._poll(), this._pollIntervalMs);
  }

  /** Stop the poll loop. */
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
   * Perform a single health poll and write results to the blackboard.
   * Can be called manually (e.g. from tests) without starting the loop.
   */
  async poll(): Promise<EnvironmentHealth[]> {
    return this._poll();
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private async _poll(): Promise<EnvironmentHealth[]> {
    const envs = this._envManager.list();
    const results: EnvironmentHealth[] = [];

    for (const env of envs) {
      const health = this._computeHealth(env.name, env.exists, env.keyCount);
      this._blackboard.write(`landscape:health:${env.name}`, health, this._agentId);
      results.push(health);
    }

    return results;
  }

  private _computeHealth(env: EnvName, exists: boolean, keyCount: number): EnvironmentHealth {
    const lastChecked = new Date().toISOString();

    if (!exists) {
      return { env, status: 'missing', keyCount: 0, lastChecked };
    }

    // Inspect the most recent completed transport targeting this environment
    const { status: lastTransportStatus, trId: lastTransportId } = this._findLastTransport(env);

    if (lastTransportStatus === 'failed' || lastTransportStatus === 'rolled_back') {
      return { env, status: 'degraded', keyCount, lastChecked, lastTransportStatus, lastTransportId };
    }

    return { env, status: 'healthy', keyCount, lastChecked, lastTransportStatus, lastTransportId };
  }

  /** Scan `transport:status:*` keys for the most recent TR that targeted `env`. */
  private _findLastTransport(env: EnvName): { status?: TransportStatusRecord['status']; trId?: string } {
    const statusKeys = this._blackboard.listKeys().filter(k => k.startsWith('transport:status:'));

    let latestTime = 0;
    let latestStatus: TransportStatusRecord['status'] | undefined;
    let latestTrId: string | undefined;

    for (const key of statusKeys) {
      const entry = this._blackboard.read(key);
      if (!entry) continue;
      const rec = entry.value as TransportStatusRecord;
      if (rec.toEnv !== env) continue;
      // Only consider terminal states
      if (!rec.completedAt) continue;
      const t = new Date(rec.completedAt).getTime();
      if (t > latestTime) {
        latestTime = t;
        latestStatus = rec.status;
        latestTrId = rec.trId;
      }
    }

    return { status: latestStatus, trId: latestTrId };
  }
}
