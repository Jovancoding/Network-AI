/**
 * test-phase18.ts
 *
 * v5.14.0 — Ecosystem expansion test suite:
 *   1. ClaudeHookBridge — AuthGuardian-gated coding-agent tool calls
 *      (observe/enforce modes, deny/allow patterns, audit JSONL, input parsing)
 *   2. MCP elicitation — StdioElicitationChannel request/response routing and
 *      createElicitationApprovalCallback fail-closed decision mapping
 *   3. A2AServer — agent card discovery, tasks/send / tasks/get / tasks/cancel,
 *      bearer auth, body-size limits
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AddressInfo } from 'net';
import { ClaudeHookBridge, DEFAULT_TOOL_RESOURCE_MAP } from './lib/claude-hooks';
import type { ClaudeHookInput, HookAuditEntry } from './lib/claude-hooks';
import { StdioElicitationChannel, createElicitationApprovalCallback } from './lib/mcp-elicitation';
import type { ElicitationCreateParams, ElicitationResult } from './lib/mcp-elicitation';
import { A2AServer } from './lib/a2a-server';
import type { ApprovalRequest } from './lib/agent-runtime';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];
function pass(label: string) { passed++; process.stdout.write(`  ✓ ${label}\n`); }
function fail(label: string, reason: string) { failed++; failures.push(`${label}: ${reason}`); process.stdout.write(`  ✗ ${label} — ${reason}\n`); }
function assert(cond: boolean, label: string, detail = '') { if (cond) pass(label); else fail(label, detail || 'assertion failed'); }
function header(t: string) { process.stdout.write(`\n=== ${t} ===\n`); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'na-phase18-'));

function preToolUseInput(toolName: string, toolInput: Record<string, unknown>): ClaudeHookInput {
  return {
    session_id: 'sess-18',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
  };
}

// ---------------------------------------------------------------------------
// 1. ClaudeHookBridge
// ---------------------------------------------------------------------------

async function testHookBridgeObserveMode() {
  header('ClaudeHookBridge — observe mode audits and never blocks');
  const auditPath = path.join(TMP, 'observe', 'hooks_audit.jsonl');
  const seen: HookAuditEntry[] = [];
  const bridge = new ClaudeHookBridge({
    mode: 'observe',
    auditLogPath: auditPath,
    onAudit: (e) => seen.push(e),
  });

  const out = await bridge.handlePreToolUse(preToolUseInput('Bash', { command: 'npm test' }));
  assert(out.hookSpecificOutput.permissionDecision === 'allow', 'observe mode allows Bash');
  assert(out.hookSpecificOutput.hookEventName === 'PreToolUse', 'output declares PreToolUse event');
  assert(/observe/i.test(out.hookSpecificOutput.permissionDecisionReason), 'reason mentions observe mode');

  const post = await bridge.handlePostToolUse({
    ...preToolUseInput('Bash', { command: 'npm test' }),
    hook_event_name: 'PostToolUse',
    tool_response: { ok: true },
  });
  assert(Object.keys(post).length === 0, 'PostToolUse returns empty no-op object');

  assert(seen.length === 2, 'onAudit called for both events', String(seen.length));
  assert(seen[0].toolName === 'Bash' && seen[0].target === 'npm test', 'audit entry captures tool and target');
  assert(seen[0].mode === 'observe', 'audit entry records mode');

  const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n');
  assert(lines.length === 2, 'audit JSONL has two entries', String(lines.length));
  const first = JSON.parse(lines[0]) as HookAuditEntry;
  assert(first.event === 'PreToolUse' && first.decision === 'allow', 'JSONL entry has event and decision');
}

async function testHookBridgeDenyAllowPatterns() {
  header('ClaudeHookBridge — deny/allow patterns take precedence');
  const bridge = new ClaudeHookBridge({
    mode: 'observe',
    denyPatterns: ['rm -rf', /git\s+push\s+--force/],
    allowPatterns: ['^Read$'],
  });

  const denied = await bridge.handlePreToolUse(preToolUseInput('Bash', { command: 'rm -rf /tmp/x' }));
  assert(denied.hookSpecificOutput.permissionDecision === 'deny', 'deny pattern blocks matching command');

  const deniedRe = await bridge.handlePreToolUse(preToolUseInput('Bash', { command: 'git push --force origin main' }));
  assert(deniedRe.hookSpecificOutput.permissionDecision === 'deny', 'regex deny pattern blocks force push');

  const allowed = await bridge.handlePreToolUse(preToolUseInput('Read', { file_path: '/repo/src/index.ts' }));
  assert(allowed.hookSpecificOutput.permissionDecision === 'allow', 'allow pattern allows Read');
  assert(/allow pattern/i.test(allowed.hookSpecificOutput.permissionDecisionReason), 'reason cites allow pattern');
}

async function testHookBridgeEnforceMode() {
  header('ClaudeHookBridge — enforce mode gates through AuthGuardian');
  const dir = path.join(TMP, 'enforce');
  fs.mkdirSync(dir, { recursive: true });
  const bridge = new ClaudeHookBridge({
    mode: 'enforce',
    agentId: 'claude-code',
    trustLevel: 0.8,
    auditLogPath: path.join(dir, 'hooks_audit.jsonl'),
    guardianAuditLogPath: path.join(dir, 'audit_log.jsonl'),
    trustConfigPath: path.join(dir, 'trust_levels.json'),
  });

  // File write: FILE_SYSTEM (baseRisk 0.5) with a strong templated justification → grant
  const write = await bridge.handlePreToolUse(preToolUseInput('Write', { file_path: '/repo/src/app.ts' }));
  assert(write.hookSpecificOutput.permissionDecision === 'allow', 'enforce mode grants Write (FILE_SYSTEM)',
    write.hookSpecificOutput.permissionDecisionReason);
  assert(/AuthGuardian granted FILE_SYSTEM/.test(write.hookSpecificOutput.permissionDecisionReason),
    'reason cites AuthGuardian FILE_SYSTEM grant');

  // Shell exec: SHELL_EXEC (baseRisk 0.8) — passes the hard risk ceiling with tool-name scope
  const bash = await bridge.handlePreToolUse(preToolUseInput('Bash', { command: 'npx tsc --noEmit' }));
  assert(bash.hookSpecificOutput.permissionDecision === 'allow', 'enforce mode grants Bash (SHELL_EXEC)',
    bash.hookSpecificOutput.permissionDecisionReason);

  // Unknown tool falls back to EXTERNAL_SERVICE
  const mcp = await bridge.handlePreToolUse(preToolUseInput('mcp__github__create_issue', { title: 'bug' }));
  assert(mcp.hookSpecificOutput.permissionDecision === 'allow', 'mcp__ tools map to EXTERNAL_SERVICE and grant',
    mcp.hookSpecificOutput.permissionDecisionReason);
}

async function testHookBridgeEnforceDenies() {
  header('ClaudeHookBridge — enforce mode denies untrusted agents');
  const dir = path.join(TMP, 'enforce-deny');
  fs.mkdirSync(dir, { recursive: true });

  // Trust 0.3 is below AuthGuardian's 0.4 floor → hard deny → 'ask' by default
  const asking = new ClaudeHookBridge({
    mode: 'enforce',
    agentId: 'untrusted-cli',
    trustLevel: 0.3,
    guardianAuditLogPath: path.join(dir, 'audit_log.jsonl'),
    trustConfigPath: path.join(dir, 'trust_levels.json'),
  });
  const ask = await asking.handlePreToolUse(preToolUseInput('Bash', { command: 'echo hi' }));
  assert(ask.hookSpecificOutput.permissionDecision === 'ask', 'guardian denial escalates as ask by default',
    ask.hookSpecificOutput.permissionDecision);
  assert(/AuthGuardian denied/.test(ask.hookSpecificOutput.permissionDecisionReason), 'reason carries guardian denial');

  // blockedDecision: 'deny' turns guardian denials into hard denies
  const denying = new ClaudeHookBridge({
    mode: 'enforce',
    agentId: 'untrusted-cli-2',
    trustLevel: 0.3,
    blockedDecision: 'deny',
    guardianAuditLogPath: path.join(dir, 'audit_log2.jsonl'),
    trustConfigPath: path.join(dir, 'trust_levels2.json'),
  });
  const deny = await denying.handlePreToolUse(preToolUseInput('Bash', { command: 'echo hi' }));
  assert(deny.hookSpecificOutput.permissionDecision === 'deny', "blockedDecision 'deny' hard-blocks");
}

async function testHookBridgeParsingAndDispatch() {
  header('ClaudeHookBridge — input parsing and dispatch');

  let threw = false;
  try { ClaudeHookBridge.parseInput('not json'); } catch { threw = true; }
  assert(threw, 'malformed JSON throws');

  threw = false;
  try { ClaudeHookBridge.parseInput('[1,2,3]'); } catch { threw = true; }
  assert(threw, 'non-object input throws');

  threw = false;
  try { ClaudeHookBridge.parseInput('{"tool_name":"Bash"}'); } catch { threw = true; }
  assert(threw, 'missing hook_event_name throws');

  const parsed = ClaudeHookBridge.parseInput(JSON.stringify(preToolUseInput('Write', { file_path: 'x.ts' })));
  assert(parsed.tool_name === 'Write', 'valid input parses');

  const bridge = new ClaudeHookBridge({ mode: 'observe' });
  const viaDispatch = await bridge.handle(parsed);
  assert('hookSpecificOutput' in viaDispatch, 'handle() dispatches PreToolUse');

  threw = false;
  try { await bridge.handle({ hook_event_name: 'SessionStart' }); } catch { threw = true; }
  assert(threw, 'unsupported hook event throws');

  assert(DEFAULT_TOOL_RESOURCE_MAP['Bash'] === 'SHELL_EXEC', 'default map: Bash → SHELL_EXEC');
  assert(DEFAULT_TOOL_RESOURCE_MAP['Edit'] === 'FILE_SYSTEM', 'default map: Edit → FILE_SYSTEM');
  assert(DEFAULT_TOOL_RESOURCE_MAP['WebFetch'] === 'EXTERNAL_SERVICE', 'default map: WebFetch → EXTERNAL_SERVICE');
}

// ---------------------------------------------------------------------------
// 2. MCP elicitation
// ---------------------------------------------------------------------------

function approvalRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    type: 'shell',
    target: 'npm run deploy',
    agentId: 'worker-1',
    justification: 'deploy the approved release',
    risk: 'high',
    timestamp: Date.now(),
    ...overrides,
  };
}

async function testElicitationChannel() {
  header('StdioElicitationChannel — request/response routing');

  const wire: string[] = [];
  const channel = new StdioElicitationChannel((line) => wire.push(line), 5_000);

  const params: ElicitationCreateParams = {
    message: 'Approve?',
    requestedSchema: { type: 'object', properties: { approve: { type: 'boolean' } }, required: ['approve'] },
  };

  const pending = channel.request('elicitation/create', params);
  assert(wire.length === 1, 'request written to the wire');
  const sent = JSON.parse(wire[0]) as { jsonrpc: string; id: number; method: string; params: ElicitationCreateParams };
  assert(sent.jsonrpc === '2.0' && sent.method === 'elicitation/create', 'wire message is a JSON-RPC elicitation/create');
  assert(typeof sent.id === 'number' && sent.id >= 1_000_000, 'server-initiated ids use the high offset');
  assert(channel.pendingCount === 1, 'request is pending');

  // Client requests are not consumed
  assert(channel.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) === false, 'client request not consumed');
  assert(channel.handleMessage({ jsonrpc: '2.0', id: 999, result: {} }) === false, 'response to unknown id not consumed');
  assert(channel.handleMessage(null) === false, 'null message not consumed');

  // Deliver the matching response
  const consumed = channel.handleMessage({
    jsonrpc: '2.0', id: sent.id,
    result: { action: 'accept', content: { approve: true } } satisfies ElicitationResult,
  });
  assert(consumed === true, 'matching response consumed');
  const result = await pending;
  assert(result.action === 'accept' && result.content?.approve === true, 'promise resolves with the client result');
  assert(channel.pendingCount === 0, 'pending map drained');

  // Error responses reject
  const failing = channel.request('elicitation/create', params);
  const failId = (JSON.parse(wire[1]) as { id: number }).id;
  channel.handleMessage({ jsonrpc: '2.0', id: failId, error: { code: -32600, message: 'nope' } });
  let rejected = false;
  await failing.catch((e: Error) => { rejected = /nope/.test(e.message); });
  assert(rejected, 'error response rejects the pending request');

  // Malformed results reject
  const malformed = channel.request('elicitation/create', params);
  const malId = (JSON.parse(wire[2]) as { id: number }).id;
  channel.handleMessage({ jsonrpc: '2.0', id: malId, result: { action: 'maybe' } });
  rejected = false;
  await malformed.catch(() => { rejected = true; });
  assert(rejected, 'malformed elicitation result rejects');

  // Timeout rejects
  const short = new StdioElicitationChannel((line) => wire.push(line), 50);
  const timedOut = short.request('elicitation/create', params);
  rejected = false;
  await timedOut.catch((e: Error) => { rejected = /timed out/.test(e.message); });
  assert(rejected, 'unanswered request times out');

  // rejectAll drains pending
  const closing = new StdioElicitationChannel((line) => wire.push(line), 0);
  const p1 = closing.request('elicitation/create', params);
  const p2 = closing.request('elicitation/create', params);
  closing.rejectAll('shutdown');
  let bothRejected = 0;
  await p1.catch(() => { bothRejected++; });
  await p2.catch(() => { bothRejected++; });
  assert(bothRejected === 2 && closing.pendingCount === 0, 'rejectAll rejects every pending request');

  // Writer failures reject immediately
  const broken = new StdioElicitationChannel(() => { throw new Error('pipe closed'); });
  rejected = false;
  await broken.request('elicitation/create', params).catch((e: Error) => { rejected = /pipe closed/.test(e.message); });
  assert(rejected, 'write failure rejects the request');
}

async function testElicitationApprovalCallback() {
  header('createElicitationApprovalCallback — decision mapping (fail closed)');

  // Accept + approve:true → approved
  let sentParams: ElicitationCreateParams | undefined;
  const approve = createElicitationApprovalCallback(async (p) => {
    sentParams = p;
    return { action: 'accept', content: { approve: true, reason: 'looks safe' } };
  }, { approvedBy: 'human-reviewer' });
  const yes = await approve(approvalRequest());
  assert(yes.approved === true, 'accept+approve:true approves');
  assert(yes.approvedBy === 'human-reviewer', 'approvedBy propagated');
  assert(yes.reason === 'looks safe', 'reason propagated from content');
  assert(/worker-1/.test(sentParams?.message ?? ''), 'elicitation message names the agent');
  assert(/shell/.test(sentParams?.message ?? ''), 'elicitation message names the operation type');
  assert(sentParams?.requestedSchema.properties['approve']?.type === 'boolean', 'schema requests a boolean approve field');
  assert(sentParams?.requestedSchema.required?.includes('approve') === true, 'approve field is required');

  // Accept + approve:false → denied
  const sayNo = createElicitationApprovalCallback(async () => ({ action: 'accept', content: { approve: false } }));
  const no = await sayNo(approvalRequest());
  assert(no.approved === false, 'accept+approve:false denies');

  // Decline / cancel → denied
  const decline = createElicitationApprovalCallback(async () => ({ action: 'decline' }));
  assert((await decline(approvalRequest())).approved === false, 'decline denies');
  const cancel = createElicitationApprovalCallback(async () => ({ action: 'cancel' }));
  const cancelled = await cancel(approvalRequest());
  assert(cancelled.approved === false && /cancel/i.test(cancelled.reason ?? ''), 'cancel denies with reason');

  // Transport error → denied (never approves)
  const boom = createElicitationApprovalCallback(async () => { throw new Error('transport down'); });
  const errored = await boom(approvalRequest());
  assert(errored.approved === false && /transport down/.test(errored.reason ?? ''), 'transport failure fails closed');

  // Timeout → denied
  const never = createElicitationApprovalCallback(
    () => new Promise<ElicitationResult>(() => { /* never resolves */ }),
    { timeoutMs: 50 },
  );
  const timedOut = await never(approvalRequest());
  assert(timedOut.approved === false && /timed out/.test(timedOut.reason ?? ''), 'timeout fails closed');
}

