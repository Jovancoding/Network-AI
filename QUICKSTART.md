# Network-AI Quick Start Guide

Get the Multi-Agent Swarm Orchestrator running in **under 5 minutes**.

---

## 1. Install

```bash
# Clone the repo
git clone https://github.com/Jovancoding/Network-AI.git
cd Network-AI

# Install dependencies (only TypeScript + ts-node needed)
npm install

# Verify everything works
npx ts-node setup.ts --check
```

**Zero external AI dependencies.** All 12 adapters are self-contained — add framework SDKs only when you need them.

---

## 2. Pick Your Framework

| Adapter | Framework | Dependency | Use Case |
|---------|-----------|------------|----------|
| `custom` | Any | none | Plain functions or HTTP endpoints |
| `langchain` | LangChain | `langchain` | Chains, agents, RAG |
| `autogen` | AutoGen/AG2 | `autogen-agentchat` | Multi-agent conversations |
| `crewai` | CrewAI | none | Role-based agent crews |
| `mcp` | MCP | `@modelcontextprotocol/sdk` | Tool serving & discovery |
| `openclaw` | OpenClaw | `openclaw-core` | OpenClaw skill ecosystem |
| `llamaindex` | LlamaIndex | `llamaindex` | RAG, query engines |
| `semantic-kernel` | Semantic Kernel | `semantic-kernel` | Enterprise planners & plugins |
| `openai-assistants` | OpenAI Assistants | `openai` | GPT assistants with threads |
| `haystack` | Haystack | none | Production RAG pipelines |
| `dspy` | DSPy | none | Programmatic prompt optimisation |
| `agno` | Agno | none | Multi-agent teams |

---

## 3. Hello World (30 seconds)

```typescript
import { createSwarmOrchestrator } from './index';
import { AdapterRegistry, CustomAdapter } from './adapters';

async function main() {
  // Create orchestrator
  const orchestrator = createSwarmOrchestrator({
    agentId: 'my-app',
    swarmName: 'My First Swarm',
  });

  // Create a simple agent
  const adapter = new CustomAdapter();
  adapter.registerHandler('greeter', async (payload) => {
    const name = payload.handoff?.instruction || 'World';
    return { greeting: `Hello, ${name}!` };
  });

  // Register it
  const registry = new AdapterRegistry();
  await registry.addAdapter(adapter);

  // Execute
  const result = await registry.executeAgent('custom:greeter', {
    action: 'greet',
    params: {},
    handoff: { instruction: 'Developer' },
  }, {
    agentId: 'my-app',
    taskId: 'task-1',
    timestamp: Date.now(),
    priority: 5,
  });

  console.log(result.data); // { greeting: "Hello, Developer!" }
}

main();
```

---

## 4. Multi-Framework Setup

Use different AI frameworks **together** in one orchestrator:

```typescript
import { AdapterRegistry, CustomAdapter, LlamaIndexAdapter, DSPyAdapter } from './adapters';

async function multiFramework() {
  const registry = new AdapterRegistry();

  // Framework 1: Custom agents for business logic
  const custom = new CustomAdapter();
  custom.registerHandler('validator', async (p) => ({
    valid: true,
    message: 'Input validated',
  }));

  // Framework 2: LlamaIndex for RAG
  const llamaindex = new LlamaIndexAdapter();
  llamaindex.registerQueryEngine('knowledge-base', myQueryEngine);

  // Framework 3: DSPy for classification
  const dspy = new DSPyAdapter();
  dspy.registerPredictor('classifier', async (inputs) => ({
    answer: inputs.question?.toString().includes('urgent') ? 'high' : 'low',
  }));

  // Register all
  await registry.addAdapter(custom);
  await registry.addAdapter(llamaindex);
  await registry.addAdapter(dspy);

  // Route tasks to the right framework
  await registry.executeAgent('custom:validator', ...);
  await registry.executeAgent('llamaindex:knowledge-base', ...);
  await registry.executeAgent('dspy:classifier', ...);
}
```

---

## 5. Add Quality Validation

Prevent bad data from entering the shared blackboard:

```typescript
import { createSwarmOrchestrator } from './index';

const orchestrator = createSwarmOrchestrator({
  agentId: 'my-app',
  swarmName: 'Quality-Controlled Swarm',
  qualityThreshold: 0.7,  // Auto-approve above this score
  aiReviewCallback: async (entry) => {
    // Optional: plug in your AI model for borderline entries
    const score = await myAIModel.evaluate(entry.value);
    return { approved: score > 0.5, score, reason: 'AI reviewed' };
  },
});
```

---

## 6. Security

```typescript
import {
  SecureSwarmGateway,
  SecureTokenManager,
  RateLimiter,
} from './security';

const gateway = new SecureSwarmGateway({
  rateLimiting: true,
  auditLogging: true,
  inputSanitization: true,
});
```

---

## 7. Build Your Own Adapter

Create a custom adapter for any framework in ~50 lines:

```typescript
import { BaseAdapter } from './adapters/base-adapter';
import type { AgentPayload, AgentContext, AgentResult } from './types/agent-adapter';

export class MyFrameworkAdapter extends BaseAdapter {
  readonly name = 'my-framework';
  readonly version = '1.0.0';

  private agents = new Map<string, any>();

  registerAgent(id: string, agent: any): void {
    this.agents.set(id, agent);
    this.registerLocalAgent({
      id, name: id,
      description: `My agent: ${id}`,
      status: 'available',
    });
  }

  async executeAgent(
    agentId: string,
    payload: AgentPayload,
    context: AgentContext
  ): Promise<AgentResult> {
    this.ensureReady();
    const agent = this.agents.get(agentId);
    if (!agent) return this.errorResult('NOT_FOUND', `Unknown: ${agentId}`, false);

    const start = Date.now();
    try {
      const result = await agent.run(payload.handoff?.instruction || '');
      return this.successResult(result, Date.now() - start);
    } catch (e: any) {
      return this.errorResult('ERROR', e.message, true, e);
    }
  }
}
```

---

## 8. Run Tests

```bash
npx ts-node test-standalone.ts    # 79 core tests
npx ts-node test-security.ts      # 33 security tests
npx ts-node test-adapters.ts      # 100+ adapter tests (all 14 frameworks)
npx ts-node test-cli.ts           # 65 CLI tests
```

---

## 9. Commands Reference

```bash
npx ts-node setup.ts --check      # Verify installation
npx ts-node setup.ts --list       # List all 12 adapters
npx ts-node setup.ts --example    # Generate example.ts
```

---

## 10. CLI

Control Network-AI directly from the terminal — no server or running process required.  
The CLI imports the same `LockedBlackboard`, `AuthGuardian`, and `FederatedBudget` core used everywhere else.

### Install (global)

```bash
npm install -g network-ai
network-ai --help
```

Or run from source without installing:

```bash
npx ts-node bin/cli.ts --help
```

### Blackboard (`bb`)

```bash
# Write / read / delete
network-ai bb set agent:status running --agent orchestrator
network-ai bb get agent:status
network-ai bb delete agent:status

# List all keys
network-ai bb list

# Snapshot (pretty-print full state)
network-ai bb snapshot

# Atomic propose → commit workflow
network-ai bb propose agent:status complete --agent orchestrator   # prints changeId
network-ai bb commit  <changeId>
network-ai bb abort   <changeId>
```

### Auth (`auth`)

```bash
# Issue a permission token
network-ai auth token my-bot --resource DATABASE --action read \
  --justification "Need Q4 invoices for report"

# Validate a token
network-ai auth check grant_a1b2c3...

# Revoke a token
network-ai auth revoke grant_a1b2c3...
```

### Budget (`budget`)

```bash
# View current spend across all agents
network-ai budget status

# Set a new ceiling
network-ai budget set-ceiling 50000
```

### Audit (`audit`)

```bash
# Print recent entries (last 50 by default)
network-ai audit log --limit 50

# Live-stream new entries as they arrive
network-ai audit tail

# Clear the log (irreversible)
network-ai audit clear
```

### Global flags

| Flag | Default | Purpose |
|---|---|---|
| `--data <path>` | `./data` | Override the data directory |
| `--json` | off | Machine-readable JSON output on every command |

