/**
 * ApprovalInbox — Web-accessible human-in-the-loop approval system
 *
 * Provides an HTTP API and SSE streaming for managing approval requests
 * from AI agents. Designed to work as an ApprovalCallback for ApprovalGate
 * while also exposing a REST-like HTTP interface.
 *
 * Features:
 *   - Queues approval requests with unique IDs and optional timeouts
 *   - REST API: list, get, approve, deny, stats
 *   - SSE stream for real-time notifications
 *   - Auto-expiry for stale requests
 *   - Standalone HTTP server or mountable handler
 *
 * @module ApprovalInbox
 * @version 1.0.0
 */

import { EventEmitter } from 'events';
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { randomBytes, timingSafeEqual } from 'crypto';
import type { ApprovalRequest, ApprovalDecision, ApprovalCallback } from './agent-runtime';

// ============================================================================
// TYPES
// ============================================================================

/** Status of an approval entry */
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

/** A queued approval entry */
export interface ApprovalEntry {
  /** Unique identifier for this approval */
  id: string;
  /** The original approval request */
  request: ApprovalRequest;
  /** Current status */
  status: ApprovalStatus;
  /** Decision if resolved */
  decision?: ApprovalDecision;
  /** When the request was created */
  createdAt: number;
  /** When the request was resolved */
  resolvedAt?: number;
  /** Timeout for this specific request (ms) */
  timeoutMs: number;
}

/** Options for the ApprovalInbox */
export interface ApprovalInboxOptions {
  /**
   * Bearer token required for POST /approve and POST /deny endpoints.
   * Strongly recommended in production — without a secret, any process that
   * can reach the HTTP server can approve agent actions (GHSA-mxjx-28vx-xjjj).
   * Clients must send: `Authorization: Bearer <secret>`.
   */
  secret?: string;
  /** Default timeout for approval requests in ms (default: 300000 = 5 min) */
  defaultTimeoutMs?: number;
  /** Maximum number of pending approvals (default: 100) */
  maxPending?: number;
  /** Maximum history entries to keep (default: 1000) */
  maxHistory?: number;
  /** URL path prefix for HTTP handler (default: '/approvals') */
  pathPrefix?: string;
}

/** SSE event types */
export type InboxEventType = 'new' | 'approved' | 'denied' | 'expired';

/** SSE event payload */
export interface InboxEvent {
  type: InboxEventType;
  entry: ApprovalEntry;
}

/** Stats snapshot */
export interface InboxStats {
  pending: number;
  approved: number;
  denied: number;
  expired: number;
  total: number;
}

// ============================================================================
// APPROVAL INBOX
// ============================================================================

/**
 * Web-accessible approval inbox for human-in-the-loop agent workflows.
 *
 * Use `inbox.callback()` to get an ApprovalCallback for ApprovalGate,
 * and `inbox.httpHandler()` to mount the HTTP API on a server.
 *
 * @example
 * ```ts
 * const inbox = new ApprovalInbox();
 * const gate = new ApprovalGate(inbox.callback());
 * const server = inbox.createServer(3002);
 * ```
 */
export class ApprovalInbox extends EventEmitter {
  private readonly pending = new Map<string, {
    entry: ApprovalEntry;
    resolve: (decision: ApprovalDecision) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }>();
  private readonly history: ApprovalEntry[] = [];
  private readonly sseClients = new Set<ServerResponse>();

  private readonly defaultTimeoutMs: number;
  private readonly maxPending: number;
  private readonly maxHistory: number;
  private readonly pathPrefix: string;
  private readonly secret: string | null;

  // Counters for stats (history may be truncated)
  private approvedCount = 0;
  private deniedCount = 0;
  private expiredCount = 0;

  constructor(options: ApprovalInboxOptions = {}) {
    super();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 300_000;
    this.maxPending = options.maxPending ?? 100;
    this.maxHistory = options.maxHistory ?? 1000;
    this.pathPrefix = (options.pathPrefix ?? '/approvals').replace(/\/$/, '');
    this.secret = options.secret ?? null;
  }

  // --------------------------------------------------------------------------
  // CORE API
  // --------------------------------------------------------------------------

  /**
   * Returns an ApprovalCallback suitable for ApprovalGate.
   * Each call enqueues a pending approval and waits for resolution.
   */
  callback(): ApprovalCallback {
    return (request: ApprovalRequest): Promise<ApprovalDecision> => {
      return this.enqueue(request);
    };
  }

