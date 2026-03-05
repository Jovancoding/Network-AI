/**
 * test-streaming.ts — Streaming Adapter Test Suite
 *
 * Tests:
 *   - StreamingBaseAdapter fallback (single-chunk wrapper around executeAgent)
 *   - CustomStreamingAdapter with async-generator handlers
 *   - CustomStreamingAdapter fallback for plain promise handlers
 *   - LangChainStreamingAdapter with a streamable runnable
 *   - LangChainStreamingAdapter fallback for non-streamable runnables
 *   - collectStream() helper
 *   - supportsStreaming() detection
 *
 * Run: npx ts-node test-streaming.ts
 */

import { StreamingBaseAdapter, collectStream } from './adapters/streaming-base-adapter';
import { CustomStreamingAdapter } from './adapters/custom-streaming-adapter';
import { LangChainStreamingAdapter } from './adapters/langchain-streaming-adapter';
import type { AgentPayload, AgentContext, AgentResult } from './types/agent-adapter';
import type { StreamingChunk } from './types/streaming-adapter';

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

// ─── Concrete StreamingBaseAdapter for tests ─────────────────────────────────

class ConcreteStreamingAdapter extends StreamingBaseAdapter {
  readonly name = 'test-streaming-base' as const;
  readonly version = '1.0.0';

  async executeAgent(
    agentId: string,
    payload: AgentPayload,
    _context: AgentContext,
  ): Promise<AgentResult> {
    if (agentId === 'greet') {
      const name = (payload.params?.name as string) ?? 'world';
      return this.successResult(`Hello, ${name}!`, 1);
    }
    return this.errorResult('NOT_FOUND', `Agent "${agentId}" not found`, false);
  }
}

// ─── Shared context / payload helpers ────────────────────────────────────────

const ctx: AgentContext = { agentId: 'tester', taskId: 'test-stream' };

function payload(instruction: string, params?: Record<string, unknown>): AgentPayload {
  return {
    action: 'stream',
    params: params ?? {},
    handoff: {
      handoffId: 'h1',
      sourceAgent: 'tester',
      targetAgent: 'target',
      taskType: 'delegate',
      instruction,
    },
  };
}

// ─── 1. StreamingBaseAdapter — fallback wrapper ───────────────────────────────

async function testStreamingBaseAdapter(): Promise<void> {
  section('StreamingBaseAdapter — single-chunk fallback');

  const adapter = new ConcreteStreamingAdapter();
  await adapter.initialize({});

  // supportsStreaming is false by default
  assert(adapter.supportsStreaming('greet') === false, 'supportsStreaming returns false by default');

  // collect success result
  const { output, chunks } = await collectStream(
    adapter.executeAgentStream('greet', payload('ignored', { name: 'Alice' }), ctx),
  );
  assert(output === 'Hello, Alice!', 'Fallback stream yields correct text');
  assert(chunks.length === 2, 'Fallback emits 2 chunks (content + done sentinel)');
  assert(chunks[chunks.length - 1].done === true, 'Last chunk has done=true');
  assert(chunks[0].done === false, 'Content chunk has done=false');

  // collect error result
  const errStream = await collectStream(
    adapter.executeAgentStream('missing', payload('noop'), ctx),
  );
  assert(errStream.chunks.length === 1, 'Error emits single done-chunk');
  assert(errStream.chunks[0].done === true, 'Error chunk has done=true');
  assert(
    errStream.chunks[0].metadata?.['error'] === true,
    'Error chunk carries error metadata',
  );
}

// ─── 2. collectStream() helper ────────────────────────────────────────────────

async function testCollectStream(): Promise<void> {
  section('collectStream() helper');

  async function* fakeStream(): AsyncIterable<StreamingChunk> {
    yield { text: 'Hel', done: false };
    yield { text: 'lo ', done: false };
    yield { text: 'world', done: false };
    yield { text: '', done: true };
  }

  const { output, chunks } = await collectStream(fakeStream());
  assert(output === 'Hello world', 'collectStream concatenates text chunks correctly');
  assert(chunks.length === 4, 'collectStream preserves all chunks');
}

// ─── 3. CustomStreamingAdapter — async generator handler ─────────────────────

