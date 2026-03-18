/**
 * test-nemoclaw.ts — NemoClaw Adapter Test Suite
 *
 * Tests:
 *   - NemoClawAdapter initialisation and lifecycle
 *   - registerSandboxAgent() registration and validation
 *   - executeAgent() — sandbox execution via mock executor
 *   - executeAgent() — unregistered agent returns error result
 *   - executeAgent() — executor throws, returns error result
 *   - Sandbox lifecycle (create, status, destroy)
 *   - Network policy YAML generation
 *   - Blueprint execution
 *   - Handoff and blackboard snapshot forwarding
 *   - Static policy presets (mcpServerPolicy, nvidiaPolicy)
 *   - Capabilities / listAgents
 *   - Multiple agents on same adapter
 *   - Type exports (smoke check)
 *
 * Run: npx ts-node test-nemoclaw.ts
 */

import { NemoClawAdapter } from './adapters/nemoclaw-adapter';
import type {
  NemoClawAgentConfig,
  OpenShellExecutor,
  BlueprintAction,
  BlueprintRunResult,
  SandboxState,
  SandboxStatus,
  NetworkPolicy,
  PolicyEndpoint,
} from './adapters/nemoclaw-adapter';
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
  params: { topic: 'security audit', depth: 'thorough' },
};

const defaultContext: AgentContext = {
  agentId: 'test-caller',
  taskId: 'task-001',
  sessionId: 'sess-001',
};

