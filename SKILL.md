---
name: network-ai
description: "Local Python orchestration skill: multi-agent workflows via shared blackboard file, permission gating, token budget scripts, and persistent project context. All bundled Python scripts run locally with zero network calls. The full npm package (npm install network-ai) additionally ships a TypeScript library, CLI, and an optional operator-started MCP SSE server that binds a TCP port."
metadata:
  openclaw:
    emoji: "\U0001F41D"
    homepage: https://network-ai.org
    capabilities:
      filesystem: "read/write — project root `swarm-blackboard.md` (blackboard state), `data/pending_changes/<id>.json` (WAL entries), `data/audit_log.jsonl`, `data/active_grants.json`, `data/.signing_key`, `data/project-context.json`, `data/task_tracking.json`, `data/agent_health.json`, `data/budget_tracking.json`. All paths are local; nothing is transmitted over the network. When NETWORK_AI_ENV is set, data paths are rooted at `data/<env>/` instead of `data/`. The `--path` argument in blackboard.py is validated against the project root at runtime — paths outside the project directory are rejected (CWE-22)."
      env_vars: "read — NETWORK_AI_ENV (environment routing), NETWORK_AI_MCP_SECRET (MCP bearer auth), NETWORK_AI_MINIMAL (minimal-mode flag). No env vars are written."
      shell_exec: "optional — AgentRuntime (lib/agent-runtime.ts) with SandboxPolicy and ApprovalGate; disabled by default. Never auto-enabled by this skill. auto_approve must NOT be set in production (see auto_approve_warning below)."
      tcp_port: "optional — MCP SSE server (bin/mcp-server.ts) binds 127.0.0.1 only when explicitly started by the operator. Requires a non-empty bearer-token secret. Never auto-started by this skill or any bundled Python script."
    bundle_scope:
      clawhub_python_scripts: "Python stdlib only — scripts/*.py (blackboard.py, check_permission.py, context_manager.py, swarm_guard.py, validate_token.py, revoke_token.py). Zero network calls, zero subprocesses, zero third-party packages. This is the scope scanned by SkillSpector."
      npm_full_package: "The npm package (npm install network-ai) adds: TypeScript library modules, CLI (bin/cli.ts), and optional MCP SSE server (bin/mcp-server.ts). The MCP SSE server exposes a TCP port and is NOT activated by installing or importing the package — it must be explicitly started by the operator."
    network_calls:
      python_scripts: none
      typescript_library: "none — BYOC (bring your own client); zero outbound calls from library code; all LLM/API clients are injected by the caller"
      mcp_sse_server: "optional — binds 127.0.0.1:<port> when explicitly started by the operator; all connections require a bearer-token secret (NETWORK_AI_MCP_SECRET); never auto-started"
    inter_agent_comms: "none — this skill does not implement, invoke, or control inter-agent messaging or sessions_send. All coordination is via local file-based blackboard only."
    sessions_send: "NOT implemented or invoked by this skill. sessions_send is a host-platform built-in entirely outside this skill's control. See data-flow notice below."
    sessions_ops: "platform-provided — outside this skill's control"
    requires:
      bins:
        - python3
      optional_bins: []
    env: {}
    privacy:
      audit_log:
        path: data/audit_log.jsonl
        scope: local-only
        description: "Local append-only JSONL file recording operation metadata. No data leaves the machine."
        pii_warning: "Justification strings are truncated to 200 characters before being written to the audit log. Audit summary output (--audit-summary --json) omits justification text from returned entries. Do not include PII, credentials, or secrets in justification fields — the truncated text still persists on disk. Grant tokens are masked to a short prefix in all listing outputs; full tokens appear only at issuance time."
      data_directory:
        path: data/
        scope: local-only
        files: ["audit_log.jsonl", "active_grants.json", ".signing_key", "project-context.json", "task_tracking.json", "agent_health.json", "budget_tracking.json", "pending_changes/<id>.json"]
        description: "All persistent state is local-only. No files are transmitted over the network."
      blackboard_file:
        path: swarm-blackboard.md
        scope: local-only
        description: "Shared coordination state written by scripts/blackboard.py (project root). Contains task results, grant tokens, status flags, and TTL-scoped cache entries. Access should be restricted to the local user running the swarm."
      auto_approve_warning: "ApprovalGate.auto_approve (lib/agent-runtime.ts) must NOT be enabled in production or untrusted environments. It is only appropriate in explicitly isolated CI/dev sandboxes where all commands executed by the runtime are known and trusted in advance."
---

# Swarm Orchestrator Skill

> **Scope:** The bundled Python scripts (`scripts/*.py`) make **no network calls**, use only the Python standard library, and have **zero third-party dependencies**. Tokens are UUID-based (`grant_{uuid4().hex}`) stored in `data/active_grants.json`. Audit logging is plain JSONL (`data/audit_log.jsonl`).

