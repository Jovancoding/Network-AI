#!/usr/bin/env node
/**
 * network-ai console — Interactive terminal dashboard for the agent runtime.
 *
 * Usage:
 *   npx network-ai-console [options]
 *   npx network-ai console             (via CLI sub-command)
 *
 * Options:
 *   --base-path <dir>    Base directory for agent sandbox (default: cwd)
 *   --auto-approve       Auto-approve all operations (DANGEROUS)
 *   --allow <patterns>   Comma-separated command whitelist (e.g. "npm *,node *,git status")
 *   --budget <tokens>    Budget ceiling in tokens (default: 100000)
 *   --pipe               Pipe mode: read JSON commands from stdin, write JSON to stdout
 *   --board <name>       Named blackboard to use (default: main)
 */

import * as path from 'path';
import { ConsoleUI } from '../lib/console-ui';
import {
  AgentRuntime,
  RuntimePolicyError,
  RuntimeApprovalError,
} from '../lib/agent-runtime';
import { LockedBlackboard } from '../lib/locked-blackboard';
import { FederatedBudget } from '../lib/federated-budget';
import { JourneyFSM } from '../lib/fsm-journey';
import { AdapterRegistry } from '../adapters/adapter-registry';
import { createSwarmOrchestrator } from '../index';

// ── Parse args ────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  basePath: string;
  autoApprove: boolean;
  allowedCommands: string[];
  budgetCeiling: number;
  pipe: boolean;
  board: string;
} {
  let basePath = process.cwd();
  let autoApprove = false;
  let allowedCommands: string[] = ['npm *', 'node *', 'npx *', 'git status', 'git diff*', 'git log*', 'ls*', 'dir*', 'cat *', 'type *', 'echo *'];
  let budgetCeiling = 100_000;
  let pipe = false;
  let board = 'main';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base-path' && argv[i + 1]) {
      basePath = path.resolve(argv[++i]);
    } else if (arg === '--auto-approve') {
      autoApprove = true;
    } else if (arg === '--allow' && argv[i + 1]) {
      allowedCommands = argv[++i].split(',').map(s => s.trim());
    } else if (arg === '--budget' && argv[i + 1]) {
      budgetCeiling = parseInt(argv[++i], 10) || 100_000;
    } else if (arg === '--pipe') {
      pipe = true;
    } else if (arg === '--board' && argv[i + 1]) {
      board = argv[++i];
    }
  }

  return { basePath, autoApprove, allowedCommands, budgetCeiling, pipe, board };
}

// ── Version ───────────────────────────────────────────────────────────────────

