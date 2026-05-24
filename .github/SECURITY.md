# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 5.8.x   | ✅ Yes — full support (current, latest: 5.8.4) |
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

## Security Measures in Network-AI

Network-AI includes built-in security features:

- **AES-256-GCM encryption** for blackboard data at rest
- **HMAC-SHA256 / Ed25519 signed tokens** via AuthGuardian with trust levels and scope restrictions
- **Rate limiting** to prevent abuse
- **Path traversal protection** in the Python blackboard (regex + resolved-path boundary checks)
- **Input validation** on all 20+ public API entry points
- **Secure audit logging** with tamper-resistant event trails
- **Justification hardening** (v3.2.1) -- prompt-injection detection (16 patterns), keyword-stuffing defense, repetition/padding detection, structural coherence validation
- **FSM Behavioral Control Plane** (v3.3.0) -- state-scoped agent and tool authorization via `JourneyFSM` and `ToolAuthorizationMatrix`; unauthorized actions blocked with `ComplianceViolationError`
- **ComplianceMonitor** (v3.3.0) -- real-time agent behavior surveillance with configurable violation policies, severity classification, and async audit loop
- **Named Multi-Blackboard API** (v3.4.0) -- isolated `SharedBlackboard` instances per name with independent namespaces, validation configs, and agent scoping; prevents cross-task data leakage
- **QA Orchestrator Agent** (v4.11.0) -- scenario replay through quality gates, cross-agent contradiction detection, feedback loop with retry limits, and regression tracking with historical snapshots
- **Deferred Adapter Initialization** (v4.12.0) -- adapters are materialized only on first use via `registerDeferred()`, preventing untrusted adapter code from running at startup
- **Adapter Hook Middleware** (v4.12.0) -- `beforeExecute` / `afterExecute` / `onError` lifecycle hooks; enables request-level logging, tracing, and custom security gates without modifying adapters
- **Flow Control** (v4.12.0) -- `pause()` / `resume()` / `setThrottle()` on the blackboard; prevents write floods and enables coordinated maintenance windows
- **Matcher-Based Hook Filtering** (v4.13.0) -- `HookMatcher` with `agentPattern`, `actionPattern`, `toolPattern` globs, and custom `condition` functions; hooks only fire when all conditions pass, enabling fine-grained security policies per tool or agent pattern
- **Phase Pipeline with Approval Gates** (v4.13.0) -- `PhasePipeline` orchestrates multi-phase workflows; `requiresApproval` boolean halts execution until explicit human approval is granted, enforcing human-in-the-loop for sensitive operations
- **Fail-Closed Approval Timeout** (v5.5.8) -- `PhasePipelineOptions.approvalTimeoutMs` (default 300,000 ms / 5 min) ensures approval gates never block indefinitely; if the `onApproval` callback does not settle within the deadline, the gate automatically denies — preventing hung pipelines in automated deployments
- **Confidence-Based Filtering** (v4.13.0) -- `ConfidenceFilter` rejects low-confidence agent findings below configurable thresholds and validates rejected results with secondary agents; aggregation strategies (unanimous, majority) enforce consensus before accepting multi-agent results
- **Agent Runtime Sandbox** (v4.14.0) -- `SandboxPolicy` enforces command allowlists/blocklists, path scoping with traversal protection, and risk assessment; `ShellExecutor` sandboxes child processes with timeout/output limits; `FileAccessor` restricts file I/O to scoped base paths
- **Approval Gates** (v4.14.0) -- `ApprovalGate` requires explicit human or callback approval for high-risk operations (writes, shell commands, budget spend); full approval history with audit trail. **WARNING:** `auto_approve: true` must only be used in explicitly isolated CI/dev sandboxes where all commands are known and trusted in advance — never in production, shared, or untrusted environments. Default is `auto_approve: false`.
- **Pipe Mode Authentication** (v4.14.0) -- JSON stdin/stdout protocol for programmatic agent control; commands processed one-at-a-time with structured responses; no shell injection surface
- **Strategy Agent Pool Isolation** (v4.14.0) -- `AgentPool` enforces per-pool capacity ceilings; `WorkloadPartitioner` routes tasks by priority class; adaptive scaling respects budget constraints before spawning agents
- **Goal Decomposer DAG Validation** (v4.15.0) -- `validateDAG()` enforces acyclicity (Kahn's algorithm), rejects self-dependencies and unknown task references; task graphs are validated before execution to prevent infinite loops or orphaned tasks
- **Team Runner Approval Gate** (v4.15.0) -- optional `approvalCallback` on `runTeam()` requires explicit approval of the full task DAG before any agent execution begins; rejection skips all tasks with audit-ready status
- **Advisory Token Enforcement** (v5.3.1) -- `check_permission.py` marks all grant tokens `advisory: true`; unknown agent identities receive a reduced trust score of 0.3 and an explicit warning flag; `PAYMENTS` / `DATABASE` resources require `--confirm-high-risk` acknowledgment
- **Context Injection Validation** (v5.3.1) -- `context_manager.py` runs `_validate_context()` before every `inject` / `show` command: schema checks plus injection-pattern detection on free-text fields; warnings printed to stderr
- **Environment Isolation** (v5.4.0) -- `EnvironmentManager` enforces a promotion chain (dev→st→sit→qa→preprod→prod) with gate types: `auto`, `confirm`, and `approval`; config files promote, live state never does; auto-backup before each promotion
- **Strict Promotion Chain Enforcement** (v5.5.8) -- `EnvironmentManager` constructor accepts `enforcePromotionChain: true` to require a `.promotion-record.json` in the source environment before any promotion proceeds; prevents skipped-stage deployments; records accumulate incrementally after every successful promotion
- **TTL Background Sweep** (v5.5.9) -- `LockedBlackboard.startSweep(intervalMs)` evicts expired entries via an unref'd background timer (default 60 s); `stopSweep()` cancels cleanly; prevents stale entries from persisting in memory after their TTL has elapsed
- **WAL Crash Recovery** (v5.6.0) -- `LockedBlackboard` Write-Ahead Log records every write before file mutation; `replayWAL()` on startup recovers uncommitted ops after unclean process exit; malformed tail bytes silently dropped
- **Circuit Breaker on AdapterRegistry** (v5.6.1) -- per-adapter `CircuitBreaker` (CLOSED/OPEN/HALF_OPEN) stops calls to failing adapters after `failureThreshold` failures; `fallbackChain` provides automatic failover; `CircuitOpenError` prevents thundering-herd load on degraded adapters
- **OTel `ITelemetryProvider` BYOT interface** (v5.7.0) -- `createOtelHooks(provider)` wires adapter lifecycle events as spans; `NullTelemetryProvider` default prevents accidental telemetry exfiltration; `CapturingTelemetryProvider` for deterministic CI testing without network calls
- **Source Protection** (v5.4.0) -- `SandboxPolicy.sourceProtection` constrains `FileAccessor.read/write/list` to `data/<env>/` only; any out-of-scope access throws `SourceProtectionError` and returns `{success: false}` to the agent

## Security Scan Results

- **VirusTotal**: Benign (0/64 engines)
- **OpenClaw Scanner**: Benign, HIGH CONFIDENCE
- **GHSA-j3vx-cx2r-pvg8** (CWE-346, High, CVSS 7.6) — Unauthenticated Cross-Origin MCP Tool Invocation via Empty Default Secret — **Fixed in v5.4.5**. SSE server now requires a non-empty secret at startup; CORS restricted to localhost origins only. Reported by 232-323 and min8282.
- **ClawHub Security Scanner** (v5.4.5): 4 Notes acknowledged and mitigated — ASI01 (agent goal hijack, by design: Orchestrator skill decomposes into 3 sub-tasks; SKILL.md documents when to enable/disable), ASI03 (advisory token identity, by design: tokens explicitly marked advisory, separate platform auth required), ASI06 (persistent context poisoning, by design: `_validate_context()` injection detection, SKILL.md warns against storing secrets, clear `data/` between projects), ASI07 (inter-agent communication boundary, by design: all inter-agent messaging is host platform's responsibility, documented in SKILL.md). These Notes reflect inherent design characteristics and will recur on future scans; the documented controls are the mitigation.- **ClawHub Security Scanner** (v5.5.2): ASI03 grant-token integrity — `check_permission.py` now HMAC-SHA256 signs each grant (`_sig` field); `validate_token.py` verifies before accepting. Signing key auto-generated at `data[/<env>]/.signing_key`. Zero new deps (stdlib `hmac`+`hashlib`). **Fixed in v5.5.2**.- **CodeQL**: v4.3.2 clean — A2A bearer tokens transmitted only via `Authorization` header; no URL embedding; streaming paths carry no credential material; `AbortController` guards prevent hanging fetch calls; CLI layer adds no new network surface (fully in-process); CWE-367 TOCTOU alerts #86/#87 resolved — `audit tail` and CLI test now open fd first and use `fs.fstatSync(fd)` instead of `fs.statSync(filename)`
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
