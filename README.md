# Network-AI

**TypeScript/Node.js multi-agent orchestrator — shared state, guardrails, budgets, and cross-framework coordination**

[![CI](https://github.com/jovanSAPFIONEER/Network-AI/actions/workflows/ci.yml/badge.svg)](https://github.com/jovanSAPFIONEER/Network-AI/actions/workflows/ci.yml)
[![CodeQL](https://github.com/jovanSAPFIONEER/Network-AI/actions/workflows/codeql.yml/badge.svg)](https://github.com/jovanSAPFIONEER/Network-AI/actions/workflows/codeql.yml)
[![Release](https://img.shields.io/badge/release-v4.0.16-blue.svg)](https://github.com/jovanSAPFIONEER/Network-AI/releases)
[![npm](https://img.shields.io/npm/dw/network-ai.svg?label=npm%20downloads)](https://www.npmjs.com/package/network-ai)
[![Tests](https://img.shields.io/badge/tests-1184%20passing-brightgreen.svg)](#testing)
[![Adapters](https://img.shields.io/badge/frameworks-12%20supported-blueviolet.svg)](#adapter-system)
[![License](https://img.shields.io/badge/license-MIT-brightgreen.svg)](LICENSE)
[![Socket](https://socket.dev/api/badge/npm/package/network-ai)](https://socket.dev/npm/package/network-ai/overview)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6.svg)](https://typescriptlang.org)
[![ClawHub](https://img.shields.io/badge/ClawHub-network--ai-orange.svg)](https://clawhub.ai/skills/network-ai)
[![Integration Guide](https://img.shields.io/badge/docs-integration%20guide-informational.svg)](INTEGRATION_GUIDE.md)

Network-AI is a TypeScript/Node.js multi-agent orchestrator that adds coordination, guardrails, and governance to any AI agent stack.

- **Shared blackboard with locking** — atomic `propose → validate → commit` prevents race conditions and split-brain failures across parallel agents
- **Guardrails and budgets** — FSM governance, per-agent token ceilings, HMAC audit trails, and permission gating
- **12 framework adapters** — LangChain, AutoGen, CrewAI, OpenAI Assistants, LlamaIndex, Semantic Kernel, and more in one orchestrator — no glue code, no lock-in

**Use Network-AI as:**
- A **TypeScript/Node.js library** — `import { createSwarmOrchestrator } from 'network-ai'`
- An **MCP server** — `npx network-ai-server --port 3001`
- An **OpenClaw skill** — `clawhub install network-ai`

[**5-minute quickstart →**](QUICKSTART.md) &nbsp;|&nbsp; [**Architecture →**](ARCHITECTURE.md) &nbsp;|&nbsp; [**All adapters →**](#adapter-system) &nbsp;|&nbsp; [**Benchmarks →**](BENCHMARKS.md)

---

## Why teams use Network-AI

| Problem | How Network-AI solves it |
|---|---|
| Race conditions in parallel agents | Atomic blackboard: `propose → validate → commit` with file-system mutex |
| Agent overspend / runaway costs | `FederatedBudget` — hard per-agent token ceilings with live spend tracking |
| No visibility into what agents did | HMAC-signed audit log on every write, permission grant, and FSM transition |
| Locked into one AI framework | 12 adapters — mix LangChain + AutoGen + CrewAI + custom in one swarm |
| Agents escalating beyond their scope | `AuthGuardian` — scoped permission tokens required before sensitive operations |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Your Application                        │
└──────────────────────────┬──────────────────────────────────┘
                           │  createSwarmOrchestrator()
┌──────────────────────────▼──────────────────────────────────┐
│                  SwarmOrchestrator                          │
│  ┌──────────────┐  ┌───────────────┐  ┌─────────────────┐  │
│  │ AdapterRegistry│  │ AuthGuardian  │  │ FederatedBudget │  │
│  │ (route tasks) │  │ (permissions) │  │ (token ceilings)│  │
│  └──────┬───────┘  └───────────────┘  └─────────────────┘  │
│         │                                                    │
│  ┌──────▼──────────────────────────────────────────────┐   │
│  │            LockedBlackboard (shared state)           │   │
│  │   propose → validate → commit  (file-system mutex)  │   │
│  └──────────────────────────────────────────────────────┘   │
│         │                                                    │
│  ┌──────▼───────────────────────────────────────────────┐  │
│  │  Adapters (plug any framework in, swap out freely)   │  │
│  │  LangChain │ AutoGen │ CrewAI │ MCP │ LlamaIndex │…  │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                           │
              HMAC-signed audit log
```

→ [Full architecture, FSM journey, and handoff protocol](ARCHITECTURE.md)

---

## Install

```bash
npm install network-ai
```

No native dependencies, no build step. Adapters are dependency-free (BYOC — bring your own client).

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

---

## Adapter System

12 frameworks, zero adapter dependencies. You bring your own SDK objects.

| Adapter | Framework | Register method |
|---|---|---|
| `CustomAdapter` | Any function or HTTP endpoint | `registerHandler(name, fn)` |
| `LangChainAdapter` | LangChain | `registerRunnable(name, runnable)` |
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

Extend `BaseAdapter` to add your own in minutes. See [references/adapter-system.md](references/adapter-system.md).

---

## Works with LangGraph, CrewAI, and AutoGen

> Network-AI is the coordination layer you add **on top of** your existing stack. Keep your LangChain chains, CrewAI crews, and AutoGen agents — and add shared state, governance, and budgets around them.

| Capability | Network-AI | LangGraph | CrewAI | AutoGen |
|---|---|---|---|---|
| Cross-framework agents in one swarm | ✅ 12 adapters | ❌ LangChain only | ❌ CrewAI only | ❌ AutoGen only |
| Atomic shared state (conflict-safe) | ✅ `propose → validate → commit` | ⚠️ Last-write-wins | ⚠️ Last-write-wins | ⚠️ Last-write-wins |
| Hard budget ceiling per agent | ✅ `FederatedBudget` | ⚠️ Callbacks only | ❌ | ❌ |
| Permission gating before sensitive ops | ✅ `AuthGuardian` | ❌ | ❌ | ❌ |
| Tamper-evident audit trail | ✅ HMAC-signed | ❌ | ❌ | ❌ |
| Encryption at rest | ✅ AES-256-GCM | ❌ | ❌ | ❌ |
| Language | TypeScript / Node.js | Python | Python | Python |

---

## Testing

```bash
npm run test:all          # All suites in sequence
npm test                  # Core orchestrator
npm run test:security     # Security module
npm run test:adapters     # All 12 adapters
npm run test:priority     # Priority & preemption
```

**1,184 passing assertions across 15 test suites** (verified by counting `assert()` / `pass()` calls in each file):

| Suite | Assertions | Covers |
|---|---|---|
| `test-standalone.ts` | 83 | Blackboard, auth, integration, persistence, parallelisation, quality gate |
| `test-adapters.ts` | 142 | All 12 adapters, registry routing, integration, edge cases |
| `test-phase4.ts` | 133 | FSM, compliance monitor, adapter integration |
| `test-phase5d.ts` | 119 | Pluggable backend |
| `test-phase5f.ts` | 113 | Phase 5f extended |
| `test-phase5g.ts` | 106 | Phase 5g extended |
| `test-phase6.ts` | 122 | Latest feature coverage |
| `test-phase5c.ts` | 74 | Named multi-blackboard |
| `test-phase5e.ts` | 88 | Phase 5e |
| `test-phase5b.ts` | 56 | Pluggable backend part 2 |
| `test-priority.ts` | 65 | Priority preemption, conflict resolution, backward compat |
| `test-security.ts` | 35 | Tokens, sanitization, rate limiting, encryption, audit |
| `test-phase5.ts` | 24 | Named multi-blackboard base |
| `test.ts` | 24 | Full integration |
| `test-phase4.ts` (stubs) | 4 | FSM stub coverage |

---

## Documentation

| Doc | Contents |
|---|---|
| [QUICKSTART.md](QUICKSTART.md) | Installation, first run, PowerShell guide, Python scripts CLI |
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

## Contributing

1. Fork → feature branch → `npm run test:all` → pull request
2. Bugs and feature requests via [Issues](https://github.com/jovanSAPFIONEER/Network-AI/issues)
3. If Network-AI saves you time, a ⭐ helps others find it

[![Star on GitHub](https://img.shields.io/github/stars/jovanSAPFIONEER/Network-AI?style=social)](https://github.com/jovanSAPFIONEER/Network-AI)

---

MIT License — [LICENSE](LICENSE) &nbsp;·&nbsp; [CHANGELOG](CHANGELOG.md) &nbsp;·&nbsp; [CONTRIBUTING](CONTRIBUTING.md) &nbsp;·&nbsp; [![RSS](https://img.shields.io/badge/RSS-releases-orange?logo=rss)](https://github.com/jovanSAPFIONEER/Network-AI/releases.atom)

<details>
<summary>Keywords (for search)</summary>

ai-agents, agentic-ai, multi-agent, multi-agent-systems, multi-agent-system, agent-framework, ai-agent-framework, agentic-framework, agentic-workflow, llm, llm-agents, llm-agent, large-language-models, generative-ai, genai, orchestration, ai-orchestration, swarm, swarm-intelligence, autonomous-agents, agents, ai, typescript, nodejs, mcp, model-context-protocol, a2a, agent-to-agent, function-calling, tool-integration, context-engineering, rag, ai-safety, multi-agents-collaboration, multi-agents, aiagents, aiagentframework, plug-and-play, adapter-registry, blackboard-pattern, agent-coordination, agent-handoffs, token-permissions, budget-tracking, cost-awareness, atomic-commits, hallucination-detection, content-quality-gate, behavioral-control-plane, governance-layer, compliance-enforcement, fan-out-fan-in, agent-observability, permission-gating, audit-trail, OpenClaw, ClawHub, clawhub, AgentSkills, LangChain adapter, LangGraph, AutoGen adapter, AG2, CrewAI adapter, MCP adapter, LlamaIndex adapter, Semantic Kernel adapter, OpenAI Assistants adapter, Haystack adapter, DSPy adapter, Agno adapter, custom-adapter, AES-256 encryption, HMAC tokens, rate limiting, input sanitization, privilege escalation prevention, agentic-rag, deep-research, workflow-orchestration, ai-assistant, ai-tools, developer-tools, open-source

</details>
