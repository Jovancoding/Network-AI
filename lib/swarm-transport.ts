/**
 * Distributed Swarm Transport — HTTP/JSON-RPC transport layer
 *
 * Enables multi-node swarm orchestration over the network.
 * Provides:
 *   - SwarmTransportServer — HTTP server that exposes SwarmOrchestrator methods
 *   - SwarmTransportClient — HTTP client that proxies calls to a remote server
 *   - Message envelope with auth, correlation IDs, and TTL
 *
 * Uses Node built-in `http` module — no external dependencies.
 * Communication format: JSON-RPC 2.0 over HTTP POST.
 *
 * Usage (server):
 *   const server = new SwarmTransportServer(orchestrator, { port: 4000 });
 *   await server.start();
 *
 * Usage (client):
 *   const client = new SwarmTransportClient('http://node-2:4000');
 *   const result = await client.delegateTask(agentId, payload);
 *
 * @module SwarmTransport
 * @version 1.0.0
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { EventEmitter } from 'events';
import { randomBytes, createHmac } from 'crypto';

// ============================================================================
// TYPES
// ============================================================================

/** Transport message envelope */
export interface TransportEnvelope {
  /** JSON-RPC version */
  jsonrpc: '2.0';
  /** Unique request ID */
  id: string;
  /** Remote method name */
  method: string;
  /** Method parameters */
  params: Record<string, unknown>;
  /** Metadata */
  meta?: TransportMeta;
}

/** Metadata attached to transport messages */
export interface TransportMeta {
  /** Correlation ID for request tracing */
  correlationId: string;
  /** Source node identifier */
  sourceNode: string;
  /** Timestamp of message creation */
  timestamp: number;
  /** Time-to-live in ms (0 = no expiry) */
  ttlMs: number;
  /** HMAC signature if auth is configured */
  signature?: string;
}

/** Transport response */
export interface TransportResponse {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Server configuration */
export interface TransportServerConfig {
  /** Port to listen on (default: 4000) */
  port?: number;
  /** Hostname to bind (default: '127.0.0.1') */
  hostname?: string;
  /** Shared secret for HMAC authentication (optional) */
  sharedSecret?: string;
  /** Maximum request body size in bytes (default: 1MB) */
  maxBodyBytes?: number;
  /** Allowed source nodes (empty = allow all) */
  allowedNodes?: string[];
  /** Node identifier for this server */
  nodeId?: string;
}

/** Client configuration */
export interface TransportClientConfig {
  /** Remote server URL (e.g. 'http://node-2:4000') */
  url: string;
  /** Shared secret for HMAC authentication (must match server) */
  sharedSecret?: string;
  /** This node's identifier */
  nodeId?: string;
  /** Default request timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** Default TTL for messages in ms (default: 60000) */
  ttlMs?: number;
}

/**
 * Handler function for swarm transport methods.
 * Receives parsed params and returns a result.
 */
export type TransportHandler = (params: Record<string, unknown>) => Promise<unknown>;

// ============================================================================
// SERVER
// ============================================================================

/**
 * HTTP transport server for distributed swarm orchestration.
 *
 * Exposes registered methods over HTTP POST with JSON-RPC 2.0 protocol.
 * Supports HMAC authentication, node allowlisting, TTL enforcement,
 * and request size limits.
 */
export class SwarmTransportServer extends EventEmitter {
  private server: Server | null = null;
  private handlers = new Map<string, TransportHandler>();
  private readonly config: Required<TransportServerConfig>;

  constructor(config: TransportServerConfig = {}) {
    super();
    this.config = {
      port: config.port ?? 4000,
      hostname: config.hostname ?? '127.0.0.1',
      sharedSecret: config.sharedSecret ?? '',
      maxBodyBytes: config.maxBodyBytes ?? 1_048_576,
      allowedNodes: config.allowedNodes ?? [],
      nodeId: config.nodeId ?? `node-${randomBytes(4).toString('hex')}`,
    };
  }

  /** Register a method handler */
  register(method: string, handler: TransportHandler): void {
    this.handlers.set(method, handler);
  }

  /** Register multiple handlers at once */
  registerAll(handlers: Record<string, TransportHandler>): void {
    for (const [method, handler] of Object.entries(handlers)) {
      this.handlers.set(method, handler);
    }
  }

  /** Start the transport server */
  async start(): Promise<void> {
    if (this.server) return;

    this.server = createServer((req, res) => this.handleRequest(req, res));
    await new Promise<void>((resolve) => {
      this.server!.listen(this.config.port, this.config.hostname, () => {
        this.emit('listening', { port: this.config.port, hostname: this.config.hostname });
        resolve();
      });
    });
  }

  /** Stop the transport server */
  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = null;
    this.emit('stopped');
  }

  /** Get the node ID */
  get nodeId(): string {
    return this.config.nodeId;
  }

  /** Whether the server is running */
  get isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Content-Type', 'application/json');

    // Only POST allowed
    if (req.method !== 'POST') {
      this.sendResponse(res, {
        jsonrpc: '2.0', id: '', error: { code: -32600, message: 'Only POST allowed' },
      });
      return;
    }

    // Health endpoint
    if (req.url === '/health') {
      this.sendResponse(res, {
        jsonrpc: '2.0', id: 'health',
        result: { nodeId: this.config.nodeId, methods: Array.from(this.handlers.keys()), uptime: process.uptime() },
      });
      return;
    }

