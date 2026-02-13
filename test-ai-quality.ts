/**
 * Quick AI Quality Gate Demo
 * 
 * Shows both layers in action:
 *   Layer 1 -- Rule-based validator (instant, deterministic)
 *   Layer 2 -- AI review callback (pluggable, async)
 *
 * Run with: npx ts-node test-ai-quality.ts
 */

import { BlackboardValidator, QualityGateAgent, AIReviewCallback } from './lib/blackboard-validator';

// --- Simulated AI reviewer (replace with real LLM call) -------------------
const mockAIReviewer: AIReviewCallback = async (key, value, entryType, context) => {
  console.log(`\n  [AI] AI Reviewer called for "${key}" (type: ${entryType})`);
  console.log(`     Source agent: ${context.sourceAgent}`);
  console.log(`     Rule score: ${context.validation.score.toFixed(2)}`);

  // Simulate AI analysis -- in production, call your LLM here:
  //   const response = await openai.chat({ messages: [{ role: 'system', content: 'Review this code/result for quality...' }, { role: 'user', content: JSON.stringify(value) }] });

  const serialized = JSON.stringify(value);
  const hasPlaceholders = /TODO|FIXME|placeholder|lorem ipsum/i.test(serialized);
  const isTooShort = serialized.length < 50;

  if (hasPlaceholders) {
    return { approved: false, confidence: 0.9, feedback: 'Contains placeholder content -- not production-ready.' };
  }
  if (isTooShort) {
    return { approved: false, confidence: 0.7, feedback: 'Response too shallow -- needs more detail.' };
  }

  return {
    approved: true,
    confidence: 0.85,
    feedback: 'Content looks substantive and well-structured.',
    suggestedFixes: entryType === 'code' ? ['Consider adding error handling'] : undefined,
  };
};

// --- Test entries ----------------------------------------------------------
const entries = [
  {
    label: '[PASS] Good result',
    key: 'result:auth-analysis',
    value: {
      summary: 'The authentication service has 3 critical vulnerabilities.',
      findings: [
        { severity: 'critical', location: 'auth/login.ts:42', issue: 'SQL injection in user lookup query' },
        { severity: 'high', location: 'auth/session.ts:18', issue: 'Session token not rotated after privilege change' },
        { severity: 'critical', location: 'auth/password.ts:7', issue: 'Passwords stored as MD5 hashes' },
      ],
      recommendation: 'Immediate patching required before deployment.',
    },
    agent: 'security-auditor',
  },
  {
    label: '[WARN] Borderline result (shallow)',
    key: 'result:perf-check',
    value: { status: 'ok', note: 'Looks fine' },
    agent: 'lazy-agent',
  },
  {
    label: '[FAIL] Hallucinated result',
    key: 'result:research',
    value: {
      source: 'https://www.example-fake-api.com/v99/data',
      citation: 'According to arXiv:9999.99999, quantum AI solves all problems.',
      isbn: 'ISBN 000-0-00-000000-0',
      data: 'The metric is exactly 3.14159265358979323846264338327950288419716939937510582097494459230781640628620899',
    },
    agent: 'hallucinator',
  },
  {
    label: '[FAIL] Dangerous code',
    key: 'code:exploit',
    value: {
      language: 'javascript',
      code: `const userInput = req.body.cmd;\neval(userInput);\nrequire('child_process').execSync('rm -rf /');`,
    },
    agent: 'rogue-coder',
  },
  {
    label: '[PASS] Good code',
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
    agent: 'code-writer',
  },
  {
    label: '[FAIL] Placeholder task',
    key: 'task:stub',
    value: { instruction: 'Do stuff' },
    agent: 'vague-requester',
  },
];

// --- Run -------------------------------------------------------------------
async function main() {
  console.log('\n+======================================================+');
  console.log('|   [TEST]  AI Quality Gate -- Quick Test                |');
  console.log('+======================================================+\n');

  const gate = new QualityGateAgent({
    qualityThreshold: 0.8,       // high bar -- pushes borderline items to AI review
    aiReviewCallback: mockAIReviewer,
  });

  for (const { label, key, value, agent } of entries) {
    console.log(`\n--- ${label} ---`);
    const result = await gate.gate(key, value, agent);
    const icon = result.decision === 'approve' ? '[PASS]' : result.decision === 'reject' ? '[FAIL]' : '[HOLD]';
    console.log(`  ${icon}  Decision: ${result.decision.toUpperCase()}`);
    console.log(`     Score: ${result.validation.score.toFixed(2)}`);
    if (result.validation.issues.length > 0) {
      console.log(`     Issues:`);
      for (const issue of result.validation.issues) {
        const sev = issue.severity === 'error' ? '[!]' : issue.severity === 'warning' ? '[~]' : '[.]';
        console.log(`       ${sev} [${issue.rule}] ${issue.message}`);
      }
    }
    if (result.reviewNotes && result.reviewNotes.length > 0) {
      console.log(`     Gate notes:`);
      for (const note of result.reviewNotes) {
        console.log(`       -> ${note}`);
      }
    }
  }

  // Summary
  const metrics = gate.getMetrics();
  const quarantined = gate.getQuarantined();

  console.log('\n======================================================');
  console.log('[#]  Metrics');
  console.log(`   Checked: ${metrics.totalChecked}  |  Approved: ${metrics.approved}  |  Rejected: ${metrics.rejected}  |  Quarantined: ${metrics.quarantined}  |  AI Reviewed: ${metrics.aiReviewed}`);
  
  if (quarantined.length > 0) {
    console.log(`\n[HOLD]  Quarantined entries (${quarantined.length}):`);
    for (const q of quarantined) {
      console.log(`   * ${q.quarantineId} -- key: ${q.key}, by: ${q.submittedBy}`);
    }
  }
  console.log('');
}

main().catch(console.error);
