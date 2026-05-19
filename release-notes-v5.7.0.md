# Network-AI v5.7.0 — OTel ITelemetryProvider BYOT Interface

All 3,136 tests pass. Zero TypeScript errors.

## Features

**`ITelemetryProvider` BYOT abstraction** (`lib/telemetry-provider.ts`)

A zero-dependency telemetry interface that lets you plug any OpenTelemetry SDK — or any custom backend — into Network-AI without modifying a single adapter.

### Interface

```typescript
interface ITelemetryProvider {
  startSpan(name: string, attributes?: SpanAttributes): unknown;
  endSpan(span: unknown, attributes?: SpanAttributes): void;
  recordError(span: unknown, error: Error): void;
}
```

### Built-in implementations

| Class | Purpose |
|---|---|
| `NullTelemetryProvider` | No-op default — zero overhead, zero imports |
| `CapturingTelemetryProvider` | In-memory store for tests and local dev |

### `createOtelHooks(provider)`

Factory that converts any `ITelemetryProvider` into three `ExecutionHook[]` ready to register with `AdapterHookManager`:

```typescript
import { createOtelHooks, CapturingTelemetryProvider } from './lib/telemetry-provider.js';
import { AdapterHookManager } from './lib/adapter-hooks.js';

const telemetry = new CapturingTelemetryProvider();
const hookManager = new AdapterHookManager();
hookManager.registerHooks(createOtelHooks(telemetry));

// After execution:
const spans = telemetry.getSpans(); // CapturedSpan[]
```

### Wiring your OTel SDK

```typescript
class MyOtelProvider implements ITelemetryProvider {
  startSpan(name: string, attrs?: SpanAttributes) {
    return otel.tracer('network-ai').startSpan(name, { attributes: attrs });
  }
  endSpan(span: unknown) { (span as Span).end(); }
  recordError(span: unknown, error: Error) {
    (span as Span).recordException(error);
    (span as Span).setStatus({ code: SpanStatusCode.ERROR });
  }
}

hookManager.registerHooks(createOtelHooks(new MyOtelProvider()));
```

Zero new runtime dependencies — BYOT principle maintained throughout.

16 new tests added to `test-phase11.ts`.
