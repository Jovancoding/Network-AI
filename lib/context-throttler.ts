/**
 * Context Throttler — Metadata-Driven Blackboard Pruning for Network-AI
 *
 * Prevents "context pollution" by ensuring agents only receive the subset of
 * Blackboard state that is relevant to their declared scope metadata.
 *
 * Before an LLM call the orchestrator passes the full blackboard snapshot and
 * the agent's `scopeMetadata` tags to `filterState()`. Keys that do not match
 * any tag are pruned, keeping the system prompt lean regardless of how large
 * the shared state grows.
 *
 * Zero external dependencies — pure TypeScript functions.
 *
 * @module ContextThrottler
 * @version 1.0.0
 */

// ============================================================================
// TYPES
// ============================================================================

/**
 * A tag-based scope declaration attached to an agent definition.
 *
 * Each tag is a plain lowercase string (e.g. `"financials"`, `"regulations"`).
 * Keys in the blackboard snapshot whose stringified key contains ANY matching
 * tag will be retained; all others are pruned.
 *
 * Special value `["*"]` means "keep everything" (no pruning).
 */
export type ScopeMetadata = string[];

/**
 * A flat key→value snapshot of the blackboard (or any shared state dict).
 * Values are kept as `unknown` so the throttler is type-agnostic.
 */
export type BlackboardSnapshot = Record<string, unknown>;

/** Result of a throttling operation. */
export interface ThrottleResult {
  /** The pruned state — only keys matching the scope. */
  filteredState: BlackboardSnapshot;
  /** Keys that were retained. */
  retainedKeys: string[];
  /** Keys that were pruned. */
  prunedKeys: string[];
  /** Agent ID the filter was applied for. */
  agentId: string;
  /** The tags used for filtering. */
  scopeMetadata: ScopeMetadata;
}

/** Options for {@link ContextThrottler}. */
export interface ContextThrottlerOptions {
  /**
   * When true, tag matching is case-sensitive (default: false — case-insensitive).
   */
  caseSensitive?: boolean;
  /**
   * When true, a key is retained if it EXACTLY equals a tag rather than
   * requiring the key to merely CONTAIN the tag as a substring.
   * Default: false (substring match).
   */
  exactMatch?: boolean;
  /**
   * Maximum number of keys to retain per agent (0 = unlimited).
   * Useful as a hard cap to prevent accidentally large contexts.
   * When the limit is hit, retained keys are chosen in insertion order.
   */
  maxKeys?: number;
}

// ============================================================================
// PURE FILTER FUNCTION
// ============================================================================

/**
 * Prune a blackboard state snapshot to only include keys matching an agent's
 * scope metadata tags.
 *
 * This is the core primitive — stateless and dependency-free. Use it directly
 * or via {@link ContextThrottler} for the OOP interface.
 *
 * @param agentId - Agent identifier (used only in the returned result metadata)
 * @param state - Full blackboard snapshot (key → value)
 * @param scopeMetadata - Tags declaring what the agent cares about
 * @param options - Matching behaviour overrides
 *
 * @example
 * ```typescript
 * import { filterState } from 'network-ai';
 *
 * const pruned = filterState('tax-agent', fullBlackboard, ['financials', 'tax']);
 * // pruned.filteredState only contains keys containing "financials" or "tax"
 * ```
 */
