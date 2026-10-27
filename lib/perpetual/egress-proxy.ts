/**
 * Perpetual Runtime — Egress Proxy (runs in its own process).
 *
 * The only network path for agents. Agents never hold API keys: they call
 * `http://<proxy>/<route>/<path>` with their signed lease in the
 * `X-Network-AI-Lease` header. The proxy verifies the lease signature, asks
 * the authority whether it is still active (revocation, pause), checks the
 * route against the lease scope, injects the real credential, and scrubs
 * credential values and cookies from the response. Without a valid lease,
 * nothing leaves.
 *
 * Phase 1 is gateway-style (named routes to fixed upstreams). There is no
 * CONNECT tunnelling and no TLS interception.
 *
 * @module EgressProxy
 */

import type { IncomingMessage, ServerResponse, Server } from 'http';
import type { KeyObject } from 'crypto';
import { isLoopbackHost } from '../http-guards';
import { verifyLease } from './signing';
import type { SignedLease } from './types';

/** One upstream an agent may reach by name. */
export interface EgressRoute {
  /** Route name; must appear in the lease's `scope.destinations` */
  name: string;
  /** Upstream base URL, e.g. `https://api.openai.com` */
  upstream: string;
  /** Credential injected on every forwarded request; the value never reaches the agent */
  credential?: { header: string; value: () => string; prefix?: string };
  /** Allowed HTTP methods (default GET, POST) */
  methods?: readonly string[];
  /** Allowed upstream path prefixes (default: all) */
  pathPrefixes?: readonly string[];
  /**
   * Financial route: every request must carry a JSON body with a numeric amount
   * at `amountField` (dot path, in USD). Requests above `maxPerRequestUsd`, or
   * that would take a run past `maxPerRunUsd`, are refused here, outside the agent.
   */
  financial?: { amountField: string; maxPerRequestUsd: number; maxPerRunUsd: number };
}

/** One proxy decision, for the audit trail. */
export interface EgressEvent {
  at: number;
  outcome: 'forwarded' | 'denied' | 'error';
  route?: string;
  leaseId?: string;
  runId?: string;
  status?: number;
  reason?: string;
}

/** Constructor options for {@link EgressProxy}. */
export interface EgressProxyOptions {
  authorityPublicKey: KeyObject;
  /** Revocation check against the authority (e.g. `HttpLeaseTransport.isActive`) */
  isLeaseActive: (leaseId: string) => Promise<boolean>;
  routes: readonly EgressRoute[];
  /** How long a positive status check is cached (default 2 s) */
  statusCacheMs?: number;
  /** Max forwarded requests per lease per minute (default 120) */
  ratePerMinute?: number;
  /** Max request body forwarded (default 1 MiB) */
  maxRequestBytes?: number;
  /** Max response body returned (default 10 MiB) */
  maxResponseBytes?: number;
  /** Upstream timeout (default 30 s) */
  timeoutMs?: number;
  onEvent?: (event: EgressEvent) => void;
  now?: () => number;
}

