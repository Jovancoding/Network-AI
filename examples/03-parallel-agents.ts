/**
 * 03-parallel-agents.ts
 * ─────────────────────
 * Demonstrates `spawn_parallel_agents` — running multiple specialist agents
 * concurrently and synthesizing their results with different strategies.
 *
 * Three agents work in parallel on the same topic:
 *   • sentiment_agent  — tone & sentiment analysis
 *   • keyword_agent    — key-phrase extraction
 *   • summary_agent    — executive summary
 *
 * The demo runs through all four synthesis strategies so you can see how
 * each one combines (or selects) the parallel outputs.
 *
 * No API key needed.
 *
 * Run:
 *   npx ts-node examples/03-parallel-agents.ts
 */

import {
  createSwarmOrchestrator,
  CustomAdapter,
  type SynthesisStrategy,
} from '..';

// ─── ANSI helpers ─────────────────────────────────────────────────────────────
const c = {
  reset  : '\x1b[0m',
  bold   : '\x1b[1m',
  cyan   : '\x1b[36m',
  green  : '\x1b[32m',
  yellow : '\x1b[33m',
  blue   : '\x1b[34m',
  magenta: '\x1b[35m',
  dim    : '\x1b[2m',
};
const banner = (msg: string) =>
  console.log(`\n${c.bold}${c.cyan}---  ${msg}  ---${c.reset}`);
const row    = (label: string, val: string) =>
  console.log(`  ${c.bold}${label.padEnd(20)}${c.reset}${val}`);
const info   = (msg: string) =>
  console.log(`  ${c.dim}${msg}${c.reset}`);

