/**
 * Strategy Agent — AI Meta-Orchestrator for Network-AI
 *
 * The StrategyAgent sits above SwarmOrchestrator and makes high-level decisions
 * about agent allocation, workload distribution, budget partitioning, and
 * adaptive scaling. It is designed for scenarios where a single AI controls
 * thousands to millions of agents.
 *
 * Architecture:
 *   - **AgentPool**: Elastic pool of agents from a template — spawn/recycle on demand
 *   - **WorkloadPartitioner**: Splits large tasks into chunks and routes to pools
 *   - **StrategyPlanner**: Evaluates current state and produces a StrategyPlan
 *   - **StrategyAgent**: Facade that composes all of the above
 *
 * Design principles:
 *   - Zero external dependencies (Node.js builtins only)
 *   - Pluggable strategy functions (bring your own AI decision-making)
 *   - Non-destructive: all actions go through existing orchestrator APIs
 *   - Observable: every decision is logged and emittable
 *
 * @module StrategyAgent
 * @version 1.0.0
 */

import { EventEmitter } from 'events';

// ============================================================================
// TYPES
// ============================================================================

/** Template for spawning agents in a pool */
export interface AgentTemplate {
  /** Unique template identifier */
  id: string;
  /** Adapter name to route through */
  adapter: string;
  /** Default action/payload for spawned agents */
  defaultAction: string;
  /** Default params merged into every spawn */
  defaultParams: Record<string, unknown>;
  /** Max concurrent agents from this template */
  maxConcurrent: number;
  /** Budget allocation per agent (tokens) */
  budgetPerAgent: number;
  /** Tags for routing and filtering */
  tags: string[];
}

/** Current status of a managed agent */
export interface ManagedAgent {
  id: string;
  templateId: string;
  status: 'spawning' | 'running' | 'completed' | 'failed' | 'recycled';
  spawnedAt: number;
  completedAt?: number;
  taskId?: string;
  tokensUsed: number;
}

/** A chunk of work to be distributed */
export interface WorkChunk {
  id: string;
  input: unknown;
  priority: number;
  assignedPool?: string;
  assignedAgent?: string;
  status: 'pending' | 'assigned' | 'running' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

/** Strategy plan produced by the planner */
export interface StrategyPlan {
  /** Human-readable description of the plan */
  description: string;
  /** Pools to scale up (templateId → target count) */
  scaleUp: Map<string, number>;
  /** Pools to scale down (templateId → target count) */
  scaleDown: Map<string, number>;
  /** Budget reallocation (templateId → new per-agent budget) */
  budgetReallocation: Map<string, number>;
  /** FSM transition to trigger (if any) */
  fsmTransition?: string;
  /** Work chunks to create */
  newChunks: Array<{ input: unknown; priority: number; targetPool: string }>;
  /** Confidence score 0-1 */
  confidence: number;
  /** Timestamp */
  createdAt: number;
}

/** Snapshot of the current system state for the planner */
export interface SystemSnapshot {
  pools: Map<string, PoolStatus>;
  totalBudgetSpent: number;
  totalBudgetCeiling: number;
  fsmState: string;
  pendingChunks: number;
  runningAgents: number;
  completedTasks: number;
  failedTasks: number;
  averageTaskDuration: number;
  timestamp: number;
}

/** Status of a single agent pool */
export interface PoolStatus {
  templateId: string;
  active: number;
  maxConcurrent: number;
  completed: number;
  failed: number;
  totalTokensUsed: number;
  budgetPerAgent: number;
  pendingChunks: number;
}

/** Pluggable strategy function — given state, produce a plan */
export type StrategyFunction = (snapshot: SystemSnapshot) => StrategyPlan | Promise<StrategyPlan>;

/** Events emitted by the StrategyAgent */
export interface StrategyEvents {
  'plan:created': (plan: StrategyPlan) => void;
  'plan:executed': (plan: StrategyPlan) => void;
  'pool:created': (templateId: string) => void;
  'pool:scaled': (templateId: string, from: number, to: number) => void;
  'agent:spawned': (agent: ManagedAgent) => void;
  'agent:completed': (agent: ManagedAgent) => void;
  'agent:failed': (agent: ManagedAgent, error: string) => void;
  'chunk:created': (chunk: WorkChunk) => void;
  'chunk:assigned': (chunk: WorkChunk) => void;
  'chunk:completed': (chunk: WorkChunk) => void;
  'chunk:failed': (chunk: WorkChunk) => void;
  'cycle:start': (cycleNumber: number) => void;
  'cycle:end': (cycleNumber: number, plan: StrategyPlan) => void;
}

/** Options for creating a StrategyAgent */
export interface StrategyAgentOptions {
  /** Custom strategy function (default: built-in adaptive strategy) */
  strategy?: StrategyFunction;
  /** How often to re-evaluate strategy (ms, default: 5000) */
  evaluationInterval?: number;
  /** Maximum total agents across all pools (default: 10000) */
  globalAgentLimit?: number;
  /** Maximum total budget across all pools (default: Infinity) */
  globalBudgetLimit?: number;
  /** Auto-start evaluation loop (default: false) */
  autoStart?: boolean;
}

// ============================================================================
// AGENT POOL
// ============================================================================

/**
 * Elastic pool of agents from a template. Manages spawn/complete/recycle
 * lifecycle without knowing about specific adapter implementations.
 */
export class AgentPool {
  readonly template: AgentTemplate;
  private agents: Map<string, ManagedAgent> = new Map();
  private _completedCount = 0;
  private _failedCount = 0;
  private _totalTokens = 0;
  private _events: EventEmitter;

