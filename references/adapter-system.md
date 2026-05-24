# Adapter System — 29 Plug-and-Play Agent Framework Adapters

## Overview

The SwarmOrchestrator uses an **adapter pattern** to work with any agent framework. Instead of being locked to one system, you bring your own agents — from any framework — and the orchestrator handles coordination, shared state, permissions, and parallel execution. As of v5.8.3, 29 adapters are included.

```
┌─────────────────────────────────────────────────────────────┐
│                   SwarmOrchestrator                          │
│                                                             │
│   ┌──────────┐  ┌────────────┐  ┌──────────────────────┐   │
│   │Blackboard│  │AuthGuardian│  │ TaskDecomposer       │   │
│   │(shared   │  │(permission │  │ (parallel execution) │   │
│   │ state)   │  │  wall)     │  │                      │   │
│   └────┬─────┘  └──────┬─────┘  └──────────┬───────────┘   │
│        │               │                   │               │
│   ┌────▼───────────────▼───────────────────▼────────────┐   │
│   │              Adapter Registry                       │   │
│   │    (routes agent requests to the right adapter)     │   │
│   └──┬──────┬──────┬──────┬──────┬──────┬───────────────┘   │
└──────┼──────┼──────┼──────┼──────┼──────┼───────────────────┘
       │      │      │      │      │      │
  ┌────▼──┐┌──▼───┐┌─▼────┐┌▼────┐┌▼───┐┌─▼─────┐
  │OpenClaw││Lang- ││Auto- ││Crew ││MCP ││Custom │
  │Adapter ││Chain ││Gen   ││AI   ││    ││       │
  └────────┘└──────┘└──────┘└─────┘└────┘└───────┘
```

## Quick Start

### 1. Simplest: Custom Function as Agent

```typescript
import { SwarmOrchestrator, CustomAdapter } from './index';

const orchestrator = new SwarmOrchestrator();
const custom = new CustomAdapter();

// Any async function becomes an agent
custom.registerHandler("analyzer", async (payload, context) => {
  const instruction = payload.handoff?.instruction ?? "";
  return { analysis: `Processed: ${instruction}`, confidence: 0.95 };
});

custom.registerHandler("summarizer", async (payload) => {
  return { summary: "Executive summary of the data..." };
});

await orchestrator.addAdapter(custom);

// Use it
const result = await orchestrator.execute("delegate_task", {
  targetAgent: "analyzer",
  taskPayload: { instruction: "Analyze Q4 revenue trends" },
}, { agentId: "orchestrator" });
```

### 2. LangChain Agents

```typescript
import { SwarmOrchestrator, LangChainAdapter } from './index';
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

const orchestrator = new SwarmOrchestrator();
const lc = new LangChainAdapter();

// Register a LangChain ReAct agent
const agent = createReactAgent({ llm: new ChatOpenAI(), tools: [...] });
lc.registerAgent("research", agent, {
  description: "Research agent with web search tools",
});

// Register a simple chain
lc.registerAgent("format", async (input) => {
  const chain = prompt.pipe(llm).pipe(outputParser);
  return chain.invoke(input);
});

await orchestrator.addAdapter(lc);

// Delegate to it (prefix "lc:" is optional — routing resolves automatically)
await orchestrator.execute("delegate_task", {
  targetAgent: "lc:research",
  taskPayload: { instruction: "Research market trends for Q1 2026" },
}, { agentId: "orchestrator" });
```

### 3. AutoGen Agents

```typescript
import { SwarmOrchestrator, AutoGenAdapter } from './index';

const orchestrator = new SwarmOrchestrator();
const ag = new AutoGenAdapter();

ag.registerAgent("coder", {
  name: "CodeWriter",
  run: async (task, context) => {
    // Your AutoGen agent logic
    return { code: "print('hello')", language: "python" };
  },
});

await orchestrator.addAdapter(ag);

await orchestrator.execute("delegate_task", {
  targetAgent: "autogen:coder",
  taskPayload: { instruction: "Write a Python script to parse CSV data" },
}, { agentId: "orchestrator" });
```

### 4. CrewAI Crews

