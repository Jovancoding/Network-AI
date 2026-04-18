/**
 * CostGovernor — Pre-flight budget prediction for task DAGs.
 *
 * Walks a TaskDAG, estimates per-node token spend using a pluggable cost
 * model, and checks the total against FederatedBudget before execution.
 *
 * @module CostGovernor
 */

// ============================================================================
// TYPES
// ============================================================================

/** Per-node cost estimate */
export interface NodeCostEstimate {
  taskId: string;
  agent: string;
  action: string;
  estimatedTokens: number;
  confidence: number; // 0-1
}

/** Full DAG cost prediction */
export interface DAGCostPrediction {
  /** Total estimated tokens across all nodes */
  totalTokens: number;
  /** Per-node breakdown */
  nodes: NodeCostEstimate[];
  /** Whether the prediction fits within the budget */
  withinBudget: boolean;
  /** Budget remaining after predicted spend */
  budgetRemaining: number;
  /** Current budget ceiling */
  budgetCeiling: number;
  /** Per-agent totals */
  perAgent: Record<string, number>;
  /** Agents that would exceed their per-agent ceiling */
  overBudgetAgents: string[];
  /** Average confidence across estimates */
  averageConfidence: number;
}

/** Cost model: maps (agent, action, params) → estimated tokens */
export interface CostModel {
  estimate(agent: string, action: string, params: Record<string, unknown>): { tokens: number; confidence: number };
}

/** Minimal DAG shape — avoids importing from goal-decomposer */
export interface CostDAGNode {
  id: string;
  agent: string;
  action: string;
  params: Record<string, unknown>;
}

/** Minimal budget interface */
export interface CostBudget {
  remaining(): number;
  getCeiling(): number;
  getAgentSpent(agentId: string): number;
  getPerAgentCeiling(): number | undefined;
}

// ============================================================================
// DEFAULT COST MODEL
// ============================================================================

/**
 * Lookup-based cost model. Register per-agent or per-action token estimates.
 * Falls back to a configurable default.
 */
export class LookupCostModel implements CostModel {
  private agentDefaults: Map<string, number> = new Map();
  private actionOverrides: Map<string, number> = new Map();
  private defaultTokens: number;

  constructor(defaultTokens = 500) {
    this.defaultTokens = defaultTokens;
  }

  /** Set default token estimate for an agent */
  setAgentDefault(agent: string, tokens: number): void {
    this.agentDefaults.set(agent, tokens);
  }

  /** Set token estimate for a specific agent:action pair */
  setActionEstimate(agent: string, action: string, tokens: number): void {
    this.actionOverrides.set(`${agent}:${action}`, tokens);
  }

  estimate(agent: string, action: string, _params: Record<string, unknown>): { tokens: number; confidence: number } {
    const key = `${agent}:${action}`;
    if (this.actionOverrides.has(key)) {
      return { tokens: this.actionOverrides.get(key)!, confidence: 0.8 };
    }
    if (this.agentDefaults.has(agent)) {
      return { tokens: this.agentDefaults.get(agent)!, confidence: 0.6 };
    }
    return { tokens: this.defaultTokens, confidence: 0.3 };
  }
}

// ============================================================================
// COST GOVERNOR
// ============================================================================

/**
 * Pre-flight budget check for task DAGs.
 *
 * @example
 * ```ts
 * const governor = new CostGovernor(budget, new LookupCostModel(1000));
 * const prediction = governor.predict(dag.nodes);
 * if (!prediction.withinBudget) {
 *   console.log('DAG would exceed budget by', -prediction.budgetRemaining, 'tokens');
 * }
 *
 * // As approval callback:
 * const options = { approvalCallback: (dag) => governor.approve(dag.nodes) };
 * ```
 */
export class CostGovernor {
  private budget: CostBudget;
  private model: CostModel;

  constructor(budget: CostBudget, model?: CostModel) {
    this.budget = budget;
    this.model = model ?? new LookupCostModel();
  }

  /** Replace the cost model */
  setCostModel(model: CostModel): void {
    this.model = model;
  }

  /**
   * Predict the total cost of a DAG and check against budget.
   */
  predict(nodes: CostDAGNode[]): DAGCostPrediction {
    const estimates: NodeCostEstimate[] = [];
    const perAgent: Record<string, number> = {};

    for (const node of nodes) {
      const { tokens, confidence } = this.model.estimate(node.agent, node.action, node.params);
      estimates.push({
        taskId: node.id,
        agent: node.agent,
        action: node.action,
        estimatedTokens: tokens,
        confidence,
      });
      perAgent[node.agent] = (perAgent[node.agent] ?? 0) + tokens;
    }

    const totalTokens = estimates.reduce((sum, e) => sum + e.estimatedTokens, 0);
    const budgetRemaining = this.budget.remaining() - totalTokens;
    const budgetCeiling = this.budget.getCeiling();
    const perAgentCeiling = this.budget.getPerAgentCeiling();

    // Check per-agent overruns
    const overBudgetAgents: string[] = [];
    if (perAgentCeiling !== undefined) {
      for (const [agent, predicted] of Object.entries(perAgent)) {
        const alreadySpent = this.budget.getAgentSpent(agent);
        if (alreadySpent + predicted > perAgentCeiling) {
          overBudgetAgents.push(agent);
        }
      }
    }

    const avgConfidence = estimates.length > 0
      ? estimates.reduce((s, e) => s + e.confidence, 0) / estimates.length
      : 0;

    return {
      totalTokens,
      nodes: estimates,
      withinBudget: budgetRemaining >= 0 && overBudgetAgents.length === 0,
      budgetRemaining,
      budgetCeiling,
      perAgent,
      overBudgetAgents,
      averageConfidence: avgConfidence,
    };
  }

  /**
   * Approval callback for TeamRunner — returns true if DAG fits budget.
   */
  async approve(nodes: CostDAGNode[]): Promise<boolean> {
    return this.predict(nodes).withinBudget;
  }
}
