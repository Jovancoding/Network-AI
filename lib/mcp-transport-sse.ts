/**
 * MCP SSE/HTTP Transport — Phase 6 Part 1
 *
 * Makes the MCP bridge network-accessible over HTTP + Server-Sent Events so
 * any MCP-compatible AI (Claude Desktop, Cursor, Cline, etc.) can connect
 * to Network-AI from outside the process.
 *
 * Architecture:
 *
 *   External AI agent
 *       │  POST /mcp          (JSON-RPC 2.0 request)
 *       ▼
 *   McpSseServer (HTTP, port 3001)
 *       │  handleRPC()
 *       ▼
 *   McpCombinedBridge
 *       ├── blackboard tools  (read/write/list/delete/exists)
 *       ├── extended tools    (budget/token/audit)
 *       └── control tools     (config/agent/fsm)
 *
 *   External AI agent
 *       │  GET /sse           (SSE connection — server pushes events)
 *       ▼
 *   McpSseServer broadcasts events to all connected clients
 *
 * Zero external dependencies — uses Node.js built-in `node:http` only.
 *
 * @module mcp-transport-sse
 * @version 1.0.0
 */

import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import type {
  McpTransport,
  McpJsonRpcRequest,
  McpJsonRpcResponse,
} from './mcp-bridge';
import {
  McpErrorCode,
  McpBlackboardBridge,
} from './mcp-bridge';
import type { MCPToolDefinition, BlackboardToolResult } from './mcp-blackboard-tools';

// ============================================================================
// TOOL PROVIDER INTERFACE
// ============================================================================

/**
 * Any object that provides MCP tools can implement this interface and be
 * registered with `McpCombinedBridge`.
 */
export interface McpToolProvider {
  getDefinitions(): MCPToolDefinition[];
  call(toolName: string, args: Record<string, unknown>): Promise<BlackboardToolResult>;
}

// ============================================================================
// COMBINED BRIDGE — aggregates multiple tool providers
// ============================================================================

/**
 * Aggregates multiple `McpToolProvider` instances into a single MCP bridge.
 *
 * Handles `tools/list` by merging all definitions, and routes `tools/call`
 * to the first provider that owns the requested tool name.
 *
 * @example
 * ```typescript
 * const combined = new McpCombinedBridge('network-ai');
 * combined.register(new McpBlackboardBridgeAdapter(myBridge));
 * combined.register(new ExtendedMcpTools({ budget }));
 * combined.register(new ControlMcpTools({ config, orchestrator }));
 *
 * const server = new McpSseServer(combined, { port: 3001 });
 * await server.listen();
 * ```
 */
export class McpCombinedBridge {
  readonly name: string;
  private readonly _providers: McpToolProvider[] = [];
  private readonly _toolIndex: Map<string, McpToolProvider> = new Map();

  constructor(name = 'network-ai') {
    this.name = name;
  }

  /**
   * Register a tool provider. Tools names must be globally unique across all
   * registered providers — duplicate names are silently overwritten with the
   * latest registration.
   */
  register(provider: McpToolProvider): void {
    this._providers.push(provider);
    for (const def of provider.getDefinitions()) {
      this._toolIndex.set(def.name, provider);
    }
  }

  /** All tool definitions across every registered provider. */
  allDefinitions(): MCPToolDefinition[] {
    return this._providers.flatMap(p => p.getDefinitions());
  }

  /**
   * Handle a single JSON-RPC 2.0 request. Never rejects — errors are encoded
   * in the response `error` field.
   */
  async handleRPC(request: McpJsonRpcRequest): Promise<McpJsonRpcResponse> {
    if (!request || request.jsonrpc !== '2.0') {
      return this._error(null, McpErrorCode.InvalidRequest, 'Invalid JSON-RPC 2.0 request');
    }

    const { id, method } = request;

    try {
      switch (method) {
        // MCP handshake — required before any tool calls
        case 'initialize':
          return this._ok(id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: this.name ?? 'network-ai', version: '4.0.10' },
          });

        // Client signals it's ready — notification (no response needed, but
        // some clients send it as a request with an id)
        case 'notifications/initialized':
          return this._ok(id, {});

        // Return empty lists so clients don't abort on missing methods
        case 'resources/list':
          return this._ok(id, { resources: [] });

        case 'prompts/list':
          return this._ok(id, { prompts: [] });

        case 'tools/list':
          return this._ok(id, { tools: this.allDefinitions() });

        case 'tools/call': {
          const params = request.params as Record<string, unknown> | undefined;
          if (!params || typeof params !== 'object') {
            return this._error(id, McpErrorCode.InvalidParams, 'tools/call requires params object');
          }
          const toolName = params['name'];
          const toolArgs = (params['arguments'] ?? {}) as Record<string, unknown>;
          if (typeof toolName !== 'string' || !toolName) {
            return this._error(id, McpErrorCode.InvalidParams, 'tools/call: "name" must be a non-empty string');
          }
          const provider = this._toolIndex.get(toolName);
          if (!provider) {
            return this._error(id, McpErrorCode.MethodNotFound, `Unknown tool: "${toolName}"`);
          }
          const result = await provider.call(toolName, toolArgs);
          return this._ok(id, {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            isError: !result.ok,
          });
        }

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

  private _ok(id: string | number | null, result: unknown): McpJsonRpcResponse {
    return { jsonrpc: '2.0', id, result };
  }

  private _error(
    id: string | number | null,
    code: McpErrorCode,
    message: string
  ): McpJsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}

// ============================================================================
// BRIDGE ADAPTER — wraps McpBlackboardBridge as a McpToolProvider
// ============================================================================

/**
 * Wraps an existing `McpBlackboardBridge` as a `McpToolProvider` so it can be
 * registered with `McpCombinedBridge` alongside extended and control tools.
 */
export class McpBlackboardBridgeAdapter implements McpToolProvider {
  constructor(private readonly bridge: McpBlackboardBridge) {}

