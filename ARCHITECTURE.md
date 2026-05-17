# Architecture

Network-AI v5.5.0 — TypeScript/Node.js multi-agent orchestrator with 29 adapters, 3,093 tests, 66+ modules.

## The Multi-Agent Race Condition Problem

Most agent frameworks let you run multiple AI agents in parallel. None of them protect you when those agents write to the same resource at the same time.

**The "Bank Run" scenario:**

```
Agent A reads balance:  $10,000
Agent B reads balance:  $10,000       (same moment)
Agent A writes balance: $10,000 - $7,000 = $3,000
Agent B writes balance: $10,000 - $6,000 = $4,000   ← Agent A's write is gone
```

Both agents thought they had $10,000. Both spent from it. You lost $3,000 to a race condition.

Without concurrency control, parallel agents will:
- **Corrupt shared state** — two agents overwrite each other's blackboard entries
- **Double-spend budgets** — token costs exceed limits because agents don't see each other's spending
- **Produce contradictory outputs** — Agent A says "approved", Agent B says "denied", both write to the same key

**How Network-AI prevents this:**

```typescript
// Atomic commit — no other agent can read/write "account:balance" during this operation
const changeId = blackboard.proposeChange('account:balance', { amount: 7000 }, 'agent-a');
blackboard.validateChange(changeId);   // checks for conflicts
blackboard.commitChange(changeId);     // atomic write with file-system mutex
```

---

## Component Overview

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
        QA["QAOrchestratorAgent\n(scenario replay, regression tracking)"]:::quality
        BB["SharedBlackboard\n(shared agent state)\npropose → validate → commit\nfilesystem mutex"]:::blackboard
        AD["Adapters — plug any framework in, swap freely\n29 adapters: LangChain · AutoGen · CrewAI · MCP · Copilot · LangGraph · Hermes · …"]:::adapters
        RT["AgentRuntime\n(sandbox policy, approval gates)"]:::security
        CUI["ConsoleUI\n(TUI dashboard + pipe mode)"]:::app
        SA["StrategyAgent\n(AgentPool, WorkloadPartitioner,\nadaptive scaling)"]:::routing

        AG -->|"grant / deny"| AR
        AR -->|"tasks dispatched"| AD
        AD -->|"writes results"| BB
        QG -->|"validates"| BB
        QA -->|"orchestrates"| QG
        RT -->|"sandbox exec"| AD
        SA -->|"scale / partition"| AR
        CUI -->|"operator control"| SO
    end

    SO --> AUDIT["data/audit_log.jsonl\n(HMAC / Ed25519-signed)"]:::audit
```

> `FederatedBudget` is a standalone export — instantiate it separately and optionally wire it to a blackboard backend for cross-node token budget enforcement.
>
> `ProjectContextManager` is a standalone Layer-3 Python helper — see [§ Layer 3](#layer-3--projectcontextmanager) below.

### LockedBlackboard

The coordination core. Uses file-system mutexes so any number of agents can write concurrently without data loss.

- `propose(key, value, agentId, ttl?, priority?)` — stages a change, detects conflicts
- `validate(changeId, validatorId)` — confirms no race occurred since propose
- `commit(changeId)` — atomic write
- Conflict strategies: `first-commit-wins`, `priority-wins`, `last-write-wins`

### AuthGuardian

Permission gating before sensitive operations. Agents must request a token with a business justification — the guardian evaluates trust level, resource risk, and justification quality before granting.

```typescript
const grant = auth.requestPermission('data_analyst', 'DATABASE', 'read',
  'Need customer order history for sales report');
// grant.token is scoped HMAC / Ed25519-signed token with TTL
```

Resource types: `DATABASE` (risk 0.5), `PAYMENTS` (0.7), `EMAIL` (0.4), `FILE_EXPORT` (0.6)

Permission scoring: justification quality 40%, agent trust level 30%, resource risk 30%. Threshold: 0.5.

### FederatedBudget

Hard token ceilings per agent and per task. Even if 5 agents run in parallel, total spend cannot exceed the budget.

```bash
python scripts/swarm_guard.py budget-init   --task-id "task_001" --budget 10000
python scripts/swarm_guard.py budget-check  --task-id "task_001"
python scripts/swarm_guard.py budget-report --task-id "task_001"
```

### CLI (bin/cli.ts)

A full in-process command-line interface that imports `LockedBlackboard`, `AuthGuardian`, and `FederatedBudget` directly — no server process required. Useful for one-off inspection, CI assertions, and debugging without spinning up the MCP server.

```bash
network-ai bb list                    # inspect shared state
network-ai audit tail                 # live-stream audit events
network-ai auth token my-bot \
  --resource DATABASE --action read   # issue a permission token
