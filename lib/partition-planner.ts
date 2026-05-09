/**
 * Partition Planner — Logical Work Partitioning for Network-AI
 *
 * Prevents parallel agents from performing redundant research or analysis by
 * running a "meta-step" before DAG execution that generates a Scope Assignment
 * Map (PartitionSchema). Each agent receives a boundary constraint injected
 * into its parameters, declaring what it SHOULD focus on and what it should
 * EXCLUDE.
 *
 * The planner also performs an overlap check — verifying that no two
 * `focus_area` strings overlap semantically (or lexically, when using the
 * built-in heuristic check).
 *
 * Zero external dependencies — the overlap checker and the planner function
 * are pluggable so callers can use any LLM or rule-based strategy.
 *
 * @module PartitionPlanner
 * @version 1.0.0
 */

import type { TeamAgent } from './goal-decomposer';

// ============================================================================
// TYPES
// ============================================================================

/**
 * A single entry in the partition schema — the boundary assignment for one
 * agent type.
 */
export interface PartitionEntry {
  /** The agent type / ID this assignment applies to. */
  agent_type: string;
  /** What this agent should focus on. */
  focus_area: string;
  /** Topics this agent must NOT research or analyse to avoid redundancy. */
  excluded_topics: string[];
}

/**
 * The full scope assignment map — one entry per agent.
 */
export type PartitionSchema = PartitionEntry[];

/**
 * A planner function that, given a goal and a list of agents, produces a
 * PartitionSchema via an LLM call (or rule-based logic).
 */
export type PartitionPlannerFunction = (
  goal: string,
  agents: TeamAgent[],
  context?: Record<string, unknown>,
) => Promise<PartitionSchema>;

/**
 * An overlap-check function that validates no two focus_area strings in a
 * schema overlap. Returns an array of overlap descriptions (empty = no overlaps).
 */
export type OverlapCheckFunction = (schema: PartitionSchema) => Promise<string[]>;

/** Options for {@link PartitionPlanner}. */
export interface PartitionPlannerOptions {
  /**
   * Overlap check implementation.
   * Defaults to the built-in lexical heuristic checker.
   */
  overlapChecker?: OverlapCheckFunction;
  /**
   * When true, throw an error if any semantic overlaps are detected.
   * When false (default), overlaps are reported in `PartitionResult.overlaps`
   * but execution continues.
   */
  strictOverlap?: boolean;
}

/** Result of a partition planning call. */
export interface PartitionResult {
  /** The generated schema (one entry per agent). */
  schema: PartitionSchema;
  /** Any detected focus_area overlaps between agents. */
  overlaps: string[];
  /** True when overlaps were detected (and strictOverlap was false). */
  hasOverlaps: boolean;
  /** When the schema was generated (epoch ms). */
  createdAt: number;
}

// ============================================================================
// BUILT-IN OVERLAP CHECKER (lexical heuristic — zero model cost)
// ============================================================================

/**
 * Lexical overlap checker: considers two focus areas to overlap when they
 * share significant word stems (ignoring common stop words).
 *
 * This is the built-in default. For true semantic overlap detection, inject
 * an LLM-based `OverlapCheckFunction` via `PartitionPlannerOptions.overlapChecker`.
 */
export function createLexicalOverlapChecker(): OverlapCheckFunction {
  const STOP_WORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
    'as', 'its', 'it', 'this', 'that', 'all', 'any', 'each', 'every',
  ]);

  function tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
    );
  }

  return async (schema: PartitionSchema): Promise<string[]> => {
    const overlaps: string[] = [];

    for (let i = 0; i < schema.length; i++) {
      for (let j = i + 1; j < schema.length; j++) {
        const tokensA = tokenize(schema[i].focus_area);
        const tokensB = tokenize(schema[j].focus_area);

        const shared: string[] = [];
        for (const token of tokensA) {
          if (tokensB.has(token)) shared.push(token);
        }

        // Flag as overlap when ≥ 2 shared significant words or overlap ratio > 0.4
        const unionSize = new Set([...tokensA, ...tokensB]).size;
        const ratio = unionSize > 0 ? shared.length / unionSize : 0;

        if (shared.length >= 2 || ratio > 0.4) {
          overlaps.push(
            `Overlap between "${schema[i].agent_type}" (focus: "${schema[i].focus_area}") and "${schema[j].agent_type}" (focus: "${schema[j].focus_area}") — shared terms: ${shared.join(', ')}`,
          );
        }
      }
    }

    return overlaps;
  };
}

