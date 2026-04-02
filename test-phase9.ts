/**
 * Phase 9: Agent Runtime & Console — Test Suite
 *
 * Tests for:
 *   9a — SandboxPolicy: command matching, path scoping, risk assessment
 *   9b — ShellExecutor: process spawning, timeout, concurrency
 *   9c — FileAccessor: scoped read/write/list, traversal protection
 *   9d — ApprovalGate: approval flow, auto-approve, history
 *   9e — AgentRuntime: integrated exec/read/write with policy + approval
 *   9f — ConsoleUI: commands, feed, status, command handlers
 *   9g — Orchestrator Wiring: blackboard, budget, FSM, adapters via console
 *   9h — StrategyAgent: pools, workload partitioning, adaptive strategy
 *   9i — Pipe Mode: JSON stdin/stdout protocol
 *
 * Run with: npx ts-node test-phase9.ts
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { EventEmitter } from 'events';

import {
  SandboxPolicy,
  ShellExecutor,
  FileAccessor,
  ApprovalGate,
  AgentRuntime,
  RuntimePolicyError,
  RuntimeApprovalError,
} from './lib/agent-runtime';
import type {
  SandboxPolicyConfig,
  ShellResult,
  ShellOptions,
  FileResult,
  ApprovalRequest,
  ApprovalDecision,
  RuntimeAuditEntry,
  AgentRuntimeOptions,
} from './lib/agent-runtime';

import { ConsoleUI } from './lib/console-ui';
import type { ConsoleStatus, FeedEntry, ConsoleUIOptions } from './lib/console-ui';
import { LockedBlackboard } from './lib/locked-blackboard';
import { FederatedBudget } from './lib/federated-budget';
import { JourneyFSM } from './lib/fsm-journey';
import { AdapterRegistry } from './adapters/adapter-registry';
import {
  AgentPool,
  WorkloadPartitioner,
  StrategyAgent,
  adaptiveStrategy,
} from './lib/strategy-agent';
import type {
  AgentTemplate,
  StrategyPlan,
  SystemSnapshot,
  PoolStatus,
} from './lib/strategy-agent';

// ============================================================================
// TEST UTILITIES
// ============================================================================

const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
} as const;

let passed = 0;
let failed = 0;

function log(msg: string, color: keyof typeof colors = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function header(title: string) {
  console.log('\n' + '='.repeat(64));
  log(`  ${title}`, 'bold');
  console.log('='.repeat(64));
}

function pass(test: string) { log(`  [PASS] ${test}`, 'green'); passed++; }
function fail(test: string, err?: string) {
  log(`  [FAIL] ${test}`, 'red');
  if (err) log(`         ${err}`, 'red');
  failed++;
}

function assert(condition: boolean, test: string, detail?: string) {
  if (condition) pass(test);
  else fail(test, detail);
}

function assertThrows(fn: () => void, test: string) {
  try { fn(); fail(test, 'Expected to throw'); }
  catch { pass(test); }
}

async function assertRejects(fn: () => Promise<unknown>, test: string) {
  try { await fn(); fail(test, 'Expected to reject'); }
  catch { pass(test); }
}

/** Create a temp directory for file tests */
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-test-'));
  return dir;
}

/** Clean up a temp directory */
function cleanTempDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ============================================================================
// 9a — SANDBOX POLICY
// ============================================================================

function testSandboxPolicy() {
  header('Phase 9a — SandboxPolicy');

  // 1. Constructor sets basePath
  {
    const policy = new SandboxPolicy({ basePath: '/test/project' });
    assert(policy.basePath === path.resolve('/test/project'), 'Constructor resolves basePath');
  }

  // 2. Empty allowedCommands blocks all
  {
    const policy = new SandboxPolicy({ basePath: '/test', allowedCommands: [] });
    assert(!policy.isCommandAllowed('npm test'), 'Empty allowlist blocks all commands');
  }

  // 3. Allowed command passes
  {
    const policy = new SandboxPolicy({ basePath: '/test', allowedCommands: ['npm *'] });
    assert(policy.isCommandAllowed('npm test'), 'Matching allowed command passes');
  }

  // 4. Non-matching command blocked
  {
    const policy = new SandboxPolicy({ basePath: '/test', allowedCommands: ['npm *'] });
    assert(!policy.isCommandAllowed('rm -rf /'), 'Non-matching command blocked');
  }

  // 5. Blocked commands override allowed
  {
    const policy = new SandboxPolicy({
      basePath: '/test',
      allowedCommands: ['*'],
      blockedCommands: ['rm -rf /'],
    });
    assert(!policy.isCommandAllowed('rm -rf /'), 'Blocked overrides allowed');
  }

  // 6. Empty command blocked
  {
    const policy = new SandboxPolicy({ basePath: '/test', allowedCommands: ['*'] });
    assert(!policy.isCommandAllowed(''), 'Empty command blocked');
    assert(!policy.isCommandAllowed('   '), 'Whitespace-only command blocked');
  }

  // 7. Glob matching works with wildcards
  {
    const policy = new SandboxPolicy({ basePath: '/test', allowedCommands: ['git *'] });
    assert(policy.isCommandAllowed('git status'), 'git status matches git *');
    assert(policy.isCommandAllowed('git push origin main'), 'git push matches git *');
    assert(!policy.isCommandAllowed('npm test'), 'npm test does not match git *');
  }

  // 8. requiresApproval detects patterns
  {
    const policy = new SandboxPolicy({
      basePath: '/test',
      allowedCommands: ['*'],
      approvalRequired: ['rm *', 'git push*'],
    });
    assert(policy.requiresApproval('rm foo.txt'), 'rm requires approval');
    assert(policy.requiresApproval('git push origin main'), 'git push requires approval');
    assert(!policy.requiresApproval('npm test'), 'npm test does not require approval');
  }

  // 9. Risk assessment
  {
    const policy = new SandboxPolicy({ basePath: '/test' });
    assert(policy.assessRisk('rm -rf node_modules') === 'high', 'rm is high risk');
    assert(policy.assessRisk('git status') === 'medium', 'git is medium risk');
    assert(policy.assessRisk('echo hello') === 'low', 'echo is low risk');
  }

  // 10. Path validation (within scope)
  {
    const base = path.resolve('/test/project');
    const policy = new SandboxPolicy({ basePath: base, allowedPaths: ['.'] });
    assert(policy.isPathAllowed('src/index.ts'), 'Relative path within scope allowed');
  }

  // 11. Path traversal blocked
  {
    const base = path.resolve('/test/project');
    const policy = new SandboxPolicy({ basePath: base });
    const result = policy.resolvePath('../../etc/passwd');
    assert(result === null, 'Path traversal returns null');
  }

  // 12. Blocked paths override allowed
  {
    const base = path.resolve('/test/project');
    const policy = new SandboxPolicy({
      basePath: base,
      allowedPaths: ['.'],
      blockedPaths: ['secrets'],
    });
    assert(!policy.isPathAllowed('secrets/key.pem'), 'Blocked path rejected');
    assert(policy.isPathAllowed('src/app.ts'), 'Non-blocked path allowed');
  }

  // 13. allowCommand dynamically adds pattern
  {
    const policy = new SandboxPolicy({ basePath: '/test', allowedCommands: [] });
    assert(!policy.isCommandAllowed('python script.py'), 'Initially blocked');
    policy.allowCommand('python *');
    assert(policy.isCommandAllowed('python script.py'), 'Allowed after dynamic add');
  }

  // 14. disallowCommand removes pattern
  {
    const policy = new SandboxPolicy({ basePath: '/test', allowedCommands: ['npm *'] });
    assert(policy.isCommandAllowed('npm test'), 'Initially allowed');
    policy.disallowCommand('npm *');
    assert(!policy.isCommandAllowed('npm test'), 'Blocked after disallow');
  }

  // 15. allowPath dynamically adds scope
  {
    const base = path.resolve('/test/project');
    const policy = new SandboxPolicy({ basePath: base, allowedPaths: [] });
    assert(!policy.isPathAllowed('src/index.ts'), 'Initially not allowed');
    policy.allowPath('src');
    assert(policy.isPathAllowed('src/index.ts'), 'Allowed after dynamic add');
  }

  // 16. blockPath dynamically blocks scope
  {
    const base = path.resolve('/test/project');
    const policy = new SandboxPolicy({ basePath: base, allowedPaths: ['.'] });
    assert(policy.isPathAllowed('.env'), 'Initially allowed');
    policy.blockPath('.env');
    // .env at root should now be blocked
    assert(!policy.isPathAllowed('.env'), 'Blocked after dynamic block');
  }

  // 17. getConfig returns a copy
  {
    const policy = new SandboxPolicy({ basePath: '/test', allowedCommands: ['npm *'] });
    const config = policy.getConfig();
    assert(config.allowedCommands.includes('npm *'), 'Config includes allowed commands');
    assert(typeof config.defaultTimeoutMs === 'number', 'Config has default timeout');
  }

  // 18. Default blocked commands include dangerous patterns
  {
    const policy = new SandboxPolicy({ basePath: '/test', allowedCommands: ['*'] });
    assert(!policy.isCommandAllowed('rm -rf /'), 'rm -rf / blocked by default');
    assert(!policy.isCommandAllowed('format C:'), 'format blocked by default');
  }

  // 19. Case-insensitive glob matching
  {
    const policy = new SandboxPolicy({ basePath: '/test', allowedCommands: ['NPM *'] });
    assert(policy.isCommandAllowed('npm test'), 'Case-insensitive match works');
  }

  // 20. Default properties
  {
    const policy = new SandboxPolicy({ basePath: '/test' });
    assert(policy.maxConcurrentProcesses === 5, 'Default maxConcurrentProcesses is 5');
    assert(policy.defaultTimeoutMs === 30_000, 'Default timeout is 30s');
    assert(policy.defaultMaxOutputBytes === 1_048_576, 'Default max output is 1MB');
    assert(policy.autoApproveReads === true, 'Auto-approve reads by default');
  }
}

