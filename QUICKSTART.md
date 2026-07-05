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

**Zero external AI dependencies.** All 32 adapters are self-contained — add framework SDKs only when you need them.

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
| `openclaw` | OpenClaw | `openclaw-core` | OpenClaw skill ecosystem |
| `a2a` | A2A | none | Agent-to-Agent protocol |
| `codex` | Codex | `openai` | OpenAI Codex CLI |
| `minimax` | MiniMax | none | MiniMax chat completions |
| `nemoclaw` | NemoClaw | none | NVIDIA sandboxed agent execution |
| `aps` | APS | none | Delegation-chain trust mapping |
| `copilot` | GitHub Copilot | none | Code generate/review/explain/fix/test/refactor |
| `langgraph` | LangGraph | `@langchain/langgraph` | Compiled StateGraph execution |
| `anthropic-computer-use` | Anthropic Computer Use | `@anthropic-ai/sdk` | Screenshot/click/type/scroll automation |
| `openai-agents` | OpenAI Agents SDK | `openai` | Tool use, handoffs, guardrails |
| `vertex-ai` | Vertex AI / Gemini | `@google-cloud/vertexai` | Function calling, multi-modal |
| `gemini` | Gemini Developer API | none | Google AI Studio models, thinking budgets |
| `openai-responses` | OpenAI Responses API | none | GPT-5.x / o-series via `/v1/responses` (Assistants successor) |
| `claude-agent-sdk` | Claude Agent SDK | `@anthropic-ai/claude-agent-sdk` | Full agentic loops as swarm agents |
| `pydantic-ai` | Pydantic AI | none | Structured output with validation |
| `browser-agent` | Browser Automation | none | Playwright/Puppeteer/CDP browser control |
| `hermes` | NousResearch Hermes / OpenAI-compatible | none | Ollama, Together AI, Fireworks, llama.cpp |
| `orchestrator` | Hierarchical multi-orchestrator | none | Nested orchestrator coordination |
| `rlm` | RLM-compatible HTTP endpoint | none | Recursive Language Model servers (BYOC client) |

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

For batch testing and regression tracking, use the QA Orchestrator:

```typescript
import { QAOrchestratorAgent } from 'network-ai';

const qa = new QAOrchestratorAgent({
  qualityThreshold: 0.7,
  maxRetries: 2,
  onFeedback: (fb) => console.log('Fix needed:', fb.issues),
});

// Run scenarios through quality gates
const harness = await qa.runHarness([
  { id: 'test-1', key: 'analysis', value: agentOutput, sourceAgent: 'analyst' },
]);
console.log(`Pass rate: ${harness.passRate}`);

// Detect cross-agent contradictions
const contradictions = qa.detectContradictions();

// Track quality regressions over time
const report = qa.getRegressionReport();
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
npx ts-node test-standalone.ts    # 88 core tests
npx ts-node test-security.ts      # 34 security tests
npx ts-node test-adapters.ts      # 271 adapter tests (all 32 frameworks)
 npx ts-node test-cli.ts           # 65 CLI tests
npx ts-node test-qa.ts             # 67 QA orchestrator tests
```

---

## 9. Commands Reference

```bash
npx ts-node setup.ts --check      # Verify installation
npx ts-node setup.ts --list       # List adapter quick-start snippets
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

### Multi-Environment (`env`) — v5.4.0+

Isolate agent state across dev / staging / production using the promotion chain.

```bash
# Initialise all environments at once
network-ai env init --all

# Or initialise a single environment
network-ai env init --env dev

# List environments and key counts
network-ai env list

# Show the promotion chain
network-ai env chain

# Diff two environments (shows +added / -removed / ~changed config keys)
network-ai env diff --from dev --to prod

# Promote config from dev → st (auto-gate, no approval needed)
network-ai env promote --from dev --to st

# Promote to preprod (requires --confirmed-by)
network-ai env promote --from qa --to preprod --confirmed-by "jane.doe"

# Promote to prod (requires --approved-by)
network-ai env promote --from preprod --to prod --approved-by "security-board"

# Backup / restore
network-ai env backup create --env prod
network-ai env backup list   --env prod
network-ai env backup restore --env prod --latest
network-ai env backup prune  --env prod --keep 5
```

Set `NETWORK_AI_ENV=dev` to automatically route all blackboard and Python script operations to `data/dev/`.

---

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

### Diagnostics (`doctor`)

```bash
# Validate the full environment — data dir, env routing, audit log, WAL, kill-switch, MCP secret
network-ai doctor
network-ai doctor --json   # machine-readable

# ✓ [PASS] data-dir: /path/to/data
# ✓ [PASS] env-routing: no --env or NETWORK_AI_ENV set; using root data dir
# ✓ [PASS] audit-log: 42 entries, all valid JSONL
# ✓ [PASS] pending-changes: no pending changes
# ✓ [PASS] kill-switch: system is running
# ⚠ [WARN] mcp-secret: NETWORK_AI_MCP_SECRET not set
# ✓ [PASS] blackboard-schema: blackboard.json OK (7 keys)
```

Exits with code `0` if all checks pass, `1` if any fail — safe for CI gates.

### Inspect a key (`inspect`)

```bash
# Show current value and metadata
network-ai inspect agent:status

# Include pending WAL history
network-ai inspect agent:status --history

# Include audit trail entries for this key
network-ai inspect agent:status --audit

# All together, machine-readable
network-ai inspect agent:status --history --audit --json
```

### Kill switch (`pause` / `resume`)

```bash
# Pause all orchestrator activity
network-ai pause
# ✓ system paused at 2026-05-23T15:00:00.000Z

