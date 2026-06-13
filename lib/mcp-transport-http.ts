/**
 * MCP Streamable HTTP Transport — 2025 MCP Spec
 *
 * Implements the MCP 2025-03-26 Streamable HTTP transport, which replaces
 * the older SSE-only transport with a single bidirectional endpoint that
 * supports both JSON responses and SSE streams from the same POST handler.
 *
 * Also adds full `resources/*` and `prompts/*` capability support through
 * the `McpResourceProvider` and `McpPromptProvider` interfaces.
 *
 * Architecture:
 *
 *   POST /mcp   — single endpoint for all JSON-RPC 2.0 traffic
 *                 • If Accept contains text/event-stream → SSE stream response
 *                 • Otherwise → immediate JSON response
 *   GET  /mcp   — optional SSE upgrade for server-initiated messages
 *   GET  /health — health check
 *   GET  /tools  — tool listing
 *
 * Zero external dependencies — uses Node.js `node:http` only.
 *
 * @module mcp-transport-http
 * @version 1.0.0
 */

import type * as http from 'node:http';
import type { McpJsonRpcRequest, McpJsonRpcResponse } from './mcp-bridge';
import { McpErrorCode } from './mcp-bridge';
import type { MCPToolDefinition, BlackboardToolResult } from './mcp-blackboard-tools';
import type { McpToolProvider } from './mcp-transport-sse';
import { McpCombinedBridge } from './mcp-transport-sse';

// Lazy-load http to avoid pulling in node:http unless this transport is used
let _http: typeof import('node:http') | undefined;
function requireHttp(): typeof import('node:http') {
  if (!_http) _http = require('node:http') as typeof import('node:http');
  return _http;
}

// ============================================================================
// RESOURCE PROVIDER INTERFACE
// ============================================================================

/**
 * An MCP resource — a named piece of content the server exposes to clients.
 * Resources map to `resources/list` and `resources/read` in the MCP 2025 spec.
 */
export interface McpResource {
  /** Unique URI identifying this resource, e.g. `"network-ai://blackboard/main"`. */
  uri: string;
  /** Human-readable name. */
  name: string;
  /** Optional MIME type. Defaults to `"text/plain"`. */
  mimeType?: string;
  /** Optional description shown in client UIs. */
  description?: string;
}

/** Result returned from `McpResourceProvider.read()`. */
export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  /** Text content (use this OR `blob`, not both). */
  text?: string;
  /** Base64-encoded binary content. */
  blob?: string;
}

/**
 * Register an `McpResourceProvider` with `McpStreamableServer` to expose
 * resources to MCP clients via `resources/list` and `resources/read`.
 */
export interface McpResourceProvider {
  /** Return all resources this provider exposes. */
  listResources(): McpResource[];
  /**
   * Return the content for a given URI.
   * Return `null` if the URI is not handled by this provider.
   */
  readResource(uri: string): Promise<McpResourceContent | null>;
}

// ============================================================================
// PROMPT PROVIDER INTERFACE
// ============================================================================

/** An argument a prompt accepts. */
export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

/** An MCP prompt — a reusable message template. */
export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

/** A single message in a prompt response. */
export interface McpPromptMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}

/** Result returned from `McpPromptProvider.getPrompt()`. */
export interface McpPromptResult {
  description?: string;
  messages: McpPromptMessage[];
}

/**
 * Register an `McpPromptProvider` with `McpStreamableServer` to expose
 * reusable prompt templates via `prompts/list` and `prompts/get`.
 */
export interface McpPromptProvider {
  listPrompts(): McpPrompt[];
  /**
   * Return rendered prompt messages for the given name and arguments.
   * Return `null` if the prompt name is not handled by this provider.
   */
  getPrompt(name: string, args: Record<string, string>): Promise<McpPromptResult | null>;
}

// ============================================================================
// STREAMABLE HTTP SERVER OPTIONS
// ============================================================================

/** Options for `McpStreamableServer`. */
export interface McpStreamableServerOptions {
  /** TCP port. Defaults to `3002`. */
  port?: number;
  /**
   * Hostname. Defaults to `'127.0.0.1'`.
   * Set to `'0.0.0.0'` only with a non-empty `secret`.
   */
  host?: string;
  /**
   * Bearer secret for authentication. Required — server rejects all requests
   * when empty (fail-closed, CWE-306/CWE-862).
   */
  secret?: string;
  /** SSE heartbeat interval in ms. Defaults to `15000`. Set to `0` to disable. */
  heartbeatMs?: number;
}

// ============================================================================
// STREAMABLE HTTP SERVER
// ============================================================================

