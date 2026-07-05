/**
 * Adapter System Test Suite
 * 
 * Tests the plug-and-play adapter architecture:
 * - CustomAdapter with function handlers
 * - AdapterRegistry routing
 * - Multi-adapter orchestration
 * - SwarmOrchestrator integration via adapters
 * 
 * Run with: npx ts-node test-adapters.ts
 */

import { AdapterRegistry } from './adapters/adapter-registry';
import { CustomAdapter } from './adapters/custom-adapter';
import { LangChainAdapter } from './adapters/langchain-adapter';
import { AutoGenAdapter } from './adapters/autogen-adapter';
import { CrewAIAdapter } from './adapters/crewai-adapter';
import { MCPAdapter } from './adapters/mcp-adapter';
import { BaseAdapter } from './adapters/base-adapter';
import type { AgentPayload, AgentContext, AgentResult } from './types/agent-adapter';

// ============================================================================
// TEST UTILITIES
// ============================================================================

const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
};

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ${colors.green}✓${colors.reset} ${message}`);
    passed++;
  } else {
    console.log(`  ${colors.red}✗${colors.reset} ${message}`);
    failed++;
  }
}

function section(title: string): void {
  console.log(`\n${colors.cyan}${colors.bold}▸ ${title}${colors.reset}`);
}

// ============================================================================
// TEST 1: CustomAdapter — Register and execute function handlers
// ============================================================================

async function testCustomAdapter(): Promise<void> {
  section('CustomAdapter — Function Handlers');

  const adapter = new CustomAdapter();
  await adapter.initialize({});

  assert(adapter.isReady(), 'Adapter initializes and is ready');
  assert(adapter.name === 'custom', 'Adapter name is "custom"');

  // Register a simple handler
  adapter.registerHandler('analyzer', async (payload, context) => {
    return {
      analysis: `Processed: ${payload.handoff?.instruction ?? 'no instruction'}`,
      agent: context.agentId,
      confidence: 0.95,
    };
  });

  adapter.registerHandler('calculator', async (payload) => {
    const a = (payload.params.a as number) ?? 0;
    const b = (payload.params.b as number) ?? 0;
    return { sum: a + b, product: a * b };
  });

  // List agents
  const agents = await adapter.listAgents();
  assert(agents.length === 2, `Lists 2 registered agents (got ${agents.length})`);
  assert(agents.some(a => a.id === 'analyzer'), 'Finds "analyzer" agent');
  assert(agents.some(a => a.id === 'calculator'), 'Finds "calculator" agent');

  // Execute analyzer
  const result1 = await adapter.executeAgent('analyzer', {
    action: 'analyze',
    params: {},
    handoff: {
      handoffId: 'test-1',
      sourceAgent: 'orchestrator',
      targetAgent: 'analyzer',
      taskType: 'delegate',
      instruction: 'Analyze Q4 revenue',
    },
  }, { agentId: 'orchestrator', taskId: 'task-1' });

  assert(result1.success === true, 'Analyzer returns success');
  assert((result1.data as any)?.analysis === 'Processed: Analyze Q4 revenue', 'Analyzer processes instruction correctly');
  assert((result1.data as any)?.agent === 'orchestrator', 'Analyzer receives context agentId');
  assert(result1.metadata?.adapter === 'custom', 'Result metadata includes adapter name');
  assert(typeof result1.metadata?.executionTimeMs === 'number', 'Result includes execution time');

  // Execute calculator
  const result2 = await adapter.executeAgent('calculator', {
    action: 'calculate',
    params: { a: 7, b: 3 },
  }, { agentId: 'orchestrator' });

  assert(result2.success === true, 'Calculator returns success');
  assert((result2.data as any)?.sum === 10, 'Calculator computes sum correctly');
  assert((result2.data as any)?.product === 21, 'Calculator computes product correctly');

  // Execute non-existent agent
  const result3 = await adapter.executeAgent('nonexistent', {
    action: 'test',
    params: {},
  }, { agentId: 'orchestrator' });

  assert(result3.success === false, 'Non-existent agent returns failure');
  assert(result3.error?.code === 'AGENT_NOT_FOUND', 'Error code is AGENT_NOT_FOUND');

  // Agent availability
  const available = await adapter.isAgentAvailable('analyzer');
  assert(available === true, 'Registered agent is available');

  const notAvailable = await adapter.isAgentAvailable('nonexistent');
  assert(notAvailable === false, 'Unregistered agent is not available');

  // Health check
  const health = await adapter.healthCheck();
  assert(health.healthy === true, 'Health check passes when initialized');

  await adapter.shutdown();
  assert(!adapter.isReady(), 'Adapter shuts down cleanly');
}

// ============================================================================
// TEST 2: LangChainAdapter — Runnable and function agents
// ============================================================================

async function testLangChainAdapter(): Promise<void> {
  section('LangChainAdapter — Runnables and Functions');

  const adapter = new LangChainAdapter();
  await adapter.initialize({});

  // Register a mock Runnable (has .invoke())
  adapter.registerAgent('research', {
    invoke: async (input: unknown) => {
      const data = input as Record<string, unknown>;
      return { output: `Research results for: ${data.input ?? data.task}` };
    },
  }, { description: 'Mock research agent' });

  // Register a plain async function
  adapter.registerAgent('summarizer', async (input: unknown) => {
    const data = input as Record<string, unknown>;
    return { result: `Summary of: ${data.input ?? 'data'}` };
  }, { description: 'Mock summarizer' });

  // Execute Runnable agent
  const result1 = await adapter.executeAgent('research', {
    action: 'research',
    params: {},
    handoff: {
      handoffId: 'h-1',
      sourceAgent: 'orchestrator',
      targetAgent: 'research',
      taskType: 'delegate',
      instruction: 'Market trends Q1 2026',
    },
  }, { agentId: 'orchestrator' });

  assert(result1.success === true, 'Runnable agent returns success');
  assert(
    (result1.data as string) === 'Research results for: Market trends Q1 2026',
    'Runnable processes instruction via .invoke() and extracts output'
  );

  // Execute function agent
  const result2 = await adapter.executeAgent('summarizer', {
    action: 'summarize',
    params: {},
    handoff: {
      handoffId: 'h-2',
      sourceAgent: 'orchestrator',
      targetAgent: 'summarizer',
      taskType: 'delegate',
      instruction: 'Key findings',
    },
  }, { agentId: 'orchestrator' });

  assert(result2.success === true, 'Function agent returns success');
  assert(
    (result2.data as string) === 'Summary of: Key findings',
    'Function agent processes instruction'
  );

  assert(result1.metadata?.adapter === 'langchain', 'Adapter name is "langchain"');

  await adapter.shutdown();
}

// ============================================================================
// TEST 3: AutoGenAdapter — Agent execution
// ============================================================================

async function testAutoGenAdapter(): Promise<void> {
  section('AutoGenAdapter — Agent Execution');

  const adapter = new AutoGenAdapter();
  await adapter.initialize({});

  // Register agent with .run()
  adapter.registerAgent('coder', {
    name: 'CodeWriter',
    run: async (task: string) => {
      return { code: `# Generated for: ${task}`, language: 'python' };
    },
  }, { description: 'Mock code writer' });

  // Register agent with .generateReply()
  adapter.registerAgent('critic', {
    name: 'CodeCritic',
    generateReply: async (messages) => {
      const lastMsg = messages[messages.length - 1];
      return { content: `Review of: ${lastMsg.content}` };
    },
  }, { description: 'Mock code critic' });

  // Execute .run() agent
  const result1 = await adapter.executeAgent('coder', {
    action: 'code',
    params: {},
    handoff: {
      handoffId: 'h-1',
      sourceAgent: 'orchestrator',
      targetAgent: 'coder',
      taskType: 'delegate',
      instruction: 'Write a CSV parser',
    },
  }, { agentId: 'orchestrator' });

  assert(result1.success === true, 'AutoGen .run() agent returns success');
  assert(
    (result1.data as any)?.code === '# Generated for: Write a CSV parser',
    'AutoGen .run() agent processes instruction'
  );

  // Execute .generateReply() agent
  const result2 = await adapter.executeAgent('critic', {
    action: 'review',
    params: {},
    handoff: {
      handoffId: 'h-2',
      sourceAgent: 'orchestrator',
      targetAgent: 'critic',
      taskType: 'delegate',
      instruction: 'Review this code',
    },
  }, { agentId: 'orchestrator' });

  assert(result2.success === true, 'AutoGen .generateReply() agent returns success');
  assert(
    (result2.data as any) === 'Review of: Review this code',
    'AutoGen .generateReply() agent processes messages'
  );

  assert(result1.metadata?.adapter === 'autogen', 'Adapter name is "autogen"');

  await adapter.shutdown();
}

// ============================================================================
// TEST 4: CrewAI Adapter — Agents and Crews
// ============================================================================

async function testCrewAIAdapter(): Promise<void> {
  section('CrewAIAdapter — Agents and Crews');

  const adapter = new CrewAIAdapter();
  await adapter.initialize({});

  // Register individual agent
  adapter.registerAgent('researcher', {
    role: 'Senior Researcher',
    goal: 'Find relevant data',
    execute: async (task: string) => {
      return `Research findings for: ${task}`;
    },
  });

  // Register a crew
  adapter.registerCrew('analysis_crew', {
    agents: [
      { role: 'Researcher', goal: 'Find data' },
      { role: 'Analyst', goal: 'Analyze data' },
    ],
    kickoff: async (inputs) => {
      return { report: `Crew report for: ${(inputs as any)?.task ?? 'unknown'}`, agents_used: 2 };
    },
  }, { description: 'Analysis crew' });

  // Execute individual agent
  const result1 = await adapter.executeAgent('researcher', {
    action: 'research',
    params: {},
    handoff: {
      handoffId: 'h-1',
      sourceAgent: 'orchestrator',
      targetAgent: 'researcher',
      taskType: 'delegate',
      instruction: 'Research AI market trends',
    },
  }, { agentId: 'orchestrator' });

  assert(result1.success === true, 'CrewAI agent returns success');
  assert(
    (result1.data as any)?.response === 'Research findings for: Research AI market trends',
    'CrewAI agent processes instruction'
  );

  // Execute crew
  const result2 = await adapter.executeAgent('analysis_crew', {
    action: 'analyze',
    params: {},
    handoff: {
      handoffId: 'h-2',
      sourceAgent: 'orchestrator',
      targetAgent: 'analysis_crew',
      taskType: 'delegate',
      instruction: 'Analyze Q4 performance',
    },
  }, { agentId: 'orchestrator' });

  assert(result2.success === true, 'CrewAI crew returns success');
  assert(
    (result2.data as any)?.crewResult?.report === 'Crew report for: Analyze Q4 performance',
    'CrewAI crew processes kickoff inputs'
  );
  assert((result2.data as any)?.agentCount === 2, 'Crew reports agent count');

  assert(result1.metadata?.adapter === 'crewai', 'Adapter name is "crewai"');

  await adapter.shutdown();
}