```typescript
import { SwarmOrchestrator, CrewAIAdapter } from './index';

const orchestrator = new SwarmOrchestrator();
const crew = new CrewAIAdapter();

crew.registerCrew("analysis_crew", {
  agents: [
    { role: "Researcher", goal: "Find relevant data" },
    { role: "Analyst", goal: "Analyze the data" },
    { role: "Writer", goal: "Write the report" },
  ],
  kickoff: async (inputs) => {
    // Your CrewAI crew execution
    return { report: "Final analysis report..." };
  },
});

await orchestrator.addAdapter(crew);

// Spawn the whole crew as a parallel task
await orchestrator.execute("spawn_parallel_agents", {
  tasks: [{ agentType: "crewai:analysis_crew", taskPayload: { instruction: "Analyze Q4" } }],
}, { agentId: "orchestrator" });
```

### 5. MCP Tools

```typescript
import { SwarmOrchestrator, MCPAdapter } from './index';

const orchestrator = new SwarmOrchestrator();
const mcp = new MCPAdapter();

// Register local MCP tool handlers
mcp.registerTool("search", async (args) => ({
  content: [{ type: "text", text: JSON.stringify({ results: ["..."] }) }],
}), { description: "Search the knowledge base" });

// Or connect to a remote MCP server
const mcp2 = new MCPAdapter();
await orchestrator.addAdapter(mcp2, {
  options: { serverConnection: myMCPClient },
});

await orchestrator.addAdapter(mcp);
```

### 6. HTTP/REST Agents

```typescript
import { SwarmOrchestrator, CustomAdapter } from './index';

const orchestrator = new SwarmOrchestrator();
const custom = new CustomAdapter();

// Any HTTP endpoint becomes an agent
custom.registerHttpAgent("external-api", "https://api.example.com/agent", {
  description: "External analysis service",
});

custom.registerHttpAgent("internal-ml", {
  url: "http://localhost:8080/predict",
  headers: { "Authorization": "Bearer ..." },
  timeout: 10000,
  transformRequest: (payload) => ({
    text: payload.handoff?.instruction,
    model: "analysis-v2",
  }),
  transformResponse: (res) => (res as any).prediction,
});

await orchestrator.addAdapter(custom);
```

### 7. OpenClaw (Original — Still Works)

```typescript
import { SwarmOrchestrator, OpenClawAdapter } from './index';

const orchestrator = new SwarmOrchestrator();
const oc = new OpenClawAdapter();

await orchestrator.addAdapter(oc, {
  options: { callSkill: openclawCore.callSkill },
});

// Everything works exactly as before
await orchestrator.execute("delegate_task", {
  targetAgent: "data_analyst",
  taskPayload: { instruction: "Analyze the dataset" },
}, { agentId: "orchestrator" });
```

## Mixing Multiple Frameworks

The real power: use agents from different frameworks together.

```typescript
const orchestrator = new SwarmOrchestrator();

// Register multiple adapters
await orchestrator.addAdapter(new LangChainAdapter());
await orchestrator.addAdapter(new AutoGenAdapter());
await orchestrator.addAdapter(new CustomAdapter());

// Route rules (optional — prefix convention "adapter:agent" works by default)
orchestrator.adapters.addRoute({ pattern: "research*", adapterName: "langchain" });
orchestrator.adapters.addRoute({ pattern: "code*", adapterName: "autogen" });
orchestrator.adapters.setDefaultAdapter("custom");

// Now delegate to agents from any framework — the registry routes automatically
await orchestrator.execute("spawn_parallel_agents", {
  tasks: [
    { agentType: "lc:research",    taskPayload: { instruction: "Research market data" } },
    { agentType: "autogen:coder",  taskPayload: { instruction: "Build analysis script" } },
    { agentType: "custom:reviewer", taskPayload: { instruction: "Review the results" } },
  ],
  synthesisStrategy: "merge",
}, { agentId: "orchestrator" });
```

## Writing Your Own Adapter

Implement the `IAgentAdapter` interface, or extend `BaseAdapter` for convenience:

```typescript
import { BaseAdapter } from './adapters/base-adapter';
import type { AgentPayload, AgentContext, AgentResult } from './types/agent-adapter';

class MyFrameworkAdapter extends BaseAdapter {
  readonly name = 'my-framework';
  readonly version = '1.0.0';

  async executeAgent(
    agentId: string,
    payload: AgentPayload,
    context: AgentContext
  ): Promise<AgentResult> {
    // 1. Translate payload into your framework's format
    // 2. Call your framework
    // 3. Normalize the result back into AgentResult

    const result = await myFramework.runAgent(agentId, payload.handoff?.instruction);

    return this.successResult(result);
  }
}
```

