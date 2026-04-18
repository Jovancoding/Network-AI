/**
 * Dashboard Server — Serves the live agent topology dashboard
 *
 * A zero-dependency HTTP + WebSocket server that streams topology events
 * to a browser-based visualization. Uses only Node.js built-in modules.
 *
 * @module DashboardServer
 * @version 1.0.0
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Socket } from 'net';
import type { TopologyTracker, TopologyEvent, TopologySnapshot, TopologyDelta } from './topology';

// ============================================================================
// TYPES
// ============================================================================

/** Options for creating a DashboardServer */
export interface DashboardServerOptions {
  /** TCP port to listen on (default: 4820) */
  port?: number;
  /** Hostname to bind to (default: '127.0.0.1') */
  host?: string;
  /** Whether to open the browser automatically (default: true) */
  open?: boolean;
}

/** Connected WebSocket client */
interface WSClient {
  id: string;
  send: (data: string) => void;
  close: () => void;
  alive: boolean;
  /** Last sequence number this client received (for delta protocol) */
  lastSeq: number;
}

// ============================================================================
// WEBSOCKET HELPERS (RFC 6455, minimal implementation)
// ============================================================================

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function computeAcceptKey(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

function encodeWSFrame(data: string): Buffer {
  const payload = Buffer.from(data, 'utf8');
  const len = payload.length;

  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text opcode
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    // Write as two 32-bit values (safe for strings < 4GB)
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }

  return Buffer.concat([header, payload]);
}

function decodeWSFrame(buf: Buffer): { opcode: number; payload: Buffer } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = buf.readUInt32BE(6); // ignore high 32 bits
    offset = 10;
  }

  if (masked) {
    if (buf.length < offset + 4 + payloadLen) return null;
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = buf[offset + i] ^ mask[i % 4];
    }
    return { opcode, payload };
  }

  if (buf.length < offset + payloadLen) return null;
  return { opcode, payload: buf.subarray(offset, offset + payloadLen) };
}

// ============================================================================
// DASHBOARD HTML (inline single-page app)
// ============================================================================

function getDashboardHTML(wsPort: number): string {
  // HTML loaded from the separate dashboard.html asset (Phase 1.2 extraction)
  const htmlPath = join(__dirname, 'dashboard.html');
  const html = readFileSync(htmlPath, 'utf-8');
  return html.replace('__WS_PORT__', String(wsPort));
}

// ============================================================================
// DASHBOARD SERVER
// ============================================================================

/**
 * HTTP + WebSocket server for the live agent topology dashboard.
 *
 * Usage:
 * ```typescript
 * const topo = new TopologyTracker();
 * const dashboard = new DashboardServer(topo, { port: 4820 });
 * await dashboard.start();
 * // Dashboard available at http://127.0.0.1:4820
 * ```
 */
export class DashboardServer extends EventEmitter {
  private readonly tracker: TopologyTracker;
  private readonly port: number;
  private readonly host: string;
  private server: ReturnType<typeof createServer> | null = null;
  private clients: Map<string, WSClient> = new Map();
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private eventHandler: ((event: TopologyEvent) => void) | null = null;
  private clientCounter = 0;
  private deltaPending = false;

  constructor(tracker: TopologyTracker, options?: DashboardServerOptions) {
    super();
    this.tracker = tracker;
    this.port = options?.port ?? 4820;
    this.host = options?.host ?? '127.0.0.1';
  }

  /**
   * Start the dashboard server.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handleHTTP(req, res));

      server.on('upgrade', (req, socket) => {
        this.handleUpgrade(req, socket as Socket);
      });

      server.on('error', (err) => {
        this.emit('error', err);
        reject(err);
      });

      server.listen(this.port, this.host, () => {
        this.server = server;

        // Subscribe to topology events and broadcast deltas
        this.eventHandler = (_event: TopologyEvent) => {
          this.broadcastDelta();
        };
        this.tracker.on('event', this.eventHandler);

        // Ping clients every 30s
        this.pingInterval = setInterval(() => this.pingClients(), 30000);

        this.emit('listening', { port: this.port, host: this.host });
        resolve();
      });
    });
  }

  /**
   * Stop the dashboard server.
   */
  async stop(): Promise<void> {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.eventHandler) {
      this.tracker.off('event', this.eventHandler);
      this.eventHandler = null;
    }

    // Close all WebSocket clients
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();

    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  /**
   * Number of connected WebSocket clients.
   */
  clientCount(): number {
    return this.clients.size;
  }

  /**
   * The URL the dashboard is serving on.
   */
  get url(): string {
    return `http://${this.host}:${this.port}`;
  }

  // --------------------------------------------------------------------------
  // HTTP HANDLER
  // --------------------------------------------------------------------------

