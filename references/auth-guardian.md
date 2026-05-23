# AuthGuardian - Permission Wall System

Complete documentation for the AuthGuardian permission system that protects sensitive API access.

## Overview

AuthGuardian is the security layer that evaluates all permission requests before allowing access to:
- **DATABASE** - Internal database / data store access
- **PAYMENTS** - Financial/payment data services
- **EMAIL** - Email sending capability
- **FILE_EXPORT** - Exporting data to local files

> **Note**: These are abstract local resource type names. No external API credentials are required — all evaluation is local.

## IAuthValidator Interface (v5.0)

As of v5.0, the authorization contract is defined by the `IAuthValidator` interface in `lib/auth-validator.ts`. This decouples consumers from the concrete `AuthGuardian` class:

```typescript
import type { IAuthValidator, PermissionRequest, PermissionResult, AgentTrust } from 'network-ai';

interface IAuthValidator {
  checkPermission(request: PermissionRequest): Promise<PermissionResult> | PermissionResult;
  getAgentTrust(agentId: string): AgentTrust | undefined;
  getAgentNamespaces(agentId: string): string[];
}
```

**Implementations:**
- `AuthGuardian` — full weighted scoring (default)
- `NoOpAuthValidator` — always grants, for testing
- Custom implementations for external auth providers (LDAP, OAuth, etc.)

## Evaluation Algorithm

### Weighted Scoring Model

Each permission request is evaluated using three weighted factors:

```
Approval Score = (Justification × 0.4) + (Trust × 0.3) + (1 - Risk × 0.3)
```

**Approval threshold: 0.5** (requests scoring below are denied)

### Factor 1: Justification Quality (40%)

The justification string is scored based on:

| Criterion | Points | Example |
|-----------|--------|---------|
| Length > 20 chars | +0.2 | Minimal detail |
| Length > 50 chars | +0.2 | Good detail |
| Task keywords | +0.2 | "task", "purpose", "need", "require" |
| Specificity keywords | +0.2 | "specific", "quarterly", "report" |
| No test keywords | +0.2 | Avoid "test", "debug", "try" |

**Maximum score: 1.0**

**Denial threshold: 0.3** (requests with poor justification are immediately denied)

### Factor 2: Agent Trust Level (30%)

Pre-configured trust scores for known agents:

| Agent ID | Trust Level | Description |
|----------|-------------|-------------|
| `orchestrator` | 0.9 | Full coordination privileges |
| `risk_assessor` | 0.85 | Risk analysis specialist |
| `data_analyst` | 0.8 | Data processing agent |
| `strategy_advisor` | 0.7 | Business strategy agent |
| Unknown agents | 0.3 | Reduced trust — `unknown_agent: true` warning flag emitted |

**Denial threshold: 0.4** (low-trust agents are denied and escalated to human)

> **Advisory tokens (v5.3.1+):** All grant tokens carry `advisory: true`. The `--agent` identity claim is accepted as-is and is **not** externally authenticated — the host platform is responsible for actual caller authentication. Unknown agents receive trust 0.3 and an `unknown_agent: true` flag.
>
> **Token integrity (v5.5.2):** Grant payloads are now HMAC-SHA256 signed. `check_permission.py` stores `_sig` in every new grant; `validate_token.py` verifies it before returning `valid: true`. A tampered `active_grants.json` record is rejected with `"Token signature invalid"`. The signing key lives at `data[/<env>]/.signing_key` (32 bytes, auto-generated, chmod 0o600). Pre-v5.5.2 tokens (no `_sig`) remain backward-compatible and return `"sig_verified": false`.

### Factor 3: Risk Assessment (30%)

Base risk scores by resource type:

| Resource | Base Risk | Reason |
|----------|-----------|--------|
| `EMAIL` | 0.4 | Lower sensitivity |
| `DATABASE` | 0.5 | Business data access — requires `--confirm-high-risk` |
| `FILE_EXPORT` | 0.6 | Data exfiltration risk |
| `PAYMENTS` | 0.7 | Financial data sensitivity — requires `--confirm-high-risk` |

**Risk modifiers:**
- Broad scope ("*", "all", empty) → +0.2
- Write operations (write/delete/update/modify) → +0.2

**Denial threshold: 0.8** (high-risk requests are denied)

