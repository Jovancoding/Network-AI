/**
 * Phase 5 Part 7 -- MCP Networking Tests
 *
 * Tests for lib/mcp-bridge.ts:
 *   - McpBlackboardBridge (construction, handleRPC, listTools, callTool)
 *   - McpInProcessTransport (send)
 *   - McpBridgeClient (listTools, callTool, sendRaw, error propagation)
 *   - McpBridgeRouter (register, unregister, has, listBridges, route, getClient)
 *   - JSON-RPC 2.0 error handling (MethodNotFound, InvalidParams, InvalidRequest)
 *   - Integration: write-then-read round trip via client
 *   - Integration: multi-board routing via McpBridgeRouter
 *
 * No real Redis, file I/O, or network connections -- all in-process.
 * Run with: npx ts-node test-phase5g.ts
 */

import {
  McpBlackboardBridge,
  McpBridgeClient,
  McpBridgeRouter,
  McpInProcessTransport,
  type McpJsonRpcRequest,
  type McpJsonRpcResponse,
  type McpListToolsResult,
  type McpCallToolResult,
  type McpTransport,
} from './lib/mcp-bridge';

import {
  BlackboardMCPTools,
  type IBlackboard,
} from './lib/mcp-blackboard-tools';

import { MemoryBackend } from './lib/blackboard-backend';

// ============================================================================
// TEST HARNESS
// ============================================================================

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  [PASS] ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.log(`  [FAIL] ${message}`);
  }
}

function assertThrows(fn: () => unknown, expectedSubstring: string, message: string): void {
  try {
    fn();
    failed++;
    failures.push(message);
    console.log(`  [FAIL] ${message} (no error thrown)`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes(expectedSubstring)) {
      passed++;
      console.log(`  [PASS] ${message}`);
    } else {
      failed++;
      failures.push(`${message} (wrong error: ${msg})`);
      console.log(`  [FAIL] ${message} (wrong error: "${msg}")`);
    }
  }
}

