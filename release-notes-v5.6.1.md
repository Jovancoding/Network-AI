# Network-AI v5.6.1 — Circuit Breaker on AdapterRegistry

All 3,136 tests pass. Zero TypeScript errors.

## Features

**Circuit Breaker on `AdapterRegistry`** (`lib/circuit-breaker.ts`)

A new standalone `CircuitBreaker` class with a three-state machine wired into every adapter in `AdapterRegistry`.

### State machine

```
CLOSED ──(failureThreshold failures)──► OPEN
  ▲                                       │
  │ (successThreshold successes)    (recoveryTimeoutMs)
  │                                       ▼
  └────────────────────────── HALF_OPEN ──┤
                                          │ (failure)
                                          └──► OPEN
```

| State | Behavior |
|---|---|
| `CLOSED` | Normal execution — failures increment counter |
| `OPEN` | `CircuitOpenError` thrown immediately — no call made to adapter |
| `HALF_OPEN` | One probe call allowed — success closes, failure re-opens |

### Configuration

```typescript
const registry = new AdapterRegistry({
  circuitBreaker: {
    failureThreshold: 3,       // trips after 3 consecutive failures (default)
    recoveryTimeoutMs: 30_000, // waits 30 s before probing (default)
    successThreshold: 1,       // 1 success in HALF_OPEN closes circuit (default)
    onStateChange: (from, to, adapterName) => console.log(`${adapterName}: ${from} → ${to}`),
  },
  fallbackChain: ['backup-agent', 'emergency-agent'],
});
```

### Fallback chain

When the circuit is `OPEN`, the registry automatically tries each adapter in `fallbackChain` in order before returning a `CIRCUIT_OPEN` error code. This enables zero-downtime failover without changing any call site.

### Public API

```typescript
registry.getCircuitState('my-agent');        // 'CLOSED' | 'OPEN' | 'HALF_OPEN'
registry.resetCircuit('my-agent');           // force back to CLOSED
registry.setCircuitBreakerConfig({ failureThreshold: 5 });
```

### New event types

`circuit:open`, `circuit:half-open`, `circuit:close` added to `AdapterEventType`.

Zero new runtime dependencies — BYOC principle maintained throughout.

13 new tests added to `test-phase11.ts`.