> **Advisory tokens notice:** Grant tokens issued by `check_permission.py` are **advisory scoring outputs only** — the caller-supplied `--agent` identity is not cryptographically verified. Downstream systems must not treat these tokens as authenticated credentials without adding a separate identity-verification step or human approval gate, especially for PAYMENTS, DATABASE, and FILE_EXPORT resources.

> **Data-flow notice (host platform — not this skill):** This skill does NOT implement, invoke, or control `sessions_send` or any inter-agent messaging. All bundled Python scripts are local-only tools (budget guard, blackboard, permission scorer, context manager). If your platform has a `sessions_send` built-in, whether and how it is used is entirely the **host platform’s** responsibility and is outside this skill’s scope. If you need to prevent external network calls, disable or reroute delegation in your **platform settings** before installing this skill.

> **Context file integrity:** The `context_manager.py inject` command now validates `data/project-context.json` for injection patterns and oversized fields before printing the context block. Review any warnings printed to stderr before passing the output to an agent system prompt.

> **PII / sensitive-data warning:** The `justification` field in permission requests and the audit log (`data/audit_log.jsonl`) store free-text strings provided by agents. **Do not include PII, secrets, or credentials in justification text.** Consider restricting file permissions on `data/` or running this skill in an isolated workspace.

## Setup

**No pip install required.** All 6 scripts use Python standard library only — zero third-party packages.

> **Note on `requirements.txt`:** The file exists for documentation purposes only — it lists the stdlib modules used and has **no required packages**. All listed deps are commented out as optional. You do not need to run `pip install -r requirements.txt`.

```bash
# Prerequisite: python3 (any version ≥ 3.8)
python3 --version

# That's it. Run any script directly:
python3 scripts/blackboard.py list
python3 scripts/swarm_guard.py budget-init --task-id "task_001" --budget 10000

# Optional: for cross-platform file locking on Windows production hosts
pip install filelock  # only needed if you see locking issues on Windows
```

The `data/` directory is created automatically on first run. No configuration files, environment variables, or credentials are required.

> **Multi-environment support (v5.4.0):** All five Python scripts now read the `NETWORK_AI_ENV` environment variable at startup and accept a `--env <name>` CLI argument. When set, all data paths are routed to `data/<env>/` instead of the root `data/` directory. Use this to isolate dev, staging, and production state.
>
> ```bash
> # Run against the dev environment
> NETWORK_AI_ENV=dev python3 scripts/blackboard.py list
> python3 scripts/check_permission.py --active-grants --env dev
> ```

Multi-agent coordination system for complex workflows requiring task delegation, parallel execution, and permission-controlled access to sensitive APIs.

## 🎯 Orchestrator System Instructions

**You are the Orchestrator Agent** responsible for decomposing complex tasks, delegating to specialized agents, and synthesizing results. Follow this protocol:

### Core Responsibilities

1. **DECOMPOSE** complex prompts into 3 specialized sub-tasks
2. **DELEGATE** using the budget-aware handoff protocol
3. **VERIFY** results on the blackboard before committing
4. **SYNTHESIZE** final output only after all validations pass

### Task Decomposition Protocol

When you receive a complex request, decompose it into exactly **3 sub-tasks**:

```
┌─────────────────────────────────────────────────────────────────┐
│                     COMPLEX USER REQUEST                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│  SUB-TASK 1   │   │  SUB-TASK 2   │   │  SUB-TASK 3   │
│ data_analyst  │   │ risk_assessor │   │strategy_advisor│
│    (DATA)     │   │   (VERIFY)    │   │  (RECOMMEND)  │
└───────────────┘   └───────────────┘   └───────────────┘
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              ▼
                    ┌───────────────┐
                    │  SYNTHESIZE   │
                    │ orchestrator  │
                    └───────────────┘
```

**Decomposition Template:**
```
TASK DECOMPOSITION for: "{user_request}"

Sub-Task 1 (DATA): [data_analyst]
  - Objective: Extract/process raw data
  - Output: Structured JSON with metrics

Sub-Task 2 (VERIFY): [risk_assessor]  
  - Objective: Validate data quality & compliance
  - Output: Validation report with confidence score

Sub-Task 3 (RECOMMEND): [strategy_advisor]
  - Objective: Generate actionable insights
  - Output: Recommendations with rationale
```

### Budget Check Protocol

**Run the budget interceptor before any task delegation:**

```bash
# Run this before delegating to any sub-agent
python {baseDir}/scripts/swarm_guard.py intercept-handoff \
  --task-id "task_001" \
  --from orchestrator \
  --to data_analyst \
  --message "Analyze Q4 revenue data"
```