That's it. Three methods to implement (the base class handles the rest):
- `executeAgent()` — run an agent (REQUIRED)
- `initialize()` — set up connections (optional, has default)
- `shutdown()` — clean up (optional, has default)

## Routing

The adapter registry resolves which adapter handles each agent using this priority:

1. **Cache** — previously resolved agents are remembered
2. **Routes** — explicit routing rules you define
3. **Prefix convention** — `"lc:research"` → `langchain` adapter, `"autogen:coder"` → `autogen` adapter
4. **Default adapter** — catch-all if set
5. **Solo adapter** — if only one adapter is registered, it handles everything

## Agent Discovery

```typescript
// See all agents across all frameworks
const agents = await orchestrator.adapters.discoverAgents();
// → [{ id: "research", adapter: "langchain" }, { id: "coder", adapter: "autogen" }, ...]

// Check specific agent
const available = await orchestrator.adapters.isAgentAvailable("lc:research");

// Health check all adapters
const health = await orchestrator.adapters.healthCheck();
// → { langchain: { healthy: true }, autogen: { healthy: true }, ... }
```

## Events

```typescript
orchestrator.adapters.on('agent:execution:start', (event) => {
  console.log(`[${event.adapter}] Starting execution...`);
});

orchestrator.adapters.on('agent:execution:complete', (event) => {
  console.log(`[${event.adapter}] Done in ${event.data.result.metadata.executionTimeMs}ms`);
});

orchestrator.adapters.on('adapter:error', (event) => {
  console.error(`[${event.adapter}] Error:`, event.data);
});
```

## APS Adapter — Delegation-Chain Trust Bridge

