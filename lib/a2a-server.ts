/**
 * A2A Server — expose Network-AI as a Google A2A (Agent2Agent) agent.
 *
 * The `A2AAdapter` (adapters/a2a-adapter.ts) lets this orchestrator *call*
 * remote A2A agents. This module is the other direction: `A2AServer` serves
 * an Agent Card at `/.well-known/agent.json` and accepts `tasks/send`
 * JSON-RPC envelopes, so any A2A-speaking framework (Google ADK, Gemini
 * agents, LangGraph A2A clients, …) can discover this orchestrator and hand
 * it tasks.
 *
 * Incoming task text is delegated to a pluggable executor — typically a
 * closure over `AdapterRegistry.executeAgent()` or
 * `SwarmOrchestrator.delegateTask()`.
 *
 * Security posture mirrors `ApprovalInbox`:
 * - binds to 127.0.0.1 by default;
 * - optional Bearer `secret` gates the task routes (the Agent Card remains
 *   public — it is the A2A discovery document);
 * - request bodies are size-capped; unknown methods are rejected.
 *
 * @example
 * ```ts
 * const server = new A2AServer({
 *   name: 'Network-AI Orchestrator',
 *   description: 'Multi-agent swarm coordinator',
 *   secret: process.env.A2A_SECRET,
 *   executor: async (text) => {
 *     const result = await registry.executeAgent('custom:solver', {
 *       action: 'solve', params: { text },
 *     }, { agentId: 'a2a-server', taskId: 'a2a' });
 *     return { text: JSON.stringify(result.data) };
 *   },
 * });
 * server.startServer(4310);
 * ```
 *
 * @module A2AServer
 * @version 1.0.0
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { randomUUID } from 'crypto';

// ============================================================================
// TYPES
// ============================================================================

/** Task lifecycle states (A2A spec §4) */
export type A2AServerTaskState = 'submitted' | 'working' | 'completed' | 'canceled' | 'failed';

/** Executor invoked for every incoming `tasks/send` */
export type A2ATaskExecutor = (
  text: string,
  metadata: Record<string, unknown> | undefined
) => Promise<{ text?: string; data?: unknown }>;

/** A stored task record */
export interface A2AServerTask {
  /** Task id (client-supplied or generated) */
  id: string;
  /** Current lifecycle state */
  state: A2AServerTaskState;
  /** The incoming message text */
  input: string;
  /** Output artifact text (present when completed) */
  output?: string;
  /** Failure/cancel message */
  message?: string;
  /** Creation timestamp (epoch ms) */
  createdAt: number;
  /** Resolution timestamp (epoch ms) */
  resolvedAt?: number;
}

/** Options for the A2AServer */
export interface A2AServerOptions {
  /** Agent name shown on the Agent Card */
  name: string;
  /** Agent description shown on the Agent Card */
  description?: string;
  /** Agent version shown on the Agent Card (default: '1.0.0') */
  version?: string;
  /** Public URL of this agent (advertised on the card) */
  url?: string;
  /**
   * Bearer token required on the task routes when set. The Agent Card at
   * /.well-known/agent.json stays public — it is the discovery document.
   */
  secret?: string;
  /** Executor that fulfils incoming tasks (required) */
  executor: A2ATaskExecutor;
  /** Maximum stored task records (default: 1000, oldest evicted first) */
  maxHistory?: number;
  /** Maximum request body size in bytes (default: 1 MiB) */
  maxBodyBytes?: number;
}

/** JSON-RPC request envelope accepted on the tasks route */
interface A2AJsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: {
    id?: string;
    message?: { role?: string; parts?: Array<{ type?: string; text?: string }> };
    metadata?: Record<string, unknown>;
  };
}

// ============================================================================
// A2A SERVER
// ============================================================================

/**
 * Minimal, dependency-free A2A protocol server: Agent Card discovery plus
 * `tasks/send`, `tasks/get`, and `tasks/cancel` over JSON-RPC 2.0.
 */
export class A2AServer {
  private readonly options: Required<Pick<A2AServerOptions, 'name' | 'version' | 'maxHistory' | 'maxBodyBytes'>> &
    Omit<A2AServerOptions, 'name' | 'version' | 'maxHistory' | 'maxBodyBytes'>;
  private readonly tasks = new Map<string, A2AServerTask>();

  constructor(options: A2AServerOptions) {
    if (!options || typeof options.name !== 'string' || options.name.trim() === '') {
      throw new Error('A2AServer: options.name is required');
    }
    if (typeof options.executor !== 'function') {
      throw new Error('A2AServer: options.executor is required');
    }
    this.options = {
      ...options,
      version: options.version ?? '1.0.0',
      maxHistory: options.maxHistory ?? 1000,
      maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024,
    };
  }

  /** Build the Agent Card served at /.well-known/agent.json */
  agentCard(): Record<string, unknown> {
    return {
      name: this.options.name,
      description: this.options.description ?? 'Network-AI multi-agent orchestrator (A2A server mode)',
      version: this.options.version,
      capabilities: {
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: false,
      },
      ...(this.options.url ? { url: this.options.url, taskEndpoint: `${this.options.url.replace(/\/+$/, '')}/tasks` } : { taskEndpoint: '/tasks' }),
      authentication: this.options.secret ? { schemes: ['bearer'] } : { schemes: [] },
    };
  }

  /** Get a stored task by id */
  getTask(id: string): A2AServerTask | undefined {
    return this.tasks.get(id);
  }

  /** Number of stored task records */
  get taskCount(): number {
    return this.tasks.size;
  }

