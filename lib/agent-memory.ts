/**
 * AgentMemory — Multi-layer memory system for agents.
 *
 * Three memory layers:
 * - **Episodic**: per-run short-term memory with time-based decay
 * - **Procedural**: persistent skill/chain patterns (e.g. SkillComposer recipes)
 * - **Shared long-term**: cross-agent knowledge base with relevance scoring
 *
 * @module AgentMemory
 */

// ============================================================================
// TYPES
// ============================================================================

/** A single memory entry */
export interface MemoryEntry {
  id: string;
  content: string;
  tags: string[];
  createdAt: number;
  lastAccessed: number;
  accessCount: number;
  score: number;
  metadata: Record<string, unknown>;
}

/** Episodic memory entry — decays over time */
export interface EpisodicEntry extends MemoryEntry {
  /** Decay half-life in milliseconds */
  halfLifeMs: number;
}

/** Procedural memory entry — persistent skill/pattern */
export interface ProceduralEntry extends MemoryEntry {
  /** The pattern type (chain, batch, loop, etc.) */
  patternType: string;
  /** Number of times this pattern succeeded */
  successCount: number;
  /** Number of times this pattern failed */
  failureCount: number;
}

/** Shared long-term entry — cross-agent knowledge */
export interface SharedEntry extends MemoryEntry {
  /** Agent that contributed this knowledge */
  sourceAgent: string;
  /** Agents that have accessed this entry */
  accessedBy: Set<string>;
}

/** Query options for memory recall */
export interface RecallOptions {
  tags?: string[];
  maxResults?: number;
  minScore?: number;
  /** Only entries newer than this timestamp */
  since?: number;
}

// ============================================================================
// EPISODIC MEMORY
// ============================================================================

/**
 * Short-term, per-run memory with exponential time decay.
 * Entries lose relevance over time; stale entries are pruned.
 */
export class EpisodicMemory {
  private entries: Map<string, EpisodicEntry> = new Map();
  private maxEntries: number;
  private defaultHalfLifeMs: number;

  constructor(options: { maxEntries?: number; defaultHalfLifeMs?: number } = {}) {
    this.maxEntries = options.maxEntries ?? 500;
    this.defaultHalfLifeMs = options.defaultHalfLifeMs ?? 600_000; // 10 minutes
  }