/** Build a mock OpenShell executor that captures calls and returns configurable responses */
function makeMockExecutor(responses?: Record<string, string>): OpenShellExecutor & {
  calls: Array<{ subcommand: string; args: string[]; options?: Record<string, unknown> }>;
} {
  const calls: Array<{ subcommand: string; args: string[]; options?: Record<string, unknown> }> = [];

  const executor: OpenShellExecutor & { calls: typeof calls } = async (subcommand, args, options) => {
    calls.push({ subcommand, args, options: options as Record<string, unknown> });

    // Match response by subcommand + first arg
    const key = `${subcommand}:${args[0] ?? ''}`;
    if (responses?.[key]) return responses[key];

    // Default responses for sandbox operations
    if (subcommand === 'sandbox' && args[0] === 'get') {
      return JSON.stringify({ state: 'running', uptime: 120 });
    }
    if (subcommand === 'sandbox' && args[0] === 'create') {
      return 'sandbox created';
    }
    if (subcommand === 'sandbox' && args[0] === 'connect') {
      return 'command output';
    }
    if (subcommand === 'sandbox' && args[0] === 'delete') {
      return 'sandbox deleted';
    }
    if (subcommand === 'policy') {
      return 'policy applied';
    }
    if (subcommand === 'blueprint') {
      return 'blueprint executed';
    }

    return '';
  };

  executor.calls = calls;
  return executor;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function runTests(): Promise<void> {

  // ── 1. Lifecycle ────────────────────────────────────────────────────────────
  section('1. Lifecycle');

  const adapter = new NemoClawAdapter();
  assert(adapter.name === 'nemoclaw', 'name is "nemoclaw"');
  assert(adapter.version === '1.0.0', 'version is 1.0.0');
  assert(!adapter.isReady(), 'not ready before initialize()');

  const mockExec = makeMockExecutor();
  await adapter.initialize({ options: { executor: mockExec } });
  assert(adapter.isReady(), 'ready after initialize()');

  const health = await adapter.healthCheck();
  assert(health.healthy === true, 'healthCheck() returns healthy');

  await adapter.shutdown();
  assert(!adapter.isReady(), 'not ready after shutdown()');

  // ── 2. Registration ─────────────────────────────────────────────────────────
  section('2. Registration');

  const a2 = new NemoClawAdapter();
  const exec2 = makeMockExecutor();
  await a2.initialize({ options: { executor: exec2 } });

  a2.registerSandboxAgent('worker-1', { sandboxName: 'test-sandbox' });
  const agents = await a2.listAgents();
  assert(agents.length === 1, 'listAgents() returns 1 agent');
  assert(agents[0].id === 'worker-1', 'agent id is "worker-1"');
  assert(await a2.isAgentAvailable('worker-1'), 'isAgentAvailable() true for registered agent');
  assert(!(await a2.isAgentAvailable('ghost')), 'isAgentAvailable() false for unknown agent');

  // ── 3. Registration validation ──────────────────────────────────────────────
  section('3. Registration validation — sandboxName required');

  const a3 = new NemoClawAdapter();
  await a3.initialize({ options: { executor: makeMockExecutor() } });

  let threw = false;
  try {
    a3.registerSandboxAgent('bad-agent', { sandboxName: '' });
  } catch (e) {
    threw = true;
    assert(e instanceof Error && e.message.includes('sandboxName'), 'error mentions sandboxName');
  }
  assert(threw, 'registering with empty sandboxName throws');

  // ── 4. Execute agent — sandbox execution via mock executor ────────────────
  section('4. Execute agent — sandbox execution');

  const exec4 = makeMockExecutor({
    'sandbox:connect': JSON.stringify({ result: 'analysis complete', score: 95 }),
  });
  const a4 = new NemoClawAdapter();
  await a4.initialize({ options: { executor: exec4 } });
  a4.registerSandboxAgent('analyst', { sandboxName: 'analysis-sandbox' });

  const r4 = await a4.executeAgent('analyst', defaultPayload, defaultContext);
  assert(r4.success === true, 'execution returns success=true');
  assert(typeof r4.data === 'object' && r4.data !== null, 'result.data is an object');
  const d4 = r4.data as Record<string, unknown>;
  assert(d4['result'] === 'analysis complete', 'result.data contains parsed JSON output');
  assert(d4['score'] === 95, 'result.data.score is 95');
  assert(r4.metadata?.['adapter'] === 'nemoclaw', 'metadata.adapter is "nemoclaw"');
  assert(typeof r4.metadata?.executionTimeMs === 'number', 'metadata.executionTimeMs present');

  // Verify sandbox was created first, then command executed
  assert(exec4.calls.length >= 2, 'at least 2 executor calls (create check + connect)');
  const connectCall = exec4.calls.find(c => c.subcommand === 'sandbox' && c.args[0] === 'connect');
  assert(connectCall !== undefined, 'sandbox connect was called');
  assert(connectCall?.args.includes('analysis-sandbox') ?? false, 'connect targets correct sandbox');

  // ── 5. Execute agent — plain text output ──────────────────────────────────
  section('5. Execute agent — plain text output');

  const exec5 = makeMockExecutor({
    'sandbox:connect': 'Hello from the sandbox!',
  });
  const a5 = new NemoClawAdapter();
  await a5.initialize({ options: { executor: exec5 } });
  a5.registerSandboxAgent('greeter', { sandboxName: 'greet-sandbox' });

  const r5 = await a5.executeAgent('greeter', { action: 'greet', params: {} }, defaultContext);
  assert(r5.success === true, 'plain text execution succeeds');
  assert(r5.data === 'Hello from the sandbox!', 'plain text output preserved');

  // ── 6. Execute agent — unregistered agent returns error ───────────────────
  section('6. Unregistered agent — error result');

  const a6 = new NemoClawAdapter();
  await a6.initialize({ options: { executor: makeMockExecutor() } });
  const r6 = await a6.executeAgent('ghost', defaultPayload, defaultContext);
  assert(r6.success === false, 'unregistered agent returns success=false');
  assert(r6.error?.code === 'AGENT_NOT_FOUND', 'error code is AGENT_NOT_FOUND');
  assert(r6.error?.message?.includes('ghost') ?? false, 'error message mentions agent id');
  assert(r6.metadata?.['adapter'] === 'nemoclaw', 'metadata.adapter is "nemoclaw"');

  // ── 7. Execute agent — executor throws ────────────────────────────────────
  section('7. Executor throws — error captured');

  const throwingExec: OpenShellExecutor = async () => {
    throw new Error('sandbox connection refused');
  };
  const a7 = new NemoClawAdapter();
  await a7.initialize({ options: { executor: throwingExec } });
  a7.registerSandboxAgent('broken', { sandboxName: 'broken-sandbox' });

  const r7 = await a7.executeAgent('broken', defaultPayload, defaultContext);
  assert(r7.success === false, 'executor error returns success=false');
  assert(r7.error?.code === 'NEMOCLAW_ERROR', 'error code is NEMOCLAW_ERROR');
  assert(r7.error?.message?.includes('sandbox connection refused') ?? false, 'error message propagated');
  assert(r7.error?.recoverable === true, 'error is recoverable');

  // ── 8. Sandbox lifecycle — create, status, destroy ────────────────────────
  section('8. Sandbox lifecycle');

  const exec8 = makeMockExecutor();
  const a8 = new NemoClawAdapter();
  await a8.initialize({ options: { executor: exec8 } });

  // Create
  const created = await a8.createSandbox('lifecycle-test', undefined, [8080, 3001]);
  assert(created.name === 'lifecycle-test', 'createSandbox returns correct name');
  assert(created.state === 'running', 'sandbox state is running');

  // Status
  const status = await a8.getSandboxStatus('lifecycle-test');
  assert(status.name === 'lifecycle-test', 'getSandboxStatus returns correct name');
  assert(status.state === 'running', 'status shows running');

  // Destroy
  await a8.destroySandbox('lifecycle-test');
  const deleteCall = exec8.calls.find(c => c.subcommand === 'sandbox' && c.args[0] === 'delete');
  assert(deleteCall !== undefined, 'destroySandbox calls sandbox delete');
  assert(deleteCall?.args.includes('lifecycle-test') ?? false, 'delete targets correct sandbox');
  assert(deleteCall?.args.includes('--force') ?? false, 'delete uses --force flag');

  // ── 9. Network policies applied during execution ──────────────────────────
  section('9. Network policies applied during execution');

  const exec9 = makeMockExecutor();
  const a9 = new NemoClawAdapter();
  await a9.initialize({ options: { executor: exec9 } });

  const policies: NetworkPolicy[] = [
    {
      name: 'nvidia',
      endpoints: [
        { host: 'api.nvidia.com', port: 443, tls: 'passthrough' },
      ],
    },
    {
      name: 'mcp_server',
      endpoints: [
        { host: 'host.docker.internal', port: 3001, protocol: 'rest' },
      ],
    },
  ];

  a9.registerSandboxAgent('policy-agent', {
    sandboxName: 'policy-sandbox',
    policies,
  });

  await a9.executeAgent('policy-agent', defaultPayload, defaultContext);

  const policyCall = exec9.calls.find(c => c.subcommand === 'policy');
  assert(policyCall !== undefined, 'policy set was called during execution');

  // ── 10. Policy YAML generation — static mcpServerPolicy ──────────────────
  section('10. Static policy presets');

  const mcpPolicy = NemoClawAdapter.mcpServerPolicy('localhost', 4000);
  assert(mcpPolicy.name === 'network_ai_mcp', 'MCP policy name is "network_ai_mcp"');
  assert(mcpPolicy.endpoints.length === 1, 'MCP policy has 1 endpoint');
  assert(mcpPolicy.endpoints[0].host === 'localhost', 'MCP policy host is correct');
  assert(mcpPolicy.endpoints[0].port === 4000, 'MCP policy port is correct');
  assert(mcpPolicy.endpoints[0].rules?.length === 2, 'MCP policy has 2 rules (SSE + messages)');

  const nvidiaPolicy = NemoClawAdapter.nvidiaPolicy();
  assert(nvidiaPolicy.name === 'nvidia', 'NVIDIA policy name is "nvidia"');
  assert(nvidiaPolicy.endpoints.length === 2, 'NVIDIA policy has 2 endpoints');
  assert(nvidiaPolicy.endpoints[0].host === 'integrate.api.nvidia.com', 'NVIDIA endpoint 1 correct');
  assert(nvidiaPolicy.endpoints[1].host === 'inference-api.nvidia.com', 'NVIDIA endpoint 2 correct');

  // ── 11. Blueprint execution ───────────────────────────────────────────────
  section('11. Blueprint execution');

  const exec11 = makeMockExecutor({
    'blueprint:plan': 'Plan output: 3 changes detected',
  });
  const a11 = new NemoClawAdapter();
  await a11.initialize({ options: { executor: exec11 } });

  const planResult = await a11.execBlueprint('/path/to/blueprint', 'plan', {
    profile: 'default',
    dryRun: true,
  });
  assert(planResult.success === true, 'blueprint plan succeeds');
  assert(planResult.action === 'plan', 'result action is "plan"');
  assert(planResult.output.includes('3 changes'), 'plan output contains expected text');
  assert(planResult.exitCode === 0, 'exit code is 0');
  assert(planResult.runId.startsWith('run-'), 'runId has expected prefix');

  // Blueprint error handling
  const failExec: OpenShellExecutor = async () => {
    throw new Error('blueprint validation failed');
  };
  const a11b = new NemoClawAdapter();
  await a11b.initialize({ options: { executor: failExec } });
  const failResult = await a11b.execBlueprint('/bad/path', 'apply');
  assert(failResult.success === false, 'failed blueprint returns success=false');
  assert(failResult.exitCode === 1, 'failed blueprint exit code is 1');
  assert(failResult.output.includes('blueprint validation failed'), 'error message propagated');

  // ── 12. Handoff forwarded to sandbox env ──────────────────────────────────
  section('12. Handoff context forwarded');

  const exec12 = makeMockExecutor();
  const a12 = new NemoClawAdapter();
  await a12.initialize({ options: { executor: exec12 } });
  a12.registerSandboxAgent('handoff-agent', { sandboxName: 'handoff-sandbox' });

  const handoffPayload: AgentPayload = {
    action: 'review',
    params: {},
    handoff: {
      handoffId: 'h-001',
      sourceAgent: 'orchestrator',
      targetAgent: 'handoff-agent',
      taskType: 'delegate',
      instruction: 'Review the auth module carefully',
    },
  };

  await a12.executeAgent('handoff-agent', handoffPayload, defaultContext);

  const handoffCall = exec12.calls.find(c => c.subcommand === 'sandbox' && c.args[0] === 'connect');
  const handoffEnv = handoffCall?.options?.['env'] as Record<string, string> | undefined;
  assert(handoffEnv?.['NETWORK_AI_HANDOFF'] !== undefined, 'NETWORK_AI_HANDOFF env var set');

  const handoffData = JSON.parse(handoffEnv?.['NETWORK_AI_HANDOFF'] ?? '{}');
  assert(handoffData['handoffId'] === 'h-001', 'handoff ID forwarded');
  assert(handoffData['instruction'] === 'Review the auth module carefully', 'handoff instruction forwarded');

  // ── 13. Blackboard snapshot forwarded to sandbox env ──────────────────────
  section('13. Blackboard snapshot forwarded');

  const exec13 = makeMockExecutor();
  const a13 = new NemoClawAdapter();
  await a13.initialize({ options: { executor: exec13 } });
  a13.registerSandboxAgent('bb-agent', { sandboxName: 'bb-sandbox' });

  const bbPayload: AgentPayload = {
    action: 'summarize',
    params: {},
    blackboardSnapshot: {
      'task:current': 'audit network policies',
      'analysis:score': 95,
    },
  };

  await a13.executeAgent('bb-agent', bbPayload, defaultContext);

  const bbCall = exec13.calls.find(c => c.subcommand === 'sandbox' && c.args[0] === 'connect');
  const bbEnv = bbCall?.options?.['env'] as Record<string, string> | undefined;
  assert(bbEnv?.['NETWORK_AI_CONTEXT'] !== undefined, 'NETWORK_AI_CONTEXT env var set');

  const bbData = JSON.parse(bbEnv?.['NETWORK_AI_CONTEXT'] ?? '{}');
  assert(bbData['task:current'] === 'audit network policies', 'blackboard key forwarded');
  assert(bbData['analysis:score'] === 95, 'blackboard value forwarded');

  // ── 14. Custom command in agent config ────────────────────────────────────
  section('14. Custom command in agent config');

  const exec14 = makeMockExecutor();
  const a14 = new NemoClawAdapter();
  await a14.initialize({ options: { executor: exec14 } });
  a14.registerSandboxAgent('custom-cmd', {
    sandboxName: 'cmd-sandbox',
    command: 'python3 /app/agent.py --mode production',
  });

  await a14.executeAgent('custom-cmd', { action: 'run', params: {} }, defaultContext);

  const cmdCall = exec14.calls.find(c => c.subcommand === 'sandbox' && c.args[0] === 'connect');
  assert(cmdCall !== undefined, 'sandbox connect was called');
  // The command should contain python3
  const cmdArgs = cmdCall?.args ?? [];
  assert(cmdArgs.includes('python3'), 'custom command passed to sandbox');

  // ── 15. Agent-level executor override ─────────────────────────────────────
  section('15. Agent-level executor override');

  const adapterExec = makeMockExecutor({ 'sandbox:connect': 'adapter-level' });
  const agentExec = makeMockExecutor({ 'sandbox:connect': 'agent-level' });
  const a15 = new NemoClawAdapter();
  await a15.initialize({ options: { executor: adapterExec } });
  a15.registerSandboxAgent('override-agent', {
    sandboxName: 'override-sandbox',
    executor: agentExec,
  });

  const r15 = await a15.executeAgent('override-agent', defaultPayload, defaultContext);
  assert(r15.success === true, 'agent-level executor succeeds');
  assert(agentExec.calls.length > 0, 'agent-level executor was called');
  // The adapter-level executor should not have been used for the connect
  const adapterConnects = adapterExec.calls.filter(c => c.subcommand === 'sandbox' && c.args[0] === 'connect');
  assert(adapterConnects.length === 0, 'adapter-level executor NOT used for connect');

  // ── 16. Multiple agents on same adapter ───────────────────────────────────
  section('16. Multiple agents on same adapter');

  const exec16 = makeMockExecutor();
  const a16 = new NemoClawAdapter();
  await a16.initialize({ options: { executor: exec16 } });
  a16.registerSandboxAgent('agent-a', { sandboxName: 'sandbox-a' });
  a16.registerSandboxAgent('agent-b', { sandboxName: 'sandbox-b' });

  const agents16 = await a16.listAgents();
  assert(agents16.length === 2, 'two agents registered');

  const rA = await a16.executeAgent('agent-a', defaultPayload, defaultContext);
  const rB = await a16.executeAgent('agent-b', defaultPayload, defaultContext);
  assert(rA.success === true, 'agent-a executes successfully');
  assert(rB.success === true, 'agent-b executes successfully');

  // Verify each used the correct sandbox name
  const callsA = exec16.calls.filter(c =>
    c.subcommand === 'sandbox' && c.args[0] === 'connect' && c.args.includes('sandbox-a')
  );
  const callsB = exec16.calls.filter(c =>
    c.subcommand === 'sandbox' && c.args[0] === 'connect' && c.args.includes('sandbox-b')
  );
  assert(callsA.length === 1, 'agent-a used sandbox-a');
  assert(callsB.length === 1, 'agent-b used sandbox-b');

  // ── 17. Capabilities ─────────────────────────────────────────────────────
  section('17. Capabilities');

  const caps = new NemoClawAdapter().capabilities;
  assert(caps.parallel === true, 'capabilities.parallel is true');
  assert(caps.authentication === true, 'capabilities.authentication is true');
  assert(caps.discovery === true, 'capabilities.discovery is true');
  assert(caps.statefulSessions === true, 'capabilities.statefulSessions is true');
  assert(caps.streaming === false, 'capabilities.streaming is false');
  assert(caps.bidirectional === false, 'capabilities.bidirectional is false');

  // ── 18. Exec in sandbox — direct API ──────────────────────────────────────
  section('18. execInSandbox direct API');

  const exec18 = makeMockExecutor({ 'sandbox:connect': 'ls output: bin etc lib' });
  const a18 = new NemoClawAdapter();
  await a18.initialize({ options: { executor: exec18 } });

  const output = await a18.execInSandbox('my-sandbox', 'ls -la /');
  assert(output === 'ls output: bin etc lib', 'execInSandbox returns executor output');
  const lsCall = exec18.calls.find(c => c.subcommand === 'sandbox' && c.args.includes('my-sandbox'));
  assert(lsCall !== undefined, 'executor called with correct sandbox name');

  // ── 19. Environment variables forwarded ───────────────────────────────────
  section('19. Environment variables forwarded');

  const exec19 = makeMockExecutor();
  const a19 = new NemoClawAdapter();
  await a19.initialize({ options: { executor: exec19 } });
  a19.registerSandboxAgent('env-agent', {
    sandboxName: 'env-sandbox',
    env: { NVIDIA_API_KEY: 'test-key', CUSTOM_VAR: 'custom-value' },
  });

  await a19.executeAgent('env-agent', defaultPayload, defaultContext);
  const envCall = exec19.calls.find(c => c.subcommand === 'sandbox' && c.args[0] === 'connect');
  const envVars = envCall?.options?.['env'] as Record<string, string> | undefined;
  assert(envVars?.['NVIDIA_API_KEY'] === 'test-key', 'NVIDIA_API_KEY forwarded');
  assert(envVars?.['CUSTOM_VAR'] === 'custom-value', 'CUSTOM_VAR forwarded');

  // ── 20. Pre-init registration ─────────────────────────────────────────────
  section('20. Pre-init registration');

  const a20 = new NemoClawAdapter();
  assert(!a20.isReady(), 'adapter not ready before anything');

  a20.registerSandboxAgent('early-bird', { sandboxName: 'early-sandbox' });
  assert(a20.isReady(), 'registerSandboxAgent sets adapter ready');

  const agents20 = await a20.listAgents();
  assert(agents20.length === 1, 'pre-init agent registered');
  assert(agents20[0].id === 'early-bird', 'pre-init agent has correct id');

  // ── 21. Type exports smoke check ──────────────────────────────────────────
  section('21. Type exports');

  const configCheck: NemoClawAgentConfig = { sandboxName: 'test' };
  assert(configCheck.sandboxName === 'test', 'NemoClawAgentConfig type usable');

  const policyCheck: NetworkPolicy = { name: 'test', endpoints: [{ host: 'localhost' }] };
  assert(policyCheck.name === 'test', 'NetworkPolicy type usable');

  const endpointCheck: PolicyEndpoint = { host: 'api.nvidia.com', port: 443, protocol: 'rest' };
  assert(endpointCheck.host === 'api.nvidia.com', 'PolicyEndpoint type usable');

  const actionCheck: BlueprintAction = 'plan';
  assert(actionCheck === 'plan', 'BlueprintAction type usable');

  const stateCheck: SandboxState = 'running';
  assert(stateCheck === 'running', 'SandboxState type usable');

  const statusCheck: SandboxStatus = { name: 'test', state: 'running' };
  assert(statusCheck.state === 'running', 'SandboxStatus type usable');

  const resultCheck: BlueprintRunResult = {
    success: true, runId: 'r1', action: 'apply', output: 'ok', exitCode: 0,
  };
  assert(resultCheck.success === true, 'BlueprintRunResult type usable');

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${c.bold}Results: ${c.green}${passed} passed${c.reset}${c.bold}, ${failed > 0 ? c.red : c.green}${failed} failed${c.reset}`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
