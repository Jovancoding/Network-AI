/**
 * Context Composer — token-budgeted, relevance-ranked context assembly.
 *
 * Agents have large context windows but a much smaller *effective reasoning*
 * window: irrelevant, stale, or noisy context degrades output quality long
 * before the hard token limit ("context rot"). This module assembles the
 * context block for an LLM call from candidate sources (blackboard entries,
 * project context, memory recall) under a **hard token budget**, ranked by:
 *
 *   score = w.relevance × relevance + w.recency × recency + w.affinity × affinity
 *
 * - **relevance** — semantic similarity to the task via a pluggable
 *   {@link SemanticRanker} (BYOE — e.g. wrap `SemanticMemory`), with a
 *   deterministic lexical-overlap fallback when no ranker is supplied;
 * - **recency**  — exponential half-life decay on the entry timestamp
 *   (the same math `EpisodicMemory` uses);
 * - **affinity** — scope-tag match on the key (same substring semantics as
 *   `ContextThrottler`).
 *
 * Pinned sources (task-critical instructions, Layer-3 project context) are
 * always included first. Assembly is position-aware by default: the
 * strongest items are placed at the start *and end* of the block, weakest in
 * the middle — mitigating "lost in the middle" attention decay.
 *
 * The result carries full observability metadata: what was included,
 * what was excluded and why, token usage, and budget utilization.
 *
 * @example
 * ```ts
 * const composer = new ContextComposer();
 * const sources = ContextComposer.fromSnapshot(blackboard.getScopedSnapshot('analyst'));
 * const pack = await composer.compose(sources, {
 *   task: 'Summarize Q3 revenue anomalies',
 *   budgetTokens: 2000,
 *   scopeTags: ['analytics', 'task'],
 * });
 * llmPrompt = `${instructions}\n\n${pack.text}`;
 * ```
 *
 * @module ContextComposer
 * @version 1.0.0
 */

// ============================================================================
// TOKEN ESTIMATION
// ============================================================================

/**
 * Estimate the token count of a text without a tokenizer dependency.
 *
 * Uses the ~4-characters-per-token heuristic blended with a word count
 * (English prose averages ~0.75 tokens/word; code and JSON run denser).
 * Accurate to roughly ±15% across prose/code/JSON — sufficient for budget
 * enforcement, not for billing.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const byChars = text.length / 4;
  const words = text.split(/\s+/).filter(Boolean).length;
  const byWords = words * 1.33;
  return Math.max(1, Math.ceil((byChars + byWords) / 2));
}

// ============================================================================
// TYPES
// ============================================================================

/** One candidate context item offered to the composer. */
export interface ContextSource {
  /** Unique identifier (blackboard key, memory id, …) */
  key: string;
  /** Rendered text content of this item */
  text: string;
  /** Agent that produced the item, when known */
  sourceAgent?: string;
  /** ISO timestamp of the item, when known (drives recency decay) */
  timestamp?: string;
  /** TTL in seconds (`null`/`undefined` = no expiry) — expired items are dropped */
  ttl?: number | null;
  /** Pinned items bypass ranking and are always included first (budget permitting) */
  pinned?: boolean;
}

/** A source annotated with its ranking scores. */
export interface RankedContextItem extends ContextSource {
  /** Semantic (or lexical-fallback) relevance to the task, 0–1 */
  relevance: number;
  /** Recency after half-life decay, 0–1 */
  recency: number;
  /** Scope-tag affinity, 0–1 */
  affinity: number;
  /** Weighted total score, 0–1 */
  score: number;
  /** Estimated token cost of this item's rendered block */
  tokens: number;
}

/** Why an item was left out of the composed pack. */
export type ExclusionReason = 'budget' | 'score' | 'stale' | 'empty';

/** An excluded item and the reason it was dropped. */
export interface ExcludedItem {
  key: string;
  reason: ExclusionReason;
  score?: number;
}

/**
 * Pluggable semantic ranker: given the task text and candidate items,
 * return a map of key → similarity score (0–1). Missing keys fall back to
 * lexical scoring. BYOE — bring your own embeddings.
 */
export type SemanticRanker = (
  query: string,
  items: ReadonlyArray<{ key: string; text: string }>
) => Promise<Map<string, number>>;