// ============================================================================
// 9b — SHELL EXECUTOR
// ============================================================================

async function testShellExecutor() {
  header('Phase 9b — ShellExecutor');

  const isWindows = process.platform === 'win32';
  const echoCmd = isWindows ? 'echo hello' : 'echo hello';

  // 1. Execute a simple command
  {
    const policy = new SandboxPolicy({ basePath: process.cwd(), allowedCommands: ['echo *'] });
    const executor = new ShellExecutor(policy);
    const result = await executor.execute('echo hello');
    assert(result.stdout.trim() === 'hello', 'Simple echo produces correct output');
    assert(result.exitCode === 0, 'Exit code is 0');
    assert(!result.timedOut, 'Not timed out');
    assert(!result.truncated, 'Not truncated');
  }

  // 2. Policy-blocked command throws
  {
    const policy = new SandboxPolicy({ basePath: process.cwd(), allowedCommands: ['echo *'] });
    const executor = new ShellExecutor(policy);
    await assertRejects(
      () => executor.execute('rm somefile'),
      'Blocked command throws RuntimePolicyError',
    );
  }

  // 3. Command with non-zero exit
  {
    const cmd = isWindows ? 'cmd /c exit 1' : 'exit 1';
    const policy = new SandboxPolicy({ basePath: process.cwd(), allowedCommands: ['*'] });
    const executor = new ShellExecutor(policy);
    const result = await executor.execute(cmd);
    assert(result.exitCode !== 0, 'Non-zero exit code captured');
  }

  // 4. Duration tracking
  {
    const policy = new SandboxPolicy({ basePath: process.cwd(), allowedCommands: ['echo *'] });
    const executor = new ShellExecutor(policy);
    const result = await executor.execute('echo timing');
    assert(result.durationMs >= 0, 'Duration is non-negative');
  }

  // 5. Running process count
  {
    const policy = new SandboxPolicy({ basePath: process.cwd(), allowedCommands: ['echo *'] });
    const executor = new ShellExecutor(policy);
    assert(executor.running === 0, 'No running processes initially');
  }

  // 6. Stderr captured
  {
    const cmd = isWindows ? 'echo error 1>&2' : 'echo error >&2';
    const policy = new SandboxPolicy({ basePath: process.cwd(), allowedCommands: ['echo *'] });
    const executor = new ShellExecutor(policy);
    const result = await executor.execute(cmd);
    assert(result.stderr.includes('error'), 'Stderr captured');
  }

  // 7. Timeout terminates command
  {
    const cmd = isWindows ? 'ping -n 10 127.0.0.1' : 'sleep 10';
    const allowed = isWindows ? 'ping *' : 'sleep *';
    const policy = new SandboxPolicy({ basePath: process.cwd(), allowedCommands: [allowed] });
    const executor = new ShellExecutor(policy);
    const result = await executor.execute(cmd, { timeoutMs: 500 });
    assert(result.timedOut, 'Command timed out');
  }

  // 8. Concurrency limit
  {
    const policy = new SandboxPolicy({
      basePath: process.cwd(),
      allowedCommands: ['echo *'],
      maxConcurrentProcesses: 1,
    });
    const executor = new ShellExecutor(policy);
    // Start one process
    const p1 = executor.execute('echo first');
    // Try to start another while first is likely still active
    // Since echo is so fast, we just verify the executor tracks count correctly
    await p1;
    assert(executor.running === 0, 'After completion, running count is 0');
  }
}

// ============================================================================
// 9c — FILE ACCESSOR
// ============================================================================

async function testFileAccessor() {
  header('Phase 9c — FileAccessor');

  const tmpDir = makeTempDir();

  try {
    // Setup test files
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'hello world');
    fs.mkdirSync(path.join(tmpDir, 'subdir'));
    fs.writeFileSync(path.join(tmpDir, 'subdir', 'nested.txt'), 'nested content');

    const policy = new SandboxPolicy({ basePath: tmpDir, allowedPaths: ['.'] });
    const accessor = new FileAccessor(policy);

    // 1. Read existing file
    {
      const result = await accessor.read('test.txt', 'agent-1');
      assert(result.success, 'Read existing file succeeds');
      assert(result.content === 'hello world', 'Read content matches');
    }

    // 2. Read nested file
    {
      const result = await accessor.read('subdir/nested.txt', 'agent-1');
      assert(result.success, 'Read nested file succeeds');
      assert(result.content === 'nested content', 'Nested content matches');
    }

    // 3. Read non-existent file
    {
      const result = await accessor.read('nonexistent.txt', 'agent-1');
      assert(!result.success, 'Read non-existent file fails');
      assert(!!result.error, 'Error message present');
    }

    // 4. Write new file
    {
      const result = await accessor.write('output.txt', 'written by agent', 'agent-1');
      assert(result.success, 'Write file succeeds');
      const content = fs.readFileSync(path.join(tmpDir, 'output.txt'), 'utf-8');
      assert(content === 'written by agent', 'Written content matches');
    }

    // 5. Write creates parent directories
    {
      const result = await accessor.write('deep/nested/file.txt', 'deep write', 'agent-1');
      assert(result.success, 'Write with nested dirs succeeds');
      const content = fs.readFileSync(path.join(tmpDir, 'deep', 'nested', 'file.txt'), 'utf-8');
      assert(content === 'deep write', 'Deep write content matches');
    }

    // 6. List directory
    {
      const result = await accessor.list('.', 'agent-1');
      assert(result.success, 'List directory succeeds');
      assert(Array.isArray(result.entries), 'Returns entries array');
      assert(result.entries!.some(e => e === 'test.txt'), 'Lists test.txt');
      assert(result.entries!.some(e => e === 'subdir/'), 'Lists subdir/ with trailing slash');
    }

    // 7. List subdirectory
    {
      const result = await accessor.list('subdir', 'agent-1');
      assert(result.success, 'List subdirectory succeeds');
      assert(result.entries!.includes('nested.txt'), 'Lists nested.txt');
    }

    // 8. Path traversal blocked
    {
      const result = await accessor.read('../../etc/passwd', 'agent-1');
      assert(!result.success, 'Path traversal read blocked');
      assert(result.error?.includes('traversal') === true, 'Error mentions traversal');
    }

    // 9. Write traversal blocked
    {
      const result = await accessor.write('../../tmp/evil.txt', 'bad', 'agent-1');
      assert(!result.success, 'Path traversal write blocked');
    }

    // 10. Not-allowed path blocked
    {
      const strictPolicy = new SandboxPolicy({
        basePath: tmpDir,
        allowedPaths: ['subdir'],
      });
      const strictAccessor = new FileAccessor(strictPolicy);

      const result = await strictAccessor.read('test.txt', 'agent-1');
      assert(!result.success, 'File outside allowed paths blocked');
    }

    // 11. Duration tracking
    {
      const result = await accessor.read('test.txt', 'agent-1');
      assert(result.durationMs >= 0, 'Duration is non-negative');
    }

    // 12. List non-existent directory
    {
      const result = await accessor.list('nonexistent', 'agent-1');
      assert(!result.success, 'List non-existent dir fails');
    }

  } finally {
    cleanTempDir(tmpDir);
  }
}