## Grant Tokens

### Token Structure

```json
{
  "token": "grant_a1b2c3d4e5f6...",
  "agent_id": "data_analyst",
  "resource_type": "DATABASE",
  "scope": "read:invoices",
  "expires_at": "2026-02-04T15:30:00Z",
  "restrictions": ["read_only", "max_records:100"],
  "granted_at": "2026-02-04T15:25:00Z",
  "advisory": true,
  "unknown_agent": false,
  "_sig": "<hmac-sha256-hex>"  ← payload integrity signature (v5.5.2+)
}
```

### Token Lifecycle

1. **Generation**: Created upon approval with UUID-based identifier
2. **Signing** (v5.5.2+): HMAC-SHA256 signature computed over `token|agent_id|resource_type|scope|expires_at|granted_at` and stored as `_sig`
3. **Validity**: 5 minutes from generation (configurable)
4. **Validation**: `validate_token.py` verifies `_sig` then checks expiry before each API call; returns `sig_verified: true/false`
5. **Revocation**: Can be manually revoked before expiry (`revoke_token.py [--env <env>]`)

### Using Tokens

```bash
# 1. Request permission (high-risk resources require --confirm-high-risk)
result=$(python scripts/check_permission.py --agent data_analyst --resource DATABASE \
  --justification "Need Q4 invoices for report" --confirm-high-risk --json)

# 2. Extract token
token=$(echo $result | jq -r '.token')

# 3. Validate before use
python scripts/validate_token.py $token

# 4. Use token in API call (include in headers/context)

# 5. Revoke when done (optional)
python scripts/revoke_token.py $token
```

## Restrictions by Resource

### DATABASE
- `read_only` - No write operations
- `max_records:100` - Limit result set size

### PAYMENTS
- `read_only` - No write operations
- `no_pii_fields` - Exclude personally identifiable information
- `audit_required` - All access logged

### EMAIL
- `rate_limit:10_per_minute` - Request throttling

### FILE_EXPORT
- `anonymize_pii` - Must anonymize personal data
- `local_only` - No external transmission

## Audit Logging

All permission requests are logged to `data/audit_log.jsonl`:

```json
{"timestamp": "2026-02-04T10:25:00Z", "action": "permission_request", "details": {...}}
{"timestamp": "2026-02-04T10:25:00Z", "action": "permission_granted", "details": {...}}
{"timestamp": "2026-02-04T10:30:00Z", "action": "permission_revoked", "details": {...}}
```

### Audit Actions

| Action | Description |
|--------|-------------|
| `permission_request` | Initial request received |
| `permission_granted` | Request approved |
| `permission_denied` | Request rejected (reason included) |
| `permission_revoked` | Token manually revoked |
| `token_expired` | Token reached TTL |

## Configuration

### Modifying Trust Levels

Edit `scripts/check_permission.py`:

```python
DEFAULT_TRUST_LEVELS = {
    "orchestrator": 0.9,
    "data_analyst": 0.8,
    "my_new_agent": 0.75,  # Add new agents
}
```

### Adjusting Token TTL

```python
GRANT_TOKEN_TTL_MINUTES = 5  # Change to desired duration
```

### Adding Resource Types

```python
BASE_RISKS = {
    "NEW_RESOURCE": 0.6,  # Add with appropriate risk level
}

RESTRICTIONS = {
    "NEW_RESOURCE": ["restriction1", "restriction2"],
}
```

## Error Handling

### Common Denial Reasons

| Reason | Solution |
|--------|----------|
| "Justification is insufficient" | Provide more specific task context |
| "Agent trust level is below threshold" | Use higher-trust agent or escalate |
| "Risk assessment exceeds threshold" | Narrow the requested scope |
| "Combined evaluation score below threshold" | Improve justification + narrow scope |

### Escalation Path

When permission is denied:
1. Review denial reason
2. Modify request (justification/scope)
3. If still denied, escalate to human operator
4. Human can manually create grant in `data/active_grants.json`

## Diagnostic API — `scoreRequest()` (v5.8.0)

`AuthGuardian.scoreRequest()` is a **read-only** method that returns the full scoring breakdown for a hypothetical request, without issuing a token or writing to the audit log. Use it for pre-flight checks, dashboards, and the `--why` CLI flag.

