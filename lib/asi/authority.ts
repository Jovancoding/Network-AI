/**
 * ASI Strict Mode — tamper-evident event export.
 *
 * {@link HashChainSink} links every strict-mode event to the previous one with
 * a SHA-256 hash chain and forwards it to an append-only destination outside
 * the agents' process ({@link ExternalAuthority.appendAudit}). An agent that
 * later edits or drops a local record cannot make the remote chain verify.
 *
 * @module AsiAuthority
 */

import { canonicalHash } from './canonical';
import type { AsiEvent, AsiEventSink, ExternalAuthority } from './types';

/** A chained event as exported. */
export type ChainedAsiEvent = AsiEvent & { prevHash: string; hash: string };

const GENESIS = '0'.repeat(64);

/** Hash-chains events and forwards them to an external authority (and optional local sink). */
export class HashChainSink implements AsiEventSink {
  private prevHash = GENESIS;
  private queue: Promise<void> = Promise.resolve();
  private failures = 0;

  constructor(private readonly authority: ExternalAuthority, private readonly local?: AsiEventSink) {
    if (typeof authority.appendAudit !== 'function') {
      throw new TypeError('HashChainSink: authority.appendAudit is required');
    }
  }

  /** Events that could not be delivered to the authority. */
  get deliveryFailures(): number {
    return this.failures;
  }

  record(event: AsiEvent): Promise<void> {
    const chained: ChainedAsiEvent = { ...event, prevHash: this.prevHash, hash: '' };
    chained.hash = canonicalHash({ ...event, prevHash: this.prevHash });
    this.prevHash = chained.hash;
    void this.local?.record(event);
    // Deliver in order; a failed delivery is counted, not retried silently out of order.
    this.queue = this.queue.then(() => this.authority.appendAudit!(chained)).catch(() => { this.failures++; });
    return this.queue;
  }
}

/** Verify a chain exported by {@link HashChainSink}. Returns the index of the first broken link, or -1. */
export function verifyEventChain(events: readonly ChainedAsiEvent[]): number {
  let prev = GENESIS;
  for (let i = 0; i < events.length; i++) {
    const { hash, prevHash, ...event } = events[i];
    if (prevHash !== prev || canonicalHash({ ...event, prevHash }) !== hash) return i;
    prev = hash;
  }
  return -1;
}
