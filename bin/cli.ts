#!/usr/bin/env node
/**
 * network-ai CLI — full in-process control over blackboard, auth, budget, and audit.
 * Imports core classes directly (Option B: no server required).
 *
 * Usage:
 *   npx network-ai <command> [options]
 *   network-ai <command> [options]      (after npm install -g network-ai)
 */

import { Command, Option } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import { LockedBlackboard } from '../lib/locked-blackboard';
import { AuthGuardian } from '../index';
import { FederatedBudget } from '../lib/federated-budget';
import { EnvironmentManager } from '../lib/env-manager';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = (() => {
  try { return require('../package.json'); } catch {
    return require('../../package.json');
  }
})() as { version: string; name: string };

// ── helpers ───────────────────────────────────────────────────────────────────

function resolveData(opts: { data?: string }): string {
  return path.resolve(opts.data ?? path.join(process.cwd(), 'data'));
}

function print(obj: unknown, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(obj, null, 2));
  } else if (typeof obj === 'string') {
    console.log(obj);
  } else {
    console.log(JSON.stringify(obj, null, 2));
  }
}

function die(msg: string): never {
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ error: msg }) + '\n');
  } else {
    process.stderr.write(`error: ${msg}\n`);
  }
  process.exit(1);
}

function tryParseJson(v: string): unknown {
  try { return JSON.parse(v); } catch { return v; }
}

// ── root program ──────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('network-ai')
  .description('Network-AI CLI — full control over blackboard, auth, budget, and audit')
  .version(pkg.version, '-v, --version')
  .enablePositionalOptions()
  .addOption(new Option('--data <path>', 'path to data directory').default('./data'))
  .addOption(new Option('--env <name>', 'target environment (dev|st|sit|qa|sandbox|preprod|prod)'))
  .addOption(new Option('--json', 'output raw JSON (useful for piping)'))
  .addOption(new Option('--minimal', 'disable WAL, TTL sweep, and telemetry hooks (CI/test mode); also set via NETWORK_AI_MINIMAL=1'));

// ── bb (blackboard) ───────────────────────────────────────────────────────────

const bb = program.command('bb').description('Blackboard operations');

bb.command('get <key>')
  .description('Read a value from the blackboard')
  .action((key: string, _opts: Record<string, unknown>, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; json: boolean }>();
    const board = new LockedBlackboard(resolveData(g));
    const entry = board.read(key);
    if (!entry) die(`key not found: ${key}`);
    print(g.json ? entry : entry.value, g.json);
  });

bb.command('set <key> <value>')
  .description('Write a value to the blackboard')
  .option('--agent <id>', 'source agent id', 'cli')
  .option('--ttl <seconds>', 'TTL in seconds', (v) => parseInt(v, 10))
  .action((key: string, value: string, opts: { agent: string; ttl?: number }, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; json: boolean }>();
    const board = new LockedBlackboard(resolveData(g));
    const entry = board.write(key, tryParseJson(value), opts.agent, opts.ttl);
    print(g.json ? entry : `✓ set ${key}`, g.json);
  });

bb.command('delete <key>')
  .description('Delete a key from the blackboard')
  .action((key: string, _opts: Record<string, unknown>, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; json: boolean }>();
    const board = new LockedBlackboard(resolveData(g));
    const ok = board.delete(key);
    if (!ok) die(`key not found: ${key}`);
    print(g.json ? { deleted: key } : `✓ deleted ${key}`, g.json);
  });

bb.command('list')
  .description('List all keys on the blackboard')
  .action((_opts: Record<string, unknown>, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; json: boolean }>();
    const board = new LockedBlackboard(resolveData(g));
    const keys = board.listKeys();
    print(g.json ? keys : keys.length ? keys.join('\n') : '(empty)', g.json);
  });

bb.command('snapshot')
  .description('Dump full blackboard state as JSON')
  .action((_opts: Record<string, unknown>, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; json: boolean }>();
    const board = new LockedBlackboard(resolveData(g));
    const snap: Record<string, unknown> = {};
    for (const key of board.listKeys()) snap[key] = board.read(key);
    console.log(JSON.stringify(snap, null, 2));
  });

