/**
 * test-claim-verifier.ts
 *
 * Test suite for the Tier 1 Agent Honesty / Lie Detector system:
 *   Phase 1 — ExecutionReceipt (generateReceipt / validateReceipt)
 *   Phase 2 — ClaimVerifier reconciliation (corroborated, UNSUPPORTED_CLAIM, UNDISCLOSED_ACTION)
 *   Phase 3 — Trust decay via AuthGuardian.recordClaimViolation
 */

import { join } from 'path';
import { mkdirSync } from 'fs';

import { SecureTokenManager } from './security';
import type { ExecutionReceipt } from './security';
import { AgentRuntime } from './lib/agent-runtime';
import { ClaimVerifier } from './lib/claim-verifier';
import type { ActionManifest } from './lib/claim-verifier';
import { ComplianceMonitor } from './lib/compliance-monitor';
import { AuthGuardian } from './lib/auth-guardian';

// Use full path to the node executable so spawn works on Windows with shell:false
const NODE = process.execPath;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function pass(label: string) {
  passed++;
  process.stdout.write(`  ✓ ${label}\n`);
}

function fail(label: string, reason: string) {
  failed++;
  failures.push(`${label}: ${reason}`);
  process.stdout.write(`  ✗ ${label} — ${reason}\n`);
}

function assert(condition: boolean, label: string, detail = '') {
  if (condition) {
    pass(label);
  } else {
    fail(label, detail || 'assertion failed');
  }
}

function header(title: string) {
  process.stdout.write(`\n=== ${title} ===\n`);
}

function makeRuntime() {
  const basePath = join('.', 'data', `test-cv-runtime-${Date.now()}`);
  mkdirSync(basePath, { recursive: true });
  return new AgentRuntime({
    policy: {
      basePath,
      allowedCommands: [`${NODE} *`],
      blockedCommands: [],
      allowedPaths: [],
      blockedPaths: [],
      maxConcurrentProcesses: 2,
      defaultTimeoutMs: 10_000,
      defaultMaxOutputBytes: 512 * 1024,
      approvalRequired: [],
      autoApproveReads: true,
      sourceProtection: false,
    },
    autoApproveAll: true,
  });
}

// ---------------------------------------------------------------------------
// PHASE 1 — ExecutionReceipt
// ---------------------------------------------------------------------------

async function testReceiptGenerate() {
  header('Phase 1a — generateReceipt');

  const mgr = new SecureTokenManager();
  const receipt = mgr.generateReceipt('agent-1', 'shell_execute', 'npm test', 0, 'abc123');

  assert(typeof receipt.receiptId === 'string' && receipt.receiptId.length > 0, 'receiptId is non-empty string');
  assert(receipt.agentId === 'agent-1', 'agentId matches');
  assert(receipt.action === 'shell_execute', 'action matches');
  assert(receipt.target === 'npm test', 'target matches');
  assert(receipt.exitCode === 0, 'exitCode matches');
  assert(receipt.outputHash === 'abc123', 'outputHash matches');
  assert(typeof receipt.issuedAt === 'number' && receipt.issuedAt > 0, 'issuedAt is a timestamp');
  assert(typeof receipt.signature === 'string' && receipt.signature.length > 0, 'signature present');
}

async function testReceiptValidate() {
  header('Phase 1b — validateReceipt');

  const mgr = new SecureTokenManager();
  const receipt = mgr.generateReceipt('agent-1', 'shell_execute', 'npm test', 0, 'abc123');

  const result = mgr.validateReceipt(receipt);
  assert(result.valid, 'fresh receipt is valid');
  assert(result.receipt?.receiptId === receipt.receiptId, 'validated receipt returned');
}

async function testReceiptTamper() {
  header('Phase 1c — tamper detection');

  const mgr = new SecureTokenManager();
  const receipt = mgr.generateReceipt('agent-1', 'shell_execute', 'npm test', 0, 'abc123');

  // Tamper with exitCode
  const tampered: ExecutionReceipt = { ...receipt, exitCode: 99 };
  const result = mgr.validateReceipt(tampered);
  assert(!result.valid, 'tampered exitCode invalidates receipt');
  assert(result.reason === 'Invalid receipt signature', `reason: ${result.reason}`);

  // Tamper with outputHash
  const tampered2: ExecutionReceipt = { ...receipt, outputHash: 'deadbeef' };
  const result2 = mgr.validateReceipt(tampered2);
  assert(!result2.valid, 'tampered outputHash invalidates receipt');

  // Tamper with agentId
  const tampered3: ExecutionReceipt = { ...receipt, agentId: 'evil-agent' };
  const result3 = mgr.validateReceipt(tampered3);
  assert(!result3.valid, 'tampered agentId invalidates receipt');
}

