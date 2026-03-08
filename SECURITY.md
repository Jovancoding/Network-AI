# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 4.3.x   | ✅ Yes — full support (current) |
| 4.2.x   | ✅ Security fixes only |
| 4.1.x   | ✅ Security fixes only |
| 4.0.x   | ✅ Security fixes only |
| 3.5.x – 3.9.x | ⚠️ Security fixes only |
| < 3.5   | ❌ No support |

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please report security issues privately:

1. Go to the [Security Advisories](https://github.com/jovanSAPFIONEER/Network-AI/security/advisories) page
2. Click **"Report a vulnerability"**
3. Provide a clear description, reproduction steps, and impact assessment

You will receive an acknowledgment within 48 hours and a detailed response within 7 days.

## Security Measures in Network-AI

Network-AI includes built-in security features:

- **AES-256-GCM encryption** for blackboard data at rest
- **HMAC-SHA256 signed tokens** via AuthGuardian with trust levels and scope restrictions
- **Rate limiting** to prevent abuse
- **Path traversal protection** in the Python blackboard (regex + resolved-path boundary checks)
- **Input validation** on all 20+ public API entry points
- **Secure audit logging** with tamper-resistant event trails
- **Justification hardening** (v3.2.1) -- prompt-injection detection (16 patterns), keyword-stuffing defense, repetition/padding detection, structural coherence validation
- **FSM Behavioral Control Plane** (v3.3.0) -- state-scoped agent and tool authorization via `JourneyFSM` and `ToolAuthorizationMatrix`; unauthorized actions blocked with `ComplianceViolationError`
- **ComplianceMonitor** (v3.3.0) -- real-time agent behavior surveillance with configurable violation policies, severity classification, and async audit loop
- **Named Multi-Blackboard API** (v3.4.0) -- isolated `SharedBlackboard` instances per name with independent namespaces, validation configs, and agent scoping; prevents cross-task data leakage

## Security Scan Results

- **VirusTotal**: Benign (0/64 engines)
- **OpenClaw Scanner**: Benign, HIGH CONFIDENCE
- **CodeQL**: v4.3.2 clean — A2A bearer tokens transmitted only via `Authorization` header; no URL embedding; streaming paths carry no credential material; `AbortController` guards prevent hanging fetch calls; CLI layer adds no new network surface (fully in-process)
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
| Token Manager | `SecureTokenManager` | HMAC-signed tokens with expiration |
| Input Sanitizer | `InputSanitizer` | XSS, injection, path traversal prevention |
| Rate Limiter | `RateLimiter` | Per-agent request throttling + lockout |
| Encryptor | `DataEncryptor` | AES-256-GCM encryption for sensitive data |
| Permission Hardener | `PermissionHardener` | Trust-ceiling & privilege escalation prevention |
| Audit Logger | `SecureAuditLogger` | Cryptographically signed audit entries |
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

The `SecureAuditLogger` produces HMAC-signed entries in `data/audit_log.jsonl`.

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
