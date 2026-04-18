/**
 * WorkTreeDashboard — Browser-based live WorkTree visualization
 *
 * Serves a single-page HTML dashboard over HTTP and streams WorkTree
 * state changes over WebSocket. Zero external dependencies — uses only
 * Node.js built-in modules.
 *
 * Follows the same architecture as {@link DashboardServer} for the
 * TopologyTracker but renders a hierarchical task tree instead of a
 * force-directed graph.
 *
 * @module WorkTreeDashboard
 * @version 1.0.0
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Socket } from 'net';
import type { WorkTree, WorkNode, WorkTreeStats, WorkTreeSnapshot } from './work-tree';

// ============================================================================
// TYPES
// ============================================================================

/** Options for WorkTreeDashboard */
export interface WorkTreeDashboardOptions {
  /** TCP port to listen on (default: 4821) */
  port?: number;
  /** Hostname to bind to (default: '127.0.0.1') */
  host?: string;
}

/** Connected WebSocket client */
interface WSClient {
  id: string;
  send: (data: string) => void;
  close: () => void;
  alive: boolean;
}

/** A single agent log entry */
export interface AgentLogEntry {
  time: string;
  message: string;
  level: 'info' | 'warn' | 'error';
}

/** Agent state as sent to the dashboard */
export interface DashboardAgentInfo {
  name: string;
  role: 'orchestrator' | 'worker';
  status: 'idle' | 'busy' | 'error';
  tasks: Array<{ id: string; label: string; status: string }>;
  currentTask: string | null;
  logs: AgentLogEntry[];
  tokens: number;
}

/** A detected system-wide diagnostic entry */
export interface SystemDiagnostic {
  level: 'info' | 'warn' | 'error';
  category: string;
  message: string;
  agent?: string;
  taskId?: string;
}

/** System health summary sent to the dashboard */
export interface SystemHealth {
  status: 'healthy' | 'warning' | 'critical';
  summary: string;
  diagnostics: SystemDiagnostic[];
}

// ============================================================================
// WEBSOCKET HELPERS (RFC 6455 minimal — same as dashboard-server)
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
    header[0] = 0x81;
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
    payloadLen = buf.readUInt32BE(6);
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
// HTML LOADER
// ============================================================================

function getDashboardHTML(wsPort: number): string {
  const htmlPath = join(__dirname, 'work-tree-dashboard.html');
  const html = readFileSync(htmlPath, 'utf-8');
  return html.replace('__WS_PORT__', String(wsPort));
}

// ============================================================================
// WORK TREE DASHBOARD
// ============================================================================

/**
 * HTTP + WebSocket server for live WorkTree visualization.
 *
 * ```typescript
 * const tree = new WorkTree('root', 'My Project');
 * const dashboard = new WorkTreeDashboard(tree, { port: 4821 });
 * await dashboard.start();
 * // Open http://127.0.0.1:4821 in your browser
 * ```
 */