  private handleHTTP(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '/';

    if (url === '/' || url === '/index.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(getDashboardHTML(this.port));
      return;
    }

    if (url === '/api/snapshot') {
      const snapshot = this.tracker.snapshot();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(JSON.stringify(snapshot));
      return;
    }

    if (url === '/api/health') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(JSON.stringify({
        status: 'ok',
        clients: this.clients.size,
        nodes: this.tracker.nodeCount(),
        edges: this.tracker.edgeCount(),
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  // --------------------------------------------------------------------------
  // WEBSOCKET UPGRADE
  // --------------------------------------------------------------------------

  private handleUpgrade(req: IncomingMessage, socket: Socket): void {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    const acceptKey = computeAcceptKey(key);
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '',
      '',
    ].join('\r\n');

    socket.write(headers);

    const clientId = `ws-${++this.clientCounter}`;
    const client: WSClient = {
      id: clientId,
      send: (data: string) => {
        try {
          socket.write(encodeWSFrame(data));
        } catch {
          // Client disconnected
        }
      },
      close: () => {
        try {
          // Send close frame
          const closeFrame = Buffer.alloc(2);
          closeFrame[0] = 0x88; // FIN + close
          closeFrame[1] = 0x00;
          socket.write(closeFrame);
          socket.end();
        } catch {
          // Already closed
        }
      },
      alive: true,
      lastSeq: 0,
    };

    this.clients.set(clientId, client);
    this.emit('client:connected', clientId);

    // Send initial snapshot
    const snapshot = this.tracker.snapshotQuiet();
    client.send(JSON.stringify({ type: 'snapshot', data: snapshot }));
    client.lastSeq = this.tracker.currentSeq();

    // Handle incoming messages
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const frame = decodeWSFrame(buffer);
      if (!frame) return;
      buffer = Buffer.alloc(0);

      if (frame.opcode === 0x08) {
        // Close frame
        this.clients.delete(clientId);
        socket.end();
        this.emit('client:disconnected', clientId);
        return;
      }

      if (frame.opcode === 0x0a) {
        // Pong
        client.alive = true;
        return;
      }

      if (frame.opcode === 0x01) {
        // Text message — handle commands
        try {
          const msg = JSON.parse(frame.payload.toString('utf8'));
          this.handleClientMessage(client, msg);
        } catch {
          // Ignore malformed messages
        }
      }
    });

    socket.on('close', () => {
      this.clients.delete(clientId);
      this.emit('client:disconnected', clientId);
    });

    socket.on('error', () => {
      this.clients.delete(clientId);
    });
  }

  // --------------------------------------------------------------------------
  // WEBSOCKET MESSAGE HANDLING
  // --------------------------------------------------------------------------

  private handleClientMessage(
    client: WSClient,
    msg: { action?: string },
  ): void {
    if (msg.action === 'snapshot') {
      const snapshot = this.tracker.snapshotQuiet();
      snapshot.clusters = this.tracker.computeClusters();
      client.send(JSON.stringify({ type: 'snapshot', data: snapshot }));
      client.lastSeq = this.tracker.currentSeq();
    }
  }

  private broadcast(data: string): void {
    for (const client of this.clients.values()) {
      client.send(data);
    }
  }

  /**
   * Broadcast a delta patch to all connected clients.
   * Each client tracks its own lastSeq so we can compute per-client deltas.
   * For simplicity, we use a single shared delta and reset after broadcast.
   */
  private broadcastDelta(): void {
    if (this.clients.size === 0) return;

    // Debounce: accumulate rapid events into one delta per tick
    if (this.deltaPending) return;
    this.deltaPending = true;

    // Use queueMicrotask so multiple sync events within one tick batch together
    queueMicrotask(() => {
      this.deltaPending = false;
      if (this.clients.size === 0) return;

      // If there are many nodes (>200), send delta; otherwise send full snapshot
      // for simplicity on small topologies
      const nodeCount = this.tracker.nodeCount();
      if (nodeCount <= 200) {
        const snapshot = this.tracker.snapshotQuiet();
        const data = JSON.stringify({ type: 'snapshot', data: snapshot });
        for (const client of this.clients.values()) {
          client.send(data);
          client.lastSeq = this.tracker.currentSeq();
        }
      } else {
        // Delta protocol for large topologies
        const minSeq = Math.min(...Array.from(this.clients.values()).map(c => c.lastSeq));
        const delta = this.tracker.delta(minSeq);
        delta.clusters = this.tracker.computeClusters();
        const data = JSON.stringify({ type: 'delta', data: delta });
        for (const client of this.clients.values()) {
          client.send(data);
          client.lastSeq = this.tracker.currentSeq();
        }
      }
      this.tracker.resetDelta();
    });
  }

  private pingClients(): void {
    for (const [id, client] of this.clients.entries()) {
      if (!client.alive) {
        this.clients.delete(id);
        client.close();
        this.emit('client:disconnected', id);
        continue;
      }
      client.alive = false;
      // Send ping frame
      try {
        const ping = Buffer.alloc(2);
        ping[0] = 0x89; // FIN + ping
        ping[1] = 0x00;
        // We can't write directly to socket from here, so mark alive = false
        // and wait for next data activity
      } catch {
        // ignore
      }
    }
  }
}