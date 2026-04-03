/**
 * Goal Decomposer — LLM-powered goal → task DAG → parallel execution
 *
 * Provides the `runTeam()` one-liner: describe a goal in plain English,
 * specify which agents to use, and let an LLM plan the task graph.
 * Execution respects all Network-AI guardrails (budgets, permissions, audit).
 *
 * Zero external dependencies — LLM calls go through the adapter system.
 *
 * @module GoalDecomposer
 * @version 1.0.0
 */

import { EventEmitter } from 'events';
import type { AgentPayload, AgentContext, AgentResult } from '../types/agent-adapter';

// ============================================================================
// TYPES
// ============================================================================

/** A single node in the task DAG */
export interface TaskNode {
  /** Unique task identifier */
  id: string;
  /** Human-readable description of the task */
  description: string;
  /** Agent ID (or pool/template) to execute this task */
  agent: string;
  /** Action to invoke on the agent */
  action: string;
  /** Parameters for the action */
  params: Record<string, unknown>;
  /** IDs of tasks that must complete before this one starts */
  dependencies: string[];
  /** Priority (higher = more urgent) */
  priority: number;
  /** Execution status */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  /** Result after execution */
  result?: AgentResult;
  /** Error message if failed */
  error?: string;
  /** Timestamps */
  startedAt?: number;
  completedAt?: number;
}

/** Directed acyclic graph of tasks */
export interface TaskDAG {
  /** The original goal */
  goal: string;
  /** All task nodes */
  nodes: TaskNode[];
  /** Adjacency list: taskId → downstream task IDs */
  edges: Map<string, string[]>;
  /** When the DAG was created */
  createdAt: number;
}

/** Configuration for an agent available to the team */
export interface TeamAgent {
  /** Agent ID (must match an adapter-registered agent or be resolvable by the executor) */
  id: string;
  /** What this agent can do (fed to LLM for planning) */
  role: string;
  /** Which adapter handles this agent */
  adapter?: string;
  /** Default action to invoke */
  defaultAction?: string;
  /** Default parameters */
  defaultParams?: Record<string, unknown>;
}

/** Function that invokes an LLM to produce a decomposition plan */
export type PlannerFunction = (
  goal: string,
  agents: TeamAgent[],
  context?: Record<string, unknown>,
) => Promise<PlannedTask[]>;

/** Output from the planner (LLM-generated) */
export interface PlannedTask {
  id: string;
  description: string;
  agent: string;
  action: string;
  params: Record<string, unknown>;
  dependencies: string[];
  priority?: number;
}

/** Function that executes a single task via the adapter system */
export type ExecutorFunction = (
  agentId: string,
  payload: AgentPayload,
  context: AgentContext,
) => Promise<AgentResult>;

/** Options for `runTeam` */
export interface RunTeamOptions {
  /** Maximum number of tasks to run in parallel (default: 5) */
  concurrency?: number;
  /** Timeout per task in ms (default: 30000) */
  taskTimeout?: number;
  /** Timeout for the entire run in ms (default: 300000) */
  totalTimeout?: number;
  /** Whether to continue executing tasks after one fails (default: false) */
  continueOnFailure?: boolean;
  /** Session ID for context propagation */
  sessionId?: string;
  /** Arbitrary metadata passed to agent contexts */
  metadata?: Record<string, unknown>;
  /** Maximum LLM retries for planning (default: 1) */
  plannerRetries?: number;
  /** Callback for approval before execution starts */
  approvalCallback?: (dag: TaskDAG) => Promise<boolean>;
}

/** Final result from a team run */
export interface TeamResult {
  /** Whether the overall goal was achieved */
  success: boolean;
  /** The task graph that was executed */
  dag: TaskDAG;
  /** Aggregated results from all completed tasks */
  results: Map<string, AgentResult>;
  /** Summary of what happened */
  summary: string;
  /** Total execution time in ms */
  durationMs: number;
  /** Count of tasks by status */
  stats: {
    total: number;
    completed: number;
    failed: number;
    skipped: number;
  };
}

/** Events emitted during a team run */
export interface TeamRunnerEvents {
  'dag:created': (dag: TaskDAG) => void;
  'task:start': (node: TaskNode) => void;
  'task:complete': (node: TaskNode, result: AgentResult) => void;
  'task:fail': (node: TaskNode, error: string) => void;
  'task:skip': (node: TaskNode, reason: string) => void;
  'run:complete': (result: TeamResult) => void;
}

// ============================================================================
// DAG UTILITIES
// ============================================================================