**Decision Logic:**
```
IF result.allowed == true:
    → Budget check passed — proceed with the delegated task
    → Note tokens_spent and remaining_budget
ELSE:
    → STOP — budget exceeded or handoff limit reached
    → Report blocked reason to user
    → Consider: reduce scope or abort task
```

### Pre-Commit Verification Workflow

Before returning final results to the user:

```bash
# Step 1: Check all sub-task results on blackboard
python {baseDir}/scripts/blackboard.py read "task:001:data_analyst"
python {baseDir}/scripts/blackboard.py read "task:001:risk_assessor"
python {baseDir}/scripts/blackboard.py read "task:001:strategy_advisor"

# Step 2: Validate each result
python {baseDir}/scripts/swarm_guard.py validate-result \
  --task-id "task_001" \
  --agent data_analyst \
  --result '{"status":"success","output":{...},"confidence":0.85}'

# Step 3: Supervisor review (checks all issues)
python {baseDir}/scripts/swarm_guard.py supervisor-review --task-id "task_001"

# Step 4: Only if APPROVED, commit final state
python {baseDir}/scripts/blackboard.py write "task:001:final" \
  '{"status":"SUCCESS","output":{...}}'
```

**Verdict Handling:**
| Verdict | Action |
|---------|--------|
| `APPROVED` | Commit and return results to user |
| `WARNING` | Review issues, fix if possible, then commit |
| `BLOCKED` | Do NOT return results. Report failure. |

---

## The 3-Layer Memory Model

Every agent in the swarm operates with three memory layers, each with a different scope and lifetime:

| Layer | Name | Lifetime | Managed by |
|-------|------|----------|------------|
| **1** | Agent context | Ephemeral — current task only | Platform (per-session) |
| **2** | Blackboard | TTL-scoped — shared across agents | `scripts/blackboard.py` |
| **3** | Project context | Persistent — survives all sessions | `scripts/context_manager.py` |

### Layer 1 — Agent Context
Each agent's own context window: the current task instructions, conversation history, and immediate working memory. Managed automatically by the OpenClaw/LLM platform. Nothing to configure.

### Layer 2 — Blackboard (Shared Coordination State)
A shared markdown file (`swarm-blackboard.md`) for real-time cross-agent coordination: task results, grant tokens, status flags, and TTL-scoped cache entries. Agents read and write via `scripts/blackboard.py`. Entries expire automatically.

### Layer 3 — Project Context (Persistent Long-Term Memory)
A JSON file (`data/project-context.json`) that holds information every agent should know, regardless of what session or task is running:
- **Goals** — long-term objectives of the project
- **Tech stack** — languages, frameworks, infrastructure
- **Milestones** — completed, in-progress, and planned work
- **Architecture decisions** — design choices and their rationales
- **Banned approaches** — approaches that have been ruled out

#### Initialising Project Context

```bash
python {baseDir}/scripts/context_manager.py init \
  --name "MyProject" \
  --description "Multi-agent workflow automation" \
  --version "1.0.0"
```

#### Injecting Context into an Agent System Prompt

```bash
python {baseDir}/scripts/context_manager.py inject
```

Copy the output block to the top of your agent's system prompt. Every agent that receives this block shares the same long-term project awareness.

#### Recording a Decision

```bash
python {baseDir}/scripts/context_manager.py update \
  --section decisions \
  --add '{"decision": "Use atomic blackboard commits", "rationale": "Prevent race conditions in parallel agents"}'
```

#### Updating Milestones

```bash
# Mark a milestone complete
python {baseDir}/scripts/context_manager.py update \
  --section milestones --complete "Ship v2.0"

# Add a planned milestone
python {baseDir}/scripts/context_manager.py update \
  --section milestones --add '{"planned": "Integrate vector memory"}'
```

#### Setting the Tech Stack

```bash
python {baseDir}/scripts/context_manager.py update \
  --section stack \
  --set '{"language": "Python", "runtime": "Python 3.11", "framework": "SwarmOrchestrator"}'
```

#### Banning an Approach

```bash
python {baseDir}/scripts/context_manager.py update \
  --section banned \
  --add "Direct database writes from agent scripts (use permission gating)"
```

---

## When to Use This Skill

- **Task Delegation**: Route work to specialized agents (data_analyst, strategy_advisor, risk_assessor)
- **Parallel Execution**: Run multiple agents simultaneously and synthesize results
- **Permission Wall**: Gate access to DATABASE, PAYMENTS, EMAIL, or FILE_EXPORT operations (abstract local resource types — no external credentials required)
- **Shared Blackboard**: Coordinate agent state via persistent markdown file

## Quick Start

### 1. Initialize Budget (FIRST!)

**Always initialize a budget before any multi-agent task:**

```bash
python {baseDir}/scripts/swarm_guard.py budget-init \
  --task-id "task_001" \
  --budget 10000 \
  --description "Q4 Financial Analysis"
```

### 2. Check Budget Before Task Delegation


