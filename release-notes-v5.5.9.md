# Network-AI v5.5.9 — TTL Background Sweep

All 3,136 tests pass. Zero TypeScript errors.

## Features

**`LockedBlackboard` TTL background sweep** (`lib/locked-blackboard.ts`)

- `purgeExpired(): number` — evicts all expired TTL entries from the in-memory cache on demand; returns the number of evictions. Call it anytime to reclaim memory without waiting for the next read or persist cycle.
- `startSweep(intervalMs?: number)` — starts a background `setInterval` that calls `purgeExpired()` automatically. Default interval: 60,000 ms (1 min). The timer is `unref()`'d so it never prevents a clean process exit.
- `stopSweep()` — cancels the sweep timer cleanly; safe to call even if no sweep is running.

**Why this matters:** `read()` and `persistToDisk()` already filtered expired entries on access, but keys that were written with a TTL and never read again would stay in the in-memory map until the next disk round-trip. `startSweep()` closes that gap for long-running processes with high write throughput and short-lived keys.

```typescript
const board = new LockedBlackboard('.', { env: 'prod' });
board.startSweep(30_000);   // evict expired entries every 30 s
// ...
board.stopSweep();           // clean shutdown
```

8 new tests added to `test-phase11.ts`.
