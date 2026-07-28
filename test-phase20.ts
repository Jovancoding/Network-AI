/**
 * test-phase20.ts
 *
 * v5.15.1 — Security advisory regression tests:
 *
 *   GHSA-743h-jr5x-mpcr — ClaudeHookBridge deny-pattern gate bypass via
 *     500-char extractTarget truncation before the security decision.
 *     Fix: deny/allow pattern matching now runs against the FULL,
 *     untruncated target; oversized targets (> maxTargetLength) are denied
 *     outright instead of matched. Truncation is applied only afterward,
 *     for audit-log/display purposes.
 *
 *   GHSA-9v4f-j8cv-fhxw — SandboxPolicy blocklist/approval-gate bypass via
 *     quote/whitespace mismatch between the raw-string glob matchers and the
 *     quote-stripping, whitespace-collapsing tokenized executor.
 *     Fix: isCommandAllowed/requiresApproval/assessRisk all match against a
 *     canonicalized form (parseCommandLine → argv.join(' ')) — the exact
 *     representation the executor runs — instead of the raw string.
 *
 * Both PoCs from the published advisories are reproduced verbatim below and
 * asserted to now behave safely.
 */

import { ClaudeHookBridge } from './lib/claude-hooks';
import type { ClaudeHookInput } from './lib/claude-hooks';
import { SandboxPolicy } from './lib/agent-runtime';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];
function pass(label: string) { passed++; process.stdout.write(`  ✓ ${label}\n`); }
function fail(label: string, reason: string) { failed++; failures.push(`${label}: ${reason}`); process.stdout.write(`  ✗ ${label} — ${reason}\n`); }
function assert(cond: boolean, label: string, detail = '') { if (cond) pass(label); else fail(label, detail || 'assertion failed'); }
function header(t: string) { process.stdout.write(`\n=== ${t} ===\n`); }

function preToolUse(toolName: string, toolInput: Record<string, unknown>): ClaudeHookInput {
  return { session_id: 's1', hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput };
}

// ---------------------------------------------------------------------------
// GHSA-743h-jr5x-mpcr — ClaudeHookBridge truncation-before-decision bypass
// ---------------------------------------------------------------------------

async function testGhsa743hExactPoc() {
  header('GHSA-743h-jr5x-mpcr — published PoC reproduction');

  const bridge = new ClaudeHookBridge({
    mode: 'observe',
    denyPatterns: ['rm\\s+-rf', 'sudo\\s', 'curl.*\\|\\s*sh'],
  });
  const cmd = ':'.repeat(505) + ' ; rm -rf /'; // 516 bytes — dangerous part past byte 500
  const out = await bridge.handlePreToolUse(preToolUse('Bash', { command: cmd }));

  assert(out.hookSpecificOutput.permissionDecision === 'deny',
    'PoC command (516 bytes, danger past byte 500) is now denied, not allowed',
    out.hookSpecificOutput.permissionDecision);
  assert(/Blocked by Network-AI deny pattern/.test(out.hookSpecificOutput.permissionDecisionReason),
    'Denial reason cites the deny pattern (matched on full command, not truncated preview)');
}

async function testGhsa743hBaselineStillCaught() {
  header('GHSA-743h-jr5x-mpcr — baseline (short dangerous command) still caught');

  const bridge = new ClaudeHookBridge({ mode: 'observe', denyPatterns: ['rm\\s+-rf'] });
  const out = await bridge.handlePreToolUse(preToolUse('Bash', { command: 'rm -rf /tmp/x' }));
  assert(out.hookSpecificOutput.permissionDecision === 'deny', 'short dangerous command denied (regression check)');
}

async function testGhsa743hMatchingUsesFullTarget() {
  header('GHSA-743h-jr5x-mpcr — deny/allow matching sees content beyond 500 chars');

  // Deny pattern that only matches content well past the old 500-char cutoff.
  const marker = 'DANGEROUS_MARKER_AT_TAIL';
  const bridge = new ClaudeHookBridge({ mode: 'observe', denyPatterns: [marker] });
  const padded = 'a'.repeat(600) + ' ' + marker;
  const out = await bridge.handlePreToolUse(preToolUse('Bash', { command: padded }));
  assert(out.hookSpecificOutput.permissionDecision === 'deny',
    'deny pattern matches content located past the 500-char display-truncation point');

  // Same content, but the marker sits inside the first 500 chars — must also deny.
  const bridge2 = new ClaudeHookBridge({ mode: 'observe', denyPatterns: [marker] });
  const out2 = await bridge2.handlePreToolUse(preToolUse('Bash', { command: `${marker} ${'b'.repeat(600)}` }));
  assert(out2.hookSpecificOutput.permissionDecision === 'deny', 'deny pattern still matches content within the first 500 chars');
}

