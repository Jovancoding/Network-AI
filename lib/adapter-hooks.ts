/**
 * Adapter Hook Middleware — Lifecycle hooks for agent execution
 *
 * Provides beforeExecute / afterExecute / onError hooks that wrap any adapter's
 * executeAgent call. Hooks run in priority order and can modify the context,
 * short-circuit execution, or transform results.
 *
 * Inspired by Claw-Code's middleware pipeline pattern.
 *
 * @module AdapterHooks
 * @version 1.0.0
 */

import type { AgentPayload, AgentContext, AgentResult } from '../types/agent-adapter';

// ============================================================================
// TYPES
// ============================================================================

/** Lifecycle phase a hook runs in */
export type HookPhase = 'beforeExecute' | 'afterExecute' | 'onError';

/**
 * Mutable context threaded through the hook pipeline.
 * beforeExecute hooks can modify payload/context; afterExecute hooks can modify result.
 */
export interface HookContext {
  /** The agent being executed */
  agentId: string;
  /** Mutable payload — beforeExecute hooks may rewrite */
  payload: AgentPayload;
  /** Mutable execution context */
  context: AgentContext;
  /** Result from agent execution (set in afterExecute phase) */
  result?: AgentResult;
  /** Error caught during execution (set in onError phase) */
  error?: Error;
  /** Arbitrary hook-local metadata */
  metadata: Record<string, unknown>;
  /** If set to true by a beforeExecute hook, execution is skipped and result is returned as-is */
  aborted: boolean;
  /**
   * Recursion depth of the current agent call (0 = root, 1 = first sub-agent, etc.).
   * Hooks can use this to distinguish top-level calls from recursive sub-calls
   * and apply different policies (e.g. stricter budgets or logging at depth 0 only).
   */
  depth: number;
}

/**
 * A single lifecycle hook.
 */
export interface ExecutionHook {
  /** Unique hook name */
  name: string;
  /** Which phase this hook fires in */
  phase: HookPhase;
  /** Higher priority hooks run first (default 0) */
  priority?: number;
  /** The hook handler — may mutate ctx and return it */
  handler: (ctx: HookContext) => Promise<HookContext> | HookContext;
  /** Optional matcher — if provided, hook only fires when matcher passes */
  matcher?: HookMatcher;
}

/**
 * Matcher for filtering when a hook should fire.
 * All specified conditions must match (AND logic).
 */
export interface HookMatcher {
  /** Glob-style pattern matched against agentId. Supports '*' and '?' wildcards. */
  agentPattern?: string;
  /** Glob-style pattern matched against payload.action. Supports '*' and '?' wildcards. */
  actionPattern?: string;
  /** Tool pattern in format 'ToolName(argGlob)' — e.g. 'Bash(git *)' or 'Edit(*.env)' */
  toolPattern?: string;
  /** Custom condition function — return true for the hook to fire */
  condition?: (ctx: HookContext) => boolean;
}

// ============================================================================
// HOOK MANAGER
// ============================================================================

/**
 * Manages lifecycle hooks for adapter execution.
 *
 * Usage:
 * ```typescript
 * const hooks = new AdapterHookManager();
 *
 * hooks.register({
 *   name: 'log-timing',
 *   phase: 'beforeExecute',
 *   handler(ctx) {
 *     ctx.metadata.startTime = Date.now();
 *     return ctx;
 *   },
 * });
 *
 * hooks.register({
 *   name: 'log-timing-after',
 *   phase: 'afterExecute',
 *   handler(ctx) {
 *     const elapsed = Date.now() - (ctx.metadata.startTime as number);
 *     console.log(`Agent ${ctx.agentId} took ${elapsed}ms`);
 *     return ctx;
 *   },
 * });
 * ```
 */
export class AdapterHookManager {
  private hooks: Map<HookPhase, ExecutionHook[]> = new Map([
    ['beforeExecute', []],
    ['afterExecute', []],
    ['onError', []],
  ]);