  /**
   * HTTP handler — mount on any node http server.
   * Routes: GET /.well-known/agent.json, POST /tasks.
   */
  httpHandler(): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
      void this.route(req, res);
    };
  }

  /**
   * Convenience: create and start an http.Server with the handler mounted.
   * Binds to 127.0.0.1 by default — expose deliberately, not accidentally.
   */
  startServer(port: number, hostname = '127.0.0.1'): Server {
    const server = createServer(this.httpHandler());
    server.listen(port, hostname);
    return server;
  }

  // --------------------------------------------------------------------------
  // Routing
  // --------------------------------------------------------------------------

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = (req.url ?? '/').split('?')[0];

    // Agent Card — public discovery document
    if (req.method === 'GET' && url === '/.well-known/agent.json') {
      this.json(res, 200, this.agentCard());
      return;
    }

    if (req.method === 'POST' && (url === '/tasks' || url === '/')) {
      // Auth gate (fail closed when a secret is configured)
      if (this.options.secret) {
        const header = req.headers['authorization'] ?? '';
        const ok = typeof header === 'string' && header === `Bearer ${this.options.secret}`;
        if (!ok) {
          this.json(res, 401, { error: 'unauthorized' });
          return;
        }
      }

      let body: string;
      try {
        body = await this.readBody(req);
      } catch (err) {
        this.json(res, 413, { error: err instanceof Error ? err.message : 'body too large' });
        return;
      }

      let rpc: A2AJsonRpcRequest;
      try {
        rpc = JSON.parse(body) as A2AJsonRpcRequest;
      } catch {
        this.rpcError(res, null, -32700, 'Parse error');
        return;
      }

      const rpcId = rpc.id ?? null;
      switch (rpc.method) {
        case 'tasks/send':
          await this.handleSend(res, rpcId, rpc);
          return;
        case 'tasks/get':
          this.handleGet(res, rpcId, rpc);
          return;
        case 'tasks/cancel':
          this.handleCancel(res, rpcId, rpc);
          return;
        default:
          this.rpcError(res, rpcId, -32601, `Method not found: ${rpc.method ?? '(none)'}`);
          return;
      }
    }

    this.json(res, 404, { error: 'not found' });
  }

  // --------------------------------------------------------------------------
  // JSON-RPC methods
  // --------------------------------------------------------------------------

  private async handleSend(
    res: ServerResponse,
    rpcId: string | number | null,
    rpc: A2AJsonRpcRequest
  ): Promise<void> {
    const params = rpc.params;
    const parts = params?.message?.parts ?? [];
    const text = parts
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('\n');

    if (!text) {
      this.rpcError(res, rpcId, -32602, 'Invalid params: message must contain at least one text part');
      return;
    }

    const taskId = params?.id && typeof params.id === 'string' ? params.id : randomUUID();
    const task: A2AServerTask = {
      id: taskId,
      state: 'working',
      input: text.slice(0, 10_000),
      createdAt: Date.now(),
    };
    this.store(task);

    try {
      const result = await this.options.executor(text, params?.metadata);
      task.state = 'completed';
      task.output = result.text ?? (result.data !== undefined ? JSON.stringify(result.data) : '');
      task.resolvedAt = Date.now();

      this.json(res, 200, {
        jsonrpc: '2.0',
        id: rpcId,
        result: {
          id: taskId,
          status: { state: 'completed' },
          artifacts: [{
            name: 'result',
            parts: [{ type: 'text', text: task.output }],
          }],
        },
      });
    } catch (err) {
      task.state = 'failed';
      task.message = err instanceof Error ? err.message : String(err);
      task.resolvedAt = Date.now();

      this.json(res, 200, {
        jsonrpc: '2.0',
        id: rpcId,
        result: {
          id: taskId,
          status: { state: 'failed', message: task.message },
        },
      });
    }
  }

  private handleGet(res: ServerResponse, rpcId: string | number | null, rpc: A2AJsonRpcRequest): void {
    const id = rpc.params?.id;
    const task = id ? this.tasks.get(id) : undefined;
    if (!task) {
      this.rpcError(res, rpcId, -32001, `Task not found: ${id ?? '(none)'}`);
      return;
    }
    this.json(res, 200, {
      jsonrpc: '2.0',
      id: rpcId,
      result: {
        id: task.id,
        status: { state: task.state, ...(task.message ? { message: task.message } : {}) },
        ...(task.output !== undefined
          ? { artifacts: [{ name: 'result', parts: [{ type: 'text', text: task.output }] }] }
          : {}),
      },
    });
  }

  private handleCancel(res: ServerResponse, rpcId: string | number | null, rpc: A2AJsonRpcRequest): void {
    const id = rpc.params?.id;
    const task = id ? this.tasks.get(id) : undefined;
    if (!task) {
      this.rpcError(res, rpcId, -32001, `Task not found: ${id ?? '(none)'}`);
      return;
    }
    if (task.state === 'submitted' || task.state === 'working') {
      task.state = 'canceled';
      task.resolvedAt = Date.now();
    }
    this.json(res, 200, {
      jsonrpc: '2.0',
      id: rpcId,
      result: { id: task.id, status: { state: task.state } },
    });
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private store(task: A2AServerTask): void {
    this.tasks.set(task.id, task);
    if (this.tasks.size > this.options.maxHistory) {
      const oldest = this.tasks.keys().next().value;
      if (oldest !== undefined) this.tasks.delete(oldest);
    }
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.options.maxBodyBytes) {
          reject(new Error(`request body exceeds ${this.options.maxBodyBytes} bytes`));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  private json(res: ServerResponse, status: number, payload: unknown): void {
    if (res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }

  private rpcError(res: ServerResponse, id: string | number | null, code: number, message: string): void {
    this.json(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  }
}