network-ai budget status              # check spend across agents
```

Four command groups mirror the four core subsystems: `bb` (LockedBlackboard), `auth` (AuthGuardian), `budget` (FederatedBudget), `audit` (SecureAuditLogger). Global `--data <path>` and `--json` flags apply to every command.

→ Full reference in [QUICKSTART.md § CLI](QUICKSTART.md)

### AdapterRegistry

Routes tasks to the right agent/framework automatically. Register multiple adapters and the registry dispatches by agent ID.

```typescript
const registry = new AdapterRegistry();
registry.register('my-langchain-agent', langchainAdapter);
registry.register('my-autogen-agent',   autogenAdapter);
```

---

## FSM Journey (JourneyFSM)

The FSM governs agent phase transitions for long-running pipelines. Each phase transition is:
- Gated by AuthGuardian tokens
- Logged to the audit trail
- Subject to timeout enforcement

```
IDLE → PLANNING → EXECUTING → REVIEWING → COMMITTING → COMPLETE
                                           ↓
                                       BLOCKED (on violation)
```

ComplianceMonitor captures violations in real-time:
- `TOOL_ABUSE` — too many rapid writes
- `TURN_TAKING` — consecutive actions without yield
- `RESPONSE_TIMEOUT` — agent exceeds time budget
- `JOURNEY_TIMEOUT` — overall pipeline exceeds wall-clock limit

---

## Handoff Protocol

Format messages for delegation between agents:

```
[HANDOFF]
Instruction: Analyze monthly sales by product category
Context: Using database export from ./data/sales_export.csv
Constraints: Focus on top 5 categories only
Expected Output: JSON summary with category, revenue, growth_pct
[/HANDOFF]
```

Budget-aware handoff (wraps `sessions_send` with budget checks):

```bash
python scripts/swarm_guard.py intercept-handoff \
  --task-id "task_001" \
  --from orchestrator \
  --to data_analyst \
  --message "Analyze Q4 revenue data"
```

Output:
```
HANDOFF ALLOWED: orchestrator -> data_analyst
   Tokens spent: 156
   Budget remaining: 9,844
   Handoff #1 (remaining: 2)
   -> Proceed with sessions_send
```

---

## Content Quality Gate

Two-layer validation before blackboard writes:

**Layer 1 — BlackboardValidator (rule-based, zero LLM calls)**
- Hallucination detection (vague, unsupported, fabricated content)
- Dangerous code detection (`eval()`, `exec()`, `rm -rf`)
- Placeholder rejection (TODO/FIXME/stub content)
- Throughput: ~500,000 ops/sec on 1 KB inputs

**Layer 2 — QualityGateAgent (AI-assisted)**
- Async, intended for high-value writes only
- Quarantine system for suspicious content
- Adds LLM latency — use selectively

**Layer 3 — QAOrchestratorAgent (coordination)**
- Scenario replay: re-run blackboard entries through quality gates as a test harness
- Feedback loop: route rejections back to agents with structured feedback and retry limits
- Regression tracker: historical quality snapshots with trend comparison
- Cross-agent contradiction detection: detect conflicting outputs from multiple agents on the same key

---

## The 3-Layer Memory Model

Every agent in a Network-AI swarm operates with three memory layers:

| Layer | Name | Lifetime | Managed by |
|-------|------|----------|------------|
| **1** | Agent context | Ephemeral — current session only | Platform / LLM host |
| **2** | Blackboard | TTL-scoped — shared across agents | `LockedBlackboard` / `scripts/blackboard.py` |
| **3** | Project context | Persistent — survives all sessions | `scripts/context_manager.py` |

### Layer 2 — LockedBlackboard
Shared markdown file for real-time task coordination: results, grant tokens, status flags, TTL-scoped cache. Atomic `propose → validate → commit` cycle prevents race conditions.

### Layer 3 — ProjectContextManager
A JSON file (`data/project-context.json`) that holds information every agent should know regardless of which session or task is running: goals, tech stack, architecture decisions, milestones, and banned approaches.

```bash
# Inject context into an agent system prompt
python scripts/context_manager.py inject

# Record a decision
python scripts/context_manager.py update \
  --section decisions \
  --add '{"decision": "Atomic blackboard commits", "rationale": "Prevent race conditions"}'