/** Scoring weights (normalized internally; defaults: 0.5 / 0.3 / 0.2). */
export interface ScoreWeights {
  relevance?: number;
  recency?: number;
  affinity?: number;
}

/** Options for a single {@link ContextComposer.compose} call. */
export interface ComposeOptions {
  /** The task/query driving relevance ranking (required) */
  task: string;
  /** Hard token budget for the entire composed block (required, > 0) */
  budgetTokens: number;
  /** Scope tags for affinity scoring (ContextThrottler semantics: substring match on key) */
  scopeTags?: string[];
  /** Score weights — merged over the composer defaults */
  weights?: ScoreWeights;
  /** Recency half-life in ms (default: composer default, 30 min) */
  halfLifeMs?: number;
  /** Items scoring below this are excluded outright (default 0.05) */
  minScore?: number;
  /** Hard cap on the number of included items (0 = unlimited) */
  maxItems?: number;
  /** Override the composer-level semantic ranker for this call */
  ranker?: SemanticRanker;
  /**
   * Position-aware assembly (default true): strongest items at the start
   * AND end of the block, weakest in the middle.
   */
  positionAware?: boolean;
}

/** The assembled, budget-enforced context pack. */
export interface ComposedContext {
  /** Final assembled context block, ready to inject into a prompt */
  text: string;
  /** Items included, in ranked order (not layout order) */
  included: RankedContextItem[];
  /** Items excluded, with reasons */
  excluded: ExcludedItem[];
  /** The budget that was enforced */
  budgetTokens: number;
  /** Estimated tokens used by `text` */
  usedTokens: number;
  /** usedTokens / budgetTokens (0–1) */
  utilization: number;
}

/** Constructor options for {@link ContextComposer}. */
export interface ContextComposerOptions {
  /** Default half-life for recency decay in ms (default: 1_800_000 = 30 min) */
  halfLifeMs?: number;
  /** Default scoring weights */
  weights?: ScoreWeights;
  /** Default semantic ranker (BYOE) */
  ranker?: SemanticRanker;
}

/** Shape of a blackboard snapshot entry accepted by {@link ContextComposer.fromSnapshot}. */
interface SnapshotEntryLike {
  value?: unknown;
  sourceAgent?: string;
  source_agent?: string;
  timestamp?: string;
  ttl?: number | null;
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/** Tokenize text into a lowercase word set for lexical overlap scoring. */
function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length > 2)
  );
}

/**
 * Deterministic lexical relevance: fraction of task words present in the
 * item (key + text). Zero-dependency fallback when no semantic ranker is
 * configured.
 */
function lexicalRelevance(taskWords: Set<string>, item: { key: string; text: string }): number {
  if (taskWords.size === 0) return 0;
  const itemWords = wordSet(`${item.key} ${item.text}`);
  if (itemWords.size === 0) return 0;
  let hits = 0;
  for (const w of taskWords) {
    if (itemWords.has(w)) hits++;
  }
  return hits / taskWords.size;
}

/** Exponential half-life recency decay (1 = now, → 0 with age). */
function recencyScore(timestamp: string | undefined, halfLifeMs: number, now: number): number {
  if (!timestamp) return 0.5; // unknown age — neutral
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return 0.5;
  const elapsed = Math.max(0, now - t);
  return Math.pow(0.5, elapsed / halfLifeMs);
}

/** Scope-tag affinity — ContextThrottler substring semantics on the key. */
function affinityScore(key: string, scopeTags: string[] | undefined): number {
  if (!scopeTags || scopeTags.length === 0) return 0.5; // no scoping — neutral
  const lowerKey = key.toLowerCase();
  return scopeTags.some((tag) => lowerKey.includes(tag.toLowerCase())) ? 1 : 0;
}

/** True when the entry's TTL has already elapsed relative to its timestamp. */
function isStale(source: ContextSource, now: number): boolean {
  if (source.ttl === null || source.ttl === undefined) return false;
  if (!source.timestamp) return false;
  const t = Date.parse(source.timestamp);
  if (Number.isNaN(t)) return false;
  return now - t > source.ttl * 1000;
}

/** Render one item as a labelled context block. */
function renderBlock(item: ContextSource): string {
  const origin = item.sourceAgent ? ` (from ${item.sourceAgent})` : '';
  return `### ${item.key}${origin}\n${item.text}`;
}