Always run the budget guard before delegating any task:

```bash
# 1. Check budget (this skill's Python script)
python {baseDir}/scripts/swarm_guard.py intercept-handoff \
  --task-id "task_001" --from orchestrator --to data_analyst \
  --message "Analyze Q4 revenue data"

# 2. If result.allowed == true, proceed with delegation via your platform's built-in tools.
# If result.allowed == false, stop — budget exceeded or handoff limit reached.
```

### 3. Check Permission Before API Access

Before accessing SAP or Financial APIs, evaluate the request:

```bash
# Run the permission checker script
python {baseDir}/scripts/check_permission.py \
  --agent "data_analyst" \
  --resource "DATABASE" \
  --justification "Need Q4 invoice data for quarterly report" \
  --scope "read:invoices"
```

The script will output a grant token if approved, or denial reason if rejected.

### 4. Use the Shared Blackboard

Read/write coordination state:

```bash
# Write to blackboard
python {baseDir}/scripts/blackboard.py write "task:q4_analysis" '{"status": "in_progress", "agent": "data_analyst"}'

# Read from blackboard  
python {baseDir}/scripts/blackboard.py read "task:q4_analysis"

# List all entries
python {baseDir}/scripts/blackboard.py list
```

## Agent-to-Agent Handoff Protocol

When delegating tasks between agents, always run the budget guard first.

### Step 1: Initialize Budget & Check Capacity
```bash
# Initialize budget (if not already done)
python {baseDir}/scripts/swarm_guard.py budget-init --task-id "task_001" --budget 10000

# Check current status
python {baseDir}/scripts/swarm_guard.py budget-check --task-id "task_001"
```

### Step 2: Identify Target Agent

Common agent types:
| Agent | Specialty |
|-------|-----------|
| `data_analyst` | Data processing, SQL, analytics |
| `strategy_advisor` | Business strategy, recommendations |
| `risk_assessor` | Risk analysis, compliance checks |
| `orchestrator` | Coordination, task decomposition |

### Step 3: Run Budget Guard Before Delegation

```bash
# Check budget AND handoff limits before delegating
python {baseDir}/scripts/swarm_guard.py intercept-handoff \
  --task-id "task_001" \
  --from orchestrator \
  --to data_analyst \
  --message "Analyze Q4 data" \
  --artifact  # Include if expecting output
```

**If ALLOWED:** Proceed with delegation via your platform's own tools
**If BLOCKED:** Stop — budget exceeded or handoff limit reached; do not delegate

### Step 4: Construct Handoff Message

Include these fields in your delegation:
- **instruction**: Clear task description
- **context**: Relevant background information
- **constraints**: Any limitations or requirements
- **expectedOutput**: What format/content you need back

### Step 5: Check Results

After delegation completes, read results from the blackboard:

```bash
python {baseDir}/scripts/blackboard.py read "task:001:data_analyst"
```

## Permission Scoring

> **Tokens are audit scoring outputs only.** Grant tokens from `check_permission.py` are NOT authenticated credentials and must NOT be used as real access control. They are advisory hints based on a local scoring model. Require a separate authenticated identity and explicit human approval before accessing PAYMENTS, DATABASE, or FILE_EXPORT resources.

**Always score permission before accessing:**
- `DATABASE` — Internal database / data store (abstract label — no external credentials)
- `PAYMENTS` — Financial/payment data services (abstract label — requires `--confirm-high-risk`)
- `EMAIL` — Email sending capability (abstract label)
- `FILE_EXPORT` — Exporting data to local files (abstract label — requires `--confirm-high-risk`)

> **Note**: These are abstract local resource type names used by `check_permission.py`. No external API credentials are required or used — all evaluation runs locally.

### Permission Evaluation Criteria

| Factor | Weight | Criteria |
|--------|--------|----------|
| Justification | 40% | Must explain specific task need |
| Trust Level | 30% | Agent's established trust score |
| Risk Assessment | 30% | Resource sensitivity + scope breadth |

### Using the Permission Script

```bash
# Request permission
python {baseDir}/scripts/check_permission.py \
  --agent "your_agent_id" \
  --resource "PAYMENTS" \
  --justification "Generating quarterly financial summary for board presentation" \
  --scope "read:revenue,read:expenses"

# Output if approved:
# ✅ GRANTED
# Token: grant_a1b2c3d4e5f6
# Expires: 2026-02-04T15:30:00Z
# Restrictions: read_only, no_pii_fields, audit_required

# Output if denied:
# ❌ DENIED
# Reason: Justification is insufficient. Please provide specific task context.
```

### Restriction Types

| Resource | Default Restrictions |
|----------|---------------------|
| DATABASE | `read_only`, `max_records:100` |
| PAYMENTS | `read_only`, `no_pii_fields`, `audit_required` |
| EMAIL | `rate_limit:10_per_minute` |
| FILE_EXPORT | `anonymize_pii`, `local_only` |