const LEASE_HEADER = 'x-network-ai-lease';
const DROP_REQUEST_HEADERS = new Set([
  'host', 'authorization', 'cookie', 'proxy-authorization', 'proxy-connection', 'connection',
  'keep-alive', 'transfer-encoding', 'te', 'upgrade', 'trailer', 'content-length', LEASE_HEADER,
]);
const DROP_RESPONSE_HEADERS = new Set(['set-cookie', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding']);
const ROUTE_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Lease-gated, credential-injecting forward gateway. */
export class EgressProxy {
  private readonly routes = new Map<string, EgressRoute & { base: URL }>();
  private readonly statusCache = new Map<string, number>();
  private readonly rate = new Map<string, number[]>();
  private readonly runSpend = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly options: EgressProxyOptions) {
    this.now = options.now ?? Date.now;
    for (const route of options.routes) {
      if (!ROUTE_NAME.test(route.name)) throw new TypeError(`EgressProxy: invalid route name "${route.name}"`);
      const base = new URL(route.upstream);
      if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new TypeError(`EgressProxy: route ${route.name} must use http(s)`);
      if (route.credential && !/^[A-Za-z0-9-]{1,64}$/.test(route.credential.header)) {
        throw new TypeError(`EgressProxy: route ${route.name} has an invalid credential header`);
      }
      const fin = route.financial;
      if (fin && (!/^[A-Za-z0-9_]{1,64}(\.[A-Za-z0-9_]{1,64}){0,7}$/.test(fin.amountField)
        || !(fin.maxPerRequestUsd >= 0 && Number.isFinite(fin.maxPerRequestUsd))
        || !(fin.maxPerRunUsd >= 0 && Number.isFinite(fin.maxPerRunUsd)))) {
        throw new TypeError(`EgressProxy: route ${route.name} has an invalid financial limit`);
      }
      this.routes.set(route.name, { ...route, base });
    }
  }

  /** HTTP handler: `/<route>/<path>` with the lease in `X-Network-AI-Lease`. */
  httpHandler(): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
      void this.handle(req, res).catch(() => this.deny(res, 502, 'proxy error', {}));
    };
  }

  /** Start on loopback (or an explicit sandbox bridge address with `allowRemote`). */
  startServer(port: number, opts: { host?: string; allowRemote?: boolean } = {}): Server {
    const host = opts.host ?? '127.0.0.1';
    if (!isLoopbackHost(host) && opts.allowRemote !== true) {
      throw new Error('EgressProxy: refusing to bind a non-loopback host without allowRemote: true');
    }
    const http = require('http') as typeof import('http');
    const server = http.createServer(this.httpHandler());
    server.listen(port, host);
    return server;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://proxy.local');
    const [, routeName = '', ...rest] = url.pathname.split('/');
    const route = this.routes.get(routeName);
    if (!route) return this.deny(res, 404, 'unknown route', {});

    const lease = decodeLease(req.headers[LEASE_HEADER]);
    if (!lease) return this.deny(res, 401, 'lease required', { route: routeName });
    const ctx = { route: routeName, leaseId: lease.claims.leaseId, runId: lease.claims.runId };
    const invalid = verifyLease(lease, this.options.authorityPublicKey, this.now());
    if (invalid) return this.deny(res, 403, invalid, ctx);
    if (!(lease.claims.scope.destinations ?? []).includes(routeName)) return this.deny(res, 403, 'route outside lease scope', ctx);
    if (!(await this.leaseActive(lease.claims.leaseId))) return this.deny(res, 403, 'lease revoked or paused', ctx);
    if (!this.allowRate(lease.claims.leaseId)) return this.deny(res, 429, 'rate limit', ctx);

    const method = (req.method ?? 'GET').toUpperCase();
    if (!(route.methods ?? ['GET', 'POST']).includes(method)) return this.deny(res, 405, 'method not allowed', ctx);
    if (rest.some((seg) => seg === '..' || seg === '.' || decodeURIComponent(seg).includes('/'))) return this.deny(res, 400, 'invalid path', ctx);
    const upstreamPath = `${route.base.pathname.replace(/\/$/, '')}/${rest.join('/')}`;
    if (route.pathPrefixes && !route.pathPrefixes.some((p) => upstreamPath.startsWith(p))) return this.deny(res, 403, 'path not allowed', ctx);
    const target = new URL(upstreamPath + url.search, route.base);
    if (target.origin !== route.base.origin) return this.deny(res, 400, 'invalid path', ctx);

    const body = await readBody(req, this.options.maxRequestBytes ?? 1024 * 1024);
    if (body === null) return this.deny(res, 413, 'request body too large', ctx);

    let amount = 0;
    if (route.financial) {
      const fin = route.financial;
      amount = readAmount(body, fin.amountField) ?? NaN;
      if (!(amount >= 0 && Number.isFinite(amount))) return this.deny(res, 400, `financial request needs a numeric ${fin.amountField}`, ctx);
      if (amount > fin.maxPerRequestUsd) return this.deny(res, 403, 'amount above the per-request limit', ctx);
      const spent = this.runSpend.get(`${routeName}\0${ctx.runId}`) ?? 0;
      if (spent + amount > fin.maxPerRunUsd) return this.deny(res, 403, 'amount would exceed the per-run limit', ctx);
      // Reserve before forwarding so concurrent requests cannot overshoot.
      this.runSpend.set(`${routeName}\0${ctx.runId}`, spent + amount);
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (DROP_REQUEST_HEADERS.has(key.toLowerCase()) || value === undefined) continue;
      headers[key] = Array.isArray(value) ? value.join(', ') : value;
    }
    const secrets: string[] = [];
    if (route.credential) {
      const value = route.credential.value();
      if (!value) return this.deny(res, 503, 'credential unavailable', ctx);
      secrets.push(value);
      headers[route.credential.header] = `${route.credential.prefix ?? ''}${value}`;
    }

    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method,
        headers,
        body: body.length && method !== 'GET' && method !== 'HEAD' ? body : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });
    } catch {
      this.emit({ outcome: 'error', ...ctx, reason: 'upstream unreachable' });
      return this.deny(res, 502, 'upstream unreachable', ctx, false);
    }

    const raw = Buffer.from(await upstream.arrayBuffer());
    const limit = this.options.maxResponseBytes ?? 10 * 1024 * 1024;
    if (raw.length > limit) return this.deny(res, 502, 'upstream response too large', ctx);
    const outHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      if (!DROP_RESPONSE_HEADERS.has(key.toLowerCase())) outHeaders[key] = scrub(value, secrets);
    });
    const scrubbed = isTextual(outHeaders['content-type']) ? Buffer.from(scrub(raw.toString('utf8'), secrets), 'utf8') : raw;
    res.writeHead(upstream.status, { ...outHeaders, 'content-length': String(scrubbed.length) }).end(scrubbed);
    this.emit({ outcome: 'forwarded', ...ctx, status: upstream.status });
  }

  private async leaseActive(leaseId: string): Promise<boolean> {
    const cachedAt = this.statusCache.get(leaseId);
    if (cachedAt !== undefined && this.now() - cachedAt < (this.options.statusCacheMs ?? 2_000)) return true;
    let active = false;
    try {
      active = await this.options.isLeaseActive(leaseId);
    } catch {
      active = false;
    }
    if (active) this.statusCache.set(leaseId, this.now());
    else this.statusCache.delete(leaseId);
    return active;
  }

  private allowRate(leaseId: string): boolean {
    const now = this.now();
    const recent = (this.rate.get(leaseId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= (this.options.ratePerMinute ?? 120)) return false;
    recent.push(now);
    this.rate.set(leaseId, recent);
    return true;
  }

  private deny(res: ServerResponse, status: number, reason: string, ctx: Partial<EgressEvent>, audit = true): void {
    if (audit) this.emit({ outcome: 'denied', ...ctx, status, reason });
    if (res.headersSent) return;
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: reason }));
  }

  private emit(event: Omit<EgressEvent, 'at'>): void {
    try {
      this.options.onEvent?.({ ...event, at: this.now() });
    } catch {
      // Audit delivery must never break the proxy decision.
    }
  }
}

