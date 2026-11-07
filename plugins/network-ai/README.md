# Network-AI for Claude Code

Gives Claude Code a multi-agent coordination layer over MCP:

- **Shared blackboard** — atomic propose → validate → commit, so concurrent agents cannot overwrite each other's state.
- **Permission gating** — agents request short-lived, HMAC/Ed25519-signed tokens before touching sensitive resources; tokens can be validated or revoked.
- **Federated token budgets** — every agent records its spend against a shared ceiling.
- **Audit log** — an append-only record of every write, grant, and state change.

The MCP server runs **locally** over stdio and keeps its state and audit log on your machine (by default under `./data/` in your working directory). There is no hosted service and no telemetry.

## Commands

| Command | What it does |
|---|---|
| `/network-ai:status` | Blackboard snapshot, budget, and recent audit activity in one report |
| `/network-ai:blackboard [key] [value]` | List keys, read a key, or write a key |
| `/network-ai:budget [agent]` | Ceiling, spend, remaining budget, and top spenders |
| `/network-ai:audit [filter]` | Query the audit log, newest first |

## MCP server

The plugin starts the Network-AI MCP server with an exact, pinned version:

```
npx -y -p network-ai@6.0.1 network-ai-server --stdio
```

Requirements: Node.js 18 or later.

## Example uses

- Coordinate several Claude Code sessions or subagents on one codebase: an agent proposes `task:auth-refactor = in_progress`, the commit is validated atomically, and the others pick different tasks.
- Cap a long multi-agent job: agents record their spend and `/network-ai:budget` shows what is left.
- Gate sensitive actions behind signed, time-limited permission tokens.
- Review a run afterwards with `/network-ai:audit`.

## Links

- Source and documentation: https://github.com/Jovancoding/Network-AI
- Website: https://network-ai.org
- Security policy: https://github.com/Jovancoding/Network-AI/blob/main/SECURITY.md
- Privacy: https://github.com/Jovancoding/Network-AI/blob/main/PRIVACY.md

License: MIT
