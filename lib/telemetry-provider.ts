/**
 * Telemetry Provider — BYOT (Bring Your Own Telemetry) abstraction.
 *
 * Defines a minimal interface over distributed tracing providers such as
 * OpenTelemetry, Datadog APM, Honeycomb, etc.  Network-AI core never imports
 * a concrete telemetry SDK — only this interface — preserving the zero-
 * dependency BYOC design.
 *
 * ## Wiring into adapter lifecycle hooks
 *
 * ```typescript
 * import { createOtelHooks, CapturingTelemetryProvider } from 'network-ai';
 * import { AdapterHookManager } from 'network-ai';
 *
 * const provider = new CapturingTelemetryProvider(); // or your own impl
 * const hookManager = new AdapterHookManager();
 * createOtelHooks(provider).forEach(h => hookManager.register(h));
 * ```
 *
 * ## Implementing for OpenTelemetry
 *
 * ```typescript
 * import { trace, SpanStatusCode } from '@opentelemetry/api';
 * import type { ITelemetryProvider, SpanAttributes } from 'network-ai';
 *
 * class OtelProvider implements ITelemetryProvider {
 *   private tracer = trace.getTracer('network-ai');
 *   private spans = new Map<string, Span>();
 *
 *   startSpan(name: string, attrs: SpanAttributes = {}): string {
 *     const span = this.tracer.startSpan(name, { attributes: attrs as Attributes });
 *     const id = `span_${Date.now()}`;
 *     this.spans.set(id, span);
 *     return id;
 *   }
 *   endSpan(id: string, status: 'ok' | 'error'): void {
 *     const span = this.spans.get(id);
 *     if (!span) return;
 *     span.setStatus({ code: status === 'ok' ? SpanStatusCode.OK : SpanStatusCode.ERROR });
 *     span.end();
 *     this.spans.delete(id);
 *   }
 *   recordEvent(id: string, name: string, attrs: SpanAttributes = {}): void {
 *     this.spans.get(id)?.addEvent(name, attrs as Attributes);
 *   }
 * }
 * ```
 */

import type { ExecutionHook, HookContext } from './adapter-hooks';

// ============================================================================
// CORE TYPES
// ============================================================================

/**
 * Flat attribute bag for span and event annotations.
 * Values must be serialisable primitives for cross-backend compatibility.
 */
export interface SpanAttributes {
  [key: string]: string | number | boolean | undefined;
}

/**
 * A span captured by `CapturingTelemetryProvider` — use in tests to assert
 * on emitted traces.
 */
export interface CapturedSpan {
  spanId: string;
  name: string;
  attributes: SpanAttributes;
  startedAt: number;
  endedAt?: number;
  status?: 'ok' | 'error';
  events: Array<{ name: string; attributes: SpanAttributes; ts: number }>;
}

// ============================================================================
// INTERFACE
// ============================================================================

/**
 * Minimal telemetry abstraction.  Implement this interface to plug any
 * tracing backend into Network-AI without adding runtime dependencies.
 *
 * **Contract:** all methods are synchronous or fire-and-forget.
 * Implementations **must not throw** — catch and handle internally.
 */
export interface ITelemetryProvider {
  /**
   * Start a new span.
   * @param name       Human-readable operation name (e.g. `'adapter.execute'`).
   * @param attributes Initial span attributes.
   * @returns          Opaque spanId — pass to `endSpan` / `recordEvent`.
   */
  startSpan(name: string, attributes?: SpanAttributes): string;

  /**
   * End a span with a final status.
   * @param spanId     Value returned by `startSpan`.
   * @param status     `'ok'` for success, `'error'` for failure.
   * @param attributes Additional attributes to attach at close time.
   */
  endSpan(spanId: string, status: 'ok' | 'error', attributes?: SpanAttributes): void;

  /**
   * Record a point-in-time event within an active span.
   * @param spanId     Value returned by `startSpan`.
   * @param name       Event name (e.g. `'blackboard.commit'`).
   * @param attributes Event annotations.
   */
  recordEvent(spanId: string, name: string, attributes?: SpanAttributes): void;
}

// ============================================================================
// NULL PROVIDER (default — zero overhead when no telemetry is configured)
// ============================================================================

/**
 * No-op implementation.  Used as the default when no telemetry provider is
 * supplied so the instrumentation path compiles to a handful of dead calls
 * that the JIT eliminates.
 */
export class NullTelemetryProvider implements ITelemetryProvider {
  /** @inheritdoc */
  startSpan(_name: string, _attributes?: SpanAttributes): string { return ''; }
  /** @inheritdoc */
  endSpan(_spanId: string, _status: 'ok' | 'error', _attributes?: SpanAttributes): void {}
  /** @inheritdoc */
  recordEvent(_spanId: string, _name: string, _attributes?: SpanAttributes): void {}
}

