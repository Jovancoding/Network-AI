/**
 * MCP Context Tools — signal-over-noise retrieval for MCP agents.
 *
 * Two tools that let any MCP client (Claude Code, Codex, Gemini CLI, Cursor)
 * pull *curated* shared state instead of dumping the whole blackboard into
 * its own context window:
 *
 *   - `context_pack`      — "give me everything relevant to task X in
 *     ≤ N tokens": a token-budgeted, relevance-ranked, position-aware
 *     context brief assembled by {@link ContextComposer} from the agent's
 *     scoped blackboard snapshot.
 *   - `blackboard_search` — ranked top-K search over blackboard entries.
 *     Uses a semantic ranker when one is wired (BYOE `SemanticMemory`),
 *     falling back to deterministic lexical overlap scoring otherwise —
 *     always works out of the box.
 *
 * Implements the same `McpToolProvider` contract as the other tool modules,
 * so it registers directly on `McpCombinedBridge`.
 *
 * @example
 * ```typescript
 * const contextTools = new ContextMcpTools({ blackboard });
 * combined.register(contextTools);
 * // MCP client:  context_pack { task: "fix the parser bug", budget_tokens: 1500, agent_id: "claude-code" }
 * ```
 *
 * @module mcp-tools-context
 * @version 1.0.0
 */

import type { MCPToolDefinition, BlackboardToolResult, IBlackboard } from './mcp-blackboard-tools';
import {
  ContextComposer,
  createSemanticMemoryRanker,
  estimateTokens,
  type ComposedContext,
  type SemanticRanker,
  type SemanticSearchLike,
} from './context-composer';

// ============================================================================
// OPTIONS
// ============================================================================

/** Options for {@link ContextMcpTools}. */
export interface ContextMcpToolsOptions {
  /** The blackboard to compose/search over (required) */
  blackboard: IBlackboard;
  /**
   * Optional BYOE semantic memory. When provided, `blackboard_search` and
   * `context_pack` rank by embedding similarity; otherwise both fall back
   * to deterministic lexical scoring.
   */
  memory?: SemanticSearchLike;
  /** Optional pre-configured composer (default: `new ContextComposer()`) */
  composer?: ContextComposer;
  /** Default token budget for `context_pack` when the caller omits one (default 2000) */
  defaultBudgetTokens?: number;
  /** Hard ceiling on any requested budget (default 32000) */
  maxBudgetTokens?: number;
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

/** MCP tool definitions for the two context tools. */
export const CONTEXT_TOOL_DEFINITIONS: MCPToolDefinition[] = [
  {
    name: 'context_pack',
    description:
      'Assemble a token-budgeted, relevance-ranked context brief from the shared blackboard for a given task. ' +
      'Use this INSTEAD of blackboard_list + many blackboard_read calls: it returns only the entries most relevant ' +
      'to your task, ranked by semantic/lexical relevance, recency (half-life decay), and namespace affinity, ' +
      'assembled position-aware (strongest items first and last) under a hard token budget. ' +
      'Read-only — never modifies the blackboard. Returns {ok:true, text, used_tokens, budget_tokens, utilization, ' +
      'included:[{key,score,tokens}], excluded:[{key,reason}]}. The `text` field is ready to use as working context. ' +
      'Entries past their TTL are excluded automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The task or question driving relevance ranking (e.g. "diagnose the failing payment webhook")',
        },
        agent_id: {
          type: 'string',
          description: 'The agent requesting the pack (used for scoped access checks and audit)',
        },
        budget_tokens: {
          type: 'number',
          description: 'Hard token budget for the returned context text (default 2000)',
        },
        scope_tags: {
          type: 'string',
          description: 'Optional comma-separated scope tags for namespace affinity (e.g. "task,analytics")',
        },
        max_items: {
          type: 'number',
          description: 'Optional hard cap on the number of included entries (0 = unlimited)',
        },
      },
      required: ['task', 'agent_id'],
    },
  },
  {
    name: 'blackboard_search',
    description:
      'Search the shared blackboard for entries relevant to a query and return the top-K ranked matches. ' +
      'Use this instead of blackboard_list when you need *relevant* keys rather than *all* keys — it keeps noise ' +
      'out of your context window. Read-only. Ranks semantically when the server has an embedding provider wired, ' +
      'otherwise by deterministic lexical overlap (response includes which mode was used). ' +
      'Returns {ok:true, mode, results:[{key, score, snippet, sourceAgent}], count}. ' +
      'Follow up with blackboard_read for the full value of a specific key.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language search query (e.g. "budget decisions for Q3")',
        },
        agent_id: {
          type: 'string',
          description: 'The agent performing the search (used for scoped access checks)',
        },
        top_k: {
          type: 'number',
          description: 'Maximum number of results to return (default 5, max 50)',
        },
        min_score: {
          type: 'number',
          description: 'Minimum relevance score 0-1 (default 0)',
        },
      },
      required: ['query', 'agent_id'],
    },
  },
];

// ============================================================================
// CONTEXT MCP TOOLS
// ============================================================================

/**
 * `McpToolProvider` exposing `context_pack` and `blackboard_search`.
 * Register on a `McpCombinedBridge` alongside the other tool providers.
 */
export class ContextMcpTools {
  private readonly blackboard: IBlackboard;
  private readonly composer: ContextComposer;
  private readonly ranker: SemanticRanker | undefined;
  private readonly semantic: boolean;
  private readonly defaultBudgetTokens: number;
  private readonly maxBudgetTokens: number;

