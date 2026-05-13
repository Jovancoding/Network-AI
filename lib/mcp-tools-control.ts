/**
 * Control-Plane MCP Tools — Phase 6 Part 4
 *
 * Exposes orchestrator configuration and agent lifecycle operations as MCP
 * tools, giving an external AI agent full control-plane access to Network-AI.
 *
 * Tools exposed:
 *   config_get        — read current CONFIG values
 *   config_set        — update any CONFIG field at runtime
 *   agent_list        — list all currently registered agents and their status
 *   agent_spawn       — dispatch a task to a named agent
 *   agent_stop        — mark a running agent as stopped
 *   fsm_transition    — write an FSM state transition to the blackboard
 *   orchestrator_info — get orchestrator version, adapter count, blackboard stats
 *
 * @module mcp-tools-control
 * @version 1.0.0
 */

import type { MCPToolDefinition, BlackboardToolResult } from './mcp-blackboard-tools';
import type { McpToolProvider } from './mcp-transport-sse';

// ============================================================================
// DEPENDENCY INTERFACES
// ============================================================================

/** Minimal CONFIG surface needed by the control tools. */
export interface IConfig {
  maxParallelAgents: number;
  defaultTimeout: number;
  enableTracing: boolean;
  [key: string]: unknown;
}

/** Minimal agent registry entry. */
export interface IAgentStatus {
  agentId: string;
  status: string;
  lastSeen?: string;
  taskCount?: number;
  [key: string]: unknown;
}

/** Minimal blackboard surface needed for FSM transitions. */
export interface IControlBlackboard {
  write(key: string, value: unknown, sourceAgent: string, ttl?: number, agentToken?: string): unknown;
  read(key: string): { key: string; value: unknown } | null;
  getSnapshot(): Record<string, unknown>;
}

