# GitHub Copilot Instructions for Network-AI

## Project Overview

Network-AI is a TypeScript/Node.js multi-agent orchestrator — shared state, guardrails, budgets, and cross-framework coordination (v5.8.7). 3,148 tests across 31 suites.

## Architecture

- **Blackboard pattern**: All coordination via `LockedBlackboard` — `propose()` → `validate()` → `commit()` with filesystem mutex. Never write to shared state directly.
- **Permission gating**: `AuthGuardian` uses weighted scoring (justification 40%, trust 30%, risk 30%). Require permission before sensitive resource access.
- **Adapter system**: All 29 adapters extend `BaseAdapter`. Each is dependency-free (BYOC — bring your own client). No cross-adapter imports.
- **Audit trail**: Every write, permission grant, and state transition is logged to `data/audit_log.jsonl` via `SecureAuditLogger`.

## Code Conventions

- TypeScript strict mode, target ES2022
- No `any` types — use proper generics or `unknown`
- JSDoc on all exported functions and classes
- No new runtime dependencies without explicit approval
- Input validation required on all public API entry points
- Keep adapter files self-contained — no cross-adapter imports

## Key Files

- `index.ts` — Core engine: SwarmOrchestrator, AuthGuardian, FederatedBudget, QualityGateAgent
- `security.ts` — SecureTokenManager, InputSanitizer, RateLimiter, DataEncryptor, SecureAuditLogger
- `lib/locked-blackboard.ts` — LockedBlackboard with atomic propose → validate → commit
- `lib/fsm-journey.ts` — JourneyFSM behavioral control plane
- `lib/compliance-monitor.ts` — Real-time agent behavior surveillance
- `lib/adapter-hooks.ts` — AdapterHookManager lifecycle hooks + matcher-based filtering
- `lib/skill-composer.ts` — SkillComposer meta-operations (chain/batch/loop/verify)
- `lib/semantic-search.ts` — SemanticMemory BYOE vector store
- `lib/phase-pipeline.ts` — PhasePipeline multi-phase workflows with approval gates
- `lib/confidence-filter.ts` — ConfidenceFilter multi-agent result scoring and filtering
- `lib/fan-out.ts` — FanOutFanIn parallel agent spawning with pluggable aggregation
- `lib/agent-runtime.ts` — AgentRuntime sandboxed execution with SandboxPolicy, ShellExecutor, FileAccessor, ApprovalGate, SourceProtectionError
- `lib/env-manager.ts` — EnvironmentManager: promotion chain dev→st→sit→qa→preprod→prod, backup/restore, env diff, NETWORK_AI_ENV routing
- `lib/console-ui.ts` — ConsoleUI interactive terminal dashboard
- `lib/strategy-agent.ts` — StrategyAgent meta-orchestrator with AgentPool, WorkloadPartitioner, adaptive scaling
- `lib/goal-decomposer.ts` — GoalDecomposer, TeamRunner, runTeam: LLM-powered goal → task DAG → parallel execution
- `lib/circuit-breaker.ts` — CircuitBreaker CLOSED/OPEN/HALF_OPEN state machine; CircuitOpenError; wired into AdapterRegistry per-adapter with fallbackChain
- `lib/telemetry-provider.ts` — ITelemetryProvider BYOT interface; NullTelemetryProvider, CapturingTelemetryProvider; createOtelHooks() factory for AdapterHookManager
- `adapters/` — 29 framework adapters (LangChain, AutoGen, CrewAI, MCP, Codex, MiniMax, NemoClaw, APS, Hermes, Orchestrator, etc.)

## Build & Test

```bash
npx tsc --noEmit              # Type-check (zero errors expected)
npm run test:all              # All 3,148 tests across 31 suites
npm test                      # Core orchestrator tests
npm run test:adapters         # All 29 adapters
```

All tests must pass before any commit. No test should be skipped or marked `.only`.

## Security

- AES-256-GCM encryption at rest
- HMAC-SHA256 / Ed25519 signed tokens with TTL
- No hardcoded secrets, keys, or credentials
- Path traversal and injection protections on all file operations
- Rate limiting on public-facing endpoints
