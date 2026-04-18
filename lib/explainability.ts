/**
 * ExplainabilityTracer — structured decision cards for agent actions.
 *
 * Records every significant decision made during task orchestration so that
 * operators can audit *why* a particular outcome was produced.
 *
 * @module explainability
 */

/** A single factor that influenced a decision. */
export interface DecisionFactor {
  name: string;
  value: unknown;
  weight?: number;
  description?: string;
}

/** Structured record of one orchestrator decision. */
export interface DecisionCard {
  /** Unique trace id */
  traceId: string;
  /** ISO timestamp */
  timestamp: string;
  /** Which component made the decision */
  source: string;
  /** Short label for the decision type */
  decision: string;
  /** The outcome chosen */
  outcome: string;
  /** Factors that contributed */
  factors: DecisionFactor[];
  /** Parent trace (e.g. the delegation that spawned this) */
  parentTraceId?: string;
  /** Agent involved, if any */
  agentId?: string;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Collects decision cards during a session.
 *
 * Usage:
 * ```ts
 * const tracer = new ExplainabilityTracer();
 * tracer.record({
 *   source: 'AuthGuardian',
 *   decision: 'permission_check',
 *   outcome: 'granted',
 *   factors: [{ name: 'trust_level', value: 0.8 }],
 * });
 * const cards = tracer.getTrace(traceId);
 * ```
 */
export class ExplainabilityTracer {
  private cards: DecisionCard[] = [];
  private maxCards: number;

  constructor(options?: { maxCards?: number }) {
    this.maxCards = options?.maxCards ?? 10_000;
  }

  /**
   * Record a decision card. Returns the generated traceId.
   */
  record(
    card: Omit<DecisionCard, 'traceId' | 'timestamp'> & { traceId?: string; timestamp?: string },
  ): string {
    const traceId = card.traceId ?? this.generateId();
    const full: DecisionCard = {
      traceId,
      timestamp: card.timestamp ?? new Date().toISOString(),
      source: card.source,
      decision: card.decision,
      outcome: card.outcome,
      factors: card.factors,
      parentTraceId: card.parentTraceId,
      agentId: card.agentId,
      metadata: card.metadata,
    };
    this.cards.push(full);
    // Evict oldest when over limit
    if (this.cards.length > this.maxCards) {
      this.cards.splice(0, this.cards.length - this.maxCards);
    }
    return traceId;
  }

  /** Get a single card by traceId. */
  getCard(traceId: string): DecisionCard | undefined {
    return this.cards.find((c) => c.traceId === traceId);
  }

  /** Get all cards sharing a parentTraceId — i.e. the full trace tree for a delegation. */
  getTrace(parentTraceId: string): DecisionCard[] {
    return this.cards.filter(
      (c) => c.traceId === parentTraceId || c.parentTraceId === parentTraceId,
    );
  }

  /** Get cards filtered by source, decision type, agent, or time range. */
  query(filter: {
    source?: string;
    decision?: string;
    agentId?: string;
    since?: string;
    until?: string;
  }): DecisionCard[] {
    return this.cards.filter((c) => {
      if (filter.source && c.source !== filter.source) return false;
      if (filter.decision && c.decision !== filter.decision) return false;
      if (filter.agentId && c.agentId !== filter.agentId) return false;
      if (filter.since && c.timestamp < filter.since) return false;
      if (filter.until && c.timestamp > filter.until) return false;
      return true;
    });
  }

  /** Total number of recorded cards. */
  get size(): number {
    return this.cards.length;
  }

  /** Clear all recorded cards. */
  clear(): void {
    this.cards.length = 0;
  }

  /** Export all cards as a JSON-serializable array. */
  export(): DecisionCard[] {
    return [...this.cards];
  }

  private generateId(): string {
    // Simple random hex id (no crypto dependency needed for trace ids)
    const bytes = new Uint8Array(12);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
}
