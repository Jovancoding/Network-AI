/**
 * ControlPlane — Unified multi-workspace dashboard server
 *
 * Provides a single HTTP + WebSocket server that aggregates multiple
 * WorkTrees and LockedBlackboards into one live dashboard. Users register
 * named workspaces; the browser UI lets operators switch between them
 * and view Task Trees, Agent orchestration, and Blackboard state.
 *
 * ```typescript
 * const cp = new ControlPlane({ port: 4800 });
 * cp.addWorkspace('feature-x', { tree: myTree, blackboard: myBB });
 * cp.addWorkspace('feature-y', { tree: otherTree });
 * await cp.start();
 * // Open http://127.0.0.1:4800
 * ```
 *
 * @module ControlPlane
 * @version 1.0.0
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Socket } from 'net';
import type { WorkTree, WorkTreeSnapshot } from './work-tree';
import type { LockedBlackboard, BlackboardEntry, PendingChange } from './locked-blackboard';

// ============================================================================
// TYPES
// ============================================================================

/** Configuration for a single workspace */
export interface WorkspaceConfig {
  /** Hierarchical task tree (enables Tree + Agents tabs) */
  tree?: WorkTree;
  /** Shared blackboard (enables Blackboard tab) */
  blackboard?: LockedBlackboard;
}

/** Runtime workspace state */
interface Workspace {
  name: string;
  config: WorkspaceConfig;
  orchestratorAgent: string | null;
  agentLogs: Map<string, AgentLogEntry[]>;
  orchestratorLogs: AgentLogEntry[];
  eventHandlers: Array<{ target: EventEmitter; event: string; handler: (...args: unknown[]) => void }>;
}

/** A log entry for an agent */
export interface AgentLogEntry {
  time: string;
  message: string;
  level: 'info' | 'warn' | 'error';
}

/** Agent info for the dashboard */
export interface CPAgentInfo {
  name: string;
  role: 'orchestrator' | 'worker';
  status: 'idle' | 'busy' | 'error';
  tasks: Array<{ id: string; label: string; status: string }>;
  currentTask: string | null;
  logs: AgentLogEntry[];
  tokens: number;
}

/** Workspace summary for the workspace picker */
export interface WorkspaceSummary {
  name: string;
  hasTree: boolean;
  hasBlackboard: boolean;
  nodeCount: number;
  progress: number;
  bbKeyCount: number;
}

/** Options for the ControlPlane */
export interface ControlPlaneOptions {
  /** TCP port (default: 4800) */
  port?: number;
  /** Hostname (default: '127.0.0.1') */
  host?: string;
}

/** Connected WebSocket client */
interface WSClient {
  id: string;
  send: (data: string) => void;
  close: () => void;
  alive: boolean;
  /** Which workspace this client is viewing (null = workspace list) */
  activeWorkspace: string | null;
}

// ============================================================================
// WEBSOCKET HELPERS (RFC 6455 minimal)
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

function getControlPlaneHTML(wsPort: number): string {
  const htmlPath = join(__dirname, 'control-plane.html');
  const html = readFileSync(htmlPath, 'utf-8');
  return html.replace('__WS_PORT__', String(wsPort));
}

// ============================================================================
// CONTROL PLANE
// ============================================================================

/**
 * Unified dashboard server for multiple WorkTrees and Blackboards.
 *
 * Register named workspaces, then open the browser to see them all.
 */
export class ControlPlane extends EventEmitter {
  private readonly port: number;
  private readonly host: string;
  private server: ReturnType<typeof createServer> | null = null;
  private clients: Map<string, WSClient> = new Map();
  private workspaces: Map<string, Workspace> = new Map();
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private bbPollInterval: ReturnType<typeof setInterval> | null = null;
  private clientCounter = 0;
  private pendingBroadcasts: Set<string> = new Set();

  constructor(options?: ControlPlaneOptions) {
    super();
    this.port = options?.port ?? 4800;
    this.host = options?.host ?? '127.0.0.1';
  }

  // --------------------------------------------------------------------------
  // WORKSPACE MANAGEMENT
  // --------------------------------------------------------------------------

