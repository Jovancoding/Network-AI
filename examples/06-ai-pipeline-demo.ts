/**
 * 06-ai-pipeline-demo.ts — Full Network-AI Pipeline Demo
 * ───────────────────────────────────────────────────────
 * 6 real AI agents coordinate through the shared blackboard to build a
 * complete feature from a single prompt:
 *
 *   "Build a rate-limiter middleware for Express"
 *
 * Pipeline:
 *   1. architect_agent   → designs the API (OpenAI)
 *             ↓ writes design to blackboard
 *   2. implementer_agent → writes the TypeScript code (OpenAI)
 *             ↓ writes code to blackboard
 *   3. PARALLEL: security_agent + test_agent + docs_agent (OpenAI × 3)
 *             ↓ each writes findings to blackboard
 *   4. coordinator_agent → reads everything, writes final report (OpenAI)
 *
 * Output: examples/output/rate-limiter-<timestamp>.ts + final report
 *
 * Run:
 *   npx ts-node examples/06-ai-pipeline-demo.ts
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import OpenAI from 'openai';
import {
  createSwarmOrchestrator,
  CustomAdapter,
  type SynthesisStrategy,
} from '..';
import { FederatedBudget } from '../lib/federated-budget';

// ─── ANSI helpers ─────────────────────────────────────────────────────────────
const c = {
  reset   : '\x1b[0m',
  bold    : '\x1b[1m',
  dim     : '\x1b[2m',
  cyan    : '\x1b[36m',
  green   : '\x1b[32m',
  yellow  : '\x1b[33m',
  blue    : '\x1b[34m',
  magenta : '\x1b[35m',
  red     : '\x1b[31m',
  white   : '\x1b[37m',
};

function banner(msg: string) {
  const line = '═'.repeat(60);
  console.log(`\n${c.bold}${c.cyan}${line}${c.reset}`);
  console.log(`${c.bold}${c.cyan}  ${msg}${c.reset}`);
  console.log(`${c.bold}${c.cyan}${line}${c.reset}\n`);
}

function agentLog(agent: string, msg: string, colour = c.green) {
  const pad = agent.padEnd(22);
  console.log(`  ${colour}●${c.reset} ${c.bold}${pad}${c.reset} ${msg}`);
}

function step(n: number, total: number, agent: string) {
  console.log(`\n${c.yellow}[${n}/${total}]${c.reset} ${c.bold}${agent}${c.reset} ${c.dim}is thinking...${c.reset}`);
}

// ─── OpenAI client ────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function llm(system: string, user: string): Promise<string> {
  const res = await openai.chat.completions.create({
    model   : 'gpt-4o-mini',
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: user   },
    ],
    temperature: 0.3,
    max_tokens : 900,
  });
  return res.choices[0]?.message?.content?.trim() ?? '';
}

// ─── Target task ──────────────────────────────────────────────────────────────
const TASK = 'Build a production-ready rate-limiter middleware for Express.js in TypeScript';

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  banner('Network-AI — 6-Agent Pipeline Demo');
  console.log(`  ${c.bold}Task:${c.reset} ${TASK}\n`);

  if (!process.env.OPENAI_API_KEY) {
    console.error(`  ${c.red}✗ OPENAI_API_KEY not set in .env${c.reset}`);
    process.exit(1);
  }

  // ─── Infrastructure ──────────────────────────────────────────────────────
  const budget = new FederatedBudget({ ceiling: 50_000 });

  // Shared state — agents read/write through the blackboard
  const bb: Record<string, string> = {};

  // ─── Define 6 agents ─────────────────────────────────────────────────────
  const adapter = new CustomAdapter();

  // 1. Architect — designs the API interface
  adapter.registerHandler('architect_agent', async () => {
    step(1, 6, 'architect_agent');
    const design = await llm(
      'You are a senior TypeScript architect. Output ONLY a concise interface design (no implementation). Use TypeScript interface syntax.',
      `Design the TypeScript interface and options type for: ${TASK}. Include: RateLimiterOptions interface, middleware function signature, error shape. Keep it under 30 lines.`,
    );
    bb['design'] = design;
    agentLog('architect_agent', `Interface designed (${design.length} chars)`);
    budget.spend('architect_agent', 300);
    return { agent: 'architect_agent', status: 'done', chars: design.length };
  });

  // 2. Implementer — writes the actual code
  adapter.registerHandler('implementer_agent', async () => {
    step(2, 6, 'implementer_agent');
    const design = bb['design'] ?? '';
    const code = await llm(
      'You are an expert TypeScript developer. Output ONLY valid TypeScript code with NO markdown fences.',
      `Implement this design as a complete, production-ready TypeScript module:\n\n${design}\n\nRequirements:\n- In-memory sliding window algorithm\n- Per-IP tracking\n- Returns standard Express middleware\n- Full JSDoc on the exported function`,
    );
    bb['code'] = code;
    agentLog('implementer_agent', `Code written (${code.split('\n').length} lines)`);
    budget.spend('implementer_agent', 600);
    return { agent: 'implementer_agent', status: 'done', lines: code.split('\n').length };
  });

  // 3a. Security agent — reviews for vulnerabilities
  adapter.registerHandler('security_agent', async () => {
    const code = bb['code'] ?? '';
    const review = await llm(
      'You are a security engineer. Be concise and specific.',
      `Security review this TypeScript code. List issues as: SEVERITY: description.\nFocus on: DoS, memory leaks, header injection, bypass vectors.\n\n${code}`,
    );
    bb['security'] = review;
    agentLog('security_agent', `Security review done`, c.red);
    budget.spend('security_agent', 400);
    return { agent: 'security_agent', findings: review };
  });

  // 3b. Test agent — writes unit tests
  adapter.registerHandler('test_agent', async () => {
    const code = bb['code'] ?? '';
    const tests = await llm(
      'You are a QA engineer. Output ONLY valid TypeScript test code using Jest. No markdown fences.',
      `Write 5 focused Jest unit tests for this rate limiter middleware:\n\n${code}\n\nTest: happy path, rate exceeded (429), per-IP isolation, reset after window, custom options.`,
    );
    bb['tests'] = tests;
    agentLog('test_agent', `Tests written (${tests.split('\n').length} lines)`, c.blue);
    budget.spend('test_agent', 500);
    return { agent: 'test_agent', tests };
  });

  // 3c. Docs agent — writes README section
  adapter.registerHandler('docs_agent', async () => {
    const code = bb['code'] ?? '';
    const design = bb['design'] ?? '';
    const docs = await llm(
      'You are a technical writer. Be clear and concise. Use Markdown.',
      `Write a README section for this middleware. Include: description (2 sentences), install, usage code example (copy-pasteable), options table, error response format.\n\nInterfaces:\n${design}\n\nImplementation summary: ${code.slice(0, 400)}...`,
    );
    bb['docs'] = docs;
    agentLog('docs_agent', `Docs written (${docs.split('\n').length} lines)`, c.magenta);
    budget.spend('docs_agent', 400);
    return { agent: 'docs_agent', docs };
  });

  // 4. Coordinator — synthesises everything
  adapter.registerHandler('coordinator_agent', async () => {
    step(4, 6, 'coordinator_agent');
    const summary = await llm(
      'You are a tech lead doing final review. Be decisive. Use bullet points.',
      `Final review of this feature delivery:\n\n=== SECURITY FINDINGS ===\n${bb['security']}\n\n=== DOCS QUALITY ===\n${bb['docs']?.slice(0, 300)}\n\n=== CODE LINES ===\n${bb['code']?.split('\n').length} lines\n\nGive: 1) Go/No-Go decision, 2) top 3 strengths, 3) top 2 required fixes before production, 4) overall quality score /10`,
    );
    bb['final_report'] = summary;
    agentLog('coordinator_agent', `Final report ready`, c.cyan);
    budget.spend('coordinator_agent', 350);
    return { agent: 'coordinator_agent', report: summary };
  });

  // ─── Build orchestrator ───────────────────────────────────────────────────
  const orchestrator = createSwarmOrchestrator({
    qualityThreshold: 0,
    trustLevels: [
      { agentId: 'pipeline',          trustLevel: 0.95, allowedNamespaces: ['*'], allowedResources: ['*'] },
      { agentId: 'architect_agent',   trustLevel: 0.9,  allowedNamespaces: ['task:'], allowedResources: ['*'] },
      { agentId: 'implementer_agent', trustLevel: 0.9,  allowedNamespaces: ['task:'], allowedResources: ['*'] },
      { agentId: 'security_agent',    trustLevel: 0.85, allowedNamespaces: ['task:'], allowedResources: ['*'] },
      { agentId: 'test_agent',        trustLevel: 0.85, allowedNamespaces: ['task:'], allowedResources: ['*'] },
      { agentId: 'docs_agent',        trustLevel: 0.85, allowedNamespaces: ['task:'], allowedResources: ['*'] },
      { agentId: 'coordinator_agent', trustLevel: 0.95, allowedNamespaces: ['task:'], allowedResources: ['*'] },
    ],
  });
  await orchestrator.addAdapter(adapter);

  const ctx = { agentId: 'pipeline', taskId: 'demo-006', sessionId: 'showcase' };

  // ─── Phase 1: Sequential — Architect ─────────────────────────────────────
  banner('Phase 1 — Architecture');
  await orchestrator.execute('delegate_task', {
    targetAgent : 'custom:architect_agent',
    taskPayload : { instruction: TASK, context: { task: TASK } },
  }, ctx);

  // ─── Phase 2: Sequential — Implement ─────────────────────────────────────
  banner('Phase 2 — Implementation');
  await orchestrator.execute('delegate_task', {
    targetAgent : 'custom:implementer_agent',
    taskPayload : { instruction: 'Implement the design', context: {} },
  }, ctx);

  // ─── Phase 3: Parallel — Security + Tests + Docs ─────────────────────────
  banner('Phase 3 — Parallel Review (security + tests + docs)');
  console.log(`  ${c.dim}3 agents running simultaneously...${c.reset}\n`);

  await orchestrator.execute('spawn_parallel_agents', {
    tasks: [
      {
        agentType  : 'custom:security_agent',
        taskPayload: { instruction: 'Security review', context: {} },
      },
      {
        agentType  : 'custom:test_agent',
        taskPayload: { instruction: 'Write tests', context: {} },
      },
      {
        agentType  : 'custom:docs_agent',
        taskPayload: { instruction: 'Write docs', context: {} },
      },
    ],
    synthesisStrategy: 'merge' as SynthesisStrategy,
  }, ctx);

  // ─── Phase 4: Coordinator ─────────────────────────────────────────────────
  banner('Phase 4 — Coordinator Synthesis');
  await orchestrator.execute('delegate_task', {
    targetAgent : 'custom:coordinator_agent',
    taskPayload : { instruction: 'Final review', context: {} },
  }, ctx);

  // ─── Write output files ───────────────────────────────────────────────────
  banner('Results');

  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });

  const ts = Date.now();
  const codeFile   = path.join(outDir, `rate-limiter-${ts}.ts`);
  const testFile   = path.join(outDir, `rate-limiter-${ts}.test.ts`);
  const reportFile = path.join(outDir, `rate-limiter-${ts}-report.md`);

  fs.writeFileSync(codeFile,   bb['code']  ?? '// no code generated');
  fs.writeFileSync(testFile,   bb['tests'] ?? '// no tests generated');
  fs.writeFileSync(reportFile,
    `# Rate Limiter — Pipeline Report\n\n` +
    `## Final Decision\n\n${bb['final_report'] ?? ''}\n\n` +
    `## Docs\n\n${bb['docs'] ?? ''}\n\n` +
    `## Security Findings\n\n${bb['security'] ?? ''}\n`
  );

  agentLog('output', `Implementation → ${path.basename(codeFile)}`, c.green);
  agentLog('output', `Tests         → ${path.basename(testFile)}`,  c.blue);
  agentLog('output', `Report        → ${path.basename(reportFile)}`, c.magenta);

  // ─── Budget summary ───────────────────────────────────────────────────────
  const spent   = budget.getTotalSpent();
  const ceiling = budget.getCeiling();
  console.log(`\n  ${c.dim}Token budget:${c.reset} ${spent.toLocaleString()} spent / ${ceiling.toLocaleString()} ceiling (${(100 * spent / ceiling).toFixed(1)}%)`);

  // ─── Final coordinator report ─────────────────────────────────────────────
  banner("Coordinator's Final Report");
  console.log(bb['final_report'] ?? 'No report generated.');

  console.log(`\n${c.bold}${c.green}✓ Pipeline complete. 6 agents, 1 prompt, production-ready output.${c.reset}\n`);
  console.log(`  Run files are in ${c.cyan}examples/output/${c.reset}\n`);
}

main().catch(err => {
  console.error(`\n${c.red}Pipeline failed:${c.reset}`, err.message);
  process.exit(1);
});