async function testCustomStreamingAdapterGenerator(): Promise<void> {
  section('CustomStreamingAdapter — async generator handler');

  const adapter = new CustomStreamingAdapter();
  await adapter.initialize({});

  // Async generator handler
  adapter.registerHandler(
    'counter',
    async function* (p: AgentPayload) {
      const n = (p.params?.count as number) ?? 3;
      for (let i = 1; i <= n; i++) {
        yield `${i}`;
        await new Promise(res => setTimeout(res, 1));
      }
    } as any,
  );
  adapter.markStreaming('counter');

  assert(adapter.supportsStreaming('counter') === true, 'Generator handler marked as streaming');

  const { output, chunks } = await collectStream(
    adapter.executeAgentStream('counter', payload('count', { count: 3 }), ctx),
  );
  assert(output === '123', 'Generator handler streams tokens correctly');
  assert(chunks[chunks.length - 1].done === true, 'Generator stream ends with done=true');
}

// ─── 4. CustomStreamingAdapter — plain promise handler (fallback) ─────────────

async function testCustomStreamingAdapterPromise(): Promise<void> {
  section('CustomStreamingAdapter — plain promise handler (single-chunk)');

  const adapter = new CustomStreamingAdapter();
  await adapter.initialize({});

  adapter.registerHandler('adder', async (p: AgentPayload) => {
    const a = (p.params?.a as number) ?? 0;
    const b = (p.params?.b as number) ?? 0;
    return { sum: a + b };
  });

  assert(adapter.supportsStreaming('adder') === false, 'Plain handler not marked as streaming');

  const { output, chunks } = await collectStream(
    adapter.executeAgentStream('adder', payload('add', { a: 3, b: 4 }), ctx),
  );
  assert(JSON.parse(output).sum === 7, 'Plain handler result serialised correctly');
  assert(chunks.length === 2, 'Plain handler emits content + done chunks');
}

// ─── 5. CustomStreamingAdapter — unknown agent ───────────────────────────────

async function testCustomStreamingAdapterUnknown(): Promise<void> {
  section('CustomStreamingAdapter — unknown agent error');

  const adapter = new CustomStreamingAdapter();
  await adapter.initialize({});

  const { chunks } = await collectStream(
    adapter.executeAgentStream('ghost', payload('noop'), ctx),
  );
  assert(chunks.length === 1, 'Unknown agent yields single error chunk');
  assert(chunks[0].done === true, 'Error chunk has done=true');
  assert(
    chunks[0].metadata?.['error'] === true,
    'Error chunk carries error flag',
  );
}

// ─── 6. LangChainStreamingAdapter — streamable runnable ──────────────────────

async function testLangChainStreamingAdapterStream(): Promise<void> {
  section('LangChainStreamingAdapter — streamable runnable');

  const adapter = new LangChainStreamingAdapter();
  await adapter.initialize({});

  // Runnable with .stream() method
  const streamableRunnable = {
    invoke: async (_input: unknown) => ({ output: 'Full non-streaming response' }),
    stream: async function* (_input: unknown): AsyncIterable<unknown> {
      const words = ['The ', 'answer ', 'is ', '42.'];
      for (const w of words) {
        yield w;
        await new Promise(res => setTimeout(res, 1));
      }
    },
  };

  adapter.registerAgent('oracle', streamableRunnable, { description: 'Test streaming oracle' });
  assert(adapter.supportsStreaming('oracle') === true, 'Streamable runnable detected');

  const { output, chunks } = await collectStream(
    adapter.executeAgentStream('oracle', payload('What is the answer?'), ctx),
  );
  assert(output === 'The answer is 42.', 'LangChain stream yields correct concatenated text');
  assert(chunks[chunks.length - 1].done === true, 'LangChain stream ends cleanly');
  assert(chunks.length >= 5, 'Multiple chunks emitted (one per word + done)');
}

// ─── 7. LangChainStreamingAdapter — non-streamable runnable (fallback) ────────

