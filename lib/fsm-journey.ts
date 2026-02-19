/**
 * FSM Journey Layer — Phase 4: Behavioral Control Plane
 *
 * Implements state machine–based workflow authorization. Agents can only act
 * in their designated states, and tools can only be called when the current
 * workflow state permits it.
 *
 * @module fsm-journey
 */

// ============================================================================
// TYPES
// ============================================================================

/** Named workflow states. Extend by passing custom string literals. */
export type WorkflowStateName = string;

/** Built-in canonical workflow states for common agent pipelines. */
export const WORKFLOW_STATES = {
  INTAKE:    'INTAKE',
  VALIDATE:  'VALIDATE',
  RESEARCH:  'RESEARCH',
  PLAN:      'PLAN',
  EXECUTE:   'EXECUTE',
  REVIEW:    'REVIEW',
  DELIVER:   'DELIVER',
  COMPLETE:  'COMPLETE',
  ERROR:     'ERROR',
} as const;

/** A single state definition in the FSM. */
export interface WorkflowStateDefinition {
  /** Unique state name */
  name: WorkflowStateName;
  /** Human-readable description */
  description?: string;
  /** Agents authorised to perform actions in this state. '*' means any. */
  authorizedAgents: string[];
  /** Tools authorised in this state, keyed by agentId ('*' = any agent). */
  authorizedTools?: Record<string, string[]>;  // agentId -> tool names
  /** Maximum time (ms) the FSM may remain in this state before it's a violation. */
  timeoutMs?: number;
}

/** A named transition between two states triggered by an event. */
export interface StateTransition {
  from: WorkflowStateName;
  event: string;
  to: WorkflowStateName;
  /** If set, only this agent (or '*') may fire this transition. */
  allowedBy?: string;
}

/** Describes what happened when a state transition was attempted. */
export interface TransitionResult {
  success: boolean;
  previousState: WorkflowStateName;
  currentState: WorkflowStateName;
  reason?: string;
}

/** Result from an inline compliance check. */
export interface ComplianceCheckResult {
  allowed: boolean;
  reason?: string;
  currentState: WorkflowStateName;
  agentId: string;
  tool?: string;
}

/** Options passed to JourneyFSM constructor. */
export interface JourneyFSMOptions {
  states: WorkflowStateDefinition[];
  transitions: StateTransition[];
  initialState: WorkflowStateName;
  /** Called whenever a transition fires (success or failure). */
  onTransition?: (result: TransitionResult, agentId: string) => void;
  /** Called whenever a compliance violation is blocked. */
  onViolation?: (check: ComplianceCheckResult) => void;
}

// ============================================================================
// TOOL AUTHORIZATION MATRIX
// ============================================================================

/**
 * Standalone tool authorization matrix.
 *
 * Maps `agentId -> state -> allowedTools[]`.
 * The FSM embeds one automatically, but you can also use this independently.
 *
 * @example
 * ```typescript
 * const matrix = new ToolAuthorizationMatrix();
 * matrix.allow('data_analyst', 'RESEARCH', ['search_web', 'query_db']);
 * matrix.allow('*', 'REVIEW', ['read_blackboard']);
 * matrix.isAllowed('data_analyst', 'RESEARCH', 'query_db'); // true
 * ```
 */
export class ToolAuthorizationMatrix {
  // agentId -> state -> Set<toolName>
  private rules: Map<string, Map<string, Set<string>>> = new Map();

  /**
   * Grant an agent permission to use a list of tools in a given state.
   * Use `'*'` for agentId or toolNames to mean "all".
   */
  allow(agentId: string, state: WorkflowStateName, tools: string[]): void {
    if (!this.rules.has(agentId)) this.rules.set(agentId, new Map());
    const agentRules = this.rules.get(agentId)!;
    if (!agentRules.has(state)) agentRules.set(state, new Set());
    const toolSet = agentRules.get(state)!;
    for (const t of tools) toolSet.add(t);
  }

  /** Revoke a specific tool permission. */
  revoke(agentId: string, state: WorkflowStateName, tool: string): void {
    this.rules.get(agentId)?.get(state)?.delete(tool);
  }

