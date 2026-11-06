/**
 * Perpetual Runtime — pull-model / one-way lease channel (Phase 5b.4).
 *
 * The agent never connects to the control plane. It appends lease requests
 * to `outbox.jsonl` in a spool directory; a {@link SpoolPuller} on the
 * authority side reads that file read-only, validates each line with the
 * relay's fixed schemas, asks the authority, and appends answers to
 * `inbox.jsonl`. The two files can sit on opposite sides of a hardware data
 * diode (one diode per direction). The trade-off is latency: one poll period
 * each way, so keep `leaseTtlMs` well above twice the poll interval.
 *
 * @module PerpetualSpool
 */

import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, writeSync } from 'fs';
import { join, resolve } from 'path';
import { randomBytes } from 'crypto';
import { parseRelayRequest, type RelayRequest } from './vsock-relay';
import type { LeaseTransport } from './lease-guard';
import type { AttestationEvidence, Heartbeat, LeaseDecision } from './types';

const OUTBOX = 'outbox.jsonl';
const INBOX = 'inbox.jsonl';
const MAX_LINE = 65_536;
const NOFOLLOW = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;

/**
 * Open a spool file without following symlinks. The spool directory is
 * writable by the agent, so a planted symlink must never redirect the
 * authority-side puller to another file. Refuses anything but a regular file.
 */
function openSpoolFile(file: string, mode: 'r' | 'a'): number | null {
  let st: ReturnType<typeof lstatSync> | null = null;
  try {
    st = lstatSync(file);
  } catch {
    st = null;
  }
  if (st && (st.isSymbolicLink() || !st.isFile())) throw new Error(`spool: ${file} is not a regular file`);
  if (!st && mode === 'r') return null;
  const flags = mode === 'r'
    ? fsConstants.O_RDONLY | NOFOLLOW
    : fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | NOFOLLOW;
  const fd = openSync(file, flags, 0o600);
  // Re-check the opened descriptor (closes the lstat/open window where O_NOFOLLOW is unavailable).
  if (!fstatSync(fd).isFile()) {
    closeSync(fd);
    throw new Error(`spool: ${file} is not a regular file`);
  }
  return fd;
}

/** Read complete lines appended since `offset`. */
function readNewLines(file: string, offset: number, maxBytes: number): { lines: string[]; offset: number } {
  if (!existsSync(file)) return { lines: [], offset };
  let fd: number | null;
  try {
    fd = openSpoolFile(file, 'r');
  } catch {
    return { lines: [], offset };
  }
  if (fd === null) return { lines: [], offset };
  try {
    const size = fstatSync(fd).size;
    if (size < offset) offset = 0;
    const len = Math.min(size - offset, maxBytes);
    if (len <= 0) return { lines: [], offset };
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, offset);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) {
      // A single line longer than the read window: skip it entirely.
      return len >= maxBytes ? { lines: [], offset: offset + len } : { lines: [], offset };
    }
    const text = buf.subarray(0, lastNl).toString('utf8');
    return { lines: text.split('\n'), offset: offset + lastNl + 1 };
  } finally {
    closeSync(fd);
  }
}

function appendLine(file: string, value: unknown): void {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line) > MAX_LINE) throw new Error('spool line too large');
  const fd = openSpoolFile(file, 'a') as number;
  try {
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
}

/** Agent-side transport: append requests, poll for answers. Never opens a network connection. */
export class SpoolLeaseTransport implements LeaseTransport {
  private readonly dir: string;
  private inboxOffset = 0;
  private readonly pending = new Map<string, unknown>();

