/**
 * 01-hello-swarm.ts
 * ─────────────────
 * The simplest possible network-ai demo: three agents (Researcher, Analyst,
 * Reporter) passing work through a shared blackboard.
 *
 * No API key needed — all agents are plain async functions.
 *
 * Run:
 *   npx ts-node examples/01-hello-swarm.ts
 */

import {
  createSwarmOrchestrator,
  CustomAdapter,
  SharedBlackboard,
} from '..';

// ─── ANSI helpers for readable terminal output ────────────────────────────────
const c = {
  reset : '\x1b[0m',
  bold  : '\x1b[1m',
  cyan  : '\x1b[36m',
  green : '\x1b[32m',
  yellow: '\x1b[33m',
  blue  : '\x1b[34m',
  magenta: '\x1b[35m',
  dim   : '\x1b[2m',
};
const banner  = (msg: string) => console.log(`\n${c.bold}${c.cyan}---  ${msg}  ---${c.reset}`);
const step    = (agent: string, msg: string) => console.log(`  ${c.green}[${agent}]${c.reset} ${msg}`);
const info    = (msg: string) => console.log(`  ${c.dim}${msg}${c.reset}`);

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  banner('network-ai - Hello Swarm');

  // 1. Shared blackboard — the agents' shared memory
  //    (writes to swarm-blackboard.md in the workspace root)
  const blackboard = new SharedBlackboard(process.cwd());

  // Register each agent identity on the blackboard.
  // Token + namespace scoping means agents can only see keys they're allowed to.
  blackboard.registerAgent('researcher', 'tok-researcher', ['task:', 'research:']);
  blackboard.registerAgent('analyst',   'tok-analyst',    ['task:', 'research:', 'analysis:']);
  blackboard.registerAgent('reporter',  'tok-reporter',   ['task:', 'analysis:', 'report:']);

  // 2. CustomAdapter — wire plain async functions as named agents
  const adapter = new CustomAdapter();

  adapter.registerHandler('researcher', async (payload) => {
    const topic = (payload.handoff?.instruction as string) ?? 'unknown topic';
    step('Researcher', `Investigating: "${topic}"`);

    // Simulate research work
    await sleep(300);
    const findings = {
      topic,
      sources: 3,
      keyFacts: [
        'Multi-agent systems reduce task latency by ~40 %.',
        'Shared blackboard architecture avoids tight coupling.',
        'Permission walls prevent unauthorized resource access.',
      ],
      confidence: 0.87,
    };

    // Write findings to the shared blackboard
    blackboard.write('research:findings', findings, 'researcher', 3600, 'tok-researcher');
    step('Researcher', `Wrote findings to blackboard  ${c.dim}(research:findings)${c.reset}`);

    return findings;
  });

  adapter.registerHandler('analyst', async () => {
    step('Analyst', 'Reading researcher findings from blackboard...');
    const entry = blackboard.read('research:findings');
    if (!entry) throw new Error('No findings on blackboard - did Researcher run first?');

    const findings = entry.value as { keyFacts: string[]; confidence: number; topic: string };

    await sleep(200);
    const analysis = {
      inputTopic : findings.topic,
      factCount  : findings.keyFacts.length,
      confidence : findings.confidence,
      recommendation: findings.confidence >= 0.8
        ? 'High confidence - proceed to report.'
        : 'Low confidence - request additional research.',
      summary:
        `Reviewed ${findings.keyFacts.length} facts about [${findings.topic}]. ` +
        `Confidence score: ${(findings.confidence * 100).toFixed(0)} %.`,
    };

    blackboard.write('analysis:result', analysis, 'analyst', 3600, 'tok-analyst');
    step('Analyst', `Wrote analysis to blackboard  ${c.dim}(analysis:result)${c.reset}`);

    return analysis;
  });

  adapter.registerHandler('reporter', async () => {
    step('Reporter', 'Reading analysis from blackboard...');
    const entry = blackboard.read('analysis:result');
    if (!entry) throw new Error('No analysis on blackboard - did Analyst run first?');

    const analysis = entry.value as {
      inputTopic: string; summary: string; recommendation: string;
    };

    await sleep(150);
    const report = {
      title     : `Swarm Research Report: ${analysis.inputTopic}`,
      generatedAt: new Date().toISOString(),
      summary   : analysis.summary,
      recommendation: analysis.recommendation,
      status    : 'FINAL',
    };

    blackboard.write('report:final', report, 'reporter', 7200, 'tok-reporter');
    step('Reporter', `Published final report  ${c.dim}(report:final)${c.reset}`);

    return report;
  });

  // 3. Build the orchestrator and register the adapter
  const orchestrator = createSwarmOrchestrator({
    qualityThreshold: 0,   // demos don't need quality-gate filtering
    trustLevels: [
      { agentId: 'orchestrator', trustLevel: 0.9, allowedNamespaces: ['*'], allowedResources: ['*'] },
      { agentId: 'researcher',   trustLevel: 0.8, allowedNamespaces: ['task:', 'research:'] },
      { agentId: 'analyst',      trustLevel: 0.8, allowedNamespaces: ['task:', 'research:', 'analysis:'] },
      { agentId: 'reporter',     trustLevel: 0.8, allowedNamespaces: ['task:', 'analysis:', 'report:'] },
    ],
  });
  await orchestrator.addAdapter(adapter);

  const ctx = { agentId: 'orchestrator', taskId: 'demo-001', sessionId: 'session-demo' };

  // ─── STEP 1: Delegate to Researcher ────────────────────────────────────────
  banner('Step 1 - Researcher');
  const r1 = await orchestrator.execute('delegate_task', {
    targetAgent : 'custom:researcher',
    taskPayload : {
      instruction   : 'multi-agent coordination patterns',
      expectedOutput: 'key facts with confidence score',
    },
  }, ctx);

  if (!r1.success) {
    console.error(`${c.bold}${c.yellow}[WARN]${c.reset} Researcher failed:`, r1.error?.message);
  }

  // ─── STEP 2: Delegate to Analyst ───────────────────────────────────────────
  banner('Step 2 - Analyst');
  const r2 = await orchestrator.execute('delegate_task', {
    targetAgent : 'custom:analyst',
    taskPayload : {
      instruction   : 'analyze researcher findings',
      expectedOutput: 'summary + recommendation',
    },
  }, ctx);

  if (!r2.success) {
    console.error(`${c.bold}${c.yellow}[WARN]${c.reset} Analyst failed:`, r2.error?.message);
  }

  // ─── STEP 3: Delegate to Reporter ──────────────────────────────────────────
  banner('Step 3 - Reporter');
  const r3 = await orchestrator.execute('delegate_task', {
    targetAgent : 'custom:reporter',
    taskPayload : {
      instruction   : 'produce final report from analysis',
      expectedOutput: 'formatted report object',
    },
  }, ctx);

  if (!r3.success) {
    console.error(`${c.bold}${c.yellow}[WARN]${c.reset} Reporter failed:`, r3.error?.message);
  }

  // ─── FINAL REPORT ──────────────────────────────────────────────────────────
  banner('Final Report');
  const finalEntry = blackboard.read('report:final');
  if (finalEntry) {
    const report = finalEntry.value as Record<string, unknown>;
    console.log(`\n  ${c.bold}${c.magenta}${report.title}${c.reset}`);
    console.log(`  ${c.dim}Generated: ${report.generatedAt}${c.reset}`);
    console.log(`\n  ${c.bold}Summary:${c.reset}        ${report.summary}`);
    console.log(`  ${c.bold}Recommendation:${c.reset} ${report.recommendation}`);
    console.log(`  ${c.bold}Status:${c.reset}         ${c.green}${report.status}${c.reset}\n`);
  }

  // ─── BLACKBOARD SNAPSHOT ───────────────────────────────────────────────────
  info('Blackboard keys written this session:');
  const snap = blackboard.getSnapshot();
  for (const [key, entry] of Object.entries(snap)) {
    info(`  ${c.blue}${key}${c.reset}  <-  ${entry.sourceAgent}  @ ${entry.timestamp.slice(11, 19)}`);
  }

  console.log(`\n${c.dim}Done.${c.reset}\n`);
}

// ─── Utility ─────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

main().catch(err => {
  console.error('\n[ERROR]', err.message);
  process.exit(1);
});