/**
 * Validate that a set of planned tasks forms a valid DAG (no cycles, valid refs).
 * @throws Error if the graph contains cycles or invalid dependency references
 */
export function validateDAG(tasks: PlannedTask[]): void {
  const ids = new Set(tasks.map((t) => t.id));

  // Check for duplicate IDs
  if (ids.size !== tasks.length) {
    throw new Error('Duplicate task IDs in plan');
  }

  // Check all dependency references are valid
  for (const task of tasks) {
    for (const dep of task.dependencies) {
      if (!ids.has(dep)) {
        throw new Error(`Task "${task.id}" depends on unknown task "${dep}"`);
      }
      if (dep === task.id) {
        throw new Error(`Task "${task.id}" depends on itself`);
      }
    }
  }

  // Cycle detection via topological sort (Kahn's algorithm)
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const task of tasks) {
    inDegree.set(task.id, 0);
    adj.set(task.id, []);
  }
  for (const task of tasks) {
    for (const dep of task.dependencies) {
      adj.get(dep)!.push(task.id);
      inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited++;
    for (const neighbor of adj.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (visited !== tasks.length) {
    throw new Error('Task graph contains a cycle');
  }
}

/**
 * Compute topological layers — tasks in the same layer can execute in parallel.
 * Returns arrays of task IDs grouped by execution layer.
 */
export function topologicalLayers(tasks: PlannedTask[]): string[][] {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const task of tasks) {
    inDegree.set(task.id, 0);
    adj.set(task.id, []);
  }
  for (const task of tasks) {
    for (const dep of task.dependencies) {
      adj.get(dep)!.push(task.id);
      inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
    }
  }

  const layers: string[][] = [];
  let remaining = new Set(tasks.map((t) => t.id));

  while (remaining.size > 0) {
    const layer: string[] = [];
    for (const id of remaining) {
      if ((inDegree.get(id) ?? 0) === 0) {
        layer.push(id);
      }
    }
    if (layer.length === 0) {
      throw new Error('Cycle detected during layer computation');
    }
    layers.push(layer);
    for (const id of layer) {
      remaining.delete(id);
      for (const neighbor of adj.get(id) ?? []) {
        inDegree.set(neighbor, (inDegree.get(neighbor) ?? 1) - 1);
      }
    }
  }

  return layers;
}

// ============================================================================
// BUILT-IN PLANNER — Structured prompt → LLM → JSON parse
// ============================================================================

/**
 * Create a planner function that uses an LLM (via executor) to decompose goals.
 *
 * The planner sends a structured prompt to the specified agent and parses
 * the JSON response into PlannedTask[]. Falls back gracefully on parse errors.
 *
 * @param executor - Function to call the LLM agent
 * @param plannerAgent - Agent ID for the LLM that does planning
 * @param plannerAdapter - Adapter name (optional, defaults to agent's adapter)
 */
export function createLLMPlanner(
  executor: ExecutorFunction,
  plannerAgent: string,
): PlannerFunction {
  return async (goal: string, agents: TeamAgent[], context?: Record<string, unknown>): Promise<PlannedTask[]> => {
    const agentDescriptions = agents
      .map((a) => `- ${a.id}: ${a.role}${a.defaultAction ? ` (action: ${a.defaultAction})` : ''}`)
      .join('\n');

    const prompt = [
      'You are a task planning agent. Decompose the following goal into a set of tasks.',
      'Each task must be assigned to one of the available agents.',
      'Tasks can depend on other tasks (they will wait for dependencies to complete).',
      'Tasks without dependencies will run in parallel.',
      '',
      `GOAL: ${goal}`,
      '',
      'AVAILABLE AGENTS:',
      agentDescriptions,
      '',
      context ? `CONTEXT: ${JSON.stringify(context)}` : '',
      '',
      'Respond with ONLY a JSON array of task objects. Each object must have:',
      '- "id": unique string identifier (e.g. "task-1")',
      '- "description": what this task does',
      '- "agent": agent ID from the list above',
      '- "action": the action to perform',
      '- "params": object with parameters',
      '- "dependencies": array of task IDs this depends on (empty array if none)',
      '- "priority": number (higher = more urgent, default 1)',
      '',
      'Example:',
      '[{"id":"task-1","description":"Research the topic","agent":"researcher","action":"research","params":{"query":"..."},"dependencies":[],"priority":2},',
      ' {"id":"task-2","description":"Write summary","agent":"writer","action":"write","params":{"input":"from task-1"},"dependencies":["task-1"],"priority":1}]',
    ].filter(Boolean).join('\n');

    const payload: AgentPayload = {
      action: 'plan',
      params: { prompt, goal, agents: agents.map((a) => ({ id: a.id, role: a.role })) },
    };

    const result = await executor(plannerAgent, payload, {
      agentId: plannerAgent,
      taskId: `plan-${Date.now()}`,
      metadata: { type: 'goal-decomposition', ...(context ?? {}) },
    });

    if (!result.success || !result.data) {
      throw new Error(`Planner agent failed: ${result.error?.message ?? 'no data returned'}`);
    }

    // Parse the LLM response — handle both string and pre-parsed responses
    let tasks: PlannedTask[];
    if (Array.isArray(result.data)) {
      tasks = result.data as PlannedTask[];
    } else if (typeof result.data === 'string') {
      tasks = parsePlanJSON(result.data);
    } else if (typeof result.data === 'object' && result.data !== null) {
      const dataObj = result.data as Record<string, unknown>;
      if (Array.isArray(dataObj.tasks)) {
        tasks = dataObj.tasks as PlannedTask[];
      } else if (typeof dataObj.text === 'string') {
        tasks = parsePlanJSON(dataObj.text);
      } else if (typeof dataObj.content === 'string') {
        tasks = parsePlanJSON(dataObj.content);
      } else {
        throw new Error('Planner returned unrecognized data shape');
      }
    } else {
      throw new Error('Planner returned unrecognized data type');
    }

    // Validate required fields
    for (const task of tasks) {
      if (!task.id || typeof task.id !== 'string') throw new Error('Task missing "id"');
      if (!task.description || typeof task.description !== 'string') throw new Error(`Task "${task.id}" missing "description"`);
      if (!task.agent || typeof task.agent !== 'string') throw new Error(`Task "${task.id}" missing "agent"`);
      if (!task.action || typeof task.action !== 'string') throw new Error(`Task "${task.id}" missing "action"`);
      if (!task.params || typeof task.params !== 'object') task.params = {};
      if (!Array.isArray(task.dependencies)) task.dependencies = [];
      if (typeof task.priority !== 'number') task.priority = 1;
    }

    return tasks;
  };
}

/**
 * Parse JSON from an LLM response string, handling markdown fences and preamble.
 */
export function parsePlanJSON(text: string): PlannedTask[] {
  // Strip markdown code fences (indexOf-based to avoid ReDoS — CodeQL #105)
  let cleaned = text.trim();
  const fenceOpen = cleaned.indexOf('```');
  if (fenceOpen !== -1) {
    const afterOpen = cleaned.indexOf('\n', fenceOpen);
    const fenceClose = cleaned.indexOf('```', afterOpen !== -1 ? afterOpen : fenceOpen + 3);
    if (afterOpen !== -1 && fenceClose > afterOpen) {
      cleaned = cleaned.substring(afterOpen + 1, fenceClose).trim();
    }
  }

  // Find the JSON array in the text
  const arrayStart = cleaned.indexOf('[');
  const arrayEnd = cleaned.lastIndexOf(']');
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    cleaned = cleaned.substring(arrayStart, arrayEnd + 1);
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) {
      throw new Error('Expected JSON array of tasks');
    }
    return parsed;
  } catch (err) {
    throw new Error(`Failed to parse planner response as JSON: ${(err as Error).message}`);
  }
}