  /**
   * Check if an agent is allowed to use a tool in a given state.
   * Checks exact agentId first, then falls back to '*' wildcard.
   */
  isAllowed(agentId: string, state: WorkflowStateName, tool: string): boolean {
    return (
      this._check(agentId, state, tool) ||
      this._check('*', state, tool) ||
      this._check(agentId, '*', tool) ||
      this._check('*', '*', tool)
    );
  }

  private _check(agentId: string, state: string, tool: string): boolean {
    const tools = this.rules.get(agentId)?.get(state);
    if (!tools) return false;
    return tools.has(tool) || tools.has('*');
  }

  /** Dump current rules for debugging/audit. */
  dump(): Record<string, Record<string, string[]>> {
    const out: Record<string, Record<string, string[]>> = {};
    for (const [agent, states] of this.rules) {
      out[agent] = {};
      for (const [state, tools] of states) {
        out[agent][state] = Array.from(tools);
      }
    }
    return out;
  }
}

// ============================================================================
// JOURNEY FSM
// ============================================================================

/**
 * Finite-state machine for workflow authorization.
 *
 * Governs which agents can act (and with which tools) based on the current
 * workflow state. Integrates an inline `ComplianceMiddleware` and a
 * `ToolAuthorizationMatrix`.
 *
 * @example
 * ```typescript
 * import { JourneyFSM, WORKFLOW_STATES } from 'network-ai';
 *
 * const fsm = new JourneyFSM({
 *   states: [
 *     { name: 'INTAKE',   authorizedAgents: ['orchestrator'],  authorizedTools: { orchestrator: ['read_intake'] } },
 *     { name: 'RESEARCH', authorizedAgents: ['data_analyst'],  authorizedTools: { data_analyst: ['query_db', 'search_web'] } },
 *     { name: 'DELIVER',  authorizedAgents: ['orchestrator'],  authorizedTools: { '*': ['write_blackboard'] } },
 *   ],
 *   transitions: [
 *     { from: 'INTAKE',   event: 'start_research', to: 'RESEARCH', allowedBy: 'orchestrator' },
 *     { from: 'RESEARCH', event: 'research_done',  to: 'DELIVER',  allowedBy: '*' },
 *   ],
 *   initialState: 'INTAKE',
 * });
 *
 * fsm.transition('start_research', 'orchestrator'); // moves to RESEARCH
 * fsm.canAgentAct('data_analyst'); // true — we're now in RESEARCH
 * ```
 */
export class JourneyFSM {
  private currentState: WorkflowStateName;
  private stateMap: Map<string, WorkflowStateDefinition> = new Map();
  private transitions: StateTransition[];
  private options: JourneyFSMOptions;
  private stateEnteredAt: number = Date.now();
  private history: Array<{ state: WorkflowStateName; enteredAt: number; exitedAt?: number; triggeredBy?: string }> = [];

  /** Embedded tool authorization matrix (populated from state definitions). */
  readonly toolMatrix: ToolAuthorizationMatrix;

  constructor(options: JourneyFSMOptions) {
    this.options = options;
    this.transitions = options.transitions;
    this.toolMatrix = new ToolAuthorizationMatrix();

    // Index states
    for (const s of options.states) {
      this.stateMap.set(s.name, s);
      // Populate the tool matrix from state definitions
      if (s.authorizedTools) {
        for (const [agentId, tools] of Object.entries(s.authorizedTools)) {
          this.toolMatrix.allow(agentId, s.name, tools);
        }
      }
    }

    if (!this.stateMap.has(options.initialState)) {
      throw new Error(`Initial state "${options.initialState}" is not defined in states list`);
    }

    this.currentState = options.initialState;
    this.history.push({ state: this.currentState, enteredAt: Date.now() });
  }

  // --------------------------------------------------------------------------
  // State accessors
  // --------------------------------------------------------------------------

  /** Current workflow state name. */
  get state(): WorkflowStateName {
    return this.currentState;
  }

  /** Full definition of the current state. */
  get stateDefinition(): WorkflowStateDefinition {
    return this.stateMap.get(this.currentState)!;
  }

  /** How long (ms) the FSM has been in the current state. */
  get timeInCurrentState(): number {
    return Date.now() - this.stateEnteredAt;
  }

