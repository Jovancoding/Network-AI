/**
 * Example 09 — Real LangChain Integration
 *
 * Shows how to wire an actual LangChain Runnable (chain, agent, or graph)
 * into Network-AI's LangChainAdapter, then run it inside the orchestrator
 * with AuthGuardian permission gating and blackboard persistence.
 *
 * Prerequisites:
 *   npm install @langchain/openai @langchain/core
 *   export OPENAI_API_KEY=sk-...
 *
 * Or with any other LangChain-compatible provider — swap ChatOpenAI for
 * ChatAnthropic, ChatGroq, ChatOllama, etc. without changing anything else.
 *
 * Run:
 *   npx ts-node examples/09-real-langchain.ts
 */

// ─── Step 1: Import Network-AI pieces ────────────────────────────────────────
import {
  createSwarmOrchestrator,
  LangChainAdapter,
  CustomAdapter,
  AdapterRegistry,
} from '../index';

// ─── Step 2: Import real LangChain objects ───────────────────────────────────
// These are your existing chains/agents — Network-AI never instantiates them,
// you bring your own and hand them to the adapter.
//
// Uncomment when @langchain/openai and @langchain/core are installed:
//
// import { ChatOpenAI } from '@langchain/openai';
// import { ChatPromptTemplate } from '@langchain/core/prompts';
// import { StringOutputParser } from '@langchain/core/output_parsers';
// import { RunnableSequence } from '@langchain/core/runnables';

// ─── Simulation helpers (remove once real imports above are uncommented) ─────

/** Simulates the shape of a LangChain Runnable for offline demo purposes. */
function mockRunnable(name: string, mockOutput: (input: unknown) => unknown) {
  return {
    invoke: async (input: unknown, _config?: unknown) => {
      console.log(`  [${name}] invoking with:`, JSON.stringify(input).slice(0, 120));
      await new Promise(r => setTimeout(r, 80)); // simulate LLM latency
      return mockOutput(input);
    },
    // Real LangChain chains also expose .stream() — used by LangChainStreamingAdapter
    stream: async function* (input: unknown, _config?: unknown) {
      const full = await mockOutput(input) as Record<string, string>;
      const text: string = full?.output ?? String(full);
      const words = text.split(' ');
      for (const word of words) {
        yield word + ' ';
        await new Promise(r => setTimeout(r, 10));
      }
    },
  };
}