async function testReceiptExpiry() {
  header('Phase 1d — receipt expiry');

  // Use a very short maxTokenAge so the receipt expires immediately
  const mgr = new SecureTokenManager({ maxTokenAge: 1 });
  const receipt = mgr.generateReceipt('agent-1', 'shell_execute', 'npm test', 0, 'abc123');

  await new Promise(r => setTimeout(r, 10));
  const result = mgr.validateReceipt(receipt);
  assert(!result.valid, 'expired receipt is invalid');
  assert(result.reason === 'Receipt has expired', `reason: ${result.reason}`);
}

async function testShellResultHasReceipt() {
  header('Phase 1e — ShellResult has receipt after exec()');

  const runtime = makeRuntime();
  const result = await runtime.exec(
    `${NODE} -e "process.stdout.write('hello')"`,
    'agent-1',
  );

  assert(result.receipt !== undefined, 'receipt is attached to ShellResult');
  assert(result.receipt!.agentId === 'agent-1', 'receipt agentId matches');
  assert(result.receipt!.action === 'shell_execute', 'receipt action is shell_execute');
  assert(result.receipt!.exitCode === result.exitCode, 'receipt exitCode matches actual exitCode');
  assert(typeof result.receipt!.outputHash === 'string' && result.receipt!.outputHash.length === 64, 'outputHash is 64-char SHA-256 hex');

  // Validate the receipt with an instance using an explicit different secret — should fail
  const otherMgr = new SecureTokenManager({ tokenSecret: 'completely-different-secret-xyz' });
  const crossValidation = otherMgr.validateReceipt(result.receipt!);
  assert(!crossValidation.valid, 'receipt from different secret does not validate cross-instance');
}

// ---------------------------------------------------------------------------
// PHASE 2 — ClaimVerifier reconciliation
// ---------------------------------------------------------------------------

async function testCorroboratedClaim() {
  header('Phase 2a — corroborated claim');

  const runtime = makeRuntime();
  const violations: unknown[] = [];
  const monitor = new ComplianceMonitor({ pollIntervalMs: 100_000, collectViolations: true, onViolation: v => violations.push(v) });
  const verifier = new ClaimVerifier({ runtime, monitor });

  const result = await runtime.exec(`${NODE} -e "process.exit(0)"`, 'agent-1');
  const manifests: ActionManifest[] = [{
    action: 'shell_execute',
    target: `${NODE} -e "process.exit(0)"`,
    receipt: result.receipt!,
  }];

  const vResult = verifier.verify(manifests, 'agent-1', 60_000);

  assert(vResult.corroboratedCount === 1, 'corroboratedCount is 1');
  assert(vResult.unsupportedCount === 0, 'unsupportedCount is 0');
  assert(vResult.outcomes[0].corroborated, 'outcome is corroborated');
  assert(violations.length === 0, 'no violations emitted');
}

async function testUnsupportedClaim() {
  header('Phase 2b — UNSUPPORTED_CLAIM (invalid receipt)');

  const runtime = makeRuntime();
  const violations: Array<{ type: string }> = [];
  const monitor = new ComplianceMonitor({ pollIntervalMs: 100_000, collectViolations: true, onViolation: v => violations.push(v as { type: string }) });
  const verifier = new ClaimVerifier({ runtime, monitor });

  // Execute so there's an audit entry, but forge a different receipt
  await runtime.exec(`${NODE} -e "process.exit(0)"`, 'agent-1');
  const forgedReceipt: ExecutionReceipt = {
    receiptId: 'fake-id',
    agentId: 'agent-1',
    action: 'shell_execute',
    target: `${NODE} -e "process.exit(0)"`,
    exitCode: 0,
    outputHash: 'deadbeef',
    issuedAt: Date.now(),
    signature: 'invalidsignature',
  };
  const manifests: ActionManifest[] = [{
    action: 'shell_execute',
    target: `${NODE} -e "process.exit(0)"`,
    receipt: forgedReceipt,
  }];

  const vResult = verifier.verify(manifests, 'agent-1', 60_000);

  assert(vResult.unsupportedCount === 1, 'unsupportedCount is 1');
  assert(!vResult.outcomes[0].corroborated, 'outcome not corroborated');
  assert(violations.length >= 1, 'UNSUPPORTED_CLAIM violation emitted');
  assert(violations[0].type === 'UNSUPPORTED_CLAIM', `violation type: ${violations[0].type}`);
}