## Shared Blackboard Pattern

The blackboard (`swarm-blackboard.md`) is a markdown file for agent coordination:

```markdown
# Swarm Blackboard
Last Updated: 2026-02-04T10:30:00Z

## Knowledge Cache
### task:q4_analysis
{"status": "completed", "result": {...}, "agent": "data_analyst"}

### cache:revenue_summary  
{"q4_total": 1250000, "growth": 0.15}
```

### Blackboard Operations

```bash
# Write with TTL (expires after 1 hour)
python {baseDir}/scripts/blackboard.py write "cache:temp_data" '{"value": 123}' --ttl 3600

# Read (returns null if expired)
python {baseDir}/scripts/blackboard.py read "cache:temp_data"

# Delete
python {baseDir}/scripts/blackboard.py delete "cache:temp_data"

# Get full snapshot
python {baseDir}/scripts/blackboard.py snapshot
```

## Parallel Execution

For tasks requiring multiple agent perspectives:

### Strategy 1: Merge (Default)
Combine all agent outputs into unified result.
```
Ask data_analyst AND strategy_advisor to both analyze the dataset.
Merge their insights into a comprehensive report.
```

### Strategy 2: Vote
Use when you need consensus - pick the result with highest confidence.

### Strategy 3: First-Success
Use for redundancy - take first successful result.

### Strategy 4: Chain
Sequential processing - output of one feeds into next.

> **TypeScript engine (v4.15.0):** These strategies map directly to the `FanOutFanIn` module (`lib/fan-out.ts`) which provides `merge`, `vote`, `firstSuccess`, and `consensus` fan-in strategies with concurrency control. For multi-phase workflows with approval gates, see `PhasePipeline` (`lib/phase-pipeline.ts`). For result scoring and threshold filtering, see `ConfidenceFilter` (`lib/confidence-filter.ts`). Matcher-based hooks (`lib/adapter-hooks.ts`) can target specific agents or tools via glob patterns. For sandboxed agent execution, see `AgentRuntime` (`lib/agent-runtime.ts`). For large-scale agent coordination, see `StrategyAgent` (`lib/strategy-agent.ts`).

### Example Parallel Workflow

```
# For each delegation below, first run the budget guard:
#   python {baseDir}/scripts/swarm_guard.py intercept-handoff --task-id "task_001" --from orchestrator --to <agent> --message "<task>"
# If result.allowed == true, delegate via your platform's own tools.
1. Delegate to data_analyst: "Extract key metrics from Q4 data"
2. Delegate to risk_assessor: "Identify compliance risks in Q4 data"
3. Delegate to strategy_advisor: "Recommend actions based on Q4 trends"
4. Wait for all results and read them from the blackboard
5. Synthesize: Combine metrics + risks + recommendations into executive summary
```

## Security Considerations

1. **Never bypass the permission wall** for gated resources
2. **Always include justification** explaining the business need
3. **Use minimal scope** - request only what you need
4. **Check token expiry** - tokens are valid for 5 minutes
5. **Validate tokens** - use `python {baseDir}/scripts/validate_token.py TOKEN` to verify grant tokens before use
6. **Audit trail** - all permission requests are logged

## 📝 Audit Trail Requirements (MANDATORY)

**Every sensitive action MUST be logged to `data/audit_log.jsonl`** to maintain compliance and enable forensic analysis.

> **Privacy note:** Audit log entries contain agent-provided free-text fields (justifications, descriptions). These are stored locally in `data/audit_log.jsonl` and never transmitted over the network by this skill. However, **do not put PII, passwords, or API keys in justification strings** — they persist on disk. Consider periodic log rotation and restricting OS file permissions on the `data/` directory.

### What Gets Logged Automatically

The scripts automatically log these events:
- `permission_granted` - When access is approved
- `permission_denied` - When access is rejected
- `permission_revoked` - When a token is manually revoked
- `ttl_cleanup` - When expired tokens are purged
- `result_validated` / `result_rejected` - Swarm Guard validations

### Log Entry Format

```json
{
  "timestamp": "2026-02-04T10:30:00+00:00",
  "action": "permission_granted",
  "details": {
    "agent_id": "data_analyst",
    "resource_type": "DATABASE",
    "justification": "Q4 revenue analysis",
    "token": "grant_abc123...",
    "restrictions": ["read_only", "max_records:100"]
  }
}
```

### Reading the Audit Log

```bash
# View recent entries (last 10)
tail -10 {baseDir}/data/audit_log.jsonl

# Search for specific agent
grep "data_analyst" {baseDir}/data/audit_log.jsonl

# Count actions by type
cat {baseDir}/data/audit_log.jsonl | jq -r '.action' | sort | uniq -c
```

### Custom Audit Entries