async function testGhsa743hOversizedTargetFailsClosed() {
  header('GHSA-743h-jr5x-mpcr — oversized target denied outright (fail closed)');

  const bridge = new ClaudeHookBridge({ mode: 'observe', maxTargetLength: 1000 });
  const huge = 'x'.repeat(2000);
  const out = await bridge.handlePreToolUse(preToolUse('Bash', { command: huge }));
  assert(out.hookSpecificOutput.permissionDecision === 'deny', 'target exceeding maxTargetLength is denied, not matched');
  assert(/maxTargetLength/.test(out.hookSpecificOutput.permissionDecisionReason), 'reason cites maxTargetLength');

  // enforce mode: oversized target uses blockedDecision instead of a hard deny
  const enforceBridge = new ClaudeHookBridge({ mode: 'enforce', maxTargetLength: 1000, blockedDecision: 'ask' });
  const outEnforce = await enforceBridge.handlePreToolUse(preToolUse('Bash', { command: huge }));
  assert(outEnforce.hookSpecificOutput.permissionDecision === 'ask',
    'enforce mode routes oversized targets through blockedDecision', outEnforce.hookSpecificOutput.permissionDecision);

  // Under the cap — normal matching resumes (no false-positive deny).
  const underCap = await bridge.handlePreToolUse(preToolUse('Bash', { command: 'echo hello' }));
  assert(underCap.hookSpecificOutput.permissionDecision === 'allow', 'commands under maxTargetLength are evaluated normally');
}

async function testGhsa743hAuditStillTruncatesForDisplay() {
  header('GHSA-743h-jr5x-mpcr — audit log still stores a bounded preview');

  const seen: Array<{ target: string }> = [];
  const bridge = new ClaudeHookBridge({
    mode: 'observe',
    onAudit: (e) => seen.push({ target: e.target }),
  });
  const long = 'y'.repeat(1000);
  await bridge.handlePreToolUse(preToolUse('Bash', { command: long }));
  assert(seen[0]!.target.length < 1000, 'audit entry target is truncated for storage/display, not the full 1000 chars',
    String(seen[0]!.target.length));
  assert(/\[\+\d+ more chars\]/.test(seen[0]!.target), 'truncated display target notes how many characters were omitted');
}

async function testGhsa743hAllowPatternsUseFullTarget() {
  header('GHSA-743h-jr5x-mpcr — allow patterns also match against the full target');

  const marker = 'ALLOWED_TAIL_MARKER';
  const bridge = new ClaudeHookBridge({ mode: 'observe', allowPatterns: [marker], denyPatterns: ['.*'] });
  const cmd = 'z'.repeat(600) + ' ' + marker;
  const out = await bridge.handlePreToolUse(preToolUse('Bash', { command: cmd }));
  // denyPatterns ['.*'] matches everything, so this also exercises deny-before-allow
  // ordering; the important regression check is that allow-pattern matching itself
  // is never silently limited to the first 500 chars.
  assert(out.hookSpecificOutput.permissionDecision === 'deny', 'deny still takes precedence (unchanged ordering)');

  const bridgeAllowOnly = new ClaudeHookBridge({ mode: 'observe', allowPatterns: [marker] });
  const out2 = await bridgeAllowOnly.handlePreToolUse(preToolUse('Bash', { command: cmd }));
  assert(out2.hookSpecificOutput.permissionDecision === 'allow', 'allow pattern matches marker beyond byte 500');
}

// ---------------------------------------------------------------------------
// GHSA-9v4f-j8cv-fhxw — SandboxPolicy quote/whitespace matcher bypass
// ---------------------------------------------------------------------------

function testGhsa9v4fBlocklistBypassPoc() {
  header('GHSA-9v4f-j8cv-fhxw — Chain A: blocklist bypass PoC (published)');

  const policy = new SandboxPolicy({ basePath: '/tmp', allowedCommands: ['rm *'], blockedCommands: ['rm -rf /'] });

  assert(policy.isCommandAllowed('rm -rf /') === false, 'unquoted destructive command still blocked (baseline)');
  assert(policy.isCommandAllowed("rm -rf '/'") === false,
    'quoted destructive command is now ALSO blocked (was: bypassed the blocklist)');
  // The executor tokenizes identically either way — confirms matcher/executor now agree.
  const argvQuoted = policy.tokenizeCommand("rm -rf '/'");
  assert(JSON.stringify(argvQuoted) === JSON.stringify(['rm', '-rf', '/']), 'executor argv unchanged by the fix');
}

