/**
 * Federated Budget Tracking
 *
 * Tracks token spending across distributed agent swarms. Each `FederatedBudget`
 * instance enforces a global ceiling shared among all agents that call `spend()`.
 *
 * When an optional `BlackboardBackend` is supplied, the budget state is written
 * to the blackboard after every mutation. Wiring a `CrdtBackend` or `RedisBackend`
 * as the underlying backend therefore gives automatic cross-node synchronization
 * with no extra configuration.
 *
 * Architecture:
 *   - In-memory `spent` map keyed by `agentId` holds per-agent cumulative totals.
 *   - `spend()` is synchronous and enforces both the global ceiling and an optional
 *     per-agent ceiling in a single check.
 *   - A `blackboard` backend (if supplied) stores a JSON snapshot under `budgetKey`
 *     after every `spend()` / `reset()` / `setCeiling()` call so distributed nodes
 *     can read the latest state.
 *   - `loadFromBlackboard()` deserializes a previously saved snapshot so a
 *     restarted node can recover its prior accumulated spend.
 *
 * @example
 * ```typescript
 * import { FederatedBudget } from 'network-ai';
 *
 * const budget = new FederatedBudget({ ceiling: 10_000 });
 *
 * budget.spend('agent-1', 3000); // { allowed: true,  remaining: 7000 }
 * budget.spend('agent-2', 8000); // { allowed: false, remaining: 7000 }
 * budget.remaining();            // 7000
 * budget.getSpendLog();          // { 'agent-1': 3000 }
 * ```
 *
 * @example With blackboard persistence
 * ```typescript
 * import { CrdtBackend } from 'network-ai';
 * import { FederatedBudget } from 'network-ai';
 *
 * const node = new CrdtBackend('node-a');
 * const budget = new FederatedBudget({ ceiling: 50_000, blackboard: node });
 *
 * budget.spend('agent-1', 1000);
 * // State is now stored in node under 'federated-budget'
 * // Sync node to other CrdtBackend nodes to propagate the spend.
 * ```
 *
 * @module FederatedBudget
 * @version 1.0.0
 * @license MIT
 */

import type { BlackboardBackend } from './blackboard-backend';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Result returned by {@link FederatedBudget.spend}.
 */
export interface SpendResult {
  /** Whether the spend was allowed (i.e. did not breach any ceiling). */
  allowed: boolean;
  /** Remaining tokens in the global pool after this call. */
  remaining: number;
  /** Reason the spend was denied, if `allowed` is `false`. */
  deniedReason?: 'global_ceiling' | 'per_agent_ceiling';
}

/**
 * A single entry in the spend log returned by {@link FederatedBudget.getSpendLog}.
 */
export interface SpendLogEntry {
  /** Agent that made the spend. */
  agentId: string;
  /** Number of tokens spent in this transaction. */
  tokens: number;
  /** ISO timestamp of the spend. */
  timestamp: string;
}

/**
 * Serializable snapshot of budget state stored on the blackboard.
 * @internal
 */
interface BudgetSnapshot {
  ceiling: number;
  perAgentCeiling?: number;
  spent: Record<string, number>;
  totalSpent: number;
}

// ============================================================================
// OPTIONS
// ============================================================================

/**
 * Construction options for {@link FederatedBudget}.
 */
export interface FederatedBudgetOptions {
  /**
   * Global token ceiling shared across all agents.
   * No single call to `spend()` may push the cumulative total above this value.
   * Must be a positive integer.
   */
  ceiling: number;

  /**
   * Optional per-agent ceiling.
   * When set, each individual agent is also capped at this many cumulative tokens,
   * independently of the global ceiling.
   * Must be a positive integer if provided.
   */
  perAgentCeiling?: number;

  /**
   * Optional blackboard backend.
   * When provided, budget state is persisted under `budgetKey` after every
   * mutation so distributed nodes can observe the latest spend.
   *
   * Pair with a `CrdtBackend` or `RedisBackend` for automatic multi-node sync.
   */
  blackboard?: BlackboardBackend;

