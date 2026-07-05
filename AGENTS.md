# AGENTS.md

Instructions for AI coding agents (OpenAI Codex, Gemini CLI, Cursor, Factory,
and any other AGENTS.md-compatible tool) working in this repository.
Claude Code users: see [CLAUDE.md](CLAUDE.md) (same content, Claude-specific extras).

## Project Overview

Network-AI is a TypeScript/Node.js multi-agent orchestrator — shared state,
guardrails, budgets, and cross-framework coordination. It ships as an npm
package (`network-ai`), an MCP server, a CLI, a Claude Code plugin, a Gemini
CLI extension, and an OpenClaw skill.

## Build & Test Commands

```bash
npm install                   # Install dependencies
npx tsc --noEmit              # Type-check (zero errors expected)
npm run test:all              # Run the full test suite (all suites)
npm test                      # Core orchestrator tests only
npm run test:security         # Security module tests
npm run test:adapters         # All framework adapter tests
npm run test:cli              # CLI layer tests
```

**All tests must pass before any commit. No test may be skipped or marked `.only`.**

## Project Structure

- `index.ts` — Core engine: SwarmOrchestrator, AuthGuardian, FederatedBudget, QualityGateAgent, all exports
- `security.ts` — SecureTokenManager, InputSanitizer, RateLimiter, DataEncryptor, SecureAuditLogger
- `lib/locked-blackboard.ts` — LockedBlackboard: atomic propose → validate → commit with file-system mutex
- `lib/auth-guardian.ts` — AuthGuardian: weighted permission scoring (justification 40%, trust 30%, risk 30%)
- `lib/claude-hooks.ts` — ClaudeHookBridge: AuthGuardian-backed permission gating for coding-agent tool calls
- `lib/mcp-elicitation.ts` — MCP elicitation channel: native in-client approval prompts
- `lib/a2a-server.ts` — A2AServer: expose the orchestrator as a Google A2A agent
- `adapters/` — 32 framework adapters (LangChain, AutoGen, CrewAI, MCP, Gemini, OpenAI Responses, Claude Agent SDK, etc.)
- `bin/cli.ts` — CLI entry point (`npx network-ai`)
- `bin/mcp-server.ts` — MCP server (stdio + SSE transports)
- `types/` — TypeScript declaration files
- `data/` — Runtime data (gitignored): audit log, pending changes

## Key Architecture Patterns

- **Blackboard pattern** — all agent coordination goes through `LockedBlackboard`
  (`propose()` → `validate()` → `commit()`). Never write shared state directly.
- **Permission gating** — `AuthGuardian.requestPermission()` before sensitive
  resource access. Grants are signed (HMAC-SHA256 / Ed25519) with TTL.
- **Adapter system** — all adapters extend `BaseAdapter` and are dependency-free
  (BYOC — bring your own client). No cross-adapter imports.
- **Audit trail** — every write, grant, and state transition is logged to
  `data/audit_log.jsonl`.

## Code Conventions

- TypeScript strict mode, target ES2022
- No `any` types — use proper generics or `unknown`
- JSDoc on all exported functions and classes
- No new runtime dependencies without explicit approval
- Input validation on all public API entry points
- Keep adapter files self-contained — no cross-adapter imports

## Security Requirements

- AES-256-GCM encryption for data at rest
- HMAC-SHA256 / Ed25519 signed tokens with TTL
- No hardcoded secrets, keys, or credentials anywhere
- Path traversal and injection protections on all file operations
- Rate limiting on public-facing endpoints

## MCP Server

The repo exposes its tool suite over MCP (stdio and SSE):

```bash
npx network-ai-server --stdio        # stdio (Claude Code, Codex, Gemini CLI, Cursor)
npx network-ai-server --port 3001    # SSE/HTTP
```

Tools: `blackboard_read`, `blackboard_write`, `blackboard_list`, `budget_status`,
`budget_spend`, `token_create`, `token_validate`, `audit_query`, `agent_list`,
`agent_spawn`, `fsm_transition`, and more.

## Releasing

See `RELEASING.md`. Version files: `package.json`, `skill.json`, `openapi.yaml`,
README badge, `CHANGELOG.md`, plugin manifests (`.claude-plugin/`,
`gemini-extension.json`, `server.json`).