/**
 * MCP Streamable HTTP server implementing the 2025-03-26 MCP spec.
 *
 * Endpoints:
 * - `POST /mcp`   — all JSON-RPC traffic; SSE-streamed if client sends
 *                   `Accept: text/event-stream`
 * - `GET  /mcp`   — server-initiated SSE stream (server push)
 * - `GET  /health` — health check
 * - `GET  /tools`  — tool listing JSON
 *
 * Register tool, resource, and prompt providers via the constructor or
 * `registerResource()` / `registerPrompt()`.
 *
 * @example
 * ```typescript
 * import { McpStreamableServer } from 'network-ai';
 *
 * const bridge = new McpCombinedBridge('network-ai');
 * bridge.register(new McpBlackboardBridgeAdapter(myBridge));
 *
 * const server = new McpStreamableServer(bridge, {
 *   port: 3002,
 *   secret: process.env['NETWORK_AI_MCP_SECRET']!,
 * });
 *
 * server.registerResource(new BlackboardResourceProvider(myBridge));
 * server.registerPrompt(new OrchestrationPromptProvider());
 *
 * await server.listen();
 * ```
 */
export class McpStreamableServer {
  private readonly _bridge: McpCombinedBridge;
  private readonly _opts: Required<McpStreamableServerOptions>;
  private readonly _resourceProviders: McpResourceProvider[] = [];
  private readonly _promptProviders: McpPromptProvider[] = [];
  private _server!: http.Server;
  private readonly _sseClients: Set<http.ServerResponse> = new Set();

  constructor(bridge: McpCombinedBridge, options: McpStreamableServerOptions = {}) {
    this._bridge = bridge;
    this._opts = {
      port: options.port ?? 3002,
      host: options.host ?? '127.0.0.1',
      secret: options.secret ?? '',
      heartbeatMs: options.heartbeatMs ?? 15000,
    };
  }

  /** Register an `McpResourceProvider`. */
  registerResource(provider: McpResourceProvider): void {
    this._resourceProviders.push(provider);
  }

  /** Register an `McpPromptProvider`. */
  registerPrompt(provider: McpPromptProvider): void {
    this._promptProviders.push(provider);
  }

  /** Start listening. Resolves when ready. */
  listen(): Promise<void> {
    if (!this._opts.secret) {
      return Promise.reject(new Error(
        'McpStreamableServer requires a non-empty secret. ' +
        'Set McpStreamableServerOptions.secret or NETWORK_AI_MCP_SECRET.'
      ));
    }

    const isLoopback =
      this._opts.host === '127.0.0.1' ||
      this._opts.host === 'localhost' ||
      this._opts.host === '::1';

    if (!isLoopback) {
      process.stderr.write(
        `[network-ai] WARNING: McpStreamableServer binding to ${this._opts.host} ` +
        '(non-loopback). Ensure your perimeter restricts access to this port.\n'
      );
    }

    this._server = requireHttp().createServer((req, res) => this._handleRequest(req, res));
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

  get port(): number { return this._opts.port; }
  get clientCount(): number { return this._sseClients.size; }

  /** Broadcast an event to all connected SSE clients. */
  broadcast(eventName: string, data: unknown): void {
    const msg = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this._sseClients) {
      try { client.write(msg); } catch { /* disconnected */ }
    }
  }

  // --------------------------------------------------------------------------
  // AUTH
  // --------------------------------------------------------------------------

  private _isAuthorized(req: http.IncomingMessage): boolean {
    if (!this._opts.secret) return false;
    const authHeader = req.headers['authorization'];
    if (typeof authHeader !== 'string') return false;
    const parts = authHeader.split(' ');
    return parts[0]?.toLowerCase() === 'bearer' && parts[1] === this._opts.secret;
  }