The `APSAdapter` maps APS (Agent Permission Service) delegation chains to AuthGuardian trust levels. This is the interop PoC for cross-framework permission delegation proposed in [crewAIInc/crewAI#4560](https://github.com/crewAIInc/crewAI/issues/4560).

```typescript
import { APSAdapter } from 'network-ai';

const aps = new APSAdapter();
await aps.initialize({});

const trust = await aps.apsDelegationToTrust({
  delegator:    'root-orchestrator',
  delegatee:    'sub-agent-7',
  scope:        ['file:read', 'net:fetch'],
  currentDepth: 1,
  maxDepth:     3,
  signature:    '<base64-token>',
});

// trust.agentId       → 'sub-agent-7'
// trust.trustLevel    → 0.693 (depth-decayed from 0.8 base)
// trust.allowedResources → ['FILE_SYSTEM', 'NETWORK']
// trust.allowedNamespaces → ['file:', 'net:']
```

**Trust formula:** `baseTrust × (1 - (currentDepth / maxDepth × depthDecay))`

Defaults: `baseTrust = 0.8`, `depthDecay = 0.4`. Configurable via `initialize({ baseTrust, depthDecay })`.

**Verification modes:**

| Mode | Description |
|------|-------------|
| `local` (default) | Verifies signature is non-empty |
| `mcp` | Verifies via an external MCP server (`mcpServerUrl` required) |
| BYOC | Pass a custom `verifySignature` function at initialize |

## All Existing Features Still Work

The adapter system is additive — everything from v1/v2 is preserved:

- **Blackboard** (shared state) — unchanged
- **AuthGuardian** (permission wall) — unchanged  
- **Security module** (encryption, tokens, rate limiting) — unchanged
- **Python scripts** (blackboard.py, swarm_guard.py, etc.) — unchanged
- **Budget tracking** — unchanged
- **Handoff protocol** — unchanged
- **OpenClaw skill interface** — `SwarmOrchestrator` still implements `OpenClawSkill`

## Deferred Adapter Initialization (v4.12.0)

Register adapters lazily so they are only created and initialized on first use:

```typescript
import { AdapterRegistry, LangChainAdapter } from 'network-ai';

const registry = new AdapterRegistry();

// Factory is NOT called until the adapter is actually needed
registry.registerDeferred('langchain', () => new LangChainAdapter(), {
  autoInit: true,              // call initialize() after construction (default true)
  initOptions: { model: 'gpt-4o' },
});

// Shows up in listings with deferred: true
const list = registry.listAdapters();
// → [{ name: 'langchain', deferred: true }]

// First executeAgent or resolveAdapterAsync triggers materialization
const adapter = await registry.resolveAdapterAsync('langchain');
// Factory runs → initialize() called → adapter cached for reuse

// executeAgent auto-resolves deferred adapters transparently
const result = await registry.executeAgent('lc:research', payload, context);
```

- `registerDeferred(name, factory, config?)` — register a lazy factory
- `resolveAdapterAsync(name)` — explicitly materialize a deferred adapter
- `executeAgent()` — auto-materializes deferred adapters on demand
- Emits `adapter:deferred` event when a deferred adapter is first materialized

## Adapter Hook Middleware (v4.12.0)

Wrap any adapter's `executeAgent` with lifecycle hooks:

```typescript
import { AdapterHookManager } from 'network-ai';

const hooks = new AdapterHookManager();

// beforeExecute — inspect or mutate payload, or abort
hooks.beforeExecute(async (ctx) => {
  console.log(`Executing ${ctx.agentId} on ${ctx.adapterName}`);
  // Mutate payload:  ctx.payload.handoff.instruction = 'modified';
  // Abort execution: return { abort: true, reason: 'blocked' };
}, { priority: 10 });

// afterExecute — inspect or mutate result
hooks.afterExecute(async (ctx) => {
  ctx.result.metadata.hookedAt = Date.now();
}, { priority: 10 });

// onError — handle or rethrow errors
hooks.onError(async (ctx) => {
  console.error(`Error in ${ctx.agentId}:`, ctx.error);
  // Optionally return a fallback result
});

// Wrap an adapter
const wrappedExecute = hooks.wrap(adapter);
const result = await wrappedExecute('research', payload, context);
```

Hooks run in priority order (lower = first). Multiple hooks per phase are supported. `beforeExecute` hooks can abort by returning `{ abort: true, reason }`.

## Flow Control on LockedBlackboard (v4.12.0)

Pause, resume, and throttle write operations on the blackboard:

```typescript
import { LockedBlackboard } from 'network-ai';

const bb = new LockedBlackboard({ throttleMs: 200 });

// Pause — blocks propose() and commit() while paused; read() still works
bb.pause();
bb.isPaused();  // true
bb.resume();

// Throttle — enforces minimum ms between mutating operations
bb.setThrottle(500);  // 500ms between writes
bb.getThrottle();     // 500

// Constructor option
const bb2 = new LockedBlackboard({ throttleMs: 100, conflictResolution: 'last-write-wins' });
```

## Matcher-Based Hook Filtering (v4.13.0)

Target hooks to specific agents, actions, or tools using glob patterns:

```typescript
import { AdapterHookManager, HookMatcher, matchGlob } from 'network-ai';

const hooks = new AdapterHookManager();

// Matcher: only fire for agents matching 'security-*' using tool 'file_*'
const matcher: HookMatcher = {
  agentPattern: 'security-*',
  toolPattern: 'file_*',
};

hooks.beforeExecute(async (ctx) => {
  console.log(`Security hook for ${ctx.agentId}`);
}, { priority: 5, matcher });

// Custom condition function for dynamic filtering
const dynamicMatcher: HookMatcher = {
  condition: (ctx) => ctx.payload?.handoff?.risk === 'high',
};

hooks.beforeExecute(async (ctx) => {
  return { abort: true, reason: 'High-risk operations require approval' };
}, { priority: 1, matcher: dynamicMatcher });
```

- `agentPattern` — glob matched against `ctx.agentId`
- `actionPattern` — glob matched against `ctx.action`
- `toolPattern` — glob matched against `ctx.tool`
- `condition` — arbitrary predicate `(ctx) => boolean`
- All specified fields use AND logic; hook fires only when all match
- `matchGlob(pattern, value)` and `matchToolPattern(pattern, tool)` are exported utilities

## Phase Pipeline (v4.13.0)

Orchestrate multi-phase workflows with approval gates:

```typescript
import { PhasePipeline, PhaseDefinition } from 'network-ai';

const phases: PhaseDefinition[] = [
  {
    name: 'research',
    agents: ['researcher-1', 'researcher-2'],
    parallel: true,
  },
  {
    name: 'review',
    agents: ['reviewer'],
    requiresApproval: true,  // halts until approved
  },
  {
    name: 'deploy',
    agents: ['deployer'],
    payloadFactory: (prev) => ({ ...prev, approved: true }),
  },
];

const pipeline = new PhasePipeline(phases, executeFn, {
  autoApprove: false,
  approvalCallback: async (phase) => {
    // Human-in-the-loop: return true to proceed, false to reject
    return await askHuman(`Approve phase "${phase.name}"?`);
  },
  onPhaseStart: (name) => console.log(`Starting: ${name}`),
  onPhaseComplete: (name, result) => console.log(`Done: ${name}`),
});

const result = await pipeline.run(initialPayload);
// result.phases — per-phase results
// result.status — 'completed' | 'rejected' | 'error'
```

## Confidence Filter (v4.13.0)

Score, filter, and aggregate multi-agent results:

```typescript
import { ConfidenceFilter, Finding } from 'network-ai';

const filter = new ConfidenceFilter({ threshold: 0.7 });

// Score individual findings
const findings: Finding[] = [
  { id: 'f1', source: 'agent-a', content: 'SQL injection found', confidence: 0.92 },
  { id: 'f2', source: 'agent-b', content: 'Minor style issue', confidence: 0.45 },
];

const result = filter.filter(findings);
// result.accepted  — [f1] (above threshold)
// result.rejected  — [f2] (below threshold)

// Validate rejected findings with a secondary agent
const validated = await filter.validateRejected(result, async (finding) => {
  return { ...finding, confidence: 0.8 };  // secondary agent re-scores
});

// Aggregate across multiple agents
const aggregated = filter.aggregate(findings, 'majority');
// Strategies: 'highest', 'average', 'unanimous', 'majority'
```

## Fan-Out / Fan-In (v4.13.0)

Spawn parallel agents with concurrency control and pluggable aggregation:

```typescript
import { FanOutFanIn, FanOutStep } from 'network-ai';

const fan = new FanOutFanIn(executeFn);

const steps: FanOutStep[] = [
  { agentId: 'researcher-1', payload: { query: 'topic A' }, tag: 'r1' },
  { agentId: 'researcher-2', payload: { query: 'topic B' }, tag: 'r2' },
  { agentId: 'researcher-3', payload: { query: 'topic C' }, tag: 'r3' },
];

// Fan-out with concurrency limit
const results = await fan.fanOut(steps, { concurrency: 2, continueOnError: true });
// results — TaggedResult[] with { tag, result, success, error? }

// Fan-in with strategy
const merged = fan.fanIn(results, 'merge');
// Strategies: 'merge', 'firstSuccess', 'vote', 'consensus'

// Or use run() for convenience (fan-out + fan-in in one call)
const final = await fan.run(steps, 'vote', { concurrency: 2 });

// Custom reducer
const custom = fan.fanIn(results, 'custom', (tagged) => {
  return { combined: tagged.map(t => t.result) };
});
```

## Agent Runtime Sandbox (v4.14.0)

Sandboxed execution environment that wraps adapter calls with policy enforcement and approval gates:

```typescript
import { AgentRuntime } from 'network-ai';

const runtime = new AgentRuntime({
  policy: {
    basePath: '/workspace',
    allowedCommands: ['npm *', 'node *', 'git status'],
    allowedPaths: ['.', 'src'],
    autoApproveReads: true,
  },
  autoApproveAll: false,
  onApproval: async (req) => {
    // Custom approval logic
    return { approved: req.risk !== 'high', approvedBy: 'policy-engine' };
  },
});

// Sandboxed shell execution
const result = await runtime.exec('npm test', 'agent-1');
// result: { stdout, stderr, exitCode, durationMs, timedOut }

// Scoped file access with traversal protection
const file = await runtime.readFile('src/index.ts', 'agent-1');
const written = await runtime.writeFile('output.json', data, 'agent-1');

// Full audit trail
const log = runtime.getAuditLog();
```

## Strategy Agent (v4.14.0)

Meta-orchestrator for coordinating large-scale agent swarms (1K–1M agents):

```typescript
import { StrategyAgent, AgentPool, WorkloadPartitioner } from 'network-ai';

// Create pools with capacity limits
const pool = new AgentPool('research', { capacity: 100, adapter: 'langchain' });

// Partition workload across pools
const partitioner = new WorkloadPartitioner();
partitioner.addRoute({ priority: 'high', pool: 'research', weight: 3 });
partitioner.addRoute({ priority: 'low', pool: 'general', weight: 1 });

// Strategy agent with adaptive scaling
const strategy = new StrategyAgent({
  pools: [pool],
  partitioner,
  budget: federatedBudget,
  adapters: adapterRegistry,
  scalingPolicy: {
    scaleUpThreshold: 0.8,   // scale up when pool is 80% utilized
    scaleDownThreshold: 0.2, // scale down when under 20%
    cooldownMs: 30_000,
  },
});

// Submit work — strategy routes to best pool
const result = await strategy.submit({
  taskId: 'research-001',
  priority: 'high',
  input: 'Analyze quarterly reports',
});
```

## v5.0 Adapters

Nine new adapters were added in v5.0, bringing the total to 27.

### CopilotAdapter

```typescript
import { CopilotAdapter } from 'network-ai';

const copilot = new CopilotAdapter({ client: yourCopilotClient });
await orchestrator.addAdapter(copilot);

const result = await copilot.executeAgent('code-reviewer', {
  action: 'review',
  code: 'function add(a, b) { return a + b; }',
});
```

Supported actions: `generate`, `review`, `explain`, `fix`, `test`, `refactor`, `chat`.

### LangGraphAdapter

```typescript
import { LangGraphAdapter } from 'network-ai';

const lg = new LangGraphAdapter({ client: compiledStateGraph });
await orchestrator.addAdapter(lg);

const result = await lg.executeAgent('workflow', {
  input: { messages: [{ role: 'user', content: 'Plan a trip' }] },
});
```

### AnthropicComputerUseAdapter

```typescript
import { AnthropicComputerUseAdapter } from 'network-ai';

const acu = new AnthropicComputerUseAdapter({ client: anthropicClient });
const result = await acu.executeAgent('browser-bot', {
  action: 'screenshot',  // or 'click', 'type', 'scroll'
  coordinate: [400, 300],
});
```

### OpenAIAgentsAdapter

```typescript
import { OpenAIAgentsAdapter } from 'network-ai';

const agents = new OpenAIAgentsAdapter({ client: openaiClient });
const result = await agents.executeAgent('assistant', {
  instructions: 'Summarize the document',
  input: docText,
});
```

### VertexAIAdapter

```typescript
import { VertexAIAdapter } from 'network-ai';

const vertex = new VertexAIAdapter({ client: vertexClient });
const result = await vertex.executeAgent('gemini', {
  prompt: 'Describe this image',
  images: [imageBuffer],  // multi-modal
});
```

### PydanticAIAdapter

```typescript
import { PydanticAIAdapter } from 'network-ai';

const pydantic = new PydanticAIAdapter({ client: pydanticAgent });
const result = await pydantic.executeAgent('structured-bot', {
  prompt: 'Extract contact info',
  resultType: 'ContactInfo',  // validated output
});
```

### BrowserAgentAdapter

```typescript
import { BrowserAgentAdapter } from 'network-ai';

const browser = new BrowserAgentAdapter({
  client: playwrightPage,  // or Puppeteer page, or CDP session
});
const result = await browser.executeAgent('scraper', {
  action: 'navigate',
  url: 'https://example.com',
});
```

### RLMAdapter (v5.1.4)

Connects to any RLM-compatible HTTP endpoint (see [arxiv 2512.24601](https://arxiv.org/abs/2512.24601) / alexzhang13/rlm). BYOC — bring your own HTTP client.

```typescript
import { RLMAdapter } from 'network-ai';

const rlm = new RLMAdapter();
rlm.registerAgent('rlm-planner', {
  endpoint: 'http://localhost:8080',
  model: 'rlm-7b',
  maxDepth: 3,
  systemPrompt: 'You are a planning agent.',
  // client: myHttpClient,  // optional BYOC HTTP client
});
await rlm.initialize({});

const result = await rlm.executeAgent(
  'rlm-planner',
  { action: 'run', params: { input: 'Plan a deployment pipeline' } },
  { agentId: 'orchestrator' },
);
// result.data → text / content from the RLM server
// result.metadata.executionTimeMs → wall-clock latency
```

Capabilities: `streaming: false`, `parallel: true`.

### Streaming Variants (v5.0)

`LangChainStreamingAdapter` and `CustomStreamingAdapter` extend their base adapters with `executeAgentStream()` that yields partial results via `AsyncIterable`. Both extend `StreamingBaseAdapter`.