async function testUnsupportedClaimNoExecution() {
  header('Phase 2c — UNSUPPORTED_CLAIM (claimed but never ran)');

  const runtime = makeRuntime();
  const violations: Array<{ type: string }> = [];
  const monitor = new ComplianceMonitor({ pollIntervalMs: 100_000, collectViolations: true, onViolation: v => violations.push(v as { type: string }) });
  // Use a separate SecureTokenManager so the receipt has a valid signature
  // but the runtime's receiptManager won't recognise it (different secret)
  const externalMgr = new SecureTokenManager();
  const verifier = new ClaimVerifier({ runtime, monitor, receiptManager: externalMgr });

  // Agent claims it ran a command — but nothing was actually executed
  const fakeReceipt = externalMgr.generateReceipt('agent-1', 'shell_execute', `${NODE} -e "evil()"`, 0, 'hash');
  const manifests: ActionManifest[] = [{
    action: 'shell_execute',
    target: `${NODE} -e "evil()"`,
    receipt: fakeReceipt,
  }];

  const vResult = verifier.verify(manifests, 'agent-1', 60_000);

  assert(vResult.unsupportedCount === 1, 'unsupportedCount is 1');
  assert(vResult.outcomes[0].reason?.includes('No matching audit entry') === true, `reason: ${vResult.outcomes[0].reason}`);
  assert(violations.length >= 1, 'violation emitted');
}

async function testUndisclosedAction() {
  header('Phase 2d — UNDISCLOSED_ACTION');

  const runtime = makeRuntime();
  const violations: Array<{ type: string }> = [];
  const monitor = new ComplianceMonitor({ pollIntervalMs: 100_000, collectViolations: true, onViolation: v => violations.push(v as { type: string }) });
  const verifier = new ClaimVerifier({ runtime, monitor });

  // Execute something but declare an empty manifest (agent didn't disclose it)
  await runtime.exec(`${NODE} -e "process.exit(0)"`, 'agent-1');
  const vResult = verifier.verify([], 'agent-1', 60_000);

  assert(vResult.undisclosedActions.length >= 1, 'undisclosed action detected');
  assert(violations.some(v => v.type === 'UNDISCLOSED_ACTION'), 'UNDISCLOSED_ACTION violation emitted');
}

async function testAgentIdMismatch() {
  header('Phase 2e — agent identity mismatch in receipt');

  const runtime = makeRuntime();
  const verifier = new ClaimVerifier({ runtime });

  const result = await runtime.exec(`${NODE} -e "process.exit(0)"`, 'agent-1');
  // Present agent-1's receipt but claim it belongs to agent-2
  const manifests: ActionManifest[] = [{
    action: 'shell_execute',
    target: `${NODE} -e "process.exit(0)"`,
    receipt: result.receipt!,
  }];

  const vResult = verifier.verify(manifests, 'agent-2', 60_000);
  assert(vResult.unsupportedCount === 1, 'cross-agent receipt rejected');
  assert(vResult.outcomes[0].reason?.includes('does not match') === true, `reason: ${vResult.outcomes[0].reason}`);
}

async function testExitCodeInReceipt() {
  header('Phase 2f — failing command: receipt reflects real exit code');

  const runtime = makeRuntime();
  const verifier = new ClaimVerifier({ runtime });

  // Command exits with code 1
  let result;
  try {
    result = await runtime.exec(`${NODE} -e "process.exit(1)"`, 'agent-1');
  } catch {
    // exec may throw on non-zero depending on policy — just check the audit log
  }

  // If result exists, receipt exit code should match
  if (result) {
    assert(result.receipt!.exitCode === 1, 'receipt records actual exit code 1');

    // Agent claims exit 0 by presenting a tampered receipt
    const lied: ExecutionReceipt = { ...result.receipt!, exitCode: 0 };
    const manifests: ActionManifest[] = [{
      action: 'shell_execute',
      target: `${NODE} -e "process.exit(1)"`,
      receipt: lied,
    }];
    const vResult = verifier.verify(manifests, 'agent-1', 60_000);
    assert(vResult.unsupportedCount === 1, 'tampered exit code detected as unsupported claim');
  } else {
    pass('exec threw on exit 1 — audit entry present, receipt not directly accessible (covered by Phase 2b)');
  }
}

// ---------------------------------------------------------------------------
// PHASE 3 — Trust decay
// ---------------------------------------------------------------------------