const pkg = (() => {
  try { return require('../package.json'); } catch {
    try { return require('../../package.json'); } catch { return { version: '0.0.0' }; }
  }
})() as { version: string };

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // In pipe mode, redirect console.log to stderr so stdout is reserved for JSON
  if (args.pipe) {
    console.log = (...a: unknown[]) => process.stderr.write(a.join(' ') + '\n');
  }

  // ── Shared Orchestrator — same instances as MCP server ───────────────────

  const orchestrator = createSwarmOrchestrator();
  const blackboard = new LockedBlackboard(args.basePath);
  const budget = new FederatedBudget({ ceiling: args.budgetCeiling });
  const adapters = orchestrator.adapters;

  // JourneyFSM requires at least one state — use a sensible default
  const fsm = new JourneyFSM({
    states: [
      { name: 'IDLE', authorizedAgents: ['*'], authorizedTools: { '*': ['*'] } },
      { name: 'PLANNING', authorizedAgents: ['*'], authorizedTools: { '*': ['*'] } },
      { name: 'EXECUTING', authorizedAgents: ['*'], authorizedTools: { '*': ['*'] } },
      { name: 'REVIEWING', authorizedAgents: ['*'], authorizedTools: { '*': ['*'] } },
      { name: 'DONE', authorizedAgents: ['orchestrator'], authorizedTools: { orchestrator: ['*'] } },
    ],
    transitions: [
      { from: 'IDLE', event: 'plan', to: 'PLANNING', allowedBy: '*' },
      { from: 'PLANNING', event: 'execute', to: 'EXECUTING', allowedBy: '*' },
      { from: 'EXECUTING', event: 'review', to: 'REVIEWING', allowedBy: '*' },
      { from: 'REVIEWING', event: 'approve', to: 'DONE', allowedBy: '*' },
      { from: 'REVIEWING', event: 'revise', to: 'EXECUTING', allowedBy: '*' },
      { from: 'DONE', event: 'reset', to: 'IDLE', allowedBy: '*' },
    ],
    initialState: 'IDLE',
  });

  // Create the runtime
  const runtime = new AgentRuntime({
    policy: {
      basePath: args.basePath,
      allowedCommands: args.allowedCommands,
      allowedPaths: ['.'],
      autoApproveReads: true,
    },
    autoApproveAll: args.autoApprove,
    onApproval: args.autoApprove
      ? undefined
      : args.pipe
      // Pipe mode has no interactive approver — fail closed. Approval-required
      // operations (rm, git push, npm publish, …) are denied unless the operator
      // explicitly opts in with --auto-approve, so untrusted stdin cannot trigger
      // a high-risk command silently.
      ? async (req) => ({
          approved: false,
          reason: `Operation requires approval ([${req.type}] ${req.target}); pipe mode has no interactive approver. Re-run with --auto-approve to permit it.`,
        })
      : async (req) => {
      // Interactive approval via console
      ui.log(`APPROVAL NEEDED: [${req.type}] ${req.target} (risk: ${req.risk})`, 'approval');
      ui.log(`Type 'approve' or 'deny <reason>'`, 'approval');

      // Store pending approval for the approve/deny commands
      pendingApproval = {
        resolve: (decision) => decision,
        request: req,
      };

      return new Promise<{ approved: boolean; approvedBy?: string; reason?: string }>((resolve) => {
        pendingApproval = { resolve, request: req };
      });
    },
  });

  let pendingApproval: {
    resolve: (decision: { approved: boolean; approvedBy?: string; reason?: string }) => void;
    request: { type: string; target: string; agentId: string };
  } | null = null;

  // Create the console UI
  const ui = new ConsoleUI({
    title: 'Network-AI',
    version: pkg.version,
    prompt: '> ',
  });

  // ── Register commands ─────────────────────────────────────────────────────

  ui.command('status', () => {
    // Sync status from real orchestrator components
    const adapterList = adapters.listAdapters();
    const readyCount = adapterList.filter(a => a.ready).length;
    const spent = budget.getTotalSpent();
    const ceiling = budget.getCeiling();
    const pct = ceiling > 0 ? Math.round((spent / ceiling) * 100) : 0;

    ui.updateStatus({
      agents: { active: readyCount, total: adapterList.length },
      budget: { usedPercent: pct },
      fsm: { state: fsm.state },
    });

    const s = ui.getStatus();
    const audit = runtime.getAuditLog();
    ui.log(`Agents: ${s.agents.active}/${s.agents.total} | Budget: ${spent.toLocaleString()}/${ceiling.toLocaleString()} (${pct}%) | FSM: ${fsm.state}`);
    ui.log(`Blackboard keys: ${blackboard.listKeys().length} | Pending changes: ${blackboard.listPendingChanges().length}`);
    ui.log(`Audit entries: ${audit.length} | Shell processes: ${runtime.shell.running}`);
    ui.log(`Pending approvals: ${s.pendingApprovals}`);
  }, 'Show runtime status');

  ui.command('exec', async (cmdArgs) => {
    if (!cmdArgs) { ui.log('Usage: exec <command>', 'warn'); return; }
    // Validate against the sandbox policy allowlist before dispatch.
    // runtime.exec() enforces the same check internally, but making it
    // explicit at the call site keeps the security boundary visible.
    if (!runtime.policy.isCommandAllowed(cmdArgs)) {
      ui.log(`Command not in allowlist: ${cmdArgs}`, 'error');
      return;
    }
    try {
      const result = await runtime.exec(cmdArgs, 'console-user');
      if (result.stdout) ui.log(result.stdout.trim());
      if (result.stderr) ui.log(result.stderr.trim(), 'warn');
      ui.log(`Exit ${result.exitCode} (${result.durationMs}ms)${result.timedOut ? ' [TIMED OUT]' : ''}`, result.exitCode === 0 ? 'success' : 'error');
    } catch (err) {
      if (err instanceof RuntimePolicyError) {
        ui.log(err.message, 'error');
      } else if (err instanceof RuntimeApprovalError) {
        ui.log(err.message, 'warn');
      } else {
        ui.log(String(err), 'error');
      }
    }
  }, 'Execute a shell command (exec <cmd>)');

  ui.command('read', async (filePath) => {
    if (!filePath) { ui.log('Usage: read <file>', 'warn'); return; }
    const result = await runtime.readFile(filePath.trim(), 'console-user');
    if (result.success && result.content) {
      ui.log(`── ${result.path} ──`);
      const lines = result.content.split('\n');
      const preview = lines.slice(0, 30).join('\n');
      ui.log(preview);
      if (lines.length > 30) ui.log(`... (${lines.length - 30} more lines)`, 'info');
    } else {
      ui.log(result.error ?? 'Failed to read file', 'error');
    }
  }, 'Read a file (read <path>)');

  ui.command('ls', async (dirPath) => {
    const target = dirPath?.trim() || '.';
    const result = await runtime.listDir(target, 'console-user');
    if (result.success && result.entries) {
      ui.log(`── ${result.path} ──`);
      for (const entry of result.entries) {
        ui.log(`  ${entry}`);
      }
    } else {
      ui.log(result.error ?? 'Failed to list directory', 'error');
    }
  }, 'List directory contents (ls [path])');

  ui.command('approve', (_args) => {
    if (!pendingApproval) {
      ui.log('No pending approval', 'warn');
      return;
    }
    const req = pendingApproval.request;
    pendingApproval.resolve({ approved: true, approvedBy: 'console-user' });
    pendingApproval = null;
    ui.log(`Approved: ${req.type} ${req.target}`, 'success');
    ui.updateStatus({ pendingApprovals: Math.max(0, ui.getStatus().pendingApprovals - 1) });
  }, 'Approve a pending operation');

  ui.command('deny', (reason) => {
    if (!pendingApproval) {
      ui.log('No pending approval', 'warn');
      return;
    }
    const req = pendingApproval.request;
    pendingApproval.resolve({ approved: false, reason: reason || 'Denied by operator' });
    pendingApproval = null;
    ui.log(`Denied: ${req.type} ${req.target} — ${reason || 'no reason'}`, 'warn');
    ui.updateStatus({ pendingApprovals: Math.max(0, ui.getStatus().pendingApprovals - 1) });
  }, 'Deny a pending operation (deny [reason])');

  ui.command('audit', (args) => {
    const count = parseInt(args) || 10;
    const entries = runtime.getAuditLog();
    const recent = entries.slice(-count);
    if (recent.length === 0) {
      ui.log('No audit entries yet', 'info');
      return;
    }
    for (const e of recent) {
      const time = e.timestamp.split('T')[1]?.slice(0, 8) ?? '';
      ui.log(`[${time}] ${e.action} | ${e.agentId} | ${e.target} → ${e.result}`);
    }
  }, 'Show recent audit entries (audit [count])');

  ui.command('policy', (args) => {
    const config = runtime.policy.getConfig();
    if (!args || args === 'show') {
      ui.log(`Base path: ${config.basePath}`);
      ui.log(`Allowed commands: ${config.allowedCommands.join(', ') || '(none)'}`);
      ui.log(`Blocked commands: ${config.blockedCommands.length} patterns`);
      ui.log(`Allowed paths: ${config.allowedPaths.join(', ')}`);
      ui.log(`Max concurrent: ${config.maxConcurrentProcesses}`);
      ui.log(`Timeout: ${config.defaultTimeoutMs}ms`);
      ui.log(`Auto-approve reads: ${config.autoApproveReads}`);
    } else if (args.startsWith('allow ')) {
      const pattern = args.slice(6).trim();
      runtime.policy.allowCommand(pattern);
      ui.log(`Added to allowed commands: ${pattern}`, 'success');
    } else if (args.startsWith('block ')) {
      const pattern = args.slice(6).trim();
      runtime.policy.disallowCommand(pattern);
      ui.log(`Removed from allowed commands: ${pattern}`, 'success');
    } else {
      ui.log('Usage: policy [show|allow <pattern>|block <pattern>]', 'warn');
    }
  }, 'View or modify sandbox policy');

  // ── Orchestrator commands ─────────────────────────────────────────────────

  ui.command('agents', async () => {
    const adapterList = adapters.listAdapters();
    if (adapterList.length === 0) {
      ui.log('No adapters registered. Use "spawn" to execute agents via adapters.', 'info');
      return;
    }
    ui.log(`── Registered Adapters (${adapterList.length}) ──`);
    for (const a of adapterList) {
      const status = a.ready ? 'ready' : (a.deferred ? 'deferred' : 'not ready');
      ui.log(`  ${a.name} v${a.version} [${status}]`);
    }

    try {
      const discovered = await adapters.discoverAgents();
      if (discovered.length > 0) {
        ui.log(`── Discovered Agents (${discovered.length}) ──`);
        for (const agent of discovered) {
          ui.log(`  ${agent.id} (${agent.adapter}) — ${agent.description ?? 'no description'}`);
        }
      }
    } catch {
      // discoverAgents may fail if no adapters are initialized
    }
  }, 'List registered adapters and discovered agents');

  ui.command('spawn', async (spawnArgs) => {
    if (!spawnArgs) { ui.log('Usage: spawn <agentId> [input text]', 'warn'); return; }
    const [agentId, ...rest] = spawnArgs.split(/\s+/);
    const input = rest.join(' ') || 'execute';

    ui.log(`Spawning agent "${agentId}"...`, 'info');
    try {
      const result = await adapters.executeAgent(
        agentId,
        { action: 'execute', params: { input } },
        { agentId: 'console-user', taskId: `console-${Date.now()}`, sessionId: 'console' },
      );
      ui.log(`Agent "${agentId}" completed — success: ${result.success}`, result.success ? 'success' : 'error');
      if (result.data) {
        const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
        const lines = text.split('\n');
        const preview = lines.slice(0, 20).join('\n');
        ui.log(preview);
        if (lines.length > 20) ui.log(`... (${lines.length - 20} more lines)`, 'info');
      }
      if (result.error) ui.log(`Error: ${result.error.message}`, 'error');
    } catch (err) {
      ui.log(`Spawn failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }, 'Execute an agent (spawn <agentId> [input])');

  ui.command('stop', async (adapterName) => {
    if (!adapterName) { ui.log('Usage: stop <adapterName>', 'warn'); return; }
    try {
      await adapters.removeAdapter(adapterName.trim());
      ui.log(`Adapter "${adapterName.trim()}" removed`, 'success');
    } catch (err) {
      ui.log(`Stop failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }, 'Remove an adapter (stop <adapterName>)');

  ui.command('bb', (bbArgs) => {
    if (!bbArgs) { ui.log('Usage: bb <read|write|list|delete|propose|validate|commit|pending> [args]', 'warn'); return; }
    const parts = bbArgs.split(/\s+/);
    const sub = parts[0];

    if (sub === 'list') {
      const keys = blackboard.listKeys();
      if (keys.length === 0) { ui.log('Blackboard is empty', 'info'); return; }
      ui.log(`── Blackboard Keys (${keys.length}) ──`);
      for (const key of keys) ui.log(`  ${key}`);
    } else if (sub === 'read') {
      const key = parts[1];
      if (!key) { ui.log('Usage: bb read <key>', 'warn'); return; }
      const entry = blackboard.read(key);
      if (!entry) { ui.log(`Key "${key}" not found`, 'warn'); return; }
      ui.log(`── ${key} ──`);
      ui.log(`  Value: ${JSON.stringify(entry.value)}`);
      ui.log(`  Source: ${entry.source_agent} | Updated: ${entry.timestamp}`);
    } else if (sub === 'write') {
      const key = parts[1];
      const value = parts.slice(2).join(' ');
      if (!key || !value) { ui.log('Usage: bb write <key> <value>', 'warn'); return; }
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { parsed = value; }
      blackboard.write(key, parsed, 'console-user');
      ui.log(`Wrote "${key}" to blackboard`, 'success');
    } else if (sub === 'delete') {
      const key = parts[1];
      if (!key) { ui.log('Usage: bb delete <key>', 'warn'); return; }
      const deleted = blackboard.delete(key);
      ui.log(deleted ? `Deleted "${key}"` : `Key "${key}" not found`, deleted ? 'success' : 'warn');
    } else if (sub === 'propose') {
      const key = parts[1];
      const value = parts.slice(2).join(' ');
      if (!key || !value) { ui.log('Usage: bb propose <key> <value>', 'warn'); return; }
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { parsed = value; }
      const changeId = blackboard.propose(key, parsed, 'console-user');
      ui.log(`Proposed change: ${changeId}`, 'success');
    } else if (sub === 'validate') {
      const changeId = parts[1];
      if (!changeId) { ui.log('Usage: bb validate <changeId>', 'warn'); return; }
      const valid = blackboard.validate(changeId, 'console-user');
      ui.log(`Validation: ${valid ? 'passed' : 'failed'}`, valid ? 'success' : 'error');
    } else if (sub === 'commit') {
      const changeId = parts[1];
      if (!changeId) { ui.log('Usage: bb commit <changeId>', 'warn'); return; }
      const result = blackboard.commit(changeId);
      ui.log(`Commit: ${result.success ? 'success' : 'failed'}${result.message ? ' — ' + result.message : ''}`, result.success ? 'success' : 'error');
    } else if (sub === 'pending') {
      const pending = blackboard.listPendingChanges();
      if (pending.length === 0) { ui.log('No pending changes', 'info'); return; }
      ui.log(`── Pending Changes (${pending.length}) ──`);
      for (const p of pending) {
        ui.log(`  ${p.change_id}: ${p.key} by ${p.source_agent} (${p.status})`);
      }
    } else {
      ui.log('Usage: bb <read|write|list|delete|propose|validate|commit|pending> [args]', 'warn');
    }
  }, 'Blackboard operations (bb <sub> [args])');

  ui.command('budget', (budgetArgs) => {
    const sub = budgetArgs?.split(/\s+/)[0];

    if (!sub || sub === 'show') {
      const spent = budget.getTotalSpent();
      const ceiling = budget.getCeiling();
      const remaining = budget.remaining();
      const pct = ceiling > 0 ? Math.round((spent / ceiling) * 100) : 0;
      ui.log(`── Budget ──`);
      ui.log(`  Ceiling:   ${ceiling.toLocaleString()} tokens`);
      ui.log(`  Spent:     ${spent.toLocaleString()} tokens (${pct}%)`);
      ui.log(`  Remaining: ${remaining.toLocaleString()} tokens`);

      const log = budget.getSpendLog();
      const agents = Object.entries(log);
      if (agents.length > 0) {
        ui.log(`  Per-agent:`);
        for (const [agentId, tokens] of agents) {
          ui.log(`    ${agentId}: ${tokens.toLocaleString()}`);
        }
      }

      // Sync status bar
      ui.updateStatus({ budget: { usedPercent: pct } });
    } else if (sub === 'spend') {
      const parts = budgetArgs.split(/\s+/);
      const agentId = parts[1];
      const tokens = parseInt(parts[2], 10);
      if (!agentId || !tokens || tokens <= 0) { ui.log('Usage: budget spend <agentId> <tokens>', 'warn'); return; }
      const result = budget.spend(agentId, tokens);
      ui.log(
        result.allowed
          ? `Spent ${tokens} tokens for "${agentId}" (remaining: ${result.remaining})`
          : `Denied: ${result.deniedReason ?? 'ceiling exceeded'} (remaining: ${result.remaining})`,
        result.allowed ? 'success' : 'error',
      );
      const pct = budget.getCeiling() > 0 ? Math.round((budget.getTotalSpent() / budget.getCeiling()) * 100) : 0;
      ui.updateStatus({ budget: { usedPercent: pct } });
    } else if (sub === 'reset') {
      budget.reset();
      ui.log('Budget reset to zero', 'success');
      ui.updateStatus({ budget: { usedPercent: 0 } });
    } else {
      ui.log('Usage: budget [show|spend <agentId> <tokens>|reset]', 'warn');
    }
  }, 'Budget tracking (budget [show|spend|reset])');

  ui.command('fsm', (fsmArgs) => {
    const parts = fsmArgs?.split(/\s+/) ?? [];
    const sub = parts[0];

    if (!sub || sub === 'show') {
      ui.log(`── FSM State ──`);
      ui.log(`  Current: ${fsm.state}`);
      ui.log(`  Time in state: ${fsm.timeInCurrentState}ms`);
      ui.log(`  Available events: ${fsm.availableEvents().join(', ') || '(none)'}`);
      ui.updateStatus({ fsm: { state: fsm.state } });
    } else if (sub === 'transition' || sub === 'go') {
      const event = parts[1];
      if (!event) { ui.log('Usage: fsm transition <event>', 'warn'); return; }
      const result = fsm.transition(event, 'console-user');
      if (result.success) {
        ui.log(`Transitioned: ${result.previousState} → ${result.currentState} (event: ${event})`, 'success');
        ui.updateStatus({ fsm: { state: fsm.state } });
      } else {
        ui.log(`Transition failed: ${result.reason ?? 'unknown'}`, 'error');
      }
    } else if (sub === 'events') {
      const events = fsm.availableEvents();
      if (events.length === 0) { ui.log('No available events from current state', 'info'); return; }
      ui.log(`Available events: ${events.join(', ')}`);
    } else if (sub === 'history') {
      const history = fsm.transitionHistory;
      if (history.length === 0) { ui.log('No transition history', 'info'); return; }
      ui.log(`── Transition History (${history.length}) ──`);
      for (const h of history) {
        const enteredAt = new Date(h.enteredAt).toISOString().split('T')[1]?.slice(0, 8) ?? '';
        ui.log(`  [${enteredAt}] ${h.state}${h.triggeredBy ? ` (by ${h.triggeredBy})` : ''}`);
      }
    } else if (sub === 'reset') {
      fsm.reset();
      ui.log('FSM reset to initial state', 'success');
      ui.updateStatus({ fsm: { state: fsm.state } });
    } else {
      ui.log('Usage: fsm [show|transition <event>|events|history|reset]', 'warn');
    }
  }, 'FSM workflow control (fsm [show|transition|events|history|reset])');

  ui.command('health', async () => {
    ui.log('Running health check...', 'info');
    try {
      const results = await adapters.healthCheck();
      const entries = Object.entries(results);
      if (entries.length === 0) { ui.log('No adapters to check', 'info'); return; }
      for (const [name, check] of entries) {
        ui.log(`  ${name}: ${check.healthy ? 'healthy' : 'unhealthy'}${check.details ? ' — ' + check.details : ''}`, check.healthy ? 'success' : 'error');
      }
    } catch (err) {
      ui.log(`Health check failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }, 'Run adapter health checks');

  // ── Wire runtime events to feed ──────────────────────────────────────────

  runtime.on('command:start', (agentId: string, cmd: string) => {
    ui.log(`${agentId} → exec "${cmd}"`, 'info');
  });

  runtime.on('command:complete', (agentId: string, cmd: string, result: { exitCode: number; durationMs: number }) => {
    const icon = result.exitCode === 0 ? 'success' : 'error';
    ui.log(`${agentId} ← exit ${result.exitCode} (${result.durationMs}ms)`, icon as 'success' | 'error');
  });

  runtime.on('policy:violation', (agentId: string, target: string, reason: string) => {
    ui.log(`BLOCKED: ${agentId} tried ${target} — ${reason}`, 'error');
  });

  runtime.on('approval:requested', () => {
    ui.updateStatus({ pendingApprovals: ui.getStatus().pendingApprovals + 1 });
  });

  // ── Start ────────────────────────────────────────────────────────────────

  if (args.pipe) {
    // ── Pipe mode: JSON in → JSON out ────────────────────────────────────
    await runPipeMode(ui, { blackboard, budget, fsm, adapters, runtime });
  } else {
    // ── Interactive TUI mode ─────────────────────────────────────────────
    ui.log('Console ready. Type "help" for commands.', 'success');
    await ui.start();
  }
}

// ============================================================================
// PIPE MODE — JSON protocol for AI agents
// ============================================================================

interface PipeCommand {
  /** Command name (same as console commands: status, bb, budget, fsm, etc.) */
  command: string;
  /** Arguments string (same format as interactive mode) */
  args?: string;
  /** Optional request ID for correlation */
  id?: string | number;
}

interface PipeResponse {
  /** Whether the command succeeded */
  success: boolean;
  /** Command that was executed */
  command: string;
  /** Structured response data */
  data?: unknown;
  /** Error message if failed */
  error?: string;
  /** Correlated request ID */
  id?: string | number;
}

async function runPipeMode(
  ui: ConsoleUI,
  ctx: {
    blackboard: LockedBlackboard;
    budget: FederatedBudget;
    fsm: JourneyFSM;
    adapters: AdapterRegistry;
    runtime: AgentRuntime;
  },
): Promise<void> {
  const { createInterface } = await import('readline');
  const rl = createInterface({ input: process.stdin, terminal: false });

  const respond = (res: PipeResponse): void => {
    process.stdout.write(JSON.stringify(res) + '\n');
  };

  rl.on('line', async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let cmd: PipeCommand;
    try {
      cmd = JSON.parse(trimmed);
    } catch {
      respond({ success: false, command: '', error: 'Invalid JSON' });
      return;
    }

    if (!cmd.command || typeof cmd.command !== 'string') {
      respond({ success: false, command: '', error: 'Missing "command" field', id: cmd.id });
      return;
    }

    try {
      const data = await executePipeCommand(cmd.command, cmd.args ?? '', ctx);
      respond({ success: true, command: cmd.command, data, id: cmd.id });
    } catch (err) {
      respond({
        success: false,
        command: cmd.command,
        error: err instanceof Error ? err.message : String(err),
        id: cmd.id,
      });
    }
  });

  rl.on('close', () => process.exit(0));

  // Keep alive
  await new Promise<void>(() => {});
}

async function executePipeCommand(
  command: string,
  args: string,
  ctx: {
    blackboard: LockedBlackboard;
    budget: FederatedBudget;
    fsm: JourneyFSM;
    adapters: AdapterRegistry;
    runtime: AgentRuntime;
  },
): Promise<unknown> {
  const { blackboard, budget, fsm, adapters, runtime } = ctx;

  switch (command) {
    case 'status': {
      const adapterList = adapters.listAdapters();
      return {
        agents: { active: adapterList.filter(a => a.ready).length, total: adapterList.length },
        budget: { spent: budget.getTotalSpent(), ceiling: budget.getCeiling(), remaining: budget.remaining() },
        fsm: { state: fsm.state, availableEvents: fsm.availableEvents() },
        blackboard: { keys: blackboard.listKeys().length, pending: blackboard.listPendingChanges().length },
        runtime: { shellProcesses: runtime.shell.running, auditEntries: runtime.getAuditLog().length },
      };
    }

    case 'bb': {
      const parts = args.split(/\s+/);
      const sub = parts[0];
      if (sub === 'list') return { keys: blackboard.listKeys() };
      if (sub === 'read') {
        const entry = blackboard.read(parts[1]);
        if (!entry) throw new Error(`Key "${parts[1]}" not found`);
        return entry;
      }
      if (sub === 'write') {
        let parsed: unknown;
        const value = parts.slice(2).join(' ');
        try { parsed = JSON.parse(value); } catch { parsed = value; }
        blackboard.write(parts[1], parsed, 'pipe-agent');
        return { key: parts[1], written: true };
      }
      if (sub === 'delete') {
        return { key: parts[1], deleted: blackboard.delete(parts[1]) };
      }
      if (sub === 'propose') {
        let parsed: unknown;
        const value = parts.slice(2).join(' ');
        try { parsed = JSON.parse(value); } catch { parsed = value; }
        const changeId = blackboard.propose(parts[1], parsed, 'pipe-agent');
        return { changeId };
      }
      if (sub === 'validate') {
        return { valid: blackboard.validate(parts[1], 'pipe-agent') };
      }
      if (sub === 'commit') {
        return blackboard.commit(parts[1]);
      }
      if (sub === 'pending') {
        return { pending: blackboard.listPendingChanges() };
      }
      if (sub === 'snapshot') {
        return blackboard.getSnapshot();
      }
      throw new Error(`Unknown bb subcommand: ${sub}`);
    }

    case 'budget': {
      const sub = args.split(/\s+/)[0];
      if (!sub || sub === 'show') {
        return {
          ceiling: budget.getCeiling(),
          spent: budget.getTotalSpent(),
          remaining: budget.remaining(),
          perAgent: budget.getSpendLog(),
        };
      }
      if (sub === 'spend') {
        const parts = args.split(/\s+/);
        return budget.spend(parts[1], parseInt(parts[2], 10));
      }
      if (sub === 'reset') {
        budget.reset();
        return { reset: true };
      }
      throw new Error(`Unknown budget subcommand: ${sub}`);
    }

    case 'fsm': {
      const parts = args.split(/\s+/);
      const sub = parts[0];
      if (!sub || sub === 'show') {
        return {
          state: fsm.state,
          timeInState: fsm.timeInCurrentState,
          availableEvents: fsm.availableEvents(),
        };
      }
      if (sub === 'transition' || sub === 'go') {
        return fsm.transition(parts[1], parts[2] ?? 'pipe-agent');
      }
      if (sub === 'events') {
        return { events: fsm.availableEvents() };
      }
      if (sub === 'history') {
        return { history: fsm.transitionHistory };
      }
      if (sub === 'reset') {
        fsm.reset();
        return { state: fsm.state };
      }
      throw new Error(`Unknown fsm subcommand: ${sub}`);
    }

    case 'agents': {
      const adapterList = adapters.listAdapters();
      let discovered: unknown[] = [];
      try { discovered = await adapters.discoverAgents(); } catch { /* ok */ }
      return { adapters: adapterList, discovered };
    }

    case 'spawn': {
      const [agentId, ...rest] = args.split(/\s+/);
      if (!agentId) throw new Error('Usage: spawn <agentId> [input]');
      return adapters.executeAgent(
        agentId,
        { action: 'execute', params: { input: rest.join(' ') || 'execute' } },
        { agentId: 'pipe-agent', taskId: `pipe-${Date.now()}`, sessionId: 'pipe' },
      );
    }

    case 'exec': {
      if (!args) throw new Error('Usage: exec <command>');
      // Validate against the sandbox policy allowlist before dispatch.
      // This ensures pipe-mode callers cannot bypass the command allowlist.
      if (!ctx.runtime.policy.isCommandAllowed(args)) {
        throw new Error(`Command not in allowlist: ${args}`);
      }
      return runtime.exec(args, 'pipe-agent');
    }

    case 'health': {
      return adapters.healthCheck();
    }

    case 'audit': {
      const count = parseInt(args) || 10;
      return { entries: runtime.getAuditLog().slice(-count) };
    }

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
