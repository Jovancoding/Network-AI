# AuthGuardian - Permission Wall System

Complete documentation for the AuthGuardian permission system that protects sensitive API access.

## Overview

AuthGuardian is the security layer that evaluates all permission requests before allowing access to:
- **DATABASE** - Internal database / data store access
- **PAYMENTS** - Financial/payment data services
- **EMAIL** - Email sending capability
- **FILE_EXPORT** - Exporting data to local files

> **Note**: These are abstract local resource type names. No external API credentials are required — all evaluation is local.

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
| Unknown agents | 0.5 | Default trust level |

**Denial threshold: 0.4** (low-trust agents are denied and escalated to human)

### Factor 3: Risk Assessment (30%)

Base risk scores by resource type:

| Resource | Base Risk | Reason |
|----------|-----------|--------|
| `EMAIL` | 0.4 | Lower sensitivity |
| `DATABASE` | 0.5 | Business data access |
| `FILE_EXPORT` | 0.6 | Data exfiltration risk |
| `PAYMENTS` | 0.7 | Financial data sensitivity |

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
  "granted_at": "2026-02-04T15:25:00Z"
}
```

### Token Lifecycle

1. **Generation**: Created upon approval with UUID-based identifier
2. **Validity**: 5 minutes from generation (configurable)
3. **Validation**: Check before each API call
4. **Revocation**: Can be manually revoked before expiry

### Using Tokens

```bash
# 1. Request permission
result=$(python scripts/check_permission.py --agent data_analyst --resource DATABASE \
  --justification "Need Q4 invoices for report" --json)

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
