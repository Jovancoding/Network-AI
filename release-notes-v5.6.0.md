# Network-AI v5.6.0 — WAL Crash Recovery

All 3,136 tests pass. Zero TypeScript errors.

## Features

**`LockedBlackboard` Write-Ahead Log (WAL) crash recovery** (`lib/locked-blackboard.ts`)

Every `write()`, `commit()`, and `delete()` now follows a strict append-before-write + checkpoint-after-write pattern:

1. **Before** the file write — an `append` record is written to `.wal.jsonl`
2. The actual state file is updated  
3. **After** the write succeeds — a `checkpoint` record is appended to `.wal.jsonl`

On construction, `replayWAL()` is called automatically after `loadFromDisk()`. It scans `.wal.jsonl` for any `append` records that have no matching `checkpoint` (= the process crashed between steps 1 and 3) and replays them into the in-memory store. The WAL is then compacted.

```typescript
// WAL is automatic — nothing to configure
const board = new LockedBlackboard('.', { env: 'prod' });
// Any uncommitted ops from a previous crash are replayed here

// Manual truncation after a full snapshot:
await board.compactWAL();
```

### WAL file locations

| Mode | Path |
|---|---|
| Env-scoped | `<basePath>/<env>/.wal.jsonl` |
| Legacy (no env) | `<basePath>/data/.wal.jsonl` |

### Resilience properties

- Partial writes at crash time produce malformed tail lines — silently skipped
- WAL replay is idempotent: replaying an already-committed op overwrites with the same value
- `compactWAL()` is safe to call at any time; a new WAL starts clean on the next write

7 new tests added to `test-phase11.ts`.
