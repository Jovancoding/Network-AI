/**
 * Agent Runtime — Sandboxed execution environment for AI agents
 *
 * Provides controlled access to shell commands, file system, and system
 * resources with policy enforcement, approval gates, and audit logging.
 *
 * Components:
 *   - SandboxPolicy — defines what agents are allowed to do
 *   - ShellExecutor — spawns child processes within policy constraints
 *   - FileAccessor — scoped file read/write with traversal protection
 *   - ApprovalGate — human-in-the-loop approval for sensitive operations
 *   - AgentRuntime — unified facade combining all components
 *
 * @module AgentRuntime
 * @version 1.0.0
 */

import { spawn } from 'child_process';
import { readFile, writeFile, readdir, stat, mkdir } from 'fs/promises';
import { join, normalize, isAbsolute, resolve, dirname } from 'path';
import { EventEmitter } from 'events';

// ============================================================================
// TYPES
// ============================================================================

/** Result of a shell command execution */
export interface ShellResult {
  /** Exit code (0 = success) */
  exitCode: number;
  /** Standard output */
  stdout: string;
  /** Standard error output */
  stderr: string;
  /** Execution time in milliseconds */
  durationMs: number;
  /** Whether the command was terminated due to timeout */
  timedOut: boolean;
  /** Whether the command was killed due to output limit */
  truncated: boolean;
}

/** Options for shell execution */
export interface ShellOptions {
  /** Working directory (defaults to policy basePath) */
  cwd?: string;
  /** Environment variables to merge with process.env */
  env?: Record<string, string>;
  /** Command timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Maximum output bytes (default: 1048576 = 1MB) */
  maxOutputBytes?: number;
  /** Whether this command requires human approval (auto-detected from policy if not set) */
  requiresApproval?: boolean;
  /** Agent ID requesting execution */
  agentId?: string;
}

/** File operation result */
export interface FileResult {
  success: boolean;
  path: string;
  content?: string;
  entries?: string[];
  error?: string;
  durationMs: number;
}

/** Sandbox policy configuration */
export interface SandboxPolicyConfig {
  /** Base directory agents are scoped to */
  basePath: string;
  /** Allowed command patterns (globs). Empty = deny all. */
  allowedCommands: string[];
  /** Blocked command patterns (override allowed). Always enforced. */
  blockedCommands: string[];
  /** Allowed directory paths for file access (relative to basePath) */
  allowedPaths: string[];
  /** Blocked directory paths (override allowed) */
  blockedPaths: string[];
  /** Maximum concurrent processes (default: 5) */
  maxConcurrentProcesses: number;
  /** Default command timeout in ms (default: 30000) */
  defaultTimeoutMs: number;
  /** Default max output bytes (default: 1MB) */
  defaultMaxOutputBytes: number;
  /** Commands that always require approval (patterns) */
  approvalRequired: string[];
  /** Whether read-only file operations auto-approve (default: true) */
  autoApproveReads: boolean;
}

/** Approval request passed to the approval callback */
export interface ApprovalRequest {
  /** Type of operation */
  type: 'shell' | 'file_write' | 'file_read' | 'file_list';
  /** The command or path being requested */
  target: string;
  /** Agent ID making the request */
  agentId: string;
  /** Why the agent needs this */
  justification?: string;
  /** Risk assessment */
  risk: 'low' | 'medium' | 'high';
  /** Timestamp of request */
  timestamp: number;
}

/** Approval decision from the human/callback */
export interface ApprovalDecision {
  approved: boolean;
  approvedBy?: string;
  reason?: string;
}

/** Callback function for approval decisions */
export type ApprovalCallback = (request: ApprovalRequest) => Promise<ApprovalDecision>;

/** Audit entry for runtime operations */
export interface RuntimeAuditEntry {
  timestamp: string;
  action: 'shell_execute' | 'file_read' | 'file_write' | 'file_list' | 'approval_requested' | 'approval_granted' | 'approval_denied' | 'policy_violation';
  agentId: string;
  target: string;
  result: 'success' | 'denied' | 'error' | 'timeout' | 'blocked';
  details?: Record<string, unknown>;
  durationMs?: number;
}