bb.command('propose <key> <value>')
  .description('Propose a change and get back a change-id')
  .option('--agent <id>', 'source agent id', 'cli')
  .option('--ttl <seconds>', 'TTL in seconds', (v) => parseInt(v, 10))
  .option('--priority <0-3>', 'priority: 0=low 1=normal 2=high 3=critical', (v) => parseInt(v, 10) as 0 | 1 | 2 | 3)
  .action((key: string, value: string, opts: { agent: string; ttl?: number; priority?: 0 | 1 | 2 | 3 }, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; json: boolean }>();
    const board = new LockedBlackboard(resolveData(g));
    const changeId = board.propose(key, tryParseJson(value), opts.agent, opts.ttl, opts.priority);
    print(g.json ? { changeId } : `change-id: ${changeId}`, g.json);
  });

bb.command('commit <changeId>')
  .description('Validate and commit a proposed change')
  .option('--agent <id>', 'validator agent id', 'cli')
  .action((changeId: string, opts: { agent: string }, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; json: boolean }>();
    const board = new LockedBlackboard(resolveData(g));
    const valid = board.validate(changeId, opts.agent);
    if (!valid) die(`change ${changeId} has conflicts — run 'bb abort' to cancel`);
    const result = board.commit(changeId);
    if (!result.success) die(`commit failed: ${result.message}`);
    print(g.json ? result : `✓ committed ${changeId}: ${result.message}`, g.json);
  });

bb.command('abort <changeId>')
  .description('Abort a pending proposed change')
  .action((changeId: string, _opts: Record<string, unknown>, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; json: boolean }>();
    const board = new LockedBlackboard(resolveData(g));
    const ok = board.abort(changeId);
    if (!ok) die(`change not found: ${changeId}`);
    print(g.json ? { aborted: changeId } : `✓ aborted ${changeId}`, g.json);
  });

// ── auth ──────────────────────────────────────────────────────────────────────

const auth = program.command('auth').description('Permission and token operations');

auth.command('token <agentId>')
  .description('Issue a permission token for an agent')
  .option('--resource <type>', 'resource type to grant', 'blackboard')
  .option('--justification <text>', 'justification text', 'CLI-issued token')
  .option('--scope <scope>', 'permission scope')
  .option('--why', 'show scoring breakdown (justification/trust/risk) before issuing')
  .action(async (agentId: string, opts: { resource: string; justification: string; scope?: string; why?: boolean }, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; json: boolean }>();
    const auditPath = path.join(resolveData(g), 'audit_log.jsonl');
    const guardian = new AuthGuardian({ auditLogPath: auditPath });
    guardian.registerAgentTrust({ agentId, trustLevel: 1, allowedResources: [opts.resource] });

    if (opts.why) {
      const scoring = guardian.scoreRequest(agentId, opts.resource, opts.justification, opts.scope);
      if (g.json) {
        print(scoring, true);
      } else {
        console.log(`justification score (40%): ${(scoring.justificationScore * 100).toFixed(1)}%`);
        console.log(`trust score        (30%): ${(scoring.trustScore * 100).toFixed(1)}%`);
        console.log(`risk score         (30%): ${(scoring.riskScore * 100).toFixed(1)}% risk → ${((1 - scoring.riskScore) * 100).toFixed(1)}% contribution`);
        console.log(`weighted score:           ${(scoring.weightedScore * 100).toFixed(1)}%`);
        console.log(`verdict:                  ${scoring.approved ? 'APPROVED' : 'DENIED'}${scoring.reason ? ` — ${scoring.reason}` : ''}`);
        console.log('');
      }
    }

    const grant = await guardian.requestPermission(agentId, opts.resource, opts.justification, opts.scope);
    if (g.json) {
      print(grant, true);
    } else {
      console.log(`token:    ${grant.grantToken ?? '(none)'}`);
      console.log(`granted:  ${grant.granted}`);
      console.log(`expires:  ${grant.expiresAt ?? 'never'}`);
      if (!grant.granted && grant.reason) console.log(`reason:   ${grant.reason}`);
    }
  });

auth.command('revoke <token>')
  .description('Revoke a permission token')
  .action((token: string, _opts: Record<string, unknown>, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; json: boolean }>();
    const auditPath = path.join(resolveData(g), 'audit_log.jsonl');
    const guardian = new AuthGuardian({ auditLogPath: auditPath });
    guardian.revokeToken(token);
    print(g.json ? { revoked: token } : `✓ revoked`, g.json);
  });