  private _unauthorized(res: http.ServerResponse): void {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer realm="network-ai"',
    });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
  }

  // --------------------------------------------------------------------------
  // ROUTING
  // --------------------------------------------------------------------------

  private _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const base = `http://${req.headers.host ?? `localhost:${this._opts.port}`}`;
    let parsed: URL;
    try { parsed = new URL(req.url ?? '/', base); }
    catch {
      res.writeHead(400); res.end('Bad request'); return;
    }

    const origin = req.headers['origin'] ?? '';
    const isLocalOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    if (isLocalOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const path = parsed.pathname;

    if (req.method === 'POST' && (path === '/mcp' || path === '/')) {
      if (!this._isAuthorized(req)) { this._unauthorized(res); return; }
      this._handlePost(req, res);
    } else if (req.method === 'GET' && (path === '/mcp' || path === '/')) {
      if (!this._isAuthorized(req)) { this._unauthorized(res); return; }
      this._handleSseUpgrade(req, res);
    } else if (req.method === 'GET' && path === '/health') {
      this._handleHealth(res);
    } else if (req.method === 'GET' && path === '/tools') {
      this._handleTools(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', endpoints: ['/mcp', '/health', '/tools'] }));
    }
  }

  // --------------------------------------------------------------------------
  // POST /mcp — main JSON-RPC handler (Streamable HTTP)
  // --------------------------------------------------------------------------

  private _handlePost(req: http.IncomingMessage, res: http.ServerResponse): void {
    const acceptsSse =
      (req.headers['accept'] ?? '').includes('text/event-stream');

    let body = '';
    const MAX_BODY = 4 * 1024 * 1024;
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

        if (acceptsSse) {
          // Streamable HTTP: respond with SSE stream so the server can push
          // multiple messages (e.g. progress, then final result)
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          const response = await this._dispatch(rpc);
          res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
          res.end();
        } else {
          const response = await this._dispatch(rpc);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const errResp: McpJsonRpcResponse = {
          jsonrpc: '2.0',
          id: null,
          error: { code: McpErrorCode.ParseError, message: `Parse error: ${msg}` },
        };
        if (!res.headersSent) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify(errResp));
      }
    });

    req.on('error', () => {
      try { if (!res.headersSent) { res.writeHead(500); } res.end(); }
      catch { /* already sent */ }
    });
  }

  // --------------------------------------------------------------------------
  // GET /mcp — server-initiated SSE upgrade
  // --------------------------------------------------------------------------

  private _handleSseUpgrade(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    res.write(`event: endpoint\ndata: /mcp\n\n`);
    this._sseClients.add(res);

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

  // --------------------------------------------------------------------------
  // DISPATCH — routes JSON-RPC method including resources/* and prompts/*
  // --------------------------------------------------------------------------

  private async _dispatch(rpc: McpJsonRpcRequest): Promise<McpJsonRpcResponse> {
    if (!rpc || rpc.jsonrpc !== '2.0') {
      return this._error(null, McpErrorCode.InvalidRequest, 'Invalid JSON-RPC 2.0 request');
    }

    const { id, method } = rpc;

    try {
      switch (method) {
        case 'initialize':
          return this._ok(id, {
            protocolVersion: '2025-03-26',
            capabilities: {
              tools: {},
              resources: { subscribe: false, listChanged: false },
              prompts: { listChanged: false },
            },
            serverInfo: { name: this._bridge.name ?? 'network-ai', version: '1.0.0' },
          });

        case 'notifications/initialized':
          return this._ok(id, {});

        // ── tools ────────────────────────────────────────────────────────────
        case 'tools/list':
          return this._ok(id, { tools: this._bridge.allDefinitions() });

        case 'tools/call': {
          const p = rpc.params as Record<string, unknown> | undefined;
          if (!p || typeof p !== 'object') {
            return this._error(id, McpErrorCode.InvalidParams, 'tools/call requires params');
          }
          const toolName = p['name'];
          const toolArgs = (p['arguments'] ?? {}) as Record<string, unknown>;
          if (typeof toolName !== 'string' || !toolName) {
            return this._error(id, McpErrorCode.InvalidParams, 'tools/call: "name" required');
          }
          // Route through the combined bridge
          const bridgeResp = await this._bridge.handleRPC({
            jsonrpc: '2.0', id, method: 'tools/call',
            params: { name: toolName, arguments: toolArgs },
          });
          return bridgeResp;
        }

        // ── resources ────────────────────────────────────────────────────────
        case 'resources/list': {
          const resources = this._resourceProviders.flatMap(p => p.listResources());
          return this._ok(id, { resources });
        }

        case 'resources/read': {
          const p = rpc.params as Record<string, unknown> | undefined;
          const uri = p?.['uri'];
          if (typeof uri !== 'string') {
            return this._error(id, McpErrorCode.InvalidParams, 'resources/read: "uri" required');
          }
          for (const provider of this._resourceProviders) {
            const content = await provider.readResource(uri);
            if (content !== null) {
              return this._ok(id, { contents: [content] });
            }
          }
          return this._error(id, McpErrorCode.InvalidParams, `Resource not found: ${uri}`);
        }

        // ── prompts ──────────────────────────────────────────────────────────
        case 'prompts/list': {
          const prompts = this._promptProviders.flatMap(p => p.listPrompts());
          return this._ok(id, { prompts });
        }

        case 'prompts/get': {
          const p = rpc.params as Record<string, unknown> | undefined;
          const name = p?.['name'];
          const args = (p?.['arguments'] ?? {}) as Record<string, string>;
          if (typeof name !== 'string') {
            return this._error(id, McpErrorCode.InvalidParams, 'prompts/get: "name" required');
          }
          for (const provider of this._promptProviders) {
            const result = await provider.getPrompt(name, args);
            if (result !== null) {
              return this._ok(id, result);
            }
          }
          return this._error(id, McpErrorCode.InvalidParams, `Prompt not found: ${name}`);
        }

        default:
          // Fall through to combined bridge for any unknown methods
          return this._bridge.handleRPC(rpc);
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
  // HELPERS
  // --------------------------------------------------------------------------

  private _handleHealth(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      bridge: this._bridge.name ?? 'network-ai',
      clients: this._sseClients.size,
      protocolVersion: '2025-03-26',
      capabilities: ['tools', 'resources', 'prompts'],
      ts: new Date().toISOString(),
    }));
  }

  private _handleTools(res: http.ServerResponse): void {
    const defs = this._bridge.allDefinitions();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tools: defs, count: defs.length }));
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
// BUILT-IN RESOURCE PROVIDER — Blackboard
// ============================================================================