// ============================================================================
// TEST 5: MCPAdapter — Tool handlers
// ============================================================================

async function testMCPAdapter(): Promise<void> {
  section('MCPAdapter — Tool Handlers');

  const adapter = new MCPAdapter();
  await adapter.initialize({});

  // Register a local tool
  adapter.registerTool('search', async (args) => {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ results: [`Found: ${args.instruction}`], count: 1 }),
      }],
    };
  }, { description: 'Search tool' });

  // Register tool that returns error
  adapter.registerTool('failing_tool', async () => {
    return {
      content: [{ type: 'text', text: 'Something went wrong' }],
      isError: true,
    };
  });

  // Execute search tool
  const result1 = await adapter.executeAgent('search', {
    action: 'search',
    params: {},
    handoff: {
      handoffId: 'h-1',
      sourceAgent: 'orchestrator',
      targetAgent: 'search',
      taskType: 'delegate',
      instruction: 'Find market data',
    },
  }, { agentId: 'orchestrator' });

  assert(result1.success === true, 'MCP tool returns success');
  assert(
    (result1.data as any)?.results?.[0] === 'Found: Find market data',
    'MCP tool processes args and returns parsed JSON'
  );

  // Execute failing tool
  const result2 = await adapter.executeAgent('failing_tool', {
    action: 'test',
    params: {},
  }, { agentId: 'orchestrator' });

  assert(result2.success === false, 'MCP failing tool returns failure');
  assert(result2.error?.code === 'TOOL_ERROR', 'Error code is TOOL_ERROR');

  // Non-existent tool
  const result3 = await adapter.executeAgent('nonexistent', {
    action: 'test',
    params: {},
  }, { agentId: 'orchestrator' });

  assert(result3.success === false, 'Non-existent tool returns failure');

  assert(result1.metadata?.adapter === 'mcp', 'Adapter name is "mcp"');

  await adapter.shutdown();
}

// ============================================================================
// TEST 6: AdapterRegistry — Routing and multi-adapter execution
// ============================================================================

async function testAdapterRegistry(): Promise<void> {
  section('AdapterRegistry — Routing & Multi-Adapter');

  const registry = new AdapterRegistry();

  // Set up CustomAdapter with agents
  const custom = new CustomAdapter();
  custom.registerHandler('reviewer', async (payload) => {
    return { review: `Reviewed: ${payload.handoff?.instruction ?? 'N/A'}` };
  });

  // Set up LangChainAdapter with agents
  const lc = new LangChainAdapter();
  lc.registerAgent('research', async (input: unknown) => {
    const data = input as Record<string, unknown>;
    return { result: `LC research: ${data.input}` };
  });

  // Register both adapters
  await registry.addAdapter(custom);
  await registry.addAdapter(lc);

  // List adapters
  const adapters = registry.listAdapters();
  assert(adapters.length === 2, `Registry has 2 adapters (got ${adapters.length})`);
  assert(adapters.some(a => a.name === 'custom' && a.ready), 'Custom adapter is ready');
  assert(adapters.some(a => a.name === 'langchain' && a.ready), 'LangChain adapter is ready');

  // Test prefix-based routing: "custom:reviewer" → custom adapter
  const result1 = await registry.executeAgent('custom:reviewer', {
    action: 'review',
    params: {},
    handoff: {
      handoffId: 'h-1',
      sourceAgent: 'orchestrator',
      targetAgent: 'reviewer',
      taskType: 'delegate',
      instruction: 'Review the report',
    },
  }, { agentId: 'orchestrator' });

  assert(result1.success === true, 'Prefix routing "custom:reviewer" → custom adapter works');
  assert((result1.data as any)?.review === 'Reviewed: Review the report', 'Custom agent executed correctly via registry');
  assert(result1.metadata?.adapter === 'custom', 'Result tagged with correct adapter');

  // Test prefix-based routing: "langchain:research" → langchain adapter
  const result2 = await registry.executeAgent('langchain:research', {
    action: 'research',
    params: {},
    handoff: {
      handoffId: 'h-2',
      sourceAgent: 'orchestrator',
      targetAgent: 'research',
      taskType: 'delegate',
      instruction: 'Research trends',
    },
  }, { agentId: 'orchestrator' });

  assert(result2.success === true, 'Prefix routing "langchain:research" → langchain adapter works');
  assert(result2.metadata?.adapter === 'langchain', 'LangChain result tagged correctly');

  // Test explicit route
  registry.addRoute({ pattern: 'analyst*', adapterName: 'custom', priority: 10 });
  custom.registerHandler('analyst_v2', async () => ({ report: 'done' }));

  const result3 = await registry.executeAgent('analyst_v2', {
    action: 'analyze',
    params: {},
  }, { agentId: 'orchestrator' });

  assert(result3.success === true, 'Explicit route "analyst*" → custom works');

  // Test default adapter
  registry.setDefaultAdapter('custom');
  custom.registerHandler('fallback_agent', async () => ({ fallback: true }));

  const result4 = await registry.executeAgent('fallback_agent', {
    action: 'test',
    params: {},
  }, { agentId: 'orchestrator' });

  assert(result4.success === true, 'Default adapter handles unrouted agents');

  // Test no adapter found
  const registry2 = new AdapterRegistry();
  const result5 = await registry2.executeAgent('nobody', {
    action: 'test',
    params: {},
  }, { agentId: 'orchestrator' });

  assert(result5.success === false, 'Returns error when no adapter found');
  assert(result5.error?.code === 'NO_ADAPTER', 'Error code is NO_ADAPTER');

  // Discovery across all adapters
  const allAgents = await registry.discoverAgents();
  assert(allAgents.length >= 3, `Discovers agents across adapters (found ${allAgents.length})`);

  // Health check
  const health = await registry.healthCheck();
  assert(health['custom']?.healthy === true, 'Custom adapter health: healthy');
  assert(health['langchain']?.healthy === true, 'LangChain adapter health: healthy');

  // Events
  let eventFired = false;
  registry.on('agent:execution:complete', () => { eventFired = true; });
  await registry.executeAgent('custom:reviewer', {
    action: 'test',
    params: {},
    handoff: {
      handoffId: 'h-ev',
      sourceAgent: 'o',
      targetAgent: 'reviewer',
      taskType: 'delegate',
      instruction: 'test',
    },
  }, { agentId: 'orchestrator' });
  assert(eventFired, 'Event "agent:execution:complete" fires after execution');

  // Shutdown
  await registry.shutdownAll();
  const adaptersAfter = registry.listAdapters();
  assert(adaptersAfter.length === 0, 'shutdownAll() clears all adapters');
}

// ============================================================================
// TEST 7: Custom BaseAdapter subclass
// ============================================================================

async function testWritingCustomAdapter(): Promise<void> {
  section('Custom Adapter Subclass — Write Your Own');

  // Simulate writing a custom adapter from scratch
  class MyFrameworkAdapter extends BaseAdapter {
    readonly name = 'my-framework';
    readonly version = '0.1.0';
    private agentLogic: Map<string, (task: string) => Promise<string>> = new Map();

    registerMyAgent(id: string, fn: (task: string) => Promise<string>): void {
      this.agentLogic.set(id, fn);
      this.registerLocalAgent({ id, name: id, status: 'available' });
    }

    async executeAgent(agentId: string, payload: AgentPayload, context: AgentContext): Promise<AgentResult> {
      this.ensureReady();
      const fn = this.agentLogic.get(agentId);
      if (!fn) return this.errorResult('NOT_FOUND', `Agent ${agentId} not found`, false);

      const startTime = Date.now();
      const instruction = payload.handoff?.instruction ?? JSON.stringify(payload.params);
      const result = await fn(instruction);
      return this.successResult(result, Date.now() - startTime);
    }
  }

  const adapter = new MyFrameworkAdapter();
  await adapter.initialize({});
  adapter.registerMyAgent('greeter', async (task) => `Hello from custom framework! Task: ${task}`);

  const result = await adapter.executeAgent('greeter', {
    action: 'greet',
    params: {},
    handoff: {
      handoffId: 'h-1',
      sourceAgent: 'orchestrator',
      targetAgent: 'greeter',
      taskType: 'delegate',
      instruction: 'Say hello',
    },
  }, { agentId: 'orchestrator' });

  assert(result.success === true, 'Custom subclass adapter works');
  assert((result.data as string) === 'Hello from custom framework! Task: Say hello', 'Custom adapter processes correctly');
  assert(result.metadata?.adapter === 'my-framework', 'Custom adapter name is correct');

  // Plug it into the registry
  const registry = new AdapterRegistry();
  await registry.addAdapter(adapter);

  const result2 = await registry.executeAgent('my-framework:greeter', {
    action: 'greet',
    params: {},
    handoff: {
      handoffId: 'h-2',
      sourceAgent: 'orchestrator',
      targetAgent: 'greeter',
      taskType: 'delegate',
      instruction: 'Hi there',
    },
  }, { agentId: 'orchestrator' });

  assert(result2.success === true, 'Custom adapter works through registry routing');

  await registry.shutdownAll();
}

// ============================================================================
// TEST 8: Error handling and edge cases
// ============================================================================

