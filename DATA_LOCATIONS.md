# Data Locations

Every file and directory that Network-AI creates, reads, or modifies at runtime — with
the path, purpose, data classification, and retention guidance.

All paths are relative to the **data directory** (default: `./data/`, override with
`--data <path>` CLI flag or `NETWORK_AI_DATA` env var).

---

## Root Data Directory (`data/`)

| File / Directory | Created by | Purpose | Data class | Contains secrets? |
|-----------------|-----------|---------|-----------|------------------|
| `audit_log.jsonl` | `SecureAuditLogger` | Append-only event log — every write, permission grant, state transition | Sensitive | No (tokens are hashed) |
| `blackboard.json` | `LockedBlackboard` | Primary key-value store; all agent coordination state | Sensitive | Operator-dependent |
| `pending_changes/` | `LockedBlackboard` | WAL entries for in-flight `propose → commit` transactions | Sensitive | Mirrors blackboard |
| `trust_levels.json` | `AuthGuardian` | Per-agent trust level registry | Sensitive | No |
| `.signing_key` | `check_permission.py` | HMAC-SHA256 key for signing grant tokens | **Critical** | **Yes** |
| `project-context.json` | `GoalDecomposer` | Active project metadata for LLM-assisted goal decomposition | Internal | No |
| `backups/` | `EnvironmentManager` | Point-in-time snapshots created by `env backup create` | Sensitive | Same as source |

## Operator-Configured Paths

These files are written **only** when the operator explicitly sets the corresponding option. They are not created by default.

| Option | Created by | Purpose | Data class |
|--------|-----------|---------|-----------|
| `PhasePipelineOptions.checkpointPath` | `PhasePipeline` | JSON checkpoint recording completed phases and `nextPhaseIndex`; enables resume after crash | Internal |
| `SemanticMemory` constructor `persistPath` | `SemanticMemory` | Versioned JSON index of all embedded entries; enables vector store persistence across restarts | Internal |

### `pending_changes/` layout

```
data/pending_changes/
  <changeId>.json        — one file per in-flight proposal
```

Each file is a `BlackboardChange` JSON object with `key`, `value`, `agent`, `timestamp`,
`ttl`, and `priority`. Files are deleted on `commit` or `abort`.

---

## Per-Environment Directories (`data/<env>/`)

When multi-environment mode is active (`NETWORK_AI_ENV=<env>` or `--env <name>`), each
environment gets its own isolated copy of all root-level files:

| Environment | Directory |
|-------------|-----------|
| dev | `data/dev/` |
| st | `data/st/` |
| sit | `data/sit/` |
| qa | `data/qa/` |
| sandbox | `data/sandbox/` |
| preprod | `data/preprod/` |
| prod | `data/prod/` |

Each env directory contains the same set of files as the root data directory. The
promotion chain is: `dev → st → sit → qa → preprod → prod`.

---

## Backup Directories (`data/backups/<env>/`)

| Path | Created by | Format |
|------|-----------|--------|
| `data/backups/<env>/<timestamp>/` | `EnvironmentManager.backup()` | Directory copy of the env data dir |

Backups are created on demand via `network-ai env backup create --env <name>`.
They are not auto-pruned; use `network-ai env backup prune --env <name> --keep N`.

---

## Lock Files

| File | Purpose | Lifespan |
|------|---------|---------|
| `data/.lock` | Filesystem mutex for `LockedBlackboard` atomic operations | Held for duration of propose/commit; auto-released |
| `data/<env>/.lock` | Per-environment lock | Same |

Lock files are created and deleted by `LockedBlackboard`. A stale lock (process crash)
is detected by PID check and automatically cleared.

---

## Audit Log Schema

Each line in `audit_log.jsonl` is a JSON object. Full schema: [AUDIT_LOG_SCHEMA.md](AUDIT_LOG_SCHEMA.md).

Key fields:

```jsonc
{
  "timestamp": "2026-05-23T15:00:00.000Z",  // ISO 8601
  "event":     "BLACKBOARD_WRITE",           // event type
  "agent":     "orchestrator-1",             // acting agent
  "key":       "task/result",                // affected key (if applicable)
  "granted":   true,                         // permission outcome
  "tokenHash": "sha256:abc123…"              // hashed token (never raw)
}
```

---

## Data Classification

| Class | Definition | Examples in Network-AI |
|-------|-----------|----------------------|
| **Critical** | Compromise enables privilege escalation or token forgery | `.signing_key` |
| **Sensitive** | Contains operational data; exposure enables information disclosure or replay | `audit_log.jsonl`, `blackboard.json`, `trust_levels.json` |
| **Internal** | Non-secret operational metadata | `project-context.json`, lock files |
| **Public** | Intentionally readable | `package.json`, source files |

---

## Operator Responsibilities

1. **Permissions**: Set `data/` to `0700` (or equivalent) — readable only by the
   Network-AI process owner. The `.signing_key` file should be `0600`.

2. **Secrets in blackboard**: Do **not** store API keys, passwords, or private keys as
   blackboard values. The blackboard is plaintext JSON on disk.

3. **Audit log retention**: The audit log is never auto-deleted. Implement a log-rotation
   policy appropriate for your compliance requirements.

4. **Backup encryption**: Backups are plaintext copies. Encrypt at the filesystem level
   (LUKS, FileVault, BitLocker) if required by your data-handling policy.

5. **Multi-project isolation**: Clear `data/` (or use a separate `--data` path) between
   unrelated projects to prevent cross-project context leakage.

---

## Files Never Created by Network-AI

The following are **never** written by Network-AI and should be treated as suspicious if
they appear in the data directory:

- Executable files (`*.sh`, `*.exe`, `*.bat`)
- Private key files in PEM/DER format (`*.pem`, `*.key`, `*.p12`)
- Any file outside the `data/` directory tree (path traversal is blocked)
