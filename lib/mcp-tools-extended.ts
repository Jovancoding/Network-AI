/**
 * Extended MCP Tools — Phase 6 Part 2
 *
 * Exposes budget, token, and audit operations as MCP-compatible tools so
 * an external AI agent can manage Network-AI's security and resource planes
 * without any code changes.
 *
 * Tool groups:
 *   Budget  — budget_status, budget_spend, budget_reset, budget_set_ceiling, budget_get_log
 *   Token   — token_validate, token_revoke, token_create
 *   Audit   — audit_query, audit_tail
 *
 * @module mcp-tools-extended
 * @version 1.0.0
 */

import { readFileSync, existsSync } from 'node:fs';
import type { MCPToolDefinition, BlackboardToolResult } from './mcp-blackboard-tools';
import type { McpToolProvider } from './mcp-transport-sse';

// ============================================================================
// DEPENDENCY INTERFACES (loose coupling — no hard imports of runtime classes)
// ============================================================================

/** Minimal FederatedBudget surface needed by the tools. */
export interface IBudget {
  spend(agentId: string, tokens: number): { allowed: boolean; remaining: number; deniedReason?: string };
  remaining(): number;
  getTotalSpent(): number;
  getCeiling(): number;
  getSpendLog(): Record<string, number>;
  getTransactionLog(): Array<{ agentId: string; tokens: number; timestamp: string }>;
  setCeiling(ceiling: number): void;
  reset(): void;
}

/** Minimal SecureTokenManager surface needed by the tools. */
export interface ITokenManager {
  generateToken(agentId: string, resourceType: string, scope: string): {
    tokenId: string;
    agentId: string;
    resourceType: string;
    scope: string;
    issuedAt: number;
    expiresAt: number;
    signature: string;
  };
  validateToken(token: {
    tokenId: string;
    agentId: string;
    resourceType: string;
    scope: string;
    issuedAt: number;
    expiresAt: number;
    signature: string;
  }): { valid: boolean; reason?: string };
  revokeToken(tokenId: string): void;
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const EXTENDED_TOOL_DEFINITIONS: MCPToolDefinition[] = [
  // ---- Budget ---------------------------------------------------------------
  {
    name: 'budget_status',
    description: 'Get the current budget status: ceiling, total spent, remaining tokens, and per-agent breakdown.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Calling agent identifier (for audit)' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'budget_spend',
    description: 'Spend tokens on behalf of an agent. Returns allowed/denied with remaining balance.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'The agent spending tokens' },
        tokens: { type: 'string', description: 'Number of tokens to spend (positive integer)' },
      },
      required: ['agent_id', 'tokens'],
    },
  },
  {
    name: 'budget_reset',
    description: 'Reset all spend counters to zero. The ceiling is preserved. Use when starting a new task cycle.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Calling agent identifier (for audit)' },
        confirm: { type: 'string', description: 'Must be "yes" to prevent accidental resets' },
      },
      required: ['agent_id', 'confirm'],
    },
  },
  {
    name: 'budget_set_ceiling',
    description: 'Dynamically change the global token ceiling. Can be raised or lowered at runtime.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Calling agent identifier (for audit)' },
        ceiling: { type: 'string', description: 'New ceiling value (positive number)' },
      },
      required: ['agent_id', 'ceiling'],
    },
  },
  {
    name: 'budget_get_log',
    description: 'Retrieve the full transaction log of all spend() calls in chronological order.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Calling agent identifier' },
        limit: { type: 'string', description: 'Maximum number of entries to return (default: 50)' },
      },
      required: ['agent_id'],
    },
  },
  // ---- Token ----------------------------------------------------------------
  {
    name: 'token_create',
    description: 'Generate a new signed security token for an agent. Returns the full token object.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent to issue the token to' },
        resource_type: { type: 'string', description: 'Resource type the token grants access to (e.g. "FILE_SYSTEM")' },
        scope: { type: 'string', description: 'Permission scope (e.g. "read", "write", "admin")' },
      },
      required: ['agent_id', 'resource_type', 'scope'],
    },
  },
  {
    name: 'token_validate',
    description: 'Validate a security token — checks signature, expiration, and revocation status.',
    inputSchema: {
      type: 'object',
      properties: {
        token_json: {
          type: 'string',
          description: 'JSON-encoded SecureToken object (as returned by token_create)',
        },
      },
      required: ['token_json'],
    },
  },
  {
    name: 'token_revoke',
    description: 'Revoke a token by its tokenId. The token will be rejected on all future validation attempts.',
    inputSchema: {
      type: 'object',
      properties: {
        token_id: { type: 'string', description: 'The tokenId to revoke' },
        reason: { type: 'string', description: 'Optional reason for revocation (for audit)' },
      },
      required: ['token_id'],
    },
  },
  // ---- Audit ----------------------------------------------------------------
  {
    name: 'audit_query',
    description: 'Query the audit log. Filter by agent_id, event_type, outcome, or time range.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id_filter: { type: 'string', description: 'Filter entries by this agent ID (optional)' },
        event_type_filter: { type: 'string', description: 'Filter by event type (optional)' },
        outcome_filter: { type: 'string', description: 'Filter by outcome: success, failure, denied (optional)' },
        since_iso: { type: 'string', description: 'ISO 8601 timestamp — return entries at or after this time (optional)' },
        limit: { type: 'string', description: 'Maximum number of entries to return (default: 100)' },
      },
      required: [],
    },
  },
  {
    name: 'audit_tail',
    description: 'Return the N most recent audit log entries. Fast — reads from end of file.',
    inputSchema: {
      type: 'object',
      properties: {
        n: { type: 'string', description: 'Number of recent entries to return (default: 20, max: 500)' },
      },
      required: [],
    },
  },
];

