/**
 * test-minimax.ts — MiniMax Adapter Test Suite
 *
 * Tests:
 *   - MiniMaxAdapter initialisation and lifecycle
 *   - registerAgent() registration
 *   - executeAgent() — chat via BYOC client
 *   - executeAgent() — unregistered agent returns error result
 *   - executeAgent() — client throws, returns error result
 *   - executeAgent() — no API key returns error result
 *   - Temperature clamping (MiniMax rejects 0)
 *   - buildPrompt coverage (handoff, blackboard snapshot)
 *   - Capabilities / listAgents
 *   - Multiple agents on same adapter
 *   - Type exports (smoke check)
 *
 * Run: npx ts-node test-minimax.ts
 */

import { MiniMaxAdapter } from './adapters/minimax-adapter';
import type {
  MiniMaxAgentConfig,
  MiniMaxChatClient,
} from './adapters/minimax-adapter';
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
  action: 'analyze',
  params: { topic: 'market trends', depth: 'detailed' },
};

const defaultContext: AgentContext = {
  agentId: 'test-caller',
  taskId: 'task-001',
  sessionId: 'sess-001',
};

/** Build a minimal BYOC chat client that captures parameters */
function makeChatClient(
  responseText: string,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
): MiniMaxChatClient & { lastParams?: Record<string, unknown> } {
  const client: MiniMaxChatClient & { lastParams?: Record<string, unknown> } = {
    create: async (params) => {
      client.lastParams = params as unknown as Record<string, unknown>;
      return {
        choices: [{ message: { content: responseText } }],
        usage,
      };
    },
  };
  return client;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function runTests(): Promise<void> {

  // ── 1. Lifecycle ────────────────────────────────────────────────────────────
  section('1. Lifecycle');

  const adapter = new MiniMaxAdapter();
  assert(adapter.name === 'minimax', 'name is "minimax"');
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

  const a2 = new MiniMaxAdapter();
  a2.registerAgent('analyst', { model: 'MiniMax-M2.5', client: makeChatClient('ok') });
  assert(a2.isReady(), 'registerAgent() sets adapter ready');

  const agents = await a2.listAgents();
  assert(agents.length === 1, 'listAgents() returns 1 agent');
  assert(agents[0].id === 'analyst', 'agent id is "analyst"');
  assert(await a2.isAgentAvailable('analyst'), 'isAgentAvailable() true for registered agent');
  assert(!(await a2.isAgentAvailable('ghost')), 'isAgentAvailable() false for unknown agent');

  // ── 3. Chat mode via BYOC client ──────────────────────────────────────────
  section('3. Chat mode — BYOC client');

  const client3 = makeChatClient('market analysis complete', {
    prompt_tokens: 50,
    completion_tokens: 120,
    total_tokens: 170,
  });

  const a3 = new MiniMaxAdapter();
  a3.registerAgent('analyst', {
    model: 'MiniMax-M2.5',
    systemPrompt: 'You are a market analyst.',
    client: client3,
  });

  const r3 = await a3.executeAgent('analyst', defaultPayload, defaultContext);
  assert(r3.success === true, 'chat mode result.success is true');
  assert(typeof r3.data === 'object' && r3.data !== null, 'result.data is an object');
  const d3 = r3.data as Record<string, unknown>;
  assert(d3['output'] === 'market analysis complete', 'result.data.output matches client response');
  assert(d3['model'] === 'MiniMax-M2.5', 'result.data.model is "MiniMax-M2.5"');
  assert(r3.metadata?.['adapter'] === 'minimax', 'metadata.adapter is "minimax"');
  assert(typeof (r3.metadata?.trace as Record<string,unknown>)?.['usage'] === 'object', 'metadata.trace.usage is present');

  // ── 4. System prompt passed to client ────────────────────────────────────
  section('4. System prompt forwarded');

  const msgs = client3.lastParams?.['messages'] as Array<{ role: string; content: string }>;
  assert(Array.isArray(msgs), 'messages is an array');
  assert(msgs[0]?.role === 'system', 'first message role is system');
  assert(msgs[0]?.content === 'You are a market analyst.', 'system prompt content is correct');
  assert(msgs[1]?.role === 'user', 'second message role is user');

  // ── 5. Temperature clamping ────────────────────────────────────────────────
  section('5. Temperature clamping (MiniMax rejects 0)');

  const tempClient = makeChatClient('ok');
  const a5 = new MiniMaxAdapter();
  a5.registerAgent('temp-test', { temperature: 0, client: tempClient });
  await a5.executeAgent('temp-test', defaultPayload, defaultContext);
  const sentTemp = (tempClient.lastParams?.['temperature'] as number) ?? -1;
  assert(sentTemp > 0, `temperature 0 clamped to ${sentTemp} (must be > 0)`);
  assert(sentTemp <= 1, `clamped temperature ${sentTemp} is <= 1`);

  const tempClient2 = makeChatClient('ok');
  const a5b = new MiniMaxAdapter();
  a5b.registerAgent('temp-test-2', { temperature: 1.5, client: tempClient2 });
  await a5b.executeAgent('temp-test-2', defaultPayload, defaultContext);
  const sentTemp2 = (tempClient2.lastParams?.['temperature'] as number) ?? -1;
  assert(sentTemp2 === 1.0, `temperature 1.5 clamped to 1.0, got ${sentTemp2}`);

  // ── 6. Default model fallback ─────────────────────────────────────────────
  section('6. Default model fallback');

  const defaultClient = makeChatClient('default response');
  const a6 = new MiniMaxAdapter();
  a6.registerAgent('default-model', { client: defaultClient }); // no model specified
  const agents6 = await a6.listAgents();
  assert(agents6[0]?.description?.includes('MiniMax-M2.5') ?? false, 'default model is MiniMax-M2.5');

  const r6 = await a6.executeAgent('default-model', defaultPayload, defaultContext);
  assert(r6.success === true, 'default model executes successfully');
  const d6 = r6.data as Record<string, unknown>;
  assert(d6['model'] === 'MiniMax-M2.5', 'result.data.model defaults to "MiniMax-M2.5"');
  assert(defaultClient.lastParams?.['model'] === 'MiniMax-M2.5', 'client receives default model');

  // ── 7. Highspeed model ────────────────────────────────────────────────────
  section('7. MiniMax-M2.5-highspeed model');

  const hsClient = makeChatClient('fast response');
  const a7 = new MiniMaxAdapter();
  a7.registerAgent('fast', { model: 'MiniMax-M2.5-highspeed', client: hsClient });

  const r7 = await a7.executeAgent('fast', defaultPayload, defaultContext);
  assert(r7.success === true, 'highspeed model executes successfully');
  assert((r7.data as Record<string, unknown>)['model'] === 'MiniMax-M2.5-highspeed', 'model is MiniMax-M2.5-highspeed');
  assert(hsClient.lastParams?.['model'] === 'MiniMax-M2.5-highspeed', 'client receives highspeed model');

  // ── 8. Blackboard snapshot in prompt ──────────────────────────────────────
  section('8. Blackboard snapshot included in prompt');

  const bbClient = makeChatClient('done');
  const a8 = new MiniMaxAdapter();
  a8.registerAgent('bb-agent', { client: bbClient });

  const bbPayload: AgentPayload = {
    action: 'summarize',
    params: {},
    blackboardSnapshot: {
      'task:current': 'review auth module',
      'analysis:result': { score: 95, issues: [] },
    },
  };

  await a8.executeAgent('bb-agent', bbPayload, defaultContext);
  const bbMsgs = bbClient.lastParams?.['messages'] as Array<{ role: string; content: string }>;
  const userMsg = bbMsgs?.find(m => m.role === 'user')?.content ?? '';
  assert(userMsg.includes('task:current'), 'prompt includes blackboard key');
  assert(userMsg.includes('review auth module'), 'prompt includes blackboard value');

  // ── 9. Handoff instruction in prompt ─────────────────────────────────────
  section('9. Handoff instruction in prompt');

  const handoffClient = makeChatClient('done');
  const a9 = new MiniMaxAdapter();
  a9.registerAgent('handoff-agent', { client: handoffClient });

  const handoffPayload: AgentPayload = {
    action: 'review',
    params: {},
    handoff: {
      handoffId: 'h-001',
      sourceAgent: 'orchestrator',
      targetAgent: 'handoff-agent',
      taskType: 'delegate',
      instruction: 'Review the authentication code carefully',
    },
  };

  await a9.executeAgent('handoff-agent', handoffPayload, defaultContext);
  const handoffMsgs = handoffClient.lastParams?.['messages'] as Array<{ role: string; content: string }>;
  const handoffUserMsg = handoffMsgs?.find(m => m.role === 'user')?.content ?? '';
  assert(handoffUserMsg.includes('Review the authentication code'), 'prompt contains handoff instruction');

  // ── 10. Unregistered agent returns error result ───────────────────────────
  section('10. Unregistered agent — error result');

  const a10 = new MiniMaxAdapter();
  await a10.initialize({});
  const r10 = await a10.executeAgent('ghost', defaultPayload, defaultContext);
  assert(r10.success === false, 'unregistered agent returns success=false');
  assert(typeof r10.error?.message === 'string' && r10.error.message.includes('ghost'), 'error message mentions agent id');
  assert(r10.metadata?.['adapter'] === 'minimax', 'metadata.adapter is "minimax"');

  // ── 11. Client throws — captured as error result ──────────────────────────
  section('11. Client throws — error captured in result');

  const throwingClient: MiniMaxChatClient = {
    create: async () => { throw new Error('rate limit exceeded'); },
  };

  const a11 = new MiniMaxAdapter();
  a11.registerAgent('throw-agent', { client: throwingClient });
  const r11 = await a11.executeAgent('throw-agent', defaultPayload, defaultContext);
  assert(r11.success === false, 'client error returns success=false');
  assert(typeof r11.error?.message === 'string' && r11.error.message.includes('rate limit'), 'error message propagated');

  // ── 12. No API key — error when using fetch path ─────────────────────────
  section('12. No API key — error result');

  const origKey = process.env['MINIMAX_API_KEY'];
  delete process.env['MINIMAX_API_KEY'];

  const a12 = new MiniMaxAdapter();
  a12.registerAgent('no-key', {}); // no client, no apiKey
  const r12 = await a12.executeAgent('no-key', defaultPayload, defaultContext);
  assert(r12.success === false, 'no API key returns success=false');
  assert(r12.error?.message?.includes('API key') ?? false, 'error mentions API key');

  if (origKey) process.env['MINIMAX_API_KEY'] = origKey;

  // ── 13. Multiple agents on same adapter ───────────────────────────────────
  section('13. Multiple agents on same adapter');

  const a13 = new MiniMaxAdapter();
  a13.registerAgent('agent-a', { model: 'MiniMax-M2.5', client: makeChatClient('response A') });
  a13.registerAgent('agent-b', { model: 'MiniMax-M2.5-highspeed', client: makeChatClient('response B') });

  const agents13 = await a13.listAgents();
  assert(agents13.length === 2, 'two agents registered');

  const rA = await a13.executeAgent('agent-a', defaultPayload, defaultContext);
  const rB = await a13.executeAgent('agent-b', defaultPayload, defaultContext);
  assert((rA.data as Record<string,unknown>)['output'] === 'response A', 'agent-a returns its own response');
  assert((rB.data as Record<string,unknown>)['output'] === 'response B', 'agent-b returns its own response');

  // ── 14. Capabilities ─────────────────────────────────────────────────────
  section('14. Capabilities');

  const caps = new MiniMaxAdapter().capabilities;
  assert(caps.parallel === true, 'capabilities.parallel is true');
  assert(caps.authentication === true, 'capabilities.authentication is true');
  assert(caps.discovery === true, 'capabilities.discovery is true');
  assert(caps.streaming === false, 'capabilities.streaming is false (sync adapter)');
  assert(caps.statefulSessions === false, 'capabilities.statefulSessions is false');

  // ── 15. Type exports smoke check ─────────────────────────────────────────
  section('15. Type exports');

  const configCheck: MiniMaxAgentConfig = { model: 'MiniMax-M2.5', temperature: 0.7 };
  assert(configCheck.model === 'MiniMax-M2.5', 'MiniMaxAgentConfig type usable');

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${c.bold}Results: ${c.green}${passed} passed${c.reset}${c.bold}, ${failed > 0 ? c.red : c.green}${failed} failed${c.reset}`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