/** Options for `ControlMcpTools`. */
export interface ControlMcpToolsOptions {
  /** Live reference to the CONFIG object (mutated directly for config_set). */
  config: IConfig;
  /** Live reference to the agent registry map. */
  agentRegistry?: Map<string, IAgentStatus>;
  /** Reference to the primary blackboard (used for fsm_transition). */
  blackboard?: IControlBlackboard;
  /** System token for writing to the blackboard. */
  systemToken?: string;
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const CONTROL_TOOL_DEFINITIONS: MCPToolDefinition[] = [
  {
    name: 'config_get',
    description: 'Read one or all live orchestrator configuration values. Returns {ok:true, key, value} for a single key, or {ok:true, config:{...}} for all keys. Returns {ok:false, error:"Unknown config key: \\"...\\" Known keys: ..."} if the key is not recognised. Call without a key to discover available config names; use config_set to update values at runtime.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Specific config key to read. Omit to return all values.' },
      },
      required: [],
    },
  },
  {
    name: 'config_set',
    description: 'Update a live orchestrator configuration value at runtime. Returns {ok:true, key, value, previous} on success. Returns {ok:false, error:"Unknown config key..."} with a list of valid keys if the key is not recognised, or {ok:false, error:"..."} if value is not valid JSON. Call config_get first to see current values and available keys; changes take effect immediately for all subsequent operations.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Config key to update (e.g. "maxParallelAgents", "defaultTimeout", "enableTracing")' },
        value: { type: 'string', description: 'New value (JSON-encoded). E.g. "10" for a number, "true" for boolean, \'"string"\' for string.' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'agent_list',
    description: 'List all agents registered with the orchestrator and their current status. Returns {ok:true, agents:[{agentId, status, lastSeen, taskCount}], count}. Returns {ok:false, error:"..."} if the registry is unavailable. Use status_filter to narrow results (active, idle, stopped, error); call this before agent_spawn to confirm the target agent is registered and active, or before agent_stop to verify the agent is running.',
    inputSchema: {
      type: 'object',
      properties: {
        status_filter: { type: 'string', description: 'Filter by status (optional): active, idle, stopped, error' },
      },
      required: [],
    },
  },
  {
    name: 'agent_spawn',
    description: 'Write a task record to the blackboard to dispatch work to a named agent on its next poll cycle. Returns {ok:true, taskKey, agentId, instruction, written:true} on success. Returns {ok:false, error:"..."} if agent_id, task_key, or instruction is missing, or if payload_json is malformed. Call agent_list first to confirm the target agent is registered; verify the task was recorded with blackboard_read after spawning.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'ID of the agent to assign the task to (e.g. "code_writer", "data_analyst")' },
        task_key: { type: 'string', description: 'Blackboard key for the task (e.g. "task:write:auth_module")' },
        instruction: { type: 'string', description: 'Natural language instruction for the agent' },
        payload_json: { type: 'string', description: 'Optional JSON-encoded extra payload for the agent' },
        ttl: { type: 'string', description: 'Time-to-live for the task entry in seconds (default: 3600)' },
      },
      required: ['agent_id', 'task_key', 'instruction'],
    },
  },
  {
    name: 'agent_stop',
    description: 'Signal a running agent to stop by writing a stop record to the blackboard and marking it stopped in the registry. Returns {ok:true, agentId, reason, stopped:true}. Returns {ok:false, error:"..."} if agent_id is missing. The agent observes the stop signal on its next poll — it does not terminate immediately. Call agent_list first to confirm the agent is currently active.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'ID of the agent to stop' },
        reason: { type: 'string', description: 'Reason for stopping (optional, for audit)' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'fsm_transition',
    description: 'Advance a named FSM (Finite State Machine) to a new state and record the transition on the blackboard. Returns {ok:true, fsmId, transition:{from, to}, blackboardWritten:true} on success. Returns {ok:false, error:"..."} if fsm_id, new_state, or agent_id is missing, or if metadata_json is not valid JSON. Use after a workflow phase completes to activate the next state; call orchestrator_info first to confirm the current FSM state before transitioning.',
    inputSchema: {
      type: 'object',
      properties: {
        fsm_id: { type: 'string', description: 'FSM identifier (e.g. "order_pipeline", "code_review_workflow")' },
        new_state: { type: 'string', description: 'The state to transition to' },
        metadata_json: { type: 'string', description: 'Optional JSON metadata to attach to the transition' },
        agent_id: { type: 'string', description: 'Agent performing the transition (for audit)' },
      },
      required: ['fsm_id', 'new_state', 'agent_id'],
    },
  },
  {
    name: 'orchestrator_info',
    description: 'Return a full health snapshot of the orchestrator: version, config values, registered agent count, blackboard key count, and system uptime. Returns {ok:true, version, config:{...}, agentCount, blackboardKeyCount, uptime}. This tool always succeeds — it never returns {ok:false}. Use as the first call when connecting to confirm the server is healthy and to discover current config before calling config_get or agent_list.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// ============================================================================
// CONTROL MCP TOOLS
// ============================================================================

/**
 * MCP tool provider for orchestrator control-plane operations.
 *
 * @example
 * ```typescript
 * import { ControlMcpTools } from 'network-ai';
 *
 * const controlTools = new ControlMcpTools({
 *   config: CONFIG,              // live reference — mutations take effect immediately
 *   agentRegistry: agentMap,
 *   blackboard: orchestrator.getBlackboard(),
 *   systemToken: 'system-orchestrator-token',
 * });
 *
 * combined.register(controlTools);
 * ```
 */
export class ControlMcpTools implements McpToolProvider {
  private readonly _config: IConfig;
  private readonly _agentRegistry?: Map<string, IAgentStatus>;
  private readonly _blackboard?: IControlBlackboard;
  private readonly _systemToken: string;
  private readonly _stoppedAgents: Map<string, string> = new Map(); // agentId -> reason

  constructor(options: ControlMcpToolsOptions) {
    this._config = options.config;
    this._agentRegistry = options.agentRegistry;
    this._blackboard = options.blackboard;
    this._systemToken = options.systemToken ?? 'system-orchestrator-token';
  }

  getDefinitions(): MCPToolDefinition[] {
    return CONTROL_TOOL_DEFINITIONS;
  }

  async call(toolName: string, args: Record<string, unknown>): Promise<BlackboardToolResult> {
    try {
      switch (toolName) {
        case 'config_get':        return this._configGet(args);
        case 'config_set':        return this._configSet(args);
        case 'agent_list':        return this._agentList(args);
        case 'agent_spawn':       return this._agentSpawn(args);
        case 'agent_stop':        return this._agentStop(args);
        case 'fsm_transition':    return this._fsmTransition(args);
        case 'orchestrator_info': return this._orchestratorInfo();
        default:
          return { ok: false, tool: toolName, error: `Unknown control tool: "${toolName}"` };
      }
    } catch (err) {
      return { ok: false, tool: toolName, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // --------------------------------------------------------------------------
  // Config tools
  // --------------------------------------------------------------------------

  private _configGet(args: Record<string, unknown>): BlackboardToolResult {
    const key = args['key'] ? String(args['key']) : null;
    if (key) {
      if (!(key in this._config)) {
        return { ok: false, tool: 'config_get', error: `Unknown config key: "${key}". Known keys: ${Object.keys(this._config).join(', ')}` };
      }
      return { ok: true, tool: 'config_get', data: { [key]: this._config[key] } };
    }
    // Return entire config (exclude any function values)
    const snapshot: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this._config)) {
      if (typeof v !== 'function') snapshot[k] = v;
    }
    return { ok: true, tool: 'config_get', data: snapshot };
  }

  private _configSet(args: Record<string, unknown>): BlackboardToolResult {
    const key = String(args['key'] ?? '');
    const rawValue = String(args['value'] ?? '');

    if (!key) return { ok: false, tool: 'config_set', error: 'key is required' };
    if (!rawValue && rawValue !== '0') return { ok: false, tool: 'config_set', error: 'value is required' };

    // Defense-in-depth: only permit known, safe config keys
    const ALLOWED_KEYS: ReadonlySet<string> = new Set([
      'maxParallelAgents',
      'defaultTimeout',
      'enableTracing',
      'grantTokenTTL',
      'maxBlackboardValueSize',
    ]);
    if (!ALLOWED_KEYS.has(key)) {
      return {
        ok: false,
        tool: 'config_set',
        error: `Unknown or immutable config key: "${key}". Allowed keys: ${[...ALLOWED_KEYS].join(', ')}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawValue);
    } catch {
      // Treat as raw string if not valid JSON
      parsed = rawValue;
    }

    const previous = this._config[key];
    (this._config as Record<string, unknown>)[key] = parsed;

    return {
      ok: true,
      tool: 'config_set',
      data: { key, previous, current: parsed, applied: true },
    };
  }

  // --------------------------------------------------------------------------
  // Agent tools
  // --------------------------------------------------------------------------

  private _agentList(args: Record<string, unknown>): BlackboardToolResult {
    const statusFilter = args['status_filter'] ? String(args['status_filter']).toLowerCase() : null;

    const agents: IAgentStatus[] = [];

    if (this._agentRegistry) {
      for (const [id, status] of this._agentRegistry) {
        const entry: IAgentStatus = { ...status };
        entry.agentId = id; // map key takes precedence
        // Mark stopped agents
        if (this._stoppedAgents.has(id)) {
          entry.status = 'stopped';
          entry.stopReason = this._stoppedAgents.get(id);
        }
        if (!statusFilter || String(entry.status).toLowerCase() === statusFilter) {
          agents.push(entry);
        }
      }
    }

    // Also include stopped agents that may not be in the registry
    for (const [id, reason] of this._stoppedAgents) {
      if (!agents.find(a => a.agentId === id)) {
        const entry: IAgentStatus = { agentId: id, status: 'stopped', stopReason: reason };
        if (!statusFilter || statusFilter === 'stopped') {
          agents.push(entry);
        }
      }
    }

    return { ok: true, tool: 'agent_list', data: { agents, count: agents.length } };
  }

  private _agentSpawn(args: Record<string, unknown>): BlackboardToolResult {
    const agentId = String(args['agent_id'] ?? '');
    const taskKey = String(args['task_key'] ?? '');
    const instruction = String(args['instruction'] ?? '');
    const ttl = Number(args['ttl']) || 3600;

    if (!agentId) return { ok: false, tool: 'agent_spawn', error: 'agent_id is required' };
    if (!taskKey) return { ok: false, tool: 'agent_spawn', error: 'task_key is required' };
    if (!instruction) return { ok: false, tool: 'agent_spawn', error: 'instruction is required' };

    let extraPayload: unknown = undefined;
    if (args['payload_json']) {
      try {
        extraPayload = JSON.parse(String(args['payload_json']));
      } catch {
        return { ok: false, tool: 'agent_spawn', error: 'payload_json must be valid JSON' };
      }
    }

    const task = {
      agentId,
      instruction,
      payload: extraPayload,
      spawnedAt: new Date().toISOString(),
      spawnedBy: 'mcp-control',
      status: 'pending',
    };

    if (this._blackboard) {
      this._blackboard.write(taskKey, JSON.stringify(task), 'mcp-control', ttl, this._systemToken);
    }

    return {
      ok: true,
      tool: 'agent_spawn',
      data: {
        agentId,
        taskKey,
        task,
        blackboardWritten: !!this._blackboard,
        message: this._blackboard
          ? `Task written to blackboard at key "${taskKey}". Agent "${agentId}" will pick it up on next poll.`
          : `No blackboard configured — task object returned but NOT persisted. Configure blackboard in ControlMcpTools.`,
      },
    };
  }

  private _agentStop(args: Record<string, unknown>): BlackboardToolResult {
    const agentId = String(args['agent_id'] ?? '');
    const reason = String(args['reason'] ?? 'stopped via MCP control tool');

    if (!agentId) return { ok: false, tool: 'agent_stop', error: 'agent_id is required' };

    this._stoppedAgents.set(agentId, reason);

    const stopKey = `agent:stop:${agentId}`;
    if (this._blackboard) {
      this._blackboard.write(stopKey, JSON.stringify({ agentId, reason, stoppedAt: new Date().toISOString() }), 'mcp-control', 300, this._systemToken);
    }

    return {
      ok: true,
      tool: 'agent_stop',
      data: { agentId, reason, stopped: true, blackboardWritten: !!this._blackboard },
    };
  }

  // --------------------------------------------------------------------------
  // FSM tool
  // --------------------------------------------------------------------------

  private _fsmTransition(args: Record<string, unknown>): BlackboardToolResult {
    const fsmId = String(args['fsm_id'] ?? '');
    const newState = String(args['new_state'] ?? '');
    const agentId = String(args['agent_id'] ?? '');

    if (!fsmId) return { ok: false, tool: 'fsm_transition', error: 'fsm_id is required' };
    if (!newState) return { ok: false, tool: 'fsm_transition', error: 'new_state is required' };
    if (!agentId) return { ok: false, tool: 'fsm_transition', error: 'agent_id is required' };

    let metadata: unknown = undefined;
    if (args['metadata_json']) {
      try {
        metadata = JSON.parse(String(args['metadata_json']));
      } catch {
        return { ok: false, tool: 'fsm_transition', error: 'metadata_json must be valid JSON' };
      }
    }

    const stateKey = `fsm:${fsmId}:state`;
    const historyKey = `fsm:${fsmId}:history`;

    let previousState: unknown = null;
    if (this._blackboard) {
      previousState = this._blackboard.read(stateKey)?.value ?? null;
    }

    const transition = {
      from: previousState,
      to: newState,
      by: agentId,
      at: new Date().toISOString(),
      metadata,
    };

    if (this._blackboard) {
      this._blackboard.write(stateKey, newState, agentId, undefined, this._systemToken);
      // Append to history (read existing, push new entry)
      const existing = this._blackboard.read(historyKey);
      const history: unknown[] = existing ? (JSON.parse(String(existing.value)) as unknown[]) : [];
      history.push(transition);
      this._blackboard.write(historyKey, JSON.stringify(history), agentId, undefined, this._systemToken);
    }

    return {
      ok: true,
      tool: 'fsm_transition',
      data: { fsmId, transition, blackboardWritten: !!this._blackboard },
    };
  }

  // --------------------------------------------------------------------------
  // Info
  // --------------------------------------------------------------------------

  private _orchestratorInfo(): BlackboardToolResult {
    const snapshot: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this._config)) {
      if (typeof v !== 'function') snapshot[k] = v;
    }

    const bbSnapshot = this._blackboard?.getSnapshot() ?? {};

    return {
      ok: true,
      tool: 'orchestrator_info',
      data: {
        version: '4.0.3',
        config: snapshot,
        agents: {
          registered: this._agentRegistry?.size ?? 0,
          stopped: this._stoppedAgents.size,
        },
        blackboard: {
          keys: Object.keys(bbSnapshot).length,
          available: !!this._blackboard,
        },
        ts: new Date().toISOString(),
      },
    };
  }
}