/** Events emitted by AgentRuntime */
export interface RuntimeEvents {
  'approval:requested': (request: ApprovalRequest) => void;
  'approval:decided': (request: ApprovalRequest, decision: ApprovalDecision) => void;
  'command:start': (agentId: string, command: string) => void;
  'command:complete': (agentId: string, command: string, result: ShellResult) => void;
  'file:access': (agentId: string, path: string, mode: 'read' | 'write' | 'list') => void;
  'policy:violation': (agentId: string, target: string, reason: string) => void;
  'audit': (entry: RuntimeAuditEntry) => void;
}

/** Options for creating an AgentRuntime */
export interface AgentRuntimeOptions {
  policy: Partial<SandboxPolicyConfig> & { basePath: string };
  onApproval?: ApprovalCallback;
  autoApproveAll?: boolean;
}

// ============================================================================
// SANDBOX POLICY
// ============================================================================

const DEFAULT_POLICY: Omit<SandboxPolicyConfig, 'basePath'> = {
  allowedCommands: [],
  blockedCommands: [
    'rm -rf /',
    'rm -rf /*',
    'rmdir /s /q C:\\',
    'format *',
    'mkfs*',
    'dd if=*',
    ':(){:|:&};:',        // fork bomb
    'shutdown*',
    'reboot*',
    'halt*',
    'init 0',
    'init 6',
    'del /f /s /q C:\\*',
    'reg delete*',
    'net user*',
    'net localgroup*',
  ],
  allowedPaths: ['.'],
  blockedPaths: [],
  maxConcurrentProcesses: 5,
  defaultTimeoutMs: 30_000,
  defaultMaxOutputBytes: 1_048_576,
  approvalRequired: [
    'rm *',
    'del *',
    'rmdir *',
    'git push*',
    'git reset --hard*',
    'npm publish*',
    'docker *',
    'kubectl *',
  ],
  autoApproveReads: true,
};

/**
 * Sandbox policy engine — determines what agents are allowed to do.
 *
 * @example
 * ```typescript
 * const policy = new SandboxPolicy({
 *   basePath: '/project',
 *   allowedCommands: ['npm *', 'node *', 'git status'],
 * });
 * policy.isCommandAllowed('npm test'); // true
 * policy.isCommandAllowed('rm -rf /'); // false
 * ```
 */
export class SandboxPolicy {
  private readonly config: SandboxPolicyConfig;

  constructor(config: Partial<SandboxPolicyConfig> & { basePath: string }) {
    this.config = { ...DEFAULT_POLICY, ...config };
    this.config.basePath = resolve(this.config.basePath);
  }

  /** Check if a command matches the policy's allowed list and isn't blocked */
  isCommandAllowed(command: string): boolean {
    const trimmed = command.trim();
    if (!trimmed) return false;

    // Check blocked first (always wins)
    if (this.matchesAny(trimmed, this.config.blockedCommands)) return false;

    // If no allowedCommands, deny all
    if (this.config.allowedCommands.length === 0) return false;

    // Check allowed
    return this.matchesAny(trimmed, this.config.allowedCommands);
  }

  /** Check if a command requires human approval */
  requiresApproval(command: string): boolean {
    return this.matchesAny(command.trim(), this.config.approvalRequired);
  }

  /** Assess risk level of a command */
  assessRisk(command: string): 'low' | 'medium' | 'high' {
    const trimmed = command.trim().toLowerCase();
    const highRisk = ['rm ', 'del ', 'format', 'drop ', 'delete ', 'truncate ', 'git push', 'git reset', 'docker', 'kubectl'];
    const medRisk = ['git ', 'npm ', 'pip ', 'mv ', 'move ', 'cp ', 'copy ', 'chmod ', 'chown '];

    if (highRisk.some(p => trimmed.startsWith(p) || trimmed.includes(' ' + p))) return 'high';
    if (medRisk.some(p => trimmed.startsWith(p) || trimmed.includes(' ' + p))) return 'medium';
    return 'low';
  }

  /** Validate that a file path is within allowed scope */
  isPathAllowed(filePath: string): boolean {
    const normalized = this.resolvePath(filePath);
    if (!normalized) return false;

    // Check blocked paths
    for (const blocked of this.config.blockedPaths) {
      const blockedAbs = resolve(this.config.basePath, blocked);
      if (normalized.startsWith(blockedAbs)) return false;
    }

    // Check allowed paths
    for (const allowed of this.config.allowedPaths) {
      const allowedAbs = resolve(this.config.basePath, allowed);
      if (normalized.startsWith(allowedAbs)) return true;
    }

    return false;
  }