    try {
      const body = await this.readBody(req);
      const envelope = JSON.parse(body) as TransportEnvelope;

      // Validate envelope
      if (envelope.jsonrpc !== '2.0' || !envelope.method || !envelope.id) {
        this.sendResponse(res, {
          jsonrpc: '2.0', id: envelope?.id ?? '',
          error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request' },
        });
        return;
      }

      // Check node allowlist
      if (this.config.allowedNodes.length > 0 && envelope.meta?.sourceNode) {
        if (!this.config.allowedNodes.includes(envelope.meta.sourceNode)) {
          this.sendResponse(res, {
            jsonrpc: '2.0', id: envelope.id,
            error: { code: -32001, message: 'Source node not allowed' },
          });
          return;
        }
      }

      // Verify HMAC
      if (this.config.sharedSecret && envelope.meta?.signature) {
        const expected = this.computeHmac(envelope.method, envelope.params, envelope.meta.timestamp);
        if (envelope.meta.signature !== expected) {
          this.sendResponse(res, {
            jsonrpc: '2.0', id: envelope.id,
            error: { code: -32002, message: 'Invalid signature' },
          });
          return;
        }
      } else if (this.config.sharedSecret && !envelope.meta?.signature) {
        this.sendResponse(res, {
          jsonrpc: '2.0', id: envelope.id,
          error: { code: -32003, message: 'Signature required' },
        });
        return;
      }

      // Check TTL
      if (envelope.meta?.ttlMs && envelope.meta.ttlMs > 0) {
        const age = Date.now() - envelope.meta.timestamp;
        if (age > envelope.meta.ttlMs) {
          this.sendResponse(res, {
            jsonrpc: '2.0', id: envelope.id,
            error: { code: -32004, message: 'Message expired' },
          });
          return;
        }
      }

      // Find handler
      const handler = this.handlers.get(envelope.method);
      if (!handler) {
        this.sendResponse(res, {
          jsonrpc: '2.0', id: envelope.id,
          error: { code: -32601, message: `Method not found: ${envelope.method}` },
        });
        return;
      }

      // Execute
      this.emit('request', { method: envelope.method, id: envelope.id, source: envelope.meta?.sourceNode });
      const result = await handler(envelope.params);
      this.sendResponse(res, { jsonrpc: '2.0', id: envelope.id, result });
    } catch (err) {
      this.sendResponse(res, {
        jsonrpc: '2.0', id: '',
        error: { code: -32700, message: err instanceof Error ? err.message : 'Parse error' },
      });
    }
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;

      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.config.maxBodyBytes) {
          req.destroy();
          reject(new Error('Request body too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }

  private sendResponse(res: ServerResponse, response: TransportResponse): void {
    const body = JSON.stringify(response);
    res.writeHead(response.error ? 400 : 200, { 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  private computeHmac(method: string, params: Record<string, unknown>, timestamp: number): string {
    const payload = `${method}:${JSON.stringify(params)}:${timestamp}`;
    return createHmac('sha256', this.config.sharedSecret).update(payload).digest('hex');
  }
}

// ============================================================================
// CLIENT
// ============================================================================

/**
 * HTTP transport client for distributed swarm orchestration.
 *
 * Proxies method calls to a remote SwarmTransportServer over HTTP POST.
 * Supports HMAC authentication, correlation IDs, and TTL.
 */
export class SwarmTransportClient extends EventEmitter {
  private readonly config: Required<TransportClientConfig>;

  constructor(config: TransportClientConfig) {
    super();
    this.config = {
      url: config.url.replace(/\/$/, ''),
      sharedSecret: config.sharedSecret ?? '',
      nodeId: config.nodeId ?? `client-${randomBytes(4).toString('hex')}`,
      timeoutMs: config.timeoutMs ?? 30_000,
      ttlMs: config.ttlMs ?? 60_000,
    };
  }

  /**
   * Call a remote method.
   * @returns The result from the remote handler.
   * @throws If the remote returns an error or the request times out.
   */
  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = randomBytes(8).toString('hex');
    const correlationId = randomBytes(8).toString('hex');
    const timestamp = Date.now();

    const meta: TransportMeta = {
      correlationId,
      sourceNode: this.config.nodeId,
      timestamp,
      ttlMs: this.config.ttlMs,
    };

    // Sign if shared secret is configured
    if (this.config.sharedSecret) {
      const payload = `${method}:${JSON.stringify(params)}:${timestamp}`;
      meta.signature = createHmac('sha256', this.config.sharedSecret).update(payload).digest('hex');
    }

    const envelope: TransportEnvelope = {
      jsonrpc: '2.0',
      id,
      method,
      params,
      meta,
    };

    const body = JSON.stringify(envelope);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(this.config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
        body,
        signal: controller.signal,
      });

      const data = await response.json() as TransportResponse;

      if (data.error) {
        const err = new Error(data.error.message);
        (err as unknown as Record<string, unknown>)['code'] = data.error.code;
        throw err;
      }

      this.emit('response', { method, id, correlationId, durationMs: Date.now() - timestamp });
      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Get the node ID */
  get nodeId(): string {
    return this.config.nodeId;
  }

  /** Convenience: delegate a task to a remote orchestrator */
  async delegateTask(agentId: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.call('delegateTask', { agentId, payload });
  }

  /** Convenience: read from remote blackboard */
  async blackboardRead(key: string): Promise<unknown> {
    return this.call('blackboard_read', { key });
  }

  /** Convenience: write to remote blackboard */
  async blackboardWrite(key: string, value: unknown, proposer?: string): Promise<unknown> {
    return this.call('blackboard_write', { key, value, proposer });
  }

  /** Convenience: query remote budget status */
  async budgetStatus(): Promise<unknown> {
    return this.call('budget_status', {});
  }
}