async function assertThrowsAsync(
  fn: () => Promise<unknown>,
  expectedSubstring: string,
  message: string
): Promise<void> {
  try {
    await fn();
    failed++;
    failures.push(message);
    console.log(`  [FAIL] ${message} (no error thrown)`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes(expectedSubstring)) {
      passed++;
      console.log(`  [PASS] ${message}`);
    } else {
      failed++;
      failures.push(`${message} (wrong error: ${msg})`);
      console.log(`  [FAIL] ${message} (wrong error: "${msg}")`);
    }
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// ============================================================================
// HELPERS -- minimal IBlackboard backed by MemoryBackend
// ============================================================================

function makeBlackboard(): IBlackboard {
  const backend = new MemoryBackend();

  return {
    read(key) {
      const entry = backend.read(key);
      if (!entry) return null;
      return { key: entry.key, value: entry.value, sourceAgent: entry.source_agent, timestamp: entry.timestamp, ttl: entry.ttl };
    },
    write(key, value, sourceAgent) {
      const e = backend.write(key, value, sourceAgent);
      return { key: e.key, value: e.value, sourceAgent: e.source_agent, timestamp: e.timestamp, ttl: e.ttl };
    },
    exists(key) {
      return backend.read(key) !== null;
    },
    getSnapshot() {
      const snap: Record<string, { key: string; value: unknown; sourceAgent: string; timestamp: string; ttl: number | null }> = {};
      for (const k of backend.listKeys()) {
        const e = backend.read(k)!;
        snap[k] = { key: e.key, value: e.value, sourceAgent: e.source_agent, timestamp: e.timestamp, ttl: e.ttl };
      }
      return snap;
    },
    delete(key) {
      backend.delete(key);
    },
  };
}

// ============================================================================
// MAIN -- async wrapper required for CommonJS (no top-level await)
// ============================================================================

(async function main() {

// ============================================================================
// SECTION 1: McpBlackboardBridge -- CONSTRUCTION
// ============================================================================

section('1. McpBlackboardBridge -- construction');

{
  const board = makeBlackboard();
  const bridge = new McpBlackboardBridge(board);
  assert(bridge instanceof McpBlackboardBridge, 'constructs from IBlackboard');
  assert(bridge.name === 'blackboard', 'default name is "blackboard"');
}

{
  const board = makeBlackboard();
  const bridge = new McpBlackboardBridge(board, { name: 'prod' });
  assert(bridge.name === 'prod', 'custom name stored');
}

{
  // Also accepts a pre-built BlackboardMCPTools instance
  const board = makeBlackboard();
  const tools = new BlackboardMCPTools(board);
  const bridge = new McpBlackboardBridge(tools);
  assert(bridge instanceof McpBlackboardBridge, 'constructs from BlackboardMCPTools');
}

// ============================================================================
// SECTION 2: McpBlackboardBridge -- listTools() direct
// ============================================================================

section('2. McpBlackboardBridge -- listTools()');

{
  const bridge = new McpBlackboardBridge(makeBlackboard());
  const tools = bridge.listTools();
  assert(Array.isArray(tools), 'listTools returns array');
  assert(tools.length === 5, 'five tools exposed');
  const names = tools.map(t => t.name);
  assert(names.includes('blackboard_read'),   'blackboard_read tool present');
  assert(names.includes('blackboard_write'),  'blackboard_write tool present');
  assert(names.includes('blackboard_list'),   'blackboard_list tool present');
  assert(names.includes('blackboard_delete'), 'blackboard_delete tool present');
  assert(names.includes('blackboard_exists'), 'blackboard_exists tool present');
}

{
  // Each tool has a description and inputSchema
  const bridge = new McpBlackboardBridge(makeBlackboard());
  for (const tool of bridge.listTools()) {
    assert(typeof tool.description === 'string' && tool.description.length > 0, `${tool.name} has description`);
    assert(typeof tool.inputSchema === 'object', `${tool.name} has inputSchema`);
  }
}

// ============================================================================
// SECTION 3: McpBlackboardBridge -- callTool() direct
// ============================================================================

section('3. McpBlackboardBridge -- callTool() direct');

{
  const board = makeBlackboard();
  const bridge = new McpBlackboardBridge(board);

  // Write then read
  const writeResult = await bridge.callTool('blackboard_write', {
    key: 'status',
    value: '"active"',
    agent_id: 'agent-1',
  });
  assert(writeResult.ok === true, 'direct callTool write succeeds');

  const readResult = await bridge.callTool('blackboard_read', {
    key: 'status',
    agent_id: 'agent-1',
  });
  assert(readResult.ok === true, 'direct callTool read succeeds');
  assert((readResult.data as { value: unknown } | null)?.value === 'active', 'read returns written value');
}

{
  const bridge = new McpBlackboardBridge(makeBlackboard());
  const result = await bridge.callTool('unknown_tool', { agent_id: 'x' });
  assert(result.ok === false, 'unknown tool returns ok:false');
  assert(typeof result.error === 'string', 'unknown tool returns error string');
}

// ============================================================================
// SECTION 4: McpBlackboardBridge -- handleRPC() tools/list
// ============================================================================

section('4. McpBlackboardBridge -- handleRPC tools/list');

{
  const bridge = new McpBlackboardBridge(makeBlackboard());
  const response = await bridge.handleRPC({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert(response.jsonrpc === '2.0', 'response has jsonrpc field');
  assert(response.id === 1, 'response id matches request id');
  assert(response.error === undefined, 'no error on success');
  const result = response.result as McpListToolsResult;
  assert(Array.isArray(result.tools), 'result.tools is array');
  assert(result.tools.length === 5, 'result.tools has 5 entries');
}

{
  // String ID is preserved
  const bridge = new McpBlackboardBridge(makeBlackboard());
  const response = await bridge.handleRPC({ jsonrpc: '2.0', id: 'req-abc', method: 'tools/list' });
  assert(response.id === 'req-abc', 'string id preserved in response');
}

{
  // Null id (notification) is allowed
  const bridge = new McpBlackboardBridge(makeBlackboard());
  const response = await bridge.handleRPC({ jsonrpc: '2.0', id: null, method: 'tools/list' });
  assert(response.id === null, 'null id preserved');
  assert(response.error === undefined, 'no error on null-id request');
}

// ============================================================================
// SECTION 5: McpBlackboardBridge -- handleRPC() tools/call
// ============================================================================

section('5. McpBlackboardBridge -- handleRPC tools/call');

{
  const board = makeBlackboard();
  board.write('greeting', 'hello', 'test');
  const bridge = new McpBlackboardBridge(board);

  const response = await bridge.handleRPC({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'blackboard_read', arguments: { key: 'greeting', agent_id: 'test' } },
  });
  assert(response.error === undefined, 'no error on valid tools/call');
  const callResult = response.result as McpCallToolResult;
  assert(Array.isArray(callResult.content), 'result.content is array');
  assert(callResult.content.length === 1, 'one content block');
  assert(callResult.content[0].type === 'text', 'content block type is text');
  assert(typeof callResult.content[0].text === 'string', 'content block text is string');
  assert(callResult.isError === false, 'isError is false for successful call');

  const toolResult = JSON.parse(callResult.content[0].text);
  assert(toolResult.ok === true, 'parsed tool result ok is true');
  assert(toolResult.data !== null, 'parsed tool result has data');
}

{
  // tools/call with unknown tool -- isError true, no protocol error
  const bridge = new McpBlackboardBridge(makeBlackboard());
  const response = await bridge.handleRPC({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'nonexistent_tool', arguments: { agent_id: 'x' } },
  });
  assert(response.error === undefined, 'unknown tool does not cause RPC error');
  const callResult = response.result as McpCallToolResult;
  assert(callResult.isError === true, 'isError true for unknown tool');
}

{
  // Blackboard_write round trip via handleRPC
  const board = makeBlackboard();
  const bridge = new McpBlackboardBridge(board);

  await bridge.handleRPC({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'blackboard_write', arguments: { key: 'x', value: '"42"', agent_id: 'a' } },
  });

  const readResp = await bridge.handleRPC({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'blackboard_read', arguments: { key: 'x', agent_id: 'a' } },
  });
  const result = JSON.parse((readResp.result as McpCallToolResult).content[0].text);
  assert(result.data?.value === '42', 'write+read round trip via handleRPC');
}

// ============================================================================
// SECTION 6: McpBlackboardBridge -- handleRPC() error cases
// ============================================================================

section('6. McpBlackboardBridge -- handleRPC error cases');

{
  // Wrong jsonrpc version
  const bridge = new McpBlackboardBridge(makeBlackboard());
  const response = await bridge.handleRPC({ jsonrpc: '1.0' as '2.0', id: 1, method: 'tools/list' });
  assert(response.error !== undefined, 'wrong jsonrpc version returns error');
  assert(response.error!.code === -32600, 'error code is InvalidRequest (-32600)');
}

{
  // Unknown method
  const bridge = new McpBlackboardBridge(makeBlackboard());
  const response = await bridge.handleRPC({ jsonrpc: '2.0', id: 1, method: 'unknown/method' });
  assert(response.error !== undefined, 'unknown method returns error');
  assert(response.error!.code === -32601, 'error code is MethodNotFound (-32601)');
}

{
  // tools/call with missing params
  const bridge = new McpBlackboardBridge(makeBlackboard());
  const response = await bridge.handleRPC({ jsonrpc: '2.0', id: 1, method: 'tools/call' });
  assert(response.error !== undefined, 'tools/call with no params returns error');
  assert(response.error!.code === -32603, 'internal error code for missing params');
}

{
  // tools/call with params but missing "name"
  const bridge = new McpBlackboardBridge(makeBlackboard());
  const response = await bridge.handleRPC({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { arguments: {} },
  });
  assert(response.error !== undefined, 'tools/call without name returns error');
}

{
  // tools/call with params.arguments as non-object
  const bridge = new McpBlackboardBridge(makeBlackboard());
  const response = await bridge.handleRPC({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'blackboard_read', arguments: 'not-an-object' },
  });
  assert(response.error !== undefined, 'tools/call with non-object arguments returns error');
}

// ============================================================================
// SECTION 7: McpInProcessTransport
// ============================================================================

section('7. McpInProcessTransport');

{
  const bridge = new McpBlackboardBridge(makeBlackboard());
  const transport = new McpInProcessTransport(bridge);

  const response = await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert(response.jsonrpc === '2.0', 'transport send returns valid JSON-RPC response');
  assert(response.error === undefined, 'no error on tools/list via transport');
  assert((response.result as McpListToolsResult).tools.length === 5, 'all tools returned via transport');
}

{
  // nextId increments
  const transport = new McpInProcessTransport(new McpBlackboardBridge(makeBlackboard()));
  const ids = [transport.nextId(), transport.nextId(), transport.nextId()];
  assert(ids[0] === 1 && ids[1] === 2 && ids[2] === 3, 'nextId increments correctly');
}

{
  // Transport is stateless between calls -- each send is independent
  const bridge = new McpBlackboardBridge(makeBlackboard());
  const transport = new McpInProcessTransport(bridge);

  const r1 = await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const r2 = await transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert(r1.id === 1 && r2.id === 2, 'transport preserves id on each send');
}

// ============================================================================
// SECTION 8: McpBridgeClient -- listTools()
// ============================================================================

section('8. McpBridgeClient -- listTools()');

{
  const client = new McpBridgeClient(new McpInProcessTransport(new McpBlackboardBridge(makeBlackboard())));
  const tools = await client.listTools();
  assert(Array.isArray(tools), 'listTools returns array');
  assert(tools.length === 5, 'five tools returned');
  assert(tools.every(t => typeof t.name === 'string'), 'all tools have string name');
}

{
  // Tools list includes correct names
  const client = new McpBridgeClient(new McpInProcessTransport(new McpBlackboardBridge(makeBlackboard())));
  const tools = await client.listTools();
  const names = tools.map(t => t.name);
  assert(names.includes('blackboard_read'),   'blackboard_read in client tool list');
  assert(names.includes('blackboard_write'),  'blackboard_write in client tool list');
  assert(names.includes('blackboard_list'),   'blackboard_list in client tool list');
  assert(names.includes('blackboard_delete'), 'blackboard_delete in client tool list');
  assert(names.includes('blackboard_exists'), 'blackboard_exists in client tool list');
}

// ============================================================================
// SECTION 9: McpBridgeClient -- callTool()
// ============================================================================

section('9. McpBridgeClient -- callTool()');

{
  // Write via client
  const board = makeBlackboard();
  const client = new McpBridgeClient(new McpInProcessTransport(new McpBlackboardBridge(board)));
  const result = await client.callTool('blackboard_write', {
    key: 'mission',
    value: '"explore"',
    agent_id: 'rover',
  });
  assert(result.ok === true, 'callTool write succeeds');
  assert(result.tool === 'blackboard_write', 'result.tool matches');
}

{
  // Read via client after write
  const board = makeBlackboard();
  const bridge = new McpBlackboardBridge(board);
  const client = new McpBridgeClient(new McpInProcessTransport(bridge));

  await client.callTool('blackboard_write', { key: 'color', value: '"blue"', agent_id: 'agent-1' });
  const readResult = await client.callTool('blackboard_read', { key: 'color', agent_id: 'agent-1' });
  assert(readResult.ok === true, 'read succeeds after write');
  assert((readResult.data as { value: unknown })?.value === 'blue', 'read returns written value');
}

{
  // exists via client
  const board = makeBlackboard();
  const client = new McpBridgeClient(new McpInProcessTransport(new McpBlackboardBridge(board)));
  await client.callTool('blackboard_write', { key: 'flag', value: 'true', agent_id: 'a' });
  const result = await client.callTool('blackboard_exists', { key: 'flag', agent_id: 'a' });
  assert(result.ok === true, 'exists check succeeds');
  assert((result.data as { exists: boolean }).exists === true, 'exists returns true for written key');
}

{
  // exists returns false for missing key
  const board = makeBlackboard();
  const client = new McpBridgeClient(new McpInProcessTransport(new McpBlackboardBridge(board)));
  const result = await client.callTool('blackboard_exists', { key: 'nope', agent_id: 'a' });
  assert(result.ok === true, 'exists check for missing key is not an error');
  assert((result.data as { exists: boolean }).exists === false, 'exists returns false for missing key');
}

{
  // delete via client
  const board = makeBlackboard();
  const client = new McpBridgeClient(new McpInProcessTransport(new McpBlackboardBridge(board)));
  await client.callTool('blackboard_write', { key: 'tmp', value: '"x"', agent_id: 'a' });
  const del = await client.callTool('blackboard_delete', { key: 'tmp', agent_id: 'a' });
  assert(del.ok === true, 'delete succeeds');
  const ex = await client.callTool('blackboard_exists', { key: 'tmp', agent_id: 'a' });
  assert((ex.data as { exists: boolean }).exists === false, 'key gone after delete');
}

{
  // list via client
  const board = makeBlackboard();
  const client = new McpBridgeClient(new McpInProcessTransport(new McpBlackboardBridge(board)));
  await client.callTool('blackboard_write', { key: 'a:1', value: '"v1"', agent_id: 'ag' });
  await client.callTool('blackboard_write', { key: 'a:2', value: '"v2"', agent_id: 'ag' });
  await client.callTool('blackboard_write', { key: 'b:1', value: '"v3"', agent_id: 'ag' });

  const list = await client.callTool('blackboard_list', { agent_id: 'ag', prefix: 'a:' });
  assert(list.ok === true, 'list with prefix succeeds');
  assert((list.data as { count: number }).count === 2, 'list prefix filters correctly');
}

{
  // Unknown tool -- ok:false, no throw
  const client = new McpBridgeClient(new McpInProcessTransport(new McpBlackboardBridge(makeBlackboard())));
  const result = await client.callTool('not_a_tool', { agent_id: 'x' });
  assert(result.ok === false, 'unknown tool returns ok:false via client');
  assert(typeof result.error === 'string', 'unknown tool returns error string');
}

{
  // Missing required arg -- ok:false, no throw
  const client = new McpBridgeClient(new McpInProcessTransport(new McpBlackboardBridge(makeBlackboard())));
  const result = await client.callTool('blackboard_read', { agent_id: 'x' }); // missing key
  assert(result.ok === false, 'missing required arg returns ok:false via client');
}

// ============================================================================
// SECTION 10: McpBridgeClient -- sendRaw()
// ============================================================================

section('10. McpBridgeClient -- sendRaw()');

{
  const client = new McpBridgeClient(new McpInProcessTransport(new McpBlackboardBridge(makeBlackboard())));
  const response = await client.sendRaw('tools/list');
  assert(response.jsonrpc === '2.0', 'sendRaw returns JSON-RPC response');
  assert(response.error === undefined, 'sendRaw tools/list has no error');
}

{
  // sendRaw with unknown method throws
  const client = new McpBridgeClient(new McpInProcessTransport(new McpBlackboardBridge(makeBlackboard())));
  await assertThrowsAsync(
    () => client.sendRaw('bad/method'),
    'MCP error',
    'sendRaw throws on unknown method'
  );
}

// ============================================================================
// SECTION 11: McpBridgeClient -- error propagation
// ============================================================================

section('11. McpBridgeClient -- error propagation');

{
  // Client throws on JSON-RPC protocol errors (not tool-level errors)
  const client = new McpBridgeClient(new McpInProcessTransport(new McpBlackboardBridge(makeBlackboard())));
  await assertThrowsAsync(
    () => client.sendRaw('tools/call', { tools_call_bad: true }),
    'MCP error',
    'client throws on invalid tools/call params'
  );
}

{
  // Custom transport that always returns an error
  const errorTransport: McpTransport = {
    async send(req) {
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32603, message: 'Simulated transport failure' },
      };
    },
  };
  const client = new McpBridgeClient(errorTransport);
  await assertThrowsAsync(
    () => client.listTools(),
    'Simulated transport failure',
    'client throws when transport returns error'
  );
}