  /** Whether the current state has timed out. */
  get isTimedOut(): boolean {
    const def = this.stateDefinition;
    if (!def.timeoutMs) return false;
    return this.timeInCurrentState > def.timeoutMs;
  }

  /** Full transition history. */
  get transitionHistory(): ReadonlyArray<{ state: WorkflowStateName; enteredAt: number; exitedAt?: number; triggeredBy?: string }> {
    return this.history;
  }

  // --------------------------------------------------------------------------
  // Authorization checks
  // --------------------------------------------------------------------------

  /**
   * Check if an agent is authorized to perform any action in the current state.
   */
  canAgentAct(agentId: string): boolean {
    const def = this.stateDefinition;
    return def.authorizedAgents.includes('*') || def.authorizedAgents.includes(agentId);
  }

  /**
   * Check if an agent is authorized to use a specific tool in the current state.
   * Checks both the tool matrix AND agent authorization.
   */
  canAgentUseTool(agentId: string, tool: string): boolean {
    if (!this.canAgentAct(agentId)) return false;
    return this.toolMatrix.isAllowed(agentId, this.currentState, tool);
  }

  /**
   * Inline compliance check — call this BEFORE executing any agent action.
   * Returns `{ allowed: true }` or `{ allowed: false, reason }`.
   */
  checkCompliance(agentId: string, tool?: string): ComplianceCheckResult {
    const canAct = this.canAgentAct(agentId);
    if (!canAct) {
      const result: ComplianceCheckResult = {
        allowed: false,
        reason: `Agent "${agentId}" is not authorized in state "${this.currentState}". ` +
          `Authorized agents: [${this.stateDefinition.authorizedAgents.join(', ')}]`,
        currentState: this.currentState,
        agentId,
        tool,
      };
      this.options.onViolation?.(result);
      return result;
    }

    if (tool) {
      const canUseTool = this.canAgentUseTool(agentId, tool);
      if (!canUseTool) {
        const result: ComplianceCheckResult = {
          allowed: false,
          reason: `Agent "${agentId}" is not authorized to use tool "${tool}" in state "${this.currentState}"`,
          currentState: this.currentState,
          agentId,
          tool,
        };
        this.options.onViolation?.(result);
        return result;
      }
    }

    return { allowed: true, currentState: this.currentState, agentId, tool };
  }

  // --------------------------------------------------------------------------
  // Transitions
  // --------------------------------------------------------------------------

  /**
   * Fire a named event to transition the FSM to the next state.
   * Returns a `TransitionResult` describing what happened.
   */
  transition(event: string, agentId: string): TransitionResult {
    const match = this.transitions.find(
      t => t.from === this.currentState && t.event === event
    );

    if (!match) {
      const result: TransitionResult = {
        success: false,
        previousState: this.currentState,
        currentState: this.currentState,
        reason: `No transition "${event}" defined from state "${this.currentState}"`,
      };
      this.options.onTransition?.(result, agentId);
      return result;
    }

    // Check if this agent is allowed to fire this transition
    if (match.allowedBy && match.allowedBy !== '*' && match.allowedBy !== agentId) {
      const result: TransitionResult = {
        success: false,
        previousState: this.currentState,
        currentState: this.currentState,
        reason: `Agent "${agentId}" cannot fire event "${event}" (only "${match.allowedBy}" can)`,
      };
      this.options.onTransition?.(result, agentId);
      return result;
    }

    if (!this.stateMap.has(match.to)) {
      const result: TransitionResult = {
        success: false,
        previousState: this.currentState,
        currentState: this.currentState,
        reason: `Target state "${match.to}" is not defined`,
      };
      this.options.onTransition?.(result, agentId);
      return result;
    }

    const previous = this.currentState;
    // Mark exit time on current history entry
    this.history[this.history.length - 1].exitedAt = Date.now();
    this.history[this.history.length - 1].triggeredBy = agentId;

    this.currentState = match.to;
    this.stateEnteredAt = Date.now();
    this.history.push({ state: this.currentState, enteredAt: this.stateEnteredAt });

    const result: TransitionResult = {
      success: true,
      previousState: previous,
      currentState: this.currentState,
    };
    this.options.onTransition?.(result, agentId);
    return result;
  }