function decodeLease(header: string | string[] | undefined): SignedLease | null {
  if (typeof header !== 'string' || header.length > 16_384) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' && 'claims' in parsed ? (parsed as SignedLease) : null;
  } catch {
    return null;
  }
}

/** Encode a lease for the `X-Network-AI-Lease` header. */
export function encodeLeaseHeader(lease: SignedLease): string {
  return Buffer.from(JSON.stringify(lease), 'utf8').toString('base64url');
}

function readAmount(body: Buffer, field: string): number | null {
  let value: unknown;
  try { value = JSON.parse(body.toString('utf8')); } catch { return null; }
  for (const part of field.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.prototype.hasOwnProperty.call(value, part)) return null;
    value = (value as Record<string, unknown>)[part];
  }
  return typeof value === 'number' ? value : typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) ? Number(value) : null;
}

function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length < 4) continue;
    out = out.split(s).join('[REDACTED]');
    const b64 = Buffer.from(s, 'utf8').toString('base64');
    if (b64.length >= 8) out = out.split(b64).join('[REDACTED]');
  }
  return out;
}

function isTextual(contentType: string | undefined): boolean {
  if (!contentType) return true;
  return /^(text\/|application\/(json|xml|x-www-form-urlencoded|.*\+json|.*\+xml|javascript))/i.test(contentType);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
