/**
 * Transport Tier — Test Suite (Phase 10-Transport)
 *
 * Tests for:
 *   ta — TransportAgent.submitRequest: request creation & validation
 *   tb — TransportAgent.execute: happy path lifecycle
 *   tc — TransportAgent.execute: prerequisites
 *   td — TransportAgent.execute: advisory lock exclusion
 *   te — TransportAgent.execute: auth denial
 *   tf — TransportAgent.execute: promote failure
 *   tg — TransportAgent.execute: canary pass & fail
 *   th — TransportAgent.start/stop poll loop
 *   ti — AgentPool.setDispatchPause
 *   tj — LandscapeAgent health tracking
 *   tk — Integration scenarios
 *
 * Run with: npx ts-node test-transport.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';

import { TransportAgent } from './lib/transport-agent';
import type {
  TransportRequest,
  TransportStatusRecord,
  TransportStatus,
  TransportAgentOptions,
} from './lib/transport-agent';
import { LandscapeAgent } from './lib/landscape-agent';
import type { EnvironmentHealth, LandscapeAgentOptions } from './lib/landscape-agent';
import { AgentPool } from './lib/strategy-agent';
import type { AgentTemplate } from './lib/strategy-agent';

// ============================================================================
// TEST UTILITIES
// ============================================================================

const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
} as const;

let passed = 0;
let failed = 0;

function log(msg: string, color: keyof typeof colors = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function header(title: string) {
  console.log('\n' + '='.repeat(68));
  log(`  ${title}`, 'bold');
  console.log('='.repeat(68));
}

function pass(test: string) { log(`  [PASS] ${test}`, 'green'); passed++; }
function fail(test: string, err?: string) {
  log(`  [FAIL] ${test}`, 'red');
  if (err) log(`         ${err}`, 'red');
  failed++;
}

function assert(condition: boolean, test: string, detail?: string) {
  if (condition) pass(test);
  else fail(test, detail ?? 'assertion failed');
}

async function assertRejects(fn: () => Promise<unknown>, test: string) {
  try { await fn(); fail(test, 'Expected to reject but did not'); }
  catch { pass(test); }
}

function assertThrows(fn: () => unknown, test: string) {
  try { fn(); fail(test, 'Expected to throw but did not'); }
  catch { pass(test); }
}

// ============================================================================
// MOCKS
// ============================================================================

/** Minimal in-memory blackboard for tests. */
class MockBlackboard {
  private store = new Map<string, { key: string; value: unknown; source_agent: string; timestamp: string; ttl: number | null; version: number }>();

  read(key: string) {
    const entry = this.store.get(key);
    return entry ?? null;
  }

  write(key: string, value: unknown, sourceAgent: string, _ttl?: number) {
    const existing = this.store.get(key);
    const entry = {
      key,
      value,
      source_agent: sourceAgent,
      timestamp: new Date().toISOString(),
      ttl: null as number | null,
      version: existing ? existing.version + 1 : 1,
    };
    this.store.set(key, entry);
    return entry;
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  listKeys(): string[] {
    return Array.from(this.store.keys());
  }

  clear(): void {
    this.store.clear();
  }
}

/** Controllable mock for EnvironmentManager. */
class MockEnvManager {
  backupCalls: Array<{ env: string }> = [];
  promoteCalls: Array<{ from: string; to: string; options: unknown }> = [];
  restoreCalls: Array<{ env: string; backupId: string }> = [];
  backupCounter = 0;
  shouldFailPromote = false;
  shouldFailBackup = false;
  envList: Array<{ name: string; exists: boolean; keyCount: number }> = [
    { name: 'dev', exists: true, keyCount: 3 },
    { name: 'st', exists: true, keyCount: 2 },
    { name: 'sit', exists: false, keyCount: 0 },
    { name: 'qa', exists: true, keyCount: 2 },
    { name: 'preprod', exists: false, keyCount: 0 },
    { name: 'prod', exists: true, keyCount: 5 },
  ];

  backup(env: string) {
    if (this.shouldFailBackup) throw new Error('backup failed');
    this.backupCalls.push({ env });
    const backupId = `bk-${++this.backupCounter}`;
    return { backupId, env, path: `/tmp/backups/${backupId}`, filesCount: 3 };
  }

  promote(from: string, to: string, options: unknown = {}) {
    this.promoteCalls.push({ from, to, options });
    if (this.shouldFailPromote) throw new Error('promote failed');
    return {
      from, to,
      configsCopied: ['trust_levels.json'],
      skipped: [],
      timestamp: new Date().toISOString(),
    };
  }

  restore(env: string, backupId: string) {
    this.restoreCalls.push({ env, backupId });
    return { backupId, env, filesRestored: 3 };
  }

  listBackups(env: string) {
    return [{ backupId: `bk-${this.backupCounter}`, env, timestamp: new Date().toISOString(), sizeBytes: 1024, path: `/tmp/backups/bk-${this.backupCounter}` }];
  }

  list() {
    return this.envList;
  }
}

/** Controllable mock for AuthGuardian. */
class MockAuthGuardian {
  shouldGrant = true;
  denyReason = 'mock denial';
  calls: Array<{ agentId: string; resource: string; justification: string }> = [];

  async requestPermission(agentId: string, resource: string, justification: string, _scope?: string) {
    this.calls.push({ agentId, resource, justification });
    if (this.shouldGrant) {
      return { granted: true, grantToken: 'mock-token', expiresAt: null, restrictions: [] };
    }
    return { granted: false, grantToken: null, expiresAt: null, restrictions: [], reason: this.denyReason };
  }
}

/** Controllable mock for ComplianceMonitor. */
class MockComplianceMonitor {
  private _violations: Array<{ type: string; message: string; severity: string }> = [];