If you perform a sensitive action manually, log it:

```python
import json
from datetime import datetime, timezone
from pathlib import Path

audit_file = Path("{baseDir}/data/audit_log.jsonl")
entry = {
    "timestamp": datetime.now(timezone.utc).isoformat(),
    "action": "manual_data_access",
    "details": {
        "agent": "orchestrator",
        "description": "Direct database query for debugging",
        "justification": "Investigating data sync issue #1234"
    }
}
with open(audit_file, "a") as f:
    f.write(json.dumps(entry) + "\n")
```

## 🧹 TTL Enforcement (Token Lifecycle)

Expired permission tokens are automatically tracked. Run periodic cleanup:

```bash
# Validate a grant token
python {baseDir}/scripts/validate_token.py grant_a1b2c3d4e5f6

# List expired tokens (without removing)
python {baseDir}/scripts/revoke_token.py --list-expired

# Remove all expired tokens
python {baseDir}/scripts/revoke_token.py --cleanup

# Output:
# 🧹 TTL Cleanup Complete
#    Removed: 3 expired token(s)
#    Remaining active grants: 2
```

**Best Practice**: Run `--cleanup` at the start of each multi-agent task to ensure a clean permission state.

## ⚠️ Swarm Guard: Preventing Common Failures

Two critical issues can derail multi-agent swarms:

### 1. The Handoff Tax 💸

**Problem**: Agents waste tokens "talking about" work instead of doing it.

**Prevention**:
```bash
# Before each handoff, check your budget:
python {baseDir}/scripts/swarm_guard.py check-handoff --task-id "task_001"

# Output:
# 🟢 Task: task_001
#    Handoffs: 1/3
#    Remaining: 2
#    Action Ratio: 100%
```

**Rules enforced**:
- **Max 3 handoffs per task** - After 3, produce output or abort
- **Max 500 chars per message** - Be concise: instruction + constraints + expected output
- **60% action ratio** - At least 60% of handoffs must produce artifacts
- **2-minute planning limit** - No output after 2min = timeout

```bash
# Record a handoff (with tax checking):
python {baseDir}/scripts/swarm_guard.py record-handoff \
  --task-id "task_001" \
  --from orchestrator \
  --to data_analyst \
  --message "Analyze sales data, output JSON summary" \
  --artifact  # Include if this handoff produces output
```

### 2. Silent Failure Detection 👻

**Problem**: One agent fails silently, others keep working on bad data.

**Prevention - Heartbeats**:
```bash
# Agents must send heartbeats while working:
python {baseDir}/scripts/swarm_guard.py heartbeat --agent data_analyst --task-id "task_001"

# Check if an agent is healthy:
python {baseDir}/scripts/swarm_guard.py health-check --agent data_analyst

# Output if healthy:
# 💚 Agent 'data_analyst' is HEALTHY
#    Last seen: 15s ago

# Output if failed:
# 💔 Agent 'data_analyst' is UNHEALTHY
#    Reason: STALE_HEARTBEAT
#    → Do NOT use any pending results from this agent.
```

**Prevention - Result Validation**:
```bash
# Before using another agent's result, validate it:
python {baseDir}/scripts/swarm_guard.py validate-result \
  --task-id "task_001" \
  --agent data_analyst \
  --result '{"status": "success", "output": {"revenue": 125000}, "confidence": 0.85}'

# Output:
# ✅ RESULT VALID
#    → APPROVED - Result can be used by other agents
```

**Required result fields**: `status`, `output`, `confidence`

### Supervisor Review

Before finalizing any task, run supervisor review:
```bash
python {baseDir}/scripts/swarm_guard.py supervisor-review --task-id "task_001"

# Output:
# ✅ SUPERVISOR VERDICT: APPROVED
#    Task: task_001
#    Age: 1.5 minutes
#    Handoffs: 2
#    Artifacts: 2
```

**Verdicts**:
- `APPROVED` - Task healthy, results usable
- `WARNING` - Issues detected, review recommended
- `BLOCKED` - Critical failures, do NOT use results

## Troubleshooting

### Permission Denied
- Provide more specific justification (mention task, purpose, expected outcome)
- Narrow the requested scope
- Check agent trust level

### Blackboard Read Returns Null
- Entry may have expired (check TTL)
- Key may be misspelled
- Entry was never written

### Session Not Found
- Run `sessions_list` (OpenClaw platform built-in) to see available sessions
- Session may need to be started first

## Security Framework Assessment (MAESTRO / OWASP AST)

The following findings are drawn from the **MAESTRO Agent Security Threat** framework (OWASP LLM / ASVS mapping). They are addressed by existing architectural controls in Network-AI — not open vulnerabilities.

### AST03 — Over-Privileged Skills · Severity: High

> *Skills are granted broader permissions than their stated function requires, creating excessive blast radius if prompt-injected.*

