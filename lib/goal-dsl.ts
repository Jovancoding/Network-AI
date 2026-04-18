/**
 * Goal DSL — Schema-driven goal definitions for swarm orchestration
 *
 * Provides a declarative way to define multi-agent goals with constraints,
 * dependencies, and validation rules. Goals can be defined in TypeScript
 * objects or parsed from YAML/JSON strings.
 *
 * Features:
 *   - Typed GoalDefinition with tasks, constraints, and outputs
 *   - Dependency graph validation (cycle detection, missing refs)
 *   - Constraint checking (budget, timeout, required agents)
 *   - YAML/JSON parsing (YAML via simple built-in parser, no deps)
 *   - Goal compilation to executable task DAGs
 *
 * Usage:
 *   const goal = parseGoal(`
 *     name: research-and-summarize
 *     tasks:
 *       - id: research
 *         agent: researcher
 *         action: search
 *       - id: summarize
 *         agent: writer
 *         action: summarize
 *         depends: [research]
 *   `);
 *   const plan = compileGoal(goal);
 *
 * @module GoalDSL
 * @version 1.0.0
 */

// ============================================================================
// TYPES
// ============================================================================

/** A single task within a goal */
export interface GoalTask {
  /** Unique task ID within this goal */
  id: string;
  /** Agent or adapter:agent to execute this task */
  agent: string;
  /** Action/instruction for the agent */
  action: string;
  /** Task IDs this depends on (must complete before this starts) */
  depends?: string[];
  /** Parameters to pass to the agent */
  params?: Record<string, unknown>;
  /** Per-task timeout in ms */
  timeoutMs?: number;
  /** Whether failure of this task fails the entire goal (default: true) */
  critical?: boolean;
  /** Retry count (default: 0) */
  retries?: number;
  /** Output key — result stored under this key for downstream tasks */
  outputKey?: string;
}

/** Constraints on goal execution */
export interface GoalConstraints {
  /** Maximum total budget */
  maxBudget?: number;
  /** Maximum total time in ms */
  maxTimeMs?: number;
  /** Required agent capabilities */
  requiredCapabilities?: string[];
  /** Maximum parallel tasks */
  maxParallelism?: number;
  /** Minimum confidence threshold for results */
  minConfidence?: number;
}

/** Expected output definition */
export interface GoalOutput {
  /** Output key name */
  key: string;
  /** Expected type ('string' | 'number' | 'object' | 'array' | 'boolean') */
  type?: string;
  /** Whether this output is required (default: true) */
  required?: boolean;
  /** Description of the output */
  description?: string;
}

/** Complete goal definition */
export interface GoalDefinition {
  /** Goal name */
  name: string;
  /** Goal description */
  description?: string;
  /** Version */
  version?: string;
  /** Tasks to execute */
  tasks: GoalTask[];
  /** Execution constraints */
  constraints?: GoalConstraints;
  /** Expected outputs */
  outputs?: GoalOutput[];
  /** Metadata */
  metadata?: Record<string, unknown>;
}

/** Validation error */
export interface GoalValidationError {
  /** Error type */
  type: 'missing_dependency' | 'cycle' | 'duplicate_id' | 'empty_tasks' | 'invalid_field' | 'missing_agent';
  /** Human-readable message */
  message: string;
  /** Related task ID */
  taskId?: string;
}

/** Validation result */
export interface GoalValidationResult {
  /** Whether the goal is valid */
  valid: boolean;
  /** Validation errors */
  errors: GoalValidationError[];
}

/** Compiled execution layer (tasks that can run in parallel) */
export interface ExecutionLayer {
  /** Layer index (0 = first) */
  index: number;
  /** Task IDs in this layer */
  taskIds: string[];
}

/** Compiled goal — ready for execution */
export interface CompiledGoal {
  /** Original goal definition */
  definition: GoalDefinition;
  /** Execution layers (topologically sorted) */
  layers: ExecutionLayer[];
  /** Total parallel depth */
  depth: number;
  /** Maximum width (max tasks in a single layer) */
  maxWidth: number;
  /** All task IDs in execution order */
  taskOrder: string[];
  /** Dependency adjacency map */
  adjacency: Map<string, string[]>;
}

// ============================================================================
// PARSER
// ============================================================================

/**
 * Parse a goal from a YAML-like or JSON string.
 *
 * Supports a simple YAML subset (no anchors, tags, or multi-doc):
 *   - Key: value pairs
 *   - Lists with `- item` syntax
 *   - Inline arrays `[a, b, c]`
 *   - Nested indentation
 *   - JSON input (auto-detected)
 */
export function parseGoal(input: string): GoalDefinition {
  const trimmed = input.trim();

  // Try JSON first
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as GoalDefinition;
    return normalizeGoal(parsed);
  }

  // Simple YAML-like parser
  return parseSimpleYaml(trimmed);
}

/** Parse from a plain object (e.g. loaded from file) */
export function goalFromObject(obj: Record<string, unknown>): GoalDefinition {
  return normalizeGoal(obj as unknown as GoalDefinition);
}

// ============================================================================
// VALIDATOR
// ============================================================================

