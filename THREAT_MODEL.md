# Network-AI Threat Model

Version: 5.8.3 — updated with each release that changes a trust boundary or auth mechanism.

---

## 1. Overview

Network-AI is an in-process multi-agent orchestrator. There is no SaaS or cloud-hosted service — the operator installs it and runs it inside their own infrastructure. The package includes an optional MCP SSE server (`bin/mcp-server.ts`) that, when explicitly started by the operator, binds a TCP port and becomes a network-reachable service boundary. This document describes the adversaries we design against, the trust boundaries we enforce, and the explicit non-goals that bound the threat model.

---

## 2. Assets

| Asset | Sensitivity | Description |
|-------|-------------|-------------|
| Blackboard state | High | Shared agent memory; controls agent behaviour |
| Audit log | High | Tamper-evident event record; forensics + compliance |
| Permission tokens | High | Grant-tokens authorise resource access |
| HMAC signing key | Critical | Signs every grant token; compromise = token forgery |
| Agent trust registry | Medium | Trust levels that gate permission scoring |
| Environment configs | Medium | Per-env data directories and promotion chain |
| Budget state | Low | Token/cost accounting; denial-of-service vector |

---

## 3. Adversaries

### 3.1 Unauthenticated Network Caller (primary MCP threat)

**Who**: Any process that can reach the TCP port where `McpSseServer` is bound —
including SSRF on the same host, containers on a shared network, or remote clients when
the operator binds to a non-loopback address.

**Goal**: Invoke MCP tools (`config_set`, `agent_spawn`, `blackboard_write`,
`token_create`, etc.) without credentials.

**Mitigations**:
- `McpSseServer` requires a non-empty `secret`; `listen()` hard-rejects on empty secret (v5.7.2, GHSA-r78r-rwrf-rjwp).
- `_isAuthorized()` fails closed: empty secret → deny (v5.7.2).
- Default bind address is `127.0.0.1`; explicit warning if binding to a non-loopback address.
- All tool invocations are logged to `data/audit_log.jsonl`.

### 3.2 Malicious / Compromised Agent

**Who**: A registered agent that has been compromised or is acting outside its intended role.

**Goal**: Write arbitrary data to the blackboard, escalate its trust level, forge tokens,
or hijack another agent's goal.

**Mitigations**:
- All writes go through `propose → validate → commit`; validators reject schema violations.
- `AuthGuardian` scores each request (justification 40 %, trust 30 %, risk 30 %); low-trust agents are denied high-risk operations.
- Justification hardening rejects prompt-injection patterns, keyword stuffing, repetition, and structural incoherence.
- Agent trust levels are stored in `data/trust_levels.json`; modifications are audit-logged.
- `ComplianceMonitor` detects behavioural anomalies in real time.

### 3.3 Blackboard Poisoning / Context Injection

**Who**: Any caller that can write to the blackboard and wants to influence subsequent agent reads.

**Goal**: Plant malicious instructions that a downstream agent will execute as if they were trusted system data.

**Mitigations**:
- `BlackboardValidator` enforces JSON Schema on all values.
- `InputSanitizer` strips prompt-injection payloads from string values.
- `_validate_context()` in Python scripts detects injection patterns before use.
- SKILL.md warns operators: never store secrets in `data/`; clear `data/` between untrusted projects.

### 3.4 Supply Chain Attacker

**Who**: A dependency author, registry hijacker, or CI pipeline attacker.

**Goal**: Introduce malicious code into network-ai or its dependencies that executes in the operator's environment.

**Mitigations**:
- npm provenance attestation on every release (SLSA Build Level 2).
- Signed commits and version tags.
- Dependabot PRs for dependency updates with CodeQL re-scan on each PR.
- Minimal runtime dependency surface (see `SUPPLY_CHAIN.md`).
- No network calls in core library code (BYOC — bring your own client).

### 3.5 Insider / CLI Operator

**Who**: A developer or CI job with local filesystem access.

**Goal**: Bypass the blackboard's `propose → validate → commit` cycle, forge audit entries, or exfiltrate the signing key.

**Mitigations**:
- Audit log is append-only (no delete API); clearing requires explicit `--yes` flag and is itself logged.
- HMAC signing key is stored at `data/.signing_key`; filesystem permissions are the operator's responsibility.
- All CLI mutations are logged to the audit trail.
- Rate limiting prevents bulk-write abuse from CLI loops.

---

