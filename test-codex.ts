/**
 * test-codex.ts — Codex Adapter Test Suite
 *
 * Tests:
 *   - CodexAdapter initialisation and lifecycle
 *   - registerCodexAgent() registration and validation
 *   - executeAgent() — chat mode via BYOC client
 *   - executeAgent() — completion mode via BYOC client
 *   - executeAgent() — CLI mode via executor function
 *   - executeAgent() — unregistered agent returns error result
 *   - executeAgent() — client throws, returns error result
 *   - CLI mode without executor throws on registration
 *   - buildPrompt coverage (handoff, blackboard snapshot)
 *   - Capabilities / listAgents
 *   - Type exports (smoke check)
 *
 * Run: npx ts-node test-codex.ts
 */

import { CodexAdapter } from './adapters/codex-adapter';
import type {
  CodexAgentConfig,
  CodexChatClient,
  CodexCompletionClient,
  CodexCLIExecutor,
  CodexMode,
} from './adapters/codex-adapter';
import type { AgentPayload, AgentContext } from './types/agent-adapter';

// ─── Colours ─────────────────────────────────────────────────────────────────

const c = {
  green: '\x1b[32m',
  red:   '\x1b[31m',
  cyan:  '\x1b[36m',
  bold:  '\x1b[1m',
  reset: '\x1b[0m',
};

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ${c.green}[v]${c.reset} ${message}`);
    passed++;
  } else {
    console.log(`  ${c.red}[x]${c.reset} ${message}`);
    failed++;
  }
}

function section(title: string): void {
  console.log(`\n${c.cyan}${c.bold}> ${title}${c.reset}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const defaultPayload: AgentPayload = {
  action: 'refactor',
  params: { language: 'typescript', complexity: 'low' },
};

const defaultContext: AgentContext = {
  agentId: 'test-caller',
  taskId: 'task-001',
  sessionId: 'sess-001',
};

/** Build a minimal BYOC chat client */
function makeChatClient(responseText: string, usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }): CodexChatClient {
  return {
    create: async (_params) => ({
      choices: [{ message: { content: responseText } }],
      usage,
    }),
  };
}

