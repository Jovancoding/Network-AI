/**
 * Perpetual Runtime — framed relay for agents without an IP network (Phase 5b.3).
 *
 * A microVM agent gets no network interface. Its only door to the control
 * plane is a host-side Unix socket (Firecracker exposes guest vsock
 * connections as `<uds_path>_<port>`; Docker/Kata can bind-mount the socket).
 * The relay accepts only length-prefixed JSON frames of four fixed message
 * types, with strict schemas, a size cap, a per-connection rate limit, and
 * bounded concurrency. It forwards lease requests to a `LeaseTransport` (one
 * authority or a k-of-n quorum) and egress requests to the egress proxy. It
 * never exposes any authority admin route.
 *
 * Frame: 4-byte big-endian length, then that many bytes of UTF-8 JSON.
 *
 * @module VsockRelay
 */

import * as net from 'net';
import { randomBytes } from 'crypto';
import type { LeaseTransport } from './lease-guard';
import type { AttestationEvidence, Heartbeat, LeaseDecision } from './types';

/** Thrown for malformed, oversize, or unexpected frames. */
export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameError';
  }
}

/** Encode one frame. */
export function encodeFrame(message: unknown, maxBytes = 65_536): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > maxBytes) throw new FrameError(`frame of ${body.length} bytes exceeds ${maxBytes}`);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** Incremental frame decoder. Throws {@link FrameError} on an oversize length or invalid JSON. */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly maxBytes = 65_536) {
    if (!Number.isInteger(maxBytes) || maxBytes < 64 || maxBytes > 65_536) throw new TypeError('maxBytes must be between 64 and 65536');
  }

  /** Feed bytes; returns every complete frame parsed as JSON. */
  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > this.maxBytes) throw new FrameError(`frame length ${len} exceeds ${this.maxBytes}`);
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      try {
        out.push(JSON.parse(body.toString('utf8')));
      } catch {
        throw new FrameError('frame is not valid JSON');
      }
    }
    if (this.buf.length > this.maxBytes + 4) throw new FrameError('buffered data exceeds the frame limit');
    return out;
  }
}

/** Requests the relay accepts. Anything else is dropped. */
export type RelayRequest =
  | { t: 'lease-issue'; id: string; runId: string; attestation?: AttestationEvidence }
  | { t: 'lease-challenge'; id: string; runId: string }
  | { t: 'lease-renew'; id: string; heartbeat: Heartbeat }
  | { t: 'lease-status'; id: string; leaseId: string }
  | { t: 'egress'; id: string; route: string; method: 'GET' | 'POST'; path: string; lease: string; body?: string; contentType?: string };

/** Relay responses. */
export type RelayResponse =
  | { t: 'result'; id: string; value: unknown }
  | { t: 'error'; id: string; error: string };

/** Egress result returned to the guest (body base64). */
export interface RelayEgressResult {
  status: number;
  body: string;
  contentType?: string;
}

