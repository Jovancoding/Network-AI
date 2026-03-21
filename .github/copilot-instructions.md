# GitHub Copilot Instructions for Network-AI

## Project Overview

Network-AI is a TypeScript/Node.js multi-agent orchestrator — shared state, guardrails, budgets, and cross-framework coordination (v4.10.0). 1,617 tests across 20 suites.

## Architecture

- **Blackboard pattern**: All coordination via `LockedBlackboard` — `propose()` → `validate()` → `commit()` with filesystem mutex. Never write to shared state directly.
- **Permission gating**: `AuthGuardian` uses weighted scoring (justification 40%, trust 30%, risk 30%). Require permission before sensitive resource access.
- **Adapter system**: All 17 adapters extend `BaseAdapter`. Each is dependency-free (BYOC — bring your own client). No cross-adapter imports.
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
- `adapters/` — 17 framework adapters (LangChain, AutoGen, CrewAI, MCP, Codex, MiniMax, NemoClaw, APS, etc.)

## Build & Test

```bash
npx tsc --noEmit              # Type-check (zero errors expected)
npm run test:all              # All 1,582 tests across 20 suites
npm test                      # Core orchestrator tests
npm run test:adapters         # All 17 adapters
```

All tests must pass before any commit. No test should be skipped or marked `.only`.

## Security

- AES-256-GCM encryption at rest
- HMAC-SHA256 / Ed25519 signed tokens with TTL
- No hardcoded secrets, keys, or credentials
- Path traversal and injection protections on all file operations
- Rate limiting on public-facing endpoints