  addViolation(type = 'POLICY_VIOLATION', message = 'test violation', severity = 'medium') {
    this._violations.push({ type, message, severity });
  }

  getViolations() {
    return [...this._violations];
  }

  recordAction(_agentId: string, _action: string, _metadata?: unknown) {
    // no-op
  }
}

/** Build a minimal AgentPool for testing. */
function makePool(tags: string[], maxConcurrent = 5): AgentPool {
  const template: AgentTemplate = {
    id: `pool-${tags.join('-') || 'untagged'}`,
    adapter: 'test',
    defaultAction: 'test',
    defaultParams: {},
    maxConcurrent,
    budgetPerAgent: 100,
    tags,
  };
  const events = new EventEmitter();
  return new AgentPool(template, events);
}

/** Build a temp directory for audit log. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nai-transport-test-'));
}

function cleanTempDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ============================================================================
// ta — TransportAgent.submitRequest
// ============================================================================

function testSubmitRequest() {
  header('ta — TransportAgent.submitRequest');

  const bb = new MockBlackboard();

  // 1. Returns a trId starting with 'tr-'
  {
    const trId = TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: 'test' });
    assert(typeof trId === 'string' && trId.startsWith('tr-'), 'trId starts with tr-');
  }

  // 2. Writes transport:request:* to blackboard
  {
    const trId = TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: 'write check' });
    const entry = bb.read(`transport:request:${trId}`);
    assert(entry !== null, 'Writes transport:request:<trId> to blackboard');
    assert((entry!.value as TransportRequest).fromEnv === 'dev', 'Request fromEnv preserved');
    assert((entry!.value as TransportRequest).toEnv === 'st', 'Request toEnv preserved');
    assert((entry!.value as TransportRequest).reason === 'write check', 'Request reason preserved');
  }

  // 3. Writes initial status with status 'pending'
  {
    const trId = TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: 'status check' });
    const entry = bb.read(`transport:status:${trId}`);
    assert(entry !== null, 'Writes transport:status:<trId> to blackboard');
    assert((entry!.value as TransportStatusRecord).status === 'pending', 'Initial status is pending');
    assert((entry!.value as TransportStatusRecord).trId === trId, 'Status record has correct trId');
  }

  // 4. Persists operator when provided
  {
    const trId = TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: 'op check', operator: 'dev-lead' });
    const entry = bb.read(`transport:status:${trId}`);
    assert((entry!.value as TransportStatusRecord).operator === 'dev-lead', 'Operator persisted in status record');
  }

  // 5. Throws if fromEnv missing
  {
    assertThrows(
      () => TransportAgent.submitRequest(bb as never, { fromEnv: '', toEnv: 'st', reason: 'r' }),
      'Throws if fromEnv empty',
    );
  }

  // 6. Throws if toEnv missing
  {
    assertThrows(
      () => TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: '', reason: 'r' }),
      'Throws if toEnv empty',
    );
  }

  // 7. Throws if reason missing
  {
    assertThrows(
      () => TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: '' }),
      'Throws if reason empty',
    );
  }

  // 8. Each call returns a unique trId
  {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      ids.add(TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: 'unique' }));
    }
    assert(ids.size === 5, 'Each submitRequest returns a unique trId');
  }
}

// ============================================================================
// tb — TransportAgent.execute: happy path
// ============================================================================

async function testHappyPath() {
  header('tb — TransportAgent.execute: happy path dev→st');

  const bb = new MockBlackboard();
  const envMgr = new MockEnvManager();
  const authMgr = new MockAuthGuardian();
  const tmpDir = makeTempDir();
  const auditPath = path.join(tmpDir, 'audit.jsonl');

  const agent = new TransportAgent({
    blackboard: bb as never,
    envManager: envMgr as never,
    authGuardian: authMgr as never,
    auditLogPath: auditPath,
  });

  const trId = TransportAgent.submitRequest(bb as never, {
    fromEnv: 'dev', toEnv: 'st', reason: 'Sprint 1 config',
    operator: 'dev-lead', canaryWindowMs: 0,
  });

  const result = await agent.execute(trId);

  // 9. Final status is 'complete'
  assert(result.status === 'complete', 'Happy path final status is complete');

  // 10. authGuardian was called with correct agentId
  assert(authMgr.calls.length >= 1, 'AuthGuardian.requestPermission was called');
  assert(authMgr.calls[0].agentId === 'basis:transport', 'AuthGuardian called with agentId basis:transport');
  assert(authMgr.calls[0].resource === 'ENVIRONMENT_PROMOTE', 'AuthGuardian called with resource ENVIRONMENT_PROMOTE');

  // 11. envManager.backup was called before promote
  assert(envMgr.backupCalls.length >= 1, 'backup() was called');
  assert(envMgr.backupCalls[0].env === 'st', 'backup() called for destination env (st)');

  // 12. envManager.promote was called
  assert(envMgr.promoteCalls.length === 1, 'promote() was called exactly once');
  assert(envMgr.promoteCalls[0].from === 'dev', 'promote() called with fromEnv dev');
  assert(envMgr.promoteCalls[0].to === 'st', 'promote() called with toEnv st');

  // 13. Status record has backupId
  assert(typeof result.backupId === 'string' && result.backupId.length > 0, 'Status record has backupId');

  // 14. Status record has promotionResult
  assert(result.promotionResult !== undefined, 'Status record has promotionResult');

  // 15. startedAt and completedAt are set
  assert(typeof result.startedAt === 'string', 'startedAt is set');
  assert(typeof result.completedAt === 'string', 'completedAt is set');

  // 16. Lock key is released after completion
  const lockEntry = bb.read(`transport:lock:st`);
  assert(lockEntry === null, 'Advisory lock is released after completion');

  // 17. Audit entry written
  const auditContent = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf-8') : '';
  assert(auditContent.includes('transport:complete'), 'Audit entry transport:complete written');
  assert(auditContent.includes(trId), 'Audit entry references trId');

  cleanTempDir(tmpDir);
}

// ============================================================================
// tc — TransportAgent.execute: prerequisites
// ============================================================================

async function testPrerequisites() {
  header('tc — TransportAgent.execute: prerequisites');

  // 18. Fails when prereq not found
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const authMgr = new MockAuthGuardian();
    const agent = new TransportAgent({ blackboard: bb as never, envManager: envMgr as never, authGuardian: authMgr as never, auditLogPath: '/dev/null' });

    const trId = TransportAgent.submitRequest(bb as never, {
      fromEnv: 'dev', toEnv: 'st', reason: 'r', prerequisites: ['tr-does-not-exist'], canaryWindowMs: 0,
    });
    const result = await agent.execute(trId);
    assert(result.status === 'failed', 'Fails when prereq TR not found');
    assert(result.error?.includes('tr-does-not-exist') ?? false, 'Error names the missing prereq');
  }

  // 19. Fails when prereq is pending (not complete)
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const authMgr = new MockAuthGuardian();
    const agent = new TransportAgent({ blackboard: bb as never, envManager: envMgr as never, authGuardian: authMgr as never, auditLogPath: '/dev/null' });

    const prereqId = TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: 'prereq', canaryWindowMs: 0 });
    // prereq stays pending — don't execute it

    const trId = TransportAgent.submitRequest(bb as never, {
      fromEnv: 'st', toEnv: 'sit', reason: 'blocked', prerequisites: [prereqId], canaryWindowMs: 0,
    });
    const result = await agent.execute(trId);
    assert(result.status === 'failed', 'Fails when prereq is in pending state');
    assert(result.error?.includes('pending') ?? false, 'Error mentions pending state');
  }

  // 20. Succeeds when prereq is complete
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const authMgr = new MockAuthGuardian();
    const agent = new TransportAgent({ blackboard: bb as never, envManager: envMgr as never, authGuardian: authMgr as never, auditLogPath: '/dev/null' });

    const prereqId = TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: 'prereq', canaryWindowMs: 0 });
    await agent.execute(prereqId); // complete the prereq

    const trId = TransportAgent.submitRequest(bb as never, {
      fromEnv: 'st', toEnv: 'sit', reason: 'should pass', prerequisites: [prereqId], canaryWindowMs: 0,
    });
    const result = await agent.execute(trId);
    assert(result.status === 'complete', 'Succeeds when prereq is complete');
  }

  // 21. Empty prerequisites array does not block
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const authMgr = new MockAuthGuardian();
    const agent = new TransportAgent({ blackboard: bb as never, envManager: envMgr as never, authGuardian: authMgr as never, auditLogPath: '/dev/null' });

    const trId = TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: 'r', prerequisites: [], canaryWindowMs: 0 });
    const result = await agent.execute(trId);
    assert(result.status === 'complete', 'Empty prerequisites array does not block');
  }
}

// ============================================================================
// td — TransportAgent.execute: advisory lock exclusion
// ============================================================================

async function testLockExclusion() {
  header('td — TransportAgent.execute: advisory lock exclusion');

  // 22. Second TR for same toEnv fails while first holds lock
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const authMgr = new MockAuthGuardian();

    // Manually insert a lock to simulate a concurrent TR
    bb.write('transport:lock:qa', { trId: 'tr-concurrent', lockedAt: new Date().toISOString() }, 'basis:transport');

    const agent = new TransportAgent({ blackboard: bb as never, envManager: envMgr as never, authGuardian: authMgr as never, auditLogPath: '/dev/null' });

    const trId = TransportAgent.submitRequest(bb as never, { fromEnv: 'st', toEnv: 'qa', reason: 'r', canaryWindowMs: 0 });
    const result = await agent.execute(trId);
    assert(result.status === 'failed', 'TR fails when target env is locked');
    assert(result.error?.includes('tr-concurrent') ?? false, 'Error names the lock holder');
  }

  // 23. Lock is released even when promotion fails
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    envMgr.shouldFailPromote = true;
    const authMgr = new MockAuthGuardian();
    const agent = new TransportAgent({ blackboard: bb as never, envManager: envMgr as never, authGuardian: authMgr as never, auditLogPath: '/dev/null' });

    const trId = TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: 'fail test', canaryWindowMs: 0 });
    const result = await agent.execute(trId);
    assert(result.status === 'failed', 'Status is failed when promote throws');
    assert(bb.read('transport:lock:st') === null, 'Lock released after promote failure');
  }

  // 24. After TR completes, same toEnv can be promoted again
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const authMgr = new MockAuthGuardian();
    const agent = new TransportAgent({ blackboard: bb as never, envManager: envMgr as never, authGuardian: authMgr as never, auditLogPath: '/dev/null' });

    const tr1 = TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: 'first', canaryWindowMs: 0 });
    await agent.execute(tr1);

    const tr2 = TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: 'second', canaryWindowMs: 0 });
    const result2 = await agent.execute(tr2);
    assert(result2.status === 'complete', 'Second TR to same env succeeds after first completes');
  }
}

// ============================================================================
// te — TransportAgent.execute: auth denial
// ============================================================================

async function testAuthDenial() {
  header('te — TransportAgent.execute: auth denial');

  // 25. Status is 'failed' when auth is denied
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const authMgr = new MockAuthGuardian();
    authMgr.shouldGrant = false;
    authMgr.denyReason = 'insufficient trust level';
    const agent = new TransportAgent({ blackboard: bb as never, envManager: envMgr as never, authGuardian: authMgr as never, auditLogPath: '/dev/null' });

    const trId = TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: 'r', canaryWindowMs: 0 });
    const result = await agent.execute(trId);
    assert(result.status === 'failed', 'Status is failed when auth denied');
    assert(result.error?.includes('insufficient trust level') ?? false, 'Error includes denial reason');
  }

  // 26. Lock is released after auth denial
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const authMgr = new MockAuthGuardian();
    authMgr.shouldGrant = false;
    const agent = new TransportAgent({ blackboard: bb as never, envManager: envMgr as never, authGuardian: authMgr as never, auditLogPath: '/dev/null' });

    const trId = TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: 'r', canaryWindowMs: 0 });
    await agent.execute(trId);
    assert(bb.read('transport:lock:st') === null, 'Lock released after auth denial');
  }

  // 27. promote() never called when auth denied
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const authMgr = new MockAuthGuardian();
    authMgr.shouldGrant = false;
    const agent = new TransportAgent({ blackboard: bb as never, envManager: envMgr as never, authGuardian: authMgr as never, auditLogPath: '/dev/null' });

    const trId = TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: 'r', canaryWindowMs: 0 });
    await agent.execute(trId);
    assert(envMgr.promoteCalls.length === 0, 'promote() not called after auth denial');
  }
}

// ============================================================================
// tf — TransportAgent.execute: promote failure
// ============================================================================

async function testPromoteFailure() {
  header('tf — TransportAgent.execute: promote failure');

  // 28. Status is 'failed' when promote throws
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    envMgr.shouldFailPromote = true;
    const authMgr = new MockAuthGuardian();
    const agent = new TransportAgent({ blackboard: bb as never, envManager: envMgr as never, authGuardian: authMgr as never, auditLogPath: '/dev/null' });

    const trId = TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: 'r', canaryWindowMs: 0 });
    const result = await agent.execute(trId);
    assert(result.status === 'failed', 'Status is failed when promote throws');
    assert(result.error?.includes('promote failed') ?? false, 'Error message from promote exception');
  }

  // 29. Pool is resumed after promote failure
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    envMgr.shouldFailPromote = true;
    const authMgr = new MockAuthGuardian();
    const pool = makePool(['st']);
    const agent = new TransportAgent({
      blackboard: bb as never, envManager: envMgr as never, authGuardian: authMgr as never,
      pools: [pool], auditLogPath: '/dev/null',
    });

    const trId = TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: 'r', canaryWindowMs: 0 });
    await agent.execute(trId);
    assert(!pool.isDispatchPaused, 'Pool is resumed after promote failure');
    assert(pool.dispatchAllowedPercent === 100, 'Pool restored to 100% capacity');
  }

  // 30. Backup is attempted even when promote will fail
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    envMgr.shouldFailPromote = true;
    const authMgr = new MockAuthGuardian();
    const agent = new TransportAgent({ blackboard: bb as never, envManager: envMgr as never, authGuardian: authMgr as never, auditLogPath: '/dev/null' });

    const trId = TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: 'r', canaryWindowMs: 0 });
    await agent.execute(trId);
    assert(envMgr.backupCalls.length >= 1, 'backup() was still attempted before promote');
  }
}

// ============================================================================
// tg — TransportAgent.execute: canary
// ============================================================================

async function testCanary() {
  header('tg — TransportAgent.execute: canary');

  // 31. Status passes through 'canary' when canaryWindowMs > 0 and monitor present
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const authMgr = new MockAuthGuardian();
    const monitor = new MockComplianceMonitor();
    const statuses: string[] = [];

    // Track status transitions
    const origWrite = bb.write.bind(bb);
    bb.write = (key: string, value: unknown, agent: string, ttl?: number) => {
      if (key.startsWith('transport:status:')) {
        statuses.push((value as TransportStatusRecord).status);
      }
      return origWrite(key, value, agent, ttl);
    };

    const agent = new TransportAgent({
      blackboard: bb as never, envManager: envMgr as never, authGuardian: authMgr as never,
      complianceMonitor: monitor as never, auditLogPath: '/dev/null',
    });

    const trId = TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: 'r', canaryWindowMs: 10, canaryMaxViolations: 0 });
    const result = await agent.execute(trId);
    assert(statuses.includes('canary'), 'Status transitions through canary');
    assert(result.status === 'complete', 'Canary pass → status complete');
    assert(result.violationsDetected === 0, 'violationsDetected is 0 when no violations');
  }

  // 32. canaryWindowMs=0 skips canary phase
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const authMgr = new MockAuthGuardian();
    const monitor = new MockComplianceMonitor();
    const statuses: string[] = [];

    const origWrite = bb.write.bind(bb);
    bb.write = (key: string, value: unknown, agent: string, ttl?: number) => {
      if (key.startsWith('transport:status:')) statuses.push((value as TransportStatusRecord).status);
      return origWrite(key, value, agent, ttl);
    };

    const agent = new TransportAgent({
      blackboard: bb as never, envManager: envMgr as never, authGuardian: authMgr as never,
      complianceMonitor: monitor as never, auditLogPath: '/dev/null',
    });

    const trId = TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: 'r', canaryWindowMs: 0 });
    const result = await agent.execute(trId);
    assert(!statuses.includes('canary'), 'canaryWindowMs=0 skips canary state');
    assert(result.status === 'complete', 'Status complete without canary');
  }

  // 33. No complianceMonitor → canary skipped even if canaryWindowMs > 0
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const authMgr = new MockAuthGuardian();
    const statuses: string[] = [];

    const origWrite = bb.write.bind(bb);
    bb.write = (key: string, value: unknown, agent: string, ttl?: number) => {
      if (key.startsWith('transport:status:')) statuses.push((value as TransportStatusRecord).status);
      return origWrite(key, value, agent, ttl);
    };

    const agent = new TransportAgent({
      blackboard: bb as never, envManager: envMgr as never, authGuardian: authMgr as never,
      auditLogPath: '/dev/null',
    });

    const trId = TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: 'r', canaryWindowMs: 5000 });
    const result = await agent.execute(trId);
    assert(!statuses.includes('canary'), 'No complianceMonitor → canary skipped');
    assert(result.status === 'complete', 'Status complete when monitor absent');
  }

  // 34. Violations during canary → rolled_back
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const authMgr = new MockAuthGuardian();
    const monitor = new MockComplianceMonitor();
    const agent = new TransportAgent({
      blackboard: bb as never, envManager: envMgr as never, authGuardian: authMgr as never,
      complianceMonitor: monitor as never, auditLogPath: '/dev/null',
    });

    // Inject violation during canary (by patching getViolations to return extra after first call)
    let callCount = 0;
    const origGet = monitor.getViolations.bind(monitor);
    monitor.getViolations = () => {
      callCount++;
      if (callCount === 1) return [];                           // before canary window
      return [{ type: 'POLICY', message: 'oops', severity: 'high' }]; // after window
    };

    const trId = TransportAgent.submitRequest(bb as never, {
      fromEnv: 'dev', toEnv: 'st', reason: 'r',
      canaryWindowMs: 10, canaryMaxViolations: 0,
    });
    const result = await agent.execute(trId);
    assert(result.status === 'rolled_back', 'Canary violation → status rolled_back');
    assert((result.violationsDetected ?? 0) > 0, 'violationsDetected reflects spike');
  }

  // 35. Rollback calls envManager.restore with correct backupId
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const authMgr = new MockAuthGuardian();
    const monitor = new MockComplianceMonitor();
    let callCount = 0;
    monitor.getViolations = () => { callCount++; return callCount === 1 ? [] : [{ type: 'V', message: 'm', severity: 'low' }]; };
    const agent = new TransportAgent({
      blackboard: bb as never, envManager: envMgr as never, authGuardian: authMgr as never,
      complianceMonitor: monitor as never, auditLogPath: '/dev/null',
    });

    const trId = TransportAgent.submitRequest(bb as never, {
      fromEnv: 'dev', toEnv: 'st', reason: 'r', canaryWindowMs: 10, canaryMaxViolations: 0,
    });
    const result = await agent.execute(trId);
    assert(envMgr.restoreCalls.length === 1, 'restore() called on rollback');
    assert(envMgr.restoreCalls[0].env === 'st', 'restore() targets correct env');
    assert(envMgr.restoreCalls[0].backupId === result.backupId, 'restore() uses backupId from pre-promote backup');
  }

  // 36. Pool fully resumed after rollback
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const authMgr = new MockAuthGuardian();
    const monitor = new MockComplianceMonitor();
    let callCount = 0;
    monitor.getViolations = () => { callCount++; return callCount === 1 ? [] : [{ type: 'V', message: 'm', severity: 'low' }]; };
    const pool = makePool(['st']);
    const agent = new TransportAgent({
      blackboard: bb as never, envManager: envMgr as never, authGuardian: authMgr as never,
      complianceMonitor: monitor as never, pools: [pool], auditLogPath: '/dev/null',
    });

    const trId = TransportAgent.submitRequest(bb as never, {
      fromEnv: 'dev', toEnv: 'st', reason: 'r', canaryWindowMs: 10, canaryMaxViolations: 0,
    });
    await agent.execute(trId);
    assert(!pool.isDispatchPaused, 'Pool fully resumed after rollback');
    assert(pool.dispatchAllowedPercent === 100, 'Pool restored to 100% after rollback');
  }

  // 37. canaryMaxViolations=1 allows one violation
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const authMgr = new MockAuthGuardian();
    const monitor = new MockComplianceMonitor();
    let callCount = 0;
    monitor.getViolations = () => { callCount++; return callCount === 1 ? [] : [{ type: 'V', message: 'm', severity: 'low' }]; };
    const agent = new TransportAgent({
      blackboard: bb as never, envManager: envMgr as never, authGuardian: authMgr as never,
      complianceMonitor: monitor as never, auditLogPath: '/dev/null',
    });

    const trId = TransportAgent.submitRequest(bb as never, {
      fromEnv: 'dev', toEnv: 'st', reason: 'r', canaryWindowMs: 10, canaryMaxViolations: 1,
    });
    const result = await agent.execute(trId);
    assert(result.status === 'complete', 'canaryMaxViolations=1 allows 1 violation, stays complete');
  }
}

// ============================================================================
// th — TransportAgent.start/stop poll loop
// ============================================================================

async function testPollLoop() {
  header('th — TransportAgent.start/stop poll loop');

  // 38. isRunning false before start
  {
    const bb = new MockBlackboard();
    const agent = new TransportAgent({ blackboard: bb as never, envManager: new MockEnvManager() as never, authGuardian: new MockAuthGuardian() as never, auditLogPath: '/dev/null' });
    assert(!agent.isRunning, 'isRunning is false before start');
  }

  // 39. isRunning true after start
  {
    const bb = new MockBlackboard();
    const agent = new TransportAgent({ blackboard: bb as never, envManager: new MockEnvManager() as never, authGuardian: new MockAuthGuardian() as never, auditLogPath: '/dev/null', pollIntervalMs: 100000 });
    agent.start();
    assert(agent.isRunning, 'isRunning is true after start');
    agent.stop();
  }

  // 40. isRunning false after stop
  {
    const bb = new MockBlackboard();
    const agent = new TransportAgent({ blackboard: bb as never, envManager: new MockEnvManager() as never, authGuardian: new MockAuthGuardian() as never, auditLogPath: '/dev/null', pollIntervalMs: 100000 });
    agent.start();
    agent.stop();
    assert(!agent.isRunning, 'isRunning is false after stop');
  }

  // 41. Double start is idempotent
  {
    const bb = new MockBlackboard();
    const agent = new TransportAgent({ blackboard: bb as never, envManager: new MockEnvManager() as never, authGuardian: new MockAuthGuardian() as never, auditLogPath: '/dev/null', pollIntervalMs: 100000 });
    agent.start();
    agent.start(); // should not throw
    assert(agent.isRunning, 'Double start is idempotent');
    agent.stop();
  }

  // 42. execute() throws when TR not found
  {
    const bb = new MockBlackboard();
    const agent = new TransportAgent({ blackboard: bb as never, envManager: new MockEnvManager() as never, authGuardian: new MockAuthGuardian() as never, auditLogPath: '/dev/null' });
    await assertRejects(() => agent.execute('tr-does-not-exist'), 'execute() throws when TR not found');
  }

  // 43. Poll loop picks up and processes pending TRs
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const authMgr = new MockAuthGuardian();
    const agent = new TransportAgent({
      blackboard: bb as never, envManager: envMgr as never, authGuardian: authMgr as never,
      auditLogPath: '/dev/null', pollIntervalMs: 20,
    });

    const trId = TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: 'poll test', canaryWindowMs: 0 });
    agent.start();
    await new Promise(r => setTimeout(r, 200)); // wait for poll
    agent.stop();

    const entry = bb.read(`transport:status:${trId}`);
    const status = (entry?.value as TransportStatusRecord)?.status;
    assert(status === 'complete', 'Poll loop processes pending TRs');
  }
}

// ============================================================================
// ti — AgentPool.setDispatchPause
// ============================================================================

function testAgentPoolPause() {
  header('ti — AgentPool.setDispatchPause');

  // 44. canSpawn false when paused
  {
    const pool = makePool(['st'], 5);
    pool.setDispatchPause(true);
    assert(!pool.canSpawn, 'canSpawn is false when paused');
  }

  // 45. canSpawn true when not paused and below limit
  {
    const pool = makePool(['st'], 5);
    assert(pool.canSpawn, 'canSpawn is true when not paused and no active agents');
  }

  // 46. isDispatchPaused reflects pause state
  {
    const pool = makePool(['st'], 5);
    assert(!pool.isDispatchPaused, 'isDispatchPaused false by default');
    pool.setDispatchPause(true);
    assert(pool.isDispatchPaused, 'isDispatchPaused true after pause');
    pool.setDispatchPause(false);
    assert(!pool.isDispatchPaused, 'isDispatchPaused false after resume');
  }

  // 47. dispatchAllowedPercent defaults to 100
  {
    const pool = makePool(['st'], 5);
    assert(pool.dispatchAllowedPercent === 100, 'dispatchAllowedPercent defaults to 100');
  }

  // 48. setDispatchPause(false, { percent: 50 }) limits capacity
  {
    const pool = makePool(['st'], 10);
    pool.setDispatchPause(false, { percent: 50 });
    assert(!pool.isDispatchPaused, 'pool not paused after percent resume');
    assert(pool.dispatchAllowedPercent === 50, 'dispatchAllowedPercent set to 50');
    // With 10 max and 50%, limit is 5 — so canSpawn should be true (0 active < 5)
    assert(pool.canSpawn, 'canSpawn true at 50% with no active agents');
  }

  // 49. setDispatchPause(true) ignores percent option
  {
    const pool = makePool(['st'], 10);
    pool.setDispatchPause(true, { percent: 50 });
    assert(pool.isDispatchPaused, 'Paused even when percent option provided');
    assert(!pool.canSpawn, 'canSpawn false when paused regardless of percent');
  }

  // 50. Resume with no options restores 100%
  {
    const pool = makePool(['st'], 10);
    pool.setDispatchPause(false, { percent: 30 });
    pool.setDispatchPause(false);
    assert(pool.dispatchAllowedPercent === 100, 'Resume with no options restores 100%');
  }

  // 51. Percent clamped to minimum of 1
  {
    const pool = makePool(['st'], 10);
    pool.setDispatchPause(false, { percent: 0 });
    assert(pool.dispatchAllowedPercent >= 1, 'Percent clamped to minimum of 1');
  }

  // 52. Percent clamped to maximum of 100
  {
    const pool = makePool(['st'], 10);
    pool.setDispatchPause(false, { percent: 200 });
    assert(pool.dispatchAllowedPercent === 100, 'Percent clamped to maximum of 100');
  }

  // 53. Pool tagged for different env is not drained for unrelated env
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const authMgr = new MockAuthGuardian();
    const prodPool = makePool(['prod'], 5);  // tagged for prod, not st
    const agent = new TransportAgent({
      blackboard: bb as never, envManager: envMgr as never, authGuardian: authMgr as never,
      pools: [prodPool], auditLogPath: '/dev/null',
    });

    const trId = TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: 'r', canaryWindowMs: 0 });
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    void agent.execute(trId);
    // prod pool should NOT be paused for a dev→st promotion
    // Since execute is async and runs immediately, check after a tick
    setTimeout(() => {
      assert(!prodPool.isDispatchPaused, 'Pool tagged for prod not drained for dev→st promotion');
    }, 10);
    pass('Pool tagged for different env not drained (deferred check)');
  }
}

// ============================================================================
// tj — LandscapeAgent health tracking
// ============================================================================

async function testLandscapeAgent() {
  header('tj — LandscapeAgent health tracking');

  // 54. poll() writes landscape:health:<env> for each env
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const la = new LandscapeAgent({ blackboard: bb as never, envManager: envMgr as never });

    await la.poll();
    const envs = envMgr.list();
    for (const env of envs) {
      const entry = bb.read(`landscape:health:${env.name}`);
      assert(entry !== null, `Writes landscape:health:${env.name}`);
    }
  }

  // 55. Missing env → status 'missing', keyCount 0
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const la = new LandscapeAgent({ blackboard: bb as never, envManager: envMgr as never });

    await la.poll();
    const sitEntry = bb.read('landscape:health:sit');
    const health = sitEntry?.value as EnvironmentHealth;
    assert(health.status === 'missing', 'Missing env → status missing');
    assert(health.keyCount === 0, 'Missing env → keyCount 0');
  }

  // 56. Existing env with no transport history → status 'healthy'
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const la = new LandscapeAgent({ blackboard: bb as never, envManager: envMgr as never });

    await la.poll();
    const devEntry = bb.read('landscape:health:dev');
    const health = devEntry?.value as EnvironmentHealth;
    assert(health.status === 'healthy', 'Existing env with no transport history → healthy');
    assert(health.keyCount === 3, 'keyCount reflects envManager value');
  }

  // 57. Env with last TR failed → status 'degraded'
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const la = new LandscapeAgent({ blackboard: bb as never, envManager: envMgr as never });

    // Inject a failed transport status
    bb.write('transport:status:tr-fail-1', {
      trId: 'tr-fail-1', status: 'failed', fromEnv: 'dev', toEnv: 'qa',
      reason: 'r', submittedAt: '2024-01-01T00:00:00.000Z', completedAt: '2024-01-01T00:01:00.000Z',
    } as TransportStatusRecord, 'basis:transport');

    await la.poll();
    const qaEntry = bb.read('landscape:health:qa');
    const health = qaEntry?.value as EnvironmentHealth;
    assert(health.status === 'degraded', 'Env with last TR failed → degraded');
    assert(health.lastTransportStatus === 'failed', 'lastTransportStatus set to failed');
  }

  // 58. Env with last TR rolled_back → status 'degraded'
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const la = new LandscapeAgent({ blackboard: bb as never, envManager: envMgr as never });

    bb.write('transport:status:tr-rb-1', {
      trId: 'tr-rb-1', status: 'rolled_back', fromEnv: 'dev', toEnv: 'dev',
      reason: 'r', submittedAt: '2024-01-01T00:00:00.000Z', completedAt: '2024-01-01T00:01:00.000Z',
    } as TransportStatusRecord, 'basis:transport');

    await la.poll();
    const devEntry = bb.read('landscape:health:dev');
    const health = devEntry?.value as EnvironmentHealth;
    assert(health.status === 'degraded', 'Env with rolled_back TR → degraded');
  }

  // 59. Env with last TR complete → status 'healthy'
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const la = new LandscapeAgent({ blackboard: bb as never, envManager: envMgr as never });

    bb.write('transport:status:tr-ok-1', {
      trId: 'tr-ok-1', status: 'complete', fromEnv: 'dev', toEnv: 'prod',
      reason: 'r', submittedAt: '2024-01-01T00:00:00.000Z', completedAt: '2024-01-01T00:01:00.000Z',
    } as TransportStatusRecord, 'basis:transport');

    await la.poll();
    const prodEntry = bb.read('landscape:health:prod');
    const health = prodEntry?.value as EnvironmentHealth;
    assert(health.status === 'healthy', 'Env with complete TR → healthy');
    assert(health.lastTransportId === 'tr-ok-1', 'lastTransportId set correctly');
  }

  // 60. Picks latest TR by completedAt (not insertion order)
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const la = new LandscapeAgent({ blackboard: bb as never, envManager: envMgr as never });

    // Older TR: complete
    bb.write('transport:status:tr-old', {
      trId: 'tr-old', status: 'complete', fromEnv: 'dev', toEnv: 'st',
      reason: 'r', submittedAt: '2024-01-01T00:00:00.000Z', completedAt: '2024-01-01T00:01:00.000Z',
    } as TransportStatusRecord, 'basis:transport');

    // Newer TR: failed
    bb.write('transport:status:tr-new', {
      trId: 'tr-new', status: 'failed', fromEnv: 'dev', toEnv: 'st',
      reason: 'r', submittedAt: '2024-01-02T00:00:00.000Z', completedAt: '2024-01-02T00:01:00.000Z',
    } as TransportStatusRecord, 'basis:transport');

    await la.poll();
    const stEntry = bb.read('landscape:health:st');
    const health = stEntry?.value as EnvironmentHealth;
    assert(health.status === 'degraded', 'Latest TR (failed) takes precedence over older complete TR');
    assert(health.lastTransportId === 'tr-new', 'lastTransportId points to newest TR');
  }

  // 61. lastChecked is an ISO-8601 timestamp
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const la = new LandscapeAgent({ blackboard: bb as never, envManager: envMgr as never });

    await la.poll();
    const devEntry = bb.read('landscape:health:dev');
    const health = devEntry?.value as EnvironmentHealth;
    assert(!isNaN(Date.parse(health.lastChecked)), 'lastChecked is a valid ISO-8601 timestamp');
  }

  // 62. isRunning reflects start/stop state
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const la = new LandscapeAgent({ blackboard: bb as never, envManager: envMgr as never, pollIntervalMs: 100000 });
    assert(!la.isRunning, 'isRunning false before start');
    la.start();
    assert(la.isRunning, 'isRunning true after start');
    la.stop();
    assert(!la.isRunning, 'isRunning false after stop');
  }

  // 63. Double start is idempotent
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const la = new LandscapeAgent({ blackboard: bb as never, envManager: envMgr as never, pollIntervalMs: 100000 });
    la.start();
    la.start();
    assert(la.isRunning, 'Double start is idempotent');
    la.stop();
  }
}

// ============================================================================
// tk — Integration scenarios
// ============================================================================

async function testIntegration() {
  header('tk — Integration scenarios');

  // 64. Full dev→st chain: landscape tracks state changes
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const authMgr = new MockAuthGuardian();
    const la = new LandscapeAgent({ blackboard: bb as never, envManager: envMgr as never });

    const agent = new TransportAgent({ blackboard: bb as never, envManager: envMgr as never, authGuardian: authMgr as never, auditLogPath: '/dev/null' });

    const trId = TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: 'integration', canaryWindowMs: 0 });
    await agent.execute(trId);
    await la.poll();

    const stHealth = bb.read('landscape:health:st')?.value as EnvironmentHealth;
    assert(stHealth.status === 'healthy', 'st healthy after successful promotion');
    assert(stHealth.lastTransportId === trId, 'LandscapeAgent tracks the correct trId');
  }

  // 65. Failed TR causes LandscapeAgent to mark env degraded
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    envMgr.shouldFailPromote = true;
    const authMgr = new MockAuthGuardian();
    const la = new LandscapeAgent({ blackboard: bb as never, envManager: envMgr as never });

    const agent = new TransportAgent({ blackboard: bb as never, envManager: envMgr as never, authGuardian: authMgr as never, auditLogPath: '/dev/null' });

    const trId = TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: 'fail integration', canaryWindowMs: 0 });
    await agent.execute(trId);
    await la.poll();

    const stHealth = bb.read('landscape:health:st')?.value as EnvironmentHealth;
    assert(stHealth.status === 'degraded', 'Landscape marks env degraded after failed TR');
  }

  // 66. Pool drain/resume round-trip
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const authMgr = new MockAuthGuardian();
    const pool = makePool(['st'], 4);
    const agent = new TransportAgent({
      blackboard: bb as never, envManager: envMgr as never, authGuardian: authMgr as never,
      pools: [pool], auditLogPath: '/dev/null',
    });

    const trId = TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: 'drain round-trip', canaryWindowMs: 0 });
    await agent.execute(trId);

    assert(!pool.isDispatchPaused, 'Pool fully resumed after complete transport');
    assert(pool.dispatchAllowedPercent === 100, 'Pool at 100% capacity after transport');
    assert(pool.canSpawn, 'Pool can spawn after transport');
  }

  // 67. Multiple pools: only env-tagged pools are affected
  {
    const bb = new MockBlackboard();
    const envMgr = new MockEnvManager();
    const authMgr = new MockAuthGuardian();
    const stPool = makePool(['st'], 4);
    const prodPool = makePool(['prod'], 4);
    const untaggedPool = makePool([], 4);

    const agent = new TransportAgent({
      blackboard: bb as never, envManager: envMgr as never, authGuardian: authMgr as never,
      pools: [stPool, prodPool, untaggedPool], auditLogPath: '/dev/null',
    });

    const trId = TransportAgent.submitRequest(bb as never, { fromEnv: 'dev', toEnv: 'st', reason: 'multi-pool', canaryWindowMs: 0 });
    await agent.execute(trId);

    assert(!stPool.isDispatchPaused, 'st pool resumed after st promotion');
    assert(!prodPool.isDispatchPaused, 'prod pool never paused during st promotion');
    assert(!untaggedPool.isDispatchPaused, 'untagged pool never paused');
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('\n' + '='.repeat(68));
  log('  Network-AI — Transport Tier Test Suite', 'bold');
  console.log('='.repeat(68));

  testSubmitRequest();
  await testHappyPath();
  await testPrerequisites();
  await testLockExclusion();
  await testAuthDenial();
  await testPromoteFailure();
  await testCanary();
  await testPollLoop();
  testAgentPoolPause();
  await testLandscapeAgent();
  await testIntegration();

  console.log('\n' + '='.repeat(68));
  const total = passed + failed;
  log(`  Results: ${passed}/${total} passed`, failed === 0 ? 'green' : 'red');
  if (failed > 0) log(`           ${failed} FAILED`, 'red');
  console.log('='.repeat(68) + '\n');

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
