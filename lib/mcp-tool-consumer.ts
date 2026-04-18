/**
 * MCPToolConsumer — Connect to external MCP servers and consume their tools.
 *
 * Implements `MCPServerConnection` for the MCPAdapter, providing:
 * - Stdio-based client transport (spawn child process)
 * - SSE-based client transport (HTTP long-poll)
 * - Auto-discovery of remote tools with caching
 * - Permission-gated remote tool execution
 *
 * BYOC: No external MCP client library required.
 *
 * @module MCPToolConsumer
 */

import { EventEmitter } from 'events';
import type { MCPServerConnection, MCPTool } from '../adapters/mcp-adapter';

// ============================================================================
// TYPES
// ============================================================================

/** JSON-RPC 2.0 request */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 response */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** MCP tool call result */
export interface ToolCallResult {
  content: Array<{ type: string; text?: string; data?: unknown }>;
  isError?: boolean;
}

/** Transport interface for MCP client communication */
export interface MCPClientTransport {
  send(request: JsonRpcRequest): Promise<JsonRpcResponse>;
  close(): Promise<void>;
}

/** Options for connecting to an external MCP server */
export interface MCPConsumerOptions {
  /** Transport to use for communication */
  transport: MCPClientTransport;
  /** Cache tool list for this many ms (default 60000) */
  toolCacheTtlMs?: number;
  /** Timeout per tool call in ms (default 30000) */
  callTimeoutMs?: number;
  /** Optional prefix for tool names when registered as agents (default 'mcp') */
  prefix?: string;
}

/** Status of a discovered remote tool */
export interface RemoteToolInfo {
  tool: MCPTool;
  serverPrefix: string;
  lastDiscovered: number;
  callCount: number;
  errorCount: number;
}

// ============================================================================
// STDIO CLIENT TRANSPORT
// ============================================================================

/**
 * Stdio-based MCP client transport.
 * Spawns a child process and communicates via stdin/stdout JSON-RPC.
 *
 * @example
 * ```ts
 * const transport = new StdioClientTransport('npx', ['some-mcp-server']);
 * const consumer = new MCPToolConsumer({ transport });
 * ```
 */
export class StdioClientTransport implements MCPClientTransport {
  private command: string;
  private args: string[];
  private process: ReturnType<typeof import('child_process').spawn> | null = null;
  private pendingRequests: Map<number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }> = new Map();
  private nextId = 1;
  private buffer = '';
  private spawnFn: typeof import('child_process').spawn | null = null;

  constructor(command: string, args: string[] = []) {
    this.command = command;
    this.args = args;
  }

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (!this.process) await this.start();

    const id = this.nextId++;
    const req: JsonRpcRequest = { ...request, id };

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.process!.stdin!.write(JSON.stringify(req) + '\n');
    });
  }

  async close(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    for (const { reject } of this.pendingRequests.values()) {
      reject(new Error('Transport closed'));
    }
    this.pendingRequests.clear();
  }

  private async start(): Promise<void> {
    if (!this.spawnFn) {
      // Dynamic import to avoid bundling child_process in browser contexts
      const cp = await import('child_process');
      this.spawnFn = cp.spawn;
    }
    this.process = this.spawnFn!(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    this.process.on('exit', () => {
      for (const { reject } of this.pendingRequests.values()) {
        reject(new Error('MCP server process exited'));
      }
      this.pendingRequests.clear();
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const response = JSON.parse(trimmed) as JsonRpcResponse;
        if (response.id !== undefined && this.pendingRequests.has(response.id)) {
          const { resolve } = this.pendingRequests.get(response.id)!;
          this.pendingRequests.delete(response.id);
          resolve(response);
        }
      } catch {
        // Not valid JSON — skip
      }
    }
  }
}

// ============================================================================
// HTTP CLIENT TRANSPORT
// ============================================================================

/**
 * HTTP-based MCP client transport.
 * Sends JSON-RPC over HTTP POST requests to an MCP server endpoint.
 */
export class HttpClientTransport implements MCPClientTransport {
  private url: string;
  private headers: Record<string, string>;
  private nextId = 1;