/**
 * Build a partition planner backed by an LLM.
 *
 * The LLM is asked to generate a PartitionSchema JSON array given the goal
 * and the available agents. Use this for rich semantic partitioning.
 *
 * @param executor - Network-AI executor function
 * @param plannerAgentId - Agent ID for the LLM that does partitioning
 */
export function createLLMPartitionPlanner(
  executor: (
    agentId: string,
    payload: { action: string; params: Record<string, unknown> },
    context: { agentId: string; taskId: string; metadata?: Record<string, unknown> },
  ) => Promise<{ success: boolean; data?: unknown; error?: { message: string } }>,
  plannerAgentId: string,
): PartitionPlannerFunction {
  return async (goal: string, agents: TeamAgent[], context?: Record<string, unknown>): Promise<PartitionSchema> => {
    const agentList = agents.map((a) => `- ${a.id}: ${a.role}`).join('\n');
    const prompt = [
      'You are a work-partitioning planner for a multi-agent AI system.',
      'Generate a scope assignment for each agent to prevent redundant research.',
      '',
      `GOAL: ${goal}`,
      '',
      'AGENTS:',
      agentList,
      '',
      context ? `CONTEXT: ${JSON.stringify(context)}` : '',
      '',
      'Respond with ONLY a JSON array where each element has:',
      '- "agent_type": agent ID from the list above',
      '- "focus_area": a short phrase describing what ONLY this agent researches',
      '- "excluded_topics": array of topic strings this agent must NOT cover',
      '',
      'Ensure no two focus_area values overlap semantically.',
      '',
      'Example:',
      '[{"agent_type":"researcher","focus_area":"market trends and competitive landscape","excluded_topics":["financial projections","legal compliance"]},',
      ' {"agent_type":"analyst","focus_area":"financial projections and ROI analysis","excluded_topics":["market research","legal compliance"]}]',
    ].filter(Boolean).join('\n');

    const result = await executor(
      plannerAgentId,
      { action: 'partition', params: { prompt } },
      { agentId: plannerAgentId, taskId: `partition-${Date.now()}`, metadata: { type: 'partition-planning', ...(context ?? {}) } },
    );

    if (!result.success || !result.data) {
      throw new Error(`Partition planner failed: ${result.error?.message ?? 'no data returned'}`);
    }

    return parsePartitionJSON(typeof result.data === 'string' ? result.data : JSON.stringify(result.data));
  };
}

/**
 * Parse a PartitionSchema from an LLM response string.
 * Handles markdown fences and leading/trailing text.
 */