  /**
   * Register a named workspace with an optional WorkTree and/or Blackboard.
   */
  addWorkspace(name: string, config: WorkspaceConfig): void {
    if (this.workspaces.has(name)) {
      throw new Error(`Workspace "${name}" already exists`);
    }
    const ws: Workspace = {
      name,
      config,
      orchestratorAgent: null,
      agentLogs: new Map(),
      orchestratorLogs: [],
      eventHandlers: [],
    };
    this.workspaces.set(name, ws);

    // Subscribe to tree events
    if (config.tree) {
      const events = ['node:added', 'node:removed', 'node:status', 'node:tokens', 'node:progress', 'tree:complete'];
      for (const eventName of events) {
        const handler = () => this.scheduleBroadcast(name);
        config.tree.on(eventName, handler);
        ws.eventHandlers.push({ target: config.tree as unknown as EventEmitter, event: eventName, handler });
      }
    }

    // Broadcast workspace list update
    this.broadcastWorkspaceList();
    this.emit('workspace:added', name);
  }

  /**
   * Remove a workspace.
   */
  removeWorkspace(name: string): boolean {
    const ws = this.workspaces.get(name);
    if (!ws) return false;

    // Unsubscribe
    for (const { target, event, handler } of ws.eventHandlers) {
      target.removeListener(event, handler);
    }

    this.workspaces.delete(name);

    // Disconnect clients viewing this workspace
    for (const client of this.clients.values()) {
      if (client.activeWorkspace === name) {
        client.activeWorkspace = null;
        client.send(JSON.stringify({ type: 'workspace_removed', name }));
      }
    }

    this.broadcastWorkspaceList();
    this.emit('workspace:removed', name);
    return true;
  }

  /**
   * Set the orchestrator agent for a workspace.
   */
  setOrchestrator(workspaceName: string, agentName: string): void {
    const ws = this.workspaces.get(workspaceName);
    if (!ws) throw new Error(`Workspace "${workspaceName}" not found`);
    ws.orchestratorAgent = agentName;
  }

  /**
   * Push a log entry to an agent in a workspace.
   */
  pushLog(workspaceName: string, agent: string, message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    const ws = this.workspaces.get(workspaceName);
    if (!ws) return;
    const entry: AgentLogEntry = { time: new Date().toLocaleTimeString(), message, level };

    if (!ws.agentLogs.has(agent)) ws.agentLogs.set(agent, []);
    const logs = ws.agentLogs.get(agent)!;
    logs.push(entry);
    if (logs.length > 100) logs.splice(0, logs.length - 100);

    if (agent === ws.orchestratorAgent) {
      ws.orchestratorLogs.push(entry);
      if (ws.orchestratorLogs.length > 50) ws.orchestratorLogs.splice(0, ws.orchestratorLogs.length - 50);
    }

    this.scheduleBroadcast(workspaceName);
  }

  /**
   * Push a narrative message to the orchestrator log for a workspace.
   */
  pushNarrative(workspaceName: string, message: string): void {
    const ws = this.workspaces.get(workspaceName);
    if (!ws) return;
    const entry: AgentLogEntry = { time: new Date().toLocaleTimeString(), message, level: 'info' };
    ws.orchestratorLogs.push(entry);
    if (ws.orchestratorLogs.length > 50) ws.orchestratorLogs.splice(0, ws.orchestratorLogs.length - 50);
    this.scheduleBroadcast(workspaceName);
  }

  /**
   * List all registered workspace names.
   */
  listWorkspaces(): string[] {
    return Array.from(this.workspaces.keys());
  }

  // --------------------------------------------------------------------------
  // SERVER LIFECYCLE
  // --------------------------------------------------------------------------

