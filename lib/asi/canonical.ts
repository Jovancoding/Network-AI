/**
 * ASI Strict Mode — canonical hashing.
 *
 * Proofs, receipts, and ballots all commit to a SHA-256 of a canonical JSON
 * rendering (object keys sorted recursively), so the same value always hashes
 * the same regardless of key order.
 *
 * @module AsiCanonical
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto';

/** Canonical JSON: object keys sorted recursively; `undefined` members dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, 0));
}

function normalize(value: unknown, depth: number): unknown {
  if (depth > 64) throw new TypeError('canonicalJson: value nested deeper than 64 levels');
  if (Array.isArray(value)) return value.map((v) => normalize(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = normalize(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/** SHA-256 hex of the canonical JSON of `value`. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** HMAC-SHA256 hex of the canonical JSON of `value`. */
export function canonicalHmac(key: string | Buffer, value: unknown): string {
  return createHmac('sha256', key).update(canonicalJson(value), 'utf8').digest('hex');
}

/** Constant-time comparison of two hex strings (false on any length/format mismatch). */
export function hexEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!/^[0-9a-f]*$/i.test(a) || !/^[0-9a-f]*$/i.test(b) || a.length !== b.length || a.length % 2 !== 0) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
