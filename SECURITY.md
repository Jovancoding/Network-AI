# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------||
| 5.14.x  | ✅ Yes — full support (current) |
| 5.13.x  | ✅ Security fixes only |
| 5.12.x  | ✅ Security fixes only |
| 5.11.x  | ✅ Security fixes only |
| 5.10.x  | ✅ Security fixes only |
| 5.9.x   | ✅ Security fixes only |
| 5.8.x   | ✅ Security fixes only |
| 5.7.x   | ✅ Security fixes only |
| 5.6.x   | ✅ Security fixes only |
| 5.5.x   | ✅ Security fixes only |
| 5.4.x   | ✅ Security fixes only |
| 5.3.x   | ✅ Security fixes only |
| 5.2.x   | ✅ Security fixes only |
| 5.1.x   | ✅ Security fixes only |
| 5.0.x   | ✅ Security fixes only |
| 4.15.x  | ✅ Security fixes only |
| 4.14.x  | ✅ Security fixes only |
| 4.13.x  | ✅ Security fixes only |
| 4.12.x  | ✅ Security fixes only |
| 4.9.x   | ✅ Security fixes only |
| 4.8.x   | ✅ Security fixes only |
| 4.7.x   | ✅ Security fixes only |
| 4.6.x   | ✅ Security fixes only |
| 4.5.x   | ✅ Security fixes only |
| 4.4.x   | ✅ Security fixes only |
| 4.3.x   | ✅ Security fixes only |
| 4.0.x – 4.2.x | ⚠️ Security fixes only |
| < 4.0   | ❌ No support |

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please report security issues privately:

