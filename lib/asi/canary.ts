/**
 * ASI Strict Mode — canary tokens.
 *
 * Plant unique, meaningless markers in context given to agents (a fake
 * credential, a decoy blackboard key). Any canary that later appears in a
 * model output, tool argument, or outbound payload proves data crossed a
 * boundary it should not have. Canaries are random, so legitimate output
 * never contains them by chance.
 *
 * @module AsiCanary
 */

import { randomBytes } from 'crypto';
import { asiViolation, getAsiConfig } from './config';
import type { AsiStrictConfig } from './types';

/** A detected canary. */
export interface CanaryHit {
  canary: string;
  label: string;
}

/** Issues canaries and scans text for them. */
export class CanaryRegistry {
  private readonly canaries = new Map<string, string>();

  constructor(private readonly config: AsiStrictConfig = getAsiConfig(), private readonly prefix = 'nai-canary') {}

  /**
   * Create a canary for `label` (e.g. `'billing-db-password'`). Embed the
   * returned string where an exfiltration attempt would pick it up.
   */
  create(label: string): string {
    const canary = `${this.prefix}-${randomBytes(12).toString('hex')}`;
    this.canaries.set(canary, label);
    return canary;
  }

  /** Number of canaries issued. */
  get size(): number {
    return this.canaries.size;
  }

  /** Find every canary present in `text` (or in any string inside an object). */
  scan(value: unknown): CanaryHit[] {
    if (this.canaries.size === 0) return [];
    const haystack = typeof value === 'string' ? value : safeStringify(value);
    if (!haystack.includes(this.prefix)) return [];
    const hits: CanaryHit[] = [];
    for (const [canary, label] of this.canaries) {
      if (haystack.includes(canary)) hits.push({ canary, label });
    }
    return hits;
  }

  /**
   * Scan and report. Returns `true` when the output must be blocked (a canary
   * was found and strict mode enforces); audit mode reports but returns `false`.
   */
  check(value: unknown, agentId?: string, where = 'output'): boolean {
    const hits = this.scan(value);
    if (hits.length === 0) return false;
    return asiViolation(this.config, {
      kind: 'canary',
      agentId,
      reason: `canary leaked in ${where}`,
      details: { labels: hits.map((h) => h.label) },
    });
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
