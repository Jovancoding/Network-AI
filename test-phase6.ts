/**
 * Phase 6 — Full AI Control Tests
 *
 * Tests for:
 *   - McpCombinedBridge + McpBlackboardBridgeAdapter
 *   - McpSseServer (real HTTP server, real requests)
 *   - McpSseTransport (real HTTP POST calls)
 *   - ExtendedMcpTools (budget, token, audit)
 *   - ControlMcpTools (config_get, config_set, agent_spawn, agent_stop, fsm_transition)
 *   - Integration: full stack end-to-end via HTTP
 *   - Pre-work: maxParallelAgents no longer throws at Infinity
 *
 * No mocking — all tests use real HTTP requests on port 3099 (auto-released).
 *
 * Run with: npx ts-node test-phase6.ts
 */

import * as http from 'node:http';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { MemoryBackend } from './lib/blackboard-backend';
import { McpBlackboardBridge } from './lib/mcp-bridge';
import { type IBlackboard } from './lib/mcp-blackboard-tools';
import {
  McpSseServer,
  McpSseTransport,
  McpCombinedBridge,
  McpBlackboardBridgeAdapter,
} from './lib/mcp-transport-sse';
import { ExtendedMcpTools } from './lib/mcp-tools-extended';
import { ControlMcpTools } from './lib/mcp-tools-control';
import { FederatedBudget } from './lib/federated-budget';
import { getConfig, setConfig } from './index';

// ============================================================================
// TEST HARNESS
// ============================================================================

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    failed++;
    failures.push(msg);
    console.error(`  ✗ FAIL: ${msg}`);
  } else {
    passed++;
    console.log(`  ✓ ${msg}`);
  }
}

function suite(name: string): void {
  console.log(`\n── ${name}`);
}

// ============================================================================
// HTTP HELPERS
// ============================================================================

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', (c: Buffer) => { data += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    }).on('error', reject);
  });
}