async function testLangChainStreamingAdapterFallback(): Promise<void> {
  section('LangChainStreamingAdapter — non-streamable runnable (fallback)');

  const adapter = new LangChainStreamingAdapter();
  await adapter.initialize({});

  // Runnable without .stream()
  const basicRunnable = {
    invoke: async (_input: unknown) => ({ output: 'Fallback response data' }),
  };

  adapter.registerAgent('basic', basicRunnable, { description: 'No streaming' });
  assert(adapter.supportsStreaming('basic') === false, 'Non-streamable runnable not marked');

  const { output, chunks } = await collectStream(
    adapter.executeAgentStream('basic', payload('Do the thing'), ctx),
  );
  assert(output === 'Fallback response data', 'Fallback yields correct result text');
  assert(chunks[chunks.length - 1].done === true, 'Fallback stream ends cleanly');
}

// ─── 8. LangChainStreamingAdapter — yields AIMessage-shaped chunks ────────────

async function testLangChainStreamingAIMessage(): Promise<void> {
  section('LangChainStreamingAdapter — AIMessage chunk shape');

  const adapter = new LangChainStreamingAdapter();
  await adapter.initialize({});

  const aiMessageRunnable = {
    invoke: async (_input: unknown) => ({ output: 'unused' }),
    stream: async function* (_input: unknown): AsyncIterable<unknown> {
      // LangChain ChatOpenAI.stream() yields AIMessage-like objects
      yield { content: 'Chat ' };
      yield { content: 'response.' };
    },
  };

  adapter.registerAgent('chat', aiMessageRunnable);
  const { output } = await collectStream(
    adapter.executeAgentStream('chat', payload('hello'), ctx),
  );
  assert(output === 'Chat response.', 'AIMessage .content field extracted correctly');
}

// ─── 9. LangChainStreamingAdapter — unknown agent ────────────────────────────

async function testLangChainStreamingUnknown(): Promise<void> {
  section('LangChainStreamingAdapter — unknown agent');

  const adapter = new LangChainStreamingAdapter();
  await adapter.initialize({});

  const { chunks } = await collectStream(
    adapter.executeAgentStream('ghost', payload('noop'), ctx),
  );
  assert(chunks.length >= 1, 'Unknown agent yields at least one error chunk');
  assert(chunks[chunks.length - 1].done === true, 'Error chunk has done=true');
}

// ─── 10. StreamingChunk types are correct ────────────────────────────────────

async function testStreamingChunkTypes(): Promise<void> {
  section('StreamingChunk — type shapes');

  const contentChunk: StreamingChunk = { text: 'hello', done: false };
  const doneChunk: StreamingChunk = { text: '', done: true, metadata: { adapter: 'test' } };

  assert(contentChunk.text === 'hello' && contentChunk.done === false, 'Content chunk shape correct');
  assert(doneChunk.done === true && doneChunk.metadata?.['adapter'] === 'test', 'Done chunk shape correct');
}

// ─── Run all ──────────────────────────────────────────────────────────────────

async function runAllTests(): Promise<void> {
  console.log(`\n${c.bold}+=====================================================+${c.reset}`);
  console.log(`${c.bold}|       Streaming Adapter Test Suite                   |${c.reset}`);
  console.log(`${c.bold}+=====================================================+${c.reset}`);

  try {
    await testStreamingBaseAdapter();
    await testCollectStream();
    await testCustomStreamingAdapterGenerator();
    await testCustomStreamingAdapterPromise();
    await testCustomStreamingAdapterUnknown();
    await testLangChainStreamingAdapterStream();
    await testLangChainStreamingAdapterFallback();
    await testLangChainStreamingAIMessage();
    await testLangChainStreamingUnknown();
    await testStreamingChunkTypes();
  } catch (err) {
    console.log(`\n${c.red}FATAL: ${err}${c.reset}`);
    if (err instanceof Error) console.log(err.stack);
    failed++;
  }

  const total = passed + failed;
  console.log(`\n${c.bold}=======================================================${c.reset}`);
  if (failed === 0) {
    console.log(`${c.green}${c.bold}  ALL ${total} STREAMING TESTS PASSED [v]${c.reset}`);
  } else {
    console.log(`${c.red}${c.bold}  ${failed} of ${total} TESTS FAILED${c.reset}`);
  }
  console.log(`${c.bold}=======================================================${c.reset}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

runAllTests();