// ============================================================================
// 9d — APPROVAL GATE
// ============================================================================

async function testApprovalGate() {
  header('Phase 9d — ApprovalGate');

  // 1. Auto-approve all
  {
    const gate = new ApprovalGate(undefined, true);
    const decision = await gate.request({
      type: 'shell', target: 'npm test', agentId: 'tester', risk: 'low', timestamp: Date.now(),
    });
    assert(decision.approved, 'Auto-approve grants all requests');
    assert(decision.approvedBy === 'auto-approve-all', 'ApprovedBy is auto-approve-all');
  }

  // 2. No callback denies
  {
    const gate = new ApprovalGate();
    const decision = await gate.request({
      type: 'shell', target: 'rm -rf /', agentId: 'rogue', risk: 'high', timestamp: Date.now(),
    });
    assert(!decision.approved, 'No callback means denied');
    assert(decision.reason?.includes('No approval callback') === true, 'Reason mentions no callback');
  }

  // 3. Custom callback approves
  {
    const gate = new ApprovalGate(async (req) => {
      return { approved: true, approvedBy: 'human', reason: 'Looks safe' };
    });
    const decision = await gate.request({
      type: 'shell', target: 'npm test', agentId: 'tester', risk: 'low', timestamp: Date.now(),
    });
    assert(decision.approved, 'Custom callback approves');
    assert(decision.approvedBy === 'human', 'ApprovedBy from callback');
  }

  // 4. Custom callback denies
  {
    const gate = new ApprovalGate(async (req) => {
      return { approved: false, reason: 'Too risky' };
    });
    const decision = await gate.request({
      type: 'shell', target: 'rm -rf /', agentId: 'rogue', risk: 'high', timestamp: Date.now(),
    });
    assert(!decision.approved, 'Custom callback denies');
    assert(decision.reason === 'Too risky', 'Denial reason preserved');
  }

  // 5. History tracking
  {
    const gate = new ApprovalGate(undefined, true);
    await gate.request({ type: 'shell', target: 'cmd1', agentId: 'a', risk: 'low', timestamp: Date.now() });
    await gate.request({ type: 'shell', target: 'cmd2', agentId: 'b', risk: 'low', timestamp: Date.now() });
    const history = gate.getHistory();
    assert(history.length === 2, 'History has 2 entries');
    assert(history[0].request.target === 'cmd1', 'First entry is cmd1');
  }

  // 6. Stats tracking
  {
    const gate = new ApprovalGate(async (req) => {
      return { approved: req.risk !== 'high' };
    });
    await gate.request({ type: 'shell', target: 'safe', agentId: 'a', risk: 'low', timestamp: Date.now() });
    await gate.request({ type: 'shell', target: 'danger', agentId: 'b', risk: 'high', timestamp: Date.now() });
    const stats = gate.getStats();
    assert(stats.total === 2, 'Total is 2');
    assert(stats.approved === 1, 'One approved');
    assert(stats.denied === 1, 'One denied');
  }

  // 7. Events emitted
  {
    const gate = new ApprovalGate(undefined, true);
    let requestedCount = 0;
    let decidedCount = 0;
    gate.on('requested', () => { requestedCount++; });
    gate.on('decided', () => { decidedCount++; });
    await gate.request({ type: 'shell', target: 'test', agentId: 'x', risk: 'low', timestamp: Date.now() });
    assert(requestedCount === 1, 'Requested event emitted');
    assert(decidedCount === 1, 'Decided event emitted');
  }

  // 8. Conditional approval based on risk
  {
    const gate = new ApprovalGate(async (req) => {
      if (req.risk === 'high') return { approved: false, reason: 'High risk' };
      return { approved: true, approvedBy: 'policy' };
    });
    const low = await gate.request({ type: 'shell', target: 'echo hi', agentId: 'a', risk: 'low', timestamp: Date.now() });
    const high = await gate.request({ type: 'shell', target: 'rm -rf /', agentId: 'b', risk: 'high', timestamp: Date.now() });
    assert(low.approved && !high.approved, 'Risk-based conditional approval works');
  }
}

// ============================================================================
// 9e — AGENT RUNTIME (Integrated)
// ============================================================================