auth.command('check <token> <permission>')
  .description('Check if a token grants a permission (exits 0=yes, 1=no)')
  .action((token: string, permission: string, _opts: Record<string, unknown>, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; json: boolean }>();
    const auditPath = path.join(resolveData(g), 'audit_log.jsonl');
    const guardian = new AuthGuardian({ auditLogPath: auditPath });
    const valid = guardian.validateToken(token);
    const violation = valid ? guardian.enforceRestrictions(token, { type: permission }) : 'invalid or expired token';
    const allowed = valid && violation === null;
    print(
      g.json ? { allowed, permission, reason: violation ?? null } : (allowed ? `✓ allowed` : `✗ denied: ${violation}`),
      g.json,
    );
    process.exit(allowed ? 0 : 1);
  });

// ── budget ────────────────────────────────────────────────────────────────────

const budgetCmd = program.command('budget').description('Token budget operations');

budgetCmd.command('status [agentId]')
  .description('Show token budget status')
  .option('--ceiling <n>', 'total token ceiling', (v) => parseInt(v, 10))
  .action((agentId: string | undefined, opts: { ceiling?: number }, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; json: boolean }>();
    const ceiling = opts.ceiling ?? 100_000;
    const fed = new FederatedBudget({ ceiling });
    if (agentId) {
      const spent = fed.getAgentSpent(agentId);
      const snap = { agentId, spent, remaining: fed.remaining(), ceiling: fed.getCeiling() };
      print(g.json ? snap : `agent:     ${agentId}\nspent:     ${snap.spent}\nremaining: ${snap.remaining}\nceiling:   ${snap.ceiling}`, g.json);
    } else {
      const snap = { totalSpent: fed.getTotalSpent(), remaining: fed.remaining(), ceiling: fed.getCeiling(), byAgent: fed.getSpendLog() };
      print(g.json ? snap : `total-spent: ${snap.totalSpent}\nremaining:   ${snap.remaining}\nceiling:     ${snap.ceiling}`, g.json);
    }
  });

budgetCmd.command('set-ceiling <amount>')
  .description('Update the token ceiling')
  .action((amount: string, _opts: Record<string, unknown>, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; json: boolean }>();
    const n = parseInt(amount, 10);
    if (isNaN(n) || n <= 0) die('amount must be a positive integer');
    const fed = new FederatedBudget({ ceiling: n });
    fed.setCeiling(n);
    print(g.json ? { ceiling: n } : `✓ ceiling set to ${n}`, g.json);
  });

// ── audit ─────────────────────────────────────────────────────────────────────

const auditCmd = program.command('audit').description('Audit log operations');

function getAuditLogPath(dataDir: string): string {
  return path.join(dataDir, 'audit_log.jsonl');
}

auditCmd.command('log')
  .description('Print audit log entries')
  .option('--limit <n>', 'show last N entries', (v) => parseInt(v, 10))
  .action((opts: { limit?: number }, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; json: boolean }>();
    const logFile = getAuditLogPath(resolveData(g));
    if (!fs.existsSync(logFile)) die(`audit log not found: ${logFile}`);
    const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
    const slice = opts.limit ? lines.slice(-opts.limit) : lines;
    if (g.json) {
      console.log(JSON.stringify(slice.map(l => { try { return JSON.parse(l); } catch { return l; } }), null, 2));
    } else {
      if (slice.length === 0) { console.log('(no entries)'); return; }
      slice.forEach(l => console.log(l));
    }
  });

auditCmd.command('tail')
  .description('Live-stream new audit log entries (Ctrl+C to stop)')
  .action((_opts: Record<string, unknown>, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; json: boolean }>();
    const logFile = getAuditLogPath(resolveData(g));
    if (!fs.existsSync(logFile)) die(`audit log not found: ${logFile}`);
    let size = fs.statSync(logFile).size;
    console.log(`tailing ${logFile} — Ctrl+C to stop`);
    const interval = setInterval(() => {
      try {
        // Open fd first, then fstat the descriptor — eliminates TOCTOU (CWE-367)
        const fd = fs.openSync(logFile, 'r');
        try {
          const newSize = fs.fstatSync(fd).size;
          if (newSize > size) {
            const buf = Buffer.alloc(newSize - size);
            fs.readSync(fd, buf, 0, buf.length, size);
            buf.toString('utf-8').trim().split('\n').filter(Boolean).forEach(l => console.log(l));
            size = newSize;
          }
        } finally {
          fs.closeSync(fd);
        }
      } catch { /* file may be briefly locked */ }
    }, 500);
    process.on('SIGINT', () => { clearInterval(interval); process.exit(0); });
  });