/**
 * Built-in `McpResourceProvider` that exposes blackboard entries as
 * `network-ai://blackboard/<key>` URIs.
 *
 * Register with `McpStreamableServer.registerResource()`.
 */
export class BlackboardResourceProvider implements McpResourceProvider {
  private readonly _read: (key: string) => Promise<unknown>;
  private readonly _list: () => Promise<string[]>;

  /**
   * @param read   Async function to read a blackboard key
   * @param list   Async function to list all blackboard keys
   */
  constructor(
    read: (key: string) => Promise<unknown>,
    list: () => Promise<string[]>
  ) {
    this._read = read;
    this._list = list;
  }

  listResources(): McpResource[] {
    // Static entry — dynamic keys are discoverable via resources/read with the URI
    return [{
      uri: 'network-ai://blackboard',
      name: 'Blackboard',
      mimeType: 'application/json',
      description: 'Network-AI shared blackboard state. Read individual keys via network-ai://blackboard/<key>',
    }];
  }

  async readResource(uri: string): Promise<McpResourceContent | null> {
    if (!uri.startsWith('network-ai://blackboard')) return null;
    const key = uri.replace('network-ai://blackboard/', '').replace('network-ai://blackboard', '');

    if (!key) {
      // List all keys
      const keys = await this._list();
      return {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify({ keys }),
      };
    }

    const value = await this._read(key);
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({ key, value }),
    };
  }
}

// ============================================================================
// BUILT-IN PROMPT PROVIDER — Orchestration prompts
// ============================================================================

/**
 * Built-in `McpPromptProvider` that exposes common Network-AI orchestration
 * prompt templates to MCP clients.
 */
export class OrchestrationPromptProvider implements McpPromptProvider {
  listPrompts(): McpPrompt[] {
    return [
      {
        name: 'orchestrate',
        description: 'Decompose a high-level goal into a multi-agent task plan using Network-AI',
        arguments: [
          { name: 'goal', description: 'The high-level goal to accomplish', required: true },
          { name: 'agents', description: 'Comma-separated list of available agent IDs', required: false },
        ],
      },
      {
        name: 'audit_summary',
        description: 'Summarise recent agent actions from the audit log',
        arguments: [
          { name: 'limit', description: 'Maximum number of recent entries (default: 20)', required: false },
        ],
      },
    ];
  }

  async getPrompt(name: string, args: Record<string, string>): Promise<McpPromptResult | null> {
    switch (name) {
      case 'orchestrate': {
        const goal = args['goal'] ?? '(no goal specified)';
        const agents = args['agents'] ? `\n\nAvailable agents: ${args['agents']}` : '';
        return {
          description: 'Multi-agent orchestration plan',
          messages: [{
            role: 'user',
            content: {
              type: 'text',
              text: `You are a Network-AI orchestrator. Decompose the following goal into a parallel task DAG using the available blackboard tools and agent adapters.${agents}\n\nGoal: ${goal}\n\nFor each task: (1) assign an agent, (2) list dependencies, (3) define the success condition.`,
            },
          }],
        };
      }

      case 'audit_summary': {
        const limit = parseInt(args['limit'] ?? '20', 10);
        return {
          description: 'Audit log summary prompt',
          messages: [{
            role: 'user',
            content: {
              type: 'text',
              text: `Summarise the last ${limit} entries from the Network-AI audit log. Group by agent, highlight any permission denials, trust violations, or UNSUPPORTED_CLAIM events. Format as a concise bullet list.`,
            },
          }],
        };
      }

      default:
        return null;
    }
  }
}