export class WorkTreeDashboard extends EventEmitter {
  private readonly tree: WorkTree;
  private readonly port: number;
  private readonly host: string;
  private server: ReturnType<typeof createServer> | null = null;
  private clients: Map<string, WSClient> = new Map();
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private eventHandlers: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];
  private clientCounter = 0;
  private deltaPending = false;
  private agentLogs: Map<string, AgentLogEntry[]> = new Map();
  private orchestratorLogs: AgentLogEntry[] = [];
  private orchestratorAgent: string | null = null;

  constructor(tree: WorkTree, options?: WorkTreeDashboardOptions) {
    super();
    this.tree = tree;
    this.port = options?.port ?? 4821;
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
        this.subscribeToTree();

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

    this.unsubscribeFromTree();

    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();

    return new Promise((resolve) => {
      if (!this.server) { resolve(); return; }
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  /** Number of connected WebSocket clients. */
  clientCount(): number {
    return this.clients.size;
  }

  /** The URL the dashboard is serving on. */
  get url(): string {
    return `http://${this.host}:${this.port}`;
  }

  /**
   * Designate an agent as the orchestrator (shown at the top of the Agents tab).
   */
  setOrchestrator(agentName: string): void {
    this.orchestratorAgent = agentName;
  }

  /**
   * Push a log entry for an agent. Triggers a broadcast to connected clients.
   *
   * @param agent  - The agent name (must match `node.agent` in the tree)
   * @param message - Log message text
   * @param level   - Severity: 'info' | 'warn' | 'error' (default: 'info')
   */
  pushLog(agent: string, message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    const entry: AgentLogEntry = {
      time: new Date().toLocaleTimeString(),
      message,
      level,
    };

    if (!this.agentLogs.has(agent)) {
      this.agentLogs.set(agent, []);
    }
    const logs = this.agentLogs.get(agent)!;
    logs.push(entry);
    // Keep max 100 entries per agent
    if (logs.length > 100) logs.splice(0, logs.length - 100);

    // Also add to orchestrator narrative if it's the orchestrator
    if (agent === this.orchestratorAgent) {
      this.orchestratorLogs.push(entry);
      if (this.orchestratorLogs.length > 50) {
        this.orchestratorLogs.splice(0, this.orchestratorLogs.length - 50);
      }
    }

    this.broadcastUpdate();
  }

  /**
   * Push a narrative message to the orchestrator log (not tied to a specific agent).
   */
  pushNarrative(message: string): void {
    const entry: AgentLogEntry = {
      time: new Date().toLocaleTimeString(),
      message,
      level: 'info',
    };
    this.orchestratorLogs.push(entry);
    if (this.orchestratorLogs.length > 50) {
      this.orchestratorLogs.splice(0, this.orchestratorLogs.length - 50);
    }
    this.broadcastUpdate();
  }

  // --------------------------------------------------------------------------
  // TREE EVENT SUBSCRIPTION
  // --------------------------------------------------------------------------

  private subscribeToTree(): void {
    const events = [
      'node:added', 'node:removed', 'node:status',
      'node:tokens', 'node:progress', 'tree:complete',
    ];

    for (const eventName of events) {
      const handler = (..._args: unknown[]) => {
        this.broadcastUpdate();
      };
      this.tree.on(eventName, handler);
      this.eventHandlers.push({ event: eventName, handler });
    }
  }

  private unsubscribeFromTree(): void {
    for (const { event, handler } of this.eventHandlers) {
      this.tree.removeListener(event, handler);
    }
    this.eventHandlers = [];
  }

  // --------------------------------------------------------------------------
  // HTTP
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
      const snapshot = this.tree.snapshot();
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
      const stats = this.tree.stats();
      res.end(JSON.stringify({
        status: 'ok',
        clients: this.clients.size,
        nodes: stats.total,
        progress: stats.progress,
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
    if (!key) { socket.destroy(); return; }

    const acceptKey = computeAcceptKey(key);
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '', '',
    ].join('\r\n');

    socket.write(headers);

    const clientId = `ws-${++this.clientCounter}`;
    const client: WSClient = {
      id: clientId,
      send: (data: string) => {
        try { socket.write(encodeWSFrame(data)); } catch { /* disconnected */ }
      },
      close: () => {
        try {
          const closeFrame = Buffer.alloc(2);
          closeFrame[0] = 0x88;
          closeFrame[1] = 0x00;
          socket.write(closeFrame);
          socket.end();
        } catch { /* already closed */ }
      },
      alive: true,
    };

    this.clients.set(clientId, client);
    this.emit('client:connected', clientId);

    // Send initial snapshot
    this.sendSnapshot(client);

    // Handle incoming messages
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const frame = decodeWSFrame(buffer);
      if (!frame) return;
      buffer = Buffer.alloc(0);

      if (frame.opcode === 0x08) {
        this.clients.delete(clientId);
        socket.end();
        this.emit('client:disconnected', clientId);
        return;
      }

      if (frame.opcode === 0x0a) {
        client.alive = true;
        return;
      }

      if (frame.opcode === 0x01) {
        try {
          const msg = JSON.parse(frame.payload.toString('utf8'));
          if (msg.action === 'snapshot') {
            this.sendSnapshot(client);
          }
        } catch { /* ignore malformed */ }
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
  // BROADCAST
  // --------------------------------------------------------------------------

  private sendSnapshot(client: WSClient): void {
    const snap = this.tree.snapshot();
    const agents = this.buildAgentMap(snap);
    const diagnostics = this.computeDiagnostics(snap, agents);
    client.send(JSON.stringify({
      type: 'snapshot',
      rootId: snap.rootId,
      nodes: snap.nodes,
      stats: snap.stats,
      agents,
      orchestratorLogs: this.orchestratorLogs,
      diagnostics,
    }));
  }

  /**
   * Broadcast a delta (changed nodes + stats) to all clients.
   * Debounced via queueMicrotask to batch rapid events per tick.
   */
  private broadcastUpdate(): void {
    if (this.clients.size === 0) return;
    if (this.deltaPending) return;
    this.deltaPending = true;

    queueMicrotask(() => {
      this.deltaPending = false;
      if (this.clients.size === 0) return;

      // For WorkTree we always send full snapshots since trees are typically
      // small (hundreds of nodes max) and the snapshot is cheap.
      const snap = this.tree.snapshot();
      const agents = this.buildAgentMap(snap);
      const diagnostics = this.computeDiagnostics(snap, agents);
      const data = JSON.stringify({
        type: 'snapshot',
        rootId: snap.rootId,
        nodes: snap.nodes,
        stats: snap.stats,
        agents,
        orchestratorLogs: this.orchestratorLogs,
        diagnostics,
      });

      for (const client of this.clients.values()) {
        client.send(data);
      }
    });
  }

  /**
   * Build agent map from tree snapshot + stored logs.
   */
  private buildAgentMap(snap: WorkTreeSnapshot): Record<string, DashboardAgentInfo> {
    const agents: Record<string, DashboardAgentInfo> = {};

    for (const id of Object.keys(snap.nodes)) {
      const node = snap.nodes[id];
      if (!node.agent) continue;
      const name = node.agent;
      if (!agents[name]) {
        agents[name] = {
          name,
          role: name === this.orchestratorAgent ? 'orchestrator' : 'worker',
          status: 'idle',
          tasks: [],
          currentTask: null,
          logs: this.agentLogs.get(name) ?? [],
          tokens: 0,
        };
      }
      const a = agents[name];
      a.tasks.push({ id: node.id, label: node.label, status: node.status });
      a.tokens += node.ownTokens ?? 0;
      if (node.status === 'running') {
        a.status = 'busy';
        a.currentTask = node.label;
      }
      if (node.status === 'failed') {
        a.status = 'error';
      }
    }

    // Include agents that have logs but no tree nodes
    for (const [name, logs] of this.agentLogs.entries()) {
      if (!agents[name]) {
        agents[name] = {
          name,
          role: name === this.orchestratorAgent ? 'orchestrator' : 'worker',
          status: 'idle',
          tasks: [],
          currentTask: null,
          logs,
          tokens: 0,
        };
      }
    }

    return agents;
  }

  /**
   * Analyze system state and detect issues, stalls, and failures.
   */
  private computeDiagnostics(
    snap: WorkTreeSnapshot,
    agents: Record<string, DashboardAgentInfo>,
  ): SystemHealth {
    const issues: SystemDiagnostic[] = [];

    // Detect failed agents
    for (const [name, agent] of Object.entries(agents)) {
      if (agent.status === 'error') {
        const errorLogs = agent.logs.filter(l => l.level === 'error');
        const lastError = errorLogs.length > 0
          ? errorLogs[errorLogs.length - 1].message
          : 'Unknown error';
        issues.push({
          level: 'error',
          category: 'agent_failure',
          message: `${name} failed: ${lastError}`,
          agent: name,
        });
      }
    }

    // Detect failed tasks
    for (const [id, node] of Object.entries(snap.nodes)) {
      if (node.status === 'failed') {
        issues.push({
          level: 'error',
          category: 'task_failure',
          message: `Task "${node.label}" failed${node.agent ? ` (${node.agent})` : ''}`,
          agent: node.agent,
          taskId: id,
        });
      }
    }

    // Detect blocked tasks
    const blockedCount = snap.stats.blocked;
    if (blockedCount > 0) {
      issues.push({
        level: 'warn',
        category: 'blocked_tasks',
        message: `${blockedCount} task${blockedCount > 1 ? 's' : ''} blocked`,
      });
    }

    // Detect stalled running tasks (no update for >60s)
    for (const [id, node] of Object.entries(snap.nodes)) {
      if (node.status === 'running') {
        const age = Date.now() - new Date(node.updatedAt).getTime();
        if (age > 60_000) {
          issues.push({
            level: 'warn',
            category: 'stalled_task',
            message: `"${node.label}" running ${Math.round(age / 1000)}s with no update`,
            agent: node.agent,
            taskId: id,
          });
        }
      }
    }

    // Detect idle agents with pending work available
    const pendingCount = Object.values(snap.nodes).filter(n => n.status === 'pending').length;
    if (pendingCount > 0) {
      for (const [name, agent] of Object.entries(agents)) {
        if (agent.status === 'idle' && agent.role !== 'orchestrator') {
          issues.push({
            level: 'info',
            category: 'idle_agent',
            message: `${name} idle — ${pendingCount} task${pendingCount > 1 ? 's' : ''} waiting`,
            agent: name,
          });
        }
      }
    }

    // Overall status
    const hasErrors = issues.some(i => i.level === 'error');
    const hasWarns = issues.some(i => i.level === 'warn');
    const status: SystemHealth['status'] = hasErrors ? 'critical' : hasWarns ? 'warning' : 'healthy';

    // Generate summary
    const { stats } = snap;
    const parts: string[] = [];
    parts.push(`${Math.round(stats.progress * 100)}% complete (${stats.completed}/${stats.total} tasks).`);

    const busyAgents = Object.values(agents).filter(a => a.status === 'busy');
    if (busyAgents.length > 0) {
      parts.push(`${busyAgents.length} agent${busyAgents.length > 1 ? 's' : ''} active: ${busyAgents.map(a => a.name).join(', ')}.`);
    }
    if (stats.failed > 0) {
      parts.push(`${stats.failed} task${stats.failed > 1 ? 's' : ''} failed.`);
    }
    if (stats.running > 0) {
      parts.push(`${stats.running} in progress.`);
    }
    if (stats.pending > 0 && stats.running === 0 && stats.completed < stats.total) {
      parts.push(`${stats.pending} waiting.`);
    }
    if (stats.progress >= 1) {
      parts.push('All tasks complete.');
    }

    return { status, summary: parts.join(' '), diagnostics: issues };
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
    }
  }
}