  /**
   * Register a lifecycle hook.
   * Throws if a hook with the same name already exists.
   */
  register(hook: ExecutionHook): void {
    // Prevent duplicate names across all phases
    for (const phaseHooks of this.hooks.values()) {
      if (phaseHooks.some(h => h.name === hook.name)) {
        throw new Error(`Hook "${hook.name}" is already registered`);
      }
    }

    const list = this.hooks.get(hook.phase)!;
    list.push(hook);
    // Re-sort: higher priority first
    list.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  /**
   * Remove a hook by name.
   * @returns true if a hook was removed
   */
  unregister(name: string): boolean {
    for (const [, list] of this.hooks.entries()) {
      const idx = list.findIndex(h => h.name === name);
      if (idx !== -1) {
        list.splice(idx, 1);
        return true;
      }
    }
    return false;
  }

  /**
   * List all registered hooks.
   */
  list(): ExecutionHook[] {
    const all: ExecutionHook[] = [];
    for (const list of this.hooks.values()) {
      all.push(...list);
    }
    return all;
  }

  /**
   * Create a fresh HookContext for a new execution.
   *
   * @param agentId  The agent being executed.
   * @param payload  Execution payload (shallow-copied so hooks don't mutate the caller's object).
   * @param context  Execution context (shallow-copied).
   * @param depth    Recursion depth — 0 for root calls, incremented by sub-agent spawners (default: 0).
   */
  createContext(agentId: string, payload: AgentPayload, context: AgentContext, depth = 0): HookContext {
    return {
      agentId,
      payload: { ...payload },
      context: { ...context },
      metadata: {},
      aborted: false,
      depth,
    };
  }

  /**
   * Run all beforeExecute hooks in priority order.
   * If any hook sets ctx.aborted = true, remaining hooks still run but
   * the caller should skip actual execution.
   */
  async runBefore(ctx: HookContext): Promise<HookContext> {
    return this.runPhase('beforeExecute', ctx);
  }

  /**
   * Run all afterExecute hooks in priority order.
   * ctx.result must be set before calling.
   */
  async runAfter(ctx: HookContext): Promise<HookContext> {
    return this.runPhase('afterExecute', ctx);
  }

  /**
   * Run all onError hooks in priority order.
   * ctx.error must be set before calling.
   */
  async runOnError(ctx: HookContext): Promise<HookContext> {
    return this.runPhase('onError', ctx);
  }

  /**
   * Total number of registered hooks.
   */
  size(): number {
    let total = 0;
    for (const list of this.hooks.values()) {
      total += list.length;
    }
    return total;
  }

  /**
   * Remove all hooks.
   */
  clear(): void {
    for (const list of this.hooks.values()) {
      list.length = 0;
    }
  }

  private async runPhase(phase: HookPhase, ctx: HookContext): Promise<HookContext> {
    const hooks = this.hooks.get(phase) ?? [];
    let current = ctx;
    for (const hook of hooks) {
      if (hook.matcher && !this.matchesHook(hook.matcher, current)) {
        continue; // skip — matcher did not pass
      }
      current = await hook.handler(current);
    }
    return current;
  }

  /**
   * Check whether a HookMatcher passes for the given context.
   */
  private matchesHook(matcher: HookMatcher, ctx: HookContext): boolean {
    if (matcher.agentPattern && !matchGlob(matcher.agentPattern, ctx.agentId)) {
      return false;
    }
    if (matcher.actionPattern && !matchGlob(matcher.actionPattern, ctx.payload.action)) {
      return false;
    }
    if (matcher.toolPattern) {
      const toolStr = (ctx.metadata?.tool as string) ?? '';
      if (!matchToolPattern(matcher.toolPattern, toolStr)) {
        return false;
      }
    }
    if (matcher.condition && !matcher.condition(ctx)) {
      return false;
    }
    return true;
  }
}

// ============================================================================
// GLOB MATCHING UTILITIES
// ============================================================================

/**
 * Simple glob matcher supporting `*` (any chars) and `?` (single char).
 * Case-insensitive.
 */
export function matchGlob(pattern: string, value: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex specials (except * and ?)
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`, 'i').test(value);
}

/**
 * Match a tool pattern like "Bash(git *)" against a tool string like "Bash(git push)".
 */
export function matchToolPattern(pattern: string, toolStr: string): boolean {
  const pMatch = pattern.match(/^([^(]+)\((.+)\)$/);
  if (!pMatch) {
    // No parens — match the whole string as a glob
    return matchGlob(pattern, toolStr);
  }
  const [, toolName, argPattern] = pMatch;
  const tMatch = toolStr.match(/^([^(]+)\((.+)\)$/);
  if (!tMatch) return false;
  const [, actualTool, actualArgs] = tMatch;

  return matchGlob(toolName, actualTool) && matchGlob(argPattern, actualArgs);
}