export function filterState(
  agentId: string,
  state: BlackboardSnapshot,
  scopeMetadata: ScopeMetadata,
  options: ContextThrottlerOptions = {},
): ThrottleResult {
  const { caseSensitive = false, exactMatch = false, maxKeys = 0 } = options;

  // Wildcard — keep everything
  if (scopeMetadata.includes('*') || scopeMetadata.length === 0) {
    const allKeys = Object.keys(state);
    return {
      filteredState: { ...state },
      retainedKeys: allKeys,
      prunedKeys: [],
      agentId,
      scopeMetadata,
    };
  }

  const normalizedTags = caseSensitive
    ? scopeMetadata
    : scopeMetadata.map((t) => t.toLowerCase());

  const retainedKeys: string[] = [];
  const prunedKeys: string[] = [];

  for (const key of Object.keys(state)) {
    const normalizedKey = caseSensitive ? key : key.toLowerCase();
    const matches = exactMatch
      ? normalizedTags.includes(normalizedKey)
      : normalizedTags.some((tag) => normalizedKey.includes(tag));

    if (matches) {
      retainedKeys.push(key);
    } else {
      prunedKeys.push(key);
    }
  }

  // Apply hard cap
  const cappedKeys = maxKeys > 0 ? retainedKeys.slice(0, maxKeys) : retainedKeys;
  const extraPruned = maxKeys > 0 ? retainedKeys.slice(maxKeys) : [];

  const filteredState: BlackboardSnapshot = {};
  for (const key of cappedKeys) {
    filteredState[key] = state[key];
  }

  return {
    filteredState,
    retainedKeys: cappedKeys,
    prunedKeys: [...prunedKeys, ...extraPruned],
    agentId,
    scopeMetadata,
  };
}

// ============================================================================
// CONTEXT THROTTLER (OOP interface)
// ============================================================================

/**
 * ContextThrottler provides a stateful interface for the `filterState`
 * primitive and maintains per-agent scope registrations.
 *
 * @example
 * ```typescript
 * const throttler = new ContextThrottler();
 * throttler.registerScope('tax-agent', ['financials', 'tax', 'regulations']);
 * throttler.registerScope('hr-agent',  ['employees', 'salaries']);
 *
 * const result = throttler.filter('tax-agent', fullBlackboard);
 * // result.filteredState only has the keys relevant to the tax agent
 * ```
 */
export class ContextThrottler {
  private scopes: Map<string, ScopeMetadata> = new Map();
  private options: ContextThrottlerOptions;

  constructor(options: ContextThrottlerOptions = {}) {
    this.options = options;
  }

  /**
   * Register a scope for an agent. Overwrites any existing registration.
   * @param agentId - Agent identifier
   * @param scopeMetadata - Tags for this agent (use `['*']` to opt out of filtering)
   */
  registerScope(agentId: string, scopeMetadata: ScopeMetadata): void {
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('agentId must be a non-empty string');
    }
    this.scopes.set(agentId, scopeMetadata);
  }

  /**
   * Remove a registered scope.
   */
  deregisterScope(agentId: string): void {
    this.scopes.delete(agentId);
  }

  /**
   * Return the registered scope for an agent, or undefined if not registered.
   */
  getScope(agentId: string): ScopeMetadata | undefined {
    return this.scopes.get(agentId);
  }

  /**
   * Filter a blackboard snapshot for a specific agent using its registered
   * scope. If no scope is registered for the agent, all keys are retained
   * (equivalent to `['*']`).
   *
   * @param agentId - Agent to filter for
   * @param state - Full blackboard snapshot
   * @param overrideScope - Override the registered scope for this call only
   */
  filter(
    agentId: string,
    state: BlackboardSnapshot,
    overrideScope?: ScopeMetadata,
  ): ThrottleResult {
    const scope = overrideScope ?? this.scopes.get(agentId) ?? ['*'];
    return filterState(agentId, state, scope, this.options);
  }

  /**
   * Filter and return only the `filteredState` object (convenience wrapper).
   */
  filterToState(agentId: string, state: BlackboardSnapshot, overrideScope?: ScopeMetadata): BlackboardSnapshot {
    return this.filter(agentId, state, overrideScope).filteredState;
  }

  /**
   * Filter a full state snapshot for every registered agent.
   * Returns a Map of agentId → ThrottleResult.
   */
  filterAll(state: BlackboardSnapshot): Map<string, ThrottleResult> {
    const results = new Map<string, ThrottleResult>();
    for (const [agentId] of this.scopes) {
      results.set(agentId, this.filter(agentId, state));
    }
    return results;
  }

  /** Number of registered agent scopes. */
  get size(): number {
    return this.scopes.size;
  }
}
