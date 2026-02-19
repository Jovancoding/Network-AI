/**
 * MCP Blackboard Tool Bindings — Phase 4: Behavioral Control Plane
 *
 * Exposes the shared blackboard as MCP-compatible tool definitions so any
 * LLM agent can interact with shared state via standard tool calls.
 *
 * Tools exposed:
 *   - blackboard_read    — read a single entry by key
 *   - blackboard_write   — write a value to the blackboard
 *   - blackboard_list    — list all keys (optionally filtered by prefix)
 *   - blackboard_delete  — delete an entry by key
 *   - blackboard_exists  — check whether a key is present and not expired
 *
 * @module mcp-blackboard-tools
 */

// ============================================================================
// TYPES (MCP-compatible, no external dependency required)
// ============================================================================

/** JSON Schema subset sufficient for MCP tool descriptors. */
export interface MCPJsonSchema {
  type: 'object';
  properties: Record<string, { type: string; description?: string; enum?: string[] }>;
  required?: string[];
}

/** MCP tool definition (matches Model Context Protocol spec). */
export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: MCPJsonSchema;
}

/** Normalised result returned by every blackboard tool call. */
export interface BlackboardToolResult {
  ok: boolean;
  tool: string;
  data?: unknown;
  error?: string;
}

/** Minimal interface required by the tool bindings. */
export interface IBlackboard {
  read(key: string): { key: string; value: unknown; sourceAgent: string; timestamp: string; ttl: number | null } | null;
  write(key: string, value: unknown, sourceAgent: string, ttl?: number, agentToken?: string): { key: string; value: unknown; sourceAgent: string; timestamp: string; ttl: number | null };
  exists(key: string): boolean;
  getSnapshot(): Record<string, { key: string; value: unknown; sourceAgent: string; timestamp: string; ttl: number | null }>;
  delete?: (key: string) => void;
  getScopedSnapshot?: (agentId: string) => Record<string, unknown>;
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

/** MCP tool definitions for all five blackboard operations. */
export const BLACKBOARD_TOOL_DEFINITIONS: MCPToolDefinition[] = [
  {
    name: 'blackboard_read',
    description: 'Read a single entry from the shared blackboard by key. Returns the value, source agent, and timestamp, or null if not found.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'The blackboard key to read (e.g. "task:analysis:q3")',
        },
        agent_id: {
          type: 'string',
          description: 'The agent performing the read (used for scoped access checks)',
        },
      },
      required: ['key', 'agent_id'],
    },
  },
  {
    name: 'blackboard_write',
    description: 'Write a value to the shared blackboard. Requires agent identity verification. Returns the written entry.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'The key to write (e.g. "task:result:q3")',
        },
        value: {
          type: 'string',
          description: 'JSON-encoded value to store',
        },
        agent_id: {
          type: 'string',
          description: 'The agent performing the write',
        },
        agent_token: {
          type: 'string',
          description: 'Optional verification token for authenticated writes',
        },
        ttl: {
          type: 'string',
          description: 'Optional TTL in seconds (e.g. "3600" for 1 hour)',
        },
      },
      required: ['key', 'value', 'agent_id'],
    },
  },
  {
    name: 'blackboard_list',
    description: 'List all keys currently on the blackboard. Optionally filter by key prefix.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'The agent requesting the list (used for scoped access)',
        },
        prefix: {
          type: 'string',
          description: 'Optional key prefix filter (e.g. "task:" to list only task entries)',
        },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'blackboard_delete',
    description: 'Delete an entry from the blackboard by key. Agent must have write access to the key.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'The key to delete',
        },
        agent_id: {
          type: 'string',
          description: 'The agent requesting deletion',
        },
        agent_token: {
          type: 'string',
          description: 'Optional verification token',
        },
      },
      required: ['key', 'agent_id'],
    },
  },
  {
    name: 'blackboard_exists',
    description: 'Check whether a key exists on the blackboard (and has not expired).',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'The key to check',
        },
        agent_id: {
          type: 'string',
          description: 'The agent performing the check',
        },
      },
      required: ['key', 'agent_id'],
    },
  },
];

// ============================================================================
// BLACKBOARD MCP TOOLS
// ============================================================================

/**
 * MCP-compatible tool handler wrapping a {@link IBlackboard} instance.
 *
 * Register it with any MCP adapter to expose shared blackboard operations
 * as callable tools for LLM agents.
 *
 * @example
 * ```typescript
 * import { BlackboardMCPTools } from 'network-ai';
 *
 * const tools = new BlackboardMCPTools(orchestrator.blackboard);
 *
 * // Register with the MCP adapter
 * for (const def of tools.getDefinitions()) {
 *   mcpAdapter.registerTool(def.name, (args) => tools.call(def.name, args), def);
 * }
 *
 * // Or call directly for testing
 * const result = await tools.call('blackboard_read', {
 *   key: 'task:q3_analysis',
 *   agent_id: 'data_analyst',
 * });
 * ```
 */
export class BlackboardMCPTools {
  constructor(private readonly blackboard: IBlackboard) {}