```bash
# Example: point at a non-default data dir and get JSON output
network-ai --data /var/swarm/data --json bb list
```

---

## Architecture

```
Your App
  └── SwarmOrchestrator (index.ts)
       ├── SharedBlackboard        — Shared state across agents
       ├── AuthGuardian            — Trust & permissions
       ├── TaskDecomposer          — Break tasks into subtasks
       ├── BlackboardValidator     — Quality gate (Layer 1)
       ├── QualityGateAgent        — AI review (Layer 2)
       └── AdapterRegistry         — Routes to any framework
            ├── CustomAdapter       ─── your functions / HTTP
            ├── LangChainAdapter    ─── LangChain / LangGraph
            ├── AutoGenAdapter      ─── Microsoft AutoGen
            ├── CrewAIAdapter       ─── CrewAI crews
            ├── MCPAdapter          ─── Model Context Protocol
            ├── OpenClawAdapter     ─── OpenClaw skills
            ├── LlamaIndexAdapter   ─── LlamaIndex engines
            ├── SemanticKernelAdapter── Semantic Kernel
            ├── OpenAIAssistantsAdapter── OpenAI Assistants
            ├── HaystackAdapter     ─── Haystack pipelines
            ├── DSPyAdapter         ─── DSPy modules
            └── AgnoAdapter         ─── Agno agents/teams
```

---

