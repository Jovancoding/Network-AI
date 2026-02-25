/**
 * MCP Blackboard Bridge — Phase 5 Part 7: MCP Networking
 *
 * Exposes any `IBlackboard` (or `BlackboardMCPTools` instance) as a
 * JSON-RPC 2.0 Model Context Protocol endpoint, enabling cross-machine
 * agent communication with no external runtime dependencies.
 *
 * Architecture:
 *
 *   ┌─────────────────────────┐        ┌─────────────────────────┐
 *   │   McpBridgeClient       │        │   McpBlackboardBridge   │
 *   │  (remote agent side)    │        │   (server side)         │
 *   │                         │        │                         │
 *   │  listTools()            │──────► │  handleRPC()            │
 *   │  callTool(name, args)   │        │   ├─ tools/list         │
 *   │                         │◄────── │   └─ tools/call         │
 *   └─────────────────────────┘        │         │               │
 *           │                          │         ▼               │
 *   McpTransport interface             │   BlackboardMCPTools    │
 *   (in-process or future SSE/WS)      │   (read/write/list...)  │
 *                                      └─────────────────────────┘
 *
 * `McpInProcessTransport` wires a client directly to a bridge instance
 * (zero I/O, ideal for testing and single-machine multi-board setups).
 * Any transport that satisfies `McpTransport` can be substituted for
 * network delivery (SSE, WebSocket, stdio) without changing callers.
 *
 * `McpBridgeRouter` manages multiple named bridges (one per blackboard)
 * and routes calls to the correct bridge by board name.
 *
 * @example
 * ```typescript
 * import { McpBlackboardBridge, McpBridgeClient, McpInProcessTransport } from 'network-ai';
 *
 * // Server side
 * const bridge = new McpBlackboardBridge(myBlackboard);
 *
 * // Client side (in-process)
 * const client = new McpBridgeClient(new McpInProcessTransport(bridge));
 *
 * const tools  = await client.listTools();
 * const result = await client.callTool('blackboard_read', { key: 'status', agent_id: 'agent-1' });
 * ```
 *
 * @example Multi-board router
 * ```typescript
 * const router = new McpBridgeRouter();
 * router.register('prod',    new McpBlackboardBridge(prodBoard));
 * router.register('staging', new McpBlackboardBridge(stagingBoard));
 *
 * const prodClient = router.getClient('prod');
 * await prodClient.callTool('blackboard_write', { key: 'deploy', value: '"ok"', agent_id: 'ci' });
 * ```
 *
 * @module McpBridge
 * @version 1.0.0
 * @license MIT
 */

import {
  BlackboardMCPTools,
  type IBlackboard,
  type MCPToolDefinition,
  type BlackboardToolResult,
} from './mcp-blackboard-tools';

// ============================================================================
// JSON-RPC 2.0 TYPES
// ============================================================================

/** JSON-RPC 2.0 request object. */
export interface McpJsonRpcRequest {
  jsonrpc: '2.0';
  /** Request ID. `null` for notifications (no response expected). */
  id: string | number | null;
  /** MCP method name: `'tools/list'` or `'tools/call'`. */
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 error object embedded inside a response. */
export interface McpJsonRpcError {
  /** Standard JSON-RPC / MCP error code. */
  code: McpErrorCode;
  message: string;
  data?: unknown;
}

/** JSON-RPC 2.0 response object. Exactly one of `result` or `error` is set. */
export interface McpJsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: McpJsonRpcError;
}

/** Standard JSON-RPC 2.0 error codes used by the bridge. */
export const enum McpErrorCode {
  ParseError      = -32700,
  InvalidRequest  = -32600,
  MethodNotFound  = -32601,
  InvalidParams   = -32602,
  InternalError   = -32603,
}

// ============================================================================
// MCP METHOD RESULT SHAPES
// ============================================================================

/**
 * Result of a `tools/list` call.
 * The `tools` array matches the standard MCP tool-list response shape.
 */