  /** Store a new episodic memory */
  store(content: string, tags: string[] = [], metadata: Record<string, unknown> = {}, halfLifeMs?: number): string {
    const id = `ep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    this.entries.set(id, {
      id,
      content,
      tags,
      createdAt: now,
      lastAccessed: now,
      accessCount: 0,
      score: 1.0,
      metadata,
      halfLifeMs: halfLifeMs ?? this.defaultHalfLifeMs,
    });
    this.evict();
    return id;
  }

  /** Recall entries matching criteria, scored by recency and decay */
  recall(options: RecallOptions = {}): EpisodicEntry[] {
    const now = Date.now();
    const results: EpisodicEntry[] = [];

    for (const entry of this.entries.values()) {
      // Apply decay
      const elapsed = now - entry.createdAt;
      const decayFactor = Math.pow(0.5, elapsed / entry.halfLifeMs);
      entry.score = decayFactor;

      if (options.minScore !== undefined && entry.score < options.minScore) continue;
      if (options.since !== undefined && entry.createdAt < options.since) continue;
      if (options.tags && options.tags.length > 0) {
        const matches = options.tags.some(t => entry.tags.includes(t));
        if (!matches) continue;
      }

      entry.lastAccessed = now;
      entry.accessCount++;
      results.push(entry);
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, options.maxResults ?? 20);
  }

  /** Remove a specific entry */
  remove(id: string): boolean {
    return this.entries.delete(id);
  }

  /** Clear all entries */
  clear(): void {
    this.entries.clear();
  }

  /** Number of stored entries */
  size(): number {
    return this.entries.size;
  }

  /** Prune entries below a score threshold */
  prune(minScore = 0.01): number {
    const now = Date.now();
    let pruned = 0;
    for (const [id, entry] of this.entries) {
      const elapsed = now - entry.createdAt;
      const decayFactor = Math.pow(0.5, elapsed / entry.halfLifeMs);
      if (decayFactor < minScore) {
        this.entries.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  private evict(): void {
    if (this.entries.size <= this.maxEntries) return;
    // Remove oldest entries
    const sorted = [...this.entries.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    const toRemove = sorted.slice(0, this.entries.size - this.maxEntries);
    for (const [id] of toRemove) this.entries.delete(id);
  }
}

// ============================================================================
// PROCEDURAL MEMORY
// ============================================================================

/**
 * Persistent memory for successful skill/chain patterns.
 * Agents learn which patterns work and prefer them in future.
 */
export class ProceduralMemory {
  private entries: Map<string, ProceduralEntry> = new Map();
  private maxEntries: number;

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries = options.maxEntries ?? 1000;
  }

  /** Register a pattern (chain/batch/loop/verify) */
  register(
    id: string,
    content: string,
    patternType: string,
    tags: string[] = [],
    metadata: Record<string, unknown> = {},
  ): ProceduralEntry {
    const now = Date.now();
    const existing = this.entries.get(id);
    if (existing) {
      existing.lastAccessed = now;
      existing.accessCount++;
      return existing;
    }
    const entry: ProceduralEntry = {
      id,
      content,
      tags,
      patternType,
      createdAt: now,
      lastAccessed: now,
      accessCount: 0,
      score: 0.5,
      metadata,
      successCount: 0,
      failureCount: 0,
    };
    this.entries.set(id, entry);
    this.evict();
    return entry;
  }

  /** Record success for a pattern — increases its score */
  recordSuccess(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.successCount++;
    entry.score = entry.successCount / (entry.successCount + entry.failureCount);
    entry.lastAccessed = Date.now();
  }

  /** Record failure for a pattern — decreases its score */
  recordFailure(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.failureCount++;
    entry.score = entry.successCount / (entry.successCount + entry.failureCount);
    entry.lastAccessed = Date.now();
  }

  /** Recall top-scoring patterns matching criteria */
  recall(options: RecallOptions & { patternType?: string } = {}): ProceduralEntry[] {
    const results: ProceduralEntry[] = [];
    for (const entry of this.entries.values()) {
      if (options.patternType && entry.patternType !== options.patternType) continue;
      if (options.minScore !== undefined && entry.score < options.minScore) continue;
      if (options.tags && options.tags.length > 0) {
        const matches = options.tags.some(t => entry.tags.includes(t));
        if (!matches) continue;
      }
      entry.lastAccessed = Date.now();
      entry.accessCount++;
      results.push(entry);
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, options.maxResults ?? 20);
  }

  /** Get a specific pattern by ID */
  get(id: string): ProceduralEntry | undefined {
    return this.entries.get(id);
  }

  /** Number of stored patterns */
  size(): number {
    return this.entries.size;
  }

  /** Clear all patterns */
  clear(): void {
    this.entries.clear();
  }

  private evict(): void {
    if (this.entries.size <= this.maxEntries) return;
    const sorted = [...this.entries.entries()].sort((a, b) => a[1].score - b[1].score);
    const toRemove = sorted.slice(0, this.entries.size - this.maxEntries);
    for (const [id] of toRemove) this.entries.delete(id);
  }
}

// ============================================================================
// SHARED LONG-TERM MEMORY
// ============================================================================

/**
 * Cross-agent shared knowledge base.
 * Any agent can contribute; all agents can query.
 * Relevance scored by tag overlap and access frequency.
 */
export class SharedLongTermMemory {
  private entries: Map<string, SharedEntry> = new Map();
  private maxEntries: number;

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries = options.maxEntries ?? 5000;
  }

  /** Contribute knowledge to the shared store */
  contribute(
    sourceAgent: string,
    content: string,
    tags: string[] = [],
    metadata: Record<string, unknown> = {},
  ): string {
    const id = `shared_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    this.entries.set(id, {
      id,
      content,
      tags,
      createdAt: now,
      lastAccessed: now,
      accessCount: 0,
      score: 0.5,
      metadata,
      sourceAgent,
      accessedBy: new Set(),
    });
    this.evict();
    return id;
  }

