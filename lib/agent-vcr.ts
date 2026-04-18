/**
 * VCR — Record and replay LLM/agent interactions for testing
 *
 * Provides a VCR (Video Cassette Recorder) pattern for capturing
 * agent execution calls and replaying them deterministically in tests.
 *
 * Modes:
 *   - `record` — Intercepts calls, forwards to real handler, saves cassette
 *   - `replay` — Matches calls to recorded cassettes, returns saved results
 *   - `passthrough` — Disabled, all calls go to real handler
 *
 * Features:
 *   - Cassettes stored as JSON files
 *   - Request matching by agent ID + action + params hash
 *   - Configurable matching strictness
 *   - Call ordering enforcement (optional)
 *   - Missing cassette detection with helpful errors
 *
 * Usage:
 *   const vcr = new AgentVCR({ mode: 'record', cassettePath: './fixtures' });
 *   const result = await vcr.execute('agent-1', payload, realHandler);
 *   await vcr.save('my-test'); // Saves cassette to ./fixtures/my-test.json
 *
 *   // Later in tests:
 *   const vcr2 = new AgentVCR({ mode: 'replay', cassettePath: './fixtures' });
 *   await vcr2.load('my-test');
 *   const result2 = await vcr2.execute('agent-1', payload); // Returns recorded result
 *
 * @module AgentVCR
 * @version 1.0.0
 */

import { readFile, writeFile, mkdir, stat } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';

// ============================================================================
// TYPES
// ============================================================================

/** VCR operating mode */
export type VCRMode = 'record' | 'replay' | 'passthrough';

/** A single recorded interaction */
export interface VCRInteraction {
  /** Request fingerprint for matching */
  fingerprint: string;
  /** Agent ID */
  agentId: string;
  /** Action/instruction */
  action: string;
  /** Params hash (for matching) */
  paramsHash: string;
  /** Full request payload (for debugging) */
  request: Record<string, unknown>;
  /** Recorded response */
  response: Record<string, unknown>;
  /** When this was recorded */
  recordedAt: number;
  /** Execution duration in ms */
  durationMs: number;
}

/** A cassette file — collection of recorded interactions */
export interface VCRCassette {
  /** Cassette name */
  name: string;
  /** When the cassette was created */
  createdAt: number;
  /** Recorded interactions */
  interactions: VCRInteraction[];
  /** Metadata */
  metadata?: Record<string, unknown>;
}

/** VCR configuration */
export interface VCRConfig {
  /** Operating mode */
  mode: VCRMode;
  /** Directory for cassette files */
  cassettePath: string;
  /** Match strictness: 'exact' matches full params, 'fuzzy' matches agent+action only */
  matchMode?: 'exact' | 'fuzzy';
  /** Whether to enforce call ordering in replay (default: false) */
  ordered?: boolean;
  /** Whether to throw on missing cassette in replay (default: true) */
  throwOnMissing?: boolean;
}

