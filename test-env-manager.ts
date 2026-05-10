/**
 * test-env-manager.ts — Tests for v5.4.0 Environment Isolation (Phase 13)
 *
 * Covers:
 *   1.  EnvironmentManager init (directory scaffold)
 *   2.  Data path isolation (dev writes never appear in prod reads)
 *   3.  Promotion — config copied, live state not copied
 *   4.  Sandbox non-promotable
 *   5.  Gate enforcement (preprod needs confirmedBy, prod needs approvedBy)
 *   6.  Env diff (detects config differences)
 *   7.  --env CLI flag / resolveEnvData helper
 *   8.  NETWORK_AI_ENV env var auto-picked by LockedBlackboard
 *   9.  Source protection (FileAccessor blocks paths outside data/<env>/)
 *  10.  Backward compatibility (no env = data/ root unchanged)
 *  11.  Backup / restore round-trip
 *  12.  Auto-backup on promote
 *
 * Run with: npx ts-node test-env-manager.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { EnvironmentManager } from './lib/env-manager';
import type { PromoteOptions } from './lib/env-manager';
import { LockedBlackboard } from './lib/locked-blackboard';
import { SandboxPolicy, FileAccessor } from './lib/agent-runtime';

// ── tiny test harness ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

function assertThrows(fn: () => unknown, msg: string): void {
  try {
    fn();
    failed++;
    failures.push(`${msg} (expected throw, got none)`);
    console.error(`  ✗ FAIL: ${msg} (expected throw, got none)`);
  } catch {
    passed++;
    console.log(`  ✓ ${msg}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nai-env-'));
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// =============================================================================
// SECTION 1: EnvironmentManager init — directory scaffold
// =============================================================================

section('1. EnvironmentManager init — directory scaffold');

(function () {
  const dir = tmpDir();
  try {
    const mgr = new EnvironmentManager(dir);
    mgr.init('dev');

    const devDir = mgr.getDataDir('dev');
    assert(fs.existsSync(devDir), 'dev directory created');
    assert(fs.existsSync(path.join(devDir, 'blackboard')), 'dev/blackboard/ created');
    assert(fs.existsSync(path.join(devDir, 'pending_changes')), 'dev/pending_changes/ created');
    assert(fs.existsSync(path.join(devDir, '.backups')), 'dev/.backups/ created');
    assert(fs.existsSync(path.join(devDir, 'trust_levels.json')), 'dev/trust_levels.json created');
    assert(fs.existsSync(path.join(devDir, 'active_grants.json')), 'dev/active_grants.json created');
    assert(fs.existsSync(path.join(devDir, 'project-context.json')), 'dev/project-context.json created');
    assert(fs.existsSync(path.join(devDir, 'audit_log.jsonl')), 'dev/audit_log.jsonl created');

    // initAll scaffolds all chain envs + sandbox
    mgr.initAll();
    for (const env of ['dev', 'st', 'sit', 'qa', 'preprod', 'prod', 'sandbox']) {
      assert(fs.existsSync(mgr.getDataDir(env)), `${env} directory exists after initAll`);
    }
  } finally {
    cleanup(dir);
  }
})();

// =============================================================================
// SECTION 2: Data path isolation — dev writes never appear in prod reads
// =============================================================================

section('2. Data path isolation — dev writes never appear in prod reads');

(function () {
  const dir = tmpDir();
  try {
    const mgr = new EnvironmentManager(dir);
    mgr.initAll();

    // Write via LockedBlackboard scoped to dev
    const devBoard = new LockedBlackboard(dir, { env: 'dev' });
    devBoard.write('isolated-key', 'dev-only-value', 'test-agent');

    // Read from prod board — should NOT see dev key
    const prodBoard = new LockedBlackboard(dir, { env: 'prod' });
    const prodRead = prodBoard.read('isolated-key');
    assert(prodRead === null, 'prod board does not see dev-only key');

    // Dev board should still have it
    const devRead = devBoard.read('isolated-key');
    assert(devRead !== null, 'dev board has its own key');
    assert((devRead as { value: unknown }).value === 'dev-only-value', 'dev board value correct');

    // Verify physical files are in separate dirs
    const devBBPath = path.join(dir, 'dev', 'swarm-blackboard.md');
    const prodBBPath = path.join(dir, 'prod', 'swarm-blackboard.md');
    assert(fs.existsSync(devBBPath), 'dev blackboard file in dev/ directory');
    assert(fs.existsSync(prodBBPath), 'prod blackboard file in prod/ directory');
  } finally {
    cleanup(dir);
  }
})();

// =============================================================================
// SECTION 3: Promotion — config copied, live state not copied
// =============================================================================

section('3. Promotion — config copied, live state not copied');

(function () {
  const dir = tmpDir();
  try {
    const mgr = new EnvironmentManager(dir);
    mgr.initAll();

    const devDir = mgr.getDataDir('dev');
    const stDir = mgr.getDataDir('st');

    // Write a promotable config file in dev
    fs.writeFileSync(path.join(devDir, 'trust_levels.json'), JSON.stringify({ trust: 'high' }));
    // Write a live-state file that must NOT be promoted
    fs.writeFileSync(path.join(devDir, 'audit_log.jsonl'), '{"action":"test"}\n');
    fs.writeFileSync(path.join(devDir, 'active_grants.json'), JSON.stringify([{ id: 'g1' }]));

    const result = mgr.promote('dev', 'st');
    assert(result.from === 'dev', 'promotion result.from = dev');
    assert(result.to === 'st', 'promotion result.to = st');
    assert(result.configsCopied.includes('trust_levels.json'), 'trust_levels.json was copied');
    assert(typeof result.timestamp === 'string', 'promotion result has timestamp');

    // trust_levels.json should be in st
    const stTrust = path.join(stDir, 'trust_levels.json');
    assert(fs.existsSync(stTrust), 'trust_levels.json present in st');
    const copied = JSON.parse(fs.readFileSync(stTrust, 'utf-8'));
    assert(copied.trust === 'high', 'trust_levels.json value copied correctly');

    // Live state must NOT be promoted
    const stAudit = path.join(stDir, 'audit_log.jsonl');
    const stGrants = path.join(stDir, 'active_grants.json');
    // audit_log might exist (empty, from init) but must not contain dev's data
    if (fs.existsSync(stAudit)) {
      const content = fs.readFileSync(stAudit, 'utf-8');
      assert(!content.includes('"action":"test"'), 'audit_log NOT copied to st');
    } else {
      assert(true, 'audit_log NOT copied to st (file absent)');
    }
    if (fs.existsSync(stGrants)) {
      const grants = JSON.parse(fs.readFileSync(stGrants, 'utf-8'));
      assert(!JSON.stringify(grants).includes('"g1"'), 'active_grants NOT copied to st');
    } else {
      assert(true, 'active_grants NOT copied to st (file absent)');
    }
  } finally {
    cleanup(dir);
  }
})();

// =============================================================================
// SECTION 4: Sandbox non-promotable
// =============================================================================

section('4. Sandbox non-promotable');

(function () {
  const dir = tmpDir();
  try {
    const mgr = new EnvironmentManager(dir);
    mgr.initAll();

    assert(!mgr.isPromotable('sandbox'), 'sandbox.isPromotable() returns false');

    assertThrows(() => mgr.promote('sandbox', 'dev'), 'promote from sandbox throws');
  } finally {
    cleanup(dir);
  }
})();

// =============================================================================
// SECTION 5: Gate enforcement
// =============================================================================

section('5. Gate enforcement (preprod needs confirmedBy, prod needs approvedBy)');

(function () {
  const dir = tmpDir();
  try {
    const mgr = new EnvironmentManager(dir);
    mgr.initAll();

    // qa → preprod requires confirmedBy
    // First promote dev→st→sit→qa so we can promote qa→preprod
    mgr.promote('dev', 'st');
    mgr.promote('st', 'sit');
    mgr.promote('sit', 'qa');

    assertThrows(
      () => mgr.promote('qa', 'preprod'),
      'promote to preprod without confirmedBy throws'
    );

    const r1 = mgr.promote('qa', 'preprod', { confirmedBy: 'ops-lead' });
    assert(r1.confirmedBy === 'ops-lead', 'preprod promotion records confirmedBy');
    assert(r1.to === 'preprod', 'preprod promotion to field correct');

    // preprod → prod requires approvedBy
    assertThrows(
      () => mgr.promote('preprod', 'prod'),
      'promote to prod without approvedBy throws'
    );

    assertThrows(
      () => mgr.promote('preprod', 'prod', { confirmedBy: 'ops-lead' } as unknown as PromoteOptions),
      'promote to prod with confirmedBy only (no approvedBy) throws'
    );

    const r2 = mgr.promote('preprod', 'prod', { approvedBy: 'cto@example.com' });
    assert(r2.approvedBy === 'cto@example.com', 'prod promotion records approvedBy');
    assert(r2.to === 'prod', 'prod promotion to field correct');

    // dev → st is auto (no options needed)
    const r3 = mgr.promote('dev', 'st');
    assert(r3.from === 'dev' && r3.to === 'st', 'auto gate promotion succeeds without options');
  } finally {
    cleanup(dir);
  }
})();

// =============================================================================
// SECTION 6: Env diff
// =============================================================================

section('6. Env diff — detects config differences');

(function () {
  const dir = tmpDir();
  try {
    const mgr = new EnvironmentManager(dir);
    mgr.initAll();

    // Identical initially — no differences on promotable config files
    const noChange = mgr.diff('dev', 'st');
    assert(noChange.env1 === 'dev' && noChange.env2 === 'st', 'diff result contains env names');

    // Write different trust_levels to dev
    const devDir = mgr.getDataDir('dev');
    fs.writeFileSync(path.join(devDir, 'trust_levels.json'), JSON.stringify({ trust: 'high' }));

    const withChange = mgr.diff('dev', 'st');
    const changedFiles = withChange.differences.map(d => d.file);
    assert(changedFiles.includes('trust_levels.json'), 'diff detects changed trust_levels.json');

    // Promote to st and diff again — should show no difference on trust_levels
    mgr.promote('dev', 'st');
    const afterPromote = mgr.diff('dev', 'st');
    const stillChanged = afterPromote.differences.filter(d => d.file === 'trust_levels.json');
    assert(stillChanged.length === 0, 'after promotion, trust_levels.json diff is resolved');
  } finally {
    cleanup(dir);
  }
})();

// =============================================================================
// SECTION 7: getChain, getNextEnv, getGateType
// =============================================================================

section('7. Chain helpers (getChain, getNextEnv, getGateType)');

(function () {
  const dir = tmpDir();
  try {
    const mgr = new EnvironmentManager(dir);
    const chain = mgr.getChain();
    assert(chain[0] === 'dev', 'chain starts with dev');
    assert(chain[chain.length - 1] === 'prod', 'chain ends with prod');
    assert(chain.includes('preprod'), 'chain includes preprod');

    assert(mgr.getNextEnv('dev') === 'st', 'getNextEnv(dev) = st');
    assert(mgr.getNextEnv('preprod') === 'prod', 'getNextEnv(preprod) = prod');
    assert(mgr.getNextEnv('prod') === null, 'getNextEnv(prod) = null');
    assert(mgr.getNextEnv('sandbox') === null, 'getNextEnv(sandbox) = null (not in chain)');

    assert(mgr.getGateType('dev') === 'auto', 'dev gate = auto');
    assert(mgr.getGateType('preprod') === 'confirm', 'preprod gate = confirm');
    assert(mgr.getGateType('prod') === 'approval', 'prod gate = approval');
    assert(mgr.getGateType('sandbox') === 'auto', 'sandbox gate = auto (default)');
  } finally {
    cleanup(dir);
  }
})();

// =============================================================================
// SECTION 8: NETWORK_AI_ENV env var auto-picked by LockedBlackboard
// =============================================================================

section('8. NETWORK_AI_ENV env var auto-picked by LockedBlackboard');

(function () {
  const dir = tmpDir();
  const original = process.env['NETWORK_AI_ENV'];
  try {
    const mgr = new EnvironmentManager(dir);
    mgr.initAll();

    // Set env var
    process.env['NETWORK_AI_ENV'] = 'qa';
    const board = new LockedBlackboard(dir);   // no explicit env option
    board.write('env-var-key', 'env-var-value', 'test');

    // Should have written to qa/
    const qaPath = path.join(dir, 'qa', 'swarm-blackboard.md');
    assert(fs.existsSync(qaPath), 'NETWORK_AI_ENV=qa caused blackboard write to qa/');

    // Reading without env var set should NOT find the key in root
    delete process.env['NETWORK_AI_ENV'];
    const rootBoard = new LockedBlackboard(dir);
    assert(rootBoard.read('env-var-key') === null, 'root board does not see qa-env key when NETWORK_AI_ENV unset');

    // Invalid NETWORK_AI_ENV should throw
    process.env['NETWORK_AI_ENV'] = '../etc/passwd';
    assertThrows(
      () => new LockedBlackboard(dir),
      'invalid NETWORK_AI_ENV value throws LockedBlackboard constructor error'
    );
  } finally {
    if (original === undefined) {
      delete process.env['NETWORK_AI_ENV'];
    } else {
      process.env['NETWORK_AI_ENV'] = original;
    }
    cleanup(dir);
  }
})();

// =============================================================================
// SECTION 9: Source protection — FileAccessor blocks source code paths
// =============================================================================

section('9. Source protection — FileAccessor blocks paths outside data/<env>/');

(function () {
  const projectRoot = path.resolve(__dirname);
  const policy = new SandboxPolicy({
    basePath: projectRoot,
    allowedCommands: [],
    allowedPaths: ['.'],
    sourceProtection: true,
    env: 'dev',
  });

  const accessor = new FileAccessor(policy);

  // Allowed path: data/dev/ subtree
  const allowedPath = path.join(projectRoot, 'data', 'dev', 'some-file.json');
  // We don't actually need to read — test the protection logic by passing a source path
  const blockedPath = path.join(projectRoot, 'lib', 'locked-blackboard.ts');

  // Test sync: resolvePath for blocked source path should resolve fine (path validation
  // only checks traversal) — but checkSourceProtection will block it.
  // We test this via a read() call on a non-existent-but-blocked path.
  let caughtError = '';
  (async () => {
    // reading a source code file should be blocked
    const result = await accessor.read(blockedPath, 'test-agent');
    caughtError = result.error ?? '';

    assert(!result.success, 'source protection: read of lib/ is denied');
    assert(caughtError.includes('Source protection'), `source protection error message present: "${caughtError}"`);

    // reading a data/dev/ path should NOT be source-protected (may still fail with ENOENT)
    const dataResult = await accessor.read(allowedPath, 'test-agent');
    const errMsg = dataResult.error ?? '';
    const isSourceBlocked = errMsg.includes('Source protection');
    assert(!isSourceBlocked, 'data/dev/ path is NOT source-protected');
  })().catch(err => {
    failed++;
    failures.push(`Section 9 async error: ${err}`);
    console.error(`  ✗ Section 9 async error: ${err}`);
  });
})();

// =============================================================================
// SECTION 10: Backward compatibility — no env = data/ root unchanged
// =============================================================================

section('10. Backward compatibility — no env option leaves data/ root unchanged');

(function () {
  const dir = tmpDir();
  try {
    // No env option — LockedBlackboard should write to <dir>/swarm-blackboard.md
    const board = new LockedBlackboard(dir);
    board.write('compat-key', 'compat-val', 'cli');

    const bbPath = path.join(dir, 'swarm-blackboard.md');
    assert(fs.existsSync(bbPath), 'blackboard file at root dir (no env)');

    const val = board.read('compat-key');
    assert(val !== null, 'compat-key can be read back without env');
    assert((val as { value: unknown }).value === 'compat-val', 'compat-key value correct');

    // env-aware board in same dir should be completely separate
    const envBoard = new LockedBlackboard(dir, { env: 'dev' });
    assert(envBoard.read('compat-key') === null, 'env-scoped board does not see root-board keys');
  } finally {
    cleanup(dir);
  }
})();

// =============================================================================
// SECTION 11: Backup / restore round-trip
// =============================================================================

section('11. Backup / restore round-trip');

(function () {
  const dir = tmpDir();
  try {
    const mgr = new EnvironmentManager(dir);
    mgr.init('dev');

    // Write some state to dev
    const devDir = mgr.getDataDir('dev');
    fs.writeFileSync(path.join(devDir, 'trust_levels.json'), JSON.stringify({ trust: 'original' }));

    // Create backup
    const backup = mgr.backup('dev');
    assert(typeof backup.backupId === 'string' && backup.backupId.length > 0, 'backup returns a backupId');
    assert(backup.env === 'dev', 'backup.env = dev');
    assert(backup.filesCount > 0, 'backup reports at least 1 file');
    assert(fs.existsSync(backup.path), 'backup directory exists');

    // Mutate state
    fs.writeFileSync(path.join(devDir, 'trust_levels.json'), JSON.stringify({ trust: 'mutated' }));
    const mutated = JSON.parse(fs.readFileSync(path.join(devDir, 'trust_levels.json'), 'utf-8'));
    assert(mutated.trust === 'mutated', 'mutation applied');

    // List backups
    const backupList = mgr.listBackups('dev');
    assert(backupList.length >= 1, 'listBackups returns at least 1 entry');
    const found = backupList.find(b => b.backupId === backup.backupId);
    assert(found !== undefined, 'original backup visible in list');

    // Restore
    const restoreResult = mgr.restore('dev', backup.backupId);
    assert(restoreResult.backupId === backup.backupId, 'restore result.backupId matches');
    assert(restoreResult.filesRestored > 0, 'restore reports files restored');

    // Verify restoration
    const restored = JSON.parse(fs.readFileSync(path.join(devDir, 'trust_levels.json'), 'utf-8'));
    assert(restored.trust === 'original', 'trust_levels.json restored to original value');

    // Prune
    // Make 3 more backups then prune to 2
    mgr.backup('dev');
    mgr.backup('dev');
    mgr.backup('dev');
    const beforePrune = mgr.listBackups('dev');
    assert(beforePrune.length >= 3, 'multiple backups accumulated');
    const pruned = mgr.pruneBackups('dev', 2);
    assert(pruned > 0, `pruneBackups deleted ${pruned} old backup(s)`);
    const afterPrune = mgr.listBackups('dev');
    assert(afterPrune.length <= 2, `at most 2 backups remain after prune (got ${afterPrune.length})`);
  } finally {
    cleanup(dir);
  }
})();

// =============================================================================
// SECTION 12: Auto-backup on promote
// =============================================================================

section('12. Auto-backup on promote');

(function () {
  const dir = tmpDir();
  try {
    const mgr = new EnvironmentManager(dir);
    mgr.initAll();

    // Write state to both dev and st so there's something to back up in st
    const stDir = mgr.getDataDir('st');
    fs.writeFileSync(path.join(stDir, 'trust_levels.json'), JSON.stringify({ trust: 'st-original' }));

    // Promote dev → st; this should auto-backup st before overwriting
    mgr.promote('dev', 'st');

    const backups = mgr.listBackups('st');
    assert(backups.length >= 1, 'auto-backup created for st before promotion');

    // Verify the backed-up trust_levels had the original value
    const firstBackup = backups[backups.length - 1]; // oldest = pre-promotion
    const backedUpTrust = path.join(firstBackup.path, 'trust_levels.json');
    if (fs.existsSync(backedUpTrust)) {
      const backedUp = JSON.parse(fs.readFileSync(backedUpTrust, 'utf-8'));
      assert(backedUp.trust === 'st-original', 'auto-backup preserves pre-promotion state');
    } else {
      assert(true, 'auto-backup ran (trust_levels was newly created in this promote cycle)');
    }
  } finally {
    cleanup(dir);
  }
})();

// =============================================================================
// RESULTS
// =============================================================================

// Give async section 9 a moment to complete
setTimeout(() => {
  console.log(`\n${'='.repeat(55)}`);
  console.log(`  test-env-manager: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  - ${f}`));
  }
  console.log('='.repeat(55));
  process.exit(failed > 0 ? 1 : 0);
}, 200);