  /** Returns all MCP tool definitions for this blackboard instance. */
  getDefinitions(): MCPToolDefinition[] {
    return BLACKBOARD_TOOL_DEFINITIONS;
  }

  /**
   * Dispatch a tool call by name. `args` should match the tool's inputSchema.
   * All errors are caught and returned as `{ ok: false, error }`.
   */
  async call(toolName: string, args: Record<string, unknown>): Promise<BlackboardToolResult> {
    try {
      switch (toolName) {
        case 'blackboard_read':   return this._read(args);
        case 'blackboard_write':  return this._write(args);
        case 'blackboard_list':   return this._list(args);
        case 'blackboard_delete': return this._delete(args);
        case 'blackboard_exists': return this._exists(args);
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

  private _read(args: Record<string, unknown>): BlackboardToolResult {
    const key     = this._requireString(args, 'key');
    const agentId = this._requireString(args, 'agent_id');

    // Use scoped snapshot if available for access control
    if (this.blackboard.getScopedSnapshot) {
      const scoped = this.blackboard.getScopedSnapshot(agentId);
      const entry = (scoped as Record<string, unknown>)[key] ?? null;
      return { ok: true, tool: 'blackboard_read', data: entry };
    }

    const entry = this.blackboard.read(key);
    return { ok: true, tool: 'blackboard_read', data: entry };
  }

  private _write(args: Record<string, unknown>): BlackboardToolResult {
    const key        = this._requireString(args, 'key');
    const rawValue   = this._requireString(args, 'value');
    const agentId    = this._requireString(args, 'agent_id');
    const agentToken = typeof args['agent_token'] === 'string' ? args['agent_token'] : undefined;
    const ttlRaw     = typeof args['ttl'] === 'string' ? parseInt(args['ttl'], 10) : undefined;
    const ttl        = (ttlRaw !== undefined && !isNaN(ttlRaw)) ? ttlRaw : undefined;

    // Parse value: try JSON first, fall back to raw string
    let value: unknown;
    try {
      value = JSON.parse(rawValue);
    } catch {
      value = rawValue;
    }

    const entry = this.blackboard.write(key, value, agentId, ttl, agentToken);
    return { ok: true, tool: 'blackboard_write', data: entry };
  }

  private _list(args: Record<string, unknown>): BlackboardToolResult {
    const agentId = this._requireString(args, 'agent_id');
    const prefix  = typeof args['prefix'] === 'string' ? args['prefix'] : '';

    let snapshot: Record<string, unknown>;
    if (this.blackboard.getScopedSnapshot) {
      snapshot = this.blackboard.getScopedSnapshot(agentId);
    } else {
      snapshot = this.blackboard.getSnapshot();
    }

    let keys = Object.keys(snapshot);
    if (prefix) keys = keys.filter(k => k.startsWith(prefix));

    return {
      ok: true,
      tool: 'blackboard_list',
      data: {
        keys,
        count: keys.length,
        entries: Object.fromEntries(keys.map(k => [k, snapshot[k]])),
      },
    };
  }

  private _delete(args: Record<string, unknown>): BlackboardToolResult {
    const key = this._requireString(args, 'key');

    if (!this.blackboard.delete) {
      return { ok: false, tool: 'blackboard_delete', error: 'Delete operation not supported by this blackboard instance' };
    }

    const existed = this.blackboard.exists(key);
    if (!existed) {
      return { ok: false, tool: 'blackboard_delete', error: `Key "${key}" not found` };
    }

    this.blackboard.delete(key);
    return { ok: true, tool: 'blackboard_delete', data: { deleted: key } };
  }

  private _exists(args: Record<string, unknown>): BlackboardToolResult {
    const key = this._requireString(args, 'key');
    const exists = this.blackboard.exists(key);
    return { ok: true, tool: 'blackboard_exists', data: { key, exists } };
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private _requireString(args: Record<string, unknown>, field: string): string {
    const val = args[field];
    if (typeof val !== 'string' || val.trim() === '') {
      throw new Error(`Missing required field "${field}" (must be a non-empty string)`);
    }
    return val;
  }
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Convenience factory: create a `BlackboardMCPTools` instance and register
 * all tools on an MCPAdapter in one call.
 *
 * @example
 * ```typescript
 * import { registerBlackboardTools } from 'network-ai';
 *
 * registerBlackboardTools(mcpAdapter, orchestrator.getBlackboard());
 * ```
 */
export function registerBlackboardTools(
  mcpAdapter: {
    registerTool(
      name: string,
      handler: (args: Record<string, unknown>) => Promise<unknown>,
      metadata?: { description?: string; inputSchema?: Record<string, unknown> }
    ): void;
  },
  blackboard: IBlackboard
): BlackboardMCPTools {
  const tools = new BlackboardMCPTools(blackboard);
  for (const def of tools.getDefinitions()) {
    mcpAdapter.registerTool(
      def.name,
      (args) => tools.call(def.name, args),
      { description: def.description, inputSchema: def.inputSchema as unknown as Record<string, unknown> }
    );
  }
  return tools;
}