  /** Resolve and validate a path against basePath (returns null if traversal detected) */
  resolvePath(filePath: string): string | null {
    const normalized = normalize(filePath);
    const absolute = isAbsolute(normalized)
      ? normalized
      : join(this.config.basePath, normalized);
    const resolved = resolve(absolute);

    // Traversal check
    if (!resolved.startsWith(this.config.basePath)) return null;
    return resolved;
  }

  /** Get a copy of the current policy config */
  getConfig(): Readonly<SandboxPolicyConfig> {
    return { ...this.config };
  }

  /** Update allowed commands */
  allowCommand(pattern: string): void {
    if (!this.config.allowedCommands.includes(pattern)) {
      this.config.allowedCommands.push(pattern);
    }
  }

  /** Remove an allowed command pattern */
  disallowCommand(pattern: string): void {
    this.config.allowedCommands = this.config.allowedCommands.filter(c => c !== pattern);
  }

  /** Update allowed paths */
  allowPath(path: string): void {
    if (!this.config.allowedPaths.includes(path)) {
      this.config.allowedPaths.push(path);
    }
  }

  /** Block a path */
  blockPath(path: string): void {
    if (!this.config.blockedPaths.includes(path)) {
      this.config.blockedPaths.push(path);
    }
  }

  get basePath(): string { return this.config.basePath; }
  get maxConcurrentProcesses(): number { return this.config.maxConcurrentProcesses; }
  get defaultTimeoutMs(): number { return this.config.defaultTimeoutMs; }
  get defaultMaxOutputBytes(): number { return this.config.defaultMaxOutputBytes; }
  get autoApproveReads(): boolean { return this.config.autoApproveReads; }

  /** Simple glob matching: supports * as wildcard */
  private matchesAny(value: string, patterns: string[]): boolean {
    return patterns.some(pattern => this.globMatch(pattern, value));
  }

  /** Match a simple glob pattern against a string */
  private globMatch(pattern: string, value: string): boolean {
    // Escape regex special chars except *
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp(`^${regexStr}$`, 'i').test(value);
  }
}

// ============================================================================
// SHELL EXECUTOR
// ============================================================================

/**
 * Sandboxed shell command executor with timeout, output limits, and
 * concurrent process tracking.
 *
 * @example
 * ```typescript
 * const executor = new ShellExecutor(policy);
 * const result = await executor.execute('npm test', { agentId: 'tester' });
 * console.log(result.exitCode, result.stdout);
 * ```
 */
export class ShellExecutor {
  private readonly policy: SandboxPolicy;
  private activeProcesses = 0;

  constructor(policy: SandboxPolicy) {
    this.policy = policy;
  }

  /** Execute a shell command within policy constraints */
  async execute(command: string, opts: ShellOptions = {}): Promise<ShellResult> {
    // Policy check
    if (!this.policy.isCommandAllowed(command)) {
      throw new RuntimePolicyError(`Command blocked by policy: ${command}`);
    }

    // Concurrency check
    if (this.activeProcesses >= this.policy.maxConcurrentProcesses) {
      throw new RuntimePolicyError(
        `Concurrency limit reached (${this.policy.maxConcurrentProcesses} max)`,
      );
    }

    const cwd = opts.cwd
      ? (this.policy.resolvePath(opts.cwd) ?? this.policy.basePath)
      : this.policy.basePath;

    const timeoutMs = opts.timeoutMs ?? this.policy.defaultTimeoutMs;
    const maxBytes = opts.maxOutputBytes ?? this.policy.defaultMaxOutputBytes;

    this.activeProcesses++;

    try {
      return await this.spawnCommand(command, cwd, timeoutMs, maxBytes, opts.env);
    } finally {
      this.activeProcesses--;
    }
  }

  /** Get the number of currently running processes */
  get running(): number { return this.activeProcesses; }

