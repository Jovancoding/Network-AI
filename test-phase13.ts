/**
 * test-phase13.ts
 *
 * v5.11.0 feature tests:
 *   Phase 1 — ESM dual-build (package.json exports map + tsconfig.esm.json)
 *   Phase 2 — Streamable HTTP MCP transport + resources/* + prompts/*
 *   Phase 3 — PhasePipeline DAG checkpoint / resume
 *   Phase 4 — SemanticMemory file-backed persistence
 */

import { join, resolve } from 'path';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function pass(label: string) {
  passed++;
  process.stdout.write(`  ✓ ${label}\n`);
}

function fail(label: string, reason: string) {
  failed++;
  failures.push(`${label}: ${reason}`);
  process.stdout.write(`  ✗ ${label} — ${reason}\n`);
}

function assert(condition: boolean, label: string, detail = '') {
  if (condition) pass(label);
  else fail(label, detail || 'assertion failed');
}

function header(title: string) {
  process.stdout.write(`\n=== ${title} ===\n`);
}

const TMP = join('.', 'data', 'test-phase13-tmp');
function ensureTmp() { mkdirSync(TMP, { recursive: true }); }
function cleanTmp() { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } }

// ---------------------------------------------------------------------------
// PHASE 1 — ESM dual-build
// ---------------------------------------------------------------------------

async function testEsmBuildConfig() {
  header('Phase 1 — ESM dual-build configuration');

  const pkg = JSON.parse(readFileSync('./package.json', 'utf-8')) as Record<string, unknown>;

  // exports map exists
  const exports = pkg['exports'] as Record<string, unknown> | undefined;
  assert(typeof exports === 'object' && exports !== null, 'package.json has exports field');

  // root export has both require and import
  const root = exports?.['.'] as Record<string, unknown> | undefined;
  assert(typeof root?.['require'] === 'string', 'root export has require (CJS)');
  assert(typeof root?.['import'] === 'string', 'root export has import (ESM)');
  assert(typeof root?.['types'] === 'string', 'root export has types');

  // ESM path points to dist/esm/
  const importPath = root?.['import'] as string;
  assert(importPath?.includes('dist/esm'), 'import path points to dist/esm/');

  // module field exists
  assert(typeof pkg['module'] === 'string', 'package.json has module field');
  assert((pkg['module'] as string).includes('dist/esm'), 'module field points to dist/esm/');

  // tsconfig.esm.json exists
  assert(existsSync('./tsconfig.esm.json'), 'tsconfig.esm.json exists');

  const tscEsm = JSON.parse(readFileSync('./tsconfig.esm.json', 'utf-8')) as Record<string, unknown>;
  const co = tscEsm['compilerOptions'] as Record<string, unknown>;
  assert(co?.['module'] === 'Node16', 'tsconfig.esm.json uses module: Node16');
  assert((co?.['outDir'] as string)?.includes('dist/esm'), 'tsconfig.esm.json outDir is dist/esm');

  // security and adapters sub-exports exist
  const secExport = exports?.['./security'] as Record<string, unknown> | undefined;
  assert(typeof secExport?.['import'] === 'string', './security export has import');
  assert(typeof secExport?.['require'] === 'string', './security export has require');

  // build:esm script exists
  const scripts = pkg['scripts'] as Record<string, unknown>;
  assert(typeof scripts?.['build:esm'] === 'string', 'build:esm script exists');
  assert(typeof scripts?.['build:cjs'] === 'string', 'build:cjs script exists');
}

// ---------------------------------------------------------------------------
// PHASE 2 — Streamable HTTP MCP transport
// ---------------------------------------------------------------------------

async function testStreamableServerInstantiates() {
  header('Phase 2a — McpStreamableServer instantiation');

  const { McpStreamableServer } = await import('./lib/mcp-transport-http');
  const { McpCombinedBridge } = await import('./lib/mcp-transport-sse');

  const bridge = new McpCombinedBridge('test-bridge');
  const server = new McpStreamableServer(bridge, {
    port: 3099,
    secret: 'test-secret-xyz',
  });

  assert(server instanceof McpStreamableServer, 'McpStreamableServer instantiates');
  assert(server.port === 3099, 'port is 3099');
  assert(server.clientCount === 0, 'starts with 0 clients');
}

async function testStreamableServerRejectsEmptySecret() {
  header('Phase 2b — McpStreamableServer rejects empty secret (fail-closed)');

  const { McpStreamableServer } = await import('./lib/mcp-transport-http');
  const { McpCombinedBridge } = await import('./lib/mcp-transport-sse');

  const bridge = new McpCombinedBridge('test');
  const server = new McpStreamableServer(bridge);

  let threw = false;
  try { await server.listen(); }
  catch { threw = true; }
  assert(threw, 'listen() rejects when secret is empty');
}