### Signature

```typescript
scoreRequest(
  agentId: string,
  resourceType: string,
  justification: string,
  scope?: string
): {
  justificationScore: number;   // 0.0–1.0, weight 40 %
  trustScore: number;           // 0.0–1.0, weight 30 %
  riskScore: number;            // 0.0–1.0 raw risk (lower is safer), weight 30 %
  weightedScore: number;        // combined approval score (threshold 0.5)
  approved: boolean;            // true if weightedScore ≥ 0.5 and no hard deny
  reason?: string;              // populated when approved === false
}
```

### Usage

```typescript
import { AuthGuardian } from 'network-ai';

const guardian = new AuthGuardian();

const result = guardian.scoreRequest(
  'data_analyst',
  'DATABASE',
  'Fetch Q4 invoices for year-end report',
  'read:invoices'
);

console.log(result);
// {
//   justificationScore: 0.8,
//   trustScore:         1.0,
//   riskScore:          0.5,
//   weightedScore:      0.74,
//   approved:           true
// }
```

### Differences from `requestPermission()`

| Aspect | `requestPermission()` | `scoreRequest()` |
|---|---|---|
| Issues token | ✅ Yes | ❌ No |
| Writes audit log | ✅ Yes | ❌ No |
| Side effects | ✅ Yes | ❌ None |
| Returns token | ✅ Yes | ❌ No |
| Returns score breakdown | ❌ No | ✅ Yes |
| Intended use | Production gating | Diagnostics / `--why` |

### CLI equivalent

```bash
network-ai auth token my-bot --resource DATABASE \
  --justification "Fetch Q4 invoices for year-end report" --why
# justification score (40%): 80.0%
# trust score        (30%): 100.0%
# risk score         (30%): 50.0% risk → 50.0% contribution
# weighted score:           74.0%
# verdict:                  APPROVED
```

## CLI Usage

The `auth` command group exposes AuthGuardian directly from the terminal — no server required.

```bash
# Issue a permission token
network-ai auth token <agentId> --resource <TYPE> --action <read|write> \
  --justification "Reason for access"

# Example: data analyst requesting database read
network-ai auth token data_analyst \
  --resource DATABASE --action read \
  --justification "Need Q4 invoices for revenue report"

# Validate a token before use
network-ai auth check grant_a1b2c3d4e5f6...

# Revoke a token (e.g., after the task completes)
network-ai auth revoke grant_a1b2c3d4e5f6...
```

All commands support `--json` for machine-readable output:

```bash
network-ai --json auth token data_analyst --resource DATABASE --action read \
  --justification "Need Q4 invoices for revenue report"
# → { "grantToken": "grant_...", "agentId": "...", "resource": "DATABASE", ... }
```

Trust level is a numeric value (`0`–`4`) mapped internally to the 0.5–0.9 scoring range — configure agent trust in `scripts/check_permission.py`.

---

## APS Integration (v4.10.0)

The `APSAdapter` bridges **APS (Agent Permission Service) delegation chains** into AuthGuardian trust levels. When an agent presents an APS delegation token, the adapter:

1. Verifies the delegation signature (locally, via MCP, or BYOC verifier)
2. Computes a depth-decayed trust level: `baseTrust × (1 - (currentDepth / maxDepth × depthDecay))`
3. Maps APS scopes to AuthGuardian resource types (`file:read` → `FILE_SYSTEM`, `shell:exec` → `SHELL_EXEC`, etc.)
4. Returns an `AgentTrustConfig` ready for `registerAgentTrust()`

```typescript
import { APSAdapter } from 'network-ai';

const aps = new APSAdapter();
await aps.initialize({ baseTrust: 0.8, depthDecay: 0.4 });

const trust = await aps.apsDelegationToTrust({
  delegator: 'root', delegatee: 'agent-1',
  scope: ['file:read', 'git:read'],
  currentDepth: 0, maxDepth: 3,
  signature: 'valid-sig',
});
// trust.trustLevel === 0.8 (root = full base trust)
// trust.allowedResources === ['FILE_SYSTEM', 'GIT']
```

See [references/adapter-system.md § APS Adapter](adapter-system.md#aps-adapter--delegation-chain-trust-bridge) for full usage.
