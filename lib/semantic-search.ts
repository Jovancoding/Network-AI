/**
 * Semantic Memory Search — Embeddings-based retrieval over blackboard data
 *
 * Provides an in-memory vector store that can index blackboard entries and
 * answer similarity queries. Bring your own embedding function (BYOE) —
 * no runtime dependency on any specific model or provider.
 *
 * Optionally persists the index to a JSON file (`persistPath`) so memory
 * survives process restarts without re-embedding everything.
 *
 * Inspired by Claw-Code's semantic memory pattern.
 *
 * @module SemanticSearch
 * @version 1.1.0
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

// ============================================================================
// TYPES
// ============================================================================

/**
 * User-provided function that converts text to a fixed-length float vector.
 * Can wrap OpenAI, Cohere, local models, etc.
 */
export type EmbeddingFn = (text: string) => Promise<number[]>;

/**
 * A single search result with similarity score.
 */
export interface SearchResult {
  /** Blackboard key or document id */
  key: string;
  /** The stored value */
  value: unknown;
  /** Cosine similarity (0–1, higher = more similar) */
  score: number;
  /** Which agent wrote this entry */
  sourceAgent: string;
}

/**
 * An indexed entry stored in the semantic memory.
 */
interface IndexedEntry {
  key: string;
  text: string;
  value: unknown;
  sourceAgent: string;
  embedding: number[];
}

// ============================================================================
// MATH HELPERS
// ============================================================================

/**
 * Cosine similarity between two equal-length vectors.
 * Returns 0 for zero-magnitude vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ============================================================================
// SEMANTIC MEMORY
// ============================================================================

/**
 * In-memory semantic vector store with optional file-backed persistence.
 *
 * @example
 * ```typescript
 * // Ephemeral (in-memory only)
 * const memory = new SemanticMemory(async (text) => openai.embed(text));
 *
 * // Persistent across restarts
 * const memory = new SemanticMemory(
 *   async (text) => openai.embed(text),
 *   { persistPath: './data/semantic-index.json' }
 * );
 * await memory.load(); // restore from disk on startup
 *
 * // Index entries
 * await memory.index('task:1', 'Quarterly revenue analysis', { status: 'done' }, 'analyst');
 * await memory.save(); // flush to disk
 *
 * // Search
 * const results = await memory.search('financial trends', 5);
 * // → [{ key: 'task:1', score: 0.87, ... }]
 * ```
 */
export class SemanticMemory {
  private entries: Map<string, IndexedEntry> = new Map();
  private embeddingFn: EmbeddingFn;
  private readonly persistPath: string | undefined;

  /**
   * @param embeddingFn  Function that produces embeddings from text
   * @param options      Optional configuration
   * @param options.persistPath  Path to a JSON file for durable storage.
   *   Call `load()` after construction to restore, and `save()` (or use
   *   `autoSave`) to flush writes.
   */
  constructor(
    embeddingFn: EmbeddingFn,
    options?: { persistPath?: string }
  ) {
    this.embeddingFn = embeddingFn;
    this.persistPath = options?.persistPath ? resolve(options.persistPath) : undefined;
  }

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------

  /**
   * Persist the current in-memory index to `persistPath`.
   * No-op when `persistPath` was not set.
   */
  save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const data = {
        version: 1,
        savedAt: new Date().toISOString(),
        entries: Array.from(this.entries.values()),
      };
      writeFileSync(this.persistPath, JSON.stringify(data), 'utf-8');
    } catch { /* non-fatal */ }
  }

  /**
   * Restore the index from `persistPath`.
   * No-op when `persistPath` was not set or the file does not exist.
   *
   * Call this once after construction to warm the index from a previous run.
   */
  load(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = readFileSync(this.persistPath, 'utf-8');
      const data = JSON.parse(raw) as { version: number; entries: IndexedEntry[] };
      if (data.version !== 1 || !Array.isArray(data.entries)) return;
      this.entries.clear();
      for (const entry of data.entries) {
        if (
          typeof entry.key === 'string' &&
          Array.isArray(entry.embedding) &&
          entry.embedding.length > 0
        ) {
          this.entries.set(entry.key, entry);
        }
      }
    } catch { /* non-fatal — start with empty index */ }
  }

  /**
   * Delete the persistence file.
   * Useful for clearing stale indexes between projects.
   */
  clearPersisted(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const { unlinkSync } = require('fs') as typeof import('fs');
      unlinkSync(this.persistPath);
    } catch { /* ignore */ }
  }

  /**
   * Index a key–value pair with its text representation.
   * Re-indexing the same key replaces the previous embedding.
   *
   * @param key Unique identifier
   * @param text The text to embed for similarity matching
   * @param value The value to return in search results
   * @param sourceAgent Agent that produced this entry
   * @param autoSave Flush to disk after indexing (requires `persistPath`). Default false.
   */
  async index(key: string, text: string, value: unknown, sourceAgent: string, autoSave = false): Promise<void> {
    const embedding = await this.embeddingFn(text);
    this.entries.set(key, { key, text, value, sourceAgent, embedding });
    if (autoSave) this.save();
  }

  /**
   * Search for entries similar to the query text.
   *
   * @param query Natural language query
   * @param topK Maximum results to return (default 5)
   * @param threshold Minimum cosine similarity (default 0)
   * @returns Sorted results, highest similarity first
   */
  async search(query: string, topK = 5, threshold = 0): Promise<SearchResult[]> {
    if (this.entries.size === 0) return [];

    const queryEmbedding = await this.embeddingFn(query);

    const scored: SearchResult[] = [];

    for (const entry of this.entries.values()) {
      const score = cosineSimilarity(queryEmbedding, entry.embedding);
      if (score >= threshold) {
        scored.push({
          key: entry.key,
          value: entry.value,
          score,
          sourceAgent: entry.sourceAgent,
        });
      }
    }

    // Sort descending by score, take top-K
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * Bulk-index all entries from a blackboard snapshot.
   *
   * @param snapshot Record of key → { value, source_agent } (from LockedBlackboard.getSnapshot())
   * @returns Number of entries indexed
   */
  async indexSnapshot(
    snapshot: Record<string, { value: unknown; source_agent: string }>,
  ): Promise<number> {
    let count = 0;
    for (const [key, entry] of Object.entries(snapshot)) {
      const text = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
      await this.index(key, text, entry.value, entry.source_agent);
      count++;
    }
    return count;
  }

  /**
   * Remove an entry by key.
   * @returns true if an entry was removed
   */
  remove(key: string): boolean {
    return this.entries.delete(key);
  }

  /**
   * Remove all indexed entries.
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Number of indexed entries.
   */
  size(): number {
    return this.entries.size;
  }

  /**
   * Check if a key is indexed.
   */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * List all indexed keys.
   */
  keys(): string[] {
    return Array.from(this.entries.keys());
  }
}