// ============================================================================
// GOAL DECOMPOSER
// ============================================================================

/**
 * LLM-powered goal decomposition engine.
 *
 * Takes a natural language goal, creates a task DAG via an LLM planner,
 * validates the graph, and returns a ready-to-execute TaskDAG.
 */
export class GoalDecomposer {
  private planner: PlannerFunction;

  constructor(planner: PlannerFunction) {
    this.planner = planner;
  }

  /**
   * Decompose a goal into a validated TaskDAG.
   * @param goal - Natural language description of the goal
   * @param agents - Available team agents
   * @param context - Optional context to feed to the planner
   * @param retries - Number of retries on planning failure (default: 1)
   */
  async decompose(
    goal: string,
    agents: TeamAgent[],
    context?: Record<string, unknown>,
    retries = 1,
  ): Promise<TaskDAG> {
    if (!goal || typeof goal !== 'string' || goal.trim().length === 0) {
      throw new Error('Goal must be a non-empty string');
    }
    if (!agents || agents.length === 0) {
      throw new Error('At least one agent is required');
    }
    // Validate agent IDs are unique
    const agentIds = new Set(agents.map((a) => a.id));
    if (agentIds.size !== agents.length) {
      throw new Error('Duplicate agent IDs');
    }

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const planned = await this.planner(goal, agents, context);
        validateDAG(planned);

        // Validate that all assigned agents exist in the team
        for (const task of planned) {
          if (!agentIds.has(task.agent)) {
            throw new Error(`Task "${task.id}" assigned to unknown agent "${task.agent}"`);
          }
        }

        // Build the TaskDAG
        const nodes: TaskNode[] = planned.map((t) => ({
          id: t.id,
          description: t.description,
          agent: t.agent,
          action: t.action,
          params: t.params,
          dependencies: t.dependencies,
          priority: t.priority ?? 1,
          status: 'pending' as const,
        }));

        const edges = new Map<string, string[]>();
        for (const task of planned) {
          edges.set(task.id, []);
        }
        for (const task of planned) {
          for (const dep of task.dependencies) {
            edges.get(dep)!.push(task.id);
          }
        }

        return { goal, nodes, edges, createdAt: Date.now() };
      } catch (err) {
        lastError = err as Error;
        if (attempt < retries) continue;
      }
    }

    throw lastError ?? new Error('Planning failed');
  }
}

