/**
 * OTelBridge — Zero-dependency OpenTelemetry bridge (BYOC pattern).
 *
 * Users inject their own OTel `Tracer` instance; the bridge wraps agent
 * executions, blackboard operations, and permission checks in proper OTel
 * spans with semantic attributes.  If no tracer is provided, all calls are
 * no-ops (zero overhead).
 *
 * @module OTelBridge
 */

// ============================================================================
// BYOC Tracer Interface (subset of @opentelemetry/api)
// ============================================================================

/** Minimal subset of OTel SpanStatusCode */
export enum SpanStatus {
  UNSET = 0,
  OK = 1,
  ERROR = 2,
}

/** Minimal span interface matching @opentelemetry/api Span */
export interface OTelSpan {
  setAttribute(key: string, value: string | number | boolean): this;
  setStatus(status: { code: SpanStatus; message?: string }): this;
  recordException(error: Error | string): this;
  end(): void;
}

/** Minimal span options */
export interface OTelSpanOptions {
  attributes?: Record<string, string | number | boolean>;
}

/** Minimal tracer interface matching @opentelemetry/api Tracer */
export interface OTelTracer {
  startSpan(name: string, options?: OTelSpanOptions): OTelSpan;
}

// ============================================================================
// NO-OP IMPLEMENTATION
// ============================================================================

class NoOpSpan implements OTelSpan {
  setAttribute(): this { return this; }
  setStatus(): this { return this; }
  recordException(): this { return this; }
  end(): void { /* no-op */ }
}

const NOOP_SPAN = new NoOpSpan();

class NoOpTracer implements OTelTracer {
  startSpan(): OTelSpan { return NOOP_SPAN; }
}

const NOOP_TRACER = new NoOpTracer();

// ============================================================================
// BRIDGE
// ============================================================================

/**
 * Wraps orchestrator operations in OTel spans.
 *
 * @example
 * ```ts
 * import { trace } from '@opentelemetry/api';
 * const bridge = new OTelBridge(trace.getTracer('network-ai'));
 *
 * // Or zero-config (no-op):
 * const bridge = new OTelBridge();
 * ```
 */
export class OTelBridge {
  private tracer: OTelTracer;

  constructor(tracer?: OTelTracer) {
    this.tracer = tracer ?? NOOP_TRACER;
  }

  /** Replace the tracer at runtime (e.g. after late initialization). */
  setTracer(tracer: OTelTracer): void {
    this.tracer = tracer;
  }

  /** Whether a real tracer (not no-op) is configured. */
  get isEnabled(): boolean {
    return this.tracer !== NOOP_TRACER;
  }

  /**
   * Wrap an async function in a span. Automatically sets status and records
   * exceptions on failure.
   */
  async trace<T>(
    spanName: string,
    attributes: Record<string, string | number | boolean>,
    fn: (span: OTelSpan) => Promise<T>,
  ): Promise<T> {
    const span = this.tracer.startSpan(spanName, { attributes });
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatus.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatus.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof Error) {
        span.recordException(error);
      }
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Wrap a synchronous function in a span.
   */
  traceSync<T>(
    spanName: string,
    attributes: Record<string, string | number | boolean>,
    fn: (span: OTelSpan) => T,
  ): T {
    const span = this.tracer.startSpan(spanName, { attributes });
    try {
      const result = fn(span);
      span.setStatus({ code: SpanStatus.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatus.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof Error) {
        span.recordException(error);
      }
      throw error;
    } finally {
      span.end();
    }
  }

  // -----------------------------------------------------------------------
  // Pre-built span helpers for common orchestrator operations
  // -----------------------------------------------------------------------

  /** Start a span for an agent delegation. Returns the span for manual end(). */
  startDelegation(sourceAgent: string, targetAgent: string, taskId: string): OTelSpan {
    return this.tracer.startSpan('agent.delegation', {
      attributes: {
        'agent.source': sourceAgent,
        'agent.target': targetAgent,
        'task.id': taskId,
      },
    });
  }

  /** Start a span for adapter execution. */
  startAdapterExecution(adapterId: string, agentId: string): OTelSpan {
    return this.tracer.startSpan('adapter.execute', {
      attributes: {
        'adapter.id': adapterId,
        'agent.id': agentId,
      },
    });
  }

  /** Start a span for a blackboard operation. */
  startBlackboardOp(operation: string, key: string, agentId: string): OTelSpan {
    return this.tracer.startSpan(`blackboard.${operation}`, {
      attributes: {
        'blackboard.operation': operation,
        'blackboard.key': key,
        'agent.id': agentId,
      },
    });
  }

  /** Start a span for a permission check. */
  startPermissionCheck(agentId: string, resourceType: string): OTelSpan {
    return this.tracer.startSpan('auth.permission_check', {
      attributes: {
        'agent.id': agentId,
        'auth.resource_type': resourceType,
      },
    });
  }

  /** Start a span for quality gate validation. */
  startQualityGate(agentId: string, key: string): OTelSpan {
    return this.tracer.startSpan('quality.gate', {
      attributes: {
        'agent.id': agentId,
        'quality.key': key,
      },
    });
  }
}