  constructor(template: AgentTemplate, events: EventEmitter) {
    this.template = template;
    this._events = events;
  }

  /** Number of currently active (spawning or running) agents */
  get active(): number {
    let count = 0;
    for (const a of this.agents.values()) {
      if (a.status === 'spawning' || a.status === 'running') count++;
    }
    return count;
  }

  /** Total completed agents */
  get completed(): number { return this._completedCount; }

  /** Total failed agents */
  get failed(): number { return this._failedCount; }

  /** Total tokens consumed by this pool */
  get totalTokensUsed(): number { return this._totalTokens; }

  /** Whether the pool can accept more agents */
  get canSpawn(): boolean { return this.active < this.template.maxConcurrent; }

  /** How many more agents can be spawned */
  get availableSlots(): number { return Math.max(0, this.template.maxConcurrent - this.active); }

  /**
   * Reserve a slot and create a ManagedAgent record.
   * Returns null if pool is at capacity.
   */
  spawn(taskId?: string): ManagedAgent | null {
    if (!this.canSpawn) return null;

    const agent: ManagedAgent = {
      id: `${this.template.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      templateId: this.template.id,
      status: 'spawning',
      spawnedAt: Date.now(),
      taskId,
      tokensUsed: 0,
    };

    this.agents.set(agent.id, agent);
    this._events.emit('agent:spawned', agent);
    return agent;
  }

  /** Mark an agent as running */
  markRunning(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent && (agent.status === 'spawning')) {
      agent.status = 'running';
    }
  }

  /** Mark an agent as completed and record token usage */
  markCompleted(agentId: string, tokensUsed = 0): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.status = 'completed';
    agent.completedAt = Date.now();
    agent.tokensUsed = tokensUsed;
    this._completedCount++;
    this._totalTokens += tokensUsed;
    this._events.emit('agent:completed', agent);
  }

  /** Mark an agent as failed */
  markFailed(agentId: string, error: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.status = 'failed';
    agent.completedAt = Date.now();
    this._failedCount++;
    this._events.emit('agent:failed', agent, error);
  }

  /** Recycle completed/failed agents to free slots */
  recycle(): number {
    let recycled = 0;
    for (const [id, agent] of this.agents) {
      if (agent.status === 'completed' || agent.status === 'failed') {
        agent.status = 'recycled';
        this.agents.delete(id);
        recycled++;
      }
    }
    return recycled;
  }

  /** Get a snapshot of pool status */
  getStatus(pendingChunks = 0): PoolStatus {
    return {
      templateId: this.template.id,
      active: this.active,
      maxConcurrent: this.template.maxConcurrent,
      completed: this._completedCount,
      failed: this._failedCount,
      totalTokensUsed: this._totalTokens,
      budgetPerAgent: this.template.budgetPerAgent,
      pendingChunks,
    };
  }

  /** Get all agents (for inspection) */
  getAgents(): ReadonlyArray<ManagedAgent> {
    return Array.from(this.agents.values());
  }
}

// ============================================================================
// WORKLOAD PARTITIONER
// ============================================================================

/**
 * Splits large tasks into work chunks and manages the chunk lifecycle.
 */
export class WorkloadPartitioner {
  private chunks: Map<string, WorkChunk> = new Map();
  private _chunkCounter = 0;
  private _events: EventEmitter;

  constructor(events: EventEmitter) {
    this._events = events;
  }

  /**
   * Create work chunks from an array of inputs.
   * @param inputs - Array of task inputs
   * @param targetPool - Pool template ID to route chunks to
   * @param priority - Priority level (higher = more urgent)
   */
  partition(inputs: unknown[], targetPool: string, priority = 1): WorkChunk[] {
    const created: WorkChunk[] = [];
    for (const input of inputs) {
      const chunk: WorkChunk = {
        id: `chunk-${++this._chunkCounter}`,
        input,
        priority,
        assignedPool: targetPool,
        status: 'pending',
        createdAt: Date.now(),
      };
      this.chunks.set(chunk.id, chunk);
      this._events.emit('chunk:created', chunk);
      created.push(chunk);
    }
    return created;
  }

  /** Get all pending chunks for a pool, sorted by priority (descending) */
  getPendingForPool(poolId: string): WorkChunk[] {
    const pending: WorkChunk[] = [];
    for (const chunk of this.chunks.values()) {
      if (chunk.status === 'pending' && chunk.assignedPool === poolId) {
        pending.push(chunk);
      }
    }
    return pending.sort((a, b) => b.priority - a.priority);
  }

  /** Assign a chunk to an agent */
  assign(chunkId: string, agentId: string): boolean {
    const chunk = this.chunks.get(chunkId);
    if (!chunk || chunk.status !== 'pending') return false;
    chunk.status = 'assigned';
    chunk.assignedAgent = agentId;
    this._events.emit('chunk:assigned', chunk);
    return true;
  }

  /** Mark a chunk as running */
  markRunning(chunkId: string): void {
    const chunk = this.chunks.get(chunkId);
    if (chunk && chunk.status === 'assigned') {
      chunk.status = 'running';
    }
  }

  /** Mark a chunk as completed */
  markCompleted(chunkId: string, result?: unknown): void {
    const chunk = this.chunks.get(chunkId);
    if (!chunk) return;
    chunk.status = 'completed';
    chunk.result = result;
    chunk.completedAt = Date.now();
    this._events.emit('chunk:completed', chunk);
  }

  /** Mark a chunk as failed */
  markFailed(chunkId: string, error: string): void {
    const chunk = this.chunks.get(chunkId);
    if (!chunk) return;
    chunk.status = 'failed';
    chunk.error = error;
    chunk.completedAt = Date.now();
    this._events.emit('chunk:failed', chunk);
  }

  /** Get counts by status */
  getCounts(): { pending: number; assigned: number; running: number; completed: number; failed: number; total: number } {
    let pending = 0, assigned = 0, running = 0, completed = 0, failed = 0;
    for (const chunk of this.chunks.values()) {
      switch (chunk.status) {
        case 'pending': pending++; break;
        case 'assigned': assigned++; break;
        case 'running': running++; break;
        case 'completed': completed++; break;
        case 'failed': failed++; break;
      }
    }
    return { pending, assigned, running, completed, failed, total: this.chunks.size };
  }

  /** Get all chunks for a pool */
  getChunksForPool(poolId: string): WorkChunk[] {
    const result: WorkChunk[] = [];
    for (const chunk of this.chunks.values()) {
      if (chunk.assignedPool === poolId) result.push(chunk);
    }
    return result;
  }

  /** Get a chunk by ID */
  getChunk(chunkId: string): WorkChunk | undefined {
    return this.chunks.get(chunkId);
  }
}

// ============================================================================
// STRATEGY PLANNER
// ============================================================================

/**
 * Default adaptive strategy that:
 *   - Scales up pools with pending work
 *   - Scales down idle pools
 *   - Reallocates budget from idle to busy pools
 */
export function adaptiveStrategy(snapshot: SystemSnapshot): StrategyPlan {
  const scaleUp = new Map<string, number>();
  const scaleDown = new Map<string, number>();
  const budgetReallocation = new Map<string, number>();
  const newChunks: StrategyPlan['newChunks'] = [];

  const budgetUsedPct = snapshot.totalBudgetCeiling > 0
    ? snapshot.totalBudgetSpent / snapshot.totalBudgetCeiling
    : 0;

  const descriptions: string[] = [];

  for (const [poolId, pool] of snapshot.pools) {
    const utilization = pool.maxConcurrent > 0 ? pool.active / pool.maxConcurrent : 0;
    const failRate = (pool.completed + pool.failed) > 0
      ? pool.failed / (pool.completed + pool.failed)
      : 0;

    // Scale up: pool has pending work and isn't at capacity
    if (pool.pendingChunks > 0 && utilization < 0.8 && budgetUsedPct < 0.9) {
      const target = Math.min(
        pool.maxConcurrent,
        pool.active + Math.ceil(pool.pendingChunks * 0.5),
      );
      if (target > pool.active) {
        scaleUp.set(poolId, target);
        descriptions.push(`Scale up ${poolId}: ${pool.active} → ${target}`);
      }
    }

    // Scale down: no pending work and low utilization
    if (pool.pendingChunks === 0 && utilization > 0 && pool.active > 1) {
      const target = Math.max(1, Math.floor(pool.active * 0.5));
      if (target < pool.active) {
        scaleDown.set(poolId, target);
        descriptions.push(`Scale down ${poolId}: ${pool.active} → ${target}`);
      }
    }

    // Budget: reduce allocation for high-fail-rate pools
    if (failRate > 0.3 && pool.budgetPerAgent > 100) {
      const newBudget = Math.max(100, Math.floor(pool.budgetPerAgent * 0.7));
      budgetReallocation.set(poolId, newBudget);
      descriptions.push(`Reduce budget for ${poolId}: ${pool.budgetPerAgent} → ${newBudget}`);
    }
  }

  // Compute confidence based on data quality
  const totalTasks = snapshot.completedTasks + snapshot.failedTasks;
  const confidence = totalTasks > 10 ? 0.8 : totalTasks > 0 ? 0.5 : 0.3;

  return {
    description: descriptions.length > 0 ? descriptions.join('; ') : 'No changes needed',
    scaleUp,
    scaleDown,
    budgetReallocation,
    newChunks,
    confidence,
    createdAt: Date.now(),
  };
}

// ============================================================================
// STRATEGY AGENT
// ============================================================================

/**
 * AI Meta-Orchestrator that manages agent pools, work distribution, and
 * adaptive strategy. Designed for controlling thousands to millions of agents.
 *
 * @example
 * ```typescript
 * const strategy = new StrategyAgent({
 *   globalAgentLimit: 10000,
 *   globalBudgetLimit: 1_000_000,
 *   evaluationInterval: 5000,
 * });
 *
 * // Define agent templates
 * strategy.createPool({
 *   id: 'researchers',
 *   adapter: 'langchain',
 *   defaultAction: 'research',
 *   defaultParams: { depth: 'thorough' },
 *   maxConcurrent: 500,
 *   budgetPerAgent: 1000,
 *   tags: ['research', 'data'],
 * });
 *
 * // Distribute work
 * const urls = [...thousandUrls];
 * strategy.distributeWork(urls, 'researchers', 2);
 *
 * // Start auto-evaluation loop
 * strategy.start();
 *
 * // Or manually evaluate + execute
 * const plan = await strategy.evaluate();
 * await strategy.executePlan(plan);
 * ```
 */
export class StrategyAgent extends EventEmitter {
  private pools: Map<string, AgentPool> = new Map();
  private partitioner: WorkloadPartitioner;
  private strategyFn: StrategyFunction;
  private evaluationInterval: number;
  private globalAgentLimit: number;
  private globalBudgetLimit: number;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private _cycleCount = 0;
  private _plans: StrategyPlan[] = [];

  constructor(options: StrategyAgentOptions = {}) {
    super();
    this.partitioner = new WorkloadPartitioner(this);
    this.strategyFn = options.strategy ?? adaptiveStrategy;
    this.evaluationInterval = options.evaluationInterval ?? 5000;
    this.globalAgentLimit = options.globalAgentLimit ?? 10000;
    this.globalBudgetLimit = options.globalBudgetLimit ?? Infinity;
    if (options.autoStart) this.start();
  }

  // --------------------------------------------------------------------------
  // POOL MANAGEMENT
  // --------------------------------------------------------------------------

  /** Create an agent pool from a template */
  createPool(template: AgentTemplate): AgentPool {
    if (this.pools.has(template.id)) {
      throw new Error(`Pool "${template.id}" already exists`);
    }
    const pool = new AgentPool(template, this);
    this.pools.set(template.id, pool);
    this.emit('pool:created', template.id);
    return pool;
  }

  /** Get a pool by template ID */
  getPool(templateId: string): AgentPool | undefined {
    return this.pools.get(templateId);
  }

  /** List all pools */
  listPools(): Array<PoolStatus> {
    const result: PoolStatus[] = [];
    for (const [id, pool] of this.pools) {
      const pendingChunks = this.partitioner.getPendingForPool(id).length;
      result.push(pool.getStatus(pendingChunks));
    }
    return result;
  }

  /** Remove a pool (recycles all agents first) */
  removePool(templateId: string): boolean {
    const pool = this.pools.get(templateId);
    if (!pool) return false;
    pool.recycle();
    this.pools.delete(templateId);
    return true;
  }

  /** Total active agents across all pools */
  get totalActiveAgents(): number {
    let total = 0;
    for (const pool of this.pools.values()) total += pool.active;
    return total;
  }

  /** Whether the global agent limit has been reached */
  get atCapacity(): boolean {
    return this.totalActiveAgents >= this.globalAgentLimit;
  }

  // --------------------------------------------------------------------------
  // WORK DISTRIBUTION
  // --------------------------------------------------------------------------

  /**
   * Distribute work items across a pool.
   * Each input becomes a work chunk assigned to the pool.
   */
  distributeWork(inputs: unknown[], targetPool: string, priority = 1): WorkChunk[] {
    if (!this.pools.has(targetPool)) {
      throw new Error(`Pool "${targetPool}" does not exist`);
    }
    return this.partitioner.partition(inputs, targetPool, priority);
  }

  /** Get work distribution status */
  getWorkStatus(): ReturnType<WorkloadPartitioner['getCounts']> {
    return this.partitioner.getCounts();
  }

  /** Access the partitioner directly */
  get workload(): WorkloadPartitioner {
    return this.partitioner;
  }

  // --------------------------------------------------------------------------
  // STRATEGY EVALUATION
  // --------------------------------------------------------------------------

  /** Take a snapshot of the current system state */
  snapshot(budgetSpent = 0, budgetCeiling = 0, fsmState = 'unknown'): SystemSnapshot {
    const pools = new Map<string, PoolStatus>();
    let runningAgents = 0;
    let completedTasks = 0;
    let failedTasks = 0;
    let totalDuration = 0;
    let durationCount = 0;

    for (const [id, pool] of this.pools) {
      const pendingChunks = this.partitioner.getPendingForPool(id).length;
      pools.set(id, pool.getStatus(pendingChunks));
      runningAgents += pool.active;
      completedTasks += pool.completed;
      failedTasks += pool.failed;

      // Compute average task duration from completed agents
      for (const agent of pool.getAgents()) {
        if (agent.status === 'completed' && agent.completedAt) {
          totalDuration += agent.completedAt - agent.spawnedAt;
          durationCount++;
        }
      }
    }

    const counts = this.partitioner.getCounts();

    return {
      pools,
      totalBudgetSpent: budgetSpent,
      totalBudgetCeiling: budgetCeiling,
      fsmState,
      pendingChunks: counts.pending,
      runningAgents,
      completedTasks,
      failedTasks,
      averageTaskDuration: durationCount > 0 ? totalDuration / durationCount : 0,
      timestamp: Date.now(),
    };
  }

  /** Evaluate the current state and produce a strategy plan */
  async evaluate(budgetSpent = 0, budgetCeiling = 0, fsmState = 'unknown'): Promise<StrategyPlan> {
    const snap = this.snapshot(budgetSpent, budgetCeiling, fsmState);
    const plan = await this.strategyFn(snap);
    this._plans.push(plan);
    this.emit('plan:created', plan);
    return plan;
  }

  /**
   * Execute a strategy plan: scale pools, reallocate budgets, create chunks.
   * Returns the number of actions taken.
   */
  executePlan(plan: StrategyPlan): number {
    let actions = 0;

    // Scale up: spawn agents to reach target
    for (const [poolId, target] of plan.scaleUp) {
      const pool = this.pools.get(poolId);
      if (!pool) continue;
      const toSpawn = target - pool.active;
      for (let i = 0; i < toSpawn; i++) {
        if (this.atCapacity) break;
        const pending = this.partitioner.getPendingForPool(poolId);
        const chunk = pending[0];
        const agent = pool.spawn(chunk?.id);
        if (agent && chunk) {
          this.partitioner.assign(chunk.id, agent.id);
        }
        if (agent) actions++;
      }
      if (toSpawn > 0) {
        this.emit('pool:scaled', poolId, pool.active - toSpawn, pool.active);
      }
    }

    // Scale down: mark excess agents for recycling
    for (const [poolId, _target] of plan.scaleDown) {
      const pool = this.pools.get(poolId);
      if (!pool) continue;
      const before = pool.active;
      pool.recycle();
      if (pool.active !== before) {
        this.emit('pool:scaled', poolId, before, pool.active);
        actions++;
      }
    }

    // Budget reallocation
    for (const [poolId, newBudget] of plan.budgetReallocation) {
      const pool = this.pools.get(poolId);
      if (!pool) continue;
      (pool.template as { budgetPerAgent: number }).budgetPerAgent = newBudget;
      actions++;
    }

    // Create new chunks
    for (const chunk of plan.newChunks) {
      this.partitioner.partition([chunk.input], chunk.targetPool, chunk.priority);
      actions++;
    }

    this.emit('plan:executed', plan);
    return actions;
  }

  // --------------------------------------------------------------------------
  // EVALUATION LOOP
  // --------------------------------------------------------------------------

  /** Start the automatic evaluation loop */
  start(): void {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(async () => {
      this._cycleCount++;
      this.emit('cycle:start', this._cycleCount);
      const plan = await this.evaluate();
      this.executePlan(plan);
      this.emit('cycle:end', this._cycleCount, plan);
    }, this.evaluationInterval);
  }

  /** Stop the evaluation loop */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Whether the evaluation loop is running */
  get isRunning(): boolean { return this.intervalHandle !== null; }

  /** Number of evaluation cycles completed */
  get cycleCount(): number { return this._cycleCount; }

  /** All plans produced so far */
  get planHistory(): ReadonlyArray<StrategyPlan> { return this._plans; }

  // --------------------------------------------------------------------------
  // CONVENIENCE
  // --------------------------------------------------------------------------

  /** Get a summary string of the current state */
  summary(): string {
    const pools = this.listPools();
    const work = this.getWorkStatus();
    const lines = [
      `Pools: ${pools.length} | Active agents: ${this.totalActiveAgents}/${this.globalAgentLimit}`,
      `Work: ${work.pending} pending, ${work.running} running, ${work.completed} completed, ${work.failed} failed`,
      `Plans: ${this._plans.length} | Cycles: ${this._cycleCount}`,
    ];
    for (const p of pools) {
      lines.push(`  ${p.templateId}: ${p.active}/${p.maxConcurrent} active, ${p.completed} done, ${p.failed} failed, ${p.totalTokensUsed} tokens`);
    }
    return lines.join('\n');
  }
}
