/**
 * AgentConversationLog — Per-agent execution & dialogue history.
 *
 * Tracks every task execution, tool invocation, and token usage for each agent
 * so operators can click an agent in the topology and inspect its full history.
 *
 * @module AgentConversation
 */

// ============================================================================
// TYPES
// ============================================================================

/** A single turn / execution entry for an agent */
export interface AgentTurn {
  /** Auto-incrementing turn number for this agent */
  turnNumber: number;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Task instruction or message sent to the agent */
  instruction: string;
  /** Truncated result (first 2000 chars of JSON) */
  result?: string;
  /** Whether the execution succeeded */
  success: boolean;
  /** Error code if failed */
  errorCode?: string;
  /** Tokens consumed in this turn */
  tokensUsed?: number;
  /** Execution wall-time in ms */
  executionTimeMs?: number;
  /** Adapter framework that handled this turn */
  adapter?: string;
  /** Retry attempts needed */
  retryAttempts?: number;
  /** Quality gate outcome */
  qualityDecision?: string;
  /** Correlation id linking to EventBus / ExplainabilityTracer */
  correlationId?: string;
  /** Source agent that delegated this task */
  sourceAgent?: string;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

/** Aggregate stats for one agent */
export interface AgentStats {
  totalTurns: number;
  successCount: number;
  failureCount: number;
  totalTokensUsed: number;
  totalExecutionTimeMs: number;
  averageExecutionTimeMs: number;
  lastActivityAt: string | null;
}

/** Full conversation record for one agent */
export interface AgentConversation {
  agentId: string;
  turns: AgentTurn[];
  stats: AgentStats;
}

// ============================================================================
// CONVERSATION LOG
// ============================================================================

/**
 * Collects per-agent execution history.
 *
 * @example
 * ```ts
 * const log = new AgentConversationLog();
 * log.recordTurn('agent-1', {
 *   instruction: 'Summarize the document',
 *   success: true,
 *   tokensUsed: 450,
 *   executionTimeMs: 1200,
 * });
 * const conv = log.getConversation('agent-1');
 * // conv.turns.length === 1
 * // conv.stats.totalTokensUsed === 450
 * ```
 */
export class AgentConversationLog {
  private conversations: Map<string, { turns: AgentTurn[]; turnCounter: number }> = new Map();
  private maxTurnsPerAgent: number;

  constructor(options?: { maxTurnsPerAgent?: number }) {
    this.maxTurnsPerAgent = options?.maxTurnsPerAgent ?? 500;
  }

  /**
   * Record a turn for an agent. Returns the assigned turn number.
   */
  recordTurn(
    agentId: string,
    turn: Omit<AgentTurn, 'turnNumber' | 'timestamp'> & { timestamp?: string },
  ): number {
    let record = this.conversations.get(agentId);
    if (!record) {
      record = { turns: [], turnCounter: 0 };
      this.conversations.set(agentId, record);
    }

    const turnNumber = ++record.turnCounter;
    const full: AgentTurn = {
      turnNumber,
      timestamp: turn.timestamp ?? new Date().toISOString(),
      instruction: turn.instruction,
      result: turn.result,
      success: turn.success,
      errorCode: turn.errorCode,
      tokensUsed: turn.tokensUsed,
      executionTimeMs: turn.executionTimeMs,
      retryAttempts: turn.retryAttempts,
      adapter: turn.adapter,
      qualityDecision: turn.qualityDecision,
      correlationId: turn.correlationId,
      sourceAgent: turn.sourceAgent,
      metadata: turn.metadata,
    };

    record.turns.push(full);

    // Evict oldest
    if (record.turns.length > this.maxTurnsPerAgent) {
      record.turns.splice(0, record.turns.length - this.maxTurnsPerAgent);
    }

    return turnNumber;
  }

  /**
   * Get the full conversation for an agent.
   */
  getConversation(agentId: string): AgentConversation | null {
    const record = this.conversations.get(agentId);
    if (!record) return null;

    return {
      agentId,
      turns: [...record.turns],
      stats: this.computeStats(record.turns),
    };
  }

  /**
   * Get stats for an agent without copying all turns.
   */
  getStats(agentId: string): AgentStats | null {
    const record = this.conversations.get(agentId);
    if (!record) return null;
    return this.computeStats(record.turns);
  }

  /**
   * Get the most recent N turns for an agent.
   */
  getRecentTurns(agentId: string, count: number): AgentTurn[] {
    const record = this.conversations.get(agentId);
    if (!record) return [];
    return record.turns.slice(-count);
  }

  /**
   * List all agent IDs that have recorded turns.
   */
  listAgents(): string[] {
    return [...this.conversations.keys()];
  }

  /**
   * Clear the conversation history for a specific agent.
   */
  clearAgent(agentId: string): void {
    this.conversations.delete(agentId);
  }

  /**
   * Clear all conversations.
   */
  clear(): void {
    this.conversations.clear();
  }

  /**
   * Total number of turns across all agents.
   */
  get totalTurns(): number {
    let sum = 0;
    for (const record of this.conversations.values()) {
      sum += record.turns.length;
    }
    return sum;
  }

  private computeStats(turns: AgentTurn[]): AgentStats {
    let successCount = 0;
    let failureCount = 0;
    let totalTokensUsed = 0;
    let totalExecutionTimeMs = 0;

    for (const t of turns) {
      if (t.success) successCount++;
      else failureCount++;
      totalTokensUsed += t.tokensUsed ?? 0;
      totalExecutionTimeMs += t.executionTimeMs ?? 0;
    }

    return {
      totalTurns: turns.length,
      successCount,
      failureCount,
      totalTokensUsed,
      totalExecutionTimeMs,
      averageExecutionTimeMs: turns.length > 0 ? totalExecutionTimeMs / turns.length : 0,
      lastActivityAt: turns.length > 0 ? turns[turns.length - 1].timestamp : null,
    };
  }
}