// ============================================================================
// CAPTURING PROVIDER (for testing)
// ============================================================================

/**
 * In-memory provider that stores every span and event for test assertions.
 *
 * @example
 * ```typescript
 * const provider = new CapturingTelemetryProvider();
 * createOtelHooks(provider).forEach(h => hookManager.register(h));
 *
 * await registry.executeAgent('agent:foo', payload, ctx);
 *
 * const span = provider.spans.find(s => s.name === 'adapter.execute');
 * expect(span?.status).toBe('ok');
 * ```
 */
export class CapturingTelemetryProvider implements ITelemetryProvider {
  /** All spans created since construction or last `clear()`. */
  readonly spans: CapturedSpan[] = [];
  private counter = 0;

  /** @inheritdoc */
  startSpan(name: string, attributes: SpanAttributes = {}): string {
    const spanId = `span_${++this.counter}`;
    this.spans.push({ spanId, name, attributes: { ...attributes }, startedAt: Date.now(), events: [] });
    return spanId;
  }

  /** @inheritdoc */
  endSpan(spanId: string, status: 'ok' | 'error', attributes: SpanAttributes = {}): void {
    const span = this.spans.find(s => s.spanId === spanId);
    if (!span) return;
    span.endedAt = Date.now();
    span.status = status;
    Object.assign(span.attributes, attributes);
  }

  /** @inheritdoc */
  recordEvent(spanId: string, name: string, attributes: SpanAttributes = {}): void {
    const span = this.spans.find(s => s.spanId === spanId);
    if (!span) return;
    span.events.push({ name, attributes: { ...attributes }, ts: Date.now() });
  }

  /** Clear all captured data and reset span counter. */
  clear(): void {
    this.spans.length = 0;
    this.counter = 0;
  }
}

// ============================================================================
// HOOK FACTORY
// ============================================================================

/** Metadata key used to propagate spanId through `HookContext`. @internal */
const SPAN_ID_META_KEY = '_otelSpanId';

/**
 * Create a set of `ExecutionHook` objects that emit traces to `provider`.
 *
 * Register the returned hooks with an `AdapterHookManager`:
 * ```typescript
 * createOtelHooks(provider).forEach(h => hookManager.register(h));
 * ```
 *
 * Three hooks are created — one per `HookPhase`:
 * - `otel:beforeExecute` — calls `provider.startSpan('adapter.execute', {...})`
 * - `otel:afterExecute`  — calls `provider.endSpan(spanId, 'ok')`
 * - `otel:onError`       — calls `provider.endSpan(spanId, 'error')`
 *
 * Each hook has `priority: 100` so it runs before most user-defined hooks.
 * The spanId is stored in `ctx.metadata._otelSpanId` for downstream hooks
 * that wish to add their own `recordEvent` calls.
 *
 * **Permission check semantics:** `beforeExecute` fires once when execution
 * begins — not per streaming chunk — matching the documented "once at start"
 * semantics of `StreamingBaseAdapter`.
 */
export function createOtelHooks(provider: ITelemetryProvider): ExecutionHook[] {
  return [
    {
      name: 'otel:beforeExecute',
      phase: 'beforeExecute',
      priority: 100,
      handler(ctx: HookContext): HookContext {
        try {
          const spanId = provider.startSpan('adapter.execute', {
            agentId: ctx.agentId,
            action: (ctx.payload as { action?: string }).action ?? '',
            depth: ctx.depth,
          });
          ctx.metadata[SPAN_ID_META_KEY] = spanId;
        } catch {
          // Telemetry must never break execution
        }
        return ctx;
      },
    },
    {
      name: 'otel:afterExecute',
      phase: 'afterExecute',
      priority: 100,
      handler(ctx: HookContext): HookContext {
        try {
          const spanId = ctx.metadata[SPAN_ID_META_KEY] as string | undefined;
          if (spanId) {
            provider.endSpan(spanId, 'ok', {
              success: ctx.result?.success === true,
            });
          }
        } catch {
          // no-op
        }
        return ctx;
      },
    },
    {
      name: 'otel:onError',
      phase: 'onError',
      priority: 100,
      handler(ctx: HookContext): HookContext {
        try {
          const spanId = ctx.metadata[SPAN_ID_META_KEY] as string | undefined;
          if (spanId) {
            provider.endSpan(spanId, 'error', {
              errorMessage: (ctx.error as Error | undefined)?.message ?? 'unknown',
            });
          }
        } catch {
          // no-op
        }
        return ctx;
      },
    },
  ];
}