## 4. Trust Boundaries

```
┌─────────────────────────────────────────────────────────────┐
│  Operator environment (filesystem, env vars, CLI)           │
│                                                             │
│  ┌──────────────────────────────────────────────┐           │
│  │  Network-AI process                          │           │
│  │                                              │           │
│  │  Agent code ──► AuthGuardian ──► Blackboard  │           │
│  │       │              │               │       │           │
│  │       │         propose/validate/    │       │           │
│  │       │         commit cycle         │       │           │
│  │       │                              │       │           │
│  │  MCP SSE ──[bearer token]──► McpSseServer    │           │
│  │  (TCP)                                       │           │
│  └──────────────────────────────────────────────┘           │
│                                                             │
│  External callers ──[auth boundary]──► MCP SSE port        │
└─────────────────────────────────────────────────────────────┘
```

**Boundary 1 — MCP network interface**: Bearer token enforced by `McpSseServer`. Empty
secret is a hard startup error. All calls are logged.

**Boundary 2 — Agent → Blackboard**: Mediated by `AuthGuardian`; weighted scoring gate.
Agents cannot write directly to `data/`; they must go through `LockedBlackboard`.

**Boundary 3 — Filesystem**: `data/` directory. The operator owns permissions on this
directory. Network-AI applies path traversal protections (resolved-path boundary checks)
but does not manage OS-level permissions.

**Boundary 4 — Python scripts**: Scripts in `scripts/` run as a child process or
standalone. They validate `NETWORK_AI_ENV` routing and apply HMAC signing to grant
tokens. The signing key lives at `data[/<env>]/.signing_key`.

---

## 5. Explicit Non-Goals

The following are **outside the threat model** — we do not design against them, and
operators must address them at the infrastructure layer:

| Non-goal | Rationale |
|----------|-----------|
| Protection against root/OS-level access | If the attacker owns the process or OS, all file-based protections are void. |
| Encryption of blackboard data in transit between processes on the same host | IPC on localhost is assumed trusted. |
| Protection against a malicious Node.js require() hook | Pre-loaded modules run before any of our code. |
| SLA guarantees for operator-hosted deployments | Network-AI is a library; the operator's SLA is their own. |
| Anti-analysis / obfuscation | Open source; security through obscurity is not a goal. |
| Protection against a compromised npm registry without provenance verification | Operators must verify provenance (`npm audit signatures`). |
| Confidentiality of blackboard values from the process owner | Values are stored as plaintext JSON on the local filesystem. |

---

## 6. Security Controls Summary

| Control | Where | Addresses |
|---------|-------|-----------|
| Fail-closed MCP auth | `lib/mcp-transport-sse.ts` | Adversary 3.1 |
| `propose → validate → commit` | `lib/locked-blackboard.ts` | Adversary 3.2 |
| AuthGuardian weighted scoring | `lib/auth-guardian.ts` | Adversary 3.2 |
| Justification hardening | `lib/auth-guardian.ts` | Adversary 3.2, 3.3 |
| BlackboardValidator schema | `lib/blackboard-validator.ts` | Adversary 3.3 |
| InputSanitizer | `security.ts` | Adversary 3.3 |
| HMAC-signed grant tokens | `scripts/check_permission.py` | Adversary 3.2 |
| npm provenance / SLSA | CI pipeline | Adversary 3.4 |
| Append-only audit log | `security.ts` | Adversary 3.5 |
| ComplianceMonitor | `lib/compliance-monitor.ts` | Adversary 3.2 |
| Rate limiting | `security.ts` | All |
| Path traversal protection | `scripts/blackboard.py` | Adversary 3.5 |

---

## 7. Out-of-scope Findings

Findings in the following categories will be acknowledged but closed as by-design:

- **ASI01** — Agent goal hijack via LLM decomposition: the 3-subtask decomposition boundary is intentional; SKILL.md documents when to enable/disable.
- **ASI03** — Advisory token identity: tokens are explicitly marked advisory; separate platform authentication is required.
- **ASI06** — Persistent context poisoning: `_validate_context()` injection detection is the mitigation; operators must clear `data/` between untrusted projects.
- **ASI07** — Inter-agent communication boundary: all inter-agent messaging is the host platform's responsibility.

---

*For active vulnerabilities, see [SECURITY.md](SECURITY.md) and the [Security Advisories](https://github.com/Jovancoding/Network-AI/security/advisories) page.*
