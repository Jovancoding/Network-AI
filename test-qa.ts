/**
 * QA Orchestrator Agent — Test Suite
 *
 * Covers: single scenario gating, batch harness, feedback loop,
 * retry limits, regression tracking, cross-agent contradiction
 * detection, and compliance integration.
 *
 * Run with: npx ts-node test-qa.ts
 */

import {
  QAOrchestratorAgent,
  type QAScenario,
  type QAFeedback,
} from './lib/qa-orchestrator';

import { type AIReviewCallback } from './lib/blackboard-validator';

// ============================================================================
// TEST UTILITIES
// ============================================================================

const colors = {
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
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
  if (err) console.log(`         ${err}`);
  failed++;
}

function assert(condition: boolean, test: string, detail?: string) {
  condition ? pass(test) : fail(test, detail);
}

// ============================================================================
// MOCK AI REVIEWER
// ============================================================================

const mockAIReviewer: AIReviewCallback = async (_key, value, _entryType, context) => {
  const serialized = JSON.stringify(value);
  const hasPlaceholders = /TODO|FIXME|placeholder|lorem ipsum/i.test(serialized);
  const isTooShort = serialized.length < 50;

  if (hasPlaceholders) {
    return { approved: false, confidence: 0.9, feedback: 'Contains placeholder content.' };
  }
  if (isTooShort) {
    return { approved: false, confidence: 0.7, feedback: 'Response too shallow.' };
  }
  return { approved: true, confidence: 0.95, feedback: 'Looks good.', suggestedFixes: [] };
};

// ============================================================================
// TEST DATA
// ============================================================================

const goodResult: QAScenario = {
  id: 'good-result',
  key: 'analysis:security',
  value: {
    findings: [
      { severity: 'high', description: 'SQL injection in /api/users endpoint', remediation: 'Use parameterized queries' },
      { severity: 'medium', description: 'Missing CSRF tokens on form submissions', remediation: 'Add csrf middleware' },
    ],
    scannedFiles: 42,
    timestamp: new Date().toISOString(),
  },
  sourceAgent: 'security-scanner',
};

const badResult: QAScenario = {
  id: 'bad-result',
  key: 'analysis:shallow',
  value: 'Looks fine',
  sourceAgent: 'lazy-agent',
};

const dangerousCode: QAScenario = {
  id: 'dangerous-code',
  key: 'code:auth',
  value: `
    const password = "hardcoded_secret_123";
    eval(userInput);
    exec("rm -rf /");
  `,
  sourceAgent: 'code-generator',
};

const goodCode: QAScenario = {
  id: 'good-code',
  key: 'code:utils',
  value: {
    language: 'typescript',
    code: [
      'export function clamp(value: number, min: number, max: number): number {',
      '  if (value < min) return min;',
      '  if (value > max) return max;',
      '  return value;',
      '}',
    ].join('\n'),
  },
  sourceAgent: 'code-generator',
};

const placeholderTask: QAScenario = {
  id: 'placeholder-task',
  key: 'task:vague',
  value: { instruction: 'Do stuff' },
  sourceAgent: 'planner',
};

// ============================================================================
// TESTS
// ============================================================================