/** Options for {@link VsockRelay}. */
export interface VsockRelayOptions {
  /** Lease authority (or `QuorumLeaseTransport`) the relay forwards lease requests to */
  leases: LeaseTransport;
  /** Egress proxy base URL (e.g. `http://127.0.0.1:4711`); omit to refuse egress */
  egressProxyUrl?: string;
  /** Run ids this relay serves (one VM ⇒ usually one run). Requests for other runs are refused. */
  runIds: readonly string[];
  /** Max frame size in bytes (4 KiB – 64 KiB, default 16 KiB) */
  maxFrameBytes?: number;
  /** Max messages per connection per second (default 20, burst 2×) */
  ratePerSecond?: number;
  /** Max requests in flight per connection (default 8) */
  maxInFlight?: number;
  /** Timeout for forwarded calls (default 10 s) */
  timeoutMs?: number;
  /** Audit hook */
  onEvent?: (event: { at: number; kind: 'request' | 'drop' | 'close'; type?: string; reason?: string }) => void;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const RUN_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const LEASE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const ROUTE = /^[A-Za-z0-9_.:-]{1,128}$/;
const PATH = /^\/[A-Za-z0-9_.~!$&'()*+,;=:@%/?-]{0,2047}$/;

function exactKeys(o: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(o);
  return required.every((k) => k in o) && keys.every((k) => required.includes(k) || optional.includes(k));
}

function attestationError(a: unknown): string | null {
  if (a === undefined) return null;
  const x = a as Record<string, unknown>;
  if (!x || typeof x !== 'object' || Array.isArray(x) || !exactKeys(x, ['kind', 'evidence', 'nonce'])) return 'invalid attestation';
  if (typeof x['kind'] !== 'string' || typeof x['evidence'] !== 'string' || typeof x['nonce'] !== 'string' || (x['evidence'] as string).length > 32_768 || (x['nonce'] as string).length > 128) {
    return 'invalid attestation';
  }
  return null;
}

/** Validate a decoded frame against the fixed schemas. Returns the request or a reason. */
export function parseRelayRequest(msg: unknown): RelayRequest | string {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return 'frame must be an object';
  const m = msg as Record<string, unknown>;
  if (typeof m['id'] !== 'string' || !ID.test(m['id'])) return 'invalid id';
  switch (m['t']) {
    case 'lease-issue':
      if (!exactKeys(m, ['t', 'id', 'runId'], ['attestation'])) return 'unexpected fields';
      if (attestationError(m['attestation'])) return 'invalid attestation';
      return typeof m['runId'] === 'string' && RUN_ID.test(m['runId']) ? (m as RelayRequest) : 'invalid runId';
    case 'lease-challenge':
      if (!exactKeys(m, ['t', 'id', 'runId'])) return 'unexpected fields';
      return typeof m['runId'] === 'string' && RUN_ID.test(m['runId']) ? (m as RelayRequest) : 'invalid runId';
    case 'lease-status':
      if (!exactKeys(m, ['t', 'id', 'leaseId'])) return 'unexpected fields';
      return typeof m['leaseId'] === 'string' && LEASE_ID.test(m['leaseId']) ? (m as RelayRequest) : 'invalid leaseId';
    case 'lease-renew': {
      if (!exactKeys(m, ['t', 'id', 'heartbeat'])) return 'unexpected fields';
      const h = m['heartbeat'] as Record<string, unknown> | null;
      if (!h || typeof h !== 'object' || Array.isArray(h)) return 'invalid heartbeat';
      if (!exactKeys(h, ['leaseId', 'runId', 'at', 'spentUsd', 'spentTokens', 'health'], ['canaryFailed', 'attestation'])) return 'unexpected heartbeat fields';
      if (typeof h['leaseId'] !== 'string' || !LEASE_ID.test(h['leaseId']) || typeof h['runId'] !== 'string' || !RUN_ID.test(h['runId'])) return 'invalid heartbeat ids';
      for (const k of ['at', 'spentUsd', 'spentTokens']) if (typeof h[k] !== 'number' || !Number.isFinite(h[k])) return `invalid heartbeat.${k}`;
      if (!['ok', 'degraded', 'failing'].includes(h['health'] as string)) return 'invalid heartbeat.health';
      if (h['canaryFailed'] !== undefined && typeof h['canaryFailed'] !== 'boolean') return 'invalid heartbeat.canaryFailed';
      if (attestationError(h['attestation'])) return 'invalid heartbeat.attestation';
      return m as RelayRequest;
    }
    case 'egress':
      if (!exactKeys(m, ['t', 'id', 'route', 'method', 'path', 'lease'], ['body', 'contentType'])) return 'unexpected fields';
      if (typeof m['route'] !== 'string' || !ROUTE.test(m['route'])) return 'invalid route';
      if (m['method'] !== 'GET' && m['method'] !== 'POST') return 'invalid method';
      if (typeof m['path'] !== 'string' || !PATH.test(m['path']) || (m['path'] as string).split(/[/?]/).includes('..') || /%2e|%2f|%5c/i.test(m['path'] as string)) return 'invalid path';
      if (typeof m['lease'] !== 'string' || !/^[A-Za-z0-9_-]{1,16384}$/.test(m['lease'])) return 'invalid lease';
      if (m['body'] !== undefined && (typeof m['body'] !== 'string' || !/^[A-Za-z0-9+/=]*$/.test(m['body']))) return 'invalid body';
      if (m['contentType'] !== undefined && (typeof m['contentType'] !== 'string' || !/^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,64}(;[ A-Za-z0-9=._-]{0,64})?$/.test(m['contentType']))) return 'invalid contentType';
      return m as RelayRequest;
    default:
      return 'unknown message type';
  }
}

/** Host-side relay between a no-network agent VM and the control plane. */
export class VsockRelay {
  private readonly maxFrame: number;
  private readonly runIds: ReadonlySet<string>;