// ============================================================================
// EXTENDED MCP TOOLS
// ============================================================================

/** Options for `ExtendedMcpTools`. All dependencies are optional. */
export interface ExtendedMcpToolsOptions {
  /** FederatedBudget instance. Budget tools are disabled if not provided. */
  budget?: IBudget;
  /** SecureTokenManager instance. Token tools are disabled if not provided. */
  tokenManager?: ITokenManager;
  /** Absolute path to the audit log JSONL file. Defaults to `./data/audit_log.jsonl`. */
  auditLogPath?: string;
}

/**
 * MCP tool provider for budget, token, and audit operations.
 *
 * All three categories are optional — only provide the services you need.
 * Tools for missing services return a clear `{ ok: false, error }` response.
 *
 * @example
 * ```typescript
 * import { FederatedBudget, SecureTokenManager } from 'network-ai';
 * import { ExtendedMcpTools } from 'network-ai';
 *
 * const tools = new ExtendedMcpTools({
 *   budget: new FederatedBudget({ ceiling: 100_000 }),
 *   tokenManager: new SecureTokenManager(),
 *   auditLogPath: './data/audit_log.jsonl',
 * });
 *
 * // Register with McpCombinedBridge
 * combined.register(tools);
 * ```
 */
export class ExtendedMcpTools implements McpToolProvider {
  private readonly _budget?: IBudget;
  private readonly _tokenManager?: ITokenManager;
  private readonly _auditLogPath: string;

  constructor(options: ExtendedMcpToolsOptions = {}) {
    this._budget = options.budget;
    this._tokenManager = options.tokenManager;
    this._auditLogPath = options.auditLogPath ?? './data/audit_log.jsonl';
  }

  getDefinitions(): MCPToolDefinition[] {
    return EXTENDED_TOOL_DEFINITIONS;
  }

