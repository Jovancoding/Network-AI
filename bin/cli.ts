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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../package.json') as { version: string; name: string };

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
  console.error(`error: ${msg}`);
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
  .addOption(new Option('--json', 'output raw JSON (useful for piping)'));

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
  .action(async (agentId: string, opts: { resource: string; justification: string; scope?: string }, cmd: Command) => {
    const g = cmd.optsWithGlobals<{ data: string; json: boolean }>();
    const auditPath = path.join(resolveData(g), 'audit_log.jsonl');
    const guardian = new AuthGuardian({ auditLogPath: auditPath });
    guardian.registerAgentTrust({ agentId, trustLevel: 1, allowedResources: [opts.resource] });
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

// ── parse ─────────────────────────────────────────────────────────────────────

program.parse(process.argv);