/** Build a minimal BYOC completion client */
function makeCompletionClient(responseText: string): CodexCompletionClient {
  return {
    create: async (_params) => ({
      choices: [{ text: responseText }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function runTests(): Promise<void> {

  // ── 1. Lifecycle ────────────────────────────────────────────────────────────
  section('1. Lifecycle');

  const adapter = new CodexAdapter();
  assert(adapter.name === 'codex', 'name is "codex"');
  assert(adapter.version === '1.0.0', 'version is 1.0.0');
  assert(!adapter.isReady(), 'not ready before initialize()');

  await adapter.initialize({});
  assert(adapter.isReady(), 'ready after initialize()');

  const health = await adapter.healthCheck();
  assert(health.healthy === true, 'healthCheck() returns healthy');

  await adapter.shutdown();
  assert(!adapter.isReady(), 'not ready after shutdown()');

  // ── 2. Registration ─────────────────────────────────────────────────────────
  section('2. Registration');

  const a2 = new CodexAdapter();
  a2.registerCodexAgent('chat-agent', { mode: 'chat', client: makeChatClient('ok') });
  assert(a2.isReady(), 'registerCodexAgent() sets adapter ready');

  const agents = await a2.listAgents();
  assert(agents.length === 1, 'listAgents() returns 1 agent');
  assert(agents[0].id === 'chat-agent', 'agent id is "chat-agent"');
  assert(await a2.isAgentAvailable('chat-agent'), 'isAgentAvailable() true for registered agent');
  assert(!(await a2.isAgentAvailable('ghost')), 'isAgentAvailable() false for unknown agent');

  // ── 3. CLI mode — missing executor throws ───────────────────────────────────
  section('3. CLI mode validation');

  const a3 = new CodexAdapter();
  let threw = false;
  try {
    a3.registerCodexAgent('bad-cli', { mode: 'cli' }); // no executor
  } catch {
    threw = true;
  }
  assert(threw, 'registerCodexAgent() throws when mode=cli and executor is missing');

  // ── 4. Chat mode via BYOC client ────────────────────────────────────────────
  section('4. Chat mode — BYOC client');

  const a4 = new CodexAdapter();
  a4.registerCodexAgent('chat', {
    mode: 'chat',
    model: 'gpt-4o',
    systemPrompt: 'You are a code review assistant.',
    client: makeChatClient('looks good to me', { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 }),
  });

  const r4 = await a4.executeAgent('chat', defaultPayload, defaultContext);
  assert(r4.success === true, 'chat mode result.success is true');
  assert(typeof r4.data === 'object' && r4.data !== null, 'result.data is an object');
  const d4 = r4.data as Record<string, unknown>;
  assert(d4['output'] === 'looks good to me', 'result.data.output matches client response');
  assert(d4['mode'] === 'chat', 'result.data.mode is "chat"');
  assert(d4['model'] === 'gpt-4o', 'result.data.model is "gpt-4o"');
  assert(r4.metadata?.['adapter'] === 'codex', 'metadata.adapter is "codex"');
  assert((r4.metadata?.trace as Record<string,unknown>)?.['mode'] === 'chat', 'metadata.trace.mode is "chat"');
  assert(typeof (r4.metadata?.trace as Record<string,unknown>)?.['usage'] === 'object', 'metadata.trace.usage is present');

  // ── 5. Completion mode via BYOC client ──────────────────────────────────────
  section('5. Completion mode — BYOC client');

  const a5 = new CodexAdapter();
  a5.registerCodexAgent('completion-agent', {
    mode: 'completion',
    model: 'code-davinci-002',
    client: makeCompletionClient('function hello() { return 42; }'),
  });

  const r5 = await a5.executeAgent('completion-agent', defaultPayload, defaultContext);
  assert(r5.success === true, 'completion mode result.success is true');
  const d5 = r5.data as Record<string, unknown>;
  assert(d5['output'] === 'function hello() { return 42; }', 'completion output matches');
  assert(d5['mode'] === 'completion', 'result.data.mode is "completion"');
  assert(d5['model'] === 'code-davinci-002', 'result.data.model is "code-davinci-002"');

  // ── 6. CLI mode via executor ─────────────────────────────────────────────────
  section('6. CLI mode — executor function');

  const capturedPrompts: string[] = [];
  const cliExecutor: CodexCLIExecutor = async (prompt, opts) => {
    capturedPrompts.push(prompt);
    return `CLI output for model ${(opts as Record<string,unknown>)?.['model'] ?? 'default'}`;
  };

  const a6 = new CodexAdapter();
  a6.registerCodexAgent('codex-cli', {
    mode: 'cli',
    model: 'gpt-4o',
    executor: cliExecutor,
  });

  const cliPayload: AgentPayload = {
    action: 'write-tests',
    params: { file: 'auth.ts' },
    handoff: {
      handoffId: 'h-001',
      sourceAgent: 'orchestrator',
      targetAgent: 'codex-cli',
      taskType: 'delegate',
      instruction: 'Write unit tests for the auth module',
    },
  };

  const r6 = await a6.executeAgent('codex-cli', cliPayload, defaultContext);
  assert(r6.success === true, 'CLI mode result.success is true');
  const d6 = r6.data as Record<string, unknown>;
  assert(d6['mode'] === 'cli', 'result.data.mode is "cli"');
  assert(typeof d6['output'] === 'string' && (d6['output'] as string).includes('CLI output'), 'CLI output contains expected text');
  assert(capturedPrompts.length === 1, 'executor was called once');
  assert(capturedPrompts[0].includes('Write unit tests'), 'prompt contains handoff instruction');
  assert(capturedPrompts[0].includes('write-tests'), 'prompt contains action');

  // ── 7. Blackboard snapshot in prompt ────────────────────────────────────────
  section('7. Blackboard snapshot included in prompt');

  const capturedBB: string[] = [];
  const bbExecutor: CodexCLIExecutor = async (prompt) => {
    capturedBB.push(prompt);
    return 'done';
  };

  const a7 = new CodexAdapter();
  a7.registerCodexAgent('bb-agent', { mode: 'cli', executor: bbExecutor });

  const bbPayload: AgentPayload = {
    action: 'summarize',
    params: {},
    blackboardSnapshot: {
      'task:current': 'review auth module',
      'analysis:result': { score: 95, issues: [] },
    },
  };

  await a7.executeAgent('bb-agent', bbPayload, defaultContext);
  assert(capturedBB.length === 1, 'executor called once');
  assert(capturedBB[0].includes('task:current'), 'prompt includes blackboard key');
  assert(capturedBB[0].includes('review auth module'), 'prompt includes blackboard value');

  // ── 8. Unregistered agent returns error result ──────────────────────────────
  section('8. Unregistered agent — error result');

  const a8 = new CodexAdapter();
  await a8.initialize({});
  const r8 = await a8.executeAgent('ghost', defaultPayload, defaultContext);
  assert(r8.success === false, 'unregistered agent returns success=false');
  assert(typeof r8.error?.message === 'string' && r8.error.message.includes('ghost'), 'error message mentions agent id');
  assert(r8.metadata?.['adapter'] === 'codex', 'metadata.adapter is "codex"');

  // ── 9. Client throws — captured as error result ─────────────────────────────
  section('9. Client throws — error captured in result');

  const throwingClient: CodexChatClient = {
    create: async () => { throw new Error('rate limit exceeded'); },
  };

  const a9 = new CodexAdapter();
  a9.registerCodexAgent('throw-agent', { mode: 'chat', client: throwingClient });
  const r9 = await a9.executeAgent('throw-agent', defaultPayload, defaultContext);
  assert(r9.success === false, 'client error returns success=false');
  assert(typeof r9.error?.message === 'string' && r9.error.message.includes('rate limit'), 'error message propagated');

  // ── 10. Default mode is chat ─────────────────────────────────────────────────
  section('10. Default mode fallback');

  const a10 = new CodexAdapter();
  a10.registerCodexAgent('default-mode', { client: makeChatClient('default response') }); // no mode specified
  const agents10 = await a10.listAgents();
  assert(agents10[0]?.description?.includes('chat') ?? false, 'default mode is chat (shows in description)');

  const r10 = await a10.executeAgent('default-mode', defaultPayload, defaultContext);
  assert(r10.success === true, 'default mode executes successfully');
  const d10 = r10.data as Record<string, unknown>;
  assert(d10['mode'] === 'chat', 'result.data.mode defaults to "chat"');

  // ── 11. Capabilities ─────────────────────────────────────────────────────────
  section('11. Capabilities');

  const caps = new CodexAdapter().capabilities;
  assert(caps.parallel === true, 'capabilities.parallel is true');
  assert(caps.authentication === true, 'capabilities.authentication is true');
  assert(caps.streaming === false, 'capabilities.streaming is false (sync adapter)');
  assert(caps.statefulSessions === false, 'capabilities.statefulSessions is false');

  // ── 12. Multiple agents on same adapter ─────────────────────────────────────
  section('12. Multiple agents on same adapter');

  const a12 = new CodexAdapter();
  a12.registerCodexAgent('agent-a', { mode: 'chat', client: makeChatClient('response A') });
  a12.registerCodexAgent('agent-b', { mode: 'chat', client: makeChatClient('response B') });
  a12.registerCodexAgent('agent-c', { mode: 'cli', executor: async () => 'cli result' });

  const agents12 = await a12.listAgents();
  assert(agents12.length === 3, 'three agents registered');

  const rA = await a12.executeAgent('agent-a', defaultPayload, defaultContext);
  const rB = await a12.executeAgent('agent-b', defaultPayload, defaultContext);
  const rC = await a12.executeAgent('agent-c', defaultPayload, defaultContext);
  assert((rA.data as Record<string,unknown>)['output'] === 'response A', 'agent-a returns its own response');
  assert((rB.data as Record<string,unknown>)['output'] === 'response B', 'agent-b returns its own response');
  assert((rC.data as Record<string,unknown>)['output'] === 'cli result', 'agent-c returns CLI result');

  // ── 13. Type exports smoke check ────────────────────────────────────────────
  section('13. Type exports');

  const modeCheck: CodexMode = 'chat';
  const configCheck: CodexAgentConfig = { mode: 'cli', executor: async () => '' };
  assert(modeCheck === 'chat', 'CodexMode type usable');
  assert(configCheck.mode === 'cli', 'CodexAgentConfig type usable');

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${c.bold}Results: ${c.green}${passed} passed${c.reset}${c.bold}, ${failed > 0 ? c.red : c.green}${failed} failed${c.reset}`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