async function testEdgeCases(): Promise<void> {
  section('Edge Cases & Error Handling');

  const custom = new CustomAdapter();
  await custom.initialize({});

  // Handler that throws
  custom.registerHandler('crasher', async () => {
    throw new Error('Boom!');
  });

  const result1 = await custom.executeAgent('crasher', {
    action: 'crash',
    params: {},
  }, { agentId: 'orchestrator' });

  assert(result1.success === false, 'Throwing handler returns failure (not unhandled exception)');
  assert(result1.error?.code === 'HANDLER_ERROR', 'Error code is HANDLER_ERROR');
  assert(result1.error?.message === 'Boom!', 'Original error message preserved');
  assert(result1.error?.recoverable === true, 'Errors are recoverable by default');

  // Uninitialized adapter
  const uninit = new CustomAdapter();
  try {
    await uninit.executeAgent('test', { action: 'test', params: {} }, { agentId: 'o' });
    assert(false, 'Should have thrown on uninitialized adapter');
  } catch (e) {
    assert(true, 'Uninitialized adapter throws on execute');
  }

  // Duplicate adapter registration
  const registry = new AdapterRegistry();
  const a1 = new CustomAdapter();
  await registry.addAdapter(a1);
  try {
    const a2 = new CustomAdapter();
    registry.registerAdapter(a2);
    assert(false, 'Should reject duplicate adapter name');
  } catch {
    assert(true, 'Rejects duplicate adapter registration');
  }

  await registry.shutdownAll();
}

// ============================================================================
// TEST 9: OrchestratorAdapter — Hierarchical multi-orchestrator coordination
// ============================================================================

async function testOrchestratorAdapter(): Promise<void> {
  section('OrchestratorAdapter — Hierarchical Orchestration');

  const { OrchestratorAdapter } = await import('./adapters/orchestrator-adapter');
  const adapter = new OrchestratorAdapter();
  await adapter.initialize({});

  assert(adapter.isReady(), 'Adapter initializes and is ready');
  assert(adapter.name === 'orchestrator', 'Adapter name is "orchestrator"');
  assert(adapter.capabilities.parallel === true, 'Supports parallel execution');
  assert(adapter.capabilities.discovery === true, 'Supports discovery');
  assert(adapter.capabilities.statefulSessions === true, 'Supports stateful sessions');

  // --- Register a mock child orchestrator ---

  const childLog: string[] = [];

  const mockChildOrchestrator = {
    name: 'ChildSwarm',
    execute: async (
      action: string,
      params: Record<string, unknown>,
      context: { agentId: string; taskId?: string; sessionId?: string }
    ) => {
      childLog.push(`${action}:${context.agentId}`);

      if (action === 'delegate_task') {
        const taskPayload = params.taskPayload as Record<string, unknown>;
        return {
          success: true,
          data: {
            taskId: 'child-task-1',
            status: 'completed',
            result: {
              success: true,
              data: { output: `Child processed: ${taskPayload?.instruction}` },
            },
            agentTrace: ['parent', params.targetAgent as string],
          },
        };
      }

      if (action === 'query_swarm_state') {
        return {
          success: true,
          data: {
            timestamp: new Date().toISOString(),
            activeAgents: [
              { agentId: 'child-worker-1', status: 'idle' },
              { agentId: 'child-worker-2', status: 'busy' },
            ],
            pendingTasks: [],
          },
        };
      }

      return { success: false, error: { code: 'UNKNOWN', message: `Unknown: ${action}`, recoverable: false } };
    },
  };

  adapter.registerOrchestrator('backend-team', mockChildOrchestrator, {
    description: 'Backend team orchestrator',
    defaultTargetAgent: 'child-worker-1',
    timeout: 5_000,
  });

  // --- Listing ---
  const agents = await adapter.listAgents();
  assert(agents.length === 1, 'One child orchestrator registered');
  assert(agents[0].id === 'backend-team', 'Agent ID matches orchestrator ID');
  assert(agents[0].name === 'ChildSwarm', 'Agent name comes from orchestrator.name');
  assert(agents[0].metadata?.type === 'orchestrator', 'Metadata marks it as orchestrator');

  const orchList = adapter.listOrchestrators();
  assert(orchList.length === 1 && orchList[0] === 'backend-team', 'listOrchestrators() returns IDs');

  // --- Execute: delegates to child via delegate_task ---
  const result = await adapter.executeAgent('backend-team', {
    action: 'execute',
    params: {},
    handoff: {
      handoffId: 'h-orch-1',
      sourceAgent: 'root',
      targetAgent: 'child-worker-2',
      taskType: 'delegate',
      instruction: 'Refactor auth module',
    },
  }, { agentId: 'root' });

  assert(result.success === true, 'Execution succeeds');
  const data = result.data as Record<string, unknown>;
  assert(data.orchestratorId === 'backend-team', 'Result includes orchestrator ID');
  assert(data.hierarchy === true, 'Result includes hierarchy flag');
  assert(childLog[0] === 'delegate_task:root', 'Child received delegate_task with correct caller');

  // Verify child received the right target agent from handoff
  const childResult = data.childResult as Record<string, unknown>;
  assert(childResult?.status === 'completed', 'Child completed the task');

  // --- Execute with defaultTargetAgent (no handoff.targetAgent) ---
  const result2 = await adapter.executeAgent('backend-team', {
    action: 'execute',
    params: { instruction: 'Run migrations' },
  }, { agentId: 'root' });

  assert(result2.success === true, 'Execution without explicit target uses default');

  // --- queryChildState ---
  const state = await adapter.queryChildState('backend-team');
  assert(state !== null, 'queryChildState returns non-null');
  assert(state!.orchestratorId === 'backend-team', 'State includes orchestrator ID');
  assert(state!.busy === false, 'Child is not busy after completion');
  const swarmState = state!.swarmState as Record<string, unknown>;
  assert(Array.isArray(swarmState.activeAgents), 'Swarm state includes active agents');
  assert((swarmState.activeAgents as unknown[]).length === 2, 'Child has 2 agents');

  // --- queryAllChildStates ---
  const allStates = await adapter.queryAllChildStates();
  assert(allStates.length === 1, 'queryAllChildStates returns all children');

  // --- isChildBusy ---
  assert(adapter.isChildBusy('backend-team') === false, 'Child not busy when idle');
  assert(adapter.isChildBusy('nonexistent') === false, 'Non-existent child returns false');

  // --- queryChildState for non-existent ---
  const nullState = await adapter.queryChildState('ghost');
  assert(nullState === null, 'queryChildState returns null for unknown orchestrator');

  // --- Execute on non-existent child ---
  const errResult = await adapter.executeAgent('ghost', {
    action: 'execute',
    params: {},
  }, { agentId: 'root' });
  assert(errResult.success === false, 'Executing non-existent child fails');
  assert(errResult.error?.code === 'ORCHESTRATOR_NOT_FOUND', 'Error code is ORCHESTRATOR_NOT_FOUND');

  // --- Register second child orchestrator ---
  const mockChild2 = {
    name: 'FrontendSwarm',
    execute: async () => ({
      success: true,
      data: { taskId: 'fe-1', status: 'completed', result: { data: 'ui-built' } },
    }),
  };
  adapter.registerOrchestrator('frontend-team', mockChild2, {
    description: 'Frontend team orchestrator',
  });

  const agents2 = await adapter.listAgents();
  assert(agents2.length === 2, 'Two child orchestrators after second registration');

  const allStates2 = await adapter.queryAllChildStates();
  assert(allStates2.length === 2, 'queryAllChildStates returns both children');

  // --- Remove orchestrator ---
  const removed = adapter.removeOrchestrator('frontend-team');
  assert(removed === true, 'removeOrchestrator returns true on success');
  assert((await adapter.listAgents()).length === 1, 'Agent list shrinks after removal');
  assert(adapter.removeOrchestrator('ghost') === false, 'removeOrchestrator returns false for unknown');

  // --- Error from child propagates correctly ---
  const failingChild = {
    name: 'FailSwarm',
    execute: async () => ({
      success: false,
      error: { code: 'CHILD_BROKE', message: 'Something went wrong', recoverable: true },
    }),
  };
  adapter.registerOrchestrator('failing-team', failingChild);

  const failResult = await adapter.executeAgent('failing-team', {
    action: 'execute',
    params: { instruction: 'Break things' },
  }, { agentId: 'root' });
  assert(failResult.success === false, 'Failed child result propagates as failure');
  assert(failResult.error?.code === 'CHILD_BROKE', 'Child error code preserved');

  // --- Child that throws ---
  const throwingChild = {
    name: 'ThrowSwarm',
    execute: async () => { throw new Error('Kaboom!'); },
  };
  adapter.registerOrchestrator('throw-team', throwingChild);

  const throwResult = await adapter.executeAgent('throw-team', {
    action: 'execute',
    params: { instruction: 'Explode' },
  }, { agentId: 'root' });
  assert(throwResult.success === false, 'Throwing child returns failure');
  assert(throwResult.error?.code === 'CHILD_EXECUTION_ERROR', 'Error code is CHILD_EXECUTION_ERROR');
  assert(throwResult.error?.message === 'Kaboom!', 'Thrown error message preserved');

  // --- Validation: bad registration inputs ---
  let threw = false;
  try {
    adapter.registerOrchestrator('', mockChildOrchestrator);
  } catch {
    threw = true;
  }
  assert(threw, 'Rejects empty orchestratorId');

  threw = false;
  try {
    adapter.registerOrchestrator('bad', { name: 'x' } as never);
  } catch {
    threw = true;
  }
  assert(threw, 'Rejects orchestrator without execute()');

  // --- Registry integration ---
  const registry = new AdapterRegistry();
  await registry.addAdapter(adapter);

  const regResult = await registry.executeAgent('orchestrator:backend-team', {
    action: 'execute',
    params: {},
    handoff: {
      handoffId: 'h-reg-1',
      sourceAgent: 'root',
      targetAgent: 'child-worker-1',
      taskType: 'delegate',
      instruction: 'Registry-routed task',
    },
  }, { agentId: 'root' });
  assert(regResult.success === true, 'Works through AdapterRegistry routing');

  // --- Shutdown ---
  await adapter.shutdown();
  assert(adapter.listOrchestrators().length === 0, 'Shutdown clears all children');
  assert((await adapter.listAgents()).length === 0, 'Shutdown clears agent registry');

  await registry.shutdownAll();
}

// ============================================================================
// TEST 9: LlamaIndexAdapter
// ============================================================================