// ---------------------------------------------------------------------------
// 3. A2AServer
// ---------------------------------------------------------------------------

function startA2A(options: ConstructorParameters<typeof A2AServer>[0]): Promise<{ server: import('http').Server; a2a: A2AServer; base: string }> {
  const a2a = new A2AServer(options);
  const server = a2a.startServer(0);
  return new Promise((resolve) => {
    server.on('listening', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, a2a, base: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server: import('http').Server): Promise<void> {
  return new Promise((res) => server.close(() => res()));
}

function rpc(method: string, params: Record<string, unknown>, id = 'rpc-1') {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

async function testA2AServerCardAndTasks() {
  header('A2AServer — agent card + task lifecycle');
  const { server, a2a, base } = await startA2A({
    name: 'Network-AI Orchestrator',
    description: 'Test swarm',
    version: '5.14.0',
    executor: async (text) => ({ text: `handled: ${text}` }),
  });

  try {
    // Agent card
    const card = await (await fetch(`${base}/.well-known/agent.json`)).json() as Record<string, unknown>;
    assert(card.name === 'Network-AI Orchestrator', 'agent card serves the name');
    assert(card.version === '5.14.0', 'agent card serves the version');
    assert((card.authentication as Record<string, unknown>).schemes !== undefined, 'agent card declares auth schemes');

    // tasks/send
    const sendResp = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rpc('tasks/send', {
        id: 'task-1',
        message: { role: 'user', parts: [{ type: 'text', text: 'summarize the report' }] },
      }),
    });
    const send = await sendResp.json() as { result?: { id: string; status: { state: string }; artifacts?: Array<{ parts: Array<{ text: string }> }> } };
    assert(send.result?.status.state === 'completed', 'tasks/send completes');
    assert(send.result?.id === 'task-1', 'client-supplied task id honored');
    assert(send.result?.artifacts?.[0].parts[0].text === 'handled: summarize the report', 'executor output returned as artifact');

    // tasks/get
    const getResp = await fetch(`${base}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: rpc('tasks/get', { id: 'task-1' }),
    });
    const got = await getResp.json() as { result?: { status: { state: string } } };
    assert(got.result?.status.state === 'completed', 'tasks/get returns stored state');
    assert(a2a.getTask('task-1')?.output === 'handled: summarize the report', 'task record stores output');

    // tasks/get unknown → -32001
    const missing = await (await fetch(`${base}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: rpc('tasks/get', { id: 'ghost' }),
    })).json() as { error?: { code: number } };
    assert(missing.error?.code === -32001, 'unknown task id yields -32001');

    // tasks/cancel on a terminal task is a no-op state-wise
    const cancel = await (await fetch(`${base}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: rpc('tasks/cancel', { id: 'task-1' }),
    })).json() as { result?: { status: { state: string } } };
    assert(cancel.result?.status.state === 'completed', 'cancel on completed task leaves it completed');

    // Unknown method → -32601
    const unknown = await (await fetch(`${base}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: rpc('tasks/stream', {}),
    })).json() as { error?: { code: number } };
    assert(unknown.error?.code === -32601, 'unknown method yields -32601');

    // Malformed JSON → -32700
    const parseErr = await (await fetch(`${base}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope',
    })).json() as { error?: { code: number } };
    assert(parseErr.error?.code === -32700, 'malformed body yields -32700');

    // Missing text parts → -32602
    const badParams = await (await fetch(`${base}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: rpc('tasks/send', { message: { role: 'user', parts: [] } }),
    })).json() as { error?: { code: number } };
    assert(badParams.error?.code === -32602, 'empty message parts yields -32602');

    // 404 elsewhere
    const notFound = await fetch(`${base}/nope`);
    assert(notFound.status === 404, 'unknown route yields 404');
  } finally {
    await closeServer(server);
  }
}

