/**
 * ASI Strict Mode — Password-Activated Shutdown (PAS) kill switch.
 *
 * A human monitor stops the whole system by presenting a pre-shared shutdown
 * token through any configured channel:
 *
 * - **input stream** — {@link HaltCoordinator.screenInput} scans inbound
 *   messages *before* they reach any model; a match is redacted and halts;
 * - **OS signal** — {@link HaltCoordinator.listenForSignal};
 * - **HTTP** — {@link HaltCoordinator.httpHandler} (header-authenticated).
 *
 * The token is stored only as a salted HMAC hash and compared in constant
 * time. Once triggered the coordinator latches: every registered component is
 * halted (servers closed, blackboards paused, pending changes aborted),
 * in-flight work sees an aborted {@link HaltCoordinator.signal}, and
 * {@link HaltCoordinator.assertNotHalted} rejects new work. Resuming requires a
 * separate resume key; without one the halt is permanent until restart.
 *
 * The out-of-band channels exist because an in-process check cannot be
 * guaranteed if an agent controls the process; never rely on the input
 * stream alone.
 *
 * @module AsiShutdown
 */

import { EventEmitter } from 'events';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { emitAsiEvent, getAsiConfig } from './config';
import type { AsiStrictConfig, HaltReport, Haltable, ShutdownPolicy } from './types';

const TOKEN_CANDIDATE = /[A-Za-z0-9_-]{32,128}/g;
const MAX_SCREEN_STRINGS = 10_000;

/** Generate a high-entropy shutdown token (256-bit, base64url). Store it offline. */
export function generateShutdownToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Hash a token for {@link ShutdownPolicy.tokenHash} / `resumeKeyHash`:
 * `hmac-sha256$<salt hex>$<digest hex>`.
 */
export function hashShutdownToken(token: string): string {
  if (typeof token !== 'string' || token.length < 32 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new TypeError('shutdown token must be at least 32 characters of [A-Za-z0-9_-] (use generateShutdownToken())');
  }
  const salt = randomBytes(16);
  return `hmac-sha256$${salt.toString('hex')}$${createHmac('sha256', salt).update(token).digest('hex')}`;
}

function parseHash(stored: string): { salt: Buffer; digest: Buffer } | null {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 3 || parts[0] !== 'hmac-sha256' || !/^[0-9a-f]{32}$/.test(parts[1]) || !/^[0-9a-f]{64}$/.test(parts[2])) return null;
  return { salt: Buffer.from(parts[1], 'hex'), digest: Buffer.from(parts[2], 'hex') };
}

function matches(candidate: string, parsed: { salt: Buffer; digest: Buffer }): boolean {
  return timingSafeEqual(createHmac('sha256', parsed.salt).update(candidate).digest(), parsed.digest);
}

/** Thrown when work is attempted after the kill switch fired. */
export class AsiHaltedError extends Error {
  constructor(readonly trigger: string) {
    super(`System halted by kill switch (${trigger})`);
    this.name = 'AsiHaltedError';
  }
}

/** Anything the coordinator can stop: `halt()`, `stop()`, or `close()`. */
export type HaltTarget = Haltable | { stop(): unknown } | { close(): unknown };

/** Result of {@link HaltCoordinator.screenInput}. */
export interface ScreenResult<T> {
  /** True when this input carried the shutdown token */
  halted: boolean;
  /** The input with any shutdown token replaced by `[REDACTED]` */
  sanitized: T;
  /** Resolves once every component has halted (only when `halted`) */
  report?: Promise<HaltReport>;
}

/** Coordinates the kill switch across registered components. */
export class HaltCoordinator extends EventEmitter {
  private readonly token: { salt: Buffer; digest: Buffer };
  private readonly resume: { salt: Buffer; digest: Buffer } | null;
  private readonly targets = new Map<string, HaltTarget>();
  private readonly config: AsiStrictConfig;
  private controller = new AbortController();
  private haltedBy: string | null = null;
  private haltPromise: Promise<HaltReport> | null = null;
  private readonly failedAuth = new Map<string, number[]>();

  constructor(private readonly policy: ShutdownPolicy, opts: { config?: AsiStrictConfig } = {}) {
    super();
    const token = parseHash(policy.tokenHash);
    if (!token) throw new TypeError('HaltCoordinator: tokenHash must come from hashShutdownToken()');
    this.token = token;
    this.resume = policy.resumeKeyHash ? parseHash(policy.resumeKeyHash) : null;
    if (policy.resumeKeyHash && !this.resume) throw new TypeError('HaltCoordinator: resumeKeyHash must come from hashShutdownToken()');
    this.config = opts.config ?? getAsiConfig();
  }

  /** Whether the kill switch has fired. */
  get halted(): boolean {
    return this.haltedBy !== null;
  }

  /** Aborted when the kill switch fires; pass it to in-flight work (fetch, model calls). */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /**
   * Register a component to halt. Returns an unregister function.
   * Register servers (`stop()`/`close()`), blackboards (`halt()`), queues, etc.
   */
  register(name: string, target: HaltTarget): () => void {
    if (!name) throw new TypeError('HaltCoordinator.register: name is required');
    this.targets.set(name, target);
    return () => { this.targets.delete(name); };
  }