{
  // Custom transport relays correct id in error
  const errorTransport: McpTransport = {
    async send(req) {
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32601, message: 'Not found', data: { method: req.method } },
      };
    },
  };
  const client = new McpBridgeClient(errorTransport);
  let thrownCode: number | undefined;
  try {
    await client.listTools();
  } catch (err: unknown) {
    thrownCode = (err as { code?: number }).code;
  }
  assert(thrownCode === -32601, 'error code propagated on thrown error');
}

// ============================================================================
// SECTION 12: McpBridgeRouter -- registration
// ============================================================================

section('12. McpBridgeRouter -- registration');

{
  const router = new McpBridgeRouter();
  assert(router.listBridges().length === 0, 'empty router has no bridges');
}

{
  const router = new McpBridgeRouter();
  const bridge = new McpBlackboardBridge(makeBlackboard(), { name: 'prod' });
  router.register('prod', bridge);
  assert(router.has('prod'), 'has() returns true after register');
  assert(router.listBridges().includes('prod'), 'listBridges includes registered name');
}

{
  // Duplicate registration throws
  const router = new McpBridgeRouter();
  const bridge = new McpBlackboardBridge(makeBlackboard());
  router.register('x', bridge);
  assertThrows(
    () => router.register('x', new McpBlackboardBridge(makeBlackboard())),
    'already registered',
    'duplicate registration throws'
  );
}