  /**
   * Enqueue an approval request. Returns a promise that resolves when
   * the request is approved, denied, or expires.
   */
  enqueue(request: ApprovalRequest, timeoutMs?: number): Promise<ApprovalDecision> {
    if (this.pending.size >= this.maxPending) {
      return Promise.resolve({ approved: false, reason: 'Approval queue is full' });
    }

    const id = randomBytes(8).toString('hex');
    const timeout = timeoutMs ?? this.defaultTimeoutMs;

    const entry: ApprovalEntry = {
      id,
      request,
      status: 'pending',
      createdAt: Date.now(),
      timeoutMs: timeout,
    };

    return new Promise<ApprovalDecision>((resolve) => {
      const timer = timeout > 0
        ? setTimeout(() => this.expire(id), timeout)
        : null;

      this.pending.set(id, { entry, resolve, timer });
      this.broadcastSSE({ type: 'new', entry });
      this.emit('new', entry);
    });
  }

  /**
   * Approve a pending request.
   * @returns The resolved entry, or undefined if not found/already resolved.
   */
  approve(id: string, approvedBy: string, reason?: string): ApprovalEntry | undefined {
    const record = this.pending.get(id);
    if (!record) return undefined;

    const decision: ApprovalDecision = {
      approved: true,
      approvedBy,
      reason,
    };

    return this.resolve(id, 'approved', decision);
  }

  /**
   * Deny a pending request.
   * @returns The resolved entry, or undefined if not found/already resolved.
   */
  deny(id: string, deniedBy?: string, reason?: string): ApprovalEntry | undefined {
    const record = this.pending.get(id);
    if (!record) return undefined;

    const decision: ApprovalDecision = {
      approved: false,
      approvedBy: deniedBy,
      reason,
    };

    return this.resolve(id, 'denied', decision);
  }

  /** Get a single entry by ID (pending or historical) */
  get(id: string): ApprovalEntry | undefined {
    const record = this.pending.get(id);
    if (record) return { ...record.entry };
    return this.history.find((e) => e.id === id);
  }

  /** List entries by status (default: 'pending') */
  list(status: ApprovalStatus | 'all' = 'pending'): ApprovalEntry[] {
    if (status === 'pending' || status === 'all') {
      const pendingEntries = Array.from(this.pending.values()).map((r) => ({ ...r.entry }));
      if (status === 'pending') return pendingEntries;
      return [...pendingEntries, ...this.history];
    }
    return this.history.filter((e) => e.status === status);
  }

  /** Get aggregate stats */
  stats(): InboxStats {
    return {
      pending: this.pending.size,
      approved: this.approvedCount,
      denied: this.deniedCount,
      expired: this.expiredCount,
      total: this.approvedCount + this.deniedCount + this.expiredCount + this.pending.size,
    };
  }

  /** Number of pending approvals */
  get pendingCount(): number {
    return this.pending.size;
  }

  // --------------------------------------------------------------------------
  // HTTP HANDLER
  // --------------------------------------------------------------------------

  /**
   * Returns an HTTP request handler for the approval inbox API.
   *
   * Routes (relative to pathPrefix):
   *   GET  /           — List approvals (?status=pending|approved|denied|expired|all)
   *   GET  /stats      — Aggregate stats
   *   GET  /sse        — SSE event stream
   *   GET  /:id        — Get single entry
   *   POST /:id/approve — Approve (body: { approvedBy, reason? })
   *   POST /:id/deny    — Deny (body: { deniedBy?, reason? })
   */
  httpHandler(): (req: IncomingMessage, res: ServerResponse) => void {
    return (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname;

      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Strip prefix
      if (!path.startsWith(this.pathPrefix)) {
        this.sendJson(res, 404, { error: 'Not found' });
        return;
      }
      const subPath = path.slice(this.pathPrefix.length) || '/';

      this.routeRequest(req, res, subPath, url);
    };
  }

  /**
   * Create a standalone HTTP server for the inbox.
   * @returns The HTTP server instance (already listening).
   */
  startServer(port: number, hostname = '127.0.0.1'): Server {
    const handler = this.httpHandler();
    const server = createServer(handler);
    server.listen(port, hostname);
    return server;
  }

  // --------------------------------------------------------------------------
  // SSE
  // --------------------------------------------------------------------------

  /** Broadcast an event to all connected SSE clients */
  private broadcastSSE(event: InboxEvent): void {
    const data = JSON.stringify(event);
    const message = `event: ${event.type}\ndata: ${data}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(message);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  /** Register an SSE client */
  private addSSEClient(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ pending: this.pending.size })}\n\n`);
    this.sseClients.add(res);

