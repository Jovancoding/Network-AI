/**
 * Test runner — executes all test suites sequentially as isolated child
 * processes. Each suite is fully cleaned up before the next one starts,
 * preventing memory accumulation that crashes VS Code's integrated terminal.
 *
 * Usage: npx ts-node run-tests.ts
 */

import { spawnSync } from 'child_process';
import { resolve } from 'path';

const SUITES = [
  'test.ts',
  'test-standalone.ts',
  'test-security.ts',
  'test-adapters.ts',
  'test-priority.ts',
  'test-phase4.ts',
  'test-phase5.ts',
  'test-phase5b.ts',
  'test-phase5c.ts',
  'test-phase5d.ts',
  'test-phase5e.ts',
  'test-phase5f.ts',
  'test-phase5g.ts',
  'test-phase6.ts',
  'test-streaming.ts',
  'test-a2a.ts',
  'test-codex.ts',
  'test-minimax.ts',
  'test-nemoclaw.ts',
  'test-cli.ts',
];

const WIDTH = 60;
const cwd = resolve(__dirname);

let totalPassed = 0;
let totalFailed = 0;
const results: { suite: string; passed: number; failed: number; ok: boolean }[] = [];

console.log('='.repeat(WIDTH));
console.log('  Network-AI Full Test Suite');
console.log('='.repeat(WIDTH));

for (const suite of SUITES) {
  process.stdout.write(`\nRunning ${suite} ... `);

  const result = spawnSync(
    process.execPath,                       // node
    ['-e', `require('ts-node/register'); require('./${suite}')`],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,          // 10 MB output buffer
      env: {
        ...process.env,
        NODE_OPTIONS: '--max-old-space-size=512',  // cap per-process RAM
      },
    }
  );

  // Count pass/fail markers — suites use either [PASS]/[FAIL], [v]/[x], or ✓/✗
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const passed = (stdout.match(/\[PASS\]|\[v\]|✓/g) ?? []).length;
  const failed  = (stdout.match(/\[FAIL\]|\[x\]|✗/g) ?? []).length;
  const ok = result.status === 0 && failed === 0;

  totalPassed += passed;
  totalFailed += failed;
  results.push({ suite, passed, failed, ok });

  if (ok) {
    console.log(`OK  (${passed} passed)`);
  } else {
    console.log(`FAIL  (${passed} passed, ${failed} failed)`);
    // Print the last 20 lines of output for quick diagnosis
    const lines = (stdout + stderr).split('\n').filter(Boolean);
    lines.slice(-20).forEach(l => console.log('   ' + l));
  }
}

console.log('\n' + '='.repeat(WIDTH));
console.log(`  Results: ${totalPassed} passed, ${totalFailed} failed`);
console.log('='.repeat(WIDTH));

const allOk = results.every(r => r.ok);
if (allOk) {
  console.log(`\nALL ${totalPassed} TESTS PASSED\n`);
} else {
  console.log('\nFAILED SUITES:');
  results.filter(r => !r.ok).forEach(r =>
    console.log(`  - ${r.suite} (${r.failed} failed)`)
  );
  process.exit(1);
}