// ============================================================================
// TEAM RUNNER — The one-liner execution engine
// ============================================================================

/**
 * Executes a TaskDAG by running tasks in parallel layers, respecting
 * dependencies, concurrency limits, and timeouts.
 *
 * @example
 * ```typescript
 * const runner = new TeamRunner(executor);
 * const result = await runner.run(dag, { concurrency: 3 });
 * console.log(result.summary);
 * ```
 */
export class TeamRunner extends EventEmitter {
  private executor: ExecutorFunction;

  constructor(executor: ExecutorFunction) {
    super();
    this.executor = executor;
  }

  /**
   * Execute a TaskDAG with parallel scheduling.
   */
  async run(dag: TaskDAG, options: RunTeamOptions = {}): Promise<TeamResult> {
    const {
      concurrency = 5,
      taskTimeout = 30_000,
      totalTimeout = 300_000,
      continueOnFailure = false,
      sessionId,
      metadata,
    } = options;

    const start = Date.now();
    const deadline = start + totalTimeout;
    const results = new Map<string, AgentResult>();
    const nodeMap = new Map<string, TaskNode>();
    for (const node of dag.nodes) {
      nodeMap.set(node.id, node);
    }

    this.emit('dag:created', dag);

    // Compute layers for parallel execution
    const planned = dag.nodes.map((n) => ({
      id: n.id,
      description: n.description,
      agent: n.agent,
      action: n.action,
      params: n.params,
      dependencies: n.dependencies,
      priority: n.priority,
    }));
    const layers = topologicalLayers(planned);

    let aborted = false;

    for (const layer of layers) {
      if (aborted) break;

      // Check total timeout
      if (Date.now() >= deadline) {
        for (const taskId of layer) {
          const node = nodeMap.get(taskId)!;
          node.status = 'skipped';
          node.error = 'Total timeout exceeded';
          this.emit('task:skip', node, 'Total timeout exceeded');
        }
        aborted = true;
        break;
      }

      // Sort by priority within the layer (higher first)
      const sorted = [...layer].sort((a, b) => {
        const na = nodeMap.get(a)!;
        const nb = nodeMap.get(b)!;
        return nb.priority - na.priority;
      });

      // Execute in batches respecting concurrency
      for (let i = 0; i < sorted.length; i += concurrency) {
        if (aborted) break;
        const batch = sorted.slice(i, i + concurrency);

        const batchPromises = batch.map(async (taskId) => {
          const node = nodeMap.get(taskId)!;

          // Skip if a dependency failed and we're not continuing on failure
          if (!continueOnFailure) {
            for (const depId of node.dependencies) {
              const dep = nodeMap.get(depId);
              if (dep && dep.status === 'failed') {
                node.status = 'skipped';
                node.error = `Dependency "${depId}" failed`;
                this.emit('task:skip', node, node.error);
                return;
              }
            }
          }

          node.status = 'running';
          node.startedAt = Date.now();
          this.emit('task:start', node);

          // Build payload with dependency results injected
          const depResults: Record<string, unknown> = {};
          for (const depId of node.dependencies) {
            const depResult = results.get(depId);
            if (depResult) depResults[depId] = depResult.data;
          }

          const payload: AgentPayload = {
            action: node.action,
            params: { ...node.params, _dependencyResults: depResults },
          };

          const context: AgentContext = {
            agentId: node.agent,
            taskId: node.id,
            sessionId,
            metadata: { ...metadata, goal: dag.goal, layer: layers.indexOf(layer) },
          };

          try {
            const result = await withTimeout(
              this.executor(node.agent, payload, context),
              taskTimeout,
              `Task "${taskId}" timed out after ${taskTimeout}ms`,
            );

            results.set(taskId, result);

            if (result.success) {
              node.status = 'completed';
              node.result = result;
              node.completedAt = Date.now();
              this.emit('task:complete', node, result);
            } else {
              node.status = 'failed';
              node.error = result.error?.message ?? 'Agent returned failure';
              node.result = result;
              node.completedAt = Date.now();
              this.emit('task:fail', node, node.error);
              if (!continueOnFailure) aborted = true;
            }
          } catch (err) {
            const errMsg = (err as Error).message ?? String(err);
            node.status = 'failed';
            node.error = errMsg;
            node.completedAt = Date.now();
            this.emit('task:fail', node, errMsg);
            results.set(taskId, {
              success: false,
              error: { code: 'EXECUTION_ERROR', message: errMsg, recoverable: false },
            });
            if (!continueOnFailure) aborted = true;
          }
        });

        await Promise.all(batchPromises);
      }
    }

    // Skip remaining unexecuted nodes
    for (const node of dag.nodes) {
      if (node.status === 'pending') {
        node.status = 'skipped';
        node.error = aborted ? 'Aborted due to prior failure' : 'Not reached';
        this.emit('task:skip', node, node.error!);
      }
    }

    const stats = {
      total: dag.nodes.length,
      completed: dag.nodes.filter((n) => n.status === 'completed').length,
      failed: dag.nodes.filter((n) => n.status === 'failed').length,
      skipped: dag.nodes.filter((n) => n.status === 'skipped').length,
    };

    const success = stats.failed === 0 && stats.skipped === 0;
    const durationMs = Date.now() - start;
    const summary = `Goal: "${dag.goal}" — ${stats.completed}/${stats.total} tasks completed${stats.failed ? `, ${stats.failed} failed` : ''}${stats.skipped ? `, ${stats.skipped} skipped` : ''} in ${durationMs}ms`;

    const teamResult: TeamResult = { success, dag, results, summary, durationMs, stats };
    this.emit('run:complete', teamResult);
    return teamResult;
  }
}