  /**
   * Returns all events available from the current state.
   */
  availableEvents(): string[] {
    return this.transitions
      .filter(t => t.from === this.currentState)
      .map(t => t.event);
  }

  /**
   * Returns which agents are authorized in a given state (defaults to current).
   */
  getAuthorizedAgents(stateName?: WorkflowStateName): string[] {
    return this.stateMap.get(stateName ?? this.currentState)?.authorizedAgents ?? [];
  }

  /**
   * Reset the FSM to its initial state.
   */
  reset(): void {
    this.history[this.history.length - 1].exitedAt = Date.now();
    this.currentState = this.options.initialState;
    this.stateEnteredAt = Date.now();
    this.history.push({ state: this.currentState, enteredAt: this.stateEnteredAt });
  }
}

// ============================================================================
// COMPLIANCE MIDDLEWARE
// ============================================================================

/**
 * Wraps an async action and blocks its execution if the FSM denies it.
 *
 * @example
 * ```typescript
 * const middleware = new ComplianceMiddleware(fsm);
 *
 * const result = await middleware.enforce('data_analyst', 'query_db', async () => {
 *   return await db.query('SELECT * FROM invoices');
 * });
 * ```
 */
export class ComplianceMiddleware {
  constructor(private fsm: JourneyFSM) {}

  /**
   * Enforce compliance before running `action`.
   * Throws if not authorized; returns the action's result if allowed.
   */
  async enforce<T>(
    agentId: string,
    tool: string,
    action: () => Promise<T>
  ): Promise<T> {
    const check = this.fsm.checkCompliance(agentId, tool);
    if (!check.allowed) {
      throw new ComplianceViolationError(check.reason ?? 'Compliance check failed', check);
    }
    return action();
  }

  /**
   * Synchronous version — use when the action is not async.
   */
  enforceSync<T>(
    agentId: string,
    tool: string,
    action: () => T
  ): T {
    const check = this.fsm.checkCompliance(agentId, tool);
    if (!check.allowed) {
      throw new ComplianceViolationError(check.reason ?? 'Compliance check failed', check);
    }
    return action();
  }
}

// ============================================================================
// ERRORS
// ============================================================================