**Questions?** Open an issue at [github.com/Jovancoding/Network-AI](https://github.com/Jovancoding/Network-AI)

---

## PowerShell (Windows)

All commands work in PowerShell. The only difference from bash is environment variable syntax.

```powershell
# Set your API key for the current session
$env:OPENAI_API_KEY = "sk-..."

# Or copy the template and fill it in
Copy-Item .env.example .env

# Run examples (no API key needed)
npx ts-node examples/01-hello-swarm.ts
npx ts-node examples/02-fsm-pipeline.ts
npx ts-node examples/03-parallel-agents.ts

# Interactive example launcher
npx ts-node run.ts

# Run tests
npm test
npm run test:all
```

To persist `OPENAI_API_KEY` across sessions, add it to your PowerShell profile or set it via *System Properties → Environment Variables*.

---

## Python Scripts CLI

The Python scripts in `scripts/` implement the local governance layer. All run locally — no network calls.

### Budget (always initialise first)

```bash
python scripts/swarm_guard.py budget-init   --task-id "task_001" --budget 10000
python scripts/swarm_guard.py budget-check  --task-id "task_001"
python scripts/swarm_guard.py budget-report --task-id "task_001"
```

### Budget-Aware Handoffs

```bash
python scripts/swarm_guard.py intercept-handoff \
  --task-id "task_001" \
  --from orchestrator \
  --to data_analyst \
  --message "Analyze Q4 revenue data"
```

### Blackboard

```bash
# Write
python scripts/blackboard.py write "task:analysis" '{"status": "running"}'

# Read
python scripts/blackboard.py read "task:analysis"

# Atomic commit workflow
python scripts/blackboard.py propose "chg_001" "key" '{"value": 1}'
python scripts/blackboard.py validate "chg_001"
python scripts/blackboard.py commit "chg_001"

# List all keys
python scripts/blackboard.py list
```

### Permissions

```bash
# Request permission
python scripts/check_permission.py \
  --agent data_analyst \
  --resource DATABASE \
  --justification "Need customer order history for Q4 report"

# View active grants
python scripts/check_permission.py --active-grants
python scripts/check_permission.py --active-grants --agent data_analyst --json

# Audit summary
python scripts/check_permission.py --audit-summary
python scripts/check_permission.py --audit-summary --last 50 --json
```

### Token Management

```bash
python scripts/revoke_token.py --list-expired
python scripts/revoke_token.py --cleanup
python scripts/validate_token.py --token "grant_85364b44..."
```

### Project Context (Layer 3 — Persistent Memory)

Long-lived project state that every agent inherits, regardless of session:

```bash
# Initialise once
python scripts/context_manager.py init \
  --name "MyProject" \
  --description "Multi-agent workflow" \
  --version "1.0.0"

# Print formatted block to inject into agent system prompts
python scripts/context_manager.py inject

# Record an architecture decision
python scripts/context_manager.py update \
  --section decisions \
  --add '{"decision": "Use atomic blackboard commits", "rationale": "Prevent race conditions"}'

# Update milestones
python scripts/context_manager.py update --section milestones --complete "Ship v1.0"
python scripts/context_manager.py update --section milestones --add '{"planned": "Vector memory integration"}'

# Set tech stack
python scripts/context_manager.py update --section stack --set '{"language": "TypeScript", "runtime": "Node.js 18"}'

# Add a goal or ban an approach
python scripts/context_manager.py update --section goals --add "Ship v2.0 before Q3"
python scripts/context_manager.py update --section banned --add "Direct DB writes from agents"

# Print full context as JSON
python scripts/context_manager.py show
```

Context is stored in `data/project-context.json`. The `inject` command outputs a markdown block ready to prepend to any agent's system prompt.

---

## Use with Claude, ChatGPT & Codex

Three integration files are included in the repo root:

| File | Use |
|---|---|
| [`claude-tools.json`](claude-tools.json) | Claude API tool use & OpenAI Codex — drop into the `tools` array |
| [`openapi.yaml`](openapi.yaml) | Custom GPT Actions — import directly in the GPT editor |
| [`claude-project-prompt.md`](claude-project-prompt.md) | Claude Projects — paste into Custom Instructions |

**Claude API / Codex:**
```js
import tools from './claude-tools.json' assert { type: 'json' };
// Pass tools array to anthropic.messages.create({ tools }) or OpenAI chat completions
```

**Custom GPT Actions:**
In the GPT editor → Actions → Import from URL, or paste `openapi.yaml` directly.
Set the server URL to your running `npx network-ai-server --port 3001` instance.

**Claude Projects:**
Copy the contents of `claude-project-prompt.md` into a Claude Project's Custom Instructions field. No server required for instruction-only mode.

---

## Fan-Out / Fan-In Pattern

```typescript
import { LockedBlackboard } from 'network-ai';

const board   = new LockedBlackboard('.', logger, { conflictResolution: 'first-commit-wins' });
const pillars = ['reliability', 'security', 'cost', 'operations', 'performance'];

// Fan-out: each agent writes to its own section independently
for (const pillar of pillars) {
  const id = board.propose(`eval:${pillar}`, { score: Math.random(), findings: [] }, pillar);
  board.validate(id, 'orchestrator');
  board.commit(id);
}

// Fan-in: orchestrator reads all results and synthesises
const results = pillars.map(p => ({ pillar: p, ...board.read(`eval:${p}`) }));
const id = board.propose('eval:summary', {
  overall: results.reduce((s, r) => s + r.score, 0) / results.length,
  pillars: results,
}, 'orchestrator');
board.validate(id, 'orchestrator');
board.commit(id);
```

---

## Configuration

### Modify Trust Levels

Edit `scripts/check_permission.py`:

```python
DEFAULT_TRUST_LEVELS = {
    "orchestrator": 0.9,
    "my_new_agent": 0.75,   # add your agent
}
GRANT_TOKEN_TTL_MINUTES = 5
```

---

## Module Exports

```typescript
// Core classes
import SwarmOrchestrator, {
  SharedBlackboard, AuthGuardian, TaskDecomposer,
  BlackboardValidator, QualityGateAgent,
} from 'network-ai';

// Factory
import { createSwarmOrchestrator } from 'network-ai';

// All 12 adapters
import {
  AdapterRegistry, BaseAdapter,
  OpenClawAdapter, LangChainAdapter, AutoGenAdapter,
  CrewAIAdapter, MCPAdapter, CustomAdapter,
  LlamaIndexAdapter, SemanticKernelAdapter, OpenAIAssistantsAdapter,
  HaystackAdapter, DSPyAdapter, AgnoAdapter,
} from 'network-ai';

// Types
import type {
  IAgentAdapter, AgentPayload, AgentContext, AgentResult, AgentInfo,
  AdapterConfig, TaskPayload, HandoffMessage, PermissionGrant, SwarmState,
  ParallelTask, ParallelExecutionResult, SynthesisStrategy,
} from 'network-ai';
```