  async call(toolName: string, args: Record<string, unknown>): Promise<BlackboardToolResult> {
    try {
      switch (toolName) {
        case 'budget_status':      return this._budgetStatus();
        case 'budget_spend':       return this._budgetSpend(args);
        case 'budget_reset':       return this._budgetReset(args);
        case 'budget_set_ceiling': return this._budgetSetCeiling(args);
        case 'budget_get_log':     return this._budgetGetLog(args);
        case 'token_create':       return this._tokenCreate(args);
        case 'token_validate':     return this._tokenValidate(args);
        case 'token_revoke':       return this._tokenRevoke(args);
        case 'audit_query':        return this._auditQuery(args);
        case 'audit_tail':         return this._auditTail(args);
        default:
          return { ok: false, tool: toolName, error: `Unknown extended tool: "${toolName}"` };
      }
    } catch (err) {
      return { ok: false, tool: toolName, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // --------------------------------------------------------------------------
  // Budget tools
  // --------------------------------------------------------------------------

  private _budgetStatus(): BlackboardToolResult {
    if (!this._budget) return this._noBudget('budget_status');
    return {
      ok: true,
      tool: 'budget_status',
      data: {
        ceiling: this._budget.getCeiling(),
        totalSpent: this._budget.getTotalSpent(),
        remaining: this._budget.remaining(),
        perAgent: this._budget.getSpendLog(),
      },
    };
  }

  private _budgetSpend(args: Record<string, unknown>): BlackboardToolResult {
    if (!this._budget) return this._noBudget('budget_spend');
    const agentId = String(args['agent_id'] ?? '');
    const tokens = Number(args['tokens']);
    if (!agentId) return { ok: false, tool: 'budget_spend', error: 'agent_id is required' };
    if (!Number.isFinite(tokens) || tokens <= 0) return { ok: false, tool: 'budget_spend', error: 'tokens must be a positive number' };
    const result = this._budget.spend(agentId, tokens);
    return { ok: true, tool: 'budget_spend', data: result };
  }

  private _budgetReset(args: Record<string, unknown>): BlackboardToolResult {
    if (!this._budget) return this._noBudget('budget_reset');
    if (String(args['confirm']).toLowerCase() !== 'yes') {
      return { ok: false, tool: 'budget_reset', error: 'confirm must be "yes" to reset the budget' };
    }
    this._budget.reset();
    return { ok: true, tool: 'budget_reset', data: { reset: true, remaining: this._budget.remaining() } };
  }

  private _budgetSetCeiling(args: Record<string, unknown>): BlackboardToolResult {
    if (!this._budget) return this._noBudget('budget_set_ceiling');
    const ceiling = Number(args['ceiling']);
    if (!Number.isFinite(ceiling) || ceiling <= 0) {
      return { ok: false, tool: 'budget_set_ceiling', error: 'ceiling must be a positive number' };
    }
    this._budget.setCeiling(ceiling);
    return { ok: true, tool: 'budget_set_ceiling', data: { ceiling, remaining: this._budget.remaining() } };
  }

  private _budgetGetLog(args: Record<string, unknown>): BlackboardToolResult {
    if (!this._budget) return this._noBudget('budget_get_log');
    const limit = Math.min(Number(args['limit']) || 50, 1000);
    const log = this._budget.getTransactionLog();
    const entries = log.slice(-limit);
    return { ok: true, tool: 'budget_get_log', data: { entries, total: log.length, shown: entries.length } };
  }

  private _noBudget(tool: string): BlackboardToolResult {
    return { ok: false, tool, error: 'No FederatedBudget instance configured. Pass budget: new FederatedBudget(...) to ExtendedMcpTools.' };
  }

  // --------------------------------------------------------------------------
  // Token tools
  // --------------------------------------------------------------------------

  private _tokenCreate(args: Record<string, unknown>): BlackboardToolResult {
    if (!this._tokenManager) return this._noTokenManager('token_create');
    const agentId = String(args['agent_id'] ?? '');
    const resourceType = String(args['resource_type'] ?? '');
    const scope = String(args['scope'] ?? '');
    if (!agentId || !resourceType || !scope) {
      return { ok: false, tool: 'token_create', error: 'agent_id, resource_type, and scope are required' };
    }
    const token = this._tokenManager.generateToken(agentId, resourceType, scope);
    return { ok: true, tool: 'token_create', data: token };
  }

  private _tokenValidate(args: Record<string, unknown>): BlackboardToolResult {
    if (!this._tokenManager) return this._noTokenManager('token_validate');
    const tokenJson = String(args['token_json'] ?? '');
    if (!tokenJson) return { ok: false, tool: 'token_validate', error: 'token_json is required' };
    try {
      const token = JSON.parse(tokenJson);
      const result = this._tokenManager.validateToken(token);
      return { ok: true, tool: 'token_validate', data: result };
    } catch (e) {
      return { ok: false, tool: 'token_validate', error: `Invalid token JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private _tokenRevoke(args: Record<string, unknown>): BlackboardToolResult {
    if (!this._tokenManager) return this._noTokenManager('token_revoke');
    const tokenId = String(args['token_id'] ?? '');
    if (!tokenId) return { ok: false, tool: 'token_revoke', error: 'token_id is required' };
    this._tokenManager.revokeToken(tokenId);
    return { ok: true, tool: 'token_revoke', data: { tokenId, revoked: true, reason: args['reason'] ?? 'revoked via MCP' } };
  }

  private _noTokenManager(tool: string): BlackboardToolResult {
    return { ok: false, tool, error: 'No SecureTokenManager instance configured. Pass tokenManager: new SecureTokenManager() to ExtendedMcpTools.' };
  }

  // --------------------------------------------------------------------------
  // Audit tools
  // --------------------------------------------------------------------------

  private _auditQuery(args: Record<string, unknown>): BlackboardToolResult {
    const entries = this._readAuditLog();
    if (!entries.ok) return { ok: false, tool: 'audit_query', error: entries.error };

    let results = entries.data as AuditEntry[];
    const agentFilter = args['agent_id_filter'] ? String(args['agent_id_filter']) : null;
    const eventFilter = args['event_type_filter'] ? String(args['event_type_filter']) : null;
    const outcomeFilter = args['outcome_filter'] ? String(args['outcome_filter']) : null;
    const sinceIso = args['since_iso'] ? String(args['since_iso']) : null;
    const limit = Math.min(Number(args['limit']) || 100, 1000);

    if (agentFilter) results = results.filter(e => e.agentId === agentFilter);
    if (eventFilter) results = results.filter(e => e.eventType === eventFilter);
    if (outcomeFilter) results = results.filter(e => e.outcome === outcomeFilter);
    if (sinceIso) {
      const since = new Date(sinceIso).getTime();
      if (!isNaN(since)) {
        results = results.filter(e => new Date(e.timestamp).getTime() >= since);
      }
    }

    const sliced = results.slice(-limit);
    return { ok: true, tool: 'audit_query', data: { entries: sliced, total: results.length, shown: sliced.length } };
  }

  private _auditTail(args: Record<string, unknown>): BlackboardToolResult {
    const n = Math.min(Math.max(Number(args['n']) || 20, 1), 500);
    const entries = this._readAuditLog();
    if (!entries.ok) return { ok: false, tool: 'audit_tail', error: entries.error };
    const all = entries.data as AuditEntry[];
    const tail = all.slice(-n);
    return { ok: true, tool: 'audit_tail', data: { entries: tail, total: all.length, shown: tail.length } };
  }

  private _readAuditLog(): { ok: true; data: AuditEntry[] } | { ok: false; error: string } {
    try {
      if (!existsSync(this._auditLogPath)) {
        return { ok: true, data: [] };
      }
      const raw = readFileSync(this._auditLogPath, 'utf-8').trim();
      if (!raw) return { ok: true, data: [] };
      const entries = raw.split('\n')
        .filter(l => l.trim())
        .map(l => {
          try { return JSON.parse(l) as AuditEntry; } catch { return null; }
        })
        .filter((e): e is AuditEntry => e !== null);
      return { ok: true, data: entries };
    } catch (err) {
      return { ok: false, error: `Failed to read audit log: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}

/** Minimal shape of an audit log entry (matches SecureAuditLogger output). */
interface AuditEntry {
  timestamp: string;
  eventId: string;
  eventType: string;
  agentId: string;
  action: string;
  resource?: string;
  outcome: string;
  details: Record<string, unknown>;
  signature?: string;
}