  private spawnCommand(
    command: string,
    cwd: string,
    timeoutMs: number,
    maxBytes: number,
    env?: Record<string, string>,
  ): Promise<ShellResult> {
    return new Promise((resolvePromise, reject) => {
      const isWindows = process.platform === 'win32';
      const shell = isWindows ? 'cmd.exe' : '/bin/sh';
      const shellArgs = isWindows ? ['/c', command] : ['-c', command];

      const child = spawn(shell, shellArgs, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let totalBytes = 0;
      let timedOut = false;
      let truncated = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 2000);
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes <= maxBytes) {
          stdout += chunk.toString();
        } else if (!truncated) {
          truncated = true;
          stdout += '\n[OUTPUT TRUNCATED — exceeded limit]';
          child.kill('SIGTERM');
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes <= maxBytes) {
          stderr += chunk.toString();
        }
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolvePromise({
          exitCode: code ?? (timedOut ? 124 : 1),
          stdout,
          stderr,
          durationMs: Date.now() - startTime,
          timedOut,
          truncated,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new RuntimeExecutionError(`Failed to spawn: ${err.message}`));
      });

      const startTime = Date.now();
    });
  }
}

// ============================================================================
// FILE ACCESSOR
// ============================================================================

/**
 * Policy-scoped file system accessor. All paths are validated against
 * the sandbox policy before any I/O.
 *
 * @example
 * ```typescript
 * const files = new FileAccessor(policy);
 * const result = await files.read('src/index.ts', 'reader-agent');
 * ```
 */
export class FileAccessor {
  private readonly policy: SandboxPolicy;

  constructor(policy: SandboxPolicy) {
    this.policy = policy;
  }

  /** Read a file within the sandbox scope */
  async read(filePath: string, agentId: string): Promise<FileResult> {
    const start = Date.now();
    const resolved = this.policy.resolvePath(filePath);

    if (!resolved) {
      return { success: false, path: filePath, error: 'Path traversal blocked', durationMs: Date.now() - start };
    }
    if (!this.policy.isPathAllowed(filePath)) {
      return { success: false, path: filePath, error: 'Path not in allowed scope', durationMs: Date.now() - start };
    }

    try {
      const content = await readFile(resolved, 'utf-8');
      return { success: true, path: resolved, content, durationMs: Date.now() - start };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, path: resolved, error: msg, durationMs: Date.now() - start };
    }
  }

  /** Write a file within the sandbox scope */
  async write(filePath: string, content: string, agentId: string): Promise<FileResult> {
    const start = Date.now();
    const resolved = this.policy.resolvePath(filePath);

    if (!resolved) {
      return { success: false, path: filePath, error: 'Path traversal blocked', durationMs: Date.now() - start };
    }
    if (!this.policy.isPathAllowed(filePath)) {
      return { success: false, path: filePath, error: 'Path not in allowed scope', durationMs: Date.now() - start };
    }

    try {
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, content, 'utf-8');
      return { success: true, path: resolved, durationMs: Date.now() - start };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, path: resolved, error: msg, durationMs: Date.now() - start };
    }
  }

  /** List directory contents within the sandbox scope */
  async list(dirPath: string, agentId: string): Promise<FileResult> {
    const start = Date.now();
    const resolved = this.policy.resolvePath(dirPath);

    if (!resolved) {
      return { success: false, path: dirPath, error: 'Path traversal blocked', durationMs: Date.now() - start };
    }
    if (!this.policy.isPathAllowed(dirPath)) {
      return { success: false, path: dirPath, error: 'Path not in allowed scope', durationMs: Date.now() - start };
    }

    try {
      const items = await readdir(resolved);
      const entries: string[] = [];
      for (const item of items) {
        const itemPath = join(resolved, item);
        const info = await stat(itemPath);
        entries.push(info.isDirectory() ? `${item}/` : item);
      }
      return { success: true, path: resolved, entries, durationMs: Date.now() - start };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, path: resolved, error: msg, durationMs: Date.now() - start };
    }
  }
}

// ============================================================================
// APPROVAL GATE
// ============================================================================

/**
 * Human-in-the-loop approval gate. Queues requests and waits for
 * a decision from the configured callback.
 *
 * @example
 * ```typescript
 * const gate = new ApprovalGate(async (req) => {
 *   return { approved: true, approvedBy: 'operator' };
 * });
 * const decision = await gate.request({ type: 'shell', target: 'npm publish', ... });
 * ```
 */
export class ApprovalGate extends EventEmitter {
  private readonly callback: ApprovalCallback | null;
  private readonly autoApproveAll: boolean;
  private readonly history: Array<{ request: ApprovalRequest; decision: ApprovalDecision }> = [];

  constructor(callback?: ApprovalCallback, autoApproveAll = false) {
    super();
    this.callback = callback ?? null;
    this.autoApproveAll = autoApproveAll;
  }

  /** Request approval for an operation */
  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    this.emit('requested', req);