{
  // Empty name throws
  const router = new McpBridgeRouter();
  assertThrows(
    () => router.register('', new McpBlackboardBridge(makeBlackboard())),
    'non-empty string',
    'empty name throws on register'
  );
}

{
  // getBridge throws for unregistered name
  const router = new McpBridgeRouter();
  assertThrows(
    () => router.getBridge('unknown'),
    'no bridge registered',
    'getBridge throws for unknown name'
  );
}

{
  // getBridge returns correct bridge
  const router = new McpBridgeRouter();
  const bridge = new McpBlackboardBridge(makeBlackboard(), { name: 'alpha' });
  router.register('alpha', bridge);
  assert(router.getBridge('alpha') === bridge, 'getBridge returns same instance');
}

// ============================================================================
// SECTION 13: McpBridgeRouter -- unregister
// ============================================================================

section('13. McpBridgeRouter -- unregister');

{
  const router = new McpBridgeRouter();
  router.register('a', new McpBlackboardBridge(makeBlackboard()));
  const removed = router.unregister('a');
  assert(removed === true, 'unregister returns true for registered bridge');
  assert(!router.has('a'), 'bridge no longer present after unregister');
}

{
  const router = new McpBridgeRouter();
  const removed = router.unregister('nope');
  assert(removed === false, 'unregister returns false for unknown name');
}