| Control | How Network-AI addresses it |
|---|---|
| **Permission manifest** | `metadata.openclaw` in SKILL.md frontmatter explicitly declares `bundle_scope` (Python scripts: local-only; full npm package: includes optional MCP SSE server), `network_calls` (Python scripts: none; MCP SSE server: TCP, operator-started, bearer-token required), `requires.bins: [python3]` — no API credentials, no external services in core |
| **Least-privilege resource gating** | `check_permission.py` uses a weighted scoring model (justification 40 %, trust 30 %, risk 30 %); PAYMENTS and FILE_EXPORT require `--confirm-high-risk` acknowledgment before any token is issued; `--scope` limits every grant to minimum required access |
| **Abstract resource labels only** | PAYMENTS, DATABASE, EMAIL, FILE_EXPORT are local scoring labels — no external credentials exist in the skill; there is nothing to leak to an external service |
| **HMAC-signed grant tokens** | Since v5.5.2, every grant record carries `_sig` (HMAC-SHA256 over canonical fields); `validate_token.py` rejects tampered records — privilege escalation via forged grants is detected at validation time |
| **SandboxPolicy + FileAccessor** | AgentRuntime's `SandboxPolicy` enforces command allowlists/blocklists; `FileAccessor` restricts all file I/O to `data/<env>/`; out-of-scope access throws `SourceProtectionError` and returns `{success: false}` without leaking path details |
| **Advisory-only tokens** | All grant tokens are explicitly marked `advisory: true`; downstream systems must add a separate authenticated identity check and human approval before any real sensitive action — documented in frontmatter and throughout SKILL.md |

### AST06 — Weak Isolation · Severity: High

> *Skills execute in the host agent's security context with full filesystem, shell, and network access.*

| Control | How Network-AI addresses it |
|---|---|
| **Zero network calls (Python scripts)** | All bundled Python scripts use Python stdlib only, spawn no subprocesses, and make no network calls — declared in `metadata.openclaw.network_calls` and `bundle_scope`. The optional MCP SSE server (`bin/mcp-server.ts`) binds a TCP port only when explicitly started by the operator and requires a non-empty bearer-token secret. |
| **AgentRuntime sandbox** | `ShellExecutor` enforces per-command timeout and output-size limits; `SandboxPolicy` allowlist/blocklist prevents unapproved shell commands from running at all |
| **ClaimVerifier (Tier 1 agent honesty)** | `AgentRuntime` issues HMAC-signed outcome-bound receipts (`ExecutionReceipt`) on every `exec()` and `writeFile()`; `ClaimVerifier` (`lib/claim-verifier.ts`) reconciles agent-declared manifests against the audit log — `UNSUPPORTED_CLAIM` and `UNDISCLOSED_ACTION` violations surface through `ComplianceMonitor`; repeated fabrication decays `AuthGuardian` trust and forces `ApprovalGate` supervision |
| **Source protection** | `SandboxPolicy.sourceProtection` constrains `FileAccessor.read/write/list` to `data/<env>/` only; any attempt to read outside that boundary throws `SourceProtectionError` — the agent receives `{success: false}`, no path details leak |
| **Environment isolation** | `NETWORK_AI_ENV` / `--env` routes all state to `data/<env>/`; dev, staging, and production state are fully separated; live state (`audit_log.jsonl`, `active_grants.json`) never promotes across environments |
| **ApprovalGate** | High-risk shell or file operations require explicit human or callback approval before execution; auto-approve only in explicitly trusted environments |
| **No hot-reload surface** | Bundled scripts do not implement or respond to a SkillsWatcher; skill updates require explicit `clawhub install` or `npm install` — no mid-session reload is possible |

### AST07 — Update Drift · Severity: Medium

> *Installed skills drift out of sync — either unpatched (leaving known CVEs open) or blindly auto-updated (potentially receiving malicious patches).*

| Control | How Network-AI addresses it |
|---|---|
| **Exact version pinning** | npm `package.json` uses exact `"version": "5.12.2"` — no semver range specifiers; `clawhub install network-ai` pins to a specific published version |
| **Zero transitive dependency drift** | All bundled Python scripts use Python stdlib only — `pip install` is never required; there are no third-party packages to drift, be compromised upstream, or introduce CVEs |
| **Signed, tagged releases** | Every release is committed with a signed Git tag (`v5.7.x`); commit hash is verifiable against CHANGELOG.md; GitHub releases link tag → diff → changelog entry |
| **Supply chain monitoring** | npm package continuously scored by Socket.dev (score A); any new dependency or permission change triggers an alert |
| **No auto-update mechanism** | Updates require explicit user action (`clawhub install`, `npm install network-ai@latest`); there is no background updater or hot-reload path |
| **CHANGELOG.md audit trail** | Every change — including docs-only patches — is tracked with version, date, and rationale; operators can diff any two versions to assess update risk before applying |