  constructor(dir: string, private readonly opts: { pollMs?: number; timeoutMs?: number } = {}) {
    this.dir = resolve(dir);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  issue(runId: string, attestation?: AttestationEvidence): Promise<LeaseDecision> {
    return this.call({ t: 'lease-issue', runId, ...(attestation ? { attestation } : {}) }) as Promise<LeaseDecision>;
  }

  async attestationNonce(runId: string): Promise<string> {
    const r = (await this.call({ t: 'lease-challenge', runId })) as { nonce?: unknown };
    if (typeof r?.nonce !== 'string') throw new Error('spool returned no nonce');
    return r.nonce;
  }

  renew(heartbeat: Heartbeat): Promise<LeaseDecision> {
    return this.call({ t: 'lease-renew', heartbeat }) as Promise<LeaseDecision>;
  }

  async isActive(leaseId: string): Promise<boolean> {
    const r = (await this.call({ t: 'lease-status', leaseId })) as { active?: unknown };
    return r?.active === true;
  }

  private async call(payload: Record<string, unknown>): Promise<unknown> {
    const id = randomBytes(8).toString('hex');
    appendLine(join(this.dir, OUTBOX), { ...payload, id });
    const deadline = Date.now() + (this.opts.timeoutMs ?? 30_000);
    const poll = this.opts.pollMs ?? 200;
    while (Date.now() < deadline) {
      this.drainInbox();
      if (this.pending.has(id)) {
        const r = this.pending.get(id) as { t?: string; value?: unknown; error?: string };
        this.pending.delete(id);
        if (r.t === 'result') return r.value;
        throw new Error(`spool: ${typeof r.error === 'string' ? r.error.slice(0, 200) : 'request refused'}`);
      }
      await new Promise((res) => setTimeout(res, poll));
    }
    throw new Error('spool: no answer before timeout');
  }

  private drainInbox(): void {
    const { lines, offset } = readNewLines(join(this.dir, INBOX), this.inboxOffset, 4 * MAX_LINE);
    this.inboxOffset = offset;
    for (const line of lines) {
      try {
        const m = JSON.parse(line) as { id?: unknown };
        if (typeof m?.id === 'string' && this.pending.size < 1024) this.pending.set(m.id, m);
      } catch {
        // Malformed answer lines are ignored.
      }
    }
  }
}

/** Options for {@link SpoolPuller}. */
export interface SpoolPullerOptions {
  /** Authority (or `QuorumLeaseTransport`) to forward requests to */
  leases: LeaseTransport;
  /** Run ids served from this spool */
  runIds: readonly string[];
  /** Max requests handled per poll (default 32) */
  maxPerPoll?: number;
  onEvent?: (event: { at: number; kind: 'request' | 'drop'; type?: string; reason?: string }) => void;
}

/** Authority-side puller: reads the agent's outbox read-only and answers into the inbox. */
export class SpoolPuller {
  private readonly dir: string;
  private offset = 0;
  private readonly runIds: ReadonlySet<string>;

  constructor(dir: string, private readonly options: SpoolPullerOptions) {
    if (!options?.leases || !Array.isArray(options.runIds) || options.runIds.length === 0) throw new TypeError('SpoolPuller: leases and runIds are required');
    this.dir = resolve(dir);
    this.runIds = new Set(options.runIds);
  }

  /** Process new requests once. Returns how many were answered. */
  async pollOnce(): Promise<number> {
    const { lines, offset } = readNewLines(join(this.dir, OUTBOX), this.offset, 4 * MAX_LINE);
    this.offset = offset;
    let answered = 0;
    const max = this.options.maxPerPoll ?? 32;
    const reply = (value: unknown): void => {
      try {
        appendLine(join(this.dir, INBOX), value);
      } catch (err) {
        this.emit({ kind: 'drop', reason: `inbox refused: ${err instanceof Error ? err.message : 'write failed'}` });
      }
    };
    for (const line of lines) {
      if (!line.trim()) continue;
      if (answered >= max) {
        this.emit({ kind: 'drop', reason: 'too many requests in one poll' });
        continue;
      }
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit({ kind: 'drop', reason: 'malformed line' });
        continue;
      }
      const req = parseRelayRequest(msg);
      const id = (msg as { id?: unknown })?.id;
      if (typeof req === 'string' || req.t === 'egress') {
        const reason = typeof req === 'string' ? req : 'egress is not available over the spool';
        this.emit({ kind: 'drop', reason });
        if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)) reply({ t: 'error', id, error: reason });
        continue;
      }
      answered++;
      this.emit({ kind: 'request', type: req.t });
      let value: unknown;
      try {
        value = await this.dispatch(req);
      } catch (err) {
        reply({ t: 'error', id: req.id, error: err instanceof Error ? err.message.slice(0, 200) : 'failed' });
        continue;
      }
      reply({ t: 'result', id: req.id, value });
    }
    return answered;
  }

  private async dispatch(req: Exclude<RelayRequest, { t: 'egress' }>): Promise<unknown> {
    switch (req.t) {
      case 'lease-issue':
        return this.runIds.has(req.runId) ? this.options.leases.issue(req.runId, req.attestation) : { granted: false, reason: 'run not served by this spool' };
      case 'lease-challenge': {
        if (!this.runIds.has(req.runId)) throw new Error('run not served by this spool');
        if (!this.options.leases.attestationNonce) throw new Error('attestation not supported');
        return { nonce: await this.options.leases.attestationNonce(req.runId) };
      }
      case 'lease-renew':
        return this.runIds.has(req.heartbeat.runId) ? this.options.leases.renew(req.heartbeat) : { granted: false, reason: 'run not served by this spool' };
      case 'lease-status':
        return { active: await this.options.leases.isActive(req.leaseId) };
    }
  }

  private emit(event: { kind: 'request' | 'drop'; type?: string; reason?: string }): void {
    try {
      this.options.onEvent?.({ ...event, at: Date.now() });
    } catch {
      // Audit delivery never affects the puller.
    }
  }
}