export interface McpListToolsResult {
  tools: MCPToolDefinition[];
}

/**
 * A single content block inside a `tools/call` response.
 * Currently only `text` blocks are emitted.
 */
export interface McpContentBlock {
  type: 'text';
  /** JSON-serialized `BlackboardToolResult`. */
  text: string;
}

/**
 * Result of a `tools/call` call.
 * Follows the Model Context Protocol `CallToolResult` shape.
 */
export interface McpCallToolResult {
  /** One or more content blocks containing the tool output. */
  content: McpContentBlock[];
  /**
   * `true` when the underlying tool returned `ok: false` or threw.
   * This allows MCP clients to detect errors without parsing `content`.
   */
  isError: boolean;
}

// ============================================================================
// TRANSPORT INTERFACE
// ============================================================================

/**
 * Minimal transport abstraction used by `McpBridgeClient`.
 *
 * Implement this interface to add network transports (SSE, WebSocket, stdio)
 * without changing any client code.  `McpInProcessTransport` is the built-in
 * zero-I/O implementation.
 */
export interface McpTransport {
  /**
   * Send a JSON-RPC request and return the corresponding response.
   * Implementations must preserve the `id` field on the response so
   * the client can correlate concurrent calls.
   */
  send(request: McpJsonRpcRequest): Promise<McpJsonRpcResponse>;
}

// ============================================================================
// MCP BLACKBOARD BRIDGE (SERVER SIDE)
// ============================================================================

/**
 * Construction options for `McpBlackboardBridge`.
 */
export interface McpBlackboardBridgeOptions {
  /**
   * Human-readable name for this bridge, used in error messages and router keys.
   * Defaults to `'blackboard'`.
   */
  name?: string;
}

/**
 * MCP server bridge that exposes a blackboard via JSON-RPC 2.0.
 *
 * Wraps a `BlackboardMCPTools` instance and handles:
 *   - `tools/list`  → returns all five tool definitions
 *   - `tools/call`  → dispatches to the appropriate tool handler
 *
 * The bridge is transport-agnostic: pass a `McpJsonRpcRequest` to
 * `handleRPC()` and receive a `McpJsonRpcResponse`.
 */
export class McpBlackboardBridge {
  private readonly _tools: BlackboardMCPTools;
  readonly name: string;

  /**
   * @param blackboard  Any object satisfying `IBlackboard`, or a
   *                    pre-built `BlackboardMCPTools` instance.
   * @param options     Optional configuration.
   */
  constructor(
    blackboard: IBlackboard | BlackboardMCPTools,
    options: McpBlackboardBridgeOptions = {}
  ) {
    this._tools =
      blackboard instanceof BlackboardMCPTools
        ? blackboard
        : new BlackboardMCPTools(blackboard);
    this.name = options.name ?? 'blackboard';
  }

  // --------------------------------------------------------------------------
  // JSON-RPC 2.0 ENTRY POINT
  // --------------------------------------------------------------------------

