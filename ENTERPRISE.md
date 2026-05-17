# Network-AI — Enterprise Evaluation Guide

This document exists so an engineer or architect can evaluate Network-AI in under 30 minutes without a sales call.

---

## Quick Evaluation Checklist

| Question | Answer |
|---|---|
| Can I run it fully offline / air-gapped? | **Yes.** Core orchestration, blackboard, permissions, FSM, budget, and compliance monitor require no network. Only the OpenAI adapter calls an external API — it is opt-in. |
| Do I control all data? | **Yes.** All state lives in your `data/` directory on your own infrastructure. Nothing is transmitted. |
| Is the source auditable? | **Yes.** MIT-licensed, fully open source, no obfuscated code, no telemetry. |
| Does it have an audit trail? | **Yes.** Every permission request, grant, denial, and revocation is appended to `data/audit_log.jsonl` with a UTC timestamp. See [AUDIT_LOG_SCHEMA.md](AUDIT_LOG_SCHEMA.md). |
| Can I plug in my own LLM / provider? | **Yes.** The adapter registry supports 29 adapters: LangChain, AutoGen, CrewAI, LlamaIndex, Semantic Kernel, OpenAI Assistants, Haystack, DSPy, Agno, MCP, OpenClaw, A2A, Codex, MiniMax, NemoClaw, APS, Copilot, LangGraph, Anthropic Computer Use, OpenAI Agents SDK, Vertex AI, Pydantic AI, Browser Agent, Hermes (any OpenAI-compatible endpoint), Orchestrator, RLM (any RLM-compatible HTTP endpoint), and a `CustomAdapter` for anything else. |
| Does it work with our existing agent framework? | **Yes.** It wraps around your framework — you keep what you have and add guardrails on top. |
| Is there a security review? | **Yes.** CodeQL scanning on every push, Dependabot auto-merge, Socket.dev supply chain score A, OpenSSF Scorecard. See [SECURITY.md](SECURITY.md). |
| What does it cost to operate? | **Zero licensing cost.** MIT license. Infrastructure cost = your own compute. |
| Is there a compliance module? | **Yes.** `ComplianceMonitor` enforces configurable violation policies with severity classification and async audit loop. |
| Can I restrict which agents access which resources? | **Yes.** `AuthGuardian` evaluates justification quality + agent trust score + resource risk score before issuing a grant token. |
| Can I isolate environments (dev / staging / prod)? | **Yes.** `EnvironmentManager` enforces a configurable promotion chain (dev → st → sit → qa → preprod → prod) with gate types: auto, confirm, and approval. Config files promote; live state never does. |
| Can agents be blocked from reading outside their sandbox? | **Yes.** `SandboxPolicy.sourceProtection` restricts `FileAccessor.read/write/list` to `data/<env>/` only, throwing `SourceProtectionError` for any out-of-scope path. |

---

## What It Does (One Paragraph)

