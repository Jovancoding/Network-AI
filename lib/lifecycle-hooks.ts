/**
 * OrchestratorLifecycleHooks — Orchestrator-level agent lifecycle hooks.
 *
 * Unlike AdapterHookManager (which wraps individual adapter calls), these
 * hooks wrap the full delegation pipeline: auth → injection scan → adapter
 * execution → quality gate → result.
 *
 * Three phases: `beforeSpawn`, `afterComplete`, `onFailure`.
 *
 * @module OrchestratorLifecycleHooks
 */

// ============================================================================
// TYPES
// ============================================================================

/** Lifecycle phase */
export type LifecyclePhase = 'beforeSpawn' | 'afterComplete' | 'onFailure';

/** Context available at beforeSpawn — agent selected, not yet executed */
export interface BeforeSpawnContext {
  agentId: string;
  instruction: string;
  priority: string;
  requiresAuth: boolean;
  metadata: Record<string, unknown>;
  /** Set to true to abort the delegation before execution */
  aborted: boolean;
  /** If aborted, reason shown to caller */
  abortReason?: string;
}

/** Context available at afterComplete — result approved by quality gate */
export interface AfterCompleteContext {
  agentId: string;
  instruction: string;
  result: unknown;
  durationMs: number;
  tokensUsed: number;
  metadata: Record<string, unknown>;
}

/** Context available at onFailure — error captured */
export interface OnFailureContext {
  agentId: string;
  instruction: string;
  error: Error | string;
  durationMs: number;
  metadata: Record<string, unknown>;
  /** Set to true to suppress the error (delegation returns a default instead) */
  suppress: boolean;
}

/** Hook handler — can be sync or async */
export type LifecycleHandler<T> = (ctx: T) => void | Promise<void>;

/** Registered hook entry */
export interface LifecycleHookEntry<T = unknown> {
  name: string;
  phase: LifecyclePhase;
  priority: number;
  handler: LifecycleHandler<T>;
}

// ============================================================================
// LIFECYCLE HOOKS MANAGER
// ============================================================================

/**
 * Registry and runner for orchestrator-level lifecycle hooks.
 *
 * @example
 * ```ts
 * const hooks = new OrchestratorLifecycleHooks();
 *
 * hooks.beforeSpawn('log-spawn', (ctx) => {
 *   console.log(`Spawning ${ctx.agentId}: ${ctx.instruction}`);
 * });
 *
 * hooks.afterComplete('track-cost', (ctx) => {
 *   costTracker.record(ctx.agentId, ctx.tokensUsed, ctx.durationMs);
 * });
 *
 * hooks.onFailure('alert', (ctx) => {
 *   alerting.send(`${ctx.agentId} failed: ${ctx.error}`);
 * });
 * ```
 */
export class OrchestratorLifecycleHooks {
  private hooks: Map<LifecyclePhase, LifecycleHookEntry[]> = new Map([
    ['beforeSpawn', []],
    ['afterComplete', []],
    ['onFailure', []],
  ]);

  /**
   * Register a beforeSpawn hook.
   * Can modify context or set `aborted = true` to block execution.
   */
  beforeSpawn(name: string, handler: LifecycleHandler<BeforeSpawnContext>, priority = 0): void {
    this.register({ name, phase: 'beforeSpawn', priority, handler: handler as LifecycleHandler<unknown> });
  }

  /**
   * Register an afterComplete hook.
   * Receives the approved result after quality gate.
   */
  afterComplete(name: string, handler: LifecycleHandler<AfterCompleteContext>, priority = 0): void {
    this.register({ name, phase: 'afterComplete', priority, handler: handler as LifecycleHandler<unknown> });
  }

  /**
   * Register an onFailure hook.
   * Can set `suppress = true` to silently absorb the error.
   */
  onFailure(name: string, handler: LifecycleHandler<OnFailureContext>, priority = 0): void {
    this.register({ name, phase: 'onFailure', priority, handler: handler as LifecycleHandler<unknown> });
  }

  /** Remove a hook by name */
  unregister(name: string): boolean {
    let found = false;
    for (const [phase, list] of this.hooks) {
      const idx = list.findIndex(h => h.name === name);
      if (idx >= 0) {
        list.splice(idx, 1);
        this.hooks.set(phase, list);
        found = true;
      }
    }
    return found;
  }

  /** List all registered hooks */
  list(): LifecycleHookEntry[] {
    const all: LifecycleHookEntry[] = [];
    for (const list of this.hooks.values()) all.push(...list);
    return all;
  }

  /** Number of registered hooks */
  size(): number {
    let count = 0;
    for (const list of this.hooks.values()) count += list.length;
    return count;
  }

  /** Clear all hooks */
  clear(): void {
    for (const list of this.hooks.values()) list.length = 0;
  }

  /**
   * Run all beforeSpawn hooks in priority order.
   * Returns the (potentially mutated) context.
   */
  async runBeforeSpawn(ctx: BeforeSpawnContext): Promise<BeforeSpawnContext> {
    return this.runPhase('beforeSpawn', ctx) as Promise<BeforeSpawnContext>;
  }

  /**
   * Run all afterComplete hooks in priority order.
   */
  async runAfterComplete(ctx: AfterCompleteContext): Promise<AfterCompleteContext> {
    return this.runPhase('afterComplete', ctx) as Promise<AfterCompleteContext>;
  }

  /**
   * Run all onFailure hooks in priority order.
   * Returns the (potentially mutated) context.
   */
  async runOnFailure(ctx: OnFailureContext): Promise<OnFailureContext> {
    return this.runPhase('onFailure', ctx) as Promise<OnFailureContext>;
  }

  // --------------------------------------------------------------------------
  // INTERNAL
  // --------------------------------------------------------------------------

  private register(entry: LifecycleHookEntry): void {
    const list = this.hooks.get(entry.phase);
    if (!list) throw new Error(`Unknown lifecycle phase: ${entry.phase}`);
    const existing = list.findIndex(h => h.name === entry.name);
    if (existing >= 0) {
      list[existing] = entry; // overwrite
    } else {
      list.push(entry);
    }
    list.sort((a, b) => b.priority - a.priority);
  }

  private async runPhase(phase: LifecyclePhase, ctx: unknown): Promise<unknown> {
    const list = this.hooks.get(phase) ?? [];
    for (const hook of list) {
      try {
        await (hook.handler as LifecycleHandler<unknown>)(ctx);
      } catch {
        // Hook errors are swallowed to prevent one bad hook from
        // blocking the entire delegation pipeline.
      }
    }
    return ctx;
  }
}