## Security Scan Findings (ClawHub)

This skill is scanned on every publish. The following Notes are flagged by design and will recur on every scan. They are acknowledged and mitigated with documented controls — they are not bugs or vulnerabilities.

| Finding | Severity | Why it recurs | Documented control |
|---------|----------|---------------|--------------------|  
| **ASI01** Agent Goal Hijack | High | Orchestrator skill performs multi-step decomposition and delegation by design | Use this skill only when multi-agent orchestration is desired; for simple requests the scope guard responds directly without decomposing |
| **ASI03** Identity and Privilege Abuse (advisory tokens) | Medium | Grant tokens are advisory scoring outputs only — caller-supplied `--agent` identity is not cryptographically verified; skill explicitly warns tokens must not be used as real authorization for PAYMENTS, DATABASE, or FILE_EXPORT | Tokens are explicitly marked advisory in SKILL.md and source; require separate platform auth and human approval before any real database, payment, email, or export action |
| **ASI03** Identity and Privilege Abuse (local grant state) | Low | The permission system creates persistent local state (`active_grants.json`, `audit_log.jsonl`, `.signing_key`) — security-relevant files that are purpose-aligned but accessible to anyone with `data/` access | Keep the skill directory private; back up or delete local grant state when no longer needed; do not share `data/` casually; restrict OS-level permissions on `data/` on shared machines |
| **ASI03** Identity and Privilege Abuse (token integrity) | ~~High~~ Resolved | Token payload had no integrity protection — active_grants.json could be edited to forge elevated grants | Fixed in v5.5.2 — `check_permission.py` HMAC-SHA256 signs each grant (`_sig` field, stdlib `hmac`+`hashlib`, key at `data/.signing_key`); `validate_token.py` verifies before accepting; tampered tokens rejected with `"Token signature invalid"` |
| **ASI03** Identity and Privilege Abuse (env-scoped paths) | ~~High~~ Resolved | `revoke_token.py` resolved `GRANTS_FILE`/`AUDIT_LOG` at module load from root `data/`, ignoring `NETWORK_AI_ENV` — revoking tokens in one env could silently miss env-specific grant files | Fixed in v5.5.1 — `_resolve_data_dir()` added, `--env` CLI argument introduced, paths re-resolved in `main()` before file I/O; consistent with `check_permission.py` and `validate_token.py` |
| **ASI06** Memory and Context Poisoning (project context) | Medium | Persistent `data/project-context.json` is injected into every agent session by design — inaccurate or malicious context could steer future agent behavior | `_validate_context()` runs injection-pattern detection before every inject; do not store secrets/credentials; review `data/project-context.json` before use; clear `data/` between projects |
| **ASI06** Memory and Context Poisoning (audit log free text) | Low | `justification` field in permission requests and `data/audit_log.jsonl` store agent-provided free-text strings locally — PII or secrets placed there will persist on disk | Do not include PII, secrets, or credentials in justification text; restrict access to `data/` on shared machines; rotate/delete `audit_log.jsonl` when no longer needed |
| **ASI07** Insecure Inter-Agent Communication | High | Blackboard is local file-based; origin/identity depends on local file access, not authenticated messaging | Run in a trusted workspace; restrict file permissions on `data/`; review blackboard changes before relying on them for important decisions |
| **ASI08** Cascading Failures | ~~High~~ Resolved | `os` was referenced before import in `swarm_guard.py` — fixed in v5.4.4; `import os` now present | Fixed — `swarm_guard.py` now imports `os` at module level; budget/health guard starts correctly |
| **SkillSpector** Intent-Code Divergence (`FILE_EXPORT` missing from `HIGH_RISK_RESOURCES`) | ~~Low~~ Resolved | Comment stated `FILE_EXPORT` requires `--confirm-high-risk` but `HIGH_RISK_RESOURCES` only contained `PAYMENTS` and `DATABASE`; file export requests could receive advisory grants without the extra acknowledgment | Fixed in v5.11.0 — `FILE_EXPORT` added to `HIGH_RISK_RESOURCES` in `check_permission.py`; now requires `--confirm-high-risk` consistent with the documented policy |
| **SkillSpector** Description-Behavior Mismatch (`ensure_data_dir()` ignoring env scope) | ~~Medium~~ Resolved | `ensure_data_dir()` always created the fixed top-level `data/` directory instead of the active env-specific path, breaking environment isolation when `NETWORK_AI_ENV` is set | Fixed in v5.11.0 — `ensure_data_dir()` now delegates to `_resolve_data_dir()` so audit log and grant files are always written to the correct env-scoped directory |

## References

This skill is part of the larger [Network-AI](https://github.com/Jovancoding/Network-AI) project. See the repository for full documentation on the permission system, blackboard schema, and trust-level calculations.