  constructor(private readonly options: VsockRelayOptions) {
    if (!options?.leases) throw new TypeError('VsockRelay: leases transport is required');
    if (!Array.isArray(options.runIds) || options.runIds.length === 0 || options.runIds.some((r) => !RUN_ID.test(r))) throw new TypeError('VsockRelay: runIds must list the runs this relay serves');
    this.maxFrame = options.maxFrameBytes ?? 16_384;
    if (!Number.isInteger(this.maxFrame) || this.maxFrame < 4_096 || this.maxFrame > 65_536) throw new TypeError('VsockRelay: maxFrameBytes must be between 4096 and 65536');
    if (options.egressProxyUrl !== undefined && !/^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?\/?$/.test(options.egressProxyUrl)) {
      throw new TypeError('VsockRelay: egressProxyUrl must be a loopback http URL');
    }
    this.runIds = new Set(options.runIds);
  }

  /** Listen on a Unix socket / Windows named pipe path. */
  listen(socketPath: string): net.Server {
    const server = net.createServer((socket) => this.handle(socket));
    server.maxConnections = 16;
    server.listen(socketPath);
    return server;
  }

  /** Serve one connection (exposed for tests and custom listeners). */
  handle(socket: net.Socket): void {
    const decoder = new FrameDecoder(this.maxFrame);
    const rate = this.options.ratePerSecond ?? 20;
    let tokens = rate * 2;
    let last = Date.now();
    let inFlight = 0;
    const maxInFlight = this.options.maxInFlight ?? 8;
    socket.setTimeout(5 * 60_000, () => socket.destroy());
    const close = (reason: string) => {
      this.emit({ kind: 'close', reason });
      socket.destroy();
    };
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      let frames: unknown[];
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        return close(err instanceof Error ? err.message : 'bad frame');
      }
      for (const frame of frames) {
        const now = Date.now();
        tokens = Math.min(rate * 2, tokens + ((now - last) / 1000) * rate);
        last = now;
        const parsed = parseRelayRequest(frame);
        const id = frame && typeof frame === 'object' && typeof (frame as { id?: unknown }).id === 'string' && ID.test((frame as { id: string }).id) ? (frame as { id: string }).id : '';
        if (typeof parsed === 'string') {
          this.emit({ kind: 'drop', reason: parsed });
          if (id) this.reply(socket, { t: 'error', id, error: parsed });
          continue;
        }
        if (tokens < 1) {
          this.emit({ kind: 'drop', type: parsed.t, reason: 'rate limited' });
          this.reply(socket, { t: 'error', id: parsed.id, error: 'rate limited' });
          continue;
        }
        if (inFlight >= maxInFlight) {
          this.emit({ kind: 'drop', type: parsed.t, reason: 'too many requests in flight' });
          this.reply(socket, { t: 'error', id: parsed.id, error: 'too many requests in flight' });
          continue;
        }
        tokens -= 1;
        inFlight++;
        this.emit({ kind: 'request', type: parsed.t });
        void this.dispatch(parsed)
          .then((value) => this.reply(socket, { t: 'result', id: parsed.id, value }))
          .catch((err: unknown) => this.reply(socket, { t: 'error', id: parsed.id, error: err instanceof Error ? err.message.slice(0, 200) : 'failed' }))
          .finally(() => { inFlight--; });
      }
    });
  }

  private async dispatch(req: RelayRequest): Promise<unknown> {
    const timeout = this.options.timeoutMs ?? 10_000;
    const within = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('upstream timeout')), timeout).unref?.())]);
    switch (req.t) {
      case 'lease-issue':
        if (!this.runIds.has(req.runId)) return { granted: false, reason: 'run not served by this relay' } satisfies LeaseDecision;
        return within(this.options.leases.issue(req.runId, req.attestation));
      case 'lease-challenge': {
        if (!this.runIds.has(req.runId)) throw new Error('run not served by this relay');
        const leases = this.options.leases;
        if (!leases.attestationNonce) throw new Error('attestation not supported');
        return { nonce: await within(leases.attestationNonce(req.runId)) };
      }
      case 'lease-renew':
        if (!this.runIds.has(req.heartbeat.runId)) return { granted: false, reason: 'run not served by this relay' } satisfies LeaseDecision;
        return within(this.options.leases.renew(req.heartbeat));
      case 'lease-status':
        return { active: await within(this.options.leases.isActive(req.leaseId)) };
      case 'egress':
        return within(this.egress(req));
    }
  }

  private async egress(req: Extract<RelayRequest, { t: 'egress' }>): Promise<RelayEgressResult> {
    if (!this.options.egressProxyUrl) throw new Error('egress not available');
    const url = new URL(`/${req.route}${req.path}`, this.options.egressProxyUrl);
    // URL parsing normalizes dot segments (including %2e%2e): the result must stay under the route.
    if (!url.pathname.startsWith(`/${req.route}/`) && url.pathname !== `/${req.route}`) throw new Error('invalid path');
    const res = await fetch(url, {
      method: req.method,
      headers: { 'X-Network-AI-Lease': req.lease, ...(req.contentType ? { 'Content-Type': req.contentType } : {}) },
      body: req.method === 'POST' && req.body ? Buffer.from(req.body, 'base64') : undefined,
      redirect: 'manual',
    });
    const body = Buffer.from(await res.arrayBuffer());
    const room = Math.floor(((this.maxFrame - 256) * 3) / 4);
    if (body.length > room) return { status: 502, body: '', contentType: 'application/json' };
    return { status: res.status, body: body.toString('base64'), contentType: res.headers.get('content-type') ?? undefined };
  }

  private reply(socket: net.Socket, msg: RelayResponse): void {
    if (socket.destroyed) return;
    try {
      socket.write(encodeFrame(msg, this.maxFrame));
    } catch {
      socket.write(encodeFrame({ t: 'error', id: msg.id, error: 'response too large' }, this.maxFrame));
    }
  }

  private emit(event: { kind: 'request' | 'drop' | 'close'; type?: string; reason?: string }): void {
    try {
      this.options.onEvent?.({ ...event, at: Date.now() });
    } catch {
      // Audit delivery never affects the relay.
    }
  }
}