  /** Query shared memory, scored by tag overlap and recency */
  query(agentId: string, options: RecallOptions = {}): SharedEntry[] {
    const results: SharedEntry[] = [];
    const queryTags = options.tags ?? [];

    for (const entry of this.entries.values()) {
      if (options.since !== undefined && entry.createdAt < options.since) continue;

      // Score by tag overlap
      let tagScore = 0;
      if (queryTags.length > 0) {
        const overlap = queryTags.filter(t => entry.tags.includes(t)).length;
        tagScore = overlap / queryTags.length;
        if (overlap === 0) continue; // no tag overlap = skip
      } else {
        tagScore = 0.5; // no filter = moderate relevance
      }

      // Boost by access frequency
      const freqBoost = Math.min(entry.accessCount / 10, 1.0) * 0.3;
      entry.score = tagScore * 0.7 + freqBoost;

      if (options.minScore !== undefined && entry.score < options.minScore) continue;

      entry.lastAccessed = Date.now();
      entry.accessCount++;
      entry.accessedBy.add(agentId);
      results.push(entry);
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, options.maxResults ?? 20);
  }

  /** Get all entries contributed by a specific agent */
  getByAgent(sourceAgent: string): SharedEntry[] {
    return [...this.entries.values()].filter(e => e.sourceAgent === sourceAgent);
  }

  /** Number of stored entries */
  size(): number {
    return this.entries.size;
  }

  /** Clear all entries */
  clear(): void {
    this.entries.clear();
  }

  private evict(): void {
    if (this.entries.size <= this.maxEntries) return;
    const sorted = [...this.entries.entries()].sort((a, b) => a[1].score - b[1].score);
    const toRemove = sorted.slice(0, this.entries.size - this.maxEntries);
    for (const [id] of toRemove) this.entries.delete(id);
  }
}

// ============================================================================
// UNIFIED AGENT MEMORY
// ============================================================================

/**
 * Unified memory system combining all three layers.
 * Instantiate per-agent for episodic, share ProceduralMemory and
 * SharedLongTermMemory across agents.
 *
 * @example
 * ```ts
 * const procedural = new ProceduralMemory();
 * const shared = new SharedLongTermMemory();
 *
 * const agentMemory = new AgentMemory('agent-1', { procedural, shared });
 * agentMemory.episodic.store('Completed code review', ['review', 'code']);
 * agentMemory.procedural.recordSuccess('chain-review-fix');
 * agentMemory.shared.contribute('agent-1', 'Auth service uses JWT', ['auth']);
 * ```
 */
export class AgentMemory {
  public readonly agentId: string;
  public readonly episodic: EpisodicMemory;
  public readonly procedural: ProceduralMemory;
  public readonly shared: SharedLongTermMemory;

  constructor(
    agentId: string,
    options: {
      episodic?: EpisodicMemory;
      procedural?: ProceduralMemory;
      shared?: SharedLongTermMemory;
    } = {},
  ) {
    this.agentId = agentId;
    this.episodic = options.episodic ?? new EpisodicMemory();
    this.procedural = options.procedural ?? new ProceduralMemory();
    this.shared = options.shared ?? new SharedLongTermMemory();
  }

  /** Recall across all layers, merged and ranked by score */
  recallAll(options: RecallOptions = {}): MemoryEntry[] {
    const results: MemoryEntry[] = [
      ...this.episodic.recall(options),
      ...this.procedural.recall(options),
      ...this.shared.query(this.agentId, options),
    ];
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, options.maxResults ?? 30);
  }
}