// ============================================================================
// runTeam() — THE ONE-LINER
// ============================================================================

/**
 * Decompose a goal into tasks and execute them with a team of agents.
 *
 * This is the main entry point — one line to go from goal to results:
 *
 * ```typescript
 * const result = await runTeam(
 *   "Build a REST API for user management",
 *   [
 *     { id: "architect", role: "System design and API specification" },
 *     { id: "coder", role: "Write TypeScript code" },
 *     { id: "reviewer", role: "Code review and quality checks" },
 *   ],
 *   { planner, executor }
 * );
 * ```
 *
 * @param goal - Natural language description of what to achieve
 * @param agents - Team of agents available for task execution
 * @param config - Planner (LLM decomposition) and executor (agent invocation) functions
 * @param options - Optional concurrency, timeout, and failure handling settings
 * @returns Full result with DAG, individual results, and stats
 */
export async function runTeam(
  goal: string,
  agents: TeamAgent[],
  config: { planner: PlannerFunction; executor: ExecutorFunction },
  options: RunTeamOptions = {},
): Promise<TeamResult> {
  const decomposer = new GoalDecomposer(config.planner);
  const runner = new TeamRunner(config.executor);

  const dag = await decomposer.decompose(
    goal,
    agents,
    options.metadata,
    options.plannerRetries ?? 1,
  );

  // Optional approval gate
  if (options.approvalCallback) {
    const approved = await options.approvalCallback(dag);
    if (!approved) {
      // Mark all tasks as skipped
      for (const node of dag.nodes) {
        node.status = 'skipped';
        node.error = 'Execution not approved';
      }
      return {
        success: false,
        dag,
        results: new Map(),
        summary: `Goal: "${goal}" — execution not approved`,
        durationMs: 0,
        stats: { total: dag.nodes.length, completed: 0, failed: 0, skipped: dag.nodes.length },
      };
    }
  }

  return runner.run(dag, options);
}

// ============================================================================
// HELPERS
// ============================================================================

/** Promise wrapper that rejects after a timeout */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  if (ms <= 0 || ms === Infinity) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