export function parsePartitionJSON(text: string): PartitionSchema {
  let cleaned = text.trim();

  // Strip markdown fences
  const fenceOpen = cleaned.indexOf('```');
  if (fenceOpen !== -1) {
    const afterOpen = cleaned.indexOf('\n', fenceOpen);
    const fenceClose = cleaned.indexOf('```', afterOpen !== -1 ? afterOpen : fenceOpen + 3);
    if (afterOpen !== -1 && fenceClose > afterOpen) {
      cleaned = cleaned.substring(afterOpen + 1, fenceClose).trim();
    }
  }

  // Find JSON array
  const arrayStart = cleaned.indexOf('[');
  const arrayEnd = cleaned.lastIndexOf(']');
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    cleaned = cleaned.substring(arrayStart, arrayEnd + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse partition schema JSON: ${(err as Error).message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Partition schema must be a JSON array');
  }

  // Validate each entry
  const schema: PartitionSchema = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('Each partition entry must be a JSON object');
    }
    const e = entry as Record<string, unknown>;
    if (!e.agent_type || typeof e.agent_type !== 'string') {
      throw new Error('Each partition entry must have a string "agent_type"');
    }
    if (!e.focus_area || typeof e.focus_area !== 'string') {
      throw new Error(`Partition entry for "${e.agent_type}" must have a string "focus_area"`);
    }
    if (!Array.isArray(e.excluded_topics)) {
      e.excluded_topics = [];
    }
    schema.push({
      agent_type: e.agent_type as string,
      focus_area: e.focus_area as string,
      excluded_topics: (e.excluded_topics as unknown[]).map(String),
    });
  }

  return schema;
}

// ============================================================================
// PARTITION PLANNER (OOP interface)
// ============================================================================

/**
 * PartitionPlanner generates a PartitionSchema (scope assignment map) for a
 * set of agents before the DAG is executed, preventing redundant research.
 *
 * @example
 * ```typescript
 * const planner = new PartitionPlanner(myLLMPartitionPlannerFn);
 * const result = await planner.plan('Analyse Q3 financial results', agents);
 * // result.schema[0] = { agent_type: 'researcher', focus_area: '...', excluded_topics: [...] }
 * // Inject result.schema[i] as boundary constraint into each agent's params
 * ```
 */
export class PartitionPlanner {
  private plannerFn: PartitionPlannerFunction;
  private overlapChecker: OverlapCheckFunction;
  private strictOverlap: boolean;

  constructor(plannerFn: PartitionPlannerFunction, options: PartitionPlannerOptions = {}) {
    this.plannerFn = plannerFn;
    this.overlapChecker = options.overlapChecker ?? createLexicalOverlapChecker();
    this.strictOverlap = options.strictOverlap ?? false;
  }

  /**
   * Generate a PartitionSchema for a goal and agent list.
   *
   * Runs the planner then validates for overlaps. If `strictOverlap` is true
   * and overlaps are found, throws an error. Otherwise overlaps are reported
   * in the result.
   *
   * @param goal - Natural language goal
   * @param agents - Available team agents
   * @param context - Optional context to feed to the planner
   */
  async plan(
    goal: string,
    agents: TeamAgent[],
    context?: Record<string, unknown>,
  ): Promise<PartitionResult> {
    if (!goal || typeof goal !== 'string') {
      throw new Error('Goal must be a non-empty string');
    }
    if (!agents || agents.length === 0) {
      throw new Error('At least one agent is required');
    }

    const schema = await this.plannerFn(goal, agents, context);
    const overlaps = await this.overlapChecker(schema);
    const hasOverlaps = overlaps.length > 0;

    if (hasOverlaps && this.strictOverlap) {
      throw new Error(`Partition schema has semantic overlaps:\n${overlaps.join('\n')}`);
    }

    return {
      schema,
      overlaps,
      hasOverlaps,
      createdAt: Date.now(),
    };
  }

  /**
   * Inject partition boundary constraints into agent params.
   *
   * Given a PartitionSchema and an existing params object for an agent,
   * returns a new params object with `_partitionConstraint` added.
   *
   * @param agentId - Agent ID to look up in the schema
   * @param params - Existing task params
   * @param schema - The partition schema
   */
  static injectConstraint(
    agentId: string,
    params: Record<string, unknown>,
    schema: PartitionSchema,
  ): Record<string, unknown> {
    const entry = schema.find((e) => e.agent_type === agentId);
    if (!entry) return params;
    return {
      ...params,
      _partitionConstraint: {
        focus_area: entry.focus_area,
        excluded_topics: entry.excluded_topics,
      },
    };
  }
}