# Resume
network-ai resume
# ✓ system resumed

# Check state
network-ai doctor   # ⚠ [WARN] kill-switch: system is PAUSED
```

Creates/removes a `data/SYSTEM_PAUSED` sentinel file. Agents should check for this file before performing writes.

### `--why` on `auth token`

```bash
# See the full scoring breakdown before the token is issued
network-ai auth token my-bot --resource DATABASE \
  --justification "Fetch Q4 invoices for year-end report" --why

# justification score (40%): 80.0%
# trust score        (30%): 100.0%
# risk score         (30%): 50.0% risk → 50.0% contribution
# weighted score:           74.0%
# verdict:                  APPROVED
```

### Global flags

| Flag | Default | Purpose |
|---|---|---|
| `--data <path>` | `./data` | Override the data directory |
| `--env <name>` | — | Target environment (dev/st/sit/qa/preprod/prod) |
| `--json` | off | Machine-readable JSON output on every command |
| `--minimal` | off | Skip WAL replay + TTL sweep (CI/test fast startup). Also set via `NETWORK_AI_MINIMAL=1` |

```bash
# Example: point at a non-default data dir and get JSON output
network-ai --data /var/swarm/data --json bb list

# CI mode — skip WAL replay for fast startup
NETWORK_AI_MINIMAL=1 network-ai doctor --json
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
       ├── QAOrchestratorAgent     — Scenario replay, feedback loops, regression tracking
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
            ├── AgnoAdapter         ─── Agno agents/teams
            ├── APSAdapter          ─── APS delegation-chain trust
            ├── CopilotAdapter      ─── GitHub Copilot
            ├── LangGraphAdapter    ─── LangGraph state graphs
            ├── VertexAIAdapter     ─── Vertex AI / Gemini
            ├── GeminiAdapter       ─── Gemini Developer API
            ├── OpenAIResponsesAdapter ── OpenAI Responses API
            ├── ClaudeAgentSDKAdapter ─── Claude Agent SDK loops
            ├── PydanticAIAdapter   ─── Pydantic AI structured output
            ├── OpenAIAgentsAdapter ─── OpenAI Agents SDK
            ├── AnthropicComputerUseAdapter ─── Computer Use
            └── BrowserAgentAdapter ─── Browser automation
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

# Interactive console (TUI dashboard)
npx network-ai-console

# Pipe mode for AI-driven control (JSON stdin/stdout)
npx network-ai-console --pipe

# Console with custom settings
npx network-ai-console --base-path ./workspace --budget 50000 --allow "npm *,git status"
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

**Claude Code (CLI) plugin:**
Install Network-AI as a [Claude Code](https://code.claude.com) plugin — the MCP server wires in automatically:

```bash
/plugin marketplace add Jovancoding/Network-AI
/plugin install network-ai@network-ai
```

Every Network-AI tool (`blackboard_read`, `budget_status`, `audit_query`, …) then loads natively. The plugin runs `npx -y -p network-ai network-ai-server --stdio`. Validate the manifests locally with `claude plugin validate .`.

**OpenAI Codex (CLI & IDE):**
Add Network-AI as a Codex MCP server with one command:

```bash
codex mcp add network-ai -- npx -y -p network-ai network-ai-server --stdio
```

Or commit it per-project — the repo root ships a [`.codex/config.toml`](.codex/config.toml) that registers the same stdio server for trusted checkouts. Run `/mcp` in the Codex TUI to verify it connected.

---

## Fan-Out / Fan-In Pattern

```typescript
import { LockedBlackboard } from 'network-ai';

const board   = new LockedBlackboard('.', logger, { conflictResolution: 'first-commit-wins' });
const pillars = ['reliability', 'security', 'cost', 'operations', 'performance'];

// Fan-out: each agent writes to its own section independently
for (const pillar of pillars) {
  const id = board.propose(`review:${pillar}`, { score: Math.random(), findings: [] }, pillar);
  board.validate(id, 'orchestrator');
  board.commit(id);
}

// Fan-in: orchestrator reads all results and synthesises
const results = pillars.map(p => ({ pillar: p, ...board.read(`review:${p}`) }));
const id = board.propose('review:summary', {
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

// All 28 adapters
import {
  AdapterRegistry, BaseAdapter,
  OpenClawAdapter, LangChainAdapter, AutoGenAdapter,
  CrewAIAdapter, MCPAdapter, CustomAdapter,
  LlamaIndexAdapter, SemanticKernelAdapter, OpenAIAssistantsAdapter,
  HaystackAdapter, DSPyAdapter, AgnoAdapter,
  CopilotAdapter, LangGraphAdapter, AnthropicComputerUseAdapter,
  OpenAIAgentsAdapter, VertexAIAdapter, PydanticAIAdapter, BrowserAgentAdapter,
} from 'network-ai';

// v5.0 modules
import {
  AgentVCR, ComparisonRunner, CoverageReporter,
  JobQueue, FileJobStore, ApprovalInbox,
  SwarmTransportServer, SwarmTransportClient,
  startPlayground, createAdapterTestSuite,
  parseGoal, validateGoal, compileGoal,
  NoOpAuthValidator,
} from 'network-ai';

// Types
import type {
  IAgentAdapter, AgentPayload, AgentContext, AgentResult, AgentInfo,
  AdapterConfig, TaskPayload, HandoffMessage, PermissionGrant, SwarmState,
  ParallelTask, ParallelExecutionResult, SynthesisStrategy,
} from 'network-ai';
```