async function testStreamableServerDispatch() {
  header('Phase 2c — McpStreamableServer dispatch (initialize, tools/list, resources/list, prompts/list)');

  const { McpStreamableServer, OrchestrationPromptProvider } = await import('./lib/mcp-transport-http');
  const { McpCombinedBridge } = await import('./lib/mcp-transport-sse');

  const bridge = new McpCombinedBridge('test-dispatch');
  const server = new McpStreamableServer(bridge, { port: 3098, secret: 'test' });

  // Dispatch via the private method by starting/stopping the server
  // Instead test via HTTP after listen
  await server.listen();

  const makeReq = (method: string, params?: unknown) =>
    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? {} });

  const http = require('http') as typeof import('http');

  const post = (body: string): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: 3098, path: '/mcp', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test', 'Content-Length': Buffer.byteLength(body) },
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.end(body);
    });

  // initialize returns 2025-03-26 protocol version
  const init = await post(makeReq('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } }));
  const initResult = init['result'] as Record<string, unknown>;
  assert(initResult?.['protocolVersion'] === '2025-03-26', 'initialize returns protocolVersion 2025-03-26');
  const caps = initResult?.['capabilities'] as Record<string, unknown>;
  assert(typeof caps?.['resources'] === 'object', 'capabilities includes resources');
  assert(typeof caps?.['prompts'] === 'object', 'capabilities includes prompts');

  // tools/list
  const toolsList = await post(makeReq('tools/list'));
  assert(Array.isArray((toolsList['result'] as Record<string, unknown>)?.['tools']), 'tools/list returns array');

  // resources/list — no providers registered → empty array
  const resList = await post(makeReq('resources/list'));
  assert(Array.isArray((resList['result'] as Record<string, unknown>)?.['resources']), 'resources/list returns array');
  assert(((resList['result'] as Record<string, unknown>)?.['resources'] as unknown[]).length === 0, 'resources/list is empty with no provider');

  // prompts/list — no providers registered → empty array
  const promptsList = await post(makeReq('prompts/list'));
  assert(Array.isArray((promptsList['result'] as Record<string, unknown>)?.['prompts']), 'prompts/list returns array');

  // Register OrchestrationPromptProvider and check prompts/list
  server.registerPrompt(new OrchestrationPromptProvider());
  const promptsList2 = await post(makeReq('prompts/list'));
  const prompts = (promptsList2['result'] as Record<string, unknown>)?.['prompts'] as unknown[];
  assert(prompts.length >= 2, `prompts/list returns ≥2 prompts after registration (got ${prompts.length})`);

  // prompts/get
  const promptGet = await post(makeReq('prompts/get', { name: 'orchestrate', arguments: { goal: 'test goal' } }));
  const messages = (promptGet['result'] as Record<string, unknown>)?.['messages'] as unknown[];
  assert(Array.isArray(messages) && messages.length > 0, 'prompts/get returns messages');

  // prompts/get unknown → error
  const unknownPrompt = await post(makeReq('prompts/get', { name: 'nonexistent' }));
  assert(typeof unknownPrompt['error'] === 'object', 'prompts/get unknown name returns error');

  // resources/read unknown URI → error
  const unknownRes = await post(makeReq('resources/read', { uri: 'unknown://foo' }));
  assert(typeof unknownRes['error'] === 'object', 'resources/read unknown URI returns error');

  // health endpoint
  const healthResp = await new Promise<Record<string, unknown>>((resolve, reject) => {
    http.get(`http://127.0.0.1:3098/health`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
  assert(healthResp['status'] === 'ok', 'health endpoint returns ok');
  assert(healthResp['protocolVersion'] === '2025-03-26', 'health returns protocolVersion 2025-03-26');

  await server.close();
}

async function testBlackboardResourceProvider() {
  header('Phase 2d — BlackboardResourceProvider');

  const { BlackboardResourceProvider } = await import('./lib/mcp-transport-http');

  const store: Record<string, unknown> = { 'agent-status': 'active', 'budget': 1000 };
  const provider = new BlackboardResourceProvider(
    async (key: string) => store[key],
    async () => Object.keys(store),
  );

  const resources = provider.listResources();
  assert(resources.length === 1, 'lists one static resource entry');
  assert(resources[0].uri === 'network-ai://blackboard', 'resource URI is correct');

  // read a key
  const keyContent = await provider.readResource('network-ai://blackboard/agent-status');
  assert(keyContent !== null, 'readResource returns content for known key');
  assert(keyContent!.text?.includes('active') === true, 'content includes the value');

  // list (no key)
  const listContent = await provider.readResource('network-ai://blackboard');
  assert(listContent !== null, 'readResource returns content for root URI');
  assert(listContent!.text?.includes('agent-status') === true, 'root content lists keys');

  // unrelated URI → null
  const nullContent = await provider.readResource('other://foo');
  assert(nullContent === null, 'readResource returns null for unknown URI');
}

// ---------------------------------------------------------------------------
// PHASE 3 — PhasePipeline checkpoint / resume
// ---------------------------------------------------------------------------

import { PhasePipeline } from './lib/phase-pipeline';
import { AdapterRegistry } from './adapters/adapter-registry';
import { BaseAdapter } from './adapters/base-adapter';
import type { AgentPayload, AgentContext, AgentResult } from './types/agent-adapter';

class MockAdapter extends BaseAdapter {
  readonly name: string;
  readonly version = '1.0.0';
  constructor(name = 'mock') { super(); this.name = name; }
  async executeAgent(_agentId: string, _payload: AgentPayload, _ctx: AgentContext): Promise<AgentResult> {
    return { success: true, data: 'done', metadata: {} };
  }
}

async function makeRegistry(): Promise<AdapterRegistry> {
  const r = new AdapterRegistry();
  const adapter = new MockAdapter('mock');
  await r.addAdapter(adapter);
  r.setDefaultAdapter('mock');
  return r;
}

async function testCheckpointSave() {
  header('Phase 3a — checkpoint saved after each phase');
  ensureTmp();

  const checkpointPath = join(TMP, 'pipeline.checkpoint.json');
  const registry = await makeRegistry();

  const pipeline = new PhasePipeline(
    registry,
    { agentId: 'test', sessionId: 'test', metadata: {} },
    {
      phases: [
        { name: 'phase-1', agents: ['mock'] },
        { name: 'phase-2', agents: ['mock'] },
      ],
      checkpointPath,
    }
  );

  await pipeline.run({ action: 'test', params: {} });

  assert(existsSync(checkpointPath), 'checkpoint file created after run');

  const cp = JSON.parse(readFileSync(checkpointPath, 'utf-8')) as Record<string, unknown>;
  assert(cp['version'] === 1, 'checkpoint version is 1');
  assert(cp['nextPhaseIndex'] === 2, `nextPhaseIndex is 2 (all phases done, got ${cp['nextPhaseIndex']})`);
  assert(Array.isArray(cp['completedPhases']) && (cp['completedPhases'] as unknown[]).length === 2, `checkpoint has 2 completed phases (got ${(cp['completedPhases'] as unknown[])?.length})`);
}

async function testCheckpointResume() {
  header('Phase 3b — pipeline resumes from checkpoint, skipping completed phases');
  ensureTmp();

  const checkpointPath = join(TMP, 'pipeline-resume.checkpoint.json');
  const registry = await makeRegistry();
  const executionOrder: string[] = [];

  const pipeline1 = new PhasePipeline(
    registry,
    { agentId: 'test', sessionId: 'test', metadata: {} },
    {
      phases: [
        { name: 'phase-1', agents: ['mock'], payloadFactory: () => { executionOrder.push('phase-1'); return { action: 'p1', params: {} }; } },
        { name: 'phase-2', agents: ['mock'], payloadFactory: () => { executionOrder.push('phase-2'); return { action: 'p2', params: {} }; } },
        { name: 'phase-3', agents: ['mock'], payloadFactory: () => { executionOrder.push('phase-3'); return { action: 'p3', params: {} }; } },
      ],
      checkpointPath,
    }
  );

  // Manually create a checkpoint at nextPhaseIndex=1 (phase-1 already done)
  const fakeCheckpoint = {
    version: 1,
    savedAt: new Date().toISOString(),
    nextPhaseIndex: 1,
    completedPhases: [{
      phaseName: 'phase-1',
      status: 'completed',
      agentResults: [['mock', { success: true, data: 'done', metadata: {} }]],
      durationMs: 10,
    }],
  };
  writeFileSync(checkpointPath, JSON.stringify(fakeCheckpoint));

  executionOrder.length = 0;
  const result = await pipeline1.run({ action: 'test', params: {} });

  assert(!executionOrder.includes('phase-1'), 'phase-1 was skipped (already checkpointed)');
  assert(executionOrder.includes('phase-2'), 'phase-2 ran during resume');
  assert(executionOrder.includes('phase-3'), 'phase-3 ran during resume');
  assert(result.phases.length === 3, `pipeline result has 3 phases (got ${result.phases.length})`);
}

async function testCheckpointClear() {
  header('Phase 3c — PhasePipeline.clearCheckpoint() removes the file');
  ensureTmp();

  const checkpointPath = join(TMP, 'to-clear.checkpoint.json');
  writeFileSync(checkpointPath, '{}');
  assert(existsSync(checkpointPath), 'file exists before clear');

  PhasePipeline.clearCheckpoint(checkpointPath);
  assert(!existsSync(checkpointPath), 'file removed after clearCheckpoint()');
}

// ---------------------------------------------------------------------------
// PHASE 4 — SemanticMemory file-backed persistence
// ---------------------------------------------------------------------------

import { SemanticMemory } from './lib/semantic-search';

// Deterministic stub embedding: returns a fixed 3-dim vector based on text hash
function stubEmbed(text: string): Promise<number[]> {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  const v = [(h & 0xff) / 255, ((h >> 4) & 0xff) / 255, ((h >> 8) & 0xff) / 255];
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return Promise.resolve(v.map(x => x / mag));
}

async function testSemanticMemoryPersist() {
  header('Phase 4a — SemanticMemory save() / load() round-trip');
  ensureTmp();

  const indexPath = join(TMP, 'semantic-index.json');

  const mem1 = new SemanticMemory(stubEmbed, { persistPath: indexPath });
  await mem1.index('task:1', 'quarterly revenue analysis', { status: 'done' }, 'analyst');
  await mem1.index('task:2', 'customer churn prediction', { status: 'pending' }, 'ml-agent');
  mem1.save();

  assert(existsSync(indexPath), 'index file created after save()');

  // Load into a fresh instance
  const mem2 = new SemanticMemory(stubEmbed, { persistPath: indexPath });
  mem2.load();

  assert(mem2.size() === 2, `loaded 2 entries (got ${mem2.size()})`);

  const results = await mem2.search('revenue', 5);
  assert(results.length > 0, 'search returns results after load');
  assert(results[0].key === 'task:1' || results[0].key === 'task:2', 'result key is one of indexed keys');
}

async function testSemanticMemoryAutoSave() {
  header('Phase 4b — autoSave=true in index() flushes to disk');
  ensureTmp();

  const indexPath = join(TMP, 'semantic-autosave.json');
  const mem = new SemanticMemory(stubEmbed, { persistPath: indexPath });

  await mem.index('doc:1', 'automated test content', 'value-1', 'tester', true);
  assert(existsSync(indexPath), 'index file created by autoSave after index()');

  const mem2 = new SemanticMemory(stubEmbed, { persistPath: indexPath });
  mem2.load();
  assert(mem2.size() === 1, `loaded 1 entry after autoSave (got ${mem2.size()})`);
}

async function testSemanticMemoryNoPersistPath() {
  header('Phase 4c — save()/load() are no-ops without persistPath');

  const mem = new SemanticMemory(stubEmbed);
  await mem.index('k', 'some text', 'v', 'agent');
  // Should not throw
  mem.save();
  mem.load();
  assert(mem.size() === 1, `entry still present after no-op save/load (got ${mem.size()})`);
}

async function testSemanticMemoryClearPersisted() {
  header('Phase 4d — clearPersisted() removes the index file');
  ensureTmp();

  const indexPath = join(TMP, 'semantic-toclear.json');
  const mem = new SemanticMemory(stubEmbed, { persistPath: indexPath });
  await mem.index('k', 'text', 'v', 'a');
  mem.save();
  assert(existsSync(indexPath), 'file exists before clearPersisted()');
  mem.clearPersisted();
  assert(!existsSync(indexPath), 'file removed after clearPersisted()');
}

async function testSemanticMemoryLoadMissingFile() {
  header('Phase 4e — load() on missing file is a no-op');
  ensureTmp();

  const mem = new SemanticMemory(stubEmbed, { persistPath: join(TMP, 'does-not-exist.json') });
  mem.load(); // must not throw
  assert(mem.size() === 0, `empty after load() on missing file (got ${mem.size()})`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  try {
    await testEsmBuildConfig();
    await testStreamableServerInstantiates();
    await testStreamableServerRejectsEmptySecret();
    await testStreamableServerDispatch();
    await testBlackboardResourceProvider();
    await testCheckpointSave();
    await testCheckpointResume();
    await testCheckpointClear();
    await testSemanticMemoryPersist();
    await testSemanticMemoryAutoSave();
    await testSemanticMemoryNoPersistPath();
    await testSemanticMemoryClearPersisted();
    await testSemanticMemoryLoadMissingFile();
  } finally {
    cleanTmp();
  }

  process.stdout.write('\n--- Results ---\n');
  process.stdout.write(`Passed: ${passed}\nFailed: ${failed}\n`);
  if (failures.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failures) process.stdout.write(`  • ${f}\n`);
  } else {
    process.stdout.write('\nAll tests passed.\n');
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  process.stderr.write(`Unhandled error: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