async function testLlamaIndexAdapter(): Promise<void> {
  section('LlamaIndexAdapter — Query, Chat, & Agent Engines');

  const { LlamaIndexAdapter } = await import('./adapters/llamaindex-adapter');
  const adapter = new LlamaIndexAdapter();
  await adapter.initialize({});

  // Register a query engine
  const mockQueryEngine = {
    query: async (q: string) => ({
      response: `Answer to: ${q}`,
      sourceNodes: [{ node: { text: 'Source doc text', metadata: { file: 'test.pdf' } }, score: 0.95 }],
    }),
  };
  adapter.registerQueryEngine('search', mockQueryEngine, { description: 'Test search engine' });

  // Register a chat engine
  const mockChatEngine = {
    chat: async (msg: string, _history?: unknown[]) => ({
      response: `Chat reply: ${msg}`,
    }),
    reset: () => {},
  };
  adapter.registerChatEngine('assistant', mockChatEngine);

  // Register an agent runner
  const mockAgentRunner = {
    chat: async (msg: string) => ({
      response: `Agent handled: ${msg}`,
      metadata: { steps: 3 },
    }),
  };
  adapter.registerAgentRunner('researcher', mockAgentRunner);

  const agents = await adapter.listAgents();
  assert(agents.length === 3, 'Three LlamaIndex engines registered');

  // Test query engine
  const ctx: AgentContext = { agentId: 'test', taskId: 't1' };
  const qResult = await adapter.executeAgent('search', {
    action: 'query',
    params: { query: 'What is AI?' },
  }, ctx);
  assert(qResult.success === true, 'Query engine executes successfully');
  assert((qResult.data as Record<string, unknown>).response === 'Answer to: What is AI?', 'Query response content correct');
  assert(((qResult.data as Record<string, unknown>).sources as unknown[])?.length === 1, 'Source nodes included');

  // Test chat engine
  const cResult = await adapter.executeAgent('assistant', {
    action: 'chat',
    params: {},
    handoff: { handoffId: 'h1', sourceAgent: 'test', targetAgent: 'assistant', taskType: 'delegate' as const, instruction: 'Hello there' },
  }, ctx);
  assert(cResult.success === true, 'Chat engine executes successfully');
  assert((cResult.data as Record<string, unknown>).response === 'Chat reply: Hello there', 'Chat response correct');

  // Test agent runner
  const aResult = await adapter.executeAgent('researcher', {
    action: 'research',
    params: {},
    handoff: { handoffId: 'h2', sourceAgent: 'test', targetAgent: 'researcher', taskType: 'delegate' as const, instruction: 'Find papers on transformers' },
  }, ctx);
  assert(aResult.success === true, 'Agent runner executes successfully');
  assert((aResult.data as Record<string, unknown>).response === 'Agent handled: Find papers on transformers', 'Agent response correct');

  // Not found
  const nf = await adapter.executeAgent('nonexistent', { action: 'x', params: {} }, ctx);
  assert(nf.success === false, 'Returns error for unknown engine');

  await adapter.shutdown();
  assert(adapter.isReady() === false, 'Adapter shuts down cleanly');
}

// ============================================================================
// TEST 10: SemanticKernelAdapter
// ============================================================================

async function testSemanticKernelAdapter(): Promise<void> {
  section('SemanticKernelAdapter — Kernel & Function Execution');

  const { SemanticKernelAdapter } = await import('./adapters/semantic-kernel-adapter');
  const adapter = new SemanticKernelAdapter();
  await adapter.initialize({});

  // Register a kernel with planner
  const mockKernel = {
    runPlan: async (goal: string) => ({
      result: `Plan executed: ${goal}`,
      steps: [{ plugin: 'web', function: 'search', result: 'found' }],
    }),
    invokePrompt: async (prompt: string) => ({
      value: `Prompt result: ${prompt}`,
    }),
    invokeFunction: async (name: string, args?: Record<string, unknown>) => ({
      value: `Function ${name} result`,
      metadata: { args },
    }),
  };
  adapter.registerKernel('planner', mockKernel);

  // Register an SK function
  const mockFn = {
    name: 'summarize',
    invoke: async (args?: Record<string, unknown>) => ({
      value: `Summary of: ${(args as Record<string, unknown>)?.input || 'nothing'}`,
    }),
  };
  adapter.registerFunction('summarizer', mockFn);

  const agents = await adapter.listAgents();
  assert(agents.length === 2, 'Two SK entries registered');

  const ctx: AgentContext = { agentId: 'test', taskId: 't1' };

  // Test kernel planner
  const planResult = await adapter.executeAgent('planner', {
    action: 'plan',
    params: {},
    handoff: { handoffId: 'h1', sourceAgent: 'test', targetAgent: 'planner', taskType: 'delegate' as const, instruction: 'Analyse market trends' },
  }, ctx);
  assert(planResult.success === true, 'Kernel planner executes successfully');
  assert((planResult.data as Record<string, unknown>).response === 'Plan executed: Analyse market trends', 'Plan result correct');
  assert(((planResult.data as Record<string, unknown>).steps as unknown[])?.length === 1, 'Plan steps included');

  // Test SK function
  const fnResult = await adapter.executeAgent('summarizer', {
    action: 'summarize',
    params: {},
    handoff: { handoffId: 'h2', sourceAgent: 'test', targetAgent: 'summarizer', taskType: 'delegate' as const, instruction: 'Long document content here...' },
  }, ctx);
  assert(fnResult.success === true, 'SK function executes successfully');
  assert(((fnResult.data as Record<string, unknown>).response as string).includes('Summary of'), 'Function result correct');

  // Not found
  const nf = await adapter.executeAgent('missing', { action: 'x', params: {} }, ctx);
  assert(nf.success === false, 'Returns error for unknown entry');

  await adapter.shutdown();
}

// ============================================================================
// TEST 11: OpenAIAssistantsAdapter
// ============================================================================