  /** Start the ControlPlane server. */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handleHTTP(req, res));
      server.on('upgrade', (req, socket) => this.handleUpgrade(req, socket as Socket));
      server.on('error', (err) => { this.emit('error', err); reject(err); });
      server.listen(this.port, this.host, () => {
        this.server = server;
        this.pingInterval = setInterval(() => this.pingClients(), 30000);
        // Poll blackboards every 500ms for changes
        this.bbPollInterval = setInterval(() => this.pollBlackboards(), 500);
        this.emit('listening', { port: this.port, host: this.host });
        resolve();
      });
    });
  }

  /** Stop the ControlPlane server. */
  async stop(): Promise<void> {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
    if (this.bbPollInterval) { clearInterval(this.bbPollInterval); this.bbPollInterval = null; }

    // Unsubscribe all workspace events
    for (const ws of this.workspaces.values()) {
      for (const { target, event, handler } of ws.eventHandlers) {
        target.removeListener(event, handler);
      }
      ws.eventHandlers = [];
    }

    for (const client of this.clients.values()) client.close();
    this.clients.clear();

    return new Promise((resolve) => {
      if (!this.server) { resolve(); return; }
      this.server.close(() => { this.server = null; resolve(); });
    });
  }

  /** Number of connected clients. */
  clientCount(): number { return this.clients.size; }

  /** Dashboard URL. */
  get url(): string { return `http://${this.host}:${this.port}`; }

  // --------------------------------------------------------------------------
  // HTTP
  // --------------------------------------------------------------------------

  private handleHTTP(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '/';

    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(getControlPlaneHTML(this.port));
      return;
    }

    if (url === '/api/workspaces') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(this.buildWorkspaceList()));
      return;
    }

    if (url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify({ status: 'ok', clients: this.clients.size, workspaces: this.workspaces.size }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  // --------------------------------------------------------------------------
  // WEBSOCKET
  // --------------------------------------------------------------------------

  private handleUpgrade(req: IncomingMessage, socket: Socket): void {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }

    const headers = [
      'HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${computeAcceptKey(key)}`, '', '',
    ].join('\r\n');
    socket.write(headers);

    const clientId = `ws-${++this.clientCounter}`;
    const client: WSClient = {
      id: clientId,
      send: (data: string) => { try { socket.write(encodeWSFrame(data)); } catch { /* disconnected */ } },
      close: () => { try { const f = Buffer.alloc(2); f[0] = 0x88; f[1] = 0; socket.write(f); socket.end(); } catch { /* closed */ } },
      alive: true,
      activeWorkspace: null,
    };

    this.clients.set(clientId, client);
    this.emit('client:connected', clientId);

    // Send workspace list
    client.send(JSON.stringify({ type: 'workspaces', list: this.buildWorkspaceList() }));

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const frame = decodeWSFrame(buffer);
      if (!frame) return;
      buffer = Buffer.alloc(0);

      if (frame.opcode === 0x08) { this.clients.delete(clientId); socket.end(); this.emit('client:disconnected', clientId); return; }
      if (frame.opcode === 0x0a) { client.alive = true; return; }

      if (frame.opcode === 0x01) {
        try {
          const msg = JSON.parse(frame.payload.toString('utf8'));
          this.handleClientMessage(client, msg);
        } catch { /* ignore */ }
      }
    });

    socket.on('close', () => { this.clients.delete(clientId); this.emit('client:disconnected', clientId); });
    socket.on('error', () => { this.clients.delete(clientId); });
  }

  private handleClientMessage(client: WSClient, msg: Record<string, unknown>): void {
    if (msg.action === 'select' && typeof msg.workspace === 'string') {
      const name = msg.workspace;
      if (this.workspaces.has(name)) {
        client.activeWorkspace = name;
        this.sendWorkspaceSnapshot(client, name);
      }
    } else if (msg.action === 'list') {
      client.send(JSON.stringify({ type: 'workspaces', list: this.buildWorkspaceList() }));
    }
  }

  // --------------------------------------------------------------------------
  // DATA BUILDING
  // --------------------------------------------------------------------------

  private buildWorkspaceList(): WorkspaceSummary[] {
    const list: WorkspaceSummary[] = [];
    for (const [name, ws] of this.workspaces.entries()) {
      const tree = ws.config.tree;
      const bb = ws.config.blackboard;
      list.push({
        name,
        hasTree: !!tree,
        hasBlackboard: !!bb,
        nodeCount: tree ? tree.stats().total : 0,
        progress: tree ? tree.stats().progress : 0,
        bbKeyCount: bb ? bb.listKeys().length : 0,
      });
    }
    return list;
  }

  private buildWorkspaceData(ws: Workspace): Record<string, unknown> {
    const data: Record<string, unknown> = {
      type: 'workspace_snapshot',
      name: ws.name,
      hasTree: !!ws.config.tree,
      hasBlackboard: !!ws.config.blackboard,
    };

    if (ws.config.tree) {
      const snap = ws.config.tree.snapshot();
      data.tree = { rootId: snap.rootId, nodes: snap.nodes, stats: snap.stats };
      data.agents = this.buildAgentMap(ws, snap);
      data.orchestratorLogs = ws.orchestratorLogs;
    }

    if (ws.config.blackboard) {
      const bb = ws.config.blackboard;
      data.blackboard = {
        entries: bb.getSnapshot(),
        pending: bb.listPendingChanges(),
        lock: bb.getLockStatus(),
        paused: bb.isPaused(),
      };
    }

    return data;
  }

  private buildAgentMap(ws: Workspace, snap: WorkTreeSnapshot): Record<string, CPAgentInfo> {
    const agents: Record<string, CPAgentInfo> = {};

    for (const id of Object.keys(snap.nodes)) {
      const node = snap.nodes[id];
      if (!node.agent) continue;
      const name = node.agent;
      if (!agents[name]) {
        agents[name] = {
          name,
          role: name === ws.orchestratorAgent ? 'orchestrator' : 'worker',
          status: 'idle',
          tasks: [],
          currentTask: null,
          logs: ws.agentLogs.get(name) ?? [],
          tokens: 0,
        };
      }
      const a = agents[name];
      a.tasks.push({ id: node.id, label: node.label, status: node.status });
      a.tokens += node.ownTokens ?? 0;
      if (node.status === 'running') { a.status = 'busy'; a.currentTask = node.label; }
      if (node.status === 'failed') a.status = 'error';
    }

    // Include agents with logs but no nodes
    for (const [name, logs] of ws.agentLogs.entries()) {
      if (!agents[name]) {
        agents[name] = { name, role: name === ws.orchestratorAgent ? 'orchestrator' : 'worker', status: 'idle', tasks: [], currentTask: null, logs, tokens: 0 };
      }
    }

    return agents;
  }

  // --------------------------------------------------------------------------
  // BROADCAST
  // --------------------------------------------------------------------------

  private sendWorkspaceSnapshot(client: WSClient, name: string): void {
    const ws = this.workspaces.get(name);
    if (!ws) return;
    client.send(JSON.stringify(this.buildWorkspaceData(ws)));
  }

  private scheduleBroadcast(workspaceName: string): void {
    if (this.pendingBroadcasts.has(workspaceName)) return;
    this.pendingBroadcasts.add(workspaceName);

    queueMicrotask(() => {
      this.pendingBroadcasts.delete(workspaceName);
      const ws = this.workspaces.get(workspaceName);
      if (!ws) return;

      const data = JSON.stringify(this.buildWorkspaceData(ws));
      for (const client of this.clients.values()) {
        if (client.activeWorkspace === workspaceName) {
          client.send(data);
        }
      }

      // Also broadcast workspace list (progress may have changed)
      this.broadcastWorkspaceList();
    });
  }

  private broadcastWorkspaceList(): void {
    if (this.clients.size === 0) return;
    const data = JSON.stringify({ type: 'workspaces', list: this.buildWorkspaceList() });
    for (const client of this.clients.values()) {
      client.send(data);
    }
  }

  /** Track last BB snapshot hashes for change detection */
  private bbHashes: Map<string, string> = new Map();

  private pollBlackboards(): void {
    for (const [name, ws] of this.workspaces.entries()) {
      if (!ws.config.blackboard) continue;
      const bb = ws.config.blackboard;
      const keys = bb.listKeys();
      const hash = keys.join(',') + ':' + keys.map(k => {
        const e = bb.getSnapshot()[k];
        return e ? `${e.version}` : '';
      }).join(',');
      const prev = this.bbHashes.get(name);
      if (prev !== hash) {
        this.bbHashes.set(name, hash);
        if (prev !== undefined) { // Skip first poll
          this.scheduleBroadcast(name);
        }
      }
    }
  }

  private pingClients(): void {
    for (const [id, client] of this.clients.entries()) {
      if (!client.alive) { this.clients.delete(id); client.close(); this.emit('client:disconnected', id); continue; }
      client.alive = false;
    }
  }
}