  constructor(options: ContextMcpToolsOptions) {
    if (!options || !options.blackboard) {
      throw new Error('ContextMcpTools: options.blackboard is required');
    }
    this.blackboard = options.blackboard;
    this.semantic = Boolean(options.memory);
    this.ranker = options.memory ? createSemanticMemoryRanker(options.memory) : undefined;
    this.composer = options.composer
      ?? new ContextComposer(this.ranker ? { ranker: this.ranker } : {});
    this.defaultBudgetTokens = options.defaultBudgetTokens ?? 2000;
    this.maxBudgetTokens = options.maxBudgetTokens ?? 32_000;
    if (this.defaultBudgetTokens <= 0 || this.maxBudgetTokens <= 0) {
      throw new Error('ContextMcpTools: token budgets must be > 0');
    }
  }

  /** Returns the MCP tool definitions provided by this module. */
  getDefinitions(): MCPToolDefinition[] {
    return CONTEXT_TOOL_DEFINITIONS;
  }

  /**
   * Dispatch a tool call by name. All errors are caught and returned as
   * `{ ok: false, error }`.
   */
  async call(toolName: string, args: Record<string, unknown>): Promise<BlackboardToolResult> {
    try {
      switch (toolName) {
        case 'context_pack':      return await this._pack(args);
        case 'blackboard_search': return await this._search(args);
        default:
          return { ok: false, tool: toolName, error: `Unknown tool: "${toolName}"` };
      }
    } catch (err) {
      return {
        ok: false,
        tool: toolName,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // --------------------------------------------------------------------------
  // Tool implementations
  // --------------------------------------------------------------------------

  private async _pack(args: Record<string, unknown>): Promise<BlackboardToolResult> {
    const task = this._requireString(args, 'task');
    const agentId = this._requireString(args, 'agent_id');
    const budget = this._clampNumber(args['budget_tokens'], this.defaultBudgetTokens, 1, this.maxBudgetTokens);
    const maxItems = this._clampNumber(args['max_items'], 0, 0, 10_000);
    const scopeTags = typeof args['scope_tags'] === 'string' && args['scope_tags'].trim() !== ''
      ? args['scope_tags'].split(',').map((t) => t.trim()).filter(Boolean)
      : undefined;

    const sources = ContextComposer.fromSnapshot(this._snapshot(agentId));
    const pack: ComposedContext = await this.composer.compose(sources, {
      task,
      budgetTokens: budget,
      ...(scopeTags ? { scopeTags } : {}),
      ...(maxItems > 0 ? { maxItems } : {}),
    });

    return {
      ok: true,
      tool: 'context_pack',
      data: {
        text: pack.text,
        used_tokens: pack.usedTokens,
        budget_tokens: pack.budgetTokens,
        utilization: Number(pack.utilization.toFixed(3)),
        mode: this.semantic ? 'semantic' : 'lexical',
        included: pack.included.map((i) => ({
          key: i.key,
          score: Number(i.score.toFixed(3)),
          tokens: i.tokens,
        })),
        excluded: pack.excluded.map((e) => ({
          key: e.key,
          reason: e.reason,
          ...(e.score !== undefined ? { score: Number(e.score.toFixed(3)) } : {}),
        })),
      },
    };
  }

  private async _search(args: Record<string, unknown>): Promise<BlackboardToolResult> {
    const query = this._requireString(args, 'query');
    const agentId = this._requireString(args, 'agent_id');
    const topK = this._clampNumber(args['top_k'], 5, 1, 50);
    const minScore = this._clampNumber(args['min_score'], 0, 0, 1);

    const sources = ContextComposer.fromSnapshot(this._snapshot(agentId));

    // Rank purely by relevance: reuse the composer with relevance-only
    // weights and an unbounded budget, then take the top-K.
    const ranked = await this.composer.compose(sources, {
      task: query,
      budgetTokens: this.maxBudgetTokens,
      weights: { relevance: 1, recency: 0, affinity: 0 },
      minScore: Math.max(minScore, 0.000_001), // drop zero-relevance items
      positionAware: false,
    });

    const results = ranked.included
      .slice(0, topK)
      .map((i) => ({
        key: i.key,
        score: Number(i.relevance.toFixed(3)),
        snippet: i.text.length > 240 ? `${i.text.slice(0, 240)}…` : i.text,
        ...(i.sourceAgent ? { sourceAgent: i.sourceAgent } : {}),
      }));

    return {
      ok: true,
      tool: 'blackboard_search',
      data: {
        mode: this.semantic ? 'semantic' : 'lexical',
        results,
        count: results.length,
        query_tokens: estimateTokens(query),
      },
    };
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private _snapshot(agentId: string): Record<string, unknown> {
    if (this.blackboard.getScopedSnapshot) {
      return this.blackboard.getScopedSnapshot(agentId);
    }
    return this.blackboard.getSnapshot();
  }

  private _requireString(args: Record<string, unknown>, field: string): string {
    const val = args[field];
    if (typeof val !== 'string' || val.trim() === '') {
      throw new Error(`Missing required field "${field}" (must be a non-empty string)`);
    }
    return val;
  }

  /** Accept number or numeric string; clamp into [min, max]; fall back to a default. */
  private _clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
    let n: number;
    if (typeof raw === 'number') n = raw;
    else if (typeof raw === 'string' && raw.trim() !== '') n = Number(raw);
    else return fallback;
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
  }
}