# Mark milestone complete
python scripts/context_manager.py update --section milestones --complete "Ship v1.0"
```

---

## v5.0 Module Inventory

### New Adapters (9 new, 26 total)

| Adapter | Framework | File |
|---------|-----------|------|
| `CopilotAdapter` | GitHub Copilot | `adapters/copilot-adapter.ts` |
| `LangGraphAdapter` | LangGraph StateGraph | `adapters/langgraph-adapter.ts` |
| `AnthropicComputerUseAdapter` | Anthropic Computer Use | `adapters/anthropic-computer-use-adapter.ts` |
| `OpenAIAgentsAdapter` | OpenAI Agents SDK | `adapters/openai-agents-adapter.ts` |
| `VertexAIAdapter` | Vertex AI / Gemini | `adapters/vertex-ai-adapter.ts` |
| `PydanticAIAdapter` | Pydantic AI | `adapters/pydantic-ai-adapter.ts` |
| `BrowserAgentAdapter` | Browser automation | `adapters/browser-agent-adapter.ts` |

### New Core Modules

| Module | File | Purpose |
|--------|------|---------|
| `EnvironmentManager` | `lib/env-manager.ts` | Multi-env promotion chain (dev→st→sit→qa→preprod→prod+sandbox), backup/restore, env diff, gate enforcement |
| `ContextThrottler` | `lib/context-throttler.ts` | Prune blackboard keys per-agent scope before LLM calls; `filterState()` + wildcard / `exactMatch` / `maxKeys` options |
| `RouteClassifier` | `lib/route-classifier.ts` | Classify goals pre-DAG; short-circuit `FACTUAL_LOOKUP` to a lookup agent bypassing blackboard |
| `PartitionPlanner` | `lib/partition-planner.ts` | Assign non-overlapping focus areas to agents; pluggable planner + `createLexicalOverlapChecker()` |
| `CoverageGate` | `lib/coverage-gate.ts` | Recursive refinement loop: evaluate completeness, re-run GoalDecomposer for gaps until score ≥ threshold |
| `MCPToolConsumer` | `lib/mcp-tool-consumer.ts` | Consume remote MCP servers (stdio + HTTP transport) |
| `ApprovalInbox` | `lib/approval-inbox.ts` | Web approval queue with REST API + SSE streaming |
| `AgentVCR` | `lib/agent-vcr.ts` | Record/replay agent calls with cassette files |
| `ComparisonRunner` | `lib/comparison-runner.ts` | Side-by-side adapter comparison with scoring |
| `CoverageReporter` | `lib/coverage-reporter.ts` | V8 coverage collection + threshold enforcement |
| `JobQueue` / `FileJobStore` | `lib/job-queue.ts` | Persistent priority FIFO with crash recovery |
| `SwarmTransportServer` | `lib/swarm-transport.ts` | JSON-RPC 2.0 over HTTP with HMAC auth |
| `GoalDSL` | `lib/goal-dsl.ts` | YAML/JSON goal definitions + cycle detection |
| `startPlayground` | `lib/playground.ts` | Interactive REPL sandbox with mock agents |
| `createAdapterTestSuite` | `lib/adapter-test-harness.ts` | Parameterized adapter test battery |
| `IAuthValidator` | `lib/auth-validator.ts` | Pluggable auth interface (decoupled from AuthGuardian) |
| `NoOpAuthValidator` | `lib/auth-validator.ts` | Always-grant auth for testing |

### Existing Modules (from v4.x)

| Module | File | Purpose |
|--------|------|---------|
| `AgentConversation` | `lib/agent-conversation.ts` | Multi-turn agent dialogues |
| `AgentDebate` | `lib/agent-debate.ts` | Structured agent debate |
| `AgentMemory` | `lib/agent-memory.ts` | Per-agent memory persistence |
| `AnomalyDetector` | `lib/anomaly-detector.ts` | Behavioral anomaly detection |
| `ConfigWatcher` | `lib/config-watcher.ts` | Live config reload |
| `CostGovernor` | `lib/cost-governor.ts` | Cost budget enforcement |
| `CostHeatmap` | `lib/cost-heatmap.ts` | Agent cost visualization |
| `DashboardServer` | `lib/dashboard-server.ts` | Web dashboard |
| `DryRun` | `lib/dry-run.ts` | Simulation mode |
| `EventBus` | `lib/event-bus.ts` | Typed pub/sub events |
| `Explainability` | `lib/explainability.ts` | Decision audit trails |
| `LearningLoop` | `lib/learning-loop.ts` | Agent self-improvement |
| `OTelBridge` | `lib/otel-bridge.ts` | OpenTelemetry export |
| `Quadtree` | `lib/quadtree.ts` | Spatial indexing |
| `SemanticMemory` | `lib/semantic-search.ts` | BYOE vector store |
| `SpeculativeExecutor` | `lib/speculative-executor.ts` | Speculative execution |
| `TimelineScrubber` | `lib/timeline-scrubber.ts` | Time-travel debugging |
| `Topology` | `lib/topology.ts` | Agent network topology |

---

## Agent Trust Levels

| Agent | Trust | Role |
|---|---|---|
| `orchestrator` | 0.9 | Primary coordinator |
| `risk_assessor` | 0.85 | Compliance specialist |
| `data_analyst` | 0.8 | Data processing |
| `strategy_advisor` | 0.7 | Business strategy |
| Unknown | 0.5 | Default |

Configure in `scripts/check_permission.py`:

```python
DEFAULT_TRUST_LEVELS = {
    "orchestrator": 0.9,
    "my_new_agent": 0.75,
}
GRANT_TOKEN_TTL_MINUTES = 5
```

---

## Project Structure

```
Network-AI/
├── index.ts                      # Core orchestrator (SwarmOrchestrator, AuthGuardian, TaskDecomposer)
├── security.ts                   # Security module (tokens, encryption, rate limiting, audit)
├── setup.ts                      # Developer setup & installation checker
├── bin/
│   └── cli.ts                    # Full CLI — bb, auth, budget, audit commands (in-process)
├── adapters/                     # 17 plug-and-play agent framework adapters
│   ├── adapter-registry.ts       # Multi-adapter routing & discovery
│   ├── base-adapter.ts           # Abstract base class
│   ├── custom-adapter.ts         # Custom function/HTTP agent adapter
│   ├── langchain-adapter.ts
│   ├── autogen-adapter.ts
│   ├── crewai-adapter.ts
│   ├── mcp-adapter.ts
│   ├── llamaindex-adapter.ts
│   ├── semantic-kernel-adapter.ts
│   ├── openai-assistants-adapter.ts
│   ├── haystack-adapter.ts
│   ├── dspy-adapter.ts
│   ├── agno-adapter.ts
│   ├── aps-adapter.ts
│   └── openclaw-adapter.ts
├── lib/
│   ├── locked-blackboard.ts      # Atomic commits with file-system mutexes
│   ├── blackboard-validator.ts   # Content quality gate (Layer 1 + Layer 2)
│   ├── qa-orchestrator.ts        # QA orchestrator (scenario replay, regression, contradictions)
│   ├── fsm-journey.ts            # FSM state machine and compliance monitor
│   ├── swarm-utils.ts            # Helper utilities
│   ├── adapter-hooks.ts          # Lifecycle hooks + matcher-based filtering (v4.12–4.13)
│   ├── skill-composer.ts         # chain/batch/loop/verify meta-operations (v4.12)
│   ├── semantic-search.ts        # BYOE vector store with cosine similarity (v4.12)
│   ├── phase-pipeline.ts         # Multi-phase workflows with approval gates (v4.13)
│   ├── confidence-filter.ts      # Multi-agent result scoring and filtering (v4.13)
│   ├── fan-out.ts                # Parallel agent spawning with pluggable aggregation (v4.13)
│   ├── agent-runtime.ts          # Sandboxed execution with SandboxPolicy, ShellExecutor (v4.14)
│   ├── console-ui.ts             # Interactive terminal dashboard with ANSI TUI (v4.14)
│   ├── strategy-agent.ts         # Meta-orchestrator with AgentPool, WorkloadPartitioner (v4.14)
│   ├── context-throttler.ts       # Prune blackboard keys per-agent scope (v5.3)
│   ├── route-classifier.ts        # Goal routing + FACTUAL_LOOKUP short-circuit (v5.3)
│   ├── partition-planner.ts       # Non-overlapping agent focus areas (v5.3)
│   ├── coverage-gate.ts           # Recursive completeness refinement loop (v5.3)
│   └── goal-decomposer.ts        # LLM-powered goal → task DAG → parallel execution (v4.15)
├── scripts/                      # Python helper scripts (local orchestration only)
│   ├── blackboard.py             # Shared state management with atomic commits
│   ├── swarm_guard.py            # Handoff tax prevention, budget tracking
│   ├── check_permission.py       # AuthGuardian permission checker + active grants
│   ├── validate_token.py         # Token validation
│   ├── revoke_token.py           # Token revocation + TTL cleanup
│   └── context_manager.py        # Layer-3 persistent project context
├── types/
│   ├── agent-adapter.d.ts        # Universal adapter interfaces
│   └── openclaw-core.d.ts        # OpenClaw type stubs
├── references/                   # Deep-dive documentation
│   ├── adapter-system.md
│   ├── auth-guardian.md
│   ├── blackboard-schema.md
│   ├── trust-levels.md
│   └── mcp-roadmap.md
├── examples/                     # Runnable examples (01–06)
│   ├── 01-hello-swarm.ts
│   ├── 02-fsm-pipeline.ts
│   ├── 03-parallel-agents.ts
│   ├── 04-live-swarm.ts
│   └── 05-code-review-swarm.ts
└── data/
    ├── audit_log.jsonl           # HMAC / Ed25519-signed audit trail (local only)
    └── pending_changes/          # In-flight atomic change records
```