auditCmd.command('clear')
  .description('Clear the audit log (prompts for confirmation)')
  .option('--yes', 'skip confirmation prompt')
  .action(async (opts: { yes?: boolean }, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; json: boolean }>();
    const logFile = getAuditLogPath(resolveData(g));
    if (!opts.yes) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>(r => rl.question(`Clear ${logFile}? [y/N] `, r));
      rl.close();
      if (answer.toLowerCase() !== 'y') { console.log('Aborted.'); return; }
    }
    fs.writeFileSync(logFile, '');
    print(g.json ? { cleared: logFile } : `✓ cleared ${logFile}`, g.json);
  });

// ── env (environment management) ──────────────────────────────────────────────

const envCmd = program.command('env').description('Multi-environment management (isolation, promotion, backup)');

envCmd.command('init')
  .description('Scaffold an environment data directory (all 7 envs if no --env given)')
  .action((_opts: Record<string, unknown>, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; env?: string; json: boolean }>();
    const mgr = new EnvironmentManager(resolveData(g));
    if (g.env) {
      mgr.init(g.env);
      print(g.json ? { initialized: g.env } : `✓ initialized env '${g.env}'`, g.json);
    } else {
      mgr.initAll();
      print(g.json ? { initialized: mgr.getChain().concat(['sandbox']) } : `✓ all environments initialized`, g.json);
    }
  });

envCmd.command('list')
  .description('List all environments with existence and key count')
  .action((_opts: Record<string, unknown>, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; env?: string; json: boolean }>();
    const mgr = new EnvironmentManager(resolveData(g));
    const envs = mgr.list();
    if (g.json) {
      print(envs, true);
    } else {
      const lines = envs.map(e => `${e.name.padEnd(10)} ${e.exists ? '✓' : '✗'} (${e.keyCount} keys)`);
      console.log(lines.join('\n'));
    }
  });

envCmd.command('chain')
  .description('Show the configured promotion chain')
  .action((_opts: Record<string, unknown>, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; json: boolean }>();
    const mgr = new EnvironmentManager(resolveData(g));
    const chain = mgr.getChain();
    print(g.json ? chain : chain.join(' → '), g.json);
  });

envCmd.command('diff')
  .description('Compare config artefacts between two environments')
  .requiredOption('--from <env>', 'source environment')
  .requiredOption('--to <env>', 'target environment')
  .action((opts: { from: string; to: string }, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; json: boolean }>();
    const mgr = new EnvironmentManager(resolveData(g));
    const result = mgr.diff(opts.from, opts.to);
    if (g.json) {
      print(result, true);
    } else if (result.differences.length === 0) {
      console.log(`No differences between '${opts.from}' and '${opts.to}'`);
    } else {
      for (const d of result.differences) {
        const sym = d.status === 'added' ? '+' : d.status === 'removed' ? '-' : '~';
        console.log(`  ${sym} ${d.file} (${d.status})`);
      }
    }
  });

envCmd.command('promote')
  .description('Promote config artefacts one step up the chain')
  .requiredOption('--from <env>', 'source environment')
  .requiredOption('--to <env>', 'target environment')
  .option('--confirmed-by <name>', 'required for preprod gate')
  .option('--approved-by <name>', 'required for prod gate')
  .action((opts: { from: string; to: string; confirmedBy?: string; approvedBy?: string }, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; json: boolean }>();
    const mgr = new EnvironmentManager(resolveData(g));
    try {
      const result = mgr.promote(opts.from, opts.to, {
        confirmedBy: opts.confirmedBy,
        approvedBy: opts.approvedBy,
      });
      print(g.json ? result : `✓ promoted ${opts.from} → ${opts.to} (${result.configsCopied.length} configs copied)`, g.json);
    } catch (err) {
      die(err instanceof Error ? err.message : String(err));
    }
  });

// ── env backup subcommand group ───────────────────────────────────────────────

const envBackup = envCmd.command('backup').description('Backup management for an environment');