function testGhsa9v4fApprovalBypassPoc() {
  header('GHSA-9v4f-j8cv-fhxw — Chain B: approval-gate bypass PoC (published)');

  const policy = new SandboxPolicy({ basePath: '/tmp', allowedCommands: ['git *'], approvalRequired: ['git push*'] });

  assert(policy.requiresApproval('git push origin main') === true, 'unquoted git push still requires approval (baseline)');
  assert(policy.requiresApproval('git "push" origin main') === true,
    'quoted git push now ALSO requires approval (was: bypassed the approval gate)');
  assert(policy.isCommandAllowed('git "push" origin main') === true, 'quoted command remains allowed by the allowlist');
  const argv = policy.tokenizeCommand('git "push" origin main');
  assert(JSON.stringify(argv) === JSON.stringify(['git', 'push', 'origin', 'main']), 'executor argv is the pushed command either way');
}

function testGhsa9v4fRiskAssessmentUsesCanonicalForm() {
  header('GHSA-9v4f-j8cv-fhxw — assessRisk uses the canonical (post-tokenize) form');

  const policy = new SandboxPolicy({ basePath: '/tmp' });
  assert(policy.assessRisk('git push origin main') === 'high', 'unquoted git push assessed high risk (baseline)');
  assert(policy.assessRisk('git "push" origin main') === 'high',
    'quoted git push now ALSO assessed high risk (was: fell through to a lower bucket)');
  assert(policy.assessRisk('rm -rf /') === 'high', 'unquoted rm assessed high risk (baseline)');
  assert(policy.assessRisk("rm -rf '/'") === 'high', 'quoted rm now ALSO assessed high risk');
}

function testGhsa9v4fWhitespaceVariantAlsoClosed() {
  header('GHSA-9v4f-j8cv-fhxw — irregular whitespace no longer evades matching either');

  const policy = new SandboxPolicy({ basePath: '/tmp', allowedCommands: ['git *'], approvalRequired: ['git push*'] });
  // Double space between tokens — raw-string glob previously required exact
  // single-space spacing, so this could also slip past the approval gate.
  assert(policy.requiresApproval('git  push origin main') === true,
    'double-spaced git push still requires approval (whitespace collapsed before matching)');
}

function testGhsa9v4fFailClosedOnUnparseableInput() {
  header('GHSA-9v4f-j8cv-fhxw — requiresApproval/assessRisk fail closed on unparseable input');

  const policy = new SandboxPolicy({ basePath: '/tmp' });
  // Unquoted metacharacter — cannot be canonicalized/tokenized at all.
  assert(policy.requiresApproval('echo hi; rm -rf /') === true,
    'unparseable command (unquoted metacharacter) requires approval by default (fail closed)');
  assert(policy.assessRisk('echo hi; rm -rf /') === 'high',
    'unparseable command assessed as high risk by default (fail closed)');
  assert(policy.isCommandAllowed('echo hi; rm -rf /') === false, 'unparseable command remains rejected outright (unchanged)');
}

function testGhsa9v4fNormalCommandsUnaffected() {
  header('GHSA-9v4f-j8cv-fhxw — ordinary single-spaced, unquoted commands are unaffected');

  const policy = new SandboxPolicy({
    basePath: '/tmp',
    allowedCommands: ['npm *', 'git *'],
    blockedCommands: ['rm -rf /'],
    approvalRequired: ['git push*'],
  });
  assert(policy.isCommandAllowed('npm test') === true, 'plain allowed command still allowed');
  assert(policy.isCommandAllowed('npm publish') === true, 'another plain allowed command still allowed');
  assert(policy.requiresApproval('npm test') === false, 'plain non-sensitive command does not require approval');
  assert(policy.requiresApproval('git status') === false, 'plain non-matching git command does not require approval');
  assert(policy.assessRisk('npm test') === 'medium', 'plain npm command still assessed medium risk');
  assert(policy.assessRisk('echo hello') === 'low', 'plain benign command still assessed low risk');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  process.stdout.write('\nPhase 20 — Security advisory regressions (GHSA-743h-jr5x-mpcr, GHSA-9v4f-j8cv-fhxw)\n');

  await testGhsa743hExactPoc();
  await testGhsa743hBaselineStillCaught();
  await testGhsa743hMatchingUsesFullTarget();
  await testGhsa743hOversizedTargetFailsClosed();
  await testGhsa743hAuditStillTruncatesForDisplay();
  await testGhsa743hAllowPatternsUseFullTarget();

  testGhsa9v4fBlocklistBypassPoc();
  testGhsa9v4fApprovalBypassPoc();
  testGhsa9v4fRiskAssessmentUsesCanonicalForm();
  testGhsa9v4fWhitespaceVariantAlsoClosed();
  testGhsa9v4fFailClosedOnUnparseableInput();
  testGhsa9v4fNormalCommandsUnaffected();

  process.stdout.write(`\n${passed + failed} checks — ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.stdout.write(failures.map((f) => `  FAIL: ${f}`).join('\n') + '\n');
    process.exit(1);
  }
  process.stdout.write('ALL PHASE 20 TESTS PASSED ✓\n');
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