  /**
   * Handle a single JSON-RPC 2.0 request and return the matching response.
   * Never rejects — errors are encoded as `{ error: { code, message } }`.
   */
  async handleRPC(request: McpJsonRpcRequest): Promise<McpJsonRpcResponse> {
    if (!request || request.jsonrpc !== '2.0') {
      return this._error(null, McpErrorCode.InvalidRequest, 'Invalid JSON-RPC 2.0 request');
    }

    const { id, method } = request;

    try {
      switch (method) {
        case 'tools/list':
          return this._ok(id, await this._handleListTools());
        case 'tools/call':
          return this._ok(id, await this._handleCallTool(request.params));
        default:
          return this._error(id, McpErrorCode.MethodNotFound, `Method not found: "${method}"`);
      }
    } catch (err) {
      return this._error(
        id,
        McpErrorCode.InternalError,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // --------------------------------------------------------------------------
  // CONVENIENCE — direct access without JSON-RPC wrapping
  // --------------------------------------------------------------------------

  /** Returns all tool definitions exposed by this bridge. */
  listTools(): MCPToolDefinition[] {
    return this._tools.getDefinitions();
  }

  /**
   * Call a specific tool directly (bypasses JSON-RPC framing).
   * Useful when the bridge and caller share the same process.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<BlackboardToolResult> {
    return this._tools.call(name, args);
  }

  // --------------------------------------------------------------------------
  // PRIVATE — method handlers
  // --------------------------------------------------------------------------

  private async _handleListTools(): Promise<McpListToolsResult> {
    return { tools: this._tools.getDefinitions() };
  }

  private async _handleCallTool(params: unknown): Promise<McpCallToolResult> {
    if (!params || typeof params !== 'object') {
      throw Object.assign(
        new Error('tools/call requires params object with "name" and "arguments"'),
        { code: McpErrorCode.InvalidParams }
      );
    }

    const p = params as Record<string, unknown>;
    const toolName = p['name'];
    const toolArgs = p['arguments'] ?? {};

    if (typeof toolName !== 'string' || !toolName) {
      throw Object.assign(
        new Error('tools/call: "name" must be a non-empty string'),
        { code: McpErrorCode.InvalidParams }
      );
    }
    if (typeof toolArgs !== 'object' || toolArgs === null || Array.isArray(toolArgs)) {
      throw Object.assign(
        new Error('tools/call: "arguments" must be an object'),
        { code: McpErrorCode.InvalidParams }
      );
    }

    const result = await this._tools.call(toolName, toolArgs as Record<string, unknown>);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: !result.ok,
    };
  }

  // --------------------------------------------------------------------------
  // PRIVATE — response helpers
  // --------------------------------------------------------------------------

  private _ok(id: string | number | null, result: unknown): McpJsonRpcResponse {
    return { jsonrpc: '2.0', id, result };
  }

  private _error(
    id: string | number | null,
    code: McpErrorCode,
    message: string,
    data?: unknown
  ): McpJsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    };
  }
}

// ============================================================================
// IN-PROCESS TRANSPORT
// ============================================================================

/**
 * Zero-I/O transport that routes calls directly to a `McpBlackboardBridge`.
 *
 * Use this when the client and server share the same process — no
 * serialization, no network, instant responses. Ideal for:
 *   - Unit and integration tests
 *   - Single-machine multi-board setups
 *   - Development and debugging
 *
 * Replace with a network transport (SSE, WebSocket, stdio pipe) when you
 * need cross-machine communication.
 */
export class McpInProcessTransport implements McpTransport {
  private _idCounter = 0;

  constructor(private readonly bridge: McpBlackboardBridge) {}

  async send(request: McpJsonRpcRequest): Promise<McpJsonRpcResponse> {
    return this.bridge.handleRPC(request);
  }

  /**
   * Generate a unique numeric request ID suitable for `McpJsonRpcRequest.id`.
   * Useful when callers don't need to track IDs manually.
   */
  nextId(): number {
    return ++this._idCounter;
  }
}

// ============================================================================
// MCP BRIDGE CLIENT
// ============================================================================

/**
 * Client that communicates with a `McpBlackboardBridge` via any `McpTransport`.
 *
 * Provides high-level methods (`listTools`, `callTool`) so callers never
 * have to construct raw JSON-RPC requests.
 */
export class McpBridgeClient {
  private _idCounter = 0;

  constructor(private readonly transport: McpTransport) {}

  // --------------------------------------------------------------------------
  // HIGH-LEVEL API
  // --------------------------------------------------------------------------

  /**
   * List all tools exposed by the connected bridge.
   *
   * @returns Array of `MCPToolDefinition` objects.
   * @throws  If the transport returns an RPC error.
   */
  async listTools(): Promise<MCPToolDefinition[]> {
    const response = await this._send('tools/list', undefined);
    const result = response.result as McpListToolsResult;
    return result.tools;
  }

  /**
   * Call a named tool on the connected bridge.
   *
   * @param name  Tool name (e.g. `'blackboard_read'`).
   * @param args  Tool arguments matching the tool's `inputSchema`.
   * @returns     Parsed `BlackboardToolResult` from the content block.
   * @throws      If the transport returns a JSON-RPC protocol error.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<BlackboardToolResult> {
    const response = await this._send('tools/call', { name, arguments: args });
    const callResult = response.result as McpCallToolResult;
    const text = callResult.content[0]?.text ?? '{}';
    return JSON.parse(text) as BlackboardToolResult;
  }

  /**
   * Send a raw JSON-RPC request and return the response.
   * The `id` is auto-assigned if not provided.
   *
   * @throws If the server returns a JSON-RPC error response.
   */
  async sendRaw(method: string, params?: unknown): Promise<McpJsonRpcResponse> {
    return this._send(method, params);
  }

  // --------------------------------------------------------------------------
  // PRIVATE
  // --------------------------------------------------------------------------

  private async _send(method: string, params: unknown): Promise<McpJsonRpcResponse> {
    const id = ++this._idCounter;
    const request: McpJsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    const response = await this.transport.send(request);

    if (response.error) {
      const { code, message, data } = response.error;
      const err = new Error(`MCP error ${code}: ${message}`);
      Object.assign(err, { code, data });
      throw err;
    }

    return response;
  }
}

// ============================================================================
// MCP BRIDGE ROUTER
// ============================================================================

/**
 * Routes MCP calls across multiple named `McpBlackboardBridge` instances
 * (one per blackboard).
 *
 * Agents address a specific blackboard by name:
 * ```typescript
 * const client = router.getClient('prod');
 * await client.callTool('blackboard_write', { ... });
 * ```
 *
 * The router also supports direct RPC routing without creating a client:
 * ```typescript
 * await router.route('prod', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
 * ```
 */
export class McpBridgeRouter {
  private _bridges: Map<string, McpBlackboardBridge> = new Map();

  /**
   * Register a bridge under `name`.
   * @throws If `name` is already registered.
   */
  register(name: string, bridge: McpBlackboardBridge): void {
    if (typeof name !== 'string' || !name) {
      throw new TypeError('McpBridgeRouter.register: name must be a non-empty string');
    }
    if (this._bridges.has(name)) {
      throw new Error(`McpBridgeRouter: bridge "${name}" is already registered`);
    }
    this._bridges.set(name, bridge);
  }

  /**
   * Unregister a bridge by name. No-op if not found.
   * @returns `true` if a bridge was removed, `false` otherwise.
   */
  unregister(name: string): boolean {
    return this._bridges.delete(name);
  }

  /**
   * Returns `true` if a bridge with `name` is registered.
   */
  has(name: string): boolean {
    return this._bridges.has(name);
  }

  /**
   * List all registered bridge names.
   */
  listBridges(): string[] {
    return Array.from(this._bridges.keys());
  }

  /**
   * Get the `McpBlackboardBridge` registered under `name`.
   * @throws If `name` is not registered.
   */
  getBridge(name: string): McpBlackboardBridge {
    const bridge = this._bridges.get(name);
    if (!bridge) {
      throw new Error(`McpBridgeRouter: no bridge registered for "${name}"`);
    }
    return bridge;
  }

  /**
   * Route a raw JSON-RPC request to the bridge named `boardName`.
   * @throws If `boardName` is not registered.
   */
  async route(boardName: string, request: McpJsonRpcRequest): Promise<McpJsonRpcResponse> {
    return this.getBridge(boardName).handleRPC(request);
  }

  /**
   * Get a `McpBridgeClient` backed by an in-process transport to the bridge
   * registered under `boardName`.
   *
   * @throws If `boardName` is not registered.
   */
  getClient(boardName: string): McpBridgeClient {
    const bridge = this.getBridge(boardName);
    return new McpBridgeClient(new McpInProcessTransport(bridge));
  }
}