envBackup.command('create')
  .description('Create a backup of the environment data directory (alias: network-ai env backup)')
  .action((_opts: Record<string, unknown>, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; env?: string; json: boolean }>();
    if (!g.env) die('--env <name> is required for backup create');
    const mgr = new EnvironmentManager(resolveData(g));
    const result = mgr.backup(g.env);
    print(g.json ? result : `✓ backup created: ${result.backupId} (${result.filesCount} files)`, g.json);
  });

envBackup.command('list')
  .description('List available backups for an environment')
  .action((_opts: Record<string, unknown>, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; env?: string; json: boolean }>();
    if (!g.env) die('--env <name> is required for backup list');
    const mgr = new EnvironmentManager(resolveData(g));
    const backups = mgr.listBackups(g.env);
    if (g.json) {
      print(backups, true);
    } else if (backups.length === 0) {
      console.log('(no backups)');
    } else {
      for (const b of backups) {
        console.log(`  ${b.backupId}  ${b.timestamp}  ${(b.sizeBytes / 1024).toFixed(1)} KB`);
      }
    }
  });

envBackup.command('restore')
  .description('Restore an environment from a backup')
  .option('--backup <id>', 'backup ID to restore')
  .option('--latest', 'restore the most recent backup')
  .action((opts: { backup?: string; latest?: boolean }, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; env?: string; json: boolean }>();
    if (!g.env) die('--env <name> is required for backup restore');
    if (!opts.backup && !opts.latest) die('provide --backup <id> or --latest');
    const mgr = new EnvironmentManager(resolveData(g));
    let backupId = opts.backup;
    if (opts.latest) {
      const backups = mgr.listBackups(g.env);
      if (backups.length === 0) die(`no backups found for env '${g.env}'`);
      backupId = backups[0].backupId;
    }
    try {
      const result = mgr.restore(g.env, backupId!);
      print(g.json ? result : `✓ restored ${result.filesRestored} files from backup '${result.backupId}'`, g.json);
    } catch (err) {
      die(err instanceof Error ? err.message : String(err));
    }
  });

envBackup.command('prune')
  .description('Remove old backups, keeping the N most recent')
  .requiredOption('--keep <n>', 'number of backups to retain', (v) => parseInt(v, 10))
  .action((opts: { keep: number }, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; env?: string; json: boolean }>();
    if (!g.env) die('--env <name> is required for backup prune');
    const mgr = new EnvironmentManager(resolveData(g));
    const deleted = mgr.pruneBackups(g.env, opts.keep);
    print(g.json ? { deleted } : `✓ pruned ${deleted} backup(s), keeping ${opts.keep}`, g.json);
  });

// ── doctor ────────────────────────────────────────────────────────────────────

