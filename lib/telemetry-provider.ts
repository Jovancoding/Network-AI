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

// ============================================================================
// REFUSAL OBSERVABILITY
// ============================================================================

/** Span/event name emitted for a classifier refusal. */
export const REFUSAL_EVENT = 'model.refusal';
/** Span/event name emitted when a fallback model serves a turn. */
export const FALLBACK_SERVED_EVENT = 'model.fallback_served';

/** Argument to {@link RefusalTelemetry.recordRefusal}. */
export interface RefusalEventInfo {
  model: string;
  category: string | null;
  agentId?: string;
}

/** Argument to {@link RefusalTelemetry.recordFallbackServed}. */
export interface FallbackServedInfo {
  requestedModel: string;
  servedModel: string;
  agentId?: string;
}

/** Point-in-time counters from {@link RefusalTelemetry.snapshot}. */
export interface RefusalSnapshot {
  refusals: number;
  fallbackServed: number;
  /** Refusals never served by a fallback — the gap to alert on. */
  unservedRefusals: number;
  byCategory: Record<string, number>;
  byModel: Record<string, number>;
}

/**
 * Refusal/fallback observability.
 *
 * A classifier refusal is a successful **HTTP 200**, so monitoring built on
 * error rates or 5xx responses never sees it. `RefusalTelemetry` records each
 * refusal and each fallback-served response as discrete **non-error** signals,
 * keeps counters, and exposes the gap between them (`unservedRefusalCount`) so
 * you can alert when refusals are not being served by a fallback.
 *
 * It satisfies the `RefusalTelemetrySink` contract consumed by
 * {@link ../lib/model-gateway!GovernedModelGateway}. Pass an
 * {@link ITelemetryProvider} to also emit spans to your tracing backend.
 *
 * @example
 * ```typescript
 * const refusals = new RefusalTelemetry(new CapturingTelemetryProvider());
 * const gateway = new GovernedModelGateway({ caller, primaryModel, fallbackModels, telemetry: refusals });
 * // ...later
 * if (refusals.unservedRefusalCount > 0) alert('refusals are reaching users');
 * ```
 */
export class RefusalTelemetry {
  private readonly provider: ITelemetryProvider | undefined;
  private _refusals = 0;
  private _fallbackServed = 0;
  private readonly _byCategory: Map<string, number> = new Map();
  private readonly _byModel: Map<string, number> = new Map();

  constructor(provider?: ITelemetryProvider) {
    this.provider = provider;
  }

  /** Record a classifier refusal (counted as a signal, never as an error). */
  recordRefusal(info: RefusalEventInfo): void {
    this._refusals++;
    const cat = info.category ?? 'unspecified';
    this._byCategory.set(cat, (this._byCategory.get(cat) ?? 0) + 1);
    this._byModel.set(info.model, (this._byModel.get(info.model) ?? 0) + 1);
    this.emit(REFUSAL_EVENT, { model: info.model, category: cat, agentId: info.agentId ?? '' });
  }

  /** Record that a fallback model served a turn the primary declined. */
  recordFallbackServed(info: FallbackServedInfo): void {
    this._fallbackServed++;
    this.emit(FALLBACK_SERVED_EVENT, {
      requestedModel: info.requestedModel,
      servedModel: info.servedModel,
      agentId: info.agentId ?? '',
    });
  }

  /** Total refusals observed. */
  get refusalCount(): number {
    return this._refusals;
  }

  /** Total fallback-served responses observed. */
  get fallbackServedCount(): number {
    return this._fallbackServed;
  }

  /** Refusals that were never served by a fallback (the gap to alert on). */
  get unservedRefusalCount(): number {
    return Math.max(0, this._refusals - this._fallbackServed);
  }

  /** Refusal counts keyed by classifier category. */
  byCategory(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this._byCategory) out[k] = v;
    return out;
  }

  /** A full counter snapshot. */
  snapshot(): RefusalSnapshot {
    const byModel: Record<string, number> = {};
    for (const [k, v] of this._byModel) byModel[k] = v;
    return {
      refusals: this._refusals,
      fallbackServed: this._fallbackServed,
      unservedRefusals: this.unservedRefusalCount,
      byCategory: this.byCategory(),
      byModel,
    };
  }

  /** Reset all counters. */
  reset(): void {
    this._refusals = 0;
    this._fallbackServed = 0;
    this._byCategory.clear();
    this._byModel.clear();
  }

  /** Emit a discrete non-error span for a refusal/fallback signal. @internal */
  private emit(name: string, attributes: SpanAttributes): void {
    if (!this.provider) return;
    try {
      const id = this.provider.startSpan(name, attributes);
      // A refusal is a successful HTTP 200 — close the span 'ok', never 'error'.
      this.provider.endSpan(id, 'ok', attributes);
    } catch {
      // Telemetry must never throw.
    }
  }
}