  getDefinitions(): MCPToolDefinition[] {
    return this.bridge.listTools();
  }

  async call(toolName: string, args: Record<string, unknown>): Promise<BlackboardToolResult> {
    return this.bridge.callTool(toolName, args);
  }
}

// ============================================================================
// SSE SERVER
// ============================================================================

/** Options for `McpSseServer`. */
export interface McpSseServerOptions {
  /** TCP port to listen on. Defaults to `3001`. */
  port?: number;
  /** Hostname to bind to. Defaults to `'0.0.0.0'` (all interfaces). */
  host?: string;
  /** Heartbeat interval in ms. Defaults to `15000`. Set to `0` to disable. */
  heartbeatMs?: number;
}

/**
 * HTTP server that exposes a `McpCombinedBridge` (or any object with
 * `handleRPC`) over two endpoints:
 *
 * - `GET  /sse`    — Server-Sent Events stream; sends initial `endpoint` event
 * - `POST /mcp`    — Receive JSON-RPC 2.0 requests, return responses
 * - `GET  /health` — Health check returning `{ status: 'ok', bridge, clients }`
 * - `GET  /tools`  — List all available tools as JSON
 *
 * No external packages required — built on Node.js `node:http`.
 */
export class McpSseServer {
  private readonly _bridge: { handleRPC(req: McpJsonRpcRequest): Promise<McpJsonRpcResponse>; name?: string; allDefinitions?: () => MCPToolDefinition[] };
  private readonly _opts: Required<McpSseServerOptions>;
  private _server!: http.Server;
  private readonly _sseClients: Set<http.ServerResponse> = new Set();

  constructor(
    bridge: { handleRPC(req: McpJsonRpcRequest): Promise<McpJsonRpcResponse>; name?: string; allDefinitions?: () => MCPToolDefinition[] },
    options: McpSseServerOptions = {}
  ) {
    this._bridge = bridge;
    this._opts = {
      port: options.port ?? 3001,
      host: options.host ?? '0.0.0.0',
      heartbeatMs: options.heartbeatMs ?? 15000,
    };
  }

  /** Start listening. Resolves when the server is ready. */
  listen(): Promise<void> {
    this._server = http.createServer((req, res) => this._handleRequest(req, res));
    return new Promise(resolve => {
      this._server.listen(this._opts.port, this._opts.host, () => resolve());
    });
  }

  /** Stop the server and close all SSE streams. */
  close(): Promise<void> {
    for (const client of this._sseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    this._sseClients.clear();
    return new Promise((resolve, reject) => {
      this._server.close(err => (err ? reject(err) : resolve()));
    });
  }

  /** Current TCP port (useful when port was auto-assigned). */
  get port(): number { return this._opts.port; }

  /** Number of currently connected SSE clients. */
  get clientCount(): number { return this._sseClients.size; }

  /**
   * Broadcast an event to every connected SSE client.
   * Useful for pushing agent status updates, budget alerts, etc.
   */
  broadcast(eventName: string, data: unknown): void {
    const msg = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this._sseClients) {
      try { client.write(msg); } catch { /* client disconnected */ }
    }
  }

  // --------------------------------------------------------------------------
  // REQUEST ROUTING
  // --------------------------------------------------------------------------

  private _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // CORS — allow any MCP client to connect
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const base = `http://${req.headers.host ?? `localhost:${this._opts.port}`}`;
    let parsed: URL;
    try {
      parsed = new URL(req.url ?? '/', base);
    } catch {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }

    const path = parsed.pathname;