// ─── Sample text the agents will analyze ─────────────────────────────────────
const SAMPLE_TEXT = `
  network-ai makes multi-agent coordination easy and secure. The shared
  blackboard lets agents collaborate without tight coupling, and the permission
  wall ensures every resource access is justified and audited. Real-world swarms
  can now be built in minutes rather than months.
`.trim();

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  banner('network-ai - Parallel Agents');

  // ─── Register three specialist agents ──────────────────────────────────────
  const adapter = new CustomAdapter();

  // Agent 1 — Sentiment analysis
  adapter.registerHandler('sentiment_agent', async (payload) => {
    const text = (payload.handoff?.context as { text?: string })?.text ?? '';
    await sleep(250);

    const positiveWords = (text.match(/easy|secure|simple|fast|safe|great|better|improve/gi) ?? []).length;
    const negativeWords = (text.match(/hard|slow|insecure|bad|broken|fail|complex/gi) ?? []).length;
    const total = positiveWords + negativeWords;
    const score = total === 0 ? 0.5 : positiveWords / total;

    return {
      agent    : 'sentiment_agent',
      sentiment: score >= 0.7 ? 'positive' : score >= 0.4 ? 'neutral' : 'negative',
      score    : parseFloat(score.toFixed(2)),
      positiveHits: positiveWords,
      negativeHits: negativeWords,
    };
  });

  // Agent 2 — Keyword extraction
  adapter.registerHandler('keyword_agent', async (payload) => {
    const text = (payload.handoff?.context as { text?: string })?.text ?? '';
    await sleep(180);

    // Very simple: pull out capitalized proper nouns and domain terms
    const domainTerms = [
      'network-ai', 'blackboard', 'agent', 'permission',
      'orchestrator', 'swarm', 'coordination', 'security',
    ];
    const found = domainTerms.filter(t => text.toLowerCase().includes(t));

    return {
      agent   : 'keyword_agent',
      keywords: found,
      count   : found.length,
      density : parseFloat((found.length / text.split(/\s+/).length).toFixed(3)),
    };
  });

  // Agent 3 — Executive summary
  adapter.registerHandler('summary_agent', async (payload) => {
    const text = (payload.handoff?.context as { text?: string })?.text ?? '';
    await sleep(320);

    const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
    const wordCount = text.split(/\s+/).length;

    return {
      agent      : 'summary_agent',
      wordCount,
      sentenceCount: sentences.length,
      firstSentence: sentences[0] ?? '',
      readingTimeSeconds: Math.ceil(wordCount / 3), // ~180 wpm
      oneLiner   : 'A secure, blackboard-based multi-agent coordination library.',
    };
  });

  // ─── Build orchestrator ─────────────────────────────────────────────────────
  const orchestrator = createSwarmOrchestrator({
    qualityThreshold: 0,   // demos don't need quality-gate filtering
    trustLevels: [
      { agentId: 'orchestrator',    trustLevel: 0.9, allowedNamespaces: ['*'], allowedResources: ['*'] },
      { agentId: 'sentiment_agent', trustLevel: 0.8, allowedNamespaces: ['task:'] },
      { agentId: 'keyword_agent',   trustLevel: 0.8, allowedNamespaces: ['task:'] },
      { agentId: 'summary_agent',   trustLevel: 0.8, allowedNamespaces: ['task:'] },
    ],
  });
  await orchestrator.addAdapter(adapter);

  const ctx = { agentId: 'orchestrator', taskId: 'demo-parallel', sessionId: 'session-p1' };

  // Shared task params (3 agents, same input text)
  const parallelTasks = [
    {
      agentType: 'custom:sentiment_agent',
      taskPayload: {
        instruction: 'Analyze sentiment of the provided text',
        context    : { text: SAMPLE_TEXT },
      },
    },
    {
      agentType: 'custom:keyword_agent',
      taskPayload: {
        instruction: 'Extract keywords from the provided text',
        context    : { text: SAMPLE_TEXT },
      },
    },
    {
      agentType: 'custom:summary_agent',
      taskPayload: {
        instruction: 'Summarize the provided text',
        context    : { text: SAMPLE_TEXT },
      },
    },
  ];

  // ─── Run with every synthesis strategy ──────────────────────────────────────
  const strategies: SynthesisStrategy[] = ['merge', 'vote', 'chain', 'first-success'];

  for (const strategy of strategies) {
    banner(`Strategy: ${strategy.toUpperCase()}`);

    const start = Date.now();
    const result = await orchestrator.execute(
      'spawn_parallel_agents',
      { tasks: parallelTasks, synthesisStrategy: strategy },
      ctx,
    );
    const elapsed = Date.now() - start;

    if (!result.success) {
      console.log(`  ${c.yellow}Failed:${c.reset}`, result.error?.message);
      continue;
    }

    const data = result.data as {
      synthesizedResult: Record<string, unknown>;
      individualResults: Array<{ agentType: string; success: boolean; executionTime: number }>;
      executionMetrics : { totalTime: number; successRate: number; synthesisStrategy: string };
    };

    // Per-agent stats
    info('Individual results:');
    for (const r of data.individualResults) {
      const name = r.agentType.replace('custom:', '');
      const icon = r.success ? c.green + '+' : c.yellow + 'x';
      console.log(`    ${icon}${c.reset}  ${name.padEnd(18)} ${r.executionTime} ms`);
    }

    // Synthesis output (strategy-specific top-level fields)
    info('\nSynthesized output (top-level fields):');
    const synth = data.synthesizedResult;
    for (const [k, v] of Object.entries(synth)) {
      if (typeof v !== 'object') {
        row(`  ${k}`, String(v));
      } else {
        row(`  ${k}`, c.dim + JSON.stringify(v).slice(0, 80) + c.reset);
      }
    }

    // Metrics
    info('');
    row('  Wall-clock time',  `${elapsed} ms`);
    row('  Success rate',     `${(data.executionMetrics.successRate * 100).toFixed(0)} %`);
    row('  Strategy used',    data.executionMetrics.synthesisStrategy);
  }

  // ─── Demonstrate: result caching on second run ─────────────────────────────
  banner('Second Run (cache hit demo)');
  info('network-ai caches successful results on the blackboard.');
  info('A second spawn_parallel_agents call with the same tasks should be instant.');

  const t0 = Date.now();
  const r2 = await orchestrator.execute(
    'spawn_parallel_agents',
    { tasks: parallelTasks, synthesisStrategy: 'merge' },
    ctx,
  );
  const t1 = Date.now();

  if (r2.success) {
    const d2 = r2.data as { individualResults: Array<{ executionTime: number }> };
    const anyFromCache = d2.individualResults.some(r => r.executionTime === 0);
    console.log(`  ${c.bold}Elapsed:${c.reset} ${t1 - t0} ms  ` +
      (anyFromCache
        ? `${c.green}<- cache hits detected (executionTime = 0)${c.reset}`
        : `${c.yellow}(no cache hits)${c.reset}`));
  }

  console.log(`\n${c.dim}Done.${c.reset}\n`);
}

// ─── Utility ─────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

main().catch(err => {
  console.error('\n[ERROR]', err.message);
  process.exit(1);
});