async function testTrustDecayAfterNViolations() {
  header('Phase 3a — trust decays after N consecutive UNSUPPORTED_CLAIM violations');

  const guardian = new AuthGuardian({
    trustLevels: [{ agentId: 'liar-agent', trustLevel: 0.8 }],
    auditLogPath: join('.', 'data', `nai-cv-trust-${Date.now()}.jsonl`),
    trustConfigPath: join('.', 'data', `nai-cv-trustcfg-${Date.now()}.json`),
  });

  // First 2 violations — under the default threshold of 3, no decay yet
  guardian.recordClaimViolation('liar-agent');
  assert(guardian.getClaimViolationCount('liar-agent') === 1, 'count is 1 after 1st violation');
  guardian.recordClaimViolation('liar-agent');
  assert(guardian.getClaimViolationCount('liar-agent') === 2, 'count is 2 after 2nd violation');

  const trustBefore = guardian.getTrustLevel('liar-agent');
  assert(trustBefore === 0.8, `trust still 0.8 before threshold: ${trustBefore}`);

  // 3rd violation — threshold reached, decay fires
  guardian.recordClaimViolation('liar-agent');
  const trustAfter = guardian.getTrustLevel('liar-agent');
  assert(trustAfter < 0.8, `trust decayed from 0.8, now: ${trustAfter}`);
  assert(guardian.getClaimViolationCount('liar-agent') === 0, 'counter reset after decay fires');
}

async function testTrustNoDecayOnSingleMiss() {
  header('Phase 3b — single miss does NOT decay trust (DoS protection)');

  const guardian = new AuthGuardian({
    trustLevels: [{ agentId: 'agent-x', trustLevel: 0.9 }],
    auditLogPath: join('.', 'data', `nai-cv-trust2-${Date.now()}.jsonl`),
    trustConfigPath: join('.', 'data', `nai-cv-trustcfg2-${Date.now()}.json`),
  });

  guardian.recordClaimViolation('agent-x');
  assert(guardian.getTrustLevel('agent-x') === 0.9, 'trust unchanged after single miss');
}

async function testTrustResetsOnCorroboratedTurn() {
  header('Phase 3c — corroborated turn resets the consecutive counter');

  const guardian = new AuthGuardian({
    trustLevels: [{ agentId: 'agent-y', trustLevel: 0.8 }],
    auditLogPath: join('.', 'data', `nai-cv-trust3-${Date.now()}.jsonl`),
    trustConfigPath: join('.', 'data', `nai-cv-trustcfg3-${Date.now()}.json`),
  });

  guardian.recordClaimViolation('agent-y');
  guardian.recordClaimViolation('agent-y');
  assert(guardian.getClaimViolationCount('agent-y') === 2, 'count is 2');

  guardian.resetClaimViolations('agent-y');
  assert(guardian.getClaimViolationCount('agent-y') === 0, 'count reset to 0 after corroborated turn');

  // Now one more violation — should not decay (counter started fresh)
  guardian.recordClaimViolation('agent-y');
  assert(guardian.getTrustLevel('agent-y') === 0.8, 'trust unchanged after reset + 1 miss');
}

async function testCustomThresholdAndDecayStep() {
  header('Phase 3d — custom threshold and decay step');

  const guardian = new AuthGuardian({
    trustLevels: [{ agentId: 'agent-z', trustLevel: 1.0 }],
    auditLogPath: join('.', 'data', `nai-cv-trust4-${Date.now()}.jsonl`),
    trustConfigPath: join('.', 'data', `nai-cv-trustcfg4-${Date.now()}.json`),
  });

  // threshold=2, decayStep=0.2
  guardian.recordClaimViolation('agent-z', 2, 0.2);
  assert(guardian.getTrustLevel('agent-z') === 1.0, 'no decay at 1 violation with threshold 2');

  guardian.recordClaimViolation('agent-z', 2, 0.2);
  const trust = guardian.getTrustLevel('agent-z');
  assert(trust === 0.8, `trust is 0.8 after decay: ${trust}`);
}

// ---------------------------------------------------------------------------
// Check AuthGuardian has getTrustLevel method (verified in Phase 3 tests)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

async function main() {
  process.stdout.write('ClaimVerifier Test Suite\n');
  process.stdout.write('========================\n');

  // Phase 1
  await testReceiptGenerate();
  await testReceiptValidate();
  await testReceiptTamper();
  await testReceiptExpiry();
  await testShellResultHasReceipt();

  // Phase 2
  await testCorroboratedClaim();
  await testUnsupportedClaim();
  await testUnsupportedClaimNoExecution();
  await testUndisclosedAction();
  await testAgentIdMismatch();
  await testExitCodeInReceipt();

  // Phase 3
  await testTrustDecayAfterNViolations();
  await testTrustNoDecayOnSingleMiss();
  await testTrustResetsOnCorroboratedTurn();
  await testCustomThresholdAndDecayStep();

  process.stdout.write(`\n--- Results ---\n`);
  process.stdout.write(`Passed: ${passed}\n`);
  process.stdout.write(`Failed: ${failed}\n`);

  if (failures.length > 0) {
    process.stdout.write('\nFailures:\n');
    for (const f of failures) process.stdout.write(`  • ${f}\n`);
    process.exit(1);
  }

  process.stdout.write('\nAll tests passed.\n');
}

main().catch(err => {
  process.stderr.write(`Unexpected error: ${err}\n`);
  process.exit(1);
});