    // CORS — allow Cursor / Claude Desktop / browser clients
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && (path === '/sse' || path === '/')) {
      this._handleSse(req, res);
    } else if (req.method === 'POST' && (path === '/mcp' || path === '/')) {
      this._handlePost(req, res);
    } else if (req.method === 'GET' && path === '/health') {
      this._handleHealth(res);
    } else if (req.method === 'GET' && path === '/tools') {
      this._handleTools(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', endpoints: ['/', '/sse', '/mcp', '/health', '/tools'] }));
    }
  }

  private _handleSse(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    });

    // MCP SSE protocol: send endpoint URL so client knows where to POST
    res.write(`event: endpoint\ndata: /mcp\n\n`);

    this._sseClients.add(res);

    // Heartbeat keeps the connection alive through proxies/load balancers
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    if (this._opts.heartbeatMs > 0) {
      heartbeat = setInterval(() => {
        try { res.write(': heartbeat\n\n'); } catch { /* closed */ }
      }, this._opts.heartbeatMs);
    }

    req.on('close', () => {
      if (heartbeat) clearInterval(heartbeat);
      this._sseClients.delete(res);
    });
  }

  private _handlePost(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    const MAX_BODY = 4 * 1024 * 1024; // 4 MB
    let bodySize = 0;

    req.on('data', (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const rpc = JSON.parse(body) as McpJsonRpcRequest;
        const response = await this._bridge.handleRPC(rpc);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));

        // Optionally broadcast the call as an event to SSE clients
        if (this._sseClients.size > 0 && rpc.method === 'tools/call') {
          this.broadcast('tool_called', { method: rpc.method, params: rpc.params, ts: Date.now() });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: McpErrorCode.ParseError, message: `Parse error: ${errMsg}` },
        }));
      }
    });

    req.on('error', () => {
      try {
        res.writeHead(500);
        res.end();
      } catch { /* already sent */ }
    });
  }

  private _handleHealth(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      bridge: this._bridge.name ?? 'network-ai',
      clients: this._sseClients.size,
      ts: new Date().toISOString(),
    }));
  }

  private _handleTools(res: http.ServerResponse): void {
    const defs = this._bridge.allDefinitions?.() ?? [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tools: defs, count: defs.length }));
  }
}

// ============================================================================
// SSE TRANSPORT (CLIENT SIDE)
// ============================================================================

/**
 * `McpTransport` implementation that sends JSON-RPC requests to a remote
 * `McpSseServer` via HTTP POST.
 *
 * Use this when the MCP client and server are in different processes or
 * machines. Pairs with `McpBridgeClient` as a drop-in replacement for
 * `McpInProcessTransport`.
 *
 * @example
 * ```typescript
 * import { McpBridgeClient } from 'network-ai';
 * import { McpSseTransport } from 'network-ai';
 *
 * const transport = new McpSseTransport('http://localhost:3001');
 * const client = new McpBridgeClient(transport);
 *
 * const tools = await client.listTools();
 * const result = await client.callTool('blackboard_read', { key: 'status', agent_id: 'my-agent' });
 * ```
 */
export class McpSseTransport implements McpTransport {
  private readonly _postUrl: string;
  private _idCounter = 0;

  /**
   * @param baseUrl  Base URL of the `McpSseServer`, e.g. `'http://localhost:3001'`.
   *                 The transport will POST to `<baseUrl>/mcp`.
   */
  constructor(baseUrl: string) {
    // Strip trailing slashes without regex to avoid ReDoS on adversarial input.
    let clean = baseUrl;
    while (clean.endsWith('/')) clean = clean.slice(0, -1);
    this._postUrl = clean.endsWith('/mcp') ? clean : `${clean}/mcp`;
  }

  /** Send a JSON-RPC request and wait for the response. */
  async send(request: McpJsonRpcRequest): Promise<McpJsonRpcResponse> {
    const body = JSON.stringify(request);
    const parsed = new URL(this._postUrl);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    return new Promise((resolve, reject) => {
      const options: http.RequestOptions = {
        hostname: parsed.hostname,
        port: parseInt(parsed.port || (isHttps ? '443' : '80'), 10),
        path: parsed.pathname + (parsed.search || ''),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = lib.request(options, resp => {
        let data = '';
        resp.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        resp.on('end', () => {
          try {
            resolve(JSON.parse(data) as McpJsonRpcResponse);
          } catch {
            reject(new Error(`McpSseTransport: invalid JSON from server: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(30000, () => {
        req.destroy(new Error('McpSseTransport: request timed out after 30s'));
      });
      req.write(body);
      req.end();
    });
  }

  /** Generate a unique request ID. */
  nextId(): number {
    return ++this._idCounter;
  }
}