/**
 * Serpentine layout: ranked items `[1,2,3,4,5]` become `[1,3,5,4,2]` —
 * strongest first, second-strongest last, weakest in the middle.
 */
function positionAwareLayout<T>(ranked: T[]): T[] {
  const head: T[] = [];
  const tail: T[] = [];
  ranked.forEach((item, i) => {
    if (i % 2 === 0) head.push(item);
    else tail.unshift(item);
  });
  return [...head, ...tail];
}

// ============================================================================
// SEMANTIC MEMORY RANKER FACTORY
// ============================================================================

/** Minimal `SemanticMemory`-compatible search surface. */
export interface SemanticSearchLike {
  search(query: string, topK?: number, threshold?: number): Promise<Array<{ key: string; score: number }>>;
}

/**
 * Adapt a `SemanticMemory` instance (or anything with a compatible
 * `search()`) into a {@link SemanticRanker}. Items the memory does not know
 * about simply fall back to lexical scoring.
 */
export function createSemanticMemoryRanker(memory: SemanticSearchLike): SemanticRanker {
  return async (query, items) => {
    const results = await memory.search(query, items.length, 0);
    const scores = new Map<string, number>();
    for (const r of results) {
      // Cosine similarity may be negative — clamp to 0–1.
      scores.set(r.key, Math.max(0, Math.min(1, r.score)));
    }
    return scores;
  };
}

// ============================================================================
// CONTEXT COMPOSER
// ============================================================================

/**
 * Assembles token-budgeted, relevance-ranked context packs from candidate
 * sources. See the module docs for the ranking model.
 */
export class ContextComposer {
  private readonly halfLifeMs: number;
  private readonly weights: Required<ScoreWeights>;
  private readonly ranker: SemanticRanker | undefined;

  constructor(options: ContextComposerOptions = {}) {
    this.halfLifeMs = options.halfLifeMs ?? 1_800_000;
    if (this.halfLifeMs <= 0) {
      throw new Error('ContextComposer: halfLifeMs must be > 0');
    }
    const w = { relevance: 0.5, recency: 0.3, affinity: 0.2, ...(options.weights ?? {}) };
    const sum = w.relevance + w.recency + w.affinity;
    if (sum <= 0) {
      throw new Error('ContextComposer: score weights must sum to a positive number');
    }
    this.weights = {
      relevance: w.relevance / sum,
      recency: w.recency / sum,
      affinity: w.affinity / sum,
    };
    this.ranker = options.ranker;
  }

  /**
   * Convert a blackboard snapshot (`getSnapshot()` / `getScopedSnapshot()`
   * shape) into {@link ContextSource} candidates. Values are rendered as
   * strings (JSON for objects) and truncated to `maxValueChars`.
   */
  static fromSnapshot(
    snapshot: Record<string, unknown>,
    options: { maxValueChars?: number } = {}
  ): ContextSource[] {
    const maxChars = options.maxValueChars ?? 4000;
    const sources: ContextSource[] = [];
    for (const [key, raw] of Object.entries(snapshot ?? {})) {
      if (raw === null || raw === undefined) continue;
      let text: string;
      let sourceAgent: string | undefined;
      let timestamp: string | undefined;
      let ttl: number | null | undefined;

      if (typeof raw === 'object' && ('value' in (raw as object))) {
        const entry = raw as SnapshotEntryLike;
        const v = entry.value;
        text = typeof v === 'string' ? v : JSON.stringify(v);
        sourceAgent = entry.sourceAgent ?? entry.source_agent;
        timestamp = entry.timestamp;
        ttl = entry.ttl;
      } else {
        text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      }

      if (text === undefined || text === null) continue;
      sources.push({
        key,
        text: text.length > maxChars ? `${text.slice(0, maxChars)}…[truncated]` : text,
        ...(sourceAgent !== undefined ? { sourceAgent } : {}),
        ...(timestamp !== undefined ? { timestamp } : {}),
        ...(ttl !== undefined ? { ttl } : {}),
      });
    }
    return sources;
  }