  /**
   * Key used to store the budget snapshot on the blackboard.
   * Defaults to `'federated-budget'`.
   */
  budgetKey?: string;

  /**
   * Agent identifier used as the `agentId` when writing to the blackboard.
   * Defaults to `'federated-budget-tracker'`.
   */
  blackboardAgent?: string;
}

// ============================================================================
// FEDERATED BUDGET
// ============================================================================

/**
 * Federated token-budget tracker for distributed agent swarms.
 *
 * Enforces a shared global ceiling across all agents and optionally an
 * individual per-agent ceiling. State can be persisted to any
 * `BlackboardBackend` for cross-node visibility.
 */
export class FederatedBudget {
  private readonly _ceiling: number;
  private _dynamicCeiling: number;
  private readonly _perAgentCeiling: number | undefined;
  private readonly _spent: Map<string, number> = new Map();
  private _totalSpent = 0;
  private readonly _log: SpendLogEntry[] = [];
  private readonly _blackboard: BlackboardBackend | undefined;
  private readonly _budgetKey: string;
  private readonly _bbAgent: string;

  constructor(options: FederatedBudgetOptions) {
    if (typeof options.ceiling !== 'number' || options.ceiling <= 0 || !Number.isFinite(options.ceiling)) {
      throw new RangeError('FederatedBudget: ceiling must be a positive finite number');
    }
    if (
      options.perAgentCeiling !== undefined &&
      (typeof options.perAgentCeiling !== 'number' ||
        options.perAgentCeiling <= 0 ||
        !Number.isFinite(options.perAgentCeiling))
    ) {
      throw new RangeError('FederatedBudget: perAgentCeiling must be a positive finite number when provided');
    }

    this._ceiling = options.ceiling;
    this._dynamicCeiling = options.ceiling;
    this._perAgentCeiling = options.perAgentCeiling;
    this._blackboard = options.blackboard;
    this._budgetKey = options.budgetKey ?? 'federated-budget';
    this._bbAgent = options.blackboardAgent ?? 'federated-budget-tracker';
  }

  // --------------------------------------------------------------------------
  // PUBLIC API
  // --------------------------------------------------------------------------

  /**
   * Attempt to spend `tokens` on behalf of `agentId`.
   *
   * The spend is allowed only when:
   *   1. `totalSpent + tokens <= ceiling` (global ceiling not breached), AND
   *   2. `agentSpent + tokens <= perAgentCeiling` if a per-agent ceiling is set.
   *
   * When allowed the internal counters are updated and the state is persisted
   * to the blackboard (if configured).
   *
   * @param agentId  Identifier of the spending agent. Must be a non-empty string.
   * @param tokens   Number of tokens to spend. Must be a positive integer.
   * @returns        `SpendResult` with `allowed`, `remaining`, and optional `deniedReason`.
   */
  spend(agentId: string, tokens: number): SpendResult {
    if (!agentId || typeof agentId !== 'string') {
      throw new TypeError('FederatedBudget.spend: agentId must be a non-empty string');
    }
    if (typeof tokens !== 'number' || tokens <= 0 || !Number.isFinite(tokens)) {
      throw new RangeError('FederatedBudget.spend: tokens must be a positive finite number');
    }

    const agentSpent = this._spent.get(agentId) ?? 0;

    // Check per-agent ceiling first (lower ceiling wins)
    if (this._perAgentCeiling !== undefined && agentSpent + tokens > this._perAgentCeiling) {
      return {
        allowed: false,
        remaining: this.remaining(),
        deniedReason: 'per_agent_ceiling',
      };
    }

    // Check global ceiling
    if (this._totalSpent + tokens > this._dynamicCeiling) {
      return {
        allowed: false,
        remaining: this.remaining(),
        deniedReason: 'global_ceiling',
      };
    }

    // Commit
    this._spent.set(agentId, agentSpent + tokens);
    this._totalSpent += tokens;
    this._log.push({
      agentId,
      tokens,
      timestamp: new Date().toISOString(),
    });

    this._persist();

    return {
      allowed: true,
      remaining: this.remaining(),
    };
  }

