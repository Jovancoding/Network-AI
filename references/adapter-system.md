# Adapter System — Plug-and-Play Agent Framework Support

## Overview

The SwarmOrchestrator uses an **adapter pattern** to work with any agent framework. Instead of being locked to one system, you bring your own agents — from any framework — and the orchestrator handles coordination, shared state, permissions, and parallel execution.

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