1. Go to the [Security Advisories](https://github.com/Jovancoding/Network-AI/security/advisories) page
2. Click **"Report a vulnerability"**
3. Provide a clear description, reproduction steps, and impact assessment

You will receive an acknowledgment within 48 hours and a detailed response within 7 days.

## Disclosure SLA

| Milestone | Target |
|-----------|--------|
| Acknowledgment | 48 hours |
| Triage + severity assessment | 5 business days |
| Patch available (Critical / High) | 14 days from triage |
| Patch available (Medium) | 30 days from triage |
| Patch available (Low) | 90 days from triage |
| Public disclosure (after patch ships) | 7 days (coordinated) |

If a patch cannot be delivered within the target window, we will notify the reporter
with a revised timeline and provide any available workaround.

## Security Measures in Network-AI

Network-AI includes built-in security features:

- **AES-256-GCM encryption** for blackboard data at rest
- **HMAC-SHA256 / Ed25519 signed tokens** via AuthGuardian with trust levels and scope restrictions
- **Rate limiting** to prevent abuse
- **Path traversal protection** in the Python blackboard (regex + resolved-path boundary checks)
- **Input validation** on all public API entry points
- **Secure audit logging** with tamper-resistant event trails
- **Justification hardening** (v3.2.1) -- prompt-injection detection (16 patterns), keyword-stuffing defense, repetition/padding detection, structural coherence validation
- **FSM Behavioral Control Plane** (v3.3.0) -- state-scoped agent and tool authorization via `JourneyFSM` and `ToolAuthorizationMatrix`; unauthorized actions blocked with `ComplianceViolationError`
- **ComplianceMonitor** (v3.3.0) -- real-time agent behavior surveillance with configurable violation policies, severity classification, and async audit loop
- **Named Multi-Blackboard API** (v3.4.0) -- isolated `SharedBlackboard` instances per name with independent namespaces, validation configs, and agent scoping; prevents cross-task data leakage
- **QA Orchestrator Agent** (v4.11.0) -- scenario replay through quality gates, cross-agent contradiction detection, feedback loop with retry limits, and regression tracking with historical snapshots
- **Deferred Adapter Initialization** (v4.12.0) -- adapters are materialized only on first use via `registerDeferred()`, preventing untrusted adapter code from running at startup
- **Adapter Hook Middleware** (v4.12.0) -- `beforeExecute` / `afterExecute` / `onError` lifecycle hooks; enables request-level logging, tracing, and custom security gates without modifying adapters
- **ClaimVerifier — Tier 1 Agent Honesty** (v5.11.0) — `ClaimVerifier` (`lib/claim-verifier.ts`) reconciles agent-declared `ActionManifest[]` against runtime-witnessed `RuntimeAuditEntry` records using outcome-bound HMAC-signed receipts (`ExecutionReceipt`) issued by `AgentRuntime` — never by the agent. `ShellExecutor` and `FileAccessor` emit receipts committing to `{ agentId, action, target, exitCode, outputHash }` co-located with the existing `audit()` call. Tampering with any field (including `exitCode` or `outputHash`) invalidates the signature. `UNSUPPORTED_CLAIM` is emitted when a manifest entry has no valid matching receipt + audit entry; `UNDISCLOSED_ACTION` when an audit entry has no corresponding manifest. Trust decays via `AuthGuardian.recordClaimViolation()` after N consecutive violations (default 3), forcing the agent into `ApprovalGate` supervised execution below trust 0.4. Scope ceiling: catches fabricated actions and outcomes; BYOC adapter network calls are unmediated (Tier 2 concern).
- **ApprovalInbox Read-Route Auth + CORS Hardening** (v5.13.4, GHSA-m4jg-6w3q-gm86, CWE-862, CWE-352, High) — incomplete fix for GHSA-mxjx-28vx-xjjj: the v5.12.2 `secret` / `checkAuth()` gate covered only the two mutating routes (`POST /approve`, `POST /deny`), leaving `GET /`, `GET /stats`, `GET /sse`, and `GET /:id` unauthenticated even when a `secret` was configured — disclosing queued high-risk action content (command strings, file paths, justifications) to any process that could reach the HTTP server. The handler also hardcoded `Access-Control-Allow-Origin: *`, letting any website read those responses cross-origin. **Fixed**: `checkAuth()` now gates the entire `routeRequest()` pipeline (before route dispatch), covering every route uniformly; the wildcard CORS header was removed and replaced with an explicit `allowedOrigins` allowlist option — no `Access-Control-Allow-Origin` header is sent unless the request's `Origin` exactly matches an allowlisted entry, and the matched origin is echoed back (never `*`). Reported by sec-reex.
- **APSAdapter Fail-Closed Signature Verification** (v5.13.4, GHSA-3jf7-33vc-hgf4, CWE-347, High, CVSS 8.6) — with the default `verificationMode: 'local'` and no caller-supplied `verifySignature` callback (the documented canonical `new APSAdapter()` + `initialize({})` setup), `verifyDelegation()` treated any non-empty string as a valid cryptographic signature, allowing a forged delegation (`scope: ['shell:exec']`, arbitrary `signature`) to be registered into `AuthGuardian` and obtain a signed `SHELL_EXEC` permission-grant token with no authentication. **Fixed**: `initialize()` now throws if `verificationMode` is `'local'` (the default) and no `verifySignature` callback is configured; the fallback branch of `verifyDelegation()` now returns `false` instead of a length check, failing closed as defense in depth.
- **Agent Sandbox — Shell-Free Command Execution** (v5.11.0, GHSA-qw6v-5fcf-5666, CWE-78, Critical) — `SandboxPolicy.isCommandAllowed` glob-matched the whole command string while `ShellExecutor` ran it through `/bin/sh -c`, so a scoped allowlist entry like `git *` also matched `git status; id` and executed the injected command. **Fixed**: `ShellExecutor` now runs `spawn(file, args, { shell: false })` with a quote-aware parsed argv (no shell is invoked); `isCommandAllowed()` and the new `tokenizeCommand()` reject any unquoted shell metacharacter (`; & | $ \` ( ) < > { }` newline) or unterminated quote before the allowlist match. Quoted metacharacters are preserved as literal argument data. Reported by lexdotdev.
- **MCP HTTP Authentication — Fail-Closed** (v5.7.2, GHSA-r78r-rwrf-rjwp) — `McpSseServer._isAuthorized()` now returns `false` when no secret is configured (previously returned `true`, granting open access — CWE-306/CWE-862 incomplete fix). `listen()` rejects with a hard error if `McpSseServerOptions.secret` is empty. `McpSseTransport` accepts an optional `secret` parameter and automatically attaches `Authorization: Bearer` headers. All callers must supply a non-empty secret.
- **MCP HTTP Authentication** (v5.1.3) — `McpSseServer` enforces bearer token auth on `POST /mcp` and `GET /sse` when a secret is configured via `McpSseServerOptions.secret` or `NETWORK_AI_MCP_SECRET` env var. Default bind address changed to `127.0.0.1`. `config_set` now rejects writes to non-allowlisted config keys.
- **Flow Control** (v4.12.0) -- `pause()` / `resume()` / `setThrottle()` on the blackboard; prevents write floods and enables coordinated maintenance windows
- **Matcher-Based Hook Filtering** (v4.13.0) -- `HookMatcher` with `agentPattern`, `actionPattern`, `toolPattern` globs, and custom `condition` functions; hooks only fire when all conditions pass, enabling fine-grained security policies per tool or agent pattern
- **Phase Pipeline with Approval Gates** (v4.13.0) -- `PhasePipeline` orchestrates multi-phase workflows; `requiresApproval` boolean halts execution until explicit human approval is granted, enforcing human-in-the-loop for sensitive operations
- **Fail-Closed Approval Timeout** (v5.5.8) -- `PhasePipelineOptions.approvalTimeoutMs` (default 300,000 ms / 5 min) ensures approval gates never block indefinitely; if the `onApproval` callback does not settle within the deadline, the gate automatically denies — `{ approved: false }` — preventing hung pipelines in automated deployments
- **Confidence-Based Filtering** (v4.13.0) -- `ConfidenceFilter` rejects low-confidence agent findings below configurable thresholds and validates rejected results with secondary agents; aggregation strategies (unanimous, majority) enforce consensus before accepting multi-agent results
- **Agent Runtime Sandbox** (v4.14.0) -- `SandboxPolicy` enforces command allowlists/blocklists, path scoping with traversal protection, and risk assessment; `ShellExecutor` sandboxes child processes with timeout/output limits; `FileAccessor` restricts file I/O to scoped base paths
- **Approval Gates** (v4.14.0) -- `ApprovalGate` requires explicit human or callback approval for high-risk operations (writes, shell commands, budget spend); full approval history with audit trail. **WARNING:** `auto_approve: true` must only be used in explicitly isolated CI/dev sandboxes where all commands are known and trusted in advance — never in production, shared, or untrusted environments. Default is `auto_approve: false`.
- **Pipe Mode Authentication** (v4.14.0) -- JSON stdin/stdout protocol for programmatic agent control; commands processed one-at-a-time with structured responses; no shell injection surface
- **Strategy Agent Pool Isolation** (v4.14.0) -- `AgentPool` enforces per-pool capacity ceilings; `WorkloadPartitioner` routes tasks by priority class; adaptive scaling respects budget constraints before spawning agents
- **Goal Decomposer DAG Validation** (v4.15.0) -- `validateDAG()` enforces acyclicity (Kahn's algorithm), rejects self-dependencies and unknown task references; task graphs are validated before execution to prevent infinite loops or orphaned tasks
- **Team Runner Approval Gate** (v4.15.0) -- optional `approvalCallback` on `runTeam()` requires explicit approval of the full task DAG before any agent execution begins; rejection skips all tasks with audit-ready status
- **IAuthValidator Interface** (v5.0.0) -- `IAuthValidator` decouples authorization checks from the concrete `AuthGuardian` class; enables pluggable auth backends and `NoOpAuthValidator` for testing without permission infrastructure
- **Approval Inbox** (v5.0.0) -- `ApprovalInbox` provides a web-accessible approval queue with REST API (`/list`, `/approve/:id`, `/deny/:id`, `/stats`) and SSE streaming for real-time approval notifications; auto-expiry on stale requests
- **Transport Layer HMAC Auth** (v5.0.0) -- `SwarmTransportServer` implements JSON-RPC 2.0 over HTTP with HMAC-SHA256 request signing, per-request TTL enforcement, request size limits, and node allowlisting
- **Job Queue Crash Recovery** (v5.0.0) -- `JobQueue` with `FileJobStore` detects stale in-progress jobs on restart and re-queues them; priority FIFO with exponential backoff retries
- **Agent VCR** (v5.0.0) -- `AgentVCR` records and replays agent execution calls with cassette files; request fingerprinting via SHA-256; prevents accidental LLM calls in CI
- **RLMAdapter BYOC Transport** (v5.1.4) -- `RLMAdapter` delegates all HTTP to a bring-your-own client (`RLMHttpClient`); no built-in network code runs without an explicit client; endpoint validation rejects empty strings before any request is attempted; error paths surface structured `RLM_REQUEST_FAILED` / `AGENT_NOT_FOUND` codes rather than raw stack traces
- **Advisory Token Enforcement** (v5.3.1) -- `check_permission.py` marks all grant tokens `advisory: true`; unknown agent identities receive a reduced trust score of 0.3 and an explicit warning flag; `PAYMENTS` / `DATABASE` resources require `--confirm-high-risk` acknowledgment before a token is issued
- **Context Injection Validation** (v5.3.1) -- `context_manager.py` runs `_validate_context()` before every `inject` / `show` command: schema checks (type enforcement on all fields) plus injection-pattern detection on free-text fields (`goals`, `decisions`, `banned_approaches`) using the same 16-pattern set from justification hardening; warnings printed to stderr before execution proceeds
- **Environment Isolation** (v5.4.0) -- `EnvironmentManager` enforces a promotion chain (dev→st→sit→qa→preprod→prod) with gate types: `auto`, `confirm`, and `approval`; config files promote, live state (`audit_log.jsonl`, `active_grants.json`) never does; auto-backup before each promotion
- **Strict Promotion Chain Enforcement** (v5.5.8) -- `EnvironmentManager` constructor accepts `enforcePromotionChain: true` to require a `.promotion-record.json` in the source environment directory before any promotion proceeds; prevents skipped-stage deployments (e.g., direct dev→prod bypassing sit/qa/preprod); a promotion record is written after every successful promotion regardless of flag state so records accumulate incrementally
- **TTL Background Sweep** (v5.5.9) -- `LockedBlackboard.startSweep(intervalMs)` runs `purgeExpired()` on an unref'd background timer (default 60 s), automatically evicting expired entries from the in-memory cache; `stopSweep()` cancels the timer cleanly; prevents stale secret or session entries from persisting in memory after their TTL has elapsed
- **WAL Crash Recovery** (v5.6.0) -- `LockedBlackboard` Write-Ahead Log records every write before the file mutation and a checkpoint after; on startup `replayWAL()` replays ops with missing checkpoints (uncommitted at crash time), preventing silent data loss after unclean process exit; malformed tail bytes from partial writes are silently dropped
- **LockedBlackboard Mutex Correctness** (v5.8.6) -- five race-condition and data-integrity fixes: (1) stale-lock force-release now uses compare-and-delete (`forceReleaseStale()`) — reads the lock file and only unlinks it if `acquired_at` + `pid` still match, preventing concurrent processes from deleting a freshly-acquired lock; (2) `release()` verifies `holder` + `pid` in the lock file before unlinking, closing the ownership-blind unlink window; (3) snapshots are written via `writeFileSync(tmp)` + `renameSync` so a crash mid-write cannot produce a truncated blackboard after WAL compaction; (4) `loadPendingChanges()` reconciles `validated` pending files against WAL-replayed cache state and immediately archives zombie entries that would otherwise loop as perpetual hash-conflict failures; (5) `cleanupOldPendingChanges()` sorts by priority ASC before age, protecting high-priority approval-gate proposals from eviction
- **Circuit Breaker on AdapterRegistry** (v5.6.1) -- per-adapter `CircuitBreaker` (CLOSED/OPEN/HALF_OPEN) stops forwarding calls to a failing adapter after `failureThreshold` consecutive failures; `CircuitOpenError` is thrown immediately when the circuit is open, preventing thundering-herd load on degraded downstream adapters; automatic recovery via HALF_OPEN probe after `recoveryTimeoutMs`
- **OTel `ITelemetryProvider` BYOT interface** (v5.7.0) -- `createOtelHooks(provider)` wires `beforeExecute` / `afterExecute` / `onError` spans into `AdapterHookManager`; `NullTelemetryProvider` default prevents accidental telemetry exfiltration if no provider is configured; `CapturingTelemetryProvider` enables deterministic testing of telemetry calls without network calls
- **Source Protection** (v5.4.0) -- `SandboxPolicy.sourceProtection` constrains `FileAccessor.read/write/list` to `data/<env>/` only; any out-of-scope access throws `SourceProtectionError` and returns `{success: false}` to the agent without leaking path details

- **Streamable HTTP MCP Transport Fail-Closed** (v5.11.0) — `McpStreamableServer` (`lib/mcp-transport-http.ts`) enforces a non-empty bearer secret before `listen()` will bind; an empty secret causes an immediate `Error: secret is required` rejection, preventing unauthenticated access consistent with the SSE transport policy (GHSA-j3vx-cx2r-pvg8). CORS origin and auth header validation are applied to every `/mcp` and `/health` request.

- **SkillSpector (v5.11.0) — `check_permission.py` two findings resolved**:
  - *Intent-Code Divergence (Low)* — `FILE_EXPORT` was missing from `HIGH_RISK_RESOURCES`; the comment and SKILL.md policy stated it requires `--confirm-high-risk` but the set only contained `PAYMENTS` and `DATABASE`. **Fixed**: `FILE_EXPORT` added to `HIGH_RISK_RESOURCES` so export requests receive the same `--confirm-high-risk` gate as payments/database.
  - *Description-Behavior Mismatch (Medium)* — `ensure_data_dir()` always created the fixed top-level `data/` directory, ignoring `NETWORK_AI_ENV`, breaking environment isolation when env-scoped paths were active. **Fixed**: `ensure_data_dir()` now delegates to `_resolve_data_dir()` so audit log and grant files are always written to the correct env-scoped directory.
- **CodeQL #174 (CWE-377, Medium) — Insecure temporary file path in `AuthGuardian`**: `trustConfigPath` accepted a caller-supplied path (including `os.tmpdir()` from tests) and passed it directly to `writeFile()`. `path.resolve()` in the constructor does not satisfy CodeQL's taint analysis — the taint still flows from `os.tmpdir()` through `resolve()` to `writeFile()`. **Fixed in v5.11.0**: All `join(tmpdir(), ...)` calls in `test-claim-verifier.ts` replaced with `join('.', 'data', ...)` paths, eliminating the taint source entirely. `AuthGuardian` constructor retains `path.resolve()` for defense-in-depth.

## Security Scan Results

- **VirusTotal**: Benign (0/64 engines)
- **OpenClaw Scanner**: Benign, HIGH CONFIDENCE
- **ClawHub Security Scanner** (v5.5.3): 4 by-design findings acknowledged — 2 Medium (ASI03 advisory tokens, ASI06 project context), 2 Low (ASI03 local grant state, ASI06 audit log free text). Severity reduced from High to Medium for the two persistent by-design findings; two new Low findings document the `.signing_key`/`active_grants.json` local state (added in v5.5.2) and the audit log free-text caution. All are documented controls, not vulnerabilities. See SKILL.md Security Scan Findings table for per-finding mitigations.
- **ClawHub Security Scanner** (v5.4.5): 4 Notes acknowledged and mitigated with documented controls — ASI01 (agent goal hijack: Orchestrator skill forces 3-subtask decomposition by design; SKILL.md documents when to enable/disable it), ASI03 (advisory token identity: tokens explicitly marked advisory; separate platform auth and human approval required for sensitive resources), ASI06 (persistent context poisoning: `_validate_context()` runs injection-pattern detection before every inject; `data/project-context.json` must not store secrets; clear `data/` between projects), and ASI07 (inter-agent communication boundary: SKILL.md explicitly states all inter-agent messaging is the host platform's responsibility; users must configure host platform network settings). These Notes reflect by-design characteristics of the skill and will recur on future scans; the documented controls are the mitigation, not an elimination of the pattern.- **ClawHub Security Scanner** (v5.5.1): ASI03 env-scoped path bug — `scripts/revoke_token.py` previously resolved `GRANTS_FILE`/`AUDIT_LOG` at module load time from the root `data/` directory, ignoring `NETWORK_AI_ENV` at runtime. **Fixed in v5.5.1**: `_resolve_data_dir()` added; `--env` CLI argument introduced; paths re-resolved in `main()` before any file I/O. Token revocation and TTL cleanup now target the correct `data/<env>/` path, consistent with `check_permission.py` and `validate_token.py`.- **GHSA-j3vx-cx2r-pvg8** (CWE-346, High, CVSS 7.6) — Unauthenticated Cross-Origin MCP Tool Invocation via Empty Default Secret — **Fixed in v5.4.5**. SSE server now requires a non-empty secret at startup; CORS restricted to localhost origins only. Reported by 232-323 and min8282.
- **CodeQL** (v5.5.3): All 6 alerts resolved — useless-assignment-to-local (#155–#158) in `lib/transport-agent.ts` (dead-store intermediate `status` writes separated from side-effect calls); unused variable `origGet` (#154) in `test-transport.ts` removed; empty-except (#159) in `scripts/check_permission.py` documented with explanatory comment.
- **CodeQL** (v5.4.1): All alerts resolved — CWE-367 TOCTOU (#149, #150) fixed via `O_CREAT|O_EXCL` open; unused imports/function (#151–#153) removed
- **CodeQL**: v4.3.2 clean — A2A bearer tokens transmitted only via `Authorization` header; no URL embedding; streaming paths carry no credential material; `AbortController` guards prevent hanging fetch calls; CLI layer adds no new network surface (fully in-process); CWE-367 TOCTOU alerts #86/#87 resolved — `audit tail` and CLI test now open fd first and use `fs.fstatSync(fd)` instead of `fs.statSync(filename)`
- **CodeQL** (historical): v3.3.0 — all fixable alerts resolved; unused imports cleaned; false-positive detection patterns dismissed; v3.4.0 clean; v3.4.1 — #65–#68 HIGH (insecure temporary file) resolved via `path.resolve()` sanitization and `mode: 0o700` directory permissions
- **Snyk**: All High/Medium findings resolved in v3.0.3

## Disclosure Policy

We follow coordinated disclosure. We will:

1. Confirm the vulnerability and determine its impact
2. Develop and test a fix
3. Release a patched version
4. Credit the reporter (unless anonymity is requested)

We ask that you give us reasonable time to address the issue before any public disclosure.


---

## Security Module

The security module (`security.ts`) provides defense-in-depth protections:

| Component | Class | Purpose |
|---|---|---|
| Token Manager | `SecureTokenManager` | HMAC / Ed25519-signed tokens with expiration |
| Input Sanitizer | `InputSanitizer` | XSS, injection, path traversal prevention |
| Rate Limiter | `RateLimiter` | Per-agent request throttling + lockout |
| Encryptor | `DataEncryptor` | AES-256-GCM encryption for sensitive data |
| Permission Hardener | `PermissionHardener` | Trust-ceiling & privilege escalation prevention |
| Audit Logger | `SecureAuditLogger` | Cryptographically signed audit entries. **Note:** Permission `justification` fields are stored verbatim — never include PII, credentials, or secrets in justification text. |
| Gateway | `SecureSwarmGateway` | Integrated security layer wrapping all ops |

---

## Permission System

The AuthGuardian evaluates permission requests using weighted scoring:

| Factor | Weight | Description |
|---|---|---|
| Justification quality | 40% | Business reason (hardened against prompt injection) |
| Agent trust level | 30% | Agent's established trust score |
| Resource risk | 30% | Resource sensitivity + scope |

Approval threshold: **0.5**

### Resource Types

| Resource | Base Risk | Default Restrictions |
|---|---|---|
| `DATABASE` | 0.5 | `read_only`, `max_records:100` |
| `PAYMENTS` | 0.7 | `read_only`, `no_pii_fields`, `audit_required` |
| `EMAIL` | 0.4 | `rate_limit:10_per_minute` |
| `FILE_EXPORT` | 0.6 | `anonymize_pii`, `local_only` |

### Check Permissions (CLI)

```bash
python scripts/check_permission.py \
  --agent data_analyst \
  --resource DATABASE \
  --justification "Need customer order history for sales report"

# View all active grants
python scripts/check_permission.py --active-grants

# Audit summary
python scripts/check_permission.py --audit-summary --last 50
```

---

## Audit Trail

The `SecureAuditLogger` produces HMAC / Ed25519-signed entries in `data/audit_log.jsonl`.

Logged events: `permission_granted`, `permission_denied`, `permission_revoked`, `ttl_cleanup`, `result_validated`, and all blackboard writes.

Each entry contains: `agentId`, `action`, `timestamp`, `outcome`, `resource`. No PII, no API keys, no message content.

To disable: pass `--no-audit` flag to `network-ai-server`, or set `auditLogPath: undefined` in `createSwarmOrchestrator` config.

Token revocation and TTL cleanup:

```bash
python scripts/revoke_token.py --list-expired
python scripts/revoke_token.py --cleanup
```

The audit log can also be queried and live-streamed via the CLI (no server required):

```bash
network-ai audit log --limit 50   # print recent entries
network-ai audit tail             # live-stream as new events arrive
network-ai audit clear            # reset the log
```