async function testOpenAIAssistantsAdapter(): Promise<void> {
  section('OpenAIAssistantsAdapter — Chat & Thread-based Execution');

  const { OpenAIAssistantsAdapter } = await import('./adapters/openai-assistants-adapter');
  const adapter = new OpenAIAssistantsAdapter();

  // Mock client with simple chat interface
  const mockClient = {
    chat: async (assistantId: string, message: string) => ({
      response: `Assistant ${assistantId}: ${message}`,
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }),
  };

  await adapter.initialize({ options: { client: mockClient } });

  adapter.registerAssistant('analyst', {
    assistantId: 'asst_abc123',
  });

  const agents = await adapter.listAgents();
  assert(agents.length === 1, 'One assistant registered');

  const ctx: AgentContext = { agentId: 'test', taskId: 't1' };

  // Test chat
  const result = await adapter.executeAgent('analyst', {
    action: 'analyze',
    params: {},
    handoff: { handoffId: 'h1', sourceAgent: 'test', targetAgent: 'agent', taskType: 'delegate' as const, instruction: 'Analyse Q4 earnings' },
  }, ctx);
  assert(result.success === true, 'Assistant executes successfully');
  assert(((result.data as Record<string, unknown>).response as string).includes('Analyse Q4 earnings'), 'Response contains instruction');
  assert(((result.data as Record<string, unknown>).usage as Record<string, unknown>)?.total_tokens === 30, 'Usage stats included');

  // Test thread-based client
  const adapter2 = new OpenAIAssistantsAdapter();
  let threadCount = 0;
  const messages: string[] = [];
  const threadClient = {
    createThread: async () => ({ id: `thread_${++threadCount}` }),
    addMessage: async (_tid: string, msg: { role: string; content: string }) => { messages.push(msg.content); },
    createAndPollRun: async () => ({
      status: 'completed' as const,
      messages: [
        { role: 'assistant' as const, content: 'Analysis complete' },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    }),
  };
  await adapter2.initialize({});
  adapter2.registerAssistant('bot', { assistantId: 'asst_xyz' }, threadClient);

  const r2 = await adapter2.executeAgent('bot', {
    action: 'test',
    params: {},
    handoff: { handoffId: 'h1', sourceAgent: 'test', targetAgent: 'agent', taskType: 'delegate' as const, instruction: 'Hello bot' },
  }, ctx);
  assert(r2.success === true, 'Thread-based execution succeeds');
  assert((r2.data as Record<string, unknown>).response === 'Analysis complete', 'Thread response correct');
  assert((r2.data as Record<string, unknown>).threadId === 'thread_1', 'Thread ID returned');

  // No client error
  const adapter3 = new OpenAIAssistantsAdapter();
  await adapter3.initialize({});
  adapter3.registerAssistant('orphan', { assistantId: 'asst_none' });
  const r3 = await adapter3.executeAgent('orphan', {
    action: 'test', params: {},
  }, ctx);
  assert(r3.success === false, 'Returns error when no client');
  assert(r3.error?.code === 'NO_CLIENT', 'Error code is NO_CLIENT');

  // Not found
  const nf = await adapter.executeAgent('ghost', { action: 'x', params: {} }, ctx);
  assert(nf.success === false, 'Returns error for unknown assistant');

  await adapter.shutdown();
  await adapter2.shutdown();
  await adapter3.shutdown();
}

// ============================================================================
// TEST 12: HaystackAdapter
// ============================================================================

async function testHaystackAdapter(): Promise<void> {
  section('HaystackAdapter — Pipelines, Agents, & Components');

  const { HaystackAdapter } = await import('./adapters/haystack-adapter');
  const adapter = new HaystackAdapter();
  await adapter.initialize({});

  // Mock pipeline
  const mockPipeline = {
    run: async (inputs: Record<string, unknown>) => ({
      llm: { replies: [`Answer to: ${inputs.query}`] },
      retriever: { documents: [{ content: 'Doc 1' }] },
    }),
    getMetadata: () => ({ name: 'rag-pipeline', components: ['retriever', 'llm'] }),
  };
  adapter.registerPipeline('rag', mockPipeline);

  // Mock agent
  const mockAgent = {
    run: async (query: string) => ({
      answer: `Agent answer: ${query}`,
      documents: [{ content: 'Supporting doc', score: 0.9, meta: { source: 'test' } }],
    }),
  };
  adapter.registerAgent('qa', mockAgent);

  // Mock component
  const mockComponent = {
    run: async (inputs: Record<string, unknown>) => ({
      output: `Processed: ${JSON.stringify(inputs)}`,
    }),
  };
  adapter.registerComponent('processor', mockComponent);

  const agents = await adapter.listAgents();
  assert(agents.length === 3, 'Three Haystack entries registered');

  const ctx: AgentContext = { agentId: 'test', taskId: 't1' };

  // Test pipeline
  const pResult = await adapter.executeAgent('rag', {
    action: 'query',
    params: {},
    handoff: { handoffId: 'h1', sourceAgent: 'test', targetAgent: 'agent', taskType: 'delegate' as const, instruction: 'What is RAG?' },
  }, ctx);
  assert(pResult.success === true, 'Pipeline executes successfully');
  assert(Array.isArray((pResult.data as Record<string, unknown>).response), 'Pipeline returns replies array');

  // Test agent
  const aResult = await adapter.executeAgent('qa', {
    action: 'ask',
    params: { query: 'Explain transformers' },
  }, ctx);
  assert(aResult.success === true, 'Agent executes successfully');
  assert((aResult.data as Record<string, unknown>).response === 'Agent answer: Explain transformers', 'Agent response correct');
  assert(((aResult.data as Record<string, unknown>).documents as unknown[])?.length === 1, 'Documents included');

  // Test component
  const cResult = await adapter.executeAgent('processor', {
    action: 'process',
    params: { text: 'hello' },
  }, ctx);
  assert(cResult.success === true, 'Component executes successfully');

  // Not found
  const nf = await adapter.executeAgent('missing', { action: 'x', params: {} }, ctx);
  assert(nf.success === false, 'Returns error for unknown entry');

  await adapter.shutdown();
}

// ============================================================================
// TEST 13: DSPyAdapter
// ============================================================================

async function testDSPyAdapter(): Promise<void> {
  section('DSPyAdapter — Modules, Programs, & Predictors');

  const { DSPyAdapter } = await import('./adapters/dspy-adapter');
  const adapter = new DSPyAdapter();
  await adapter.initialize({});

  // Mock module
  const mockModule = {
    forward: async (inputs: Record<string, unknown>) => ({
      answer: `Classified: ${inputs.question || inputs.query}`,
      rationale: 'Based on analysis...',
    }),
  };
  adapter.registerModule('classifier', mockModule);

  // Mock program
  const mockProgram = {
    run: async (inputs: Record<string, unknown>) => ({
      answer: `Program result for: ${inputs.question}`,
      response: 'Compiled output',
    }),
  };
  adapter.registerProgram('rag-pipeline', mockProgram);

  // Mock predictor (simple function)
  adapter.registerPredictor('simple', async (inputs) => ({
    answer: `Predicted: ${inputs.question || 'unknown'}`,
  }));

  const agents = await adapter.listAgents();
  assert(agents.length === 3, 'Three DSPy entries registered');

  const ctx: AgentContext = { agentId: 'test', taskId: 't1' };

  // Test module
  const mResult = await adapter.executeAgent('classifier', {
    action: 'classify',
    params: {},
    handoff: { handoffId: 'h1', sourceAgent: 'test', targetAgent: 'agent', taskType: 'delegate' as const, instruction: 'Is this spam?' },
  }, ctx);
  assert(mResult.success === true, 'Module executes successfully');
  assert((mResult.data as Record<string, unknown>).response === 'Classified: Is this spam?', 'Module answer correct');
  assert((mResult.data as Record<string, unknown>).rationale === 'Based on analysis...', 'Rationale included');

  // Test program
  const pResult = await adapter.executeAgent('rag-pipeline', {
    action: 'run',
    params: {},
    handoff: { handoffId: 'h1', sourceAgent: 'test', targetAgent: 'agent', taskType: 'delegate' as const, instruction: 'What is DSPy?' },
  }, ctx);
  assert(pResult.success === true, 'Program executes successfully');
  assert((pResult.data as Record<string, unknown>).response === 'Program result for: What is DSPy?', 'Program result correct');

  // Test predictor
  const prResult = await adapter.executeAgent('simple', {
    action: 'predict',
    params: {},
    handoff: { handoffId: 'h1', sourceAgent: 'test', targetAgent: 'agent', taskType: 'delegate' as const, instruction: 'Will it rain?' },
  }, ctx);
  assert(prResult.success === true, 'Predictor executes successfully');
  assert((prResult.data as Record<string, unknown>).response === 'Predicted: Will it rain?', 'Prediction correct');

  // Not found
  const nf = await adapter.executeAgent('nope', { action: 'x', params: {} }, ctx);
  assert(nf.success === false, 'Returns error for unknown entry');

  // Test module with __call__
  const callModule = {
    forward: async () => ({ answer: 'forward' }),
    __call__: async (inputs: Record<string, unknown>) => ({
      answer: `Called: ${inputs.question}`,
    }),
  };
  adapter.registerModule('callable', callModule);
  const callResult = await adapter.executeAgent('callable', {
    action: 'test',
    params: {},
    handoff: { handoffId: 'h1', sourceAgent: 'test', targetAgent: 'agent', taskType: 'delegate' as const, instruction: 'test call' },
  }, ctx);
  assert(callResult.success === true, '__call__ interface works');
  assert((callResult.data as Record<string, unknown>).response === 'Called: test call', '__call__ preferred over forward');

  await adapter.shutdown();
}

// ============================================================================
// TEST 14: AgnoAdapter
// ============================================================================

async function testAgnoAdapter(): Promise<void> {
  section('AgnoAdapter — Agents, Teams, & Functions');

  const { AgnoAdapter } = await import('./adapters/agno-adapter');
  const adapter = new AgnoAdapter();
  await adapter.initialize({});

  // Mock agent
  const mockAgent = {
    name: 'ResearchBot',
    run: async (message: string) => ({
      content: `Researched: ${message}`,
      toolCalls: [{ name: 'web_search', args: { q: message }, result: 'found data' }],
      usage: { input_tokens: 50, output_tokens: 100 },
    }),
  };
  adapter.registerAgent('researcher', mockAgent);

  // Mock team
  const mockTeam = {
    name: 'DevTeam',
    members: [{ name: 'coder', role: 'developer' }, { name: 'reviewer', role: 'qa' }],
    run: async (message: string) => ({
      content: `Team handled: ${message}`,
      respondingAgent: 'coder',
    }),
  };
  adapter.registerTeam('dev-team', mockTeam);

  // Mock function
  adapter.registerFunction('quick-calc', async (msg) => {
    return `Calculated: ${msg}`;
  });

  const agents = await adapter.listAgents();
  assert(agents.length === 3, 'Three Agno entries registered');

  const ctx: AgentContext = { agentId: 'test', taskId: 't1' };

  // Test agent
  const aResult = await adapter.executeAgent('researcher', {
    action: 'research',
    params: {},
    handoff: { handoffId: 'h1', sourceAgent: 'test', targetAgent: 'agent', taskType: 'delegate' as const, instruction: 'Find AI papers from 2024' },
  }, ctx);
  assert(aResult.success === true, 'Agent executes successfully');
  assert((aResult.data as Record<string, unknown>).response === 'Researched: Find AI papers from 2024', 'Agent response correct');
  assert(((aResult.data as Record<string, unknown>).toolCalls as unknown[])?.length === 1, 'Tool calls included');
  assert(((aResult.data as Record<string, unknown>).usage as Record<string, unknown>)?.input_tokens === 50, 'Usage stats included');

  // Test team
  const tResult = await adapter.executeAgent('dev-team', {
    action: 'develop',
    params: {},
    handoff: { handoffId: 'h1', sourceAgent: 'test', targetAgent: 'agent', taskType: 'delegate' as const, instruction: 'Build a REST API' },
  }, ctx);
  assert(tResult.success === true, 'Team executes successfully');
  assert((tResult.data as Record<string, unknown>).response === 'Team handled: Build a REST API', 'Team response correct');
  assert((tResult.data as Record<string, unknown>).respondingAgent === 'coder', 'Responding agent identified');
  assert((tResult.data as Record<string, unknown>).team === 'DevTeam', 'Team name included');

  // Test function
  const fResult = await adapter.executeAgent('quick-calc', {
    action: 'calculate',
    params: {},
    handoff: { handoffId: 'h1', sourceAgent: 'test', targetAgent: 'agent', taskType: 'delegate' as const, instruction: '2 + 2' },
  }, ctx);
  assert(fResult.success === true, 'Function executes successfully');
  assert((fResult.data as Record<string, unknown>).response === 'Calculated: 2 + 2', 'Function response correct');

  // Not found
  const nf = await adapter.executeAgent('ghost', { action: 'x', params: {} }, ctx);
  assert(nf.success === false, 'Returns error for unknown entry');

  // Test function returning AgnoResponse object
  adapter.registerFunction('structured', async (msg) => ({
    content: `Structured: ${msg}`,
    messages: [{ role: 'assistant', content: msg }],
  }));
  const sResult = await adapter.executeAgent('structured', {
    action: 'test', params: {}, handoff: { handoffId: 'h1', sourceAgent: 'test', targetAgent: 'agent', taskType: 'delegate' as const, instruction: 'hello' },
  }, ctx);
  assert(sResult.success === true, 'Structured function response works');
  assert((sResult.data as Record<string, unknown>).response === 'Structured: hello', 'Structured content extracted');

  await adapter.shutdown();
  assert(adapter.isReady() === false, 'Adapter shuts down cleanly');
}

// ============================================================================
// TEST 15b: HermesAdapter
// ============================================================================

async function testHermesAdapter(): Promise<void> {
  section('HermesAdapter — NousResearch Hermes (BYOC / OpenAI-compatible)');

  const { HermesAdapter } = await import('./adapters/hermes-adapter');
  const adapter = new HermesAdapter();
  await adapter.initialize({});

  // --- Registration ---
  adapter.registerAgent('assistant', {
    model: 'hermes3',
    systemPrompt: 'You are a helpful assistant.',
  });
  adapter.registerAgent('reasoner', {
    model: 'hermes3:70b',
    baseUrl: 'http://localhost:11434/v1',
    maxTokens: 512,
    temperature: 0.4,
  });

  const agents = await adapter.listAgents();
  assert(agents.length === 2, 'Two Hermes agents registered');
  assert(agents.some((a) => a.id === 'assistant'), 'assistant agent registered');
  assert(agents.some((a) => a.id === 'reasoner'), 'reasoner agent registered');

  // --- BYOC client path ---
  const mockClient = {
    create: async (params: {
      model: string;
      messages: Array<{ role: string; content: string }>;
    }) => ({
      choices: [{ message: { content: `Echo: ${params.messages[params.messages.length - 1].content}` } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }),
  };
  adapter.registerAgent('byoc', { model: 'hermes3', client: mockClient });

  const ctx: AgentContext = { agentId: 'test', taskId: 't1' };
  const result = await adapter.executeAgent('byoc', {
    action: 'greet',
    params: {},
    handoff: {
      handoffId: 'h1',
      sourceAgent: 'test',
      targetAgent: 'byoc',
      taskType: 'delegate' as const,
      instruction: 'Say hello',
    },
  }, ctx);

  assert(result.success === true, 'BYOC agent executes successfully');
  const data = result.data as Record<string, unknown>;
  assert(typeof data.response === 'string', 'Response is a string');
  assert((data.response as string).includes('Say hello'), 'Response contains prompt content');
  assert(data.model === 'hermes3', 'Model name preserved in result');
  assert((data.usage as Record<string, number>).total_tokens === 30, 'Usage stats returned');

  // --- Error: unknown agent ---
  const errResult = await adapter.executeAgent('no-such-agent', { action: 'x', params: {} }, ctx);
  assert(errResult.success === false, 'Missing agent returns failure');
  assert(typeof (errResult.error as Record<string, unknown>)?.message === 'string', 'Error message provided');

  // --- Error: invalid agentId registration ---
  let threw = false;
  try {
    adapter.registerAgent('', { model: 'hermes3' });
  } catch {
    threw = true;
  }
  assert(threw, 'Empty agentId throws on registration');

  // --- Shutdown clears agents ---
  await adapter.shutdown();
  assert(!(await adapter.isAgentAvailable('byoc')), 'Agents cleared after shutdown');
}

// ============================================================================
// TEST 15: APSAdapter
// ============================================================================

async function testAPSAdapter(): Promise<void> {
  section('APS Adapter (Agent Permission Service)');

  const { APSAdapter } = await import('./adapters/aps-adapter');

  // 1. Fail closed: default 'local' verificationMode with no verifySignature
  //    callback must throw, never silently accept unverified delegations
  //    (GHSA-3jf7-33vc-hgf4 — the old default treated any non-empty
  //    signature string as verified).
  let initThrew = false;
  try {
    const unconfigured = new APSAdapter();
    await unconfigured.initialize({});
  } catch { initThrew = true; }
  assert(initThrew, 'APS: initialize({}) in default local mode throws without verifySignature (fail-closed, GHSA-3jf7-33vc-hgf4)');

  // 2. Initialize with an explicit BYOC verifier (required for local mode)
  const aps = new APSAdapter();
  await aps.initialize({ verifySignature: async (d) => d.signature.length > 0 });
  assert(true, 'APS adapter initializes with a BYOC verifySignature callback');

  // 2. Root delegation (depth 0) → full base trust
  const root = await aps.apsDelegationToTrust({
    delegator: 'root',
    delegatee: 'agent-1',
    scope: ['file:read', 'git:read'],
    currentDepth: 0,
    maxDepth: 3,
    signature: 'valid-sig-abc123',
  });
  assert(root.agentId === 'agent-1', 'APS: root delegation maps to correct agentId');
  assert(root.trustLevel === 0.8, `APS: root trust = baseTrust (0.8), got ${root.trustLevel}`);
  assert(root.allowedResources.includes('FILE_SYSTEM'), 'APS: file:read maps to FILE_SYSTEM');
  assert(root.allowedResources.includes('GIT'), 'APS: git:read maps to GIT');
  assert(root.apsMetadata.verified === true, 'APS: root delegation is verified');

  // 3. Mid-chain delegation (depth 1/3) → decayed trust
  const mid = await aps.apsDelegationToTrust({
    delegator: 'agent-1',
    delegatee: 'agent-2',
    scope: ['file:read'],
    currentDepth: 1,
    maxDepth: 3,
    signature: 'valid-sig-def456',
  });
  assert(mid.trustLevel > 0.6 && mid.trustLevel < 0.75, `APS: mid-chain trust decayed, got ${mid.trustLevel}`);
  assert(mid.allowedResources.length === 1, 'APS: scope narrowed to 1 resource');

  // 4. Max depth delegation → maximum decay
  const deep = await aps.apsDelegationToTrust({
    delegator: 'agent-2',
    delegatee: 'agent-3',
    scope: ['file:read'],
    currentDepth: 3,
    maxDepth: 3,
    signature: 'valid-sig-ghi789',
  });
  assert(deep.trustLevel === 0.48, `APS: max depth trust = 0.48, got ${deep.trustLevel}`);

  // 5. Empty signature → unverified → trust 0
  const unverified = await aps.apsDelegationToTrust({
    delegator: 'root',
    delegatee: 'agent-bad',
    scope: ['file:read'],
    currentDepth: 0,
    maxDepth: 3,
    signature: '',
  });
  assert(unverified.trustLevel === 0, 'APS: empty signature → trust 0');
  assert(unverified.apsMetadata.verified === false, 'APS: empty sig → not verified');

  // 6. Custom baseTrust and depthDecay
  const customAps = new APSAdapter();
  await customAps.initialize({ baseTrust: 0.9, depthDecay: 0.6, verifySignature: async (d) => d.signature.length > 0 });
  const customResult = await customAps.apsDelegationToTrust({
    delegator: 'root',
    delegatee: 'custom-agent',
    scope: ['shell:exec'],
    currentDepth: 2,
    maxDepth: 4,
    signature: 'custom-sig',
  });
  assert(customResult.trustLevel === 0.63, `APS: custom config trust = 0.63, got ${customResult.trustLevel}`);
  assert(customResult.allowedResources.includes('SHELL_EXEC'), 'APS: shell:exec maps to SHELL_EXEC');

  // 7. BYOC signature verifier
  const byoc = new APSAdapter();
  await byoc.initialize({
    verifySignature: async (d) => d.signature === 'secret-token',
  });
  const verified = await byoc.apsDelegationToTrust({
    delegator: 'root',
    delegatee: 'byoc-agent',
    scope: ['net:fetch'],
    currentDepth: 0,
    maxDepth: 2,
    signature: 'secret-token',
  });
  assert(verified.apsMetadata.verified === true, 'APS: BYOC verifier accepts valid signature');
  const rejected = await byoc.apsDelegationToTrust({
    delegator: 'root',
    delegatee: 'byoc-agent',
    scope: ['net:fetch'],
    currentDepth: 0,
    maxDepth: 2,
    signature: 'wrong-token',
  });
  assert(rejected.trustLevel === 0, 'APS: BYOC verifier rejects invalid signature');

  // 8. Invalid input rejects
  let threw = false;
  try {
    await aps.apsDelegationToTrust({ delegator: '', delegatee: 'x', scope: ['file:read'], currentDepth: 0, maxDepth: 1, signature: 's' });
  } catch { threw = true; }
  assert(threw, 'APS: empty delegator throws');

  // 9. Depth exceeds max rejects
  threw = false;
  try {
    await aps.apsDelegationToTrust({ delegator: 'a', delegatee: 'b', scope: ['file:read'], currentDepth: 5, maxDepth: 3, signature: 's' });
  } catch { threw = true; }
  assert(threw, 'APS: depth > maxDepth throws');

  // 10. executeAgent pass-through
  const execResult = await aps.executeAgent('verify', {
    action: 'verify',
    params: {
      delegator: 'root',
      delegatee: 'exec-agent',
      scope: ['db:read'],
      currentDepth: 0,
      maxDepth: 2,
      signature: 'exec-sig',
    },
  }, { agentId: 'test' });
  assert(execResult.success === true, 'APS: executeAgent returns trust mapping');
  assert((execResult.data as Record<string, unknown>).agentId === 'exec-agent', 'APS: executeAgent maps correct agentId');

  // 11. Namespace derivation
  assert(root.allowedNamespaces.includes('file:'), 'APS: file: namespace derived');
  assert(root.allowedNamespaces.includes('git:'), 'APS: git: namespace derived');

  // 12. MCP mode requires URL
  threw = false;
  try {
    const mcpAps = new APSAdapter();
    await mcpAps.initialize({ verificationMode: 'mcp' });
  } catch { threw = true; }
  assert(threw, 'APS: MCP mode without URL throws');

  // 13. Capabilities
  assert(aps.capabilities.authentication === true, 'APS: capabilities.authentication is true');
}

// ============================================================================
// TEST 16: GeminiAdapter
// ============================================================================

async function testGeminiAdapter(): Promise<void> {
  section('GeminiAdapter — Google Gemini Developer API (BYOC)');

  const { GeminiAdapter } = await import('./adapters/gemini-adapter');
  const adapter = new GeminiAdapter();
  await adapter.initialize({});

  // --- Registration ---
  adapter.registerAgent('researcher', {
    model: 'gemini-2.5-flash',
    systemPrompt: 'You are a meticulous researcher.',
  });
  adapter.registerAgent('pro', {
    model: 'gemini-2.5-pro',
    maxOutputTokens: 1024,
    temperature: 0.3,
    thinkingBudget: 2048,
  });

  const agents = await adapter.listAgents();
  assert(agents.length === 2, 'Two Gemini agents registered');
  assert(agents.some((a) => a.id === 'researcher'), 'researcher agent registered');
  assert(agents.every((a) => a.capabilities?.includes('multi-modal') === true), 'Gemini agents declare multi-modal capability');

  // --- BYOC client path (SDK-style: text convenience accessor) ---
  let capturedConfig: Record<string, unknown> | undefined;
  const mockClient = {
    generateContent: async (params: {
      model: string;
      contents: Array<{ role?: string; parts: Array<{ text?: string }> }> | string;
      config?: Record<string, unknown>;
    }) => {
      capturedConfig = params.config;
      const text = Array.isArray(params.contents)
        ? params.contents[0].parts[0].text ?? ''
        : String(params.contents);
      return {
        text: `Gemini says: ${text}`,
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 24, totalTokenCount: 36 },
      };
    },
  };
  adapter.registerAgent('byoc', {
    model: 'gemini-2.5-flash',
    client: mockClient,
    systemPrompt: 'Be brief.',
    thinkingBudget: 512,
  });

  const ctx: AgentContext = { agentId: 'test', taskId: 't1' };
  const result = await adapter.executeAgent('byoc', {
    action: 'research',
    params: {},
    handoff: {
      handoffId: 'h1', sourceAgent: 'test', targetAgent: 'byoc',
      taskType: 'delegate' as const, instruction: 'Summarize the findings',
    },
  }, ctx);

  assert(result.success === true, 'BYOC Gemini agent executes successfully');
  const data = result.data as Record<string, unknown>;
  assert(typeof data.output === 'string' && (data.output as string).includes('Summarize the findings'), 'Output contains prompt content');
  assert(data.model === 'gemini-2.5-flash', 'Model name preserved in result');
  assert(capturedConfig?.['systemInstruction'] === 'Be brief.', 'System prompt forwarded as systemInstruction');
  assert(
    (capturedConfig?.['thinkingConfig'] as Record<string, unknown> | undefined)?.['thinkingBudget'] === 512,
    'Thinking budget forwarded in config'
  );
  const usage = (result.metadata?.trace as Record<string, unknown>)?.usage as Record<string, number>;
  assert(usage?.totalTokenCount === 36, 'Usage metadata returned in trace');

  // --- REST-shape response (candidates array, no text accessor) ---
  const restClient = {
    generateContent: async () => ({
      candidates: [{ content: { role: 'model' as const, parts: [{ text: 'part one. ' }, { text: 'part two.' }] } }],
    }),
  };
  adapter.registerAgent('rest', { client: restClient });
  const restResult = await adapter.executeAgent('rest', { action: 'go', params: {} }, ctx);
  assert(restResult.success === true, 'REST-shape response handled');
  assert(
    ((restResult.data as Record<string, unknown>).output as string) === 'part one. part two.',
    'Multi-part candidates concatenated'
  );

  // --- Error: unknown agent ---
  const errResult = await adapter.executeAgent('nope', { action: 'x', params: {} }, ctx);
  assert(errResult.success === false, 'Missing Gemini agent returns failure');
  assert(errResult.error?.code === 'AGENT_NOT_FOUND', 'Missing agent error code is AGENT_NOT_FOUND');

  // --- Error: no API key and no client ---
  adapter.registerAgent('keyless', { apiKey: '' });
  const saved = process.env['GEMINI_API_KEY'];
  delete process.env['GEMINI_API_KEY'];
  const keyless = await adapter.executeAgent('keyless', { action: 'x', params: {} }, ctx);
  if (saved !== undefined) process.env['GEMINI_API_KEY'] = saved;
  assert(keyless.success === false, 'No API key and no client fails');
  assert((keyless.error?.message ?? '').includes('GEMINI_API_KEY'), 'Error message mentions GEMINI_API_KEY');

  // --- Error: invalid registration ---
  let threw = false;
  try { adapter.registerAgent('', {}); } catch { threw = true; }
  assert(threw, 'Empty agentId throws on Gemini registration');

  // --- Shutdown ---
  await adapter.shutdown();
  assert(!(await adapter.isAgentAvailable('byoc')), 'Gemini agents cleared after shutdown');
}

// ============================================================================
// TEST 17: OpenAIResponsesAdapter
// ============================================================================

async function testOpenAIResponsesAdapter(): Promise<void> {
  section('OpenAIResponsesAdapter — OpenAI Responses API (BYOC)');

  const { OpenAIResponsesAdapter } = await import('./adapters/openai-responses-adapter');
  const adapter = new OpenAIResponsesAdapter();
  await adapter.initialize({});

  // --- Registration ---
  adapter.registerAgent('writer', { model: 'gpt-4.1', instructions: 'Be concise.' });
  adapter.registerAgent('reasoner', { model: 'o4-mini', reasoningEffort: 'high' });

  const agents = await adapter.listAgents();
  assert(agents.length === 2, 'Two Responses agents registered');
  assert(agents.some((a) => a.id === 'reasoner'), 'reasoner agent registered');

  // --- BYOC client path (SDK-style: output_text accessor) ---
  let capturedParams: Record<string, unknown> | undefined;
  const mockClient = {
    create: async (params: {
      model: string;
      input: string;
      instructions?: string;
      reasoning?: { effort?: string };
    }) => {
      capturedParams = params as unknown as Record<string, unknown>;
      return {
        output_text: `Response to: ${params.input}`,
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      };
    },
  };
  adapter.registerAgent('byoc', {
    model: 'gpt-5.2',
    client: mockClient,
    instructions: 'You are terse.',
    reasoningEffort: 'medium',
  });

  const ctx: AgentContext = { agentId: 'test', taskId: 't1' };
  const result = await adapter.executeAgent('byoc', {
    action: 'write',
    params: {},
    handoff: {
      handoffId: 'h1', sourceAgent: 'test', targetAgent: 'byoc',
      taskType: 'delegate' as const, instruction: 'Draft the summary',
    },
  }, ctx);

  assert(result.success === true, 'BYOC Responses agent executes successfully');
  const data = result.data as Record<string, unknown>;
  assert((data.output as string).includes('Draft the summary'), 'Output contains prompt content');
  assert(data.model === 'gpt-5.2', 'Model name preserved in result');
  assert(capturedParams?.['instructions'] === 'You are terse.', 'Instructions forwarded to the API');
  assert(
    (capturedParams?.['reasoning'] as Record<string, unknown> | undefined)?.['effort'] === 'medium',
    'Reasoning effort forwarded to the API'
  );
  const usage = (result.metadata?.trace as Record<string, unknown>)?.usage as Record<string, number>;
  assert(usage?.total_tokens === 30, 'Usage stats returned in trace');

  // --- REST-shape response (output items array, no output_text) ---
  const restClient = {
    create: async () => ({
      output: [
        { type: 'reasoning', content: [] },
        { type: 'message', content: [{ type: 'output_text', text: 'structured answer' }] },
      ],
    }),
  };
  adapter.registerAgent('rest', { client: restClient });
  const restResult = await adapter.executeAgent('rest', { action: 'go', params: {} }, ctx);
  assert(restResult.success === true, 'Output-items response handled');
  assert(
    ((restResult.data as Record<string, unknown>).output as string) === 'structured answer',
    'output_text extracted from message items'
  );

  // --- Error: unknown agent ---
  const errResult = await adapter.executeAgent('nope', { action: 'x', params: {} }, ctx);
  assert(errResult.success === false, 'Missing Responses agent returns failure');

  // --- Error: no API key and no client ---
  adapter.registerAgent('keyless', { apiKey: '' });
  const saved = process.env['OPENAI_API_KEY'];
  delete process.env['OPENAI_API_KEY'];
  const keyless = await adapter.executeAgent('keyless', { action: 'x', params: {} }, ctx);
  if (saved !== undefined) process.env['OPENAI_API_KEY'] = saved;
  assert(keyless.success === false, 'No API key and no client fails');
  assert((keyless.error?.message ?? '').includes('OPENAI_API_KEY'), 'Error message mentions OPENAI_API_KEY');

  // --- Error: invalid registration ---
  let threw = false;
  try { adapter.registerAgent('  ', {}); } catch { threw = true; }
  assert(threw, 'Blank agentId throws on Responses registration');

  // --- Shutdown ---
  await adapter.shutdown();
  assert(!(await adapter.isAgentAvailable('byoc')), 'Responses agents cleared after shutdown');
}

// ============================================================================
// TEST 18: ClaudeAgentSDKAdapter
// ============================================================================

async function testClaudeAgentSDKAdapter(): Promise<void> {
  section('ClaudeAgentSDKAdapter — Claude Agent SDK agentic loop (BYOC)');

  const { ClaudeAgentSDKAdapter } = await import('./adapters/claude-agent-sdk-adapter');
  const adapter = new ClaudeAgentSDKAdapter();
  await adapter.initialize({});

  // --- Registration requires a query function ---
  let threw = false;
  try {
    adapter.registerAgent('bad', {} as Parameters<typeof adapter.registerAgent>[1]);
  } catch { threw = true; }
  assert(threw, 'Registration without query function throws');

  threw = false;
  try {
    adapter.registerAgent('', { query: async function* () { /* empty */ } });
  } catch { threw = true; }
  assert(threw, 'Empty agentId throws on SDK registration');

  // --- Successful agentic loop ---
  const seen: string[] = [];
  let capturedOptions: Record<string, unknown> | undefined;
  adapter.registerAgent('coder', {
    query: async function* (params: { prompt: string; options?: Record<string, unknown> }) {
      capturedOptions = params.options;
      yield { type: 'system', subtype: 'init' };
      yield { type: 'assistant' };
      yield {
        type: 'result',
        subtype: 'success',
        result: `Done: ${params.prompt.split('\n')[0]}`,
        total_cost_usd: 0.042,
        num_turns: 3,
        session_id: 'sess-123',
        usage: { input_tokens: 100, output_tokens: 50 },
      };
    },
    options: { maxTurns: 10 },
    systemPrompt: 'You are a careful coder.',
    onMessage: (m) => seen.push(m.type),
  });

  const agents = await adapter.listAgents();
  assert(agents.length === 1 && agents[0]?.id === 'coder', 'SDK agent registered');
  assert(agents.every((a) => a.capabilities?.includes('agentic-loop') === true), 'SDK agent declares agentic-loop capability');

  const ctx: AgentContext = { agentId: 'test', taskId: 't1' };
  const result = await adapter.executeAgent('coder', {
    action: 'refactor',
    params: {},
    handoff: {
      handoffId: 'h1', sourceAgent: 'test', targetAgent: 'coder',
      taskType: 'delegate' as const, instruction: 'Refactor the parser',
    },
  }, ctx);

  assert(result.success === true, 'SDK agent executes successfully');
  const data = result.data as Record<string, unknown>;
  assert((data.output as string).includes('Refactor the parser'), 'Result text extracted from result message');
  assert(data.sessionId === 'sess-123', 'Session id surfaced');
  assert(data.numTurns === 3, 'Turn count surfaced');
  assert(data.costUsd === 0.042, 'Cost surfaced');
  assert(seen.length === 2 && seen[0] === 'system', 'Intermediate messages passed to onMessage');
  assert(capturedOptions?.['maxTurns'] === 10, 'Options forwarded to query');
  assert(capturedOptions?.['systemPrompt'] === 'You are a careful coder.', 'systemPrompt forwarded via options');

  // --- Error result message ---
  adapter.registerAgent('failer', {
    query: async function* () {
      yield { type: 'result', subtype: 'error_max_turns', result: 'ran out of turns', is_error: true };
    },
  });
  const failResult = await adapter.executeAgent('failer', { action: 'x', params: {} }, ctx);
  assert(failResult.success === false, 'Error result message fails the execution');
  assert((failResult.error?.message ?? '').includes('error_max_turns'), 'Error subtype surfaced in message');

  // --- Loop ends without result ---
  adapter.registerAgent('empty', {
    query: async function* () {
      yield { type: 'assistant' };
    },
  });
  const emptyResult = await adapter.executeAgent('empty', { action: 'x', params: {} }, ctx);
  assert(emptyResult.success === false, 'Loop without result message fails');
  assert(emptyResult.error?.code === 'NO_RESULT', 'NO_RESULT error code returned');

  // --- Query function throws ---
  adapter.registerAgent('thrower', {
    query: async function* () {
      yield { type: 'assistant' };
      throw new Error('SDK exploded');
    },
  });
  const throwResult = await adapter.executeAgent('thrower', { action: 'x', params: {} }, ctx);
  assert(throwResult.success === false, 'Throwing query is caught');
  assert((throwResult.error?.message ?? '').includes('SDK exploded'), 'Original error message preserved');

  // --- Unknown agent ---
  const missing = await adapter.executeAgent('ghost', { action: 'x', params: {} }, ctx);
  assert(missing.success === false && missing.error?.code === 'AGENT_NOT_FOUND', 'Missing SDK agent returns AGENT_NOT_FOUND');

  // --- Shutdown ---
  await adapter.shutdown();
  assert(!(await adapter.isAgentAvailable('coder')), 'SDK agents cleared after shutdown');
}

// ============================================================================
// TEST 19: All Adapters in Registry Together
// ============================================================================

async function testAllAdaptersInRegistry(): Promise<void> {
  section('Full Registry — All Adapters Working Together');

  const registry = new AdapterRegistry();

  // Import all adapters
  const { LlamaIndexAdapter } = await import('./adapters/llamaindex-adapter');
  const { SemanticKernelAdapter } = await import('./adapters/semantic-kernel-adapter');
  const { OpenAIAssistantsAdapter } = await import('./adapters/openai-assistants-adapter');
  const { HaystackAdapter } = await import('./adapters/haystack-adapter');
  const { DSPyAdapter } = await import('./adapters/dspy-adapter');
  const { AgnoAdapter } = await import('./adapters/agno-adapter');
  const { NemoClawAdapter } = await import('./adapters/nemoclaw-adapter');

  // Set up all new adapters with mock agents
  const llamaindex = new LlamaIndexAdapter();
  llamaindex.registerQueryEngine('search', {
    query: async (q: string) => ({ response: `LlamaIndex: ${q}` }),
  });

  const sk = new SemanticKernelAdapter();
  sk.registerFunction('summarize', {
    name: 'summarize',
    invoke: async (args?: Record<string, unknown>) => ({ value: `SK: ${(args as Record<string, unknown>)?.input}` }),
  });

  const openai = new OpenAIAssistantsAdapter();
  const mockOAClient = {
    chat: async (_id: string, msg: string) => ({ response: `OpenAI: ${msg}` }),
  };
  await openai.initialize({ options: { client: mockOAClient } });
  openai.registerAssistant('gpt', { assistantId: 'asst_test' });

  const haystack = new HaystackAdapter();
  haystack.registerAgent('qa', {
    run: async (q: string) => ({ answer: `Haystack: ${q}` }),
  });

  const dspy = new DSPyAdapter();
  dspy.registerPredictor('predict', async (inputs) => ({
    answer: `DSPy: ${inputs.question}`,
  }));

  const agno = new AgnoAdapter();
  agno.registerFunction('helper', async (msg) => `Agno: ${msg}`);

  // Also add a custom adapter
  const custom = new CustomAdapter();
  custom.registerHandler('echo', async (payload) => ({ echo: payload.params }));

  // NemoClaw adapter with mock executor
  const nemoclaw = new NemoClawAdapter();
  const mockExec = async (subcommand: string, args: string[]) => {
    if (subcommand === 'sandbox' && args[0] === 'get') return JSON.stringify({ state: 'running' });
    if (subcommand === 'sandbox' && args[0] === 'create') return 'created';
    if (subcommand === 'sandbox' && args[0] === 'connect') return JSON.stringify({ result: 'nemoclaw done' });
    if (subcommand === 'policy') return 'ok';
    return '';
  };
  await nemoclaw.initialize({ options: { executor: mockExec } });
  nemoclaw.registerSandboxAgent('sandbox-worker', { sandboxName: 'test-sandbox' });

  // Register all
  await registry.addAdapter(llamaindex);
  await registry.addAdapter(sk);
  await registry.addAdapter(openai);
  await registry.addAdapter(haystack);
  await registry.addAdapter(dspy);
  await registry.addAdapter(agno);
  await registry.addAdapter(custom);
  await registry.addAdapter(nemoclaw);

  const allAdapters = registry.listAdapters();
  assert(allAdapters.length === 8, `8 adapters registered in registry (got ${allAdapters.length})`);

  const ctx: AgentContext = { agentId: 'test', taskId: 't1' };

  // Execute through each adapter via registry
  const r1 = await registry.executeAgent('llamaindex:search', {
    action: 'query', params: {}, handoff: { handoffId: 'h1', sourceAgent: 'test', targetAgent: 'agent', taskType: 'delegate' as const, instruction: 'test query' },
  }, ctx);
  assert(r1.success === true, 'LlamaIndex works through registry');

  const r2 = await registry.executeAgent('semantic-kernel:summarize', {
    action: 'summarize', params: {}, handoff: { handoffId: 'h1', sourceAgent: 'test', targetAgent: 'agent', taskType: 'delegate' as const, instruction: 'text to summarize' },
  }, ctx);
  assert(r2.success === true, 'Semantic Kernel works through registry');

  const r3 = await registry.executeAgent('openai-assistants:gpt', {
    action: 'chat', params: {}, handoff: { handoffId: 'h1', sourceAgent: 'test', targetAgent: 'agent', taskType: 'delegate' as const, instruction: 'Hello GPT' },
  }, ctx);
  assert(r3.success === true, 'OpenAI Assistants works through registry');

  const r4 = await registry.executeAgent('haystack:qa', {
    action: 'ask', params: { query: 'test' },
  }, ctx);
  assert(r4.success === true, 'Haystack works through registry');

  const r5 = await registry.executeAgent('dspy:predict', {
    action: 'predict', params: {}, handoff: { handoffId: 'h1', sourceAgent: 'test', targetAgent: 'agent', taskType: 'delegate' as const, instruction: 'test prediction' },
  }, ctx);
  assert(r5.success === true, 'DSPy works through registry');

  const r6 = await registry.executeAgent('agno:helper', {
    action: 'help', params: {}, handoff: { handoffId: 'h1', sourceAgent: 'test', targetAgent: 'agent', taskType: 'delegate' as const, instruction: 'help me' },
  }, ctx);
  assert(r6.success === true, 'Agno works through registry');

  const r7 = await registry.executeAgent('custom:echo', {
    action: 'echo', params: { msg: 'hello' },
  }, ctx);
  assert(r7.success === true, 'Custom still works through registry');

  const r8 = await registry.executeAgent('nemoclaw:sandbox-worker', {
    action: 'run', params: { task: 'test' },
  }, ctx);
  assert(r8.success === true, 'NemoClaw works through registry');

  // Health check all
  const health = await registry.healthCheck();
  assert(Object.keys(health).length === 8, 'Health check covers all 8 adapters');
  assert(Object.values(health).every((h: Record<string, unknown>) => h.healthy), 'All adapters report healthy');

  await registry.shutdownAll();
}

// ============================================================================
// RUN ALL TESTS
// ============================================================================

async function runAllTests(): Promise<void> {
  console.log(`\n${colors.bold}╔══════════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bold}║     Adapter System Test Suite — Plug & Play Agents   ║${colors.reset}`);
  console.log(`${colors.bold}╚══════════════════════════════════════════════════════╝${colors.reset}`);

  try {
    await testCustomAdapter();
    await testLangChainAdapter();
    await testAutoGenAdapter();
    await testCrewAIAdapter();
    await testMCPAdapter();
    await testAdapterRegistry();
    await testWritingCustomAdapter();
    await testEdgeCases();
    await testOrchestratorAdapter();

    // Extended adapter test suites
    await testLlamaIndexAdapter();
    await testSemanticKernelAdapter();
    await testOpenAIAssistantsAdapter();
    await testHaystackAdapter();
    await testDSPyAdapter();
    await testAgnoAdapter();
    await testHermesAdapter();
    await testAPSAdapter();
    await testGeminiAdapter();
    await testOpenAIResponsesAdapter();
    await testClaudeAgentSDKAdapter();
    await testAllAdaptersInRegistry();
  } catch (error) {
    console.log(`\n${colors.red}FATAL: Unexpected error: ${error}${colors.reset}`);
    if (error instanceof Error) console.log(error.stack);
    failed++;
  }

  // Summary
  const total = passed + failed;
  console.log(`\n${colors.bold}═══════════════════════════════════════════════════════${colors.reset}`);
  if (failed === 0) {
    console.log(`${colors.green}${colors.bold}  ALL ${total} TESTS PASSED ✓${colors.reset}`);
  } else {
    console.log(`${colors.red}${colors.bold}  ${failed} of ${total} TESTS FAILED${colors.reset}`);
  }
  console.log(`${colors.bold}═══════════════════════════════════════════════════════${colors.reset}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

runAllTests();