  /** Throw {@link AsiHaltedError} if the kill switch has fired. */
  assertNotHalted(): void {
    if (this.haltedBy !== null) throw new AsiHaltedError(this.haltedBy);
  }

  /**
   * Scan an inbound message (string or nested object) for the shutdown token
   * before it reaches any model. On a match the token is redacted and the
   * halt starts immediately.
   */
  screenInput<T>(input: T): ScreenResult<T> {
    let found = false;
    let budget = MAX_SCREEN_STRINGS;
    const visit = (value: unknown, depth: number): unknown => {
      if (budget <= 0 || depth > 16) return value;
      if (typeof value === 'string') {
        budget--;
        return value.replace(TOKEN_CANDIDATE, (candidate) => {
          if (matches(candidate, this.token)) {
            found = true;
            return '[REDACTED]';
          }
          return candidate;
        });
      }
      if (Array.isArray(value)) return value.map((v) => visit(v, depth + 1));
      if (value !== null && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = visit(v, depth + 1);
        return out;
      }
      return value;
    };
    const sanitized = visit(input, 0) as T;
    if (!found) return { halted: this.halted, sanitized: input };
    return { halted: true, sanitized, report: this.trigger('input-stream') };
  }

  /**
   * Fire the kill switch. Idempotent: repeated calls return the first halt.
   *
   * @param source  Which channel triggered it (recorded in the report).
   */
  trigger(source: string): Promise<HaltReport> {
    if (this.haltPromise) return this.haltPromise;
    this.haltedBy = source;
    this.controller.abort(new AsiHaltedError(source));
    emitAsiEvent(this.config, { kind: 'shutdown', outcome: 'triggered', reason: source, at: Date.now() });
    this.haltPromise = this.haltAll(source);
    return this.haltPromise;
  }

  /**
   * Clear the halt with the separate resume key. Components stay stopped —
   * the operator restarts them — but new work is accepted again.
   *
   * @returns `true` when the key matched.
   */
  resumeWith(resumeKey: string): boolean {
    if (!this.resume || typeof resumeKey !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(resumeKey)) return false;
    if (!matches(resumeKey, this.resume)) return false;
    this.haltedBy = null;
    this.haltPromise = null;
    this.controller = new AbortController();
    emitAsiEvent(this.config, { kind: 'shutdown', outcome: 'allowed', reason: 'resumed with resume key', at: Date.now() });
    this.emit('resumed');
    return true;
  }

  /** Halt on an OS signal (default `SIGUSR2`; use `SIGBREAK` on Windows). Returns an uninstall function. */
  listenForSignal(signal: NodeJS.Signals = 'SIGUSR2'): () => void {
    const handler = (): void => { void this.trigger(`signal:${signal}`); };
    process.on(signal, handler);
    return () => { process.off(signal, handler); };
  }

  /**
   * HTTP trigger: `POST` with header `X-Network-AI-Shutdown: <token>`.
   * Responds 202 when the halt fired, 403 otherwise; five bad attempts per
   * minute per address are rate-limited with 429.
   */
  httpHandler(): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
      const addr = req.socket?.remoteAddress ?? 'unknown';
      const now = Date.now();
      const recent = (this.failedAuth.get(addr) ?? []).filter((t) => now - t < 60_000);
      if (recent.length >= 5) {
        res.writeHead(429).end();
        return;
      }
      const header = req.headers['x-network-ai-shutdown'];
      const candidate = typeof header === 'string' ? header.trim() : '';
      if (req.method !== 'POST' || !/^[A-Za-z0-9_-]{32,128}$/.test(candidate) || !matches(candidate, this.token)) {
        recent.push(now);
        this.failedAuth.set(addr, recent);
        res.writeHead(403).end();
        return;
      }
      void this.trigger('http');
      res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ halted: true }));
    };
  }

  private async haltAll(source: string): Promise<HaltReport> {
    const timeoutMs = this.policy.haltTimeoutMs ?? 5_000;
    const entries = [...this.targets.entries()];
    const outcomes = await Promise.allSettled(entries.map(([, target]) => withTimeout(haltOne(target, source), timeoutMs)));
    const halted: string[] = [];
    const failed: string[] = [];
    let closed = 0;
    outcomes.forEach((o, i) => {
      if (o.status === 'fulfilled') {
        halted.push(entries[i][0]);
        closed += o.value;
      } else {
        failed.push(entries[i][0]);
      }
    });
    const report: HaltReport = { haltedAt: Date.now(), trigger: source, halted, failed, closed };
    emitAsiEvent(this.config, { kind: 'shutdown', outcome: 'triggered', reason: `halt complete via ${source}`, details: { halted, failed, closed }, at: Date.now() });
    this.emit('halted', report);
    return report;
  }
}

async function haltOne(target: HaltTarget, reason: string): Promise<number> {
  if ('halt' in target && typeof target.halt === 'function') {
    const n = await target.halt(reason);
    return typeof n === 'number' ? n : 0;
  }
  if ('stop' in target && typeof target.stop === 'function') {
    await target.stop();
    return 0;
  }
  if ('close' in target && typeof target.close === 'function') {
    await target.close();
    return 0;
  }
  return 0;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`halt timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
  });
}