    const onClose = (): void => {
      this.sseClients.delete(res);
    };
    res.on('close', onClose);
    res.on('error', onClose);
  }

  // --------------------------------------------------------------------------
  // INTERNAL
  // --------------------------------------------------------------------------

  private resolve(id: string, status: 'approved' | 'denied' | 'expired', decision: ApprovalDecision): ApprovalEntry {
    const record = this.pending.get(id)!;
    if (record.timer) clearTimeout(record.timer);

    record.entry.status = status;
    record.entry.decision = decision;
    record.entry.resolvedAt = Date.now();

    this.pending.delete(id);
    this.addToHistory(record.entry);

    if (status === 'approved') this.approvedCount++;
    else if (status === 'denied') this.deniedCount++;
    else this.expiredCount++;

    const eventType = status as InboxEventType;
    this.broadcastSSE({ type: eventType, entry: record.entry });
    this.emit(status, record.entry);
    record.resolve(decision);

    return { ...record.entry };
  }

  private expire(id: string): void {
    const record = this.pending.get(id);
    if (!record) return;

    const decision: ApprovalDecision = {
      approved: false,
      reason: `Approval request expired after ${record.entry.timeoutMs}ms`,
    };

    this.resolve(id, 'expired', decision);
  }

  private addToHistory(entry: ApprovalEntry): void {
    this.history.push(entry);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
  }

  private routeRequest(req: IncomingMessage, res: ServerResponse, subPath: string, url: URL): void {
    // GET / — list
    if (subPath === '/' && req.method === 'GET') {
      const status = (url.searchParams.get('status') ?? 'pending') as ApprovalStatus | 'all';
      this.sendJson(res, 200, this.list(status));
      return;
    }

    // GET /stats
    if (subPath === '/stats' && req.method === 'GET') {
      this.sendJson(res, 200, this.stats());
      return;
    }

    // GET /sse
    if (subPath === '/sse' && req.method === 'GET') {
      this.addSSEClient(res);
      return;
    }

    // POST /:id/approve
    const approveMatch = subPath.match(/^\/([a-f0-9]+)\/approve$/);
    if (approveMatch && req.method === 'POST') {
      if (!this.checkAuth(req, res)) return;
      this.readBody(req).then((body) => {
        const approvedBy = typeof body.approvedBy === 'string' ? body.approvedBy : 'anonymous';
        const reason = typeof body.reason === 'string' ? body.reason : undefined;
        const entry = this.approve(approveMatch[1], approvedBy, reason);
        if (!entry) {
          this.sendJson(res, 404, { error: 'Approval not found or already resolved' });
        } else {
          this.sendJson(res, 200, entry);
        }
      }).catch(() => {
        this.sendJson(res, 400, { error: 'Invalid request body' });
      });
      return;
    }

    // POST /:id/deny
    const denyMatch = subPath.match(/^\/([a-f0-9]+)\/deny$/);
    if (denyMatch && req.method === 'POST') {
      if (!this.checkAuth(req, res)) return;
      this.readBody(req).then((body) => {
        const deniedBy = typeof body.deniedBy === 'string' ? body.deniedBy : undefined;
        const reason = typeof body.reason === 'string' ? body.reason : undefined;
        const entry = this.deny(denyMatch[1], deniedBy, reason);
        if (!entry) {
          this.sendJson(res, 404, { error: 'Approval not found or already resolved' });
        } else {
          this.sendJson(res, 200, entry);
        }
      }).catch(() => {
        this.sendJson(res, 400, { error: 'Invalid request body' });
      });
      return;
    }

    // GET /:id
    const idMatch = subPath.match(/^\/([a-f0-9]+)$/);
    if (idMatch && req.method === 'GET') {
      const entry = this.get(idMatch[1]);
      if (!entry) {
        this.sendJson(res, 404, { error: 'Approval not found' });
      } else {
        this.sendJson(res, 200, entry);
      }
      return;
    }

    this.sendJson(res, 404, { error: 'Not found' });
  }

  /**
   * Validates the Authorization: Bearer <secret> header on mutating requests.
   * Returns true if the request is authorized (or no secret is configured).
   * Sends a 401/403 response and returns false if authorization fails.
   * Uses constant-time comparison to prevent timing attacks (GHSA-mxjx-28vx-xjjj).
   */
  private checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (this.secret === null) return true; // no secret configured — allow (backward-compatible)
    const authHeader = req.headers['authorization'];
    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      this.sendJson(res, 401, { error: 'Authorization: Bearer <token> required' });
      return false;
    }
    const provided = Buffer.from(authHeader.slice(7));
    const expected = Buffer.from(this.secret);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      this.sendJson(res, 403, { error: 'Forbidden' });
      return false;
    }
    return true;
  }

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  private readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const maxSize = 16_384; // 16KB max

      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxSize) {
          req.destroy();
          reject(new Error('Request body too large'));
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const parsed: unknown = raw.length > 0 ? JSON.parse(raw) : {};
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            reject(new Error('Body must be a JSON object'));
          } else {
            resolve(parsed as Record<string, unknown>);
          }
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });

      req.on('error', reject);
    });
  }
}
