/**
 * test-a2a.ts — A2A Protocol Adapter Test Suite
 *
 * Tests:
 *   - A2AAdapter initialisation
 *   - registerLocalA2AAgent()
 *   - executeAgent() success path (happy-path mock fetch)
 *   - executeAgent() error paths: not found, HTTP error, A2A error, task failed
 *   - fetchAgentCard failure
 *   - registerRemoteAgent() with mock fetch
 *   - Capabilities / listAgents
 *
 * Run: npx ts-node test-a2a.ts
 */

import { A2AAdapter } from './adapters/a2a-adapter';
import type { A2ATaskResponse } from './adapters/a2a-adapter';
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

// ─── Mock fetch factory ───────────────────────────────────────────────────────

function mockFetch(responses: Map<string, { status: number; body: unknown }>): typeof fetch {
  return async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;

    // Find the first matching key in the map (prefix match)
    let matchedKey: string | undefined;
    for (const key of responses.keys()) {
      if (url.includes(key)) { matchedKey = key; break; }
    }

    const entry = matchedKey ? responses.get(matchedKey)! : undefined;
    if (!entry) {
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    }

    return new Response(JSON.stringify(entry.body), {
      status: entry.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

/** Build a minimal valid A2A task response */
function taskResponse(
  state: 'completed' | 'failed' | 'canceled',
  outputText?: string,
  errorCode?: number,
): A2ATaskResponse {
  if (errorCode !== undefined) {
    return { jsonrpc: '2.0', id: 'tid', error: { code: errorCode, message: 'A2A error' } };
  }
  return {
    jsonrpc: '2.0',
    id: 'tid',
    result: {
      id: 'tid',
      status: { state },
      artifacts: outputText
        ? [{ parts: [{ type: 'text', text: outputText }] }]
        : [],
    },
  };
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

const ctx: AgentContext = { agentId: 'tester', taskId: 'a2a-test' };

function payload(instruction: string): AgentPayload {
  return {
    action: 'delegate',
    params: {},
    handoff: {
      handoffId: 'h1',
      sourceAgent: 'tester',
      targetAgent: 'a2a-agent',
      taskType: 'delegate',
      instruction,
    },
  };
}

// ─── 1. Initialisation & capabilities ────────────────────────────────────────

async function testInit(): Promise<void> {
  section('A2AAdapter — initialisation & capabilities');

  const adapter = new A2AAdapter();
  assert(!adapter.isReady(), 'Not ready before initialize()');

  await adapter.initialize({});
  assert(adapter.isReady(), 'Ready after initialize()');
  assert(adapter.name === 'a2a', 'Adapter name is "a2a"');
  assert(adapter.capabilities.authentication === true, 'Declares authentication capability');
  assert(adapter.capabilities.discovery === true, 'Declares discovery capability');

  await adapter.shutdown();
  assert(!adapter.isReady(), 'Not ready after shutdown()');
}

// ─── 2. registerLocalA2AAgent & listAgents ───────────────────────────────────

async function testRegisterLocal(): Promise<void> {
  section('A2AAdapter — registerLocalA2AAgent');

  const adapter = new A2AAdapter();
  await adapter.initialize({});

  adapter.registerLocalA2AAgent('writer', {
    name: 'Writing Agent',
    description: 'Drafts documents',
    version: '1.2.0',
    capabilities: { streaming: false },
    taskEndpoint: 'https://writer.example.com/tasks',
  });

  const agents = await adapter.listAgents();
  assert(agents.length === 1, 'One agent registered');
  assert(agents[0].id === 'writer', 'Agent id is "writer"');
  assert(agents[0].name === 'Writing Agent', 'Agent name set correctly');
  assert(await adapter.isAgentAvailable('writer'), 'Agent available check returns true');
  assert(!(await adapter.isAgentAvailable('ghost')), 'Unknown agent not available');
}

// ─── 3. executeAgent — happy path ────────────────────────────────────────────

async function testExecuteSuccess(): Promise<void> {
  section('A2AAdapter — executeAgent success');

  const fetch = mockFetch(new Map([
    ['/tasks', { status: 200, body: taskResponse('completed', 'Report generated: 18% YoY growth') }],
  ]));

  const adapter = new A2AAdapter();
  await adapter.initialize({ fetchImpl: fetch });

  adapter.registerLocalA2AAgent('analyst', {
    name: 'Analyst',
    taskEndpoint: 'https://analyst.example.com/tasks',
  });

  const result = await adapter.executeAgent('analyst', payload('Analyze Q4 revenue'), ctx);
  assert(result.success === true, 'Success result returned');
  assert((result.data as any).state === 'completed', 'Task state is completed');
  assert(
    (result.data as any).output === 'Report generated: 18% YoY growth',
    'Output text extracted from artifact',
  );
  assert(result.metadata?.['adapter'] === 'a2a', 'Adapter name in metadata');
}

// ─── 4. executeAgent — agent not found ───────────────────────────────────────

async function testExecuteNotFound(): Promise<void> {
  section('A2AAdapter — executeAgent agent not found');

  const adapter = new A2AAdapter();
  await adapter.initialize({});

  const result = await adapter.executeAgent('ghost', payload('noop'), ctx);
  assert(result.success === false, 'Failure result for unknown agent');
  assert(result.error?.code === 'AGENT_NOT_FOUND', 'Error code AGENT_NOT_FOUND');
  assert(result.error?.recoverable === false, 'Not recoverable');
}

// ─── 5. executeAgent — HTTP error ────────────────────────────────────────────

async function testExecuteHttpError(): Promise<void> {
  section('A2AAdapter — executeAgent HTTP error');

  const fetch = mockFetch(new Map([
    ['/tasks', { status: 503, body: { error: 'Service Unavailable' } }],
  ]));

  const adapter = new A2AAdapter();
  await adapter.initialize({ fetchImpl: fetch });

  adapter.registerLocalA2AAgent('flaky', {
    name: 'Flaky Agent',
    taskEndpoint: 'https://flaky.example.com/tasks',
  });

  const result = await adapter.executeAgent('flaky', payload('do something'), ctx);
  assert(result.success === false, 'Failure result on HTTP error');
  assert(
    result.error?.message?.includes('HTTP 503') ?? false,
    'Error message contains HTTP status code',
  );
}

// ─── 6. executeAgent — A2A-level error in body ───────────────────────────────

async function testExecuteA2AError(): Promise<void> {
  section('A2AAdapter — A2A JSON-RPC error in response body');

  const fetch = mockFetch(new Map([
    ['/tasks', { status: 200, body: taskResponse('completed', undefined, -32600) }],
  ]));

  const adapter = new A2AAdapter();
  await adapter.initialize({ fetchImpl: fetch });

  adapter.registerLocalA2AAgent('errorer', {
    name: 'Errorer',
    taskEndpoint: 'https://errorer.example.com/tasks',
  });

  const result = await adapter.executeAgent('errorer', payload('noop'), ctx);
  assert(result.success === false, 'Failure result for A2A JSON-RPC error');
  assert(result.error?.code?.startsWith('A2A_ERROR_') ?? false, 'Error code prefixed A2A_ERROR_');
}

// ─── 7. executeAgent — task failed state ─────────────────────────────────────

async function testExecuteTaskFailed(): Promise<void> {
  section('A2AAdapter — task ended in failed state');

  const fetch = mockFetch(new Map([
    ['/tasks', { status: 200, body: taskResponse('failed') }],
  ]));

  const adapter = new A2AAdapter();
  await adapter.initialize({ fetchImpl: fetch });

  adapter.registerLocalA2AAgent('bad-agent', {
    name: 'Bad Agent',
    taskEndpoint: 'https://bad.example.com/tasks',
  });

  const result = await adapter.executeAgent('bad-agent', payload('noop'), ctx);
  assert(result.success === false, 'Failure result for failed task state');
  assert(result.error?.code === 'A2A_TASK_FAILED', 'Error code A2A_TASK_FAILED');
}

// ─── 8. executeAgent — task canceled state ───────────────────────────────────

async function testExecuteTaskCanceled(): Promise<void> {
  section('A2AAdapter — task ended in canceled state');

  const fetch = mockFetch(new Map([
    ['/tasks', { status: 200, body: taskResponse('canceled') }],
  ]));

  const adapter = new A2AAdapter();
  await adapter.initialize({ fetchImpl: fetch });

  adapter.registerLocalA2AAgent('cancel-agent', {
    name: 'Cancel Agent',
    taskEndpoint: 'https://cancel.example.com/tasks',
  });

  const result = await adapter.executeAgent('cancel-agent', payload('noop'), ctx);
  assert(result.success === false, 'Failure result for canceled task state');
  assert(result.error?.code === 'A2A_TASK_CANCELED', 'Error code A2A_TASK_CANCELED');
}

// ─── 9. registerRemoteAgent — fetches card then registers ────────────────────

async function testRegisterRemote(): Promise<void> {
  section('A2AAdapter — registerRemoteAgent (mock fetch)');

  const agentCard = {
    name: 'Remote Analyst',
    description: 'Hosted financial analysis agent',
    version: '2.0.0',
    capabilities: { streaming: true },
    taskEndpoint: 'https://remote.example.com/tasks',
  };

  const fetch = mockFetch(new Map([
    ['/.well-known/agent.json', { status: 200, body: agentCard }],
    ['/tasks', { status: 200, body: taskResponse('completed', 'All good') }],
  ]));

  const adapter = new A2AAdapter();
  await adapter.initialize({ fetchImpl: fetch });

  await adapter.registerRemoteAgent('remote-analyst', 'https://remote.example.com');

  const agents = await adapter.listAgents();
  assert(agents.length === 1, 'Remote agent registered after card fetch');
  assert(agents[0].name === 'Remote Analyst', 'Agent name from card');
  assert(agents[0].metadata?.['a2aBaseUrl'] === 'https://remote.example.com', 'Base URL in metadata');

  const result = await adapter.executeAgent('remote-analyst', payload('Analyze'), ctx);
  assert(result.success === true, 'Remote agent executes successfully');
}

// ─── 10. registerRemoteAgent — card fetch 404 ────────────────────────────────

async function testRegisterRemoteNotFound(): Promise<void> {
  section('A2AAdapter — registerRemoteAgent card fetch fails');

  const fetch = mockFetch(new Map()); // empty — all 404s

  const adapter = new A2AAdapter();
  await adapter.initialize({ fetchImpl: fetch });

  let threw = false;
  try {
    await adapter.registerRemoteAgent('bad', 'https://bad.example.com');
  } catch (_) {
    threw = true;
  }
  assert(threw, 'registerRemoteAgent throws when card fetch fails');
}

// ─── 11. Multiple artifacts — text extraction ────────────────────────────────

async function testMultipleArtifacts(): Promise<void> {
  section('A2AAdapter — multiple artifacts text extraction');

  const multiResponse: A2ATaskResponse = {
    jsonrpc: '2.0',
    id: 'tid',
    result: {
      id: 'tid',
      status: { state: 'completed' },
      artifacts: [
        { name: 'part1', parts: [{ type: 'text', text: 'First' }] },
        { name: 'part2', parts: [{ type: 'text', text: 'Second' }] },
        { name: 'data',  parts: [{ type: 'data', data: { foo: 1 } }] }, // non-text; ignored
      ],
    },
  };

  const fetch = mockFetch(new Map([
    ['/tasks', { status: 200, body: multiResponse }],
  ]));

  const adapter = new A2AAdapter();
  await adapter.initialize({ fetchImpl: fetch });

  adapter.registerLocalA2AAgent('multi', {
    name: 'Multi-artifact Agent',
    taskEndpoint: 'https://multi.example.com/tasks',
  });

  const result = await adapter.executeAgent('multi', payload('extract'), ctx);
  assert(result.success === true, 'Multi-artifact response succeeds');
  assert((result.data as any).output === 'First\nSecond', 'Multiple text artifacts joined with newline');
}

// ─── 12. Not-ready guard ─────────────────────────────────────────────────────

async function testNotReadyGuard(): Promise<void> {
  section('A2AAdapter — ensureReady guard');

  const adapter = new A2AAdapter();
  // deliberately NOT calling initialize()

  adapter.registerLocalA2AAgent('early', {
    name: 'Early Agent',
    taskEndpoint: 'https://example.com/tasks',
  });

  let threw = false;
  try {
    await adapter.executeAgent('early', payload('noop'), ctx);
  } catch (_) {
    threw = true;
  }
  assert(threw, 'executeAgent throws when adapter not initialized');
}

// ─── Run all ──────────────────────────────────────────────────────────────────

async function runAllTests(): Promise<void> {
  console.log(`\n${c.bold}+========================================================+${c.reset}`);
  console.log(`${c.bold}|     A2A Protocol Adapter Test Suite                     |${c.reset}`);
  console.log(`${c.bold}+========================================================+${c.reset}`);

  try {
    await testInit();
    await testRegisterLocal();
    await testExecuteSuccess();
    await testExecuteNotFound();
    await testExecuteHttpError();
    await testExecuteA2AError();
    await testExecuteTaskFailed();
    await testExecuteTaskCanceled();
    await testRegisterRemote();
    await testRegisterRemoteNotFound();
    await testMultipleArtifacts();
    await testNotReadyGuard();
  } catch (err) {
    console.log(`\n${c.red}FATAL: ${err}${c.reset}`);
    if (err instanceof Error) console.log(err.stack);
    failed++;
  }

  const total = passed + failed;
  console.log(`\n${c.bold}=======================================================${c.reset}`);
  if (failed === 0) {
    console.log(`${c.green}${c.bold}  ALL ${total} A2A TESTS PASSED [v]${c.reset}`);
  } else {
    console.log(`${c.red}${c.bold}  ${failed} of ${total} TESTS FAILED${c.reset}`);
  }
  console.log(`${c.bold}=======================================================${c.reset}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

runAllTests();