/**
 * Validate a goal definition for correctness.
 * Checks for cycles, missing dependencies, duplicate IDs, and required fields.
 */
export function validateGoal(goal: GoalDefinition): GoalValidationResult {
  const errors: GoalValidationError[] = [];

  // Empty tasks
  if (!goal.tasks || goal.tasks.length === 0) {
    errors.push({ type: 'empty_tasks', message: 'Goal must have at least one task' });
    return { valid: false, errors };
  }

  // Duplicate IDs
  const idSet = new Set<string>();
  for (const task of goal.tasks) {
    if (idSet.has(task.id)) {
      errors.push({ type: 'duplicate_id', message: `Duplicate task ID: '${task.id}'`, taskId: task.id });
    }
    idSet.add(task.id);
  }

  // Required fields
  for (const task of goal.tasks) {
    if (!task.id || typeof task.id !== 'string') {
      errors.push({ type: 'invalid_field', message: 'Task missing required field: id', taskId: task.id });
    }
    if (!task.agent || typeof task.agent !== 'string') {
      errors.push({ type: 'missing_agent', message: `Task '${task.id}' missing required field: agent`, taskId: task.id });
    }
    if (!task.action || typeof task.action !== 'string') {
      errors.push({ type: 'invalid_field', message: `Task '${task.id}' missing required field: action`, taskId: task.id });
    }
  }

  // Missing dependencies
  for (const task of goal.tasks) {
    if (task.depends) {
      for (const dep of task.depends) {
        if (!idSet.has(dep)) {
          errors.push({
            type: 'missing_dependency',
            message: `Task '${task.id}' depends on unknown task '${dep}'`,
            taskId: task.id,
          });
        }
      }
    }
  }

  // Cycle detection (Kahn's algorithm)
  if (errors.length === 0) {
    const hasCycle = detectCycle(goal.tasks);
    if (hasCycle) {
      errors.push({ type: 'cycle', message: 'Goal task graph contains a cycle' });
    }
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================================
// COMPILER
// ============================================================================

/**
 * Compile a validated goal into an executable plan with layered parallelism.
 * Performs topological sort to determine execution layers.
 *
 * @throws If the goal is invalid.
 */
export function compileGoal(goal: GoalDefinition): CompiledGoal {
  const validation = validateGoal(goal);
  if (!validation.valid) {
    throw new Error(`Invalid goal: ${validation.errors.map((e) => e.message).join('; ')}`);
  }

  const adjacency = new Map<string, string[]>();

  // Build adjacency (task → dependents)
  for (const task of goal.tasks) {
    if (!adjacency.has(task.id)) adjacency.set(task.id, []);
    if (task.depends) {
      for (const dep of task.depends) {
        const deps = adjacency.get(dep) ?? [];
        deps.push(task.id);
        adjacency.set(dep, deps);
      }
    }
  }

  // Topological sort into layers
  const inDegree = new Map<string, number>();
  for (const task of goal.tasks) {
    inDegree.set(task.id, task.depends?.length ?? 0);
  }

  const layers: ExecutionLayer[] = [];
  const taskOrder: string[] = [];
  const remaining = new Set(goal.tasks.map((t) => t.id));

  let layerIndex = 0;
  while (remaining.size > 0) {
    const ready: string[] = [];
    for (const id of remaining) {
      if ((inDegree.get(id) ?? 0) <= 0) {
        ready.push(id);
      }
    }

    if (ready.length === 0) break; // Safety: shouldn't happen after validation

    layers.push({ index: layerIndex++, taskIds: ready });
    taskOrder.push(...ready);

    for (const id of ready) {
      remaining.delete(id);
      const dependents = adjacency.get(id) ?? [];
      for (const dep of dependents) {
        inDegree.set(dep, (inDegree.get(dep) ?? 1) - 1);
      }
    }
  }

  const maxWidth = Math.max(...layers.map((l) => l.taskIds.length), 0);

  return {
    definition: goal,
    layers,
    depth: layers.length,
    maxWidth,
    taskOrder,
    adjacency,
  };
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

function detectCycle(tasks: GoalTask[]): boolean {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const task of tasks) {
    inDegree.set(task.id, 0);
    adj.set(task.id, []);
  }

  for (const task of tasks) {
    if (task.depends) {
      for (const dep of task.depends) {
        adj.get(dep)?.push(task.id);
        inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
      }
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
    for (const next of adj.get(node) ?? []) {
      const newDeg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, newDeg);
      if (newDeg === 0) queue.push(next);
    }
  }

  return visited !== tasks.length;
}

function normalizeGoal(raw: GoalDefinition): GoalDefinition {
  return {
    name: raw.name ?? 'unnamed',
    description: raw.description,
    version: raw.version,
    tasks: (raw.tasks ?? []).map((t) => ({
      id: t.id,
      agent: t.agent,
      action: t.action,
      depends: t.depends,
      params: t.params,
      timeoutMs: t.timeoutMs,
      critical: t.critical ?? true,
      retries: t.retries ?? 0,
      outputKey: t.outputKey,
    })),
    constraints: raw.constraints,
    outputs: raw.outputs,
    metadata: raw.metadata,
  };
}

function parseSimpleYaml(input: string): GoalDefinition {
  const lines = input.split('\n');
  const result: Record<string, unknown> = {};
  let currentTasks: Array<Record<string, unknown>> = [];
  let currentTask: Record<string, unknown> | null = null;
  let currentOutputs: Array<Record<string, unknown>> = [];
  let currentOutput: Record<string, unknown> | null = null;
  let section: 'root' | 'tasks' | 'task' | 'constraints' | 'outputs' | 'output' = 'root';
  let constraints: Record<string, unknown> = {};

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const trimmedLine = line.trimStart();
    if (trimmedLine === '' || trimmedLine.startsWith('#')) continue;

    const indent = line.length - trimmedLine.length;

    // Top-level keys
    if (indent === 0 && trimmedLine.includes(':')) {
      // Save previous state
      if (currentTask) {
        currentTasks.push(currentTask);
        currentTask = null;
      }
      if (currentOutput) {
        currentOutputs.push(currentOutput);
        currentOutput = null;
      }

      const [key, ...valParts] = trimmedLine.split(':');
      const val = valParts.join(':').trim();

      if (key.trim() === 'tasks') {
        section = 'tasks';
        continue;
      }
      if (key.trim() === 'constraints') {
        section = 'constraints';
        continue;
      }
      if (key.trim() === 'outputs') {
        section = 'outputs';
        continue;
      }

      result[key.trim()] = parseYamlValue(val);
      section = 'root';
      continue;
    }

    // Task list items
    if (section === 'tasks' || section === 'task') {
      if (trimmedLine.startsWith('- ')) {
        if (currentTask) currentTasks.push(currentTask);
        currentTask = {};
        section = 'task';
        // Parse inline key:value after -
        const afterDash = trimmedLine.slice(2).trim();
        if (afterDash.includes(':')) {
          const [k, ...vParts] = afterDash.split(':');
          currentTask[k.trim()] = parseYamlValue(vParts.join(':').trim());
        }
        continue;
      }
      if (currentTask && trimmedLine.includes(':')) {
        const [k, ...vParts] = trimmedLine.split(':');
        currentTask[k.trim()] = parseYamlValue(vParts.join(':').trim());
        continue;
      }
    }

    // Constraints
    if (section === 'constraints' && trimmedLine.includes(':')) {
      const [k, ...vParts] = trimmedLine.split(':');
      constraints[k.trim()] = parseYamlValue(vParts.join(':').trim());
      continue;
    }

    // Outputs
    if (section === 'outputs' || section === 'output') {
      if (trimmedLine.startsWith('- ')) {
        if (currentOutput) currentOutputs.push(currentOutput);
        currentOutput = {};
        section = 'output';
        const afterDash = trimmedLine.slice(2).trim();
        if (afterDash.includes(':')) {
          const [k, ...vParts] = afterDash.split(':');
          currentOutput[k.trim()] = parseYamlValue(vParts.join(':').trim());
        }
        continue;
      }
      if (currentOutput && trimmedLine.includes(':')) {
        const [k, ...vParts] = trimmedLine.split(':');
        currentOutput[k.trim()] = parseYamlValue(vParts.join(':').trim());
        continue;
      }
    }
  }

  // Flush remaining
  if (currentTask) currentTasks.push(currentTask);
  if (currentOutput) currentOutputs.push(currentOutput);

  const goal: GoalDefinition = {
    name: (result['name'] as string) ?? 'unnamed',
    description: result['description'] as string | undefined,
    version: result['version'] as string | undefined,
    tasks: currentTasks.map((t) => ({
      id: (t['id'] as string) ?? '',
      agent: (t['agent'] as string) ?? '',
      action: (t['action'] as string) ?? '',
      depends: t['depends'] as string[] | undefined,
      params: t['params'] as Record<string, unknown> | undefined,
      timeoutMs: t['timeoutMs'] as number | undefined,
      critical: t['critical'] as boolean | undefined,
      retries: t['retries'] as number | undefined,
      outputKey: t['outputKey'] as string | undefined,
    })),
    constraints: Object.keys(constraints).length > 0 ? constraints as GoalConstraints : undefined,
    outputs: currentOutputs.length > 0 ? currentOutputs.map((o) => ({
      key: (o['key'] as string) ?? '',
      type: o['type'] as string | undefined,
      required: o['required'] as boolean | undefined,
      description: o['description'] as string | undefined,
    })) : undefined,
    metadata: result['metadata'] as Record<string, unknown> | undefined,
  };

  return normalizeGoal(goal);
}

function parseYamlValue(val: string): unknown {
  if (val === '' || val === undefined) return undefined;
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === 'null') return null;

  // Inline array [a, b, c]
  if (val.startsWith('[') && val.endsWith(']')) {
    const inner = val.slice(1, -1);
    return inner.split(',').map((s) => parseYamlValue(s.trim()));
  }

  // Number
  const num = Number(val);
  if (!isNaN(num) && val !== '') return num;

  // Strip quotes
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }

  return val;
}