{
  // Can re-register after unregister
  const router = new McpBridgeRouter();
  router.register('slot', new McpBlackboardBridge(makeBlackboard()));
  router.unregister('slot');
  router.register('slot', new McpBlackboardBridge(makeBlackboard())); // should not throw
  assert(router.has('slot'), 'can re-register after unregister');
}

// ============================================================================
// SECTION 14: McpBridgeRouter -- route()
// ============================================================================

section('14. McpBridgeRouter -- route()');

{
  const router = new McpBridgeRouter();
  router.register('main', new McpBlackboardBridge(makeBlackboard()));

  const response = await router.route('main', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert(response.error === undefined, 'route returns success for valid request');
  assert((response.result as McpListToolsResult).tools.length === 5, 'route returns tools list');
}

{
  // route to unknown board throws
  const router = new McpBridgeRouter();
  await assertThrowsAsync(
    () => router.route('missing', { jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    'no bridge registered',
    'route throws for unknown board name'
  );
}

// ============================================================================
// SECTION 15: McpBridgeRouter -- getClient()
// ============================================================================

section('15. McpBridgeRouter -- getClient()');

{
  const board = makeBlackboard();
  const router = new McpBridgeRouter();
  router.register('alpha', new McpBlackboardBridge(board));

  const client = router.getClient('alpha');
  assert(client instanceof McpBridgeClient, 'getClient returns McpBridgeClient');

  const tools = await client.listTools();
  assert(tools.length === 5, 'client from getClient lists all tools');
}

{
  // getClient throws for unknown board
  const router = new McpBridgeRouter();
  assertThrows(
    () => router.getClient('ghost'),
    'no bridge registered',
    'getClient throws for unknown board'
  );
}

{
  // Each call to getClient returns a new client instance
  const router = new McpBridgeRouter();
  router.register('b', new McpBlackboardBridge(makeBlackboard()));
  const c1 = router.getClient('b');
  const c2 = router.getClient('b');
  assert(c1 !== c2, 'getClient returns new client each call');
}

// ============================================================================
// SECTION 16: INTEGRATION -- write-then-read round trip via client
// ============================================================================

section('16. Integration -- write-then-read round trip');

{
  const board = makeBlackboard();
  const bridge = new McpBlackboardBridge(board);
  const client = new McpBridgeClient(new McpInProcessTransport(bridge));

  // Write three entries
  await client.callTool('blackboard_write', { key: 'task:1', value: '"pending"', agent_id: 'planner' });
  await client.callTool('blackboard_write', { key: 'task:2', value: '"running"', agent_id: 'planner' });
  await client.callTool('blackboard_write', { key: 'task:3', value: '"done"',    agent_id: 'planner' });

  // List with prefix
  const list = await client.callTool('blackboard_list', { agent_id: 'planner', prefix: 'task:' });
  assert((list.data as { count: number }).count === 3, 'all three task entries listed');

  // Read each
  const r1 = await client.callTool('blackboard_read', { key: 'task:1', agent_id: 'worker' });
  const r3 = await client.callTool('blackboard_read', { key: 'task:3', agent_id: 'worker' });
  assert((r1.data as { value: unknown })?.value === 'pending', 'task:1 value correct');
  assert((r3.data as { value: unknown })?.value === 'done', 'task:3 value correct');

  // Delete task:1
  await client.callTool('blackboard_delete', { key: 'task:1', agent_id: 'planner' });
  const list2 = await client.callTool('blackboard_list', { agent_id: 'planner', prefix: 'task:' });
  assert((list2.data as { count: number }).count === 2, 'two entries after delete');
}

// ============================================================================
// SECTION 17: INTEGRATION -- multi-board routing via McpBridgeRouter
// ============================================================================

section('17. Integration -- multi-board routing via McpBridgeRouter');

{
  const prodBoard    = makeBlackboard();
  const stagingBoard = makeBlackboard();

  const router = new McpBridgeRouter();
  router.register('prod',    new McpBlackboardBridge(prodBoard,    { name: 'prod' }));
  router.register('staging', new McpBlackboardBridge(stagingBoard, { name: 'staging' }));

  assert(router.listBridges().length === 2, 'router has 2 boards');

  const prodClient    = router.getClient('prod');
  const stagingClient = router.getClient('staging');

  // Write to prod
  await prodClient.callTool('blackboard_write', { key: 'deploy:status', value: '"stable"', agent_id: 'ci' });

  // Write to staging (different value)
  await stagingClient.callTool('blackboard_write', { key: 'deploy:status', value: '"testing"', agent_id: 'ci' });

  // Read from prod
  const prodRead = await prodClient.callTool('blackboard_read', { key: 'deploy:status', agent_id: 'ci' });
  assert((prodRead.data as { value: unknown })?.value === 'stable', 'prod board has correct value');

  // Read from staging
  const stagingRead = await stagingClient.callTool('blackboard_read', { key: 'deploy:status', agent_id: 'ci' });
  assert((stagingRead.data as { value: unknown })?.value === 'testing', 'staging board has correct value');

  // Boards are completely isolated
  const prodEx    = await prodClient.callTool('blackboard_exists', { key: 'deploy:status', agent_id: 'ci' });
  const stagingEx = await stagingClient.callTool('blackboard_exists', { key: 'deploy:status', agent_id: 'ci' });
  assert((prodEx.data as { exists: boolean }).exists    === true, 'prod key exists in prod board');
  assert((stagingEx.data as { exists: boolean }).exists === true, 'staging key exists in staging board');

  // Key written to staging does not appear in prod
  prodBoard.write('unique:prod', 'only-here', 'test');
  const notInStaging = await stagingClient.callTool('blackboard_exists', { key: 'unique:prod', agent_id: 'x' });
  assert((notInStaging.data as { exists: boolean }).exists === false, 'prod-only key absent from staging board');
}

// ============================================================================
// SECTION 18: CUSTOM TRANSPORT ADAPTER PATTERN
// ============================================================================

section('18. Custom transport adapter pattern');

{
  // Demonstrates swapping transports without changing client code.
  // A "buffered" transport that records all requests before forwarding.
  const requests: McpJsonRpcRequest[] = [];
  const bridge = new McpBlackboardBridge(makeBlackboard());

  const recordingTransport: McpTransport = {
    async send(req) {
      requests.push(req);
      return bridge.handleRPC(req);
    },
  };

  const client = new McpBridgeClient(recordingTransport);
  await client.listTools();
  await client.listTools();

  assert(requests.length === 2, 'custom transport records all requests');
  assert(requests.every(r => r.method === 'tools/list'), 'recorded methods are correct');
}

{
  // Transport that injects request ID tracking
  const bridge = new McpBlackboardBridge(makeBlackboard());
  const receivedIds: (string | number | null)[] = [];

  const idTrackingTransport: McpTransport = {
    async send(req) {
      receivedIds.push(req.id);
      return bridge.handleRPC(req);
    },
  };

  const client = new McpBridgeClient(idTrackingTransport);
  await client.listTools();
  await client.listTools();
  await client.listTools();

  assert(receivedIds.length === 3, 'three requests tracked');
  // IDs should be auto-incremented: 1, 2, 3
  assert(receivedIds[0] === 1, 'first request id is 1');
  assert(receivedIds[1] === 2, 'second request id is 2');
  assert(receivedIds[2] === 3, 'third request id is 3');
}

// ============================================================================
// SUMMARY
// ============================================================================

console.log('\n' + '='.repeat(60));
console.log(`  Phase 5 Part 7 -- MCP Networking`);
console.log(`  Passed: ${passed}  Failed: ${failed}`);
console.log('='.repeat(60));

if (failures.length > 0) {
  console.log('\nFailed tests:');
  for (const f of failures) console.log(`  - ${f}`);
}

process.exit(failed > 0 ? 1 : 0);

})().catch(err => {
  console.error('Unexpected test runner error:', err);
  process.exit(1);
});