  /**
   * Remaining tokens in the global pool.
   */
  remaining(): number {
    return Math.max(0, this._dynamicCeiling - this._totalSpent);
  }

  /**
   * Total tokens spent across all agents.
   */
  getTotalSpent(): number {
    return this._totalSpent;
  }

  /**
   * Tokens spent by a specific agent. Returns `0` if the agent has no spend.
   */
  getAgentSpent(agentId: string): number {
    return this._spent.get(agentId) ?? 0;
  }

  /**
   * Per-agent spend totals as a plain object: `{ agentId: totalTokens }`.
   */
  getSpendLog(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [id, total] of this._spent) {
      result[id] = total;
    }
    return result;
  }

  /**
   * Detailed transaction log — every individual `spend()` call in order.
   */
  getTransactionLog(): SpendLogEntry[] {
    return this._log.slice();
  }

  /**
   * Current global ceiling (may differ from the original if `setCeiling()` was called).
   */
  getCeiling(): number {
    return this._dynamicCeiling;
  }

  /**
   * Per-agent ceiling, or `undefined` if none was configured.
   */
  getPerAgentCeiling(): number | undefined {
    return this._perAgentCeiling;
  }

  /**
   * Dynamically adjust the global ceiling.
   *
   * The new ceiling must be a positive finite number. It may be set below
   * the current `totalSpent` (no previously approved spends are reversed, but
   * future spends will be denied until tokens are freed by a `reset()`).
   *
   * @param ceiling  New global ceiling.
   */
  setCeiling(ceiling: number): void {
    if (typeof ceiling !== 'number' || ceiling <= 0 || !Number.isFinite(ceiling)) {
      throw new RangeError('FederatedBudget.setCeiling: ceiling must be a positive finite number');
    }
    this._dynamicCeiling = ceiling;
    this._persist();
  }

  /**
   * Reset all spend counters and clear the transaction log.
   *
   * The global ceiling is preserved (its current value after any `setCeiling()`
   * calls). After a reset `remaining() === getCeiling()`.
   *
   * The blackboard entry (if configured) is updated with the reset state.
   */
  reset(): void {
    this._spent.clear();
    this._totalSpent = 0;
    this._log.length = 0;
    this._persist();
  }

  /**
   * Restore budget state from the blackboard backend.
   *
   * Reads the entry stored under `budgetKey`, deserializes the snapshot, and
   * replaces the current in-memory state. Useful when a node restarts and
   * needs to recover its prior accumulated spend.
   *
   * No-op (returns `false`) when no blackboard is configured or no entry exists.
   *
   * @returns `true` if state was successfully loaded, `false` otherwise.
   */
  loadFromBlackboard(): boolean {
    if (!this._blackboard) return false;
    const entry = this._blackboard.read(this._budgetKey);
    if (!entry) return false;
    try {
      const snapshot: BudgetSnapshot = JSON.parse(entry.value as string);
      this._spent.clear();
      for (const [id, total] of Object.entries(snapshot.spent)) {
        this._spent.set(id, total);
      }
      this._totalSpent = snapshot.totalSpent;
      this._dynamicCeiling = snapshot.ceiling;
      return true;
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // PRIVATE HELPERS
  // --------------------------------------------------------------------------

  /** Serialize current state to the blackboard, if one is configured. */
  private _persist(): void {
    if (!this._blackboard) return;
    const snapshot: BudgetSnapshot = {
      ceiling: this._dynamicCeiling,
      perAgentCeiling: this._perAgentCeiling,
      spent: this.getSpendLog(),
      totalSpent: this._totalSpent,
    };
    try {
      this._blackboard.write(this._budgetKey, JSON.stringify(snapshot), this._bbAgent);
    } catch {
      // Swallow persistence errors — the in-memory state remains authoritative.
    }
  }
}