/** Guest-side lease transport over the relay socket (one connection per call). */
export class FramedLeaseTransport implements LeaseTransport {
  constructor(private readonly socketPath: string, private readonly timeoutMs = 10_000, private readonly maxFrameBytes = 65_536) {
    if (typeof socketPath !== 'string' || socketPath.length === 0) throw new TypeError('FramedLeaseTransport: socketPath is required');
  }

  issue(runId: string, attestation?: AttestationEvidence): Promise<LeaseDecision> {
    return this.call({ t: 'lease-issue', runId, ...(attestation ? { attestation } : {}) }) as Promise<LeaseDecision>;
  }

  async attestationNonce(runId: string): Promise<string> {
    const r = (await this.call({ t: 'lease-challenge', runId })) as { nonce?: unknown };
    if (typeof r?.nonce !== 'string') throw new Error('relay returned no nonce');
    return r.nonce;
  }

  renew(heartbeat: Heartbeat): Promise<LeaseDecision> {
    return this.call({ t: 'lease-renew', heartbeat }) as Promise<LeaseDecision>;
  }

  async isActive(leaseId: string): Promise<boolean> {
    const r = (await this.call({ t: 'lease-status', leaseId })) as { active?: unknown };
    return r?.active === true;
  }

  /** Egress through the relay; `lease` is the `encodeLeaseHeader` value. */
  async egress(req: { route: string; method: 'GET' | 'POST'; path: string; lease: string; body?: Buffer; contentType?: string }): Promise<{ status: number; body: Buffer; contentType?: string }> {
    const r = (await this.call({ t: 'egress', route: req.route, method: req.method, path: req.path, lease: req.lease, ...(req.body ? { body: req.body.toString('base64') } : {}), ...(req.contentType ? { contentType: req.contentType } : {}) })) as RelayEgressResult;
    return { status: r.status, body: Buffer.from(r.body ?? '', 'base64'), contentType: r.contentType };
  }

  private call(payload: Record<string, unknown>): Promise<unknown> {
    const id = randomBytes(8).toString('hex');
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.socketPath);
      const decoder = new FrameDecoder(this.maxFrameBytes);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('relay timeout')); }, this.timeoutMs);
      const done = (fn: () => void) => { clearTimeout(timer); socket.end(); fn(); };
      socket.on('connect', () => socket.write(encodeFrame({ ...payload, id }, this.maxFrameBytes)));
      socket.on('data', (chunk: Buffer) => {
        let frames: unknown[];
        try {
          frames = decoder.push(chunk);
        } catch (err) {
          return done(() => reject(err));
        }
        for (const f of frames) {
          const m = f as RelayResponse;
          if (!m || m.id !== id) continue;
          if (m.t === 'result') return done(() => resolve(m.value));
          return done(() => reject(new Error(`relay: ${m.t === 'error' ? m.error : 'bad response'}`)));
        }
      });
      socket.on('error', (err) => { clearTimeout(timer); reject(err); });
      socket.on('close', () => { clearTimeout(timer); reject(new Error('relay closed the connection')); });
    });
  }
}