async function testA2AServerFailuresAndAuth() {
  header('A2AServer — executor failures, auth, and limits');

  // Failing executor → failed state, not an HTTP error
  const failing = await startA2A({
    name: 'Failer',
    executor: async () => { throw new Error('downstream exploded'); },
  });
  try {
    const resp = await (await fetch(`${failing.base}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: rpc('tasks/send', { id: 'f1', message: { role: 'user', parts: [{ type: 'text', text: 'go' }] } }),
    })).json() as { result?: { status: { state: string; message?: string } } };
    assert(resp.result?.status.state === 'failed', 'executor throw yields failed task state');
    assert(/downstream exploded/.test(resp.result?.status.message ?? ''), 'failure message propagated');
    assert(failing.a2a.getTask('f1')?.state === 'failed', 'failed state stored');
  } finally {
    await closeServer(failing.server);
  }

  // Bearer auth on tasks; card stays public
  const secured = await startA2A({
    name: 'Secured',
    secret: 'a2a-secret',
    executor: async (text) => ({ text }),
  });
  try {
    const card = await fetch(`${secured.base}/.well-known/agent.json`);
    assert(card.status === 200, 'agent card remains public with secret set');
    const cardBody = await card.json() as { authentication: { schemes: string[] } };
    assert(cardBody.authentication.schemes.includes('bearer'), 'card advertises bearer auth');

    const noAuth = await fetch(`${secured.base}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: rpc('tasks/send', { message: { role: 'user', parts: [{ type: 'text', text: 'x' }] } }),
    });
    assert(noAuth.status === 401, 'tasks without auth → 401');

    const wrongAuth = await fetch(`${secured.base}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer wrong' },
      body: rpc('tasks/send', { message: { role: 'user', parts: [{ type: 'text', text: 'x' }] } }),
    });
    assert(wrongAuth.status === 401, 'tasks with wrong token → 401');

    const okAuth = await fetch(`${secured.base}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer a2a-secret' },
      body: rpc('tasks/send', { message: { role: 'user', parts: [{ type: 'text', text: 'hello' }] } }),
    });
    assert(okAuth.status === 200, 'tasks with correct token → 200');
  } finally {
    await closeServer(secured.server);
  }

  // Body size cap
  const capped = await startA2A({
    name: 'Capped',
    maxBodyBytes: 256,
    executor: async (text) => ({ text }),
  });
  try {
    const big = await fetch(`${capped.base}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: rpc('tasks/send', { message: { role: 'user', parts: [{ type: 'text', text: 'y'.repeat(2048) }] } }),
    }).then((r) => r.status).catch(() => 413);
    assert(big === 413, 'oversized body → 413 (or connection rejected)', String(big));
  } finally {
    await closeServer(capped.server);
  }

  // Constructor validation
  let threw = false;
  try { new A2AServer({ name: '', executor: async () => ({}) }); } catch { threw = true; }
  assert(threw, 'empty name throws');
  threw = false;
  try { new A2AServer({ name: 'x' } as unknown as ConstructorParameters<typeof A2AServer>[0]); } catch { threw = true; }
  assert(threw, 'missing executor throws');
}

async function testA2AServerHistoryEviction() {
  header('A2AServer — history eviction');
  const { server, a2a, base } = await startA2A({
    name: 'Evictor',
    maxHistory: 3,
    executor: async (text) => ({ text }),
  });
  try {
    for (let i = 0; i < 5; i++) {
      await fetch(`${base}/tasks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: rpc('tasks/send', { id: `t${i}`, message: { role: 'user', parts: [{ type: 'text', text: `job ${i}` }] } }),
      });
    }
    assert(a2a.taskCount === 3, 'history capped at maxHistory', String(a2a.taskCount));
    assert(a2a.getTask('t0') === undefined, 'oldest task evicted');
    assert(a2a.getTask('t4') !== undefined, 'newest task retained');
  } finally {
    await closeServer(server);
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  process.stdout.write('\nPhase 18 — Ecosystem expansion (hooks bridge, MCP elicitation, A2A server)\n');

  await testHookBridgeObserveMode();
  await testHookBridgeDenyAllowPatterns();
  await testHookBridgeEnforceMode();
  await testHookBridgeEnforceDenies();
  await testHookBridgeParsingAndDispatch();
  await testElicitationChannel();
  await testElicitationApprovalCallback();
  await testA2AServerCardAndTasks();
  await testA2AServerFailuresAndAuth();
  await testA2AServerHistoryEviction();

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }

  process.stdout.write(`\n${passed + failed} checks — ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.stdout.write(failures.map((f) => `  FAIL: ${f}`).join('\n') + '\n');
    process.exit(1);
  }
  process.stdout.write('ALL PHASE 18 TESTS PASSED ✓\n');
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