Network-AI is a TypeScript/Node.js orchestration layer that sits between your agents and your shared state. It enforces: atomic blackboard writes (no race conditions when two agents write simultaneously), permission gating (agents must request access to sensitive resources and provide a scored justification), budget ceilings (per-agent token limits; rogue agents get cut off mid-task), FSM-based workflow governance (agents are blocked from skipping pipeline stages), and real-time compliance monitoring (tool abuse, turn-taking violations, response timeouts). v5.0 adds: approval inbox (web-accessible approval queue), job queue (persistent priority FIFO with crash recovery), transport layer (JSON-RPC 2.0 with HMAC auth), agent VCR (record/replay for testing), comparison runner (side-by-side adapter evaluation), and 9 new adapters. v5.1.4 adds: RLMAdapter (recursive language model / any RLM-compatible HTTP endpoint), FederatedBudget child spending, blackboard metadata API, PhasePipeline compaction, semaphore-based fan-out, HookContext depth, and sub-goal recursion. v5.3.x adds: Context Throttler (prune blackboard keys per-agent scope), Route Classifier (goal routing + FACTUAL_LOOKUP short-circuit), Partition Planner (non-overlapping agent focus areas), Coverage Gate (recursive completeness refinement), advisory token enforcement in the permission system, and context injection validation in the project context manager. v5.4.0 adds: EnvironmentManager (full promotion chain with backup/rollback), LockedBlackboard env routing (NETWORK_AI_ENV), source protection (FileAccessor scope enforcement), Python NETWORK_AI_ENV support across all five scripts, and 29 CLI env subcommands. v5.4.1 adds: TOCTOU race condition fixes in `_touchJson`/`_touchFile` (CWE-367, CodeQL #149–#150) via `openSync(O_CREAT|O_EXCL)`; unused imports and dead function removed (CodeQL #151–#153). v5.4.2 adds: improved MCP tool descriptions across all 22 tools (behavior on error, return shapes, usage guidelines); ClawHub ASI01/ASI03/ASI06/ASI07 Notes documented as by-design mitigated patterns in SECURITY.md. v5.4.3 adds: ClawHub ASI01/03/06/07 Notes security-findings table added to SKILL.md; README documentation table updated with SKILL.md entry and Code of Conduct/Security Policy footer links; UTF-8 BOM stripped from package.json/skill.json/openapi.yaml (fixed CI ts-node parse failure). v5.4.4 adds: fixed missing `import os` in `scripts/swarm_guard.py` (ClawHub ASI08). v5.5.0 adds: SAP Basis-inspired TransportAgent/LandscapeAgent transport tier; AgentPool.setDispatchPause; ENVIRONMENT_PROMOTE AuthGuardian resource profile; 117 new transport tests. v5.5.1 adds: `revoke_token.py` env-scoped path fix — `_resolve_data_dir()` + `--env` CLI arg ensure token revocation and TTL cleanup target the correct `data/<env>/` directory (ClawScan ASI03). v5.5.2 adds: HMAC-SHA256 grant-token integrity — `check_permission.py` signs each grant with `_sig`; `validate_token.py` rejects tampered records; signing key auto-generated at `data/.signing_key` (stdlib only, zero new deps, ClawScan ASI03).

---

## Architecture Summary

```
Your agents
    │
    ▼
┌─────────────────────────────────────────────────────┐
│  Network-AI Orchestration Layer                     │
│                                                     │
│  LockedBlackboard  ──── atomic propose/commit       │
│  AuthGuardian      ──── permission scoring          │
│  FederatedBudget   ──── per-agent token ceilings    │
│  JourneyFSM        ──── FSM state governance        │
│  ComplianceMonitor ──── real-time violation policy  │
│  BlackboardValidator─── content quality gate        │
│  QAOrchestratorAgent── scenario replay & regression │
│  ProjectContextManager─ Layer-3 persistent memory   │
└─────────────────────────────────────────────────────┘
    │
    ▼
data/ (local filesystem — you own it)
  ├── audit_log.jsonl
  ├── active_grants.json
  ├── project-context.json
  └── blackboard state files
```

Full architecture: [ARCHITECTURE.md](ARCHITECTURE.md)

---

## Security & Supply Chain

| Check | Status |
|---|---|
| CodeQL (GitHub Advanced Security) | ✅ All alerts resolved |
| Dependabot | ✅ Auto-merge enabled, dependency graph active |
| Socket.dev supply chain | ✅ No high-severity flags |
| OpenSSF Scorecard | ✅ SHA-pinned CI actions, provenance publishing |
| npm provenance | ✅ Published with `--provenance` since v4.0.0 |
| Secret scanning | ✅ Enabled on repository |
| ClawHub Security Scanner | ✅ 4 Notes acknowledged and mitigated — ASI01 (agent goal hijack, by design: 3-subtask decomposition; SKILL.md usage guidance), ASI03 (advisory token identity, by design: tokens marked advisory; platform auth required), ASI06 (persistent context poisoning, by design: `_validate_context()` injection detection; no secrets in `data/`; clear between projects), ASI07 (inter-agent communication boundary, by design: host platform responsible for messaging; configure platform network settings). Notes recur on every scan by design; documented controls are the mitigation. |
| Vulnerability disclosure | [SECURITY.md](SECURITY.md) — 48h acknowledgment, 7-day response |

---

## Stability & Support Expectations

### Versioning

Network-AI follows [Semantic Versioning](https://semver.org/):
- **Patch** (4.0.x): bug fixes and security patches — safe to auto-update
- **Minor** (4.x.0): additive features, backward-compatible — upgrade at your pace
- **Major** (x.0.0): breaking API changes — migration guide provided in CHANGELOG

### Security Fix Policy

| Version | Policy |
|---|---|
| 5.4.x (current) | Full support — bugs + security fixes |
| 5.1.x | Security fixes only |
| 5.0.x | Security fixes only |
| 4.15.x | Security fixes only |
| 4.0.x – 4.13.x | Security fixes only |
| < 4.0 | No support |

### Response Times (GitHub Issues)

| Severity | Target |
|---|---|
| Security vulnerability (private) | 48h acknowledgment, 7 days remediation |
| Bug with reproduction | Best effort, typically < 7 days |
| Feature request | Triaged on rolling basis |

### Stability Signals

- 3,093 passing assertions across 30 suites
- Deterministic scoring — no random outcomes in permission evaluation or budget enforcement
- CI runs on every push and every PR
- All examples ship with the repo and run without mocking

---

## Integration Entry Points

| Use case | Starting point |
|---|---|
| Wrap existing LangChain agents | [INTEGRATION_GUIDE.md § LangChain](INTEGRATION_GUIDE.md) |
| Add permission gating | `AuthGuardian` in [QUICKSTART.md](QUICKSTART.md) |
| Add budget enforcement | `FederatedBudget` in [QUICKSTART.md](QUICKSTART.md) |
| Add FSM workflow governance | `JourneyFSM` in [ARCHITECTURE.md](ARCHITECTURE.md) |
| MCP server (model context protocol) | `npx network-ai-mcp` — see [QUICKSTART.md](QUICKSTART.md) |
| Inject long-term project context into agents | `context_manager.py inject` — see [QUICKSTART.md § Project Context](QUICKSTART.md) |
| Use with Claude API / Codex (tool-use schema) | [`claude-tools.json`](claude-tools.json) — drop into `tools` array |
| Use as a Custom GPT Action | [`openapi.yaml`](openapi.yaml) — import in GPT editor |
| Use as a Claude Project | [`claude-project-prompt.md`](claude-project-prompt.md) — paste into Custom Instructions |
| Inspect / manage state from terminal | `network-ai bb` CLI — see [QUICKSTART.md § CLI](QUICKSTART.md) |
| Full working example (no API key) | `npx ts-node examples/08-control-plane-stress-demo.ts` |
| Full working example (with API key) | `npx ts-node examples/07-full-showcase.ts` |

---

## Known Adopters

See [ADOPTERS.md](ADOPTERS.md).

---

## License

MIT — [LICENSE](LICENSE). No CLA required for contributions.