program.command('doctor')
  .description('Validate the Network-AI environment and configuration')
  .action((_opts: Record<string, unknown>, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; env?: string; json: boolean }>();
    const dataDir = resolveData(g);

    const results: Array<{ check: string; status: 'pass' | 'warn' | 'fail'; detail: string }> = [];
    let exitCode = 0;

    function check(name: string, fn: () => { status: 'pass' | 'warn' | 'fail'; detail: string }): void {
      try {
        results.push({ check: name, ...fn() });
      } catch (err) {
        results.push({ check: name, status: 'fail', detail: err instanceof Error ? err.message : String(err) });
      }
    }

    // 1 — Data directory exists and is writable
    check('data-dir', () => {
      if (!fs.existsSync(dataDir)) {
        return { status: 'warn', detail: `data dir does not exist: ${dataDir} (will be created on first write)` };
      }
      try {
        fs.accessSync(dataDir, fs.constants.W_OK);
        return { status: 'pass', detail: dataDir };
      } catch {
        return { status: 'fail', detail: `data dir is not writable: ${dataDir}` };
      }
    });

    // 2 — NETWORK_AI_ENV routing
    check('env-routing', () => {
      const envVar = process.env['NETWORK_AI_ENV'];
      if (g.env) {
        return { status: 'pass', detail: `--env ${g.env} (CLI flag)` };
      }
      if (envVar) {
        return { status: 'pass', detail: `NETWORK_AI_ENV=${envVar}` };
      }
      return { status: 'warn', detail: 'no --env or NETWORK_AI_ENV set; using root data dir' };
    });

    // 3 — Audit log integrity (valid JSONL)
    check('audit-log', () => {
      const logFile = getAuditLogPath(dataDir);
      if (!fs.existsSync(logFile)) {
        return { status: 'warn', detail: 'audit log does not exist yet' };
      }
      const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(l => l.trim());
      let badLines = 0;
      for (const line of lines) {
        try { JSON.parse(line); } catch { badLines++; }
      }
      if (badLines > 0) {
        return { status: 'fail', detail: `${badLines} of ${lines.length} lines are not valid JSON` };
      }
      return { status: 'pass', detail: `${lines.length} entries, all valid JSONL` };
    });

    // 4 — Pending changes (stale WAL entries)
    check('pending-changes', () => {
      const pendingDir = path.join(dataDir, 'pending_changes');
      if (!fs.existsSync(pendingDir)) {
        return { status: 'pass', detail: 'no pending_changes dir' };
      }
      const files = fs.readdirSync(pendingDir).filter(f => f.endsWith('.json'));
      if (files.length === 0) {
        return { status: 'pass', detail: 'no pending changes' };
      }
      // Flag as warn if any are older than 5 minutes
      const stale = files.filter(f => {
        try {
          const st = fs.statSync(path.join(pendingDir, f));
          return (Date.now() - st.mtimeMs) > 5 * 60 * 1000;
        } catch { return false; }
      });
      if (stale.length > 0) {
        return { status: 'warn', detail: `${stale.length} stale pending change(s) (>5 min old)` };
      }
      return { status: 'pass', detail: `${files.length} in-flight pending change(s)` };
    });

    // 5 — System paused?
    check('kill-switch', () => {
      const sentinel = path.join(dataDir, 'SYSTEM_PAUSED');
      if (fs.existsSync(sentinel)) {
        return { status: 'warn', detail: 'system is PAUSED (run "network-ai resume" to unpause)' };
      }
      return { status: 'pass', detail: 'system is running' };
    });

    // 6 — MCP secret configured (env var)
    check('mcp-secret', () => {
      const secret = process.env['NETWORK_AI_MCP_SECRET'];
      if (!secret) {
        return { status: 'warn', detail: 'NETWORK_AI_MCP_SECRET not set; McpSseServer will refuse to start without a secret' };
      }
      return { status: 'pass', detail: 'NETWORK_AI_MCP_SECRET is set' };
    });

    // 7 — Blackboard file is valid JSON (if it exists)
    check('blackboard-schema', () => {
      const bbFile = path.join(dataDir, 'blackboard.json');
      if (!fs.existsSync(bbFile)) {
        return { status: 'pass', detail: 'blackboard file does not exist yet' };
      }
      try {
        const raw = fs.readFileSync(bbFile, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return { status: 'fail', detail: 'blackboard.json is not a JSON object' };
        }
        return { status: 'pass', detail: `blackboard.json OK (${Object.keys(parsed as Record<string, unknown>).length} keys)` };
      } catch (e) {
        return { status: 'fail', detail: `blackboard.json parse error: ${e instanceof Error ? e.message : String(e)}` };
      }
    });

    // Determine exit code
    for (const r of results) {
      if (r.status === 'fail') exitCode = 1;
    }

    if (g.json) {
      print({ checks: results, ok: exitCode === 0 }, true);
    } else {
      for (const r of results) {
        const icon = r.status === 'pass' ? '✓' : r.status === 'warn' ? '⚠' : '✗';
        console.log(`${icon} [${r.status.toUpperCase().padEnd(4)}] ${r.check}: ${r.detail}`);
      }
      if (exitCode === 0) {
        console.log('\nAll checks passed.');
      } else {
        console.log('\nOne or more checks failed.');
      }
    }

    process.exit(exitCode);
  });

// ── inspect ───────────────────────────────────────────────────────────────────