  constructor(url: string, headers: Record<string, string> = {}) {
    this.url = url;
    this.headers = headers;
  }

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { ...request, id };

    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body: JSON.stringify(req),
    });

    if (!response.ok) {
      throw new Error(`MCP HTTP error: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<JsonRpcResponse>;
  }

  async close(): Promise<void> {
    // HTTP is stateless — nothing to close
  }
}

// ============================================================================
// MCP TOOL CONSUMER
// ============================================================================

/**
 * Consume tools from an external MCP server.
 * Implements MCPServerConnection for use with MCPAdapter.
 *
 * @example
 * ```ts
 * const transport = new HttpClientTransport('http://localhost:3001/mcp');
 * const consumer = new MCPToolConsumer({ transport });
 *
 * // Use with MCPAdapter:
 * const adapter = new MCPAdapter();
 * adapter.initialize({ options: { serverConnection: consumer } });
 * await adapter.discoverServerTools();
 * ```
 */
export class MCPToolConsumer extends EventEmitter implements MCPServerConnection {
  private transport: MCPClientTransport;
  private toolCache: MCPTool[] | null = null;
  private toolCacheTime = 0;
  private toolCacheTtlMs: number;
  private callTimeoutMs: number;
  private prefix: string;
  private toolInfo: Map<string, RemoteToolInfo> = new Map();
  private initialized = false;

  constructor(options: MCPConsumerOptions) {
    super();
    this.transport = options.transport;
    this.toolCacheTtlMs = options.toolCacheTtlMs ?? 60_000;
    this.callTimeoutMs = options.callTimeoutMs ?? 30_000;
    this.prefix = options.prefix ?? 'mcp';
  }

  /**
   * Initialize the MCP connection (send initialize handshake).
   */
  async initialize(clientInfo?: { name: string; version: string }): Promise<void> {
    if (this.initialized) return;
    const response = await this.transport.send({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: clientInfo ?? { name: 'network-ai', version: '5.0.0' },
      },
    });
    if (response.error) {
      throw new Error(`MCP initialize failed: ${response.error.message}`);
    }
    this.initialized = true;
  }

  /**
   * List available tools from the remote MCP server.
   * Results are cached for `toolCacheTtlMs`.
   */
  async listTools(): Promise<MCPTool[]> {
    if (!this.initialized) await this.initialize();

    const now = Date.now();
    if (this.toolCache && (now - this.toolCacheTime) < this.toolCacheTtlMs) {
      return this.toolCache;
    }

    const response = await this.transport.send({
      jsonrpc: '2.0',
      id: 0,
      method: 'tools/list',
    });

    if (response.error) {
      throw new Error(`tools/list failed: ${response.error.message}`);
    }

    const result = response.result as { tools?: MCPTool[] } | undefined;
    const tools = result?.tools ?? [];
    this.toolCache = tools;
    this.toolCacheTime = now;

    // Update tool info registry
    for (const tool of tools) {
      if (!this.toolInfo.has(tool.name)) {
        this.toolInfo.set(tool.name, {
          tool,
          serverPrefix: this.prefix,
          lastDiscovered: now,
          callCount: 0,
          errorCount: 0,
        });
      }
    }

    this.emit('tools-discovered', tools);
    return tools;
  }

  /**
   * Call a tool on the remote MCP server.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    if (!this.initialized) await this.initialize();

    const info = this.toolInfo.get(name);
    if (info) info.callCount++;

    const resultPromise = this.transport.send({
      jsonrpc: '2.0',
      id: 0,
      method: 'tools/call',
      params: { name, arguments: args },
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Tool call timeout: ${name}`)), this.callTimeoutMs),
    );

    try {
      const response = await Promise.race([resultPromise, timeoutPromise]);

      if (response.error) {
        if (info) info.errorCount++;
        return {
          content: [{ type: 'text', text: response.error.message }],
          isError: true,
        };
      }

      const result = response.result as ToolCallResult | undefined;
      return result ?? { content: [{ type: 'text', text: 'No result' }] };
    } catch (err) {
      if (info) info.errorCount++;
      throw err;
    }
  }

  /** Close the transport connection */
  async close(): Promise<void> {
    await this.transport.close();
    this.toolCache = null;
    this.initialized = false;
  }

  /** Get info about discovered tools */
  getToolInfo(): RemoteToolInfo[] {
    return [...this.toolInfo.values()];
  }

  /** Invalidate the tool cache to force re-discovery */
  invalidateCache(): void {
    this.toolCache = null;
    this.toolCacheTime = 0;
  }

  /** Get the prefix used for agent naming */
  getPrefix(): string {
    return this.prefix;
  }
}