// ─── Colors ──────────────────────────────────────────────────────────────────
const c = {
  bold:  '\x1b[1m',
  cyan:  '\x1b[36m',
  green: '\x1b[32m',
  yellow:'\x1b[33m',
  dim:   '\x1b[2m',
  reset: '\x1b[0m',
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${c.bold}${c.cyan}Example 09 — Real LangChain Integration${c.reset}`);
  console.log(`${c.dim}Wire your own Runnables into Network-AI with zero boilerplate${c.reset}\n`);

  // ── 1. Build your LangChain chains ──────────────────────────────────────────
  // Replace mockRunnable() with your real chain:
  //
  //   const llm = new ChatOpenAI({ model: 'gpt-4o', temperature: 0 });
  //   const prompt = ChatPromptTemplate.fromMessages([
  //     ['system', 'You are a senior financial analyst.'],
  //     ['human', '{input}'],
  //   ]);
  //   const analysisChain = RunnableSequence.from([prompt, llm, new StringOutputParser()]);
  //
  const analysisChain = mockRunnable('analyst-chain', (input: unknown) => {
    const inp = input as Record<string, unknown>;
    return {
      output: `Revenue grew 18% YoY. Key drivers: ${inp.input ?? 'Q4 revenue data'}. ` +
              `Recommendation: increase marketing budget by 12%.`,
    };
  });

  //   const summaryChain = RunnableSequence.from([summaryPrompt, llm, new StringOutputParser()]);
  const summaryChain = mockRunnable('summary-chain', (input: unknown) => {
    const inp = input as Record<string, unknown>;
    const analysis = (inp.analysis ?? inp.input ?? '') as string;
    return {
      output: `Executive summary: ${analysis.slice(0, 60)}... Action required.`,
    };
  });

  // ── 2. Register them in a LangChainAdapter ───────────────────────────────────
  // This is the ONLY Network-AI-specific step. Pass your real Runnable object
  // directly — the adapter calls .invoke() using LangChain's own interface.
  const langchainAdapter = new LangChainAdapter();
  await langchainAdapter.initialize({});

  langchainAdapter.registerAgent('analyst', analysisChain, {
    description: 'Financial analysis chain (GPT-4o)',
    capabilities: ['analysis', 'finance'],
  });

  langchainAdapter.registerAgent('summarizer', summaryChain, {
    description: 'Executive summary chain (GPT-4o)',
    capabilities: ['summarization'],
  });

  console.log(`${c.green}[✓]${c.reset} Registered 2 LangChain agents (analyst, summarizer)`);

  // ── 3. Add a plain CustomAdapter agent for comparison ───────────────────────
  // Mix any other adapter type in the same registry — no restrictions.
  const customAdapter = new CustomAdapter();
  await customAdapter.initialize({});

  customAdapter.registerHandler('formatter', async (payload) => {
    const instruction = payload.handoff?.instruction ?? '';
    return {
      report: `[FORMATTED REPORT] ${instruction}`,
      generatedAt: new Date().toISOString(),
    };
  });

  console.log(`${c.green}[✓]${c.reset} Registered 1 Custom agent (formatter)`);

  // ── 4. Create the orchestrator with both adapters ───────────────────────────
  const registry = new AdapterRegistry();
  await registry.addAdapter(langchainAdapter);
  await registry.addAdapter(customAdapter);

  const orchestrator = createSwarmOrchestrator({
    adapterRegistry: registry,
    // Trust levels — analyst needs DATABASE access for the permission gate demo
    trustLevels: [
      { agentId: 'orchestrator',   trustLevel: 0.9, allowedNamespaces: ['*'],            allowedResources: ['*'] },
      { agentId: 'analyst',        trustLevel: 0.8, allowedNamespaces: ['task:', 'analytics:'], allowedResources: ['DATABASE', 'FINANCIAL_API'] },
      { agentId: 'summarizer',     trustLevel: 0.8, allowedNamespaces: ['task:', 'analytics:'], allowedResources: ['DATA_EXPORT'] },
      { agentId: 'formatter',      trustLevel: 0.7, allowedNamespaces: ['task:', 'report:'],    allowedResources: ['DATA_EXPORT'] },
    ],
  });

  console.log(`${c.green}[✓]${c.reset} Orchestrator created with LangChain + Custom adapters\n`);

  // ── 5. AuthGuardian permission gate ─────────────────────────────────────────
  console.log(`${c.cyan}${c.bold}Phase 1 — Permission gate${c.reset}`);
  const permResult = await orchestrator.execute('request_permission', {
    resourceType: 'FINANCIAL_API',
    justification: 'Need access to Q4 financial data for annual revenue analysis task-2026',
    scope: 'read',
  }, { agentId: 'analyst', taskId: 'task-q4-2026' });

  const grantToken = (permResult.data as any)?.grantToken;
  console.log(`  Permission: ${permResult.success ? `${c.green}GRANTED${c.reset}` : `\x1b[31mDENIED${c.reset}`}`);
  if (grantToken) {
    console.log(`  Token: ${c.dim}${grantToken.slice(0, 20)}...${c.reset}`);
  }

  // ── 6. Delegate to the real LangChain analyst chain ─────────────────────────
  console.log(`\n${c.cyan}${c.bold}Phase 2 — LangChain analyst chain${c.reset}`);
  const analysisResult = await orchestrator.execute('delegate_task', {
    targetAgent: 'langchain:analyst',
    taskPayload: {
      instruction: 'Analyze Q4 2026 revenue data and identify key growth drivers',
      context: { quarter: 'Q4', year: 2026, grantToken },
      expectedOutput: 'JSON with revenue metrics and recommendations',
    },
  }, { agentId: 'orchestrator', taskId: 'task-q4-2026' });

  const analysis = analysisResult.success
    ? (analysisResult.data as any)?.result?.data
    : null;

  console.log(`  Result: ${analysisResult.success ? c.green + 'OK' + c.reset : '\x1b[31mFAIL\x1b[0m'}`);
  if (analysis) {
    const text = typeof analysis === 'string' ? analysis : JSON.stringify(analysis);
    console.log(`  Output: ${c.dim}${text.slice(0, 100)}...${c.reset}`);
  }

  // ── 7. Pipe the analysis result into the summarizer chain ───────────────────
  console.log(`\n${c.cyan}${c.bold}Phase 3 — LangChain summarizer chain${c.reset}`);
  const summaryResult = await orchestrator.execute('delegate_task', {
    targetAgent: 'langchain:summarizer',
    taskPayload: {
      instruction: typeof analysis === 'string'
        ? analysis
        : 'Summarize the Q4 2026 revenue analysis for the board',
      context: { previousAgent: 'analyst' },
      expectedOutput: 'One-paragraph executive summary',
    },
  }, { agentId: 'orchestrator', taskId: 'task-q4-2026' });

  const summary = summaryResult.success
    ? (summaryResult.data as any)?.result?.data
    : null;

  console.log(`  Result: ${summaryResult.success ? c.green + 'OK' + c.reset : '\x1b[31mFAIL\x1b[0m'}`);
  if (summary) {
    const text = typeof summary === 'string' ? summary : JSON.stringify(summary);
    console.log(`  Output: ${c.dim}${text.slice(0, 100)}...${c.reset}`);
  }

  // ── 8. Persist the final report via the formatter (CustomAdapter) ───────────
  console.log(`\n${c.cyan}${c.bold}Phase 4 — Custom formatter agent (cross-framework)${c.reset}`);
  const formatResult = await orchestrator.execute('delegate_task', {
    targetAgent: 'custom:formatter',
    taskPayload: {
      instruction: typeof summary === 'string' ? summary : 'Q4 analysis complete',
      expectedOutput: 'Formatted report string',
    },
  }, { agentId: 'orchestrator', taskId: 'task-q4-2026' });

  const report = formatResult.success
    ? (formatResult.data as any)?.result?.data
    : null;

  console.log(`  Result: ${formatResult.success ? c.green + 'OK' + c.reset : '\x1b[31mFAIL\x1b[0m'}`);
  if (report) {
    const text = typeof report === 'string' ? report : JSON.stringify(report);
    console.log(`  Output: ${c.dim}${text.slice(0, 120)}${c.reset}`);
  }

  // ── 9. Write final result to the shared blackboard ──────────────────────────
  console.log(`\n${c.cyan}${c.bold}Phase 5 — Write to shared blackboard${c.reset}`);
  const bbWrite = await orchestrator.execute('update_blackboard', {
    key: 'report:q4-2026',
    value: {
      analysis,
      summary,
      report,
      agents: ['analyst', 'summarizer', 'formatter'],
      completedAt: new Date().toISOString(),
    },
    ttl: 3600,
  }, { agentId: 'orchestrator' });

  console.log(`  Blackboard write: ${bbWrite.success ? c.green + 'OK' + c.reset : '\x1b[31mFAIL\x1b[0m'}`);

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log(`\n${c.bold}${'─'.repeat(58)}${c.reset}`);
  console.log(`${c.bold}  Done.${c.reset}`);
  console.log(`  • 2 LangChain Runnables + 1 Custom handler`);
  console.log(`  • AuthGuardian permission gate → analysis chain → summary chain → formatter`);
  console.log(`  • Final result persisted to blackboard key ${c.cyan}report:q4-2026${c.reset}`);
  console.log(`\n${c.dim}To use real LangChain objects:${c.reset}`);
  console.log(`  ${c.dim}1. npm install @langchain/openai @langchain/core${c.reset}`);
  console.log(`  ${c.dim}2. Replace mockRunnable() calls with your real chains${c.reset}`);
  console.log(`  ${c.dim}3. Set OPENAI_API_KEY (or any other provider)${c.reset}`);
  console.log(`${c.bold}${'─'.repeat(58)}${c.reset}\n`);
}

main().catch(err => {
  console.error('\nFatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
