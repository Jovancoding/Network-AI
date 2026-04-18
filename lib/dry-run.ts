/**
 * DryRunSimulator — Simulate a task DAG execution with zero side effects.
 *
 * Walks a TaskDAG using topological layers, produces per-node estimated
 * costs, permission requirements, and a synthetic TeamResult — without
 * touching adapters, the blackboard, or spending any budget.
 *
 * @module DryRunSimulator
 */

import type { DAGCostPrediction, CostModel, CostDAGNode } from './cost-governor';
import { CostGovernor, LookupCostModel } from './cost-governor';

// ============================================================================
// TYPES
// ============================================================================

/** Per-node simulation result */
export interface SimulatedNode {
  taskId: string;
  agent: string;
  action: string;
  estimatedTokens: number;
  confidence: number;
  dependencies: string[];
  layer: number;
}

/** Full dry-run report */
export interface DryRunReport {
  /** Whether the plan could execute within budget constraints */
  feasible: boolean;
  /** Human-readable summary */
  summary: string;
  /** Per-node simulation */
  nodes: SimulatedNode[];
  /** Topological layers — tasks within a layer run in parallel */
  layers: string[][];
  /** Cost prediction from CostGovernor */
  costPrediction: DAGCostPrediction;
  /** Total estimated wall-clock layers (sequential depth) */
  parallelDepth: number;
  /** Maximum parallel width (largest layer size) */
  maxParallelWidth: number;
}

/** Minimal DAG node with dependencies for topological ordering */
export interface DryRunNode extends CostDAGNode {
  dependencies: string[];
}

/** Minimal budget interface (same as CostBudget) */
export interface DryRunBudget {
  remaining(): number;
  getCeiling(): number;
  getAgentSpent(agentId: string): number;
  getPerAgentCeiling(): number | undefined;
}

// ============================================================================
// TOPOLOGICAL LAYER COMPUTATION
// ============================================================================

function computeLayers(nodes: DryRunNode[]): string[][] {
  const nodeMap = new Map<string, DryRunNode>();
  const inDegree = new Map<string, number>();
  const downstream = new Map<string, string[]>();

  for (const n of nodes) {
    nodeMap.set(n.id, n);
    inDegree.set(n.id, 0);
    downstream.set(n.id, []);
  }

  for (const n of nodes) {
    for (const dep of n.dependencies) {
      if (downstream.has(dep)) {
        downstream.get(dep)!.push(n.id);
      }
      inDegree.set(n.id, (inDegree.get(n.id) ?? 0) + 1);
    }
  }

  const layers: string[][] = [];
  let queue = nodes.filter(n => (inDegree.get(n.id) ?? 0) === 0).map(n => n.id);

  while (queue.length > 0) {
    layers.push([...queue]);
    const next: string[] = [];
    for (const id of queue) {
      for (const child of (downstream.get(id) ?? [])) {
        const newDeg = (inDegree.get(child) ?? 1) - 1;
        inDegree.set(child, newDeg);
        if (newDeg === 0) next.push(child);
      }
    }
    queue = next;
  }
  return layers;
}

// ============================================================================
// DRY-RUN SIMULATOR
// ============================================================================

/**
 * Simulate a DAG execution plan without side effects.
 *
 * @example
 * ```ts
 * const sim = new DryRunSimulator(budget);
 * const report = sim.simulate(dag.nodes.map(n => ({
 *   id: n.id, agent: n.agent, action: n.action,
 *   params: n.params, dependencies: n.dependencies,
 * })));
 * console.log(report.summary);
 * ```
 */
export class DryRunSimulator {
  private governor: CostGovernor;

  constructor(budget: DryRunBudget, model?: CostModel) {
    this.governor = new CostGovernor(budget, model ?? new LookupCostModel());
  }

  /** Replace the underlying cost model */
  setCostModel(model: CostModel): void {
    this.governor.setCostModel(model);
  }

  /**
   * Simulate execution of a DAG. Returns a full report with cost predictions,
   * layer structure, and feasibility assessment.
   */
  simulate(nodes: DryRunNode[]): DryRunReport {
    const layers = computeLayers(nodes);
    const costPrediction = this.governor.predict(nodes);

    const nodeMap = new Map<string, DryRunNode>();
    for (const n of nodes) nodeMap.set(n.id, n);

    // Assign layer number to each node
    const layerOf = new Map<string, number>();
    for (let i = 0; i < layers.length; i++) {
      for (const id of layers[i]) layerOf.set(id, i);
    }

    const simNodes: SimulatedNode[] = costPrediction.nodes.map(est => {
      const orig = nodeMap.get(est.taskId);
      return {
        taskId: est.taskId,
        agent: est.agent,
        action: est.action,
        estimatedTokens: est.estimatedTokens,
        confidence: est.confidence,
        dependencies: orig?.dependencies ?? [],
        layer: layerOf.get(est.taskId) ?? 0,
      };
    });

    const maxParallelWidth = layers.reduce((m, l) => Math.max(m, l.length), 0);

    const feasible = costPrediction.withinBudget;
    const overBudget = costPrediction.overBudgetAgents;

    let summary = `Plan: ${nodes.length} task(s) in ${layers.length} layer(s), max parallelism ${maxParallelWidth}. `;
    summary += `Estimated tokens: ${costPrediction.totalTokens} / ${costPrediction.budgetCeiling} budget. `;
    if (feasible) {
      summary += `Budget OK — ${costPrediction.budgetRemaining} tokens remaining after execution.`;
    } else if (overBudget.length > 0) {
      summary += `OVER BUDGET — agents exceeding per-agent ceiling: ${overBudget.join(', ')}.`;
    } else {
      summary += `OVER BUDGET — would exceed global ceiling by ${-costPrediction.budgetRemaining} tokens.`;
    }

    return {
      feasible,
      summary,
      nodes: simNodes,
      layers,
      costPrediction,
      parallelDepth: layers.length,
      maxParallelWidth,
    };
  }
}
