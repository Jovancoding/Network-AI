# Network-AI

**TypeScript/Node.js multi-agent orchestrator — shared state, guardrails, budgets, and cross-framework coordination**

[![Website](https://img.shields.io/badge/website-network--ai.org-4b9df2?style=flat&logo=web&logoColor=white)](https://network-ai.org/)
[![CI](https://github.com/Jovancoding/Network-AI/actions/workflows/ci.yml/badge.svg)](https://github.com/Jovancoding/Network-AI/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Jovancoding/Network-AI/actions/workflows/codeql.yml/badge.svg)](https://github.com/Jovancoding/Network-AI/actions/workflows/codeql.yml)
[![Release](https://img.shields.io/badge/release-v4.10.5-blue.svg)](https://github.com/Jovancoding/Network-AI/releases)
[![npm](https://img.shields.io/npm/dw/network-ai.svg?label=npm%20downloads)](https://www.npmjs.com/package/network-ai)
[![Tests](https://img.shields.io/badge/tests-1617%20passing-brightgreen.svg)](#testing)
[![Adapters](https://img.shields.io/badge/frameworks-17%20supported-blueviolet.svg)](#adapter-system)
[![License](https://img.shields.io/badge/license-MIT-brightgreen.svg)](LICENSE)
[![Socket](https://socket.dev/api/badge/npm/package/network-ai)](https://socket.dev/npm/package/network-ai/overview)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6.svg)](https://typescriptlang.org)
[![ClawHub](https://img.shields.io/badge/ClawHub-network--ai-orange.svg)](https://clawhub.ai/skills/network-ai)
[![Integration Guide](https://img.shields.io/badge/docs-integration%20guide-informational.svg)](INTEGRATION_GUIDE.md)
[![Sponsor](https://img.shields.io/badge/sponsor-support%20the%20project-f15bb5.svg)](https://github.com/sponsors/Jovancoding)
[![Discord](https://img.shields.io/badge/Discord-Join%20Community-5865F2?logo=discord&logoColor=white)](https://discord.gg/Cab5vAxc86)
[![Glama](https://glama.ai/mcp/servers/Jovancoding/network-ai/badges/score.svg)](https://glama.ai/mcp/servers/Jovancoding/network-ai)

<p align="center">
  <img src="assets/demo.svg" alt="Network-AI control-plane demo — atomic blackboard, priority preemption, AuthGuardian, FSM governance" width="720">
</p>

Network-AI is a TypeScript/Node.js multi-agent orchestrator that adds coordination, guardrails, and governance to any AI agent stack.

- **Shared blackboard with locking** — atomic `propose → validate → commit` prevents race conditions and split-brain failures across parallel agents
- **Guardrails and budgets** — FSM governance, per-agent token ceilings, HMAC / Ed25519 audit trails, and permission gating
- **17 adapters** — LangChain (+ streaming), AutoGen, CrewAI, OpenAI Assistants, LlamaIndex, Semantic Kernel, Haystack, DSPy, Agno, MCP, Custom (+ streaming), OpenClaw, A2A, Codex, MiniMax, NemoClaw, and APS — no glue code, no lock-in
- **Persistent project memory (Layer 3)** — `context_manager.py` injects decisions, goals, stack, milestones, and banned patterns into every system prompt so agents always have full project context

> **The silent failure mode in multi-agent systems:** parallel agents writing to the same key
> use last-write-wins by default — one agent's result silently overwrites another's mid-flight.
> The outcome is split-brain state: double-spends, contradictory decisions, corrupted context,
> no error thrown. Network-AI's `propose → validate → commit` mutex prevents this at the
> coordination layer, before any write reaches shared state.

**Use Network-AI as:**
- A **TypeScript/Node.js library** — `import { createSwarmOrchestrator } from 'network-ai'`
- An **MCP server** — `npx network-ai-server --port 3001`
- A **CLI** — `network-ai bb get status` / `network-ai audit tail`
- An **OpenClaw skill** — `clawhub install network-ai`

[**5-minute quickstart →**](QUICKSTART.md) &nbsp;|&nbsp; [**Architecture →**](ARCHITECTURE.md) &nbsp;|&nbsp; [**All adapters →**](#adapter-system) &nbsp;|&nbsp; [**Benchmarks →**](BENCHMARKS.md)

---

## ⚡ Try in 60 Seconds

```bash
npm install network-ai
```

```typescript
import { LockedBlackboard } from 'network-ai';

const board = new LockedBlackboard('.');
const id    = board.propose('status', { ready: true }, 'agent-1');
board.validate(id, 'agent-1');
board.commit(id);

console.log(board.read('status'));  // { ready: true }
```

Two agents, atomic writes, no race conditions. That's it.

Want the full stress test? **No API key, ~3 seconds:**

```bash
npx ts-node examples/08-control-plane-stress-demo.ts
```

Runs priority preemption, AuthGuardian permission gating, FSM governance, and compliance monitoring — all without a single LLM call.

> If it saves you from a race condition, a ⭐ helps others find it.

---

## What's Included

| | |
|---|---|
| ✅ Atomic shared state | `propose → validate → commit` with filesystem mutex — no split-brain |
| ✅ Token budgets | Hard per-agent ceilings with live spend tracking |
| ✅ Permission gating | HMAC / Ed25519-signed tokens, scoped per agent and resource |
| ✅ Append-only audit log | Every write, grant, and transition signed and logged |
| ✅ 17 framework adapters | LangChain, CrewAI, AutoGen, MCP, Codex, APS, and 11 more — zero lock-in |
| ✅ FSM governance | Hard-stop agents at state boundaries, timeout enforcement |
| ✅ Compliance monitoring | Real-time violation detection (tool abuse, turn-taking, timeouts) |
| ✅ TypeScript native | ES2022 strict mode, zero native dependencies |

---

## Why teams use Network-AI

| Problem | How Network-AI solves it |
|---|---|
| Race conditions in parallel agents | Atomic blackboard: `propose → validate → commit` with file-system mutex |
| Agent overspend / runaway costs | `FederatedBudget` — hard per-agent token ceilings with live spend tracking |
| No visibility into what agents did | HMAC / Ed25519-signed audit log on every write, permission grant, and FSM transition |
| Locked into one AI framework | 17 adapters — mix LangChain + AutoGen + CrewAI + Codex + MiniMax + NemoClaw + APS + custom in one swarm |
| Agents escalating beyond their scope | `AuthGuardian` — scoped permission tokens required before sensitive operations |
| Agents lack project context between runs | `ProjectContextManager` (Layer 3) — inject decisions, goals, stack, and milestones into every system prompt |

---

## Architecture

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'primaryColor': '#1e293b', 'primaryTextColor': '#e2e8f0', 'primaryBorderColor': '#475569', 'lineColor': '#94a3b8', 'clusterBkg': '#0f172a', 'clusterBorder': '#334155', 'edgeLabelBackground': '#1e293b', 'edgeLabelColor': '#cbd5e1', 'titleColor': '#e2e8f0'}}}%%
flowchart TD
    classDef app        fill:#1e3a5f,stroke:#3b82f6,color:#bfdbfe,font-weight:bold
    classDef security   fill:#451a03,stroke:#d97706,color:#fde68a
    classDef routing    fill:#14532d,stroke:#16a34a,color:#bbf7d0
    classDef quality    fill:#3b0764,stroke:#9333ea,color:#e9d5ff
    classDef blackboard fill:#0c4a6e,stroke:#0284c7,color:#bae6fd
    classDef adapters   fill:#064e3b,stroke:#059669,color:#a7f3d0
    classDef audit      fill:#1e293b,stroke:#475569,color:#94a3b8

    App["Your Application"]:::app
    App -->|"createSwarmOrchestrator()"| SO

    subgraph SO["SwarmOrchestrator"]
        AG["AuthGuardian\n(HMAC / Ed25519 permission tokens)"]:::security
        AR["AdapterRegistry\n(route tasks to frameworks)"]:::routing
        QG["QualityGateAgent\n(validate blackboard writes)"]:::quality
        BB["SharedBlackboard\n(shared agent state)\npropose → validate → commit\nfilesystem mutex"]:::blackboard
        AD["Adapters — plug any framework in, swap freely\nLangChain · AutoGen · CrewAI · MCP · LlamaIndex · …"]:::adapters

        AG -->|"grant / deny"| AR
        AR -->|"tasks dispatched"| AD
        AD -->|"writes results"| BB
        QG -->|"validates"| BB
    end

    SO --> AUDIT["data/audit_log.jsonl\n(HMAC / Ed25519-signed)"]:::audit
```

> `FederatedBudget` is a standalone export — instantiate it separately and optionally wire it to a blackboard backend for cross-node token budget enforcement.
>
> `ProjectContextManager` is a Layer-3 Python helper (`scripts/context_manager.py`) that injects persistent project goals, decisions, and milestones into agent system prompts — see [ARCHITECTURE.md § Layer 3](ARCHITECTURE.md#layer-3--projectcontextmanager).

→ [Full architecture, FSM journey, and handoff protocol](ARCHITECTURE.md)

---

## Install

```bash
npm install network-ai
```

No native dependencies, no build step. Adapters are dependency-free (BYOC — bring your own client).

---

## Use as MCP Server

Start the server (no config required, zero dependencies):

```bash
npx network-ai-server --port 3001
# or from source:
npx ts-node bin/mcp-server.ts --port 3001
```

Then wire any MCP-compatible client to it.

**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "network-ai": {
      "url": "http://localhost:3001/sse"
    }
  }
}
```

**Cursor / Cline / any SSE-based MCP client** — point to the same URL:

```json
{
  "mcpServers": {
    "network-ai": {
      "url": "http://localhost:3001/sse"
    }
  }
}
```

Verify it's running:

```bash
curl http://localhost:3001/health   # { "status": "ok", "tools": <n>, "uptime": <ms> }
curl http://localhost:3001/tools    # full tool list
```

**Tools exposed over MCP:**
- `blackboard_read` / `blackboard_write` / `blackboard_list` / `blackboard_delete` / `blackboard_exists`
- `budget_status` / `budget_spend` / `budget_reset` — federated token tracking
- `token_create` / `token_validate` / `token_revoke` — HMAC / Ed25519-signed permission tokens
- `audit_query` — query the append-only audit log
- `config_get` / `config_set` — live orchestrator configuration
- `agent_list` / `agent_spawn` / `agent_stop` — agent lifecycle
- `fsm_transition` — write FSM state transitions to the blackboard

Each tool takes an `agent_id` parameter — all writes are identity-verified and namespace-scoped, exactly as they are in the TypeScript API.

Options: `--no-budget`, `--no-token`, `--no-control`, `--ceiling <n>`, `--board <name>`, `--audit-log <path>`.

---

## CLI

Control Network-AI directly from the terminal — no server required. The CLI imports the same core engine used by the MCP server.

```bash
# One-off commands (no server needed)
npx ts-node bin/cli.ts bb set status running --agent cli
npx ts-node bin/cli.ts bb get status
npx ts-node bin/cli.ts bb snapshot

# After npm install -g network-ai:
network-ai bb list
network-ai audit tail          # live-stream the audit log
network-ai auth token my-bot --resource blackboard
```

| Command group | What it controls |
|---|---|
| `network-ai bb` | Blackboard — get, set, delete, list, snapshot, propose, commit, abort |
| `network-ai auth` | AuthGuardian — issue tokens, revoke, check permissions |
| `network-ai budget` | FederatedBudget — spend status, set ceiling |
| `network-ai audit` | Audit log — print, live-tail, clear |

Global flags on every command: `--data <path>` (data directory, default `./data`) · `--json` (machine-readable output)

→ Full reference in [QUICKSTART.md § CLI](QUICKSTART.md)

---

## Two agents, one shared state — without race conditions

The real differentiator is coordination. Here is what no single-framework solution handles: two agents writing to the same resource concurrently, atomically, without corrupting each other.

```typescript
import { LockedBlackboard, CustomAdapter, createSwarmOrchestrator } from 'network-ai';

const board   = new LockedBlackboard('.');
const adapter = new CustomAdapter();

// Agent 1: writes its analysis result atomically
adapter.registerHandler('analyst', async () => {
  const id = board.propose('report:status', { phase: 'analysis', complete: true }, 'analyst');
  board.validate(id, 'analyst');
  board.commit(id);                           // file-system mutex — no race condition possible
  return { result: 'analysis written' };
});

// Agent 2: runs concurrently, writes to its own key safely
adapter.registerHandler('reviewer', async () => {
  const id = board.propose('report:review', { approved: true }, 'reviewer');
  board.validate(id, 'reviewer');
  board.commit(id);
  const analysis = board.read('report:status');
  return { result: `reviewed phase=${analysis?.phase}` };
});

createSwarmOrchestrator({ adapters: [{ adapter }] });

// Both fire concurrently — mutex guarantees no write is ever lost
const [, ] = await Promise.all([
  adapter.executeAgent('analyst',  { action: 'run', params: {} }, { agentId: 'analyst' }),
  adapter.executeAgent('reviewer', { action: 'run', params: {} }, { agentId: 'reviewer' }),
]);

console.log(board.read('report:status'));   // { phase: 'analysis', complete: true }
console.log(board.read('report:review'));   // { approved: true }
```

Add budgets, permissions, and cross-framework agents with the same pattern. → [QUICKSTART.md](QUICKSTART.md)

---

## Demo — Control-Plane Stress Test *(no API key)*

Runs in ~3 seconds. Proves the coordination primitives without any LLM calls.

```bash
npm run demo -- --08
```

What it shows: atomic blackboard locking, priority preemption (priority-3 wins over priority-0 on same key), **AuthGuardian permission gate** (blocked → justified → granted with token), FSM hard-stop at 700 ms, live compliance violation capture (TOOL_ABUSE, TURN_TAKING, RESPONSE_TIMEOUT, JOURNEY_TIMEOUT), and `FederatedBudget` tracking — all without a single API call.

[![Control Plane Demo](https://img.youtube.com/vi/niVRZJu1MEo/0.jpg)](https://www.youtube.com/watch?v=niVRZJu1MEo)

**8-agent AI pipeline** (requires `OPENAI_API_KEY` — builds a Payment Processing Service end-to-end):

```bash
npm run demo -- --07
```

[![Code Review Swarm Demo](https://img.youtube.com/vi/UyMsNhaw9lU/0.jpg)](https://youtu.be/UyMsNhaw9lU)

**NemoClaw sandbox swarm** *(no API key)* — 3 agents in isolated NVIDIA NemoClaw sandboxes with deny-by-default network policies:

```bash
npx ts-node examples/10-nemoclaw-sandbox-swarm.ts
```

[![NemoClaw Sandbox Demo](https://img.youtube.com/vi/c-UWDrdP4ZE/0.jpg)](https://www.youtube.com/watch?v=c-UWDrdP4ZE)

---

## Adapter System

17 adapters, zero adapter dependencies. You bring your own SDK objects.

| Adapter | Framework / Protocol | Register method |
|---|---|---|
| `CustomAdapter` | Any function or HTTP endpoint | `registerHandler(name, fn)` |
| `LangChainAdapter` | LangChain | `registerAgent(name, runnable)` |
| `AutoGenAdapter` | AutoGen / AG2 | `registerAgent(name, agent)` |
| `CrewAIAdapter` | CrewAI | `registerAgent` or `registerCrew` |
| `MCPAdapter` | Model Context Protocol | `registerTool(name, handler)` |
| `LlamaIndexAdapter` | LlamaIndex | `registerQueryEngine()`, `registerChatEngine()` |
| `SemanticKernelAdapter` | Microsoft Semantic Kernel | `registerKernel()`, `registerFunction()` |
| `OpenAIAssistantsAdapter` | OpenAI Assistants | `registerAssistant(name, config)` |
| `HaystackAdapter` | deepset Haystack | `registerPipeline()`, `registerAgent()` |
| `DSPyAdapter` | Stanford DSPy | `registerModule()`, `registerProgram()` |
| `AgnoAdapter` | Agno (formerly Phidata) | `registerAgent()`, `registerTeam()` |
| `OpenClawAdapter` | OpenClaw | `registerSkill(name, skillRef)` |
| `A2AAdapter` | Google A2A Protocol | `registerRemoteAgent(name, url)` |
| `CodexAdapter` | OpenAI Codex / gpt-4o / Codex CLI | `registerCodexAgent(name, config)` |
| `MiniMaxAdapter` | MiniMax LLM API (M2.5 / M2.5-highspeed) | `registerAgent(name, config)` |
| `NemoClawAdapter` | NVIDIA NemoClaw (sandboxed agents via OpenShell) | `registerSandboxAgent(name, config)` |
| `APSAdapter` | Agent Permission Service (delegation-chain trust) | `apsDelegationToTrust(delegation)` |

**Streaming variants** (drop-in replacements with `.stream()` support):

| Adapter | Extends | Streaming source |
|---|---|---|
| `LangChainStreamingAdapter` | `LangChainAdapter` | Calls `.stream()` on the Runnable if available; falls back to `.invoke()` |
| `CustomStreamingAdapter` | `CustomAdapter` | Pipes `AsyncIterable<string>` handlers; falls back to single-chunk for plain Promises |

Extend `BaseAdapter` (or `StreamingBaseAdapter` for streaming) to add your own in minutes. See [references/adapter-system.md](references/adapter-system.md).

---

## Works with LangGraph, CrewAI, and AutoGen

> Network-AI is the coordination layer you add **on top of** your existing stack. Keep your LangChain chains, CrewAI crews, and AutoGen agents — and add shared state, governance, and budgets around them.

| Capability | Network-AI | LangGraph | CrewAI | AutoGen |
|---|---|---|---|---|
| Cross-framework agents in one swarm | ✅ 17 built-in adapters | ⚠️ Nodes can call any code; no adapter abstraction | ⚠️ Extensible via tools; CrewAI-native agents only | ⚠️ Extensible via plugins; AutoGen-native agents only |
| Atomic shared state (conflict-safe) | ✅ `propose → validate → commit` mutex | ⚠️ State passed between nodes; last-write-wins | ⚠️ Shared memory available; no conflict resolution | ⚠️ Shared context available; no conflict resolution |
| Hard token ceiling per agent | ✅ `FederatedBudget` (first-class API) | ⚠️ Via callbacks / custom middleware | ⚠️ Via callbacks / custom middleware | ⚠️ Built-in token tracking in v0.4+; no swarm-level ceiling |
| Permission gating before sensitive ops | ✅ `AuthGuardian` (built-in) | ⚠️ Possible via custom node logic | ⚠️ Possible via custom tools | ⚠️ Possible via custom middleware |
| Append-only audit log | ✅ plain JSONL (`data/audit_log.jsonl`) | ⚠️ Not built-in | ⚠️ Not built-in | ⚠️ Not built-in |
| Encryption at rest | ✅ AES-256-GCM (TypeScript layer) | ⚠️ Not built-in | ⚠️ Not built-in | ⚠️ Not built-in |
| Language | TypeScript / Node.js | Python | Python | Python |

---

## Testing

```bash
npm run test:all          # All suites in sequence
npm test                  # Core orchestrator
npm run test:security     # Security module
npm run test:adapters     # All 17 adapters
npm run test:streaming    # Streaming adapters
npm run test:a2a          # A2A protocol adapter
npm run test:codex        # Codex adapter
npm run test:priority     # Priority & preemption
npm run test:cli          # CLI layer
```

**1,617 passing assertions across 20 test suites** (`npm run test:all`):

| Suite | Assertions | Covers |
|---|---|---|
| `test-phase4.ts` | 147 | FSM governance, compliance monitor, adapter integration |
| `test-phase5f.ts` | 127 | SSE transport, `McpCombinedBridge`, extended MCP tools |
| `test-phase5g.ts` | 121 | CRDT backend, vector clocks, bidirectional sync |
| `test-phase6.ts` | 121 | MCP server, control-plane tools, audit tools |
| `test-adapters.ts` | 176 | All 17 adapters, registry routing, integration, edge cases |
| `test-phase5d.ts` | 117 | Pluggable backend (Redis, CRDT, Memory) |
| `test-standalone.ts` | 88 | Blackboard, auth, integration, persistence, parallelisation, quality gate |
| `test-phase5e.ts` | 87 | Federated budget tracking |
| `test-phase5c.ts` | 73 | Named multi-blackboard, isolation, backend options |
| `test-codex.ts` | 51 | Codex adapter: chat, completion, CLI, BYOC client, error paths |
| `test-minimax.ts` | 50 | MiniMax adapter: lifecycle, registration, chat mode, temperature clamping |
| `test-nemoclaw.ts` | 93 | NemoClaw adapter: sandbox lifecycle, policies, blueprint, handoff, env forwarding |
| `test-priority.ts` | 64 | Priority preemption, conflict resolution, backward compat |
| `test-a2a.ts` | 35 | A2A protocol: register, execute, mock fetch, error paths |
| `test-streaming.ts` | 32 | Streaming adapters, chunk shapes, fallback, collectStream |
| `test-phase5b.ts` | 55 | Pluggable backend part 2, consistency levels |
| `test-phase5.ts` | 42 | Named multi-blackboard base |
| `test-security.ts` | 34 | Tokens, sanitization, rate limiting, encryption, audit |
| `test-cli.ts` | 65 | CLI layer: bb, auth, budget, audit commands |

---

## Documentation

| Doc | Contents |
|---|---|
| [QUICKSTART.md](QUICKSTART.md) | Installation, first run, CLI reference, PowerShell guide, Python scripts CLI |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Race condition problem, FSM design, handoff protocol, project structure |
| [BENCHMARKS.md](BENCHMARKS.md) | Provider performance, rate limits, local GPU, `max_completion_tokens` guide |
| [SECURITY.md](SECURITY.md) | Security module, permission system, trust levels, audit trail |
| [ENTERPRISE.md](ENTERPRISE.md) | Evaluation checklist, stability policy, security summary, integration entry points |
| [AUDIT_LOG_SCHEMA.md](AUDIT_LOG_SCHEMA.md) | Audit log field reference, all event types, scoring formula |
| [ADOPTERS.md](ADOPTERS.md) | Known adopters — open a PR to add yourself |
| [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md) | End-to-end integration walkthrough |
| [references/adapter-system.md](references/adapter-system.md) | Adapter architecture, writing custom adapters |
| [references/auth-guardian.md](references/auth-guardian.md) | Permission scoring, resource types |
| [references/trust-levels.md](references/trust-levels.md) | Trust level configuration |

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
In the GPT editor → Actions → Import from URL, or paste the contents of `openapi.yaml`.
Set the server URL to your running `npx network-ai-server --port 3001` instance.

**Claude Projects:**
Copy the contents of `claude-project-prompt.md` (below the horizontal rule) into a Claude Project's Custom Instructions field. No server required for instruction-only mode.

---

## Community

Join our Discord server to discuss multi-agent AI coordination, get help, and share what you're building:

[![Discord](https://img.shields.io/badge/Join%20Discord-5865F2?logo=discord&logoColor=white&style=for-the-badge)](https://discord.gg/Cab5vAxc86)

---

## Contributing

1. Fork → feature branch → `npm run test:all` → pull request
2. Bugs and feature requests via [Issues](https://github.com/Jovancoding/Network-AI/issues)

---

MIT License — [LICENSE](LICENSE) &nbsp;·&nbsp; [CHANGELOG](CHANGELOG.md) &nbsp;·&nbsp; [CONTRIBUTING](CONTRIBUTING.md) &nbsp;·&nbsp; [![RSS](https://img.shields.io/badge/RSS-releases-orange?logo=rss)](https://github.com/Jovancoding/Network-AI/releases.atom)

<details>
<summary>Keywords</summary>

multi-agent · agent orchestration · AI agents · agentic AI · agentic workflow · TypeScript · Node.js · LangGraph · CrewAI · AutoGen · MCP · model-context-protocol · LlamaIndex · Semantic Kernel · OpenAI Assistants · Haystack · DSPy · Agno · OpenClaw · ClawHub · shared state · blackboard pattern · atomic commits · guardrails · token budgets · permission gating · audit trail · agent coordination · agent handoffs · governance · cost-awareness

</details>