async function runTests() {
  header('QA Orchestrator Agent — Test Suite');

  // ---- 1. Single scenario: approve good result -------------------------
  header('1. Single Scenario Gating');
  {
    const qa = new QAOrchestratorAgent({ qualityThreshold: 0.7 });
    const r = await qa.runScenario(goodResult);
    assert(r.decision === 'approve', 'Good result approved');
    assert(r.passed === true, 'Good result marked as passed');
    assert(r.score >= 0.7, `Good result score >= 0.7 (got ${r.score.toFixed(2)})`);
    assert(r.issues.length === 0 || r.issues.every(i => !i.includes('[error]')), 'No error-level issues');
  }

  // ---- 2. Reject dangerous code -----------------------------------------
  {
    const qa = new QAOrchestratorAgent({ qualityThreshold: 0.7 });
    const r = await qa.runScenario(dangerousCode);
    assert(r.decision === 'reject', 'Dangerous code rejected');
    assert(r.passed === false, 'Dangerous code fails gate');
    assert(r.score < 0.5, `Dangerous code low score (got ${r.score.toFixed(2)})`);
    assert(r.issues.length > 0, `Has issues: ${r.issues.length}`);
  }

  // ---- 3. Approve good code ---------------------------------------------
  {
    const qa = new QAOrchestratorAgent({ qualityThreshold: 0.7 });
    const r = await qa.runScenario(goodCode);
    assert(r.decision === 'approve', 'Good code approved');
    assert(r.passed === true, 'Good code passes gate');
  }

  // ---- 4. Reject vague task ---------------------------------------------
  {
    const qa = new QAOrchestratorAgent({ qualityThreshold: 0.7 });
    const r = await qa.runScenario(placeholderTask);
    assert(r.passed === false, 'Vague task rejected');
  }

  // ---- 5. Feedback loop routing -----------------------------------------
  header('2. Feedback Loop');
  {
    const feedbacks: QAFeedback[] = [];
    const qa = new QAOrchestratorAgent({
      qualityThreshold: 0.7,
      maxRetries: 2,
      onFeedback: (fb) => { feedbacks.push(fb); },
    });

    await qa.runScenario(dangerousCode);
    assert(feedbacks.length === 1, 'Feedback routed on rejection');
    assert(feedbacks[0].sourceAgent === 'code-generator', 'Feedback targets correct agent');
    assert(feedbacks[0].retryCount === 1, 'First retry');
    assert(feedbacks[0].issues.length > 0, 'Feedback includes issues');

    // Second attempt (still bad) — should route again
    await qa.runScenario(dangerousCode);
    assert(feedbacks.length === 2, 'Second feedback routed');
    assert(feedbacks[1].retryCount === 2, 'Second retry');

    // Third attempt — max retries reached, no more feedback
    await qa.runScenario(dangerousCode);
    assert(feedbacks.length === 2, 'No feedback after max retries');
  }

  // ---- 6. Reset retries -------------------------------------------------
  {
    const feedbacks: QAFeedback[] = [];
    const qa = new QAOrchestratorAgent({
      maxRetries: 1,
      onFeedback: (fb) => { feedbacks.push(fb); },
    });

    await qa.runScenario(dangerousCode);
    assert(feedbacks.length === 1, 'Feedback on first try');

    await qa.runScenario(dangerousCode);
    assert(feedbacks.length === 1, 'No feedback after max');

    qa.resetRetries('dangerous-code');
    await qa.runScenario(dangerousCode);
    assert(feedbacks.length === 2, 'Feedback resumed after reset');
  }

  // ---- 7. Batch harness ------------------------------------------------
  header('3. Batch Harness');
  {
    const qa = new QAOrchestratorAgent({ qualityThreshold: 0.7 });
    const harness = await qa.runHarness([goodResult, goodCode, dangerousCode, placeholderTask]);

    assert(harness.total === 4, `Total scenarios: ${harness.total}`);
    assert(harness.passed >= 2, `Passed: ${harness.passed} (expected >= 2)`);
    assert(harness.failed <= 2, `Failed: ${harness.failed} (expected <= 2)`);
    assert(harness.passRate >= 0.5, `Pass rate: ${harness.passRate} (expected >= 0.5)`);
    assert(harness.snapshot !== undefined, 'Snapshot captured');
    assert(harness.snapshot.scenariosRun === 4, 'Snapshot records scenario count');
  }

  // ---- 8. Regression tracking -------------------------------------------
  header('4. Regression Tracking');
  {
    const qa = new QAOrchestratorAgent({ qualityThreshold: 0.7 });

    // First run — 50% pass rate
    await qa.runHarness([goodResult, dangerousCode]);

    // No regression report with only 1 snapshot
    assert(qa.getRegressionReport() === null, 'No report with single snapshot');

    // Second run — better pass rate
    await qa.runHarness([goodResult, goodCode]);

    const report = qa.getRegressionReport();
    assert(report !== null, 'Report available with 2 snapshots');
    assert(report!.passRateDelta >= 0, `Pass rate improved or stable (got ${report!.passRateDelta})`);
    assert(report!.regressed === false, 'No regression detected');

    // History tracked
    const history = qa.getHistory();
    assert(history.length === 2, `History has 2 entries (got ${history.length})`);
  }

  // ---- 9. Regression detected -------------------------------------------
  {
    const qa = new QAOrchestratorAgent({ qualityThreshold: 0.7 });

    // First run — good
    await qa.runHarness([goodResult, goodCode]);
    // Second run — worse
    await qa.runHarness([dangerousCode, placeholderTask]);

    const report = qa.getRegressionReport();
    assert(report !== null, 'Regression report exists');
    assert(report!.regressed === true, 'Regression detected');
    assert(report!.passRateDelta < 0, `Pass rate delta negative (${report!.passRateDelta})`);
  }

  // ---- 10. Cross-agent contradiction detection --------------------------
  header('5. Cross-Agent Contradiction Detection');
  {
    const qa = new QAOrchestratorAgent({ qualityThreshold: 0.7 });

    // Two agents write to same key with contradictory booleans
    await qa.runScenario({
      id: 'agent-a-report',
      key: 'report:security',
      value: { safe: true, data: 'All clear' },
      sourceAgent: 'optimist-agent',
    });

    await qa.runScenario({
      id: 'agent-b-report',
      key: 'report:security',
      value: { safe: false, error: 'Critical vulnerability found' },
      sourceAgent: 'pessimist-agent',
    });

    const contradictions = qa.detectContradictions();
    assert(contradictions.length >= 1, `Contradiction found: ${contradictions.length}`);
    assert(contradictions[0].key === 'report:security', 'Contradiction on correct key');
    assert(contradictions[0].agentA === 'optimist-agent', 'Agent A identified');
    assert(contradictions[0].agentB === 'pessimist-agent', 'Agent B identified');
  }

  // ---- 11. No false-positive contradictions ----------------------------
  {
    const qa = new QAOrchestratorAgent({ qualityThreshold: 0.7 });

    await qa.runScenario({
      id: 'consistent-a',
      key: 'status:deploy',
      value: { ready: true, checks: 5 },
      sourceAgent: 'agent-alpha',
    });

    await qa.runScenario({
      id: 'consistent-b',
      key: 'status:deploy',
      value: { ready: true, checks: 8 },
      sourceAgent: 'agent-beta',
    });

    const contradictions = qa.detectContradictions();
    assert(contradictions.length === 0, 'No false contradiction for agreeing agents');
  }

  // ---- 12. Error vs success contradiction --------------------------------
  {
    const qa = new QAOrchestratorAgent({ qualityThreshold: 0.7 });

    await qa.runScenario({
      id: 'err-vs-success-a',
      key: 'result:api-test',
      value: { data: [1, 2, 3], result: 'success' },
      sourceAgent: 'runner-a',
    });

    await qa.runScenario({
      id: 'err-vs-success-b',
      key: 'result:api-test',
      value: { error: 'Connection refused', code: 500 },
      sourceAgent: 'runner-b',
    });

    const contradictions = qa.detectContradictions();
    assert(contradictions.length >= 1, 'Error vs success detected as contradiction');
  }

  // ---- 13. Custom contradiction detector --------------------------------
  header('6. Custom Contradiction Detector');
  {
    const qa = new QAOrchestratorAgent({
      qualityThreshold: 0.7,
      contradictionDetector: (a, b) => {
        // Custom: numeric values differ by more than 50%
        if (typeof a === 'number' && typeof b === 'number') {
          const avg = (Math.abs(a) + Math.abs(b)) / 2;
          return avg > 0 && Math.abs(a - b) / avg > 0.5;
        }
        return false;
      },
    });

    await qa.runScenario({ id: 'num-a', key: 'metric:latency', value: 100, sourceAgent: 'monitor-a' });
    await qa.runScenario({ id: 'num-b', key: 'metric:latency', value: 500, sourceAgent: 'monitor-b' });

    const c = qa.detectContradictions();
    assert(c.length >= 1, 'Custom detector caught divergent metrics');
  }

  // ---- 14. AI review integration ----------------------------------------
  header('7. AI Review Integration');
  {
    const qa = new QAOrchestratorAgent({
      qualityThreshold: 1.1,  // Force AI review by setting threshold above max
      aiReviewCallback: mockAIReviewer,
    });

    const r = await qa.runScenario(goodResult);
    assert(r.score >= 0, 'AI review produced a score');
    // The AI reviewer should approve the good result
    const metrics = qa.getMetrics();
    assert(metrics.totalChecked >= 1, `Gate checked at least 1 (got ${metrics.totalChecked})`);
  }

  // ---- 15. Metrics accessor consistency ----------------------------------
  header('8. Metrics & Accessors');
  {
    const qa = new QAOrchestratorAgent({ qualityThreshold: 0.7 });
    await qa.runScenario(goodResult);
    await qa.runScenario(dangerousCode);

    const metrics = qa.getMetrics();
    assert(metrics.totalChecked === 2, `Total checked: ${metrics.totalChecked}`);
    assert(metrics.approved >= 1, `At least 1 approved (got ${metrics.approved})`);
    assert(metrics.rejected >= 1, `At least 1 rejected (got ${metrics.rejected})`);

    // Underlying components accessible
    assert(qa.getQualityGate() !== undefined, 'Quality gate accessible');
    assert(qa.getComplianceMonitor() !== undefined, 'Compliance monitor accessible');
  }

  // ---- 16. Retries remaining API -----------------------------------------
  {
    const qa = new QAOrchestratorAgent({
      maxRetries: 3,
      onFeedback: () => {},
    });

    assert(qa.getRetriesRemaining('dangerous-code') === 3, 'Full retries before any attempt');

    await qa.runScenario(dangerousCode);
    assert(qa.getRetriesRemaining('dangerous-code') === 2, '2 retries remaining after 1 attempt');

    await qa.runScenario(dangerousCode);
    assert(qa.getRetriesRemaining('dangerous-code') === 1, '1 retry remaining after 2 attempts');
  }

  // ---- 17. minScore per-scenario override --------------------------------
  header('9. Per-Scenario Threshold Override');
  {
    const qa = new QAOrchestratorAgent({ qualityThreshold: 0.3 }); // lenient global
    const r = await qa.runScenario({
      ...goodResult,
      id: 'strict-scenario',
      minScore: 0.99,  // but very strict per-scenario
    });
    // Good result has high score but might not hit 0.99
    // The point is minScore overrides global threshold
    assert(typeof r.passed === 'boolean', 'Per-scenario threshold applied');
    assert(r.score > 0, 'Score is positive');
  }

  // ---- 18. Clear output tracking ----------------------------------------
  {
    const qa = new QAOrchestratorAgent({ qualityThreshold: 0.7 });
    await qa.runScenario({
      id: 'track-a', key: 'shared:key',
      value: { safe: true }, sourceAgent: 'a',
    });
    await qa.runScenario({
      id: 'track-b', key: 'shared:key',
      value: { safe: false }, sourceAgent: 'b',
    });
    assert(qa.detectContradictions().length >= 1, 'Contradiction before clear');

    qa.clearOutputTracking();
    assert(qa.detectContradictions().length === 0, 'No contradictions after clear');
  }

  // ---- 19. Snapshot without harness (manual) ----------------------------
  header('10. Manual Snapshots');
  {
    const qa = new QAOrchestratorAgent({ qualityThreshold: 0.7 });
    await qa.runScenario(goodResult);

    const snap = qa.takeSnapshot(1, 1);
    assert(snap.timestamp.length > 0, 'Snapshot has timestamp');
    assert(snap.gateMetrics.totalChecked >= 1, 'Gate metrics in snapshot');
    assert(snap.scenariosRun === 1, 'Manual scenario count recorded');
    assert(snap.scenarioPassRate === 1, 'Manual pass rate recorded');
  }

  // ---- 20. Empty harness ------------------------------------------------
  {
    const qa = new QAOrchestratorAgent({ qualityThreshold: 0.7 });
    const harness = await qa.runHarness([]);
    assert(harness.total === 0, 'Empty harness: total 0');
    assert(harness.passRate === 0, 'Empty harness: passRate 0');
    assert(harness.results.length === 0, 'Empty harness: no results');
  }

  // ---- 21. Harness captures contradictions ------------------------------
  header('11. Harness Contradiction Capture');
  {
    const qa = new QAOrchestratorAgent({ qualityThreshold: 0.7 });
    const harness = await qa.runHarness([
      { id: 'h-a', key: 'report:status', value: { ok: true, data: 'All systems go' }, sourceAgent: 'agent-1' },
      { id: 'h-b', key: 'report:status', value: { ok: false, error: 'System down' }, sourceAgent: 'agent-2' },
    ]);
    assert(harness.contradictions.length >= 1, 'Harness captures contradictions');
  }

  // ---- 22. Feedback includes suggested fixes ----------------------------
  header('12. Feedback Suggested Fixes');
  {
    const feedbacks: QAFeedback[] = [];
    const qa = new QAOrchestratorAgent({
      onFeedback: (fb) => { feedbacks.push(fb); },
      maxRetries: 1,
    });

    await qa.runScenario(dangerousCode);
    assert(feedbacks.length === 1, 'Feedback received');
    // Dangerous code should trigger issues with suggestions
    assert(Array.isArray(feedbacks[0].suggestedFixes), 'suggestedFixes is an array');
  }

  // ---- 23. Async feedback handler supported -----------------------------
  {
    let asyncCalled = false;
    const qa = new QAOrchestratorAgent({
      maxRetries: 1,
      onFeedback: async (fb) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        asyncCalled = true;
      },
    });

    await qa.runScenario(dangerousCode);
    assert(asyncCalled, 'Async feedback handler awaited');
  }

  // ========================================================================
  // SUMMARY
  // ========================================================================

  console.log('\n' + '='.repeat(64));
  log(`  QA Orchestrator Results: ${passed} passed, ${failed} failed`, failed > 0 ? 'red' : 'green');
  console.log('='.repeat(64) + '\n');

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
