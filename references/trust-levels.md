# Agent Trust Levels

Documentation for the trust level system used by AuthGuardian.

## Overview

Trust levels are numerical scores (0.0 to 1.0) that represent how much the system trusts a particular agent to access sensitive resources. Higher trust = more likely to be granted permission.

## Default Trust Levels

| Agent ID | Trust Level | Role Description |
|----------|-------------|------------------|
| `orchestrator` | 0.9 | Primary coordinator with full privileges |
| `risk_assessor` | 0.85 | Specialized in compliance and risk analysis |
| `data_analyst` | 0.8 | Data processing and analytics specialist |
| `strategy_advisor` | 0.7 | Business strategy recommendations |
| Unknown agents | 0.5 | Default for unregistered agents |

## Trust Level Bands

| Range | Category | Typical Capabilities |
|-------|----------|---------------------|
| 0.9 - 1.0 | **Full Trust** | Access all resources, minimal restrictions |
| 0.7 - 0.89 | **High Trust** | Access most resources with standard restrictions |
| 0.5 - 0.69 | **Medium Trust** | Limited access, stricter restrictions |
| 0.4 - 0.49 | **Low Trust** | Requires strong justification |
| < 0.4 | **Untrusted** | Automatically denied, escalate to human |

## How Trust Affects Approval

Trust contributes 30% to the final approval score:

```
Weighted Score = (Justification × 0.4) + (Trust × 0.3) + ((1 - Risk) × 0.3)
```

### Examples

**High-trust agent (0.9) with good justification (0.8) accessing low-risk resource (0.4):**
```
Score = (0.8 × 0.4) + (0.9 × 0.3) + (0.6 × 0.3)
     = 0.32 + 0.27 + 0.18
     = 0.77 ✅ APPROVED
```

**Low-trust agent (0.5) with weak justification (0.4) accessing high-risk resource (0.7):**
```
Score = (0.4 × 0.4) + (0.5 × 0.3) + (0.3 × 0.3)
     = 0.16 + 0.15 + 0.09
     = 0.40 ❌ DENIED
```

## Agent Roles and Responsibilities

### orchestrator (0.9)

The primary coordination agent responsible for:
- Task decomposition and delegation
- Multi-agent workflow orchestration
- Cross-session communication
- Permission request on behalf of other agents

**Why high trust:** Needs broad access to coordinate all operations effectively.

### risk_assessor (0.85)

Specialized agent for:
- Compliance verification
- Risk analysis and reporting
- Security assessment
- Audit preparation

**Why high trust:** Must access sensitive data to perform compliance checks.

### data_analyst (0.8)

Data-focused agent for:
- Data extraction and processing
- Statistical analysis
- Report generation
- Query optimization

**Why medium-high trust:** Needs data access but operations are typically read-only.

### strategy_advisor (0.7)

Business intelligence agent for:
- Strategic recommendations
- Market analysis
- Trend identification
- Executive summaries

**Why medium trust:** Works primarily with aggregated data, less need for raw access.

## Establishing Trust for New Agents

### Option 1: Pre-register in Configuration

Edit `scripts/check_permission.py`:

```python
DEFAULT_TRUST_LEVELS = {
    "orchestrator": 0.9,
    "data_analyst": 0.8,
    "my_new_agent": 0.75,  # Add your agent here
}
```

### Option 2: Gradual Trust Building

1. Start at default trust (0.5)
2. Track successful operations in audit log
3. Manually increase trust based on track record
4. Consider automated trust adjustment (future feature)

### Option 3: Inherited Trust

For sub-agents spawned by trusted orchestrators:
- Inherit parent's trust level (minus penalty)
- Example: orchestrator (0.9) spawns sub-agent → 0.9 - 0.1 = 0.8

## Trust Denial Threshold

Agents with trust below **0.4** are automatically denied with message:
> "Agent trust level is below threshold. Escalate to human operator."

This prevents:
- Unknown agents from accessing sensitive resources
- Compromised or misconfigured agents from causing damage
- Accidental exposure through unvalidated agent IDs

## Security Considerations

### Trust is Not Authentication

Trust levels assume the agent ID is already verified. Trust does NOT:
- Authenticate the agent's identity
- Prevent agent ID spoofing
- Replace proper access control

### Principle of Least Privilege

Even high-trust agents should:
- Request minimal necessary scope
- Provide clear justification
- Follow restriction guidelines
- Have tokens expire appropriately

### Trust Decay (Recommended Practice)

Consider implementing trust decay for agents that:
- Haven't been active recently
- Have had failed requests
- Are operating outside normal hours

## Monitoring and Adjustment

### Signs to Increase Trust

- Consistent successful operations
- Appropriate justifications
- No security incidents
- Positive audit reviews

### Signs to Decrease Trust

- Frequent permission denials
- Vague or suspicious justifications
- Operations outside expected scope
- Security alerts or anomalies

### Trust Audit Checklist

- [ ] Review all agents with trust > 0.8 quarterly
- [ ] Verify agent responsibilities match trust level
- [ ] Check audit logs for unusual patterns
- [ ] Remove trust for decommissioned agents
- [ ] Document trust level changes

## CLI and Trust Levels

When issuing tokens via the CLI, trust level is resolved automatically from the agent ID:

```bash
# data_analyst has trust 0.8 — passes for DATABASE read
network-ai auth token data_analyst \
  --resource DATABASE --action read \
  --justification "Need Q4 invoices for revenue report"

# unknown_bot resolves to default trust 0.5 — may pass or fail depending on resource
network-ai auth token unknown_bot \
  --resource EMAIL --action read \
  --justification "Send weekly summary digest"
```

Trust levels are numeric integers (`1`–`4`) in the CLI implementation, which map to the 0.5–0.9 scoring band. Configure agent trust in `scripts/check_permission.py` under `DEFAULT_TRUST_LEVELS`.

## APS Delegation-Chain Trust (v5.0)

The `APSAdapter` introduced delegation-chain trust mapping: when Agent A delegates work to Agent B, the trust chain is preserved and attenuated. This integrates with AuthGuardian so that delegated agents inherit a bounded trust level.

### How It Works

1. Parent agent has trust `T_parent`
2. Each delegation hop applies a configurable attenuation factor (default 0.9)
3. Delegated agent trust: `T_delegated = T_parent × attenuation ^ depth`
4. AuthGuardian evaluates permission requests using the attenuated trust

### Example

```
orchestrator (0.9) → analyst (depth 1) → sub-agent (depth 2)

analyst trust  = 0.9 × 0.9^1 = 0.81
sub-agent trust = 0.9 × 0.9^2 = 0.729
```

### Configuration

```typescript
import { APSAdapter } from 'network-ai';

const aps = new APSAdapter({
  client: apsClient,
  trustAttenuation: 0.9,  // per-hop multiplier
  maxDelegationDepth: 5,   // cap chain length
});
```

### IAuthValidator and Trust (v5.0)

The `IAuthValidator` interface exposes `getAgentTrust(agentId)`, which returns the effective trust level for any agent — including APS-delegated agents whose trust was computed from the delegation chain. See [auth-guardian.md](auth-guardian.md) for the full interface.