/** Real execution handler — wraps the actual agent call */
export type VCRHandler = (
  agentId: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** Match result for debugging */
export interface VCRMatchResult {
  matched: boolean;
  fingerprint: string;
  candidates: number;
  bestMatch?: VCRInteraction;
}

// ============================================================================
// VCR
// ============================================================================

/**
 * Agent VCR — Record and replay agent execution calls.
 *
 * In `record` mode, calls are forwarded to the real handler and saved.
 * In `replay` mode, calls are matched to saved cassettes.
 */
export class AgentVCR {
  private cassette: VCRCassette | null = null;
  private replayIndex = 0;
  private readonly config: Required<VCRConfig>;

  constructor(config: VCRConfig) {
    this.config = {
      mode: config.mode,
      cassettePath: config.cassettePath,
      matchMode: config.matchMode ?? 'exact',
      ordered: config.ordered ?? false,
      throwOnMissing: config.throwOnMissing ?? true,
    };
  }

  /** Get current mode */
  get mode(): VCRMode {
    return this.config.mode;
  }

  /** Set mode at runtime */
  setMode(mode: VCRMode): void {
    (this.config as { mode: VCRMode }).mode = mode;
  }

  /**
   * Execute an agent call through the VCR.
   *
   * @param agentId - The agent to call
   * @param payload - The request payload
   * @param handler - Real handler (required in record/passthrough mode)
   */
  async execute(
    agentId: string,
    payload: Record<string, unknown>,
    handler?: VCRHandler,
  ): Promise<Record<string, unknown>> {
    switch (this.config.mode) {
      case 'passthrough':
        if (!handler) throw new Error('VCR passthrough mode requires a handler');
        return handler(agentId, payload);

      case 'record':
        return this.recordExecution(agentId, payload, handler);

      case 'replay':
        return this.replayExecution(agentId, payload);

      default:
        throw new Error(`Unknown VCR mode: ${this.config.mode}`);
    }
  }

  /**
   * Load a cassette from disk.
   */
  async load(name: string): Promise<VCRCassette> {
    const filePath = join(this.config.cassettePath, `${name}.json`);
    const raw = await readFile(filePath, 'utf-8');
    this.cassette = JSON.parse(raw) as VCRCassette;
    this.replayIndex = 0;
    return this.cassette;
  }

  /**
   * Save the current recording as a named cassette.
   */
  async save(name: string): Promise<void> {
    if (!this.cassette) {
      this.cassette = { name, createdAt: Date.now(), interactions: [] };
    }
    this.cassette.name = name;

    try {
      await stat(this.config.cassettePath);
    } catch {
      await mkdir(this.config.cassettePath, { recursive: true });
    }

    const filePath = join(this.config.cassettePath, `${name}.json`);
    await writeFile(filePath, JSON.stringify(this.cassette, null, 2), 'utf-8');
  }

  /** Get the current cassette */
  getCassette(): VCRCassette | null {
    return this.cassette;
  }

  /** Reset the VCR (clear cassette and replay index) */
  reset(): void {
    this.cassette = null;
    this.replayIndex = 0;
  }

  /** Get number of recorded interactions */
  get interactionCount(): number {
    return this.cassette?.interactions.length ?? 0;
  }

  /**
   * Try to match a request to a recorded interaction.
   * Useful for debugging match failures.
   */
  findMatch(agentId: string, payload: Record<string, unknown>): VCRMatchResult {
    const fingerprint = this.computeFingerprint(agentId, payload);
    if (!this.cassette) {
      return { matched: false, fingerprint, candidates: 0 };
    }

    const candidates = this.cassette.interactions.filter((i) => {
      if (this.config.matchMode === 'fuzzy') {
        return i.agentId === agentId;
      }
      return i.fingerprint === fingerprint;
    });

    return {
      matched: candidates.length > 0,
      fingerprint,
      candidates: candidates.length,
      bestMatch: candidates[0],
    };
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private async recordExecution(
    agentId: string,
    payload: Record<string, unknown>,
    handler?: VCRHandler,
  ): Promise<Record<string, unknown>> {
    if (!handler) throw new Error('VCR record mode requires a handler');

    if (!this.cassette) {
      this.cassette = { name: 'recording', createdAt: Date.now(), interactions: [] };
    }

    const start = Date.now();
    const response = await handler(agentId, payload);
    const durationMs = Date.now() - start;

    const action = (payload['action'] as string) ?? '';
    const paramsHash = this.hashParams(payload);
    const fingerprint = this.computeFingerprint(agentId, payload);

    this.cassette.interactions.push({
      fingerprint,
      agentId,
      action,
      paramsHash,
      request: payload,
      response,
      recordedAt: Date.now(),
      durationMs,
    });

    return response;
  }

  private replayExecution(
    agentId: string,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!this.cassette || this.cassette.interactions.length === 0) {
      throw new Error('No cassette loaded for replay. Call load() first.');
    }

    // Ordered mode: use sequential index
    if (this.config.ordered) {
      if (this.replayIndex >= this.cassette.interactions.length) {
        throw new Error(
          `VCR replay exhausted: ${this.replayIndex} calls made but only ${this.cassette.interactions.length} recorded`,
        );
      }
      const interaction = this.cassette.interactions[this.replayIndex++];
      return interaction.response;
    }

    // Unordered: match by fingerprint
    const fingerprint = this.computeFingerprint(agentId, payload);

    const match = this.cassette.interactions.find((i) => {
      if (this.config.matchMode === 'fuzzy') {
        return i.agentId === agentId;
      }
      return i.fingerprint === fingerprint;
    });

    if (match) {
      return match.response;
    }

    if (this.config.throwOnMissing) {
      throw new Error(
        `VCR replay: no matching interaction for agent='${agentId}' fingerprint='${fingerprint}'. ` +
        `Cassette has ${this.cassette.interactions.length} interactions.`,
      );
    }

    return { error: 'VCR: no matching interaction', agentId };
  }

  private computeFingerprint(agentId: string, payload: Record<string, unknown>): string {
    const action = (payload['action'] as string) ?? '';
    const paramsHash = this.hashParams(payload);
    return `${agentId}:${action}:${paramsHash}`;
  }

  private hashParams(payload: Record<string, unknown>): string {
    const sorted = JSON.stringify(payload, Object.keys(payload).sort());
    return createHash('sha256').update(sorted).digest('hex').slice(0, 12);
  }
}