program.command('inspect <key>')
  .description('Inspect a blackboard key: value, metadata, audit trail')
  .option('--history', 'show WAL/pending version history')
  .option('--audit', 'show audit log entries for this key')
  .action((key: string, opts: { history?: boolean; audit?: boolean }, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; env?: string; json: boolean }>();
    const dataDir = resolveData(g);

    const bb = new LockedBlackboard(dataDir);
    const entry = bb.read(key);

    const result: Record<string, unknown> = {
      key,
      exists: entry !== null,
      value: entry?.value ?? null,
      metadata: entry ? {
        source_agent: entry.source_agent,
        timestamp: entry.timestamp,
        ttl: entry.ttl,
        version: entry.version,
      } : null,
    };

    if (opts.history) {
      const pendingDir = path.join(dataDir, 'pending_changes');
      const history: unknown[] = [];
      if (fs.existsSync(pendingDir)) {
        const files = fs.readdirSync(pendingDir)
          .filter(f => f.endsWith('.json'))
          .sort();
        for (const f of files) {
          try {
            const raw = JSON.parse(fs.readFileSync(path.join(pendingDir, f), 'utf8')) as Record<string, unknown>;
            if (raw['key'] === key) history.push(raw);
          } catch { /* skip malformed */ }
        }
      }
      result['pendingHistory'] = history;
    }

    if (opts.audit) {
      const logFile = getAuditLogPath(dataDir);
      const auditEntries: unknown[] = [];
      if (fs.existsSync(logFile)) {
        const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const entry2 = JSON.parse(line) as Record<string, unknown>;
            if (entry2['key'] === key) auditEntries.push(entry2);
          } catch { /* skip */ }
        }
      }
      result['auditTrail'] = auditEntries;
    }

    if (g.json) {
      print(result, true);
    } else {
      console.log(`key:    ${key}`);
      console.log(`exists: ${result['exists']}`);
      if (result['exists']) {
        console.log(`value:  ${JSON.stringify(result['value'], null, 2)}`);
        if (result['metadata']) {
          console.log(`meta:   ${JSON.stringify(result['metadata'], null, 2)}`);
        }
      }
      if (opts.history && Array.isArray(result['pendingHistory'])) {
        const h = result['pendingHistory'] as unknown[];
        console.log(`\npending history (${h.length} entries):`);
        h.forEach((e, i) => console.log(`  [${i + 1}] ${JSON.stringify(e)}`));
      }
      if (opts.audit && Array.isArray(result['auditTrail'])) {
        const a = result['auditTrail'] as unknown[];
        console.log(`\naudit trail (${a.length} entries):`);
        a.forEach((e, i) => console.log(`  [${i + 1}] ${JSON.stringify(e)}`));
      }
    }
  });

// ── pause / resume (kill switch) ──────────────────────────────────────────────

program.command('pause')
  .description('Pause all orchestrator activity (writes SYSTEM_PAUSED sentinel)')
  .action((_opts: Record<string, unknown>, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; json: boolean }>();
    const dataDir = resolveData(g);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const sentinel = path.join(dataDir, 'SYSTEM_PAUSED');
    const ts = new Date().toISOString();
    fs.writeFileSync(sentinel, `paused at ${ts}\n`, 'utf8');
    print(g.json ? { paused: true, at: ts, sentinel } : `✓ system paused at ${ts}`, g.json);
  });

program.command('resume')
  .description('Resume orchestrator activity (removes SYSTEM_PAUSED sentinel)')
  .action((_opts: Record<string, unknown>, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; json: boolean }>();
    const dataDir = resolveData(g);
    const sentinel = path.join(dataDir, 'SYSTEM_PAUSED');
    if (!fs.existsSync(sentinel)) {
      print(g.json ? { paused: false, detail: 'system was not paused' } : '✓ system is not paused', g.json);
      return;
    }
    fs.unlinkSync(sentinel);
    print(g.json ? { paused: false, resumed: true } : '✓ system resumed', g.json);
  });

// ── parse ─────────────────────────────────────────────────────────────────────

// Auto-detect MCP stdio mode: when stdin is piped (not a TTY) and no
// subcommand was given, start the MCP server in stdio transport mode.
// This is the convention used by Glama, Claude Desktop, Cursor, etc.
const userArgs = process.argv.slice(2);

// Propagate --minimal flag to env var before any commands run so that
// LockedBlackboard and other components can check it in their constructors.
if (userArgs.includes('--minimal') || process.env['NETWORK_AI_MINIMAL'] === '1') {
  process.env['NETWORK_AI_MINIMAL'] = '1';
}

if (!process.stdin.isTTY && userArgs.length === 0) {
  // Set --stdio before importing so the server module picks it up
  process.argv.push('--stdio');
  import('./mcp-server').catch(err => {
    process.stderr.write(`[network-ai] Failed to start MCP stdio mode: ${err}\n`);
    process.exit(1);
  });
} else {
  program.parse(process.argv);
}