    if (this.autoApproveAll) {
      const decision: ApprovalDecision = { approved: true, approvedBy: 'auto-approve-all' };
      this.history.push({ request: req, decision });
      this.emit('decided', req, decision);
      return decision;
    }

    if (!this.callback) {
      const decision: ApprovalDecision = { approved: false, reason: 'No approval callback configured' };
      this.history.push({ request: req, decision });
      this.emit('decided', req, decision);
      return decision;
    }

    const decision = await this.callback(req);
    this.history.push({ request: req, decision });
    this.emit('decided', req, decision);
    return decision;
  }

  /** Get approval history */
  getHistory(): ReadonlyArray<{ request: ApprovalRequest; decision: ApprovalDecision }> {
    return this.history;
  }

  /** Get count of approvals/denials */
  getStats(): { total: number; approved: number; denied: number } {
    const approved = this.history.filter(h => h.decision.approved).length;
    return { total: this.history.length, approved, denied: this.history.length - approved };
  }
}

// ============================================================================
// AGENT RUNTIME (Facade)
// ============================================================================

/**
 * Unified agent execution runtime. Combines policy, shell, file access,
 * and approval into a single interface for agent consumption.
 *
 * @example
 * ```typescript
 * const runtime = new AgentRuntime({
 *   policy: {
 *     basePath: '/project',
 *     allowedCommands: ['npm *', 'node *', 'git status', 'git diff'],
 *   },
 *   onApproval: async (req) => {
 *     console.log(`Approve? ${req.type}: ${req.target}`);
 *     return { approved: true, approvedBy: 'operator' };
 *   },
 * });
 *
 * const result = await runtime.exec('npm test', 'tester-agent');
 * ```
 */
export class AgentRuntime extends EventEmitter {
  readonly policy: SandboxPolicy;
  readonly shell: ShellExecutor;
  readonly files: FileAccessor;
  readonly gate: ApprovalGate;
  private auditLog: RuntimeAuditEntry[] = [];

  constructor(opts: AgentRuntimeOptions) {
    super();
    this.policy = new SandboxPolicy(opts.policy);
    this.shell = new ShellExecutor(this.policy);
    this.files = new FileAccessor(this.policy);
    this.gate = new ApprovalGate(opts.onApproval, opts.autoApproveAll);

    // Wire approval events
    this.gate.on('requested', (req: ApprovalRequest) => {
      this.emit('approval:requested', req);
      this.audit({ action: 'approval_requested', agentId: req.agentId, target: req.target, result: 'success' });
    });
    this.gate.on('decided', (req: ApprovalRequest, dec: ApprovalDecision) => {
      this.emit('approval:decided', req, dec);
      this.audit({
        action: dec.approved ? 'approval_granted' : 'approval_denied',
        agentId: req.agentId,
        target: req.target,
        result: dec.approved ? 'success' : 'denied',
        details: { approvedBy: dec.approvedBy, reason: dec.reason },
      });
    });
  }

  /**
   * Execute a shell command with policy + approval checks.
   * Returns ShellResult on success, throws on policy violation.
   */
  async exec(command: string, agentId: string, opts: ShellOptions = {}): Promise<ShellResult> {
    // Policy check
    if (!this.policy.isCommandAllowed(command)) {
      this.emit('policy:violation', agentId, command, 'Command not allowed by policy');
      this.audit({ action: 'shell_execute', agentId, target: command, result: 'blocked' });
      throw new RuntimePolicyError(`Command blocked by policy: ${command}`);
    }

    // Approval check
    const needsApproval = opts.requiresApproval ?? this.policy.requiresApproval(command);
    if (needsApproval) {
      const decision = await this.gate.request({
        type: 'shell',
        target: command,
        agentId,
        risk: this.policy.assessRisk(command),
        timestamp: Date.now(),
      });
      if (!decision.approved) {
        this.audit({ action: 'shell_execute', agentId, target: command, result: 'denied', details: { reason: decision.reason } });
        throw new RuntimeApprovalError(`Command denied: ${decision.reason ?? 'no reason given'}`);
      }
    }

    // Execute
    this.emit('command:start', agentId, command);
    const result = await this.shell.execute(command, { ...opts, agentId });
    this.emit('command:complete', agentId, command, result);
    this.audit({
      action: 'shell_execute',
      agentId,
      target: command,
      result: result.exitCode === 0 ? 'success' : (result.timedOut ? 'timeout' : 'error'),
      durationMs: result.durationMs,
      details: { exitCode: result.exitCode, timedOut: result.timedOut },
    });
    return result;
  }

