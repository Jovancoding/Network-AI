# GEMINI.md — Project Instructions for Gemini CLI

This file is read automatically by Gemini CLI when working in this repository
(and when the Network-AI extension is installed).

## What Network-AI Is

Network-AI is a TypeScript/Node.js multi-agent orchestrator — shared state,
guardrails, budgets, and cross-framework coordination. When installed as a
Gemini CLI extension, the Network-AI MCP server loads automatically and exposes
coordination tools (`blackboard_read`, `blackboard_write`, `budget_status`,
`token_create`, `audit_query`, and more) directly inside Gemini CLI.

## Using the MCP Tools

- **Blackboard** — shared state between agents. Always write through
  `blackboard_write` with your `agent_id`; never assume exclusive access.
  Reads via `blackboard_read` / `blackboard_list`.
- **Budgets** — `budget_status` before spending, `budget_spend` to record
  token usage. Respect the federated ceiling.
- **Permissions** — `token_create` issues an HMAC/Ed25519-signed grant for a
  resource; `token_validate` checks one. Request permission before sensitive
  resource access.
- **Audit** — every write, grant, and state transition is logged. Query with
  `audit_query`.

## Build & Test Commands (when working on this repo)

```bash
npm install                   # Install dependencies
npx tsc --noEmit              # Type-check (zero errors expected)
npm run test:all              # Run the full test suite
npm test                      # Core orchestrator tests only
npm run test:adapters         # All framework adapter tests
```

All tests must pass before any commit. No test should be skipped or marked `.only`.

## Project Structure

- `index.ts` — Core engine: SwarmOrchestrator, AuthGuardian, FederatedBudget, QualityGateAgent
- `security.ts` — SecureTokenManager, InputSanitizer, RateLimiter, DataEncryptor, SecureAuditLogger
- `lib/locked-blackboard.ts` — LockedBlackboard with atomic propose → validate → commit
- `lib/auth-guardian.ts` — Weighted permission scoring (justification 40%, trust 30%, risk 30%)
- `lib/a2a-server.ts` — A2AServer: expose the orchestrator as a Google A2A agent (agent card + tasks)
- `adapters/` — 32 framework adapters, including `GeminiAdapter` (Gemini Developer API)
  and `VertexAIAdapter` (Vertex AI / Gemini on GCP)
- `bin/mcp-server.ts` — the MCP server this extension launches (stdio transport)

## Gemini-Specific Integration Points

- **`GeminiAdapter`** (`adapters/gemini-adapter.ts`) — BYOC adapter for the
  Gemini Developer API (`generativelanguage.googleapis.com`). Supports a
  supplied `@google/genai`-compatible client or a built-in fetch path with
  `GEMINI_API_KEY`.
- **`VertexAIAdapter`** (`adapters/vertex-ai-adapter.ts`) — enterprise path via
  Google Cloud Vertex AI (function calling, multi-modal).
- **A2A protocol** — Network-AI speaks Google's Agent2Agent protocol in both
  directions: `A2AAdapter` calls remote A2A agents; `A2AServer` exposes this
  orchestrator as an A2A agent at `/.well-known/agent.json`.

## Code Conventions

- TypeScript strict mode, target ES2022; no `any` types
- JSDoc on all exported functions and classes
- No new runtime dependencies without explicit approval
- Adapters are self-contained (BYOC — bring your own client); no cross-adapter imports
- All coordination goes through the blackboard — never write shared state directly