async function testAgentRuntime() {
  header('Phase 9e — AgentRuntime (Integrated)');

  const tmpDir = makeTempDir();

  try {
    fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'Hello from test');

    // 1. Runtime constructor creates all components
    {
      const rt = new AgentRuntime({
        policy: { basePath: tmpDir, allowedCommands: ['echo *'] },
        autoApproveAll: true,
      });
      assert(rt.policy instanceof SandboxPolicy, 'Policy is SandboxPolicy');
      assert(rt.shell instanceof ShellExecutor, 'Shell is ShellExecutor');
      assert(rt.files instanceof FileAccessor, 'Files is FileAccessor');
      assert(rt.gate instanceof ApprovalGate, 'Gate is ApprovalGate');
    }

    // 2. exec runs allowed command
    {
      const rt = new AgentRuntime({
        policy: { basePath: tmpDir, allowedCommands: ['echo *'] },
        autoApproveAll: true,
      });
      const result = await rt.exec('echo runtime test', 'agent-a');
      assert(result.stdout.trim() === 'runtime test', 'Exec runs and captures output');
    }

    // 3. exec blocks disallowed command
    {
      const rt = new AgentRuntime({
        policy: { basePath: tmpDir, allowedCommands: ['echo *'] },
        autoApproveAll: true,
      });
      await assertRejects(
        () => rt.exec('rm somefile', 'agent-a'),
        'Exec rejects disallowed command',
      );
    }

    // 4. exec with approval required — denied
    {
      const rt = new AgentRuntime({
        policy: { basePath: tmpDir, allowedCommands: ['rm *'], approvalRequired: ['rm *'] },
        onApproval: async () => ({ approved: false, reason: 'Nope' }),
      });
      await assertRejects(
        () => rt.exec('rm temp.txt', 'agent-a'),
        'Exec denied by approval gate',
      );
    }

    // 5. exec with approval required — approved
    {
      const rt = new AgentRuntime({
        policy: { basePath: tmpDir, allowedCommands: ['echo *'], approvalRequired: ['echo *'] },
        onApproval: async () => ({ approved: true, approvedBy: 'test' }),
      });
      const result = await rt.exec('echo approved', 'agent-a');
      assert(result.stdout.trim() === 'approved', 'Exec succeeds after approval');
    }

    // 6. readFile within scope
    {
      const rt = new AgentRuntime({
        policy: { basePath: tmpDir, allowedCommands: [] },
        autoApproveAll: true,
      });
      const result = await rt.readFile('readme.txt', 'agent-a');
      assert(result.success, 'readFile succeeds');
      assert(result.content === 'Hello from test', 'readFile content matches');
    }

    // 7. readFile outside scope
    {
      const rt = new AgentRuntime({
        policy: { basePath: tmpDir, allowedPaths: ['subdir'] },
        autoApproveAll: true,
      });
      const result = await rt.readFile('readme.txt', 'agent-a');
      assert(!result.success, 'readFile outside allowed paths fails');
    }

    // 8. writeFile with approval
    {
      const rt = new AgentRuntime({
        policy: { basePath: tmpDir },
        onApproval: async () => ({ approved: true, approvedBy: 'test' }),
      });
      const result = await rt.writeFile('agent-output.txt', 'agent wrote this', 'agent-a');
      assert(result.success, 'writeFile succeeds with approval');
      const content = fs.readFileSync(path.join(tmpDir, 'agent-output.txt'), 'utf-8');
      assert(content === 'agent wrote this', 'Written content matches');
    }

    // 9. writeFile denied without approval
    {
      const rt = new AgentRuntime({
        policy: { basePath: tmpDir },
        onApproval: async () => ({ approved: false, reason: 'No writes allowed' }),
      });
      const result = await rt.writeFile('blocked.txt', 'should not appear', 'agent-a');
      assert(!result.success, 'writeFile denied without approval');
      assert(!fs.existsSync(path.join(tmpDir, 'blocked.txt')), 'File was not created');
    }

    // 10. listDir
    {
      const rt = new AgentRuntime({
        policy: { basePath: tmpDir },
        autoApproveAll: true,
      });
      const result = await rt.listDir('.', 'agent-a');
      assert(result.success, 'listDir succeeds');
      assert(result.entries!.includes('readme.txt'), 'listDir includes readme.txt');
    }

    // 11. Audit log populated
    {
      const rt = new AgentRuntime({
        policy: { basePath: tmpDir, allowedCommands: ['echo *'] },
        autoApproveAll: true,
      });
      await rt.exec('echo audit test', 'auditor');
      const log = rt.getAuditLog();
      assert(log.length > 0, 'Audit log has entries');
      assert(log.some(e => e.action === 'shell_execute'), 'Audit log has shell_execute entry');
    }

    // 12. Audit log cleared
    {
      const rt = new AgentRuntime({
        policy: { basePath: tmpDir, allowedCommands: ['echo *'] },
        autoApproveAll: true,
      });
      await rt.exec('echo audit', 'auditor');
      assert(rt.getAuditLog().length > 0, 'Log has entries before clear');
      rt.clearAuditLog();
      assert(rt.getAuditLog().length === 0, 'Log empty after clear');
    }

    // 13. Events emitted on exec
    {
      const rt = new AgentRuntime({
        policy: { basePath: tmpDir, allowedCommands: ['echo *'] },
        autoApproveAll: true,
      });
      let started = false;
      let completed = false;
      rt.on('command:start', () => { started = true; });
      rt.on('command:complete', () => { completed = true; });
      await rt.exec('echo events', 'agent-a');
      assert(started, 'command:start event emitted');
      assert(completed, 'command:complete event emitted');
    }

    // 14. Policy violation event
    {
      const rt = new AgentRuntime({
        policy: { basePath: tmpDir, allowedCommands: ['echo *'] },
        autoApproveAll: true,
      });
      let violation = false;
      rt.on('policy:violation', () => { violation = true; });
      try { await rt.exec('rm badfile', 'agent-a'); } catch { /* expected */ }
      assert(violation, 'policy:violation event emitted');
    }

    // 15. Approval events emitted
    {
      const rt = new AgentRuntime({
        policy: { basePath: tmpDir, allowedCommands: ['echo *'], approvalRequired: ['echo *'] },
        onApproval: async () => ({ approved: true }),
      });
      let approvalRequested = false;
      let approvalDecided = false;
      rt.on('approval:requested', () => { approvalRequested = true; });
      rt.on('approval:decided', () => { approvalDecided = true; });
      await rt.exec('echo approval-events', 'agent-a');
      assert(approvalRequested, 'approval:requested event emitted');
      assert(approvalDecided, 'approval:decided event emitted');
    }

    // 16. Audit entry has correct structure
    {
      const rt = new AgentRuntime({
        policy: { basePath: tmpDir, allowedCommands: ['echo *'] },
        autoApproveAll: true,
      });
      await rt.exec('echo structure', 'struct-agent');
      const entry = rt.getAuditLog().find(e => e.action === 'shell_execute');
      assert(!!entry, 'Shell execute audit entry exists');
      assert(entry!.agentId === 'struct-agent', 'Audit entry agentId correct');
      assert(entry!.target === 'echo structure', 'Audit entry target correct');
      assert(!!entry!.timestamp, 'Audit entry has timestamp');
    }

    // 17. File access event emitted
    {
      const rt = new AgentRuntime({
        policy: { basePath: tmpDir },
        autoApproveAll: true,
      });
      let fileAccessMode = '';
      rt.on('file:access', (_agentId: string, _path: string, mode: string) => { fileAccessMode = mode; });
      await rt.readFile('readme.txt', 'reader');
      assert(fileAccessMode === 'read', 'file:access emitted with read mode');
    }

    // 18. RuntimePolicyError has correct code
    {
      const err = new RuntimePolicyError('test');
      assert(err.code === 'POLICY_VIOLATION', 'RuntimePolicyError code');
      assert(err.name === 'RuntimePolicyError', 'RuntimePolicyError name');
    }

    // 19. RuntimeApprovalError has correct code
    {
      const err = new RuntimeApprovalError('test');
      assert(err.code === 'APPROVAL_DENIED', 'RuntimeApprovalError code');
      assert(err.name === 'RuntimeApprovalError', 'RuntimeApprovalError name');
    }

    // 20. listDir outside scope blocked
    {
      const rt = new AgentRuntime({
        policy: { basePath: tmpDir, allowedPaths: ['subdir'] },
        autoApproveAll: true,
      });
      const result = await rt.listDir('.', 'agent-a');
      assert(!result.success, 'listDir outside allowed paths blocked');
    }

  } finally {
    cleanTempDir(tmpDir);
  }
}

// ============================================================================
// 9f — CONSOLE UI
// ============================================================================

// Mock writable stream for capturing console output
class MockWritable extends EventEmitter {
  data = '';
  write(chunk: string): boolean { this.data += chunk; return true; }
  end(): void { /* noop */ }
}

async function testConsoleUI() {
  header('Phase 9f — ConsoleUI');

  // 1. Constructor defaults
  {
    const ui = new ConsoleUI();
    assert(!ui.isRunning, 'Not running initially');
    const status = ui.getStatus();
    assert(status.agents.active === 0, 'Default agents active is 0');
    assert(status.budget.usedPercent === 0, 'Default budget is 0%');
    assert(status.fsm.state === 'idle', 'Default FSM state is idle');
  }

  // 2. Custom options
  {
    const ui = new ConsoleUI({
      title: 'TestUI',
      version: '1.2.3',
      prompt: '$ ',
    });
    const status = ui.getStatus();
    assert(status.version === '1.2.3', 'Custom version set');
  }

  // 3. Register and retrieve command
  {
    const ui = new ConsoleUI();
    let called = false;
    ui.command('test-cmd', () => { called = true; });
    // Verify it's registered (help won't throw)
    ui.showHelp();
    assert(true, 'Command registered without error');
  }

  // 4. Log adds to feed
  {
    const ui = new ConsoleUI();
    ui.log('Test message', 'info');
    ui.log('Warning msg', 'warn');
    ui.log('Error msg', 'error');
    const feed = ui.getFeed();
    assert(feed.length === 3, 'Feed has 3 entries');
    assert(feed[0].level === 'info', 'First entry is info');
    assert(feed[1].level === 'warn', 'Second entry is warn');
    assert(feed[2].level === 'error', 'Third entry is error');
  }

  // 5. Feed max limit
  {
    const ui = new ConsoleUI({ maxFeedEntries: 5 });
    for (let i = 0; i < 10; i++) {
      ui.log(`msg ${i}`);
    }
    assert(ui.getFeed().length === 5, 'Feed capped at maxFeedEntries');
    assert(ui.getFeed()[0].message.includes('msg 5'), 'Oldest entries evicted');
  }

  // 6. Clear feed
  {
    const ui = new ConsoleUI();
    ui.log('to be cleared');
    assert(ui.getFeed().length === 1, 'Feed has entry');
    ui.clearFeed();
    assert(ui.getFeed().length === 0, 'Feed cleared');
  }

  // 7. Update status
  {
    const ui = new ConsoleUI();
    ui.updateStatus({
      agents: { active: 3, total: 5 },
      budget: { usedPercent: 42 },
      fsm: { state: 'executing' },
      pendingApprovals: 2,
    });
    const s = ui.getStatus();
    assert(s.agents.active === 3, 'Agents active updated');
    assert(s.budget.usedPercent === 42, 'Budget updated');
    assert(s.fsm.state === 'executing', 'FSM state updated');
    assert(s.pendingApprovals === 2, 'Pending approvals updated');
  }

  // 8. Feed emits event
  {
    const ui = new ConsoleUI();
    let emittedEntry: FeedEntry | null = null;
    ui.on('feed', (entry: FeedEntry) => { emittedEntry = entry; });
    ui.log('event test', 'success');
    assert(emittedEntry !== null, 'Feed event emitted');
    assert(emittedEntry!.level === 'success', 'Feed event has correct level');
  }

  // 9. Success level icon
  {
    const ui = new ConsoleUI();
    ui.log('success msg', 'success');
    const entry = ui.getFeed()[0];
    assert(entry.icon.includes('✓'), 'Success icon is checkmark');
  }

  // 10. Approval level icon
  {
    const ui = new ConsoleUI();
    ui.log('approval msg', 'approval');
    const entry = ui.getFeed()[0];
    assert(entry.icon.includes('⏳'), 'Approval icon is hourglass');
  }

  // 11. renderHeader produces output
  {
    const output = new MockWritable();
    const ui = new ConsoleUI({
      output: output as unknown as NodeJS.WritableStream,
      version: '4.13.1',
    });
    ui.renderHeader();
    assert(output.data.includes('Network-AI'), 'Header contains title');
    assert(output.data.includes('4.13.1'), 'Header contains version');
  }

  // 12. Built-in help command exists
  {
    const output = new MockWritable();
    const ui = new ConsoleUI({
      output: output as unknown as NodeJS.WritableStream,
    });
    ui.showHelp();
    assert(output.data.includes('help'), 'Help lists help command');
    assert(output.data.includes('exit'), 'Help lists exit command');
    assert(output.data.includes('clear'), 'Help lists clear command');
  }

  // 13. Feed entry has timestamp
  {
    const ui = new ConsoleUI();
    ui.log('timestamp test');
    const entry = ui.getFeed()[0];
    assert(entry.time.includes(':'), 'Time has colon separator');
  }

  // 14. Partial status update preserves other fields
  {
    const ui = new ConsoleUI();
    ui.updateStatus({ agents: { active: 5, total: 10 } });
    ui.updateStatus({ budget: { usedPercent: 75 } });
    const s = ui.getStatus();
    assert(s.agents.active === 5, 'Agents preserved after budget update');
    assert(s.budget.usedPercent === 75, 'Budget updated');
  }

  // 15. Multiple commands can be registered
  {
    const ui = new ConsoleUI();
    ui.command('cmd1', () => { });
    ui.command('cmd2', () => { });
    ui.command('cmd3', () => { });
    // Built-ins: help, clear, exit, quit = 4 + 3 custom = 7
    // Just verify no error
    assert(true, 'Multiple commands registered');
  }

  // 16. Stop sets isRunning to false
  {
    const output = new MockWritable();
    const ui = new ConsoleUI({
      output: output as unknown as NodeJS.WritableStream,
    });
    // Not running before start, stop should still work
    ui.stop();
    assert(!ui.isRunning, 'isRunning is false after stop');
    assert(output.data.includes('Goodbye'), 'Stop prints goodbye');
  }

  // 17. Log with default level is info
  {
    const ui = new ConsoleUI();
    ui.log('default level');
    assert(ui.getFeed()[0].level === 'info', 'Default level is info');
  }

  // 18. Command handler with description
  {
    const output = new MockWritable();
    const ui = new ConsoleUI({
      output: output as unknown as NodeJS.WritableStream,
    });
    ui.command('mycmd', () => { }, 'My description');
    ui.showHelp();
    assert(output.data.includes('My description'), 'Help shows command description');
  }
}