function httpPostRaw(url: string, rawBody: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parseInt(parsed.port, 10),
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(rawBody) },
    };
    const req = http.request(options, res => {
      let data = '';
      res.on('data', (c: Buffer) => { data += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}

function httpPost(url: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed = new URL(url);
    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parseInt(parsed.port, 10),
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    };
    const req = http.request(options, res => {
      let data = '';
      res.on('data', (c: Buffer) => { data += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ============================================================================
// MOCK BLACKBOARD
// ============================================================================

function makeBlackboard(): IBlackboard {
  const store = new MemoryBackend();
  return {
    read(key: string) {
      const e = store.read(key);
      if (!e) return null;
      return { key, value: e.value, sourceAgent: e.source_agent ?? 'test', timestamp: e.timestamp ?? new Date().toISOString(), ttl: e.ttl ?? null };
    },
    write(key: string, value: unknown, sourceAgent: string, ttl?: number) {
      const entry = store.write(key, value, sourceAgent, ttl);
      return { key, value: entry.value, sourceAgent: entry.source_agent ?? sourceAgent, timestamp: entry.timestamp, ttl: entry.ttl ?? null };
    },
    exists(key: string) { return store.read(key) !== null; },
    getSnapshot() {
      const snap = store.getSnapshot();
      const result: Record<string, { key: string; value: unknown; sourceAgent: string; timestamp: string; ttl: number | null }> = {};
      for (const [k, v] of Object.entries(snap)) {
        result[k] = { key: k, value: v.value, sourceAgent: v.source_agent ?? 'test', timestamp: v.timestamp ?? new Date().toISOString(), ttl: v.ttl ?? null };
      }
      return result;
    },
    delete(key: string) { store.delete(key); },
  };
}

// ============================================================================
// SECTION 1: Pre-work — remove hard constraints
// ============================================================================

async function testConstraintsRemoved(): Promise<void> {
  suite('Pre-work: Hard constraints removed');

  // maxParallelAgents should now be Infinity
  const cfg = getConfig() as Record<string, unknown>;
  assert(cfg['maxParallelAgents'] === Infinity, 'maxParallelAgents defaults to Infinity');

  // Config is readable via getConfig(key)
  const timeout = getConfig('defaultTimeout') as number;
  assert(typeof timeout === 'number' && timeout > 0, 'getConfig("defaultTimeout") returns a number');

  // setConfig updates the value
  setConfig('maxParallelAgents', 50);
  assert(getConfig('maxParallelAgents') === 50, 'setConfig("maxParallelAgents", 50) takes effect');
  setConfig('maxParallelAgents', Infinity); // restore
  assert(getConfig('maxParallelAgents') === Infinity, 'restoring maxParallelAgents to Infinity');
}

// ============================================================================
// SECTION 2: McpCombinedBridge + McpBlackboardBridgeAdapter
// ============================================================================

async function testCombinedBridge(): Promise<void> {
  suite('McpCombinedBridge + McpBlackboardBridgeAdapter');

  const bb = makeBlackboard();
  const bridge = new McpBlackboardBridge(bb, { name: 'test-board' });
  const adapter = new McpBlackboardBridgeAdapter(bridge);

  // Adapter exposes the same 5 tool definitions
  const defs = adapter.getDefinitions();
  assert(defs.length === 5, 'adapter.getDefinitions() returns 5 tools');
  assert(defs.some(d => d.name === 'blackboard_read'), 'blackboard_read present');
  assert(defs.some(d => d.name === 'blackboard_write'), 'blackboard_write present');

  // CombinedBridge with just the adapter
  const combined = new McpCombinedBridge('test');
  combined.register(adapter);
  assert(combined.allDefinitions().length === 5, 'combined bridge has 5 tools after registering adapter');

  // tools/list via handleRPC
  const listResp = await combined.handleRPC({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert(!listResp.error, 'tools/list returns no error');
  const tools = (listResp.result as { tools: unknown[] }).tools;
  assert(Array.isArray(tools) && tools.length === 5, 'tools/list result has 5 tools');

  // tools/call blackboard_write
  const writeResp = await combined.handleRPC({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'blackboard_write', arguments: { key: 'x:1', value: '"hello"', agent_id: 'tester' } },
  });
  assert(!writeResp.error, 'blackboard_write via combined bridge: no error');

  // tools/call blackboard_read
  const readResp = await combined.handleRPC({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'blackboard_read', arguments: { key: 'x:1', agent_id: 'tester' } },
  });
  assert(!readResp.error, 'blackboard_read via combined bridge: no error');
  const content = (readResp.result as { content: Array<{ text: string }> }).content[0].text;
  const parsed = JSON.parse(content) as { ok: boolean };
  assert(parsed.ok === true, 'blackboard_read result.ok === true');

  // Unknown tool returns error
  const unknownResp = await combined.handleRPC({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'does_not_exist', arguments: {} },
  });
  assert(!!unknownResp.error, 'unknown tool returns JSON-RPC error');

  // Unknown method returns MethodNotFound
  const badMethod = await combined.handleRPC({ jsonrpc: '2.0', id: 5, method: 'tools/unknown' });
  assert(!!badMethod.error, 'unknown method returns error');
  assert(badMethod.error!.code === -32601, 'unknown method returns code -32601 (MethodNotFound)');
}

// ============================================================================
// SECTION 3: ExtendedMcpTools — Budget
// ============================================================================

async function testExtendedBudget(): Promise<void> {
  suite('ExtendedMcpTools — Budget tools');

  const budget = new FederatedBudget({ ceiling: 10000 });
  const tools = new ExtendedMcpTools({ budget });

  const defs = tools.getDefinitions();
  assert(defs.length === 10, `ExtendedMcpTools.getDefinitions() returns 10 tools (got ${defs.length})`);

  // budget_status
  const status = await tools.call('budget_status', { agent_id: 'tester' });
  assert(status.ok, 'budget_status ok');
  const sdata = status.data as { ceiling: number; remaining: number; totalSpent: number };
  assert(sdata.ceiling === 10000, `budget_status.ceiling === 10000 (got ${sdata.ceiling})`);
  assert(sdata.remaining === 10000, 'budget_status.remaining === 10000 (fresh)');
  assert(sdata.totalSpent === 0, 'budget_status.totalSpent === 0 (fresh)');

  // budget_spend — allowed
  const spend1 = await tools.call('budget_spend', { agent_id: 'agent-1', tokens: '3000' });
  assert(spend1.ok, 'budget_spend allowed ok');
  const sp1 = spend1.data as { allowed: boolean; remaining: number };
  assert(sp1.allowed === true, 'budget_spend allowed === true');
  assert(sp1.remaining === 7000, `budget_spend remaining === 7000 (got ${sp1.remaining})`);

  // budget_spend — denied (over ceiling)
  const spend2 = await tools.call('budget_spend', { agent_id: 'agent-2', tokens: '8000' });
  assert(spend2.ok, 'budget_spend denied: ok flag still true');
  const sp2 = spend2.data as { allowed: boolean };
  assert(sp2.allowed === false, 'budget_spend over ceiling: allowed === false');

  // budget_get_log
  const log = await tools.call('budget_get_log', { agent_id: 'tester' });
  assert(log.ok, 'budget_get_log ok');
  const ldata = log.data as { entries: unknown[]; total: number };
  assert(ldata.total === 1, `budget_get_log total === 1 (got ${ldata.total})`);

  // budget_set_ceiling
  const sc = await tools.call('budget_set_ceiling', { agent_id: 'tester', ceiling: '20000' });
  assert(sc.ok, `budget_set_ceiling ok (got ok=${sc.ok}, err=${sc.error})`);
  assert((sc.data as { ceiling: number }).ceiling === 20000, 'budget_set_ceiling new ceiling === 20000');

  // budget_reset — requires confirm
  const badReset = await tools.call('budget_reset', { agent_id: 'tester', confirm: 'no' });
  assert(!badReset.ok, 'budget_reset without confirm=yes returns error');

  const goodReset = await tools.call('budget_reset', { agent_id: 'tester', confirm: 'yes' });
  assert(goodReset.ok, 'budget_reset with confirm=yes succeeds');

  // budget_status after reset
  const statusAfter = await tools.call('budget_status', { agent_id: 'tester' });
  assert((statusAfter.data as { totalSpent: number }).totalSpent === 0, 'totalSpent === 0 after reset');
}

// ============================================================================
// SECTION 4: ExtendedMcpTools — Token
// ============================================================================

async function testExtendedToken(): Promise<void> {
  suite('ExtendedMcpTools — Token tools');

  // Dynamic import to avoid top-level import issues with security.ts path
  const { SecureTokenManager } = await import('./security');
  const tokenManager = new SecureTokenManager();
  const tools = new ExtendedMcpTools({ tokenManager });

  // token_create
  const create = await tools.call('token_create', { agent_id: 'agent-x', resource_type: 'FILE_SYSTEM', scope: 'read' });
  assert(create.ok, `token_create ok (err=${create.error})`);
  const tokenData = create.data as { tokenId: string; agentId: string };
  assert(typeof tokenData.tokenId === 'string' && tokenData.tokenId.length > 0, 'token_create returns tokenId');
  assert(tokenData.agentId === 'agent-x', 'token_create agentId matches');

  // token_validate — valid token
  const validate = await tools.call('token_validate', { token_json: JSON.stringify(create.data) });
  assert(validate.ok, `token_validate ok (err=${validate.error})`);
  assert((validate.data as { valid: boolean }).valid === true, 'token_validate valid === true for fresh token');

  // token_revoke
  const revoke = await tools.call('token_revoke', { token_id: tokenData.tokenId, reason: 'test revocation' });
  assert(revoke.ok, 'token_revoke ok');
  assert((revoke.data as { revoked: boolean }).revoked === true, 'token_revoke revoked === true');

  // token_validate after revoke
  const validateAfter = await tools.call('token_validate', { token_json: JSON.stringify(create.data) });
  assert(validateAfter.ok, 'token_validate after revoke: tool call ok');
  assert((validateAfter.data as { valid: boolean }).valid === false, 'token_validate after revoke: valid === false');

  // token_validate with bad JSON
  const badValidate = await tools.call('token_validate', { token_json: '{invalid}' });
  assert(!badValidate.ok, 'token_validate bad JSON returns error');

  // Missing token manager → error
  const noTools = new ExtendedMcpTools({});
  const noTM = await noTools.call('token_create', { agent_id: 'x', resource_type: 'F', scope: 's' });
  assert(!noTM.ok, 'token_create without tokenManager returns error');
}

// ============================================================================
// SECTION 5: ExtendedMcpTools — Audit
// ============================================================================

async function testExtendedAudit(): Promise<void> {
  suite('ExtendedMcpTools — Audit tools');

  const auditPath = resolve('./data/test-phase6-audit.jsonl');
  // Write test entries
  const entries = [
    { timestamp: '2026-01-01T10:00:00.000Z', eventId: 'a1', eventType: 'PERMISSION', agentId: 'agent-1', action: 'FILE_READ', outcome: 'success', details: {} },
    { timestamp: '2026-01-01T11:00:00.000Z', eventId: 'a2', eventType: 'AUTH',       agentId: 'agent-2', action: 'TOKEN_USE',  outcome: 'failure', details: {} },
    { timestamp: '2026-01-01T12:00:00.000Z', eventId: 'a3', eventType: 'PERMISSION', agentId: 'agent-1', action: 'FILE_WRITE', outcome: 'denied',  details: {} },
  ];
  writeFileSync(auditPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

  const tools = new ExtendedMcpTools({ auditLogPath: auditPath });

  // audit_tail default (20 entries)
  const tail = await tools.call('audit_tail', { n: '3' });
  assert(tail.ok, 'audit_tail ok');
  const tdata = tail.data as { entries: unknown[]; total: number };
  assert(tdata.total === 3, `audit_tail total === 3 (got ${tdata.total})`);
  assert(tdata.entries.length === 3, 'audit_tail returned 3 entries');

  // audit_query — no filters
  const all = await tools.call('audit_query', {});
  assert(all.ok, 'audit_query (no filters) ok');
  assert((all.data as { total: number }).total === 3, 'audit_query total === 3');

  // audit_query — filter by agent
  const byAgent = await tools.call('audit_query', { agent_id_filter: 'agent-1' });
  assert(byAgent.ok, 'audit_query agent filter ok');
  assert((byAgent.data as { total: number }).total === 2, 'audit_query filter agent-1 returns 2');

  // audit_query — filter by outcome
  const byOutcome = await tools.call('audit_query', { outcome_filter: 'failure' });
  assert(byOutcome.ok, 'audit_query outcome filter ok');
  assert((byOutcome.data as { total: number }).total === 1, 'audit_query filter outcome=failure returns 1');

  // audit_query — filter by since_iso
  const bySince = await tools.call('audit_query', { since_iso: '2026-01-01T11:00:00.000Z' });
  assert(bySince.ok, 'audit_query since_iso filter ok');
  assert((bySince.data as { total: number }).total === 2, 'audit_query since 11:00 returns 2');

  // Non-existent log path
  const missing = new ExtendedMcpTools({ auditLogPath: './data/does-not-exist.jsonl' });
  const missingResult = await missing.call('audit_tail', {});
  assert(missingResult.ok, 'audit_tail on missing log returns ok with empty list');
  assert((missingResult.data as { total: number }).total === 0, 'audit_tail missing log returns total 0');

  // Cleanup
  if (existsSync(auditPath)) unlinkSync(auditPath);
}

// ============================================================================
// SECTION 6: ControlMcpTools
// ============================================================================

async function testControlTools(): Promise<void> {
  suite('ControlMcpTools — config, agent, fsm, info');

  const liveConfig = { maxParallelAgents: Infinity, defaultTimeout: 30000, enableTracing: true };
  const bb = makeBlackboard();

  const tools = new ControlMcpTools({
    config: liveConfig,
    blackboard: bb as unknown as import('./lib/mcp-tools-control').IControlBlackboard,
    systemToken: 'test-token',
  });

  // config_get — all
  const allCfg = await tools.call('config_get', {});
  assert(allCfg.ok, 'config_get (all) ok');
  const cfgData = allCfg.data as Record<string, unknown>;
  assert('maxParallelAgents' in cfgData, 'config_get returns maxParallelAgents');
  assert('defaultTimeout' in cfgData, 'config_get returns defaultTimeout');

  // config_get — specific key
  const specific = await tools.call('config_get', { key: 'defaultTimeout' });
  assert(specific.ok, 'config_get (specific) ok');
  assert((specific.data as { defaultTimeout: number }).defaultTimeout === 30000, 'config_get defaultTimeout === 30000');

  // config_get — unknown key
  const unknown = await tools.call('config_get', { key: 'doesNotExist' });
  assert(!unknown.ok, 'config_get unknown key returns error');

  // config_set — number
  const setNum = await tools.call('config_set', { key: 'maxParallelAgents', value: '10' });
  assert(setNum.ok, 'config_set number ok');
  assert(liveConfig.maxParallelAgents === 10, 'config_set mutates live config object');

  // config_set — boolean
  const setBool = await tools.call('config_set', { key: 'enableTracing', value: 'false' });
  assert(setBool.ok, 'config_set boolean ok');
  assert(liveConfig.enableTracing === false, 'config_set false mutates live config');

  // agent_list — empty
  const listEmpty = await tools.call('agent_list', {});
  assert(listEmpty.ok, 'agent_list ok (empty)');
  assert((listEmpty.data as { count: number }).count === 0, 'agent_list count === 0 initially');

  // agent_spawn
  const spawn = await tools.call('agent_spawn', {
    agent_id: 'code_writer',
    task_key: 'task:write:auth',
    instruction: 'Write the auth module',
  });
  assert(spawn.ok, `agent_spawn ok (err=${spawn.error})`);
  const spawnData = spawn.data as { agentId: string; taskKey: string; blackboardWritten: boolean };
  assert(spawnData.agentId === 'code_writer', 'agent_spawn agentId correct');
  assert(spawnData.blackboardWritten === true, 'agent_spawn wrote to blackboard');
  // Verify blackboard has the task
  const taskEntry = bb.read('task:write:auth');
  assert(taskEntry !== null, 'agent_spawn: task appears on blackboard');

  // agent_stop
  const stop = await tools.call('agent_stop', { agent_id: 'code_writer', reason: 'test done' });
  assert(stop.ok, 'agent_stop ok');
  assert((stop.data as { stopped: boolean }).stopped === true, 'agent_stop stopped === true');

  // agent_list — shows stopped agent
  const listAfter = await tools.call('agent_list', {});
  assert(listAfter.ok, 'agent_list after stop ok');
  assert((listAfter.data as { count: number }).count >= 1, 'agent_list shows stopped agent');

  // fsm_transition
  const fsm = await tools.call('fsm_transition', {
    fsm_id: 'order_pipeline',
    new_state: 'processing',
    agent_id: 'orchestrator',
  });
  assert(fsm.ok, `fsm_transition ok (err=${fsm.error})`);
  const fsmData = fsm.data as { fsmId: string; transition: { to: string }; blackboardWritten: boolean };
  assert(fsmData.fsmId === 'order_pipeline', 'fsm_transition fsmId correct');
  assert(fsmData.transition.to === 'processing', 'fsm_transition to state correct');
  assert(fsmData.blackboardWritten === true, 'fsm_transition wrote to blackboard');
  // Verify state on blackboard
  const fsmState = bb.read('fsm:order_pipeline:state');
  assert(fsmState?.value === 'processing', 'fsm state on blackboard matches');

  // fsm_transition — second transition (checks history)
  await tools.call('fsm_transition', { fsm_id: 'order_pipeline', new_state: 'shipped', agent_id: 'orchestrator' });
  const history = bb.read('fsm:order_pipeline:history');
  assert(history !== null, 'fsm history entry exists');
  const historyArr = JSON.parse(String(history!.value)) as unknown[];
  assert(historyArr.length === 2, `fsm history has 2 entries (got ${historyArr.length})`);

  // orchestrator_info
  const info = await tools.call('orchestrator_info', {});
  assert(info.ok, 'orchestrator_info ok');
  const infoData = info.data as { version: string; blackboard: { available: boolean } };
  assert(infoData.version === '4.0.3', 'orchestrator_info version === 4.0.3');
  assert(infoData.blackboard.available === true, 'orchestrator_info blackboard.available === true');
}

// ============================================================================
// SECTION 7: McpSseServer + McpSseTransport (real HTTP)
// ============================================================================

const TEST_PORT = 3099;

async function testSseServer(): Promise<void> {
  suite('McpSseServer + McpSseTransport (real HTTP on port 3099)');

  const bb = makeBlackboard();
  const bridge = new McpBlackboardBridge(bb, { name: 'test' });
  const budget = new FederatedBudget({ ceiling: 50000 });
  const combined = new McpCombinedBridge('test-network-ai');
  combined.register(new McpBlackboardBridgeAdapter(bridge));
  combined.register(new ExtendedMcpTools({ budget }));

  const server = new McpSseServer(combined, { port: TEST_PORT, host: '127.0.0.1', heartbeatMs: 0 });
  await server.listen();

  try {
    // Health endpoint
    const health = await httpGet(`http://127.0.0.1:${TEST_PORT}/health`);
    assert(health.status === 200, `GET /health returns 200 (got ${health.status})`);
    const healthBody = JSON.parse(health.body) as { status: string };
    assert(healthBody.status === 'ok', 'GET /health body.status === ok');

    // Tools endpoint
    const toolsResp = await httpGet(`http://127.0.0.1:${TEST_PORT}/tools`);
    assert(toolsResp.status === 200, `GET /tools returns 200 (got ${toolsResp.status})`);
    const toolsBody = JSON.parse(toolsResp.body) as { count: number };
    assert(toolsBody.count >= 10, `GET /tools count >= 10 (got ${toolsBody.count})`);

    // 404 for unknown path
    const notFound = await httpGet(`http://127.0.0.1:${TEST_PORT}/unknown`);
    assert(notFound.status === 404, `GET /unknown returns 404 (got ${notFound.status})`);

    // POST /mcp — tools/list
    const listPost = await httpPost(`http://127.0.0.1:${TEST_PORT}/mcp`, {
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    });
    assert(listPost.status === 200, `POST /mcp tools/list returns 200 (got ${listPost.status})`);
    const listBody = JSON.parse(listPost.body) as { result: { tools: unknown[] } };
    assert(Array.isArray(listBody.result?.tools), 'POST /mcp tools/list result.tools is array');

    // POST /mcp — blackboard_write
    const writePost = await httpPost(`http://127.0.0.1:${TEST_PORT}/mcp`, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'blackboard_write', arguments: { key: 'net:status', value: '"online"', agent_id: 'srv-test' } },
    });
    assert(writePost.status === 200, `POST /mcp blackboard_write returns 200`);
    const writeBody = JSON.parse(writePost.body) as { result: { isError: boolean } };
    assert(writeBody.result?.isError === false, 'blackboard_write isError === false');

    // POST /mcp — blackboard_read
    const readPost = await httpPost(`http://127.0.0.1:${TEST_PORT}/mcp`, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'blackboard_read', arguments: { key: 'net:status', agent_id: 'srv-test' } },
    });
    assert(readPost.status === 200, 'POST /mcp blackboard_read returns 200');
    const readBody = JSON.parse(readPost.body) as { result: { content: Array<{ text: string }> } };
    const readResult = JSON.parse(readBody.result?.content?.[0]?.text ?? '{}') as { ok: boolean; data: { value: string } };
    assert(readResult.ok, 'blackboard_read via HTTP: ok === true');
    assert(readResult.data?.value === 'online', `blackboard_read via HTTP: value === "online" (got "${readResult.data?.value}")`);

    // POST /mcp — budget_status
    const budgetPost = await httpPost(`http://127.0.0.1:${TEST_PORT}/mcp`, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'budget_status', arguments: { agent_id: 'srv-test' } },
    });
    assert(budgetPost.status === 200, 'POST /mcp budget_status returns 200');
    const budgetBodyParsed = JSON.parse(budgetPost.body) as { result: { content: Array<{ text: string }> } };
    const budgetResult = JSON.parse(budgetBodyParsed.result?.content?.[0]?.text ?? '{}') as { ok: boolean; data: { ceiling: number } };
    assert(budgetResult.ok, 'budget_status via HTTP: ok === true');
    assert(budgetResult.data?.ceiling === 50000, `budget_status via HTTP: ceiling === 50000 (got ${budgetResult.data?.ceiling})`);

    // POST /mcp — invalid JSON
    const badJson = await httpPostRaw(`http://127.0.0.1:${TEST_PORT}/mcp`, '{bad json');
    assert(badJson.status === 400, 'POST /mcp invalid JSON returns 400');

    // McpSseTransport — send via transport class
    const transport = new McpSseTransport(`http://127.0.0.1:${TEST_PORT}`);
    const transportResp = await transport.send({ jsonrpc: '2.0', id: 10, method: 'tools/list' });
    assert(!transportResp.error, 'McpSseTransport.send() tools/list: no error');
    assert(Array.isArray((transportResp.result as { tools: unknown[] })?.tools), 'McpSseTransport result.tools is array');

    // clientCount
    assert(server.clientCount === 0, 'clientCount === 0 (no SSE clients connected)');

    // broadcast (no-op when no SSE clients — just verify it doesn't throw)
    server.broadcast('test_event', { hello: 'world' });
    assert(true, 'broadcast with 0 clients does not throw');

  } finally {
    await server.close();
  }
}

// ============================================================================
// SECTION 8: Integration — full combined bridge end-to-end
// ============================================================================

async function testFullIntegration(): Promise<void> {
  suite('Integration: Full combined bridge (blackboard + extended + control)');

  const bb = makeBlackboard();
  const bridge = new McpBlackboardBridge(bb, { name: 'integration' });
  const budget = new FederatedBudget({ ceiling: 100 });
  const config = { maxParallelAgents: Infinity, defaultTimeout: 30000, enableTracing: true };

  const combined = new McpCombinedBridge('integration');
  combined.register(new McpBlackboardBridgeAdapter(bridge));
  combined.register(new ExtendedMcpTools({ budget }));
  combined.register(new ControlMcpTools({
    config,
    blackboard: bb as unknown as import('./lib/mcp-tools-control').IControlBlackboard,
  }));

  // All 3 groups present
  const allDefs = combined.allDefinitions();
  const toolNames = allDefs.map(d => d.name);
  assert(toolNames.includes('blackboard_write'), 'integration: blackboard_write present');
  assert(toolNames.includes('budget_spend'), 'integration: budget_spend present');
  assert(toolNames.includes('config_set'), 'integration: config_set present');
  assert(toolNames.includes('agent_spawn'), 'integration: agent_spawn present');
  assert(toolNames.includes('fsm_transition'), 'integration: fsm_transition present');
  assert(toolNames.includes('orchestrator_info'), 'integration: orchestrator_info present');
  assert(allDefs.length >= 22, `integration: total tools >= 22 (got ${allDefs.length})`);

  // Simulate AI agent workflow:
  // 1. Write task to blackboard
  const step1 = await combined.handleRPC({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'blackboard_write', arguments: { key: 'task:1', value: '"analyze data"', agent_id: 'orchestrator' } },
  });
  assert(!step1.error, 'integration step 1: write task ok');

  // 2. Spawn agent
  const step2 = await combined.handleRPC({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'agent_spawn', arguments: { agent_id: 'data_analyst', task_key: 'task:2', instruction: 'Analyze Q3 data' } },
  });
  assert(!step2.error, 'integration step 2: spawn agent ok');

  // 3. Spend budget
  const step3 = await combined.handleRPC({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'budget_spend', arguments: { agent_id: 'data_analyst', tokens: '50' } },
  });
  assert(!step3.error, 'integration step 3: spend budget ok');

  // 4. FSM transition
  const step4 = await combined.handleRPC({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'fsm_transition', arguments: { fsm_id: 'analysis_pipeline', new_state: 'running', agent_id: 'orchestrator' } },
  });
  assert(!step4.error, 'integration step 4: fsm transition ok');

  // 5. Config set
  const step5 = await combined.handleRPC({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'config_set', arguments: { key: 'maxParallelAgents', value: '5' } },
  });
  assert(!step5.error, 'integration step 5: config_set ok');
  assert(config.maxParallelAgents === 5, 'integration step 5: config mutated to 5');

  // 6. Orchestrator info
  const step6 = await combined.handleRPC({
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'orchestrator_info', arguments: {} },
  });
  assert(!step6.error, 'integration step 6: orchestrator_info ok');
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('  Phase 6 — Full AI Control Tests');
  console.log('='.repeat(60));

  await testConstraintsRemoved();
  await testCombinedBridge();
  await testExtendedBudget();
  await testExtendedToken();
  await testExtendedAudit();
  await testControlTools();
  await testSseServer();
  await testFullIntegration();

  console.log('\n' + '='.repeat(60));
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`    ✗ ${f}`);
  }
  console.log('='.repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
