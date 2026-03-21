# CODEX.md — Project Instructions for OpenAI Codex

This file is read automatically by OpenAI Codex CLI when working in this repository.

## Project Overview

Network-AI is a TypeScript/Node.js multi-agent orchestrator — shared state, guardrails, budgets, and cross-framework coordination. Version 4.10.0.

## Build & Test Commands

```bash
npm install                   # Install dependencies
npx tsc --noEmit              # Type-check (zero errors expected)
npm run test:all              # Run all 1,617 tests across 20 suites
npm test                      # Core orchestrator tests only
npm run test:security         # Security module tests
npm run test:adapters         # All 17 adapter tests
npm run test:priority         # Priority & preemption tests
npm run test:cli              # CLI layer tests
```

All tests must pass before any commit. No test should be skipped or marked `.only`.

## Project Structure

- `index.ts` — Core engine: SwarmOrchestrator, AuthGuardian, FederatedBudget, QualityGateAgent, all exports
- `security.ts` — Security module: SecureTokenManager, InputSanitizer, RateLimiter, DataEncryptor, SecureAuditLogger
- `lib/locked-blackboard.ts` — LockedBlackboard with atomic propose → validate → commit and file-system mutex
- `lib/fsm-journey.ts` — JourneyFSM behavioral control plane
- `lib/compliance-monitor.ts` — Real-time agent behavior surveillance
- `adapters/` — 17 framework adapters (LangChain, AutoGen, CrewAI, MCP, Codex, MiniMax, NemoClaw, APS, etc.)
- `bin/cli.ts` — CLI entry point (`npx network-ai`)
- `bin/mcp-server.ts` — MCP server (SSE + stdio transport)
- `scripts/` — Python helper scripts (blackboard, permissions, token management)
- `types/` — TypeScript declaration files
- `data/` — Runtime data (gitignored): audit log, pending changes

## Key Architecture Patterns

- **Blackboard pattern**: All agent coordination goes through `LockedBlackboard` — `propose()` → `validate()` → `commit()` with file-system mutex. Never write directly.
- **Permission gating**: `AuthGuardian` uses weighted scoring (justification 40%, trust 30%, risk 30%). Always require permission before sensitive resource access.
- **Adapter system**: All adapters extend `BaseAdapter`. Each is dependency-free (BYOC — bring your own client). Do not add runtime dependencies to adapters.
- **Audit trail**: Every write, permission grant, and state transition is logged to `data/audit_log.jsonl` via `SecureAuditLogger`.

## Code Conventions

- TypeScript strict mode, target ES2022
- No `any` types — use proper generics or `unknown`
- JSDoc on all exported functions and classes
- No new runtime dependencies without explicit approval
- Input validation required on all public API entry points
- Keep adapter files self-contained — no cross-adapter imports

## Security Requirements

- AES-256-GCM encryption for data at rest
- HMAC-SHA256 / Ed25519 signed tokens with TTL
- No hardcoded secrets, keys, or credentials anywhere
- Path traversal and injection protections on all file operations
- Rate limiting on all public-facing endpoints

## Common Workflows

**Adding a new adapter:**
1. Create `adapters/<name>-adapter.ts` extending `BaseAdapter`
2. Implement `executeAgent()`, `getCapabilities()`, lifecycle methods
3. Register in `adapters/adapter-registry.ts` and `adapters/index.ts`
4. Add tests in `test-adapters.ts`
5. Update README adapter table

**Bumping a version:**
See `RELEASING.md` for the full checklist. Key files: `package.json`, `skill.json`, `openapi.yaml`, `README.md` badge, `CHANGELOG.md`, `SECURITY.md`, `.github/SECURITY.md`.