  /**
   * Rank the candidate sources against the task and assemble the largest
   * high-signal context block that fits the token budget.
   */
  async compose(sources: ContextSource[], options: ComposeOptions): Promise<ComposedContext> {
    if (!options || typeof options.task !== 'string' || options.task.trim() === '') {
      throw new Error('ContextComposer.compose: options.task must be a non-empty string');
    }
    if (typeof options.budgetTokens !== 'number' || options.budgetTokens <= 0) {
      throw new Error('ContextComposer.compose: options.budgetTokens must be > 0');
    }

    const now = Date.now();
    const halfLifeMs = options.halfLifeMs ?? this.halfLifeMs;
    const minScore = options.minScore ?? 0.05;
    const maxItems = options.maxItems ?? 0;
    const w = (() => {
      if (!options.weights) return this.weights;
      const merged = { ...this.weights, ...options.weights };
      const sum = merged.relevance + merged.recency + merged.affinity;
      return sum > 0
        ? { relevance: merged.relevance / sum, recency: merged.recency / sum, affinity: merged.affinity / sum }
        : this.weights;
    })();

    const excluded: ExcludedItem[] = [];
    const pinned: ContextSource[] = [];
    const candidates: ContextSource[] = [];

    for (const source of sources ?? []) {
      if (!source || typeof source.key !== 'string' || source.key === '') continue;
      if (!source.text || source.text.trim() === '') {
        excluded.push({ key: source.key ?? '(unknown)', reason: 'empty' });
        continue;
      }
      if (isStale(source, now)) {
        excluded.push({ key: source.key, reason: 'stale' });
        continue;
      }
      (source.pinned ? pinned : candidates).push(source);
    }

    // ── Relevance scores (semantic ranker with lexical fallback) ────────────
    const taskWords = wordSet(options.task);
    let semanticScores = new Map<string, number>();
    const ranker = options.ranker ?? this.ranker;
    if (ranker && candidates.length > 0) {
      try {
        semanticScores = await ranker(
          options.task,
          candidates.map((c) => ({ key: c.key, text: c.text }))
        );
      } catch {
        semanticScores = new Map(); // ranker failure → lexical fallback for all
      }
    }

    // ── Score every candidate ────────────────────────────────────────────────
    const ranked: RankedContextItem[] = candidates.map((c) => {
      const relevance = semanticScores.get(c.key) ?? lexicalRelevance(taskWords, c);
      const recency = recencyScore(c.timestamp, halfLifeMs, now);
      const affinity = affinityScore(c.key, options.scopeTags);
      const score = w.relevance * relevance + w.recency * recency + w.affinity * affinity;
      return { ...c, relevance, recency, affinity, score, tokens: estimateTokens(renderBlock(c)) };
    });
    ranked.sort((a, b) => b.score - a.score);

    // ── Budget-enforced selection: pinned first, then by score ──────────────
    const included: RankedContextItem[] = [];
    let usedTokens = 0;

    for (const p of pinned) {
      const tokens = estimateTokens(renderBlock(p));
      if (usedTokens + tokens > options.budgetTokens) {
        excluded.push({ key: p.key, reason: 'budget' });
        continue;
      }
      usedTokens += tokens;
      included.push({ ...p, relevance: 1, recency: 1, affinity: 1, score: 1, tokens });
    }

    for (const item of ranked) {
      if (item.score < minScore) {
        excluded.push({ key: item.key, reason: 'score', score: item.score });
        continue;
      }
      if (maxItems > 0 && included.length >= maxItems) {
        excluded.push({ key: item.key, reason: 'budget', score: item.score });
        continue;
      }
      if (usedTokens + item.tokens > options.budgetTokens) {
        excluded.push({ key: item.key, reason: 'budget', score: item.score });
        continue;
      }
      usedTokens += item.tokens;
      included.push(item);
    }

    // ── Assembly (pinned lead; ranked items in position-aware layout) ────────
    const pinnedBlocks = included.filter((i) => i.pinned);
    const rankedBlocks = included.filter((i) => !i.pinned);
    const layout = (options.positionAware ?? true)
      ? positionAwareLayout(rankedBlocks)
      : rankedBlocks;

    const text = [...pinnedBlocks, ...layout].map((i) => renderBlock(i)).join('\n\n');

    return {
      text,
      included,
      excluded,
      budgetTokens: options.budgetTokens,
      usedTokens,
      utilization: Math.min(1, usedTokens / options.budgetTokens),
    };
  }
}