/** Thrown when ComplianceMiddleware blocks an action. */
export class ComplianceViolationError extends Error {
  readonly check: ComplianceCheckResult;
  constructor(message: string, check: ComplianceCheckResult) {
    super(message);
    this.name = 'ComplianceViolationError';
    this.check = check;
  }
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Build a standard delivery pipeline FSM with sensible defaults.
 * States: INTAKE → VALIDATE → RESEARCH → PLAN → EXECUTE → REVIEW → DELIVER → COMPLETE
 *
 * @example
 * ```typescript
 * const fsm = createDeliveryPipelineFSM({
 *   orchestratorId: 'orchestrator',
 *   researchAgentId: 'data_analyst',
 *   executorId: 'code_writer',
 * });
 * ```
 */
export function createDeliveryPipelineFSM(options: {
  orchestratorId?: string;
  researchAgentId?: string;
  executorId?: string;
  reviewerId?: string;
  onTransition?: JourneyFSMOptions['onTransition'];
  onViolation?: JourneyFSMOptions['onViolation'];
}): JourneyFSM {
  const orch    = options.orchestratorId  ?? 'orchestrator';
  const analyst = options.researchAgentId ?? 'data_analyst';
  const exec    = options.executorId      ?? 'code_writer';
  const reviewer = options.reviewerId     ?? 'reviewer';

  return new JourneyFSM({
    states: [
      {
        name: WORKFLOW_STATES.INTAKE,
        description: 'Receive and parse the incoming task',
        authorizedAgents: [orch],
        authorizedTools: { [orch]: ['read_intake', 'write_blackboard', 'parse_task'] },
        timeoutMs: 30_000,
      },
      {
        name: WORKFLOW_STATES.VALIDATE,
        description: 'Validate task feasibility and permissions',
        authorizedAgents: [orch],
        authorizedTools: { [orch]: ['check_permission', 'validate_schema', 'write_blackboard'] },
        timeoutMs: 60_000,
      },
      {
        name: WORKFLOW_STATES.RESEARCH,
        description: 'Gather information required for the task',
        authorizedAgents: [analyst],
        authorizedTools: { [analyst]: ['query_db', 'search_web', 'read_blackboard', 'write_blackboard'] },
        timeoutMs: 120_000,
      },
      {
        name: WORKFLOW_STATES.PLAN,
        description: 'Build execution plan from research results',
        authorizedAgents: [orch],
        authorizedTools: { [orch]: ['read_blackboard', 'write_blackboard', 'decompose_task'] },
        timeoutMs: 60_000,
      },
      {
        name: WORKFLOW_STATES.EXECUTE,
        description: 'Execute the planned steps',
        authorizedAgents: [exec],
        authorizedTools: { [exec]: ['run_code', 'call_api', 'write_blackboard', 'read_blackboard'] },
        timeoutMs: 300_000,
      },
      {
        name: WORKFLOW_STATES.REVIEW,
        description: 'Review execution output for quality',
        authorizedAgents: [reviewer, orch],
        authorizedTools: {
          [reviewer]: ['read_blackboard', 'quality_gate', 'write_review'],
          [orch]:     ['read_blackboard', 'quality_gate'],
        },
        timeoutMs: 120_000,
      },
      {
        name: WORKFLOW_STATES.DELIVER,
        description: 'Deliver results to requesting system',
        authorizedAgents: [orch],
        authorizedTools: { [orch]: ['write_output', 'notify', 'write_blackboard'] },
        timeoutMs: 30_000,
      },
      {
        name: WORKFLOW_STATES.COMPLETE,
        description: 'Terminal state — workflow complete',
        authorizedAgents: ['*'],
        authorizedTools: { '*': ['read_blackboard'] },
      },
      {
        name: WORKFLOW_STATES.ERROR,
        description: 'Error recovery state',
        authorizedAgents: [orch, '*'],
        authorizedTools: { '*': ['read_blackboard', 'write_blackboard'] },
      },
    ],
    transitions: [
      { from: WORKFLOW_STATES.INTAKE,    event: 'validate',        to: WORKFLOW_STATES.VALIDATE,  allowedBy: orch },
      { from: WORKFLOW_STATES.VALIDATE,  event: 'start_research',  to: WORKFLOW_STATES.RESEARCH,  allowedBy: orch },
      { from: WORKFLOW_STATES.VALIDATE,  event: 'validation_fail', to: WORKFLOW_STATES.ERROR,     allowedBy: orch },
      { from: WORKFLOW_STATES.RESEARCH,  event: 'research_done',   to: WORKFLOW_STATES.PLAN,      allowedBy: analyst },
      { from: WORKFLOW_STATES.RESEARCH,  event: 'research_fail',   to: WORKFLOW_STATES.ERROR,     allowedBy: analyst },
      { from: WORKFLOW_STATES.PLAN,      event: 'execute',         to: WORKFLOW_STATES.EXECUTE,   allowedBy: orch },
      { from: WORKFLOW_STATES.EXECUTE,   event: 'execution_done',  to: WORKFLOW_STATES.REVIEW,    allowedBy: exec },
      { from: WORKFLOW_STATES.EXECUTE,   event: 'execution_fail',  to: WORKFLOW_STATES.ERROR,     allowedBy: exec },
      { from: WORKFLOW_STATES.REVIEW,    event: 'approved',        to: WORKFLOW_STATES.DELIVER,   allowedBy: '*' },
      { from: WORKFLOW_STATES.REVIEW,    event: 'rejected',        to: WORKFLOW_STATES.EXECUTE,   allowedBy: '*' },
      { from: WORKFLOW_STATES.DELIVER,   event: 'delivered',       to: WORKFLOW_STATES.COMPLETE,  allowedBy: orch },
      { from: WORKFLOW_STATES.ERROR,     event: 'retry',           to: WORKFLOW_STATES.INTAKE,    allowedBy: orch },
      { from: WORKFLOW_STATES.ERROR,     event: 'abort',           to: WORKFLOW_STATES.COMPLETE,  allowedBy: orch },
    ],
    initialState: WORKFLOW_STATES.INTAKE,
    onTransition: options.onTransition,
    onViolation:  options.onViolation,
  });
}