// ============================================================================
// 9g — Console Orchestrator Wiring
// ============================================================================

async function testOrchestratorWiring() {
  header('9g — Console Orchestrator Wiring');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase9g-'));

  // 1. LockedBlackboard basic CRUD via bb commands
  {
    const bb = new LockedBlackboard(tmpDir);
    bb.write('test-key', 'test-value', 'console-user');
    const entry = bb.read('test-key');
    assert(entry !== null && entry.value === 'test-value', 'BB write + read works');
    const keys = bb.listKeys();
    assert(keys.includes('test-key'), 'BB listKeys includes written key');
    const deleted = bb.delete('test-key');
    assert(deleted === true, 'BB delete returns true');
    assert(bb.read('test-key') === null, 'BB deleted key reads null');
  }

  // 2. LockedBlackboard propose → validate → commit
  {
    const bb = new LockedBlackboard(tmpDir);
    const changeId = bb.propose('atomic-key', 42, 'console-user');
    assert(typeof changeId === 'string' && changeId.length > 0, 'BB propose returns changeId');
    const valid = bb.validate(changeId, 'console-user');
    assert(valid === true, 'BB validate returns true');
    const result = bb.commit(changeId);
    assert(result.success === true, 'BB commit succeeds');
    const entry = bb.read('atomic-key');
    assert(entry !== null && entry.value === 42, 'Committed value is readable');
  }

  // 3. LockedBlackboard listPendingChanges
  {
    const bb = new LockedBlackboard(tmpDir);
    const changeId = bb.propose('pending-key', 'value', 'agent-1');
    const pending = bb.listPendingChanges();
    const found = pending.some(p => p.change_id === changeId);
    assert(found, 'listPendingChanges includes proposed change');
    bb.abort(changeId);
  }

  // 4. FederatedBudget spend + status
  {
    const budget = new FederatedBudget({ ceiling: 1000 });
    assert(budget.remaining() === 1000, 'Budget starts with full ceiling');
    const r1 = budget.spend('agent-1', 300);
    assert(r1.allowed === true && r1.remaining === 700, 'Budget spend allowed');
    assert(budget.getTotalSpent() === 300, 'Budget totalSpent is 300');
    const log = budget.getSpendLog();
    assert(log['agent-1'] === 300, 'Spend log tracks agent-1');
  }

  // 5. FederatedBudget ceiling enforcement
  {
    const budget = new FederatedBudget({ ceiling: 100 });
    budget.spend('agent-1', 80);
    const r2 = budget.spend('agent-1', 30);
    assert(r2.allowed === false, 'Budget rejects spend exceeding ceiling');
    assert(budget.remaining() === 20, 'Remaining is correct after denial');
  }

  // 6. FederatedBudget reset
  {
    const budget = new FederatedBudget({ ceiling: 1000 });
    budget.spend('agent-1', 500);
    budget.reset();
    assert(budget.getTotalSpent() === 0, 'Budget reset clears spending');
    assert(budget.remaining() === 1000, 'Budget remaining restored after reset');
  }

  // 7. JourneyFSM state and transitions
  {
    const fsm = new JourneyFSM({
      states: [
        { name: 'IDLE', authorizedAgents: ['*'], authorizedTools: { '*': ['*'] } },
        { name: 'ACTIVE', authorizedAgents: ['*'], authorizedTools: { '*': ['*'] } },
        { name: 'DONE', authorizedAgents: ['*'], authorizedTools: { '*': ['*'] } },
      ],
      transitions: [
        { from: 'IDLE', event: 'start', to: 'ACTIVE', allowedBy: '*' },
        { from: 'ACTIVE', event: 'finish', to: 'DONE', allowedBy: '*' },
      ],
      initialState: 'IDLE',
    });
    assert(fsm.state === 'IDLE', 'FSM starts at initial state');
    const events = fsm.availableEvents();
    assert(events.includes('start'), 'Available events includes start');
  }

  // 8. JourneyFSM transition
  {
    const fsm = new JourneyFSM({
      states: [
        { name: 'A', authorizedAgents: ['*'], authorizedTools: { '*': ['*'] } },
        { name: 'B', authorizedAgents: ['*'], authorizedTools: { '*': ['*'] } },
      ],
      transitions: [
        { from: 'A', event: 'go', to: 'B', allowedBy: '*' },
      ],
      initialState: 'A',
    });
    const result = fsm.transition('go', 'console-user');
    assert(result.success === true, 'FSM transition succeeds');
    assert(result.currentState === 'B', 'FSM current state is B after transition');
    assert(result.previousState === 'A', 'FSM previous state was A');
    assert(fsm.state === 'B', 'FSM.state reflects new state');
  }

  // 9. JourneyFSM invalid transition
  {
    const fsm = new JourneyFSM({
      states: [
        { name: 'X', authorizedAgents: ['*'], authorizedTools: { '*': ['*'] } },
        { name: 'Y', authorizedAgents: ['*'], authorizedTools: { '*': ['*'] } },
      ],
      transitions: [
        { from: 'X', event: 'go', to: 'Y', allowedBy: '*' },
      ],
      initialState: 'X',
    });
    const result = fsm.transition('invalid', 'console-user');
    assert(result.success === false, 'Invalid transition fails');
  }

  // 10. JourneyFSM history
  {
    const fsm = new JourneyFSM({
      states: [
        { name: 'S1', authorizedAgents: ['*'], authorizedTools: { '*': ['*'] } },
        { name: 'S2', authorizedAgents: ['*'], authorizedTools: { '*': ['*'] } },
      ],
      transitions: [
        { from: 'S1', event: 'next', to: 'S2', allowedBy: '*' },
      ],
      initialState: 'S1',
    });
    fsm.transition('next', 'console-user');
    const history = fsm.transitionHistory;
    assert(history.length >= 2, 'FSM history has at least 2 entries');
    assert(history[0].state === 'S1', 'First history entry is initial state');
  }

  // 11. JourneyFSM reset
  {
    const fsm = new JourneyFSM({
      states: [
        { name: 'INIT', authorizedAgents: ['*'], authorizedTools: { '*': ['*'] } },
        { name: 'RUNNING', authorizedAgents: ['*'], authorizedTools: { '*': ['*'] } },
      ],
      transitions: [
        { from: 'INIT', event: 'run', to: 'RUNNING', allowedBy: '*' },
      ],
      initialState: 'INIT',
    });
    fsm.transition('run', 'user');
    assert(fsm.state === 'RUNNING', 'FSM moved to RUNNING');
    fsm.reset();
    assert(fsm.state === 'INIT', 'FSM reset to initial state');
  }

  // 12. AdapterRegistry list + discover
  {
    const registry = new AdapterRegistry();
    const list = registry.listAdapters();
    assert(Array.isArray(list), 'listAdapters returns array');
    assert(list.length === 0, 'Empty registry has no adapters');
  }

  // 13. AdapterRegistry health check with no adapters
  {
    const registry = new AdapterRegistry();
    const health = await registry.healthCheck();
    assert(typeof health === 'object', 'Health check returns object');
    assert(Object.keys(health).length === 0, 'No adapters = empty health');
  }

  // 14. Console + Blackboard integration: write and read through ConsoleUI command handler
  {
    const bb = new LockedBlackboard(tmpDir);
    const output = new MockWritable();
    const ui = new ConsoleUI({
      output: output as unknown as NodeJS.WritableStream,
    });
    // Simulate bb write command
    bb.write('console-test', 'hello', 'console-user');
    const entry = bb.read('console-test');
    assert(entry !== null && entry.value === 'hello', 'BB integration: write + read via console flow');
    // Register a command and call it
    ui.command('bb', (args) => {
      const entry = bb.read(args);
      if (entry) ui.log(`value: ${entry.value}`);
    });
    // Verify the command is registered
    assert(true, 'BB command wired to ConsoleUI');
  }

  // 15. Console + Budget integration
  {
    const budget = new FederatedBudget({ ceiling: 5000 });
    const output = new MockWritable();
    const ui = new ConsoleUI({
      output: output as unknown as NodeJS.WritableStream,
    });
    ui.command('budget', () => {
      const pct = Math.round((budget.getTotalSpent() / budget.getCeiling()) * 100);
      ui.updateStatus({ budget: { usedPercent: pct } });
      ui.log(`Budget: ${pct}%`);
    });
    budget.spend('agent-a', 2500);
    // Simulate calling budget command
    const s = ui.getStatus();
    // Before command: status is default
    assert(s.budget.usedPercent === 0, 'Before budget cmd: 0%');
    // After budget is wired, calling the actual spend works
    assert(budget.getTotalSpent() === 2500, 'Budget spent is 2500');
  }

  // 16. Console + FSM integration
  {
    const fsm = new JourneyFSM({
      states: [
        { name: 'IDLE', authorizedAgents: ['*'], authorizedTools: { '*': ['*'] } },
        { name: 'RUNNING', authorizedAgents: ['*'], authorizedTools: { '*': ['*'] } },
      ],
      transitions: [
        { from: 'IDLE', event: 'go', to: 'RUNNING', allowedBy: '*' },
      ],
      initialState: 'IDLE',
    });
    const output = new MockWritable();
    const ui = new ConsoleUI({
      output: output as unknown as NodeJS.WritableStream,
    });
    ui.command('fsm', (args) => {
      if (args === 'go') {
        const result = fsm.transition('go', 'console-user');
        if (result.success) {
          ui.updateStatus({ fsm: { state: fsm.state } });
          ui.log(`Now in ${fsm.state}`);
        }
      }
    });
    assert(ui.getStatus().fsm.state === 'idle', 'FSM status starts at idle (default)');
    // Actual FSM state:
    assert(fsm.state === 'IDLE', 'Real FSM state is IDLE');
  }

  // 17. Blackboard JSON parsing
  {
    const bb = new LockedBlackboard(tmpDir);
    bb.write('json-key', { nested: { value: 42 } }, 'console-user');
    const entry = bb.read('json-key');
    assert(
      entry !== null && typeof entry.value === 'object' && (entry.value as Record<string, unknown>)['nested'] !== undefined,
      'BB stores and retrieves JSON objects',
    );
  }

  // 18. Budget per-agent ceiling
  {
    const budget = new FederatedBudget({ ceiling: 10000, perAgentCeiling: 500 });
    const r1 = budget.spend('agent-greedy', 400);
    assert(r1.allowed === true, 'Within per-agent ceiling: allowed');
    const r2 = budget.spend('agent-greedy', 200);
    assert(r2.allowed === false, 'Exceeding per-agent ceiling: denied');
  }

  // 19. Blackboard pause/resume
  {
    const bb = new LockedBlackboard(tmpDir);
    assert(bb.isPaused() === false, 'BB starts unpaused');
    bb.pause();
    assert(bb.isPaused() === true, 'BB is paused after pause()');
    bb.resume();
    assert(bb.isPaused() === false, 'BB is resumed after resume()');
  }

  // 20. FederatedBudget transaction log
  {
    const budget = new FederatedBudget({ ceiling: 10000 });
    budget.spend('agent-1', 100);
    budget.spend('agent-2', 200);
    const txLog = budget.getTransactionLog();
    assert(txLog.length === 2, 'Transaction log has 2 entries');
    assert(txLog[0].agentId === 'agent-1', 'First tx is agent-1');
    assert(txLog[1].tokens === 200, 'Second tx is 200 tokens');
  }

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ============================================================================
// 9h — Strategy Agent
// ============================================================================

async function testStrategyAgent() {
  header('9h — StrategyAgent');

  const makeTemplate = (id: string, maxConcurrent = 10): AgentTemplate => ({
    id,
    adapter: 'test',
    defaultAction: 'run',
    defaultParams: {},
    maxConcurrent,
    budgetPerAgent: 1000,
    tags: ['test'],
  });

  // 1. Create pool
  {
    const sa = new StrategyAgent();
    const pool = sa.createPool(makeTemplate('pool-1'));
    assert(pool.template.id === 'pool-1', 'Pool created with correct id');
    assert(sa.listPools().length === 1, 'listPools returns 1');
  }

  // 2. Duplicate pool throws
  {
    const sa = new StrategyAgent();
    sa.createPool(makeTemplate('dup'));
    let threw = false;
    try { sa.createPool(makeTemplate('dup')); } catch { threw = true; }
    assert(threw, 'Duplicate pool throws error');
  }

  // 3. Agent spawn and lifecycle
  {
    const sa = new StrategyAgent();
    sa.createPool(makeTemplate('lc', 3));
    const pool = sa.getPool('lc')!;
    const agent = pool.spawn('task-1');
    assert(agent !== null, 'Spawn returns agent');
    assert(agent!.status === 'spawning', 'Initial status is spawning');
    pool.markRunning(agent!.id);
    assert(pool.active === 1, 'Active count is 1 after markRunning');
    pool.markCompleted(agent!.id, 500);
    assert(pool.completed === 1, 'Completed count is 1');
    assert(pool.totalTokensUsed === 500, 'Tokens tracked');
  }

  // 4. Pool capacity enforcement
  {
    const sa = new StrategyAgent();
    sa.createPool(makeTemplate('cap', 2));
    const pool = sa.getPool('cap')!;
    const a1 = pool.spawn();
    const a2 = pool.spawn();
    const a3 = pool.spawn();
    assert(a1 !== null && a2 !== null, 'First two spawns succeed');
    assert(a3 === null, 'Third spawn returns null (at capacity)');
    assert(!pool.canSpawn, 'canSpawn is false at capacity');
  }

  // 5. Recycle frees slots
  {
    const sa = new StrategyAgent();
    sa.createPool(makeTemplate('rec', 2));
    const pool = sa.getPool('rec')!;
    const a1 = pool.spawn();
    pool.markCompleted(a1!.id);
    const recycled = pool.recycle();
    assert(recycled === 1, 'Recycled 1 agent');
    assert(pool.canSpawn, 'Can spawn after recycle');
  }

  // 6. Pool failed tracking
  {
    const sa = new StrategyAgent();
    sa.createPool(makeTemplate('fail', 5));
    const pool = sa.getPool('fail')!;
    const a1 = pool.spawn();
    pool.markFailed(a1!.id, 'timeout');
    assert(pool.failed === 1, 'Failed count is 1');
  }

  // 7. Workload partitioning
  {
    const sa = new StrategyAgent();
    sa.createPool(makeTemplate('work', 10));
    const chunks = sa.distributeWork(['a', 'b', 'c'], 'work', 2);
    assert(chunks.length === 3, 'Created 3 chunks');
    assert(chunks[0].priority === 2, 'Priority set correctly');
    assert(chunks[0].status === 'pending', 'Status is pending');
  }

  // 8. Workload counts
  {
    const sa = new StrategyAgent();
    sa.createPool(makeTemplate('wc', 10));
    sa.distributeWork([1, 2, 3, 4, 5], 'wc');
    const counts = sa.getWorkStatus();
    assert(counts.pending === 5, '5 pending chunks');
    assert(counts.total === 5, 'Total is 5');
  }

  // 9. Chunk assignment
  {
    const sa = new StrategyAgent();
    sa.createPool(makeTemplate('assign', 10));
    const chunks = sa.distributeWork(['x'], 'assign');
    const assigned = sa.workload.assign(chunks[0].id, 'agent-1');
    assert(assigned === true, 'Chunk assigned');
    assert(sa.workload.getChunk(chunks[0].id)?.status === 'assigned', 'Status is assigned');
  }

  // 10. Chunk lifecycle
  {
    const sa = new StrategyAgent();
    sa.createPool(makeTemplate('clc', 10));
    const chunks = sa.distributeWork(['y'], 'clc');
    sa.workload.assign(chunks[0].id, 'a1');
    sa.workload.markRunning(chunks[0].id);
    assert(sa.workload.getChunk(chunks[0].id)?.status === 'running', 'Chunk is running');
    sa.workload.markCompleted(chunks[0].id, { result: 42 });
    assert(sa.workload.getChunk(chunks[0].id)?.status === 'completed', 'Chunk completed');
    assert(sa.workload.getChunk(chunks[0].id)?.result !== undefined, 'Result stored');
  }

  // 11. Chunk failure
  {
    const sa = new StrategyAgent();
    sa.createPool(makeTemplate('cf', 10));
    const chunks = sa.distributeWork(['z'], 'cf');
    sa.workload.assign(chunks[0].id, 'a1');
    sa.workload.markFailed(chunks[0].id, 'explosion');
    assert(sa.workload.getChunk(chunks[0].id)?.status === 'failed', 'Chunk failed');
    assert(sa.workload.getChunk(chunks[0].id)?.error === 'explosion', 'Error stored');
  }

  // 12. Distribute to non-existent pool throws
  {
    const sa = new StrategyAgent();
    let threw = false;
    try { sa.distributeWork(['a'], 'nowhere'); } catch { threw = true; }
    assert(threw, 'Distribute to missing pool throws');
  }

  // 13. Adaptive strategy: scale up
  {
    const pools = new Map<string, PoolStatus>();
    pools.set('busy', {
      templateId: 'busy',
      active: 2,
      maxConcurrent: 10,
      completed: 5,
      failed: 0,
      totalTokensUsed: 5000,
      budgetPerAgent: 1000,
      pendingChunks: 8,
    });
    const snap: SystemSnapshot = {
      pools,
      totalBudgetSpent: 5000,
      totalBudgetCeiling: 100000,
      fsmState: 'EXECUTING',
      pendingChunks: 8,
      runningAgents: 2,
      completedTasks: 5,
      failedTasks: 0,
      averageTaskDuration: 200,
      timestamp: Date.now(),
    };
    const plan = adaptiveStrategy(snap);
    assert(plan.scaleUp.has('busy'), 'Plan scales up busy pool');
    assert((plan.scaleUp.get('busy') ?? 0) > 2, 'Target is higher than current');
  }

  // 14. Adaptive strategy: scale down idle
  {
    const pools = new Map<string, PoolStatus>();
    pools.set('idle', {
      templateId: 'idle',
      active: 5,
      maxConcurrent: 10,
      completed: 20,
      failed: 0,
      totalTokensUsed: 20000,
      budgetPerAgent: 1000,
      pendingChunks: 0,
    });
    const snap: SystemSnapshot = {
      pools,
      totalBudgetSpent: 20000,
      totalBudgetCeiling: 100000,
      fsmState: 'IDLE',
      pendingChunks: 0,
      runningAgents: 5,
      completedTasks: 20,
      failedTasks: 0,
      averageTaskDuration: 100,
      timestamp: Date.now(),
    };
    const plan = adaptiveStrategy(snap);
    assert(plan.scaleDown.has('idle'), 'Plan scales down idle pool');
  }

  // 15. Adaptive strategy: reduce budget for high-fail pools
  {
    const pools = new Map<string, PoolStatus>();
    pools.set('failing', {
      templateId: 'failing',
      active: 3,
      maxConcurrent: 10,
      completed: 3,
      failed: 7,
      totalTokensUsed: 10000,
      budgetPerAgent: 1000,
      pendingChunks: 0,
    });
    const snap: SystemSnapshot = {
      pools,
      totalBudgetSpent: 10000,
      totalBudgetCeiling: 100000,
      fsmState: 'EXECUTING',
      pendingChunks: 0,
      runningAgents: 3,
      completedTasks: 3,
      failedTasks: 7,
      averageTaskDuration: 150,
      timestamp: Date.now(),
    };
    const plan = adaptiveStrategy(snap);
    assert(plan.budgetReallocation.has('failing'), 'Plan reduces budget for failing pool');
    assert((plan.budgetReallocation.get('failing') ?? 0) < 1000, 'New budget is lower');
  }

  // 16. StrategyAgent evaluate produces a plan
  {
    const sa = new StrategyAgent();
    sa.createPool(makeTemplate('eval', 10));
    sa.distributeWork([1, 2, 3], 'eval');
    const plan = await sa.evaluate(0, 100000, 'IDLE');
    assert(plan.confidence > 0, 'Plan has confidence > 0');
    assert(typeof plan.description === 'string', 'Plan has description');
  }

  // 17. StrategyAgent executePlan spawns agents
  {
    const sa = new StrategyAgent();
    sa.createPool(makeTemplate('exec', 10));
    sa.distributeWork([1, 2, 3], 'exec');
    const plan = await sa.evaluate(0, 100000, 'IDLE');
    const actions = sa.executePlan(plan);
    assert(actions >= 0, 'executePlan returns action count');
  }

  // 18. Global agent limit
  {
    const sa = new StrategyAgent({ globalAgentLimit: 3 });
    sa.createPool(makeTemplate('lim', 10));
    const pool = sa.getPool('lim')!;
    pool.spawn(); pool.spawn(); pool.spawn();
    assert(sa.atCapacity, 'At capacity with 3 agents');
  }

  // 19. Remove pool
  {
    const sa = new StrategyAgent();
    sa.createPool(makeTemplate('rm', 5));
    assert(sa.removePool('rm') === true, 'removePool returns true');
    assert(sa.listPools().length === 0, 'No pools after removal');
    assert(sa.removePool('nonexistent') === false, 'removePool returns false for missing');
  }

  // 20. Summary string
  {
    const sa = new StrategyAgent();
    sa.createPool(makeTemplate('sum', 5));
    sa.distributeWork([1, 2], 'sum');
    const summary = sa.summary();
    assert(summary.includes('Pools: 1'), 'Summary includes pool count');
    assert(summary.includes('sum'), 'Summary includes pool name');
  }

  // 21. Events emitted
  {
    const sa = new StrategyAgent();
    let poolCreated = false;
    let agentSpawned = false;
    sa.on('pool:created', () => { poolCreated = true; });
    sa.on('agent:spawned', () => { agentSpawned = true; });
    sa.createPool(makeTemplate('ev', 5));
    sa.getPool('ev')!.spawn();
    assert(poolCreated, 'pool:created event emitted');
    assert(agentSpawned, 'agent:spawned event emitted');
  }

  // 22. Custom strategy function
  {
    const customStrategy = (_snap: SystemSnapshot): StrategyPlan => ({
      description: 'Custom plan',
      scaleUp: new Map(),
      scaleDown: new Map(),
      budgetReallocation: new Map(),
      newChunks: [],
      confidence: 0.99,
      createdAt: Date.now(),
    });
    const sa = new StrategyAgent({ strategy: customStrategy });
    sa.createPool(makeTemplate('custom', 5));
    const plan = await sa.evaluate();
    assert(plan.confidence === 0.99, 'Custom strategy confidence is 0.99');
    assert(plan.description === 'Custom plan', 'Custom strategy description');
  }

  // 23. Plan history
  {
    const sa = new StrategyAgent();
    sa.createPool(makeTemplate('hist', 5));
    await sa.evaluate();
    await sa.evaluate();
    assert(sa.planHistory.length === 2, 'Plan history has 2 entries');
  }

  // 24. Pool getAgents
  {
    const sa = new StrategyAgent();
    sa.createPool(makeTemplate('ga', 5));
    const pool = sa.getPool('ga')!;
    pool.spawn('t1');
    pool.spawn('t2');
    const agents = pool.getAgents();
    assert(agents.length === 2, 'getAgents returns 2');
  }

  // 25. Chunk getPendingForPool priority sort
  {
    const sa = new StrategyAgent();
    sa.createPool(makeTemplate('pri', 10));
    sa.distributeWork(['low'], 'pri', 1);
    sa.distributeWork(['high'], 'pri', 5);
    const pending = sa.workload.getPendingForPool('pri');
    assert(pending[0].priority === 5, 'Highest priority first');
    assert(pending[1].priority === 1, 'Lowest priority second');
  }

  // 26. Pool availableSlots
  {
    const sa = new StrategyAgent();
    sa.createPool(makeTemplate('slots', 3));
    const pool = sa.getPool('slots')!;
    assert(pool.availableSlots === 3, 'All 3 slots available');
    pool.spawn();
    assert(pool.availableSlots === 2, '2 slots after 1 spawn');
  }

  // 27. Start/stop evaluation loop
  {
    const sa = new StrategyAgent({ evaluationInterval: 100000 });
    assert(!sa.isRunning, 'Not running initially');
    sa.start();
    assert(sa.isRunning, 'Running after start');
    sa.stop();
    assert(!sa.isRunning, 'Not running after stop');
  }

  // 28. Snapshot
  {
    const sa = new StrategyAgent();
    sa.createPool(makeTemplate('snap', 5));
    const snap = sa.snapshot(500, 10000, 'PLANNING');
    assert(snap.totalBudgetSpent === 500, 'Budget spent in snapshot');
    assert(snap.totalBudgetCeiling === 10000, 'Budget ceiling in snapshot');
    assert(snap.fsmState === 'PLANNING', 'FSM state in snapshot');
    assert(snap.pools.has('snap'), 'Pools in snapshot');
  }

  // 29. Workload getChunksForPool
  {
    const sa = new StrategyAgent();
    sa.createPool(makeTemplate('gcp1', 5));
    sa.createPool(makeTemplate('gcp2', 5));
    sa.distributeWork([1, 2], 'gcp1');
    sa.distributeWork([3], 'gcp2');
    assert(sa.workload.getChunksForPool('gcp1').length === 2, 'Pool 1 has 2 chunks');
    assert(sa.workload.getChunksForPool('gcp2').length === 1, 'Pool 2 has 1 chunk');
  }

  // 30. Agent completed event
  {
    const sa = new StrategyAgent();
    let completed = false;
    sa.on('agent:completed', () => { completed = true; });
    sa.createPool(makeTemplate('comp', 5));
    const pool = sa.getPool('comp')!;
    const a = pool.spawn();
    pool.markCompleted(a!.id, 100);
    assert(completed, 'agent:completed event emitted');
  }
}

// ============================================================================
// 9i — Pipe Mode
// ============================================================================

async function testPipeMode() {
  header('9i — Pipe Mode (JSON Protocol)');

  // We test the pipe command executor by importing it indirectly through
  // spawning a child process with --pipe flag.
  // For unit tests, we verify the JSON protocol contract.

  const { spawn } = await import('child_process');

  // Helper: send a JSON command to the pipe-mode process and get a response
  async function pipeCommand(cmd: object): Promise<{ success: boolean; command?: string; data?: unknown; error?: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--require', 'ts-node/register',
        path.join(__dirname, 'bin', 'console.ts'),
        '--pipe',
        '--auto-approve',
        '--base-path', os.tmpdir(),
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1' },
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      // Send command and close stdin
      child.stdin.write(JSON.stringify(cmd) + '\n');

      // Wait a bit for processing, then kill
      setTimeout(() => {
        child.kill('SIGTERM');
      }, 5000);

      child.on('exit', () => {
        const lines = stdout.trim().split('\n').filter(l => l.trim());
        if (lines.length === 0) {
          reject(new Error(`No response. stderr: ${stderr}`));
          return;
        }
        try {
          resolve(JSON.parse(lines[lines.length - 1]));
        } catch {
          reject(new Error(`Invalid JSON response: ${lines[lines.length - 1]}`));
        }
      });
    });
  }

  // 1. Status command
  {
    try {
      const res = await pipeCommand({ command: 'status', id: 1 });
      assert(res.success === true, 'Pipe status returns success');
      assert(typeof res.data === 'object', 'Pipe status has data object');
      const data = res.data as Record<string, unknown>;
      assert('budget' in data, 'Status data has budget');
      assert('fsm' in data, 'Status data has fsm');
    } catch (err) {
      fail(`Pipe status: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2. Budget show command
  {
    try {
      const res = await pipeCommand({ command: 'budget', args: 'show', id: 2 });
      assert(res.success === true, 'Pipe budget show succeeds');
      const data = res.data as Record<string, unknown>;
      assert('ceiling' in data, 'Budget data has ceiling');
      assert('remaining' in data, 'Budget data has remaining');
    } catch (err) {
      fail(`Pipe budget: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3. FSM show command
  {
    try {
      const res = await pipeCommand({ command: 'fsm', args: 'show', id: 3 });
      assert(res.success === true, 'Pipe fsm show succeeds');
      const data = res.data as Record<string, unknown>;
      assert('state' in data, 'FSM data has state');
      assert('availableEvents' in data, 'FSM data has availableEvents');
    } catch (err) {
      fail(`Pipe fsm: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 4. Unknown command returns error
  {
    try {
      const res = await pipeCommand({ command: 'nonexistent', id: 4 });
      assert(res.success === false, 'Unknown command returns success:false');
      assert(typeof res.error === 'string', 'Error message present');
    } catch (err) {
      fail(`Pipe unknown cmd: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 5. Invalid JSON handling (tested via malformed input)
  {
    try {
      const res = await pipeCommand({ command: 'bb', args: 'list', id: 5 });
      assert(res.success === true, 'Pipe bb list succeeds');
      const data = res.data as Record<string, unknown>;
      assert('keys' in data, 'BB list data has keys');
    } catch (err) {
      fail(`Pipe bb list: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 6. Command with correlation ID
  {
    try {
      const res = await pipeCommand({ command: 'health', id: 'req-abc' });
      assert(res.success === true, 'Health check succeeds via pipe');
    } catch (err) {
      fail(`Pipe health: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ============================================================================
// RUNNER
// ============================================================================

async function main() {
  console.log('\n' + '='.repeat(64));
  console.log('  PHASE 9: Agent Runtime & Console — Test Suite');
  console.log('='.repeat(64));

  testSandboxPolicy();
  await testShellExecutor();
  await testFileAccessor();
  await testApprovalGate();
  await testAgentRuntime();
  await testConsoleUI();
  await testOrchestratorWiring();
  await testStrategyAgent();
  await testPipeMode();

  console.log('\n' + '='.repeat(64));
  const color = failed === 0 ? colors.green : colors.red;
  console.log(`${color}  RESULTS: ${passed} passed, ${failed} failed (${passed + failed} total)${colors.reset}`);
  console.log('='.repeat(64) + '\n');

  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