  /** Read a file with policy + optional approval */
  async readFile(filePath: string, agentId: string): Promise<FileResult> {
    if (!this.policy.isPathAllowed(filePath)) {
      this.emit('policy:violation', agentId, filePath, 'Path not allowed');
      this.audit({ action: 'file_read', agentId, target: filePath, result: 'blocked' });
      return { success: false, path: filePath, error: 'Path not allowed by policy', durationMs: 0 };
    }

    // Reads can auto-approve
    if (!this.policy.autoApproveReads) {
      const decision = await this.gate.request({
        type: 'file_read', target: filePath, agentId, risk: 'low', timestamp: Date.now(),
      });
      if (!decision.approved) {
        this.audit({ action: 'file_read', agentId, target: filePath, result: 'denied' });
        return { success: false, path: filePath, error: 'Read denied', durationMs: 0 };
      }
    }

    this.emit('file:access', agentId, filePath, 'read');
    const result = await this.files.read(filePath, agentId);
    this.audit({
      action: 'file_read', agentId, target: filePath,
      result: result.success ? 'success' : 'error', durationMs: result.durationMs,
    });
    return result;
  }

  /** Write a file with policy + approval */
  async writeFile(filePath: string, content: string, agentId: string): Promise<FileResult> {
    if (!this.policy.isPathAllowed(filePath)) {
      this.emit('policy:violation', agentId, filePath, 'Path not allowed');
      this.audit({ action: 'file_write', agentId, target: filePath, result: 'blocked' });
      return { success: false, path: filePath, error: 'Path not allowed by policy', durationMs: 0 };
    }

    const decision = await this.gate.request({
      type: 'file_write', target: filePath, agentId, risk: 'medium', timestamp: Date.now(),
    });
    if (!decision.approved) {
      this.audit({ action: 'file_write', agentId, target: filePath, result: 'denied' });
      return { success: false, path: filePath, error: `Write denied: ${decision.reason ?? 'no reason'}`, durationMs: 0 };
    }

    this.emit('file:access', agentId, filePath, 'write');
    const result = await this.files.write(filePath, content, agentId);
    this.audit({
      action: 'file_write', agentId, target: filePath,
      result: result.success ? 'success' : 'error', durationMs: result.durationMs,
    });
    return result;
  }

  /** List a directory with policy check */
  async listDir(dirPath: string, agentId: string): Promise<FileResult> {
    if (!this.policy.isPathAllowed(dirPath)) {
      this.emit('policy:violation', agentId, dirPath, 'Path not allowed');
      this.audit({ action: 'file_list', agentId, target: dirPath, result: 'blocked' });
      return { success: false, path: dirPath, error: 'Path not allowed by policy', durationMs: 0 };
    }

    this.emit('file:access', agentId, dirPath, 'list');
    const result = await this.files.list(dirPath, agentId);
    this.audit({
      action: 'file_list', agentId, target: dirPath,
      result: result.success ? 'success' : 'error', durationMs: result.durationMs,
    });
    return result;
  }

  /** Get the internal audit log */
  getAuditLog(): ReadonlyArray<RuntimeAuditEntry> {
    return this.auditLog;
  }

  /** Clear the internal audit log */
  clearAuditLog(): void {
    this.auditLog = [];
  }

  private audit(entry: Omit<RuntimeAuditEntry, 'timestamp'>): void {
    const full: RuntimeAuditEntry = { ...entry, timestamp: new Date().toISOString() };
    this.auditLog.push(full);
    this.emit('audit', full);
  }
}

// ============================================================================
// ERROR TYPES
// ============================================================================

/** Thrown when an operation violates the sandbox policy */
export class RuntimePolicyError extends Error {
  readonly code = 'POLICY_VIOLATION';
  constructor(message: string) {
    super(message);
    this.name = 'RuntimePolicyError';
  }
}

/** Thrown when an operation is denied by the approval gate */
export class RuntimeApprovalError extends Error {
  readonly code = 'APPROVAL_DENIED';
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeApprovalError';
  }
}

/** Thrown when a command fails to spawn */
export class RuntimeExecutionError extends Error {
  readonly code = 'EXECUTION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeExecutionError';
  }
}
