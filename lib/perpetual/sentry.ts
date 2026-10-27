/**
 * Perpetual Runtime — defensive sentry swarm.
 *
 * Sentries run outside the agent process and only read: they tail the audit
 * stream, run detectors (OWASP Agentic Top 10 style), and report findings to
 * the lease authority. Their only levers are {@link SentryControl.reportAlert}
 * and {@link SentryControl.tighten} — they can narrow or stop a run, never
 * loosen, renew, approve, or edit policy. With a `sentryQuorum` in the signed
 * policy, renewal stops only when enough independent sentries agree.
 *
 * @module Sentry
 */

import { closeSync, fstatSync, openSync, readSync } from 'fs';
import type { AlertLevel, TightenDelta } from './lease-authority';

/** Something a sentry watched happen. */
export interface SentryObservation {
  at: number;
  kind: 'tool' | 'file' | 'blackboard' | 'context' | 'output' | 'egress' | 'other';
  agentId?: string;
  runId?: string;
  /** Tool or action name */
  action?: string;
  outcome?: 'success' | 'failure' | 'denied' | 'blocked';
  /** File path, blackboard key, or route */
  target?: string;
  /** Text to inspect (context packs, tool results, outputs) */
  text?: string;
}

/** A detector's conclusion. */
export interface SentryFinding {
  detector: string;
  level: AlertLevel;
  reason: string;
  agentId?: string;
  runId?: string;
  at: number;
}

/** A pure detector over observations. */
export interface SentryDetector {
  readonly name: string;
  inspect(obs: SentryObservation): SentryFinding | null;
}

/** The only control operations a sentry may use. */
export interface SentryControl {
  reportAlert(level: AlertLevel): Promise<void>;
  tighten(delta: TightenDelta): Promise<void>;
}

function windowCounter(windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string, at: number): number => {
    const list = (hits.get(key) ?? []).filter((t) => at - t < windowMs);
    list.push(at);
    hits.set(key, list.slice(-10_000));
    if (hits.size > 10_000) hits.delete(hits.keys().next().value as string);
    return list.length;
  };
}

/** Flags an agent whose action rate exceeds `maxEvents` per `windowMs`. */
export function velocityDetector(opts: { maxEvents: number; windowMs: number; level?: AlertLevel }): SentryDetector {
  const count = windowCounter(opts.windowMs);
  return {
    name: 'velocity',
    inspect(obs) {
      if (obs.kind !== 'tool' && obs.kind !== 'file' && obs.kind !== 'blackboard' && obs.kind !== 'egress') return null;
      const n = count(obs.agentId ?? obs.runId ?? '?', obs.at);
      return n === opts.maxEvents + 1
        ? { detector: 'velocity', level: opts.level ?? 'warning', reason: `${n} actions within ${opts.windowMs} ms`, agentId: obs.agentId, runId: obs.runId, at: obs.at }
        : null;
    },
  };
}

/** Flags repeated denied or blocked actions (probing for a way around the policy). */
export function deniedAccessDetector(opts: { maxDenied: number; windowMs: number; level?: AlertLevel }): SentryDetector {
  const count = windowCounter(opts.windowMs);
  return {
    name: 'denied-access',
    inspect(obs) {
      if (obs.outcome !== 'denied' && obs.outcome !== 'blocked') return null;
      const n = count(obs.agentId ?? obs.runId ?? '?', obs.at);
      return n >= opts.maxDenied
        ? { detector: 'denied-access', level: opts.level ?? 'warning', reason: `${n} denied actions within ${opts.windowMs} ms`, agentId: obs.agentId, runId: obs.runId, at: obs.at }
        : null;
    },
  };
}

const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore (all |any )?(previous|prior|above) (instructions|prompts|rules)/i,
  /disregard (the |your )?(system|previous) (prompt|instructions)/i,
  /you are now (in )?(developer|dan|jailbreak|unrestricted) mode/i,
  /(reveal|print|output|exfiltrate) (the |your )?(system prompt|api key|secret|credentials|private key)/i,
  /\b(disable|turn off|bypass) (the )?(guard|sentry|lease|kill switch|audit|safety)/i,
  /<\s*\/?\s*(system|assistant)\s*>/i,
];

/** Flags prompt-injection indicators in context, tool results, and outputs. */
export function promptInjectionDetector(opts: { patterns?: readonly RegExp[]; level?: AlertLevel } = {}): SentryDetector {
  const patterns = opts.patterns ?? INJECTION_PATTERNS;
  return {
    name: 'prompt-injection',
    inspect(obs) {
      if (typeof obs.text !== 'string' || obs.text.length === 0) return null;
      const sample = obs.text.slice(0, 200_000);
      const hit = patterns.find((p) => p.test(sample));
      return hit
        ? { detector: 'prompt-injection', level: opts.level ?? 'warning', reason: `injection indicator: ${hit.source.slice(0, 80)}`, agentId: obs.agentId, runId: obs.runId, at: obs.at }
        : null;
    },
  };
}

/** Flags one blackboard key overwritten unusually often (state poisoning / thrashing). */
export function blackboardPoisoningDetector(opts: { maxOverwrites: number; windowMs: number; level?: AlertLevel }): SentryDetector {
  const count = windowCounter(opts.windowMs);
  return {
    name: 'blackboard-poisoning',
    inspect(obs) {
      if (obs.kind !== 'blackboard' || !obs.target || obs.outcome !== 'success') return null;
      const n = count(obs.target, obs.at);
      return n === opts.maxOverwrites + 1
        ? { detector: 'blackboard-poisoning', level: opts.level ?? 'warning', reason: `key ${obs.target.slice(0, 128)} overwritten ${n} times within ${opts.windowMs} ms`, agentId: obs.agentId, runId: obs.runId, at: obs.at }
        : null;
    },
  };
}

/**
 * Flags attempts on guarded files and blackboard keys. A refused attempt is
 * `critical`; a successful (operator-approved) write is recorded as `info`.
 */
export function guardedTouchDetector(guarded: { isGuardedPath(p: string): boolean; isGuardedKey(k: string): boolean }): SentryDetector {
  return {
    name: 'guarded-touch',
    inspect(obs) {
      if (!obs.target) return null;
      const hit = (obs.kind === 'file' && guarded.isGuardedPath(obs.target)) || (obs.kind === 'blackboard' && guarded.isGuardedKey(obs.target));
      if (!hit) return null;
      const refused = obs.outcome === 'denied' || obs.outcome === 'blocked' || obs.outcome === 'failure';
      return { detector: 'guarded-touch', level: refused ? 'critical' : 'info', reason: `${refused ? 'refused' : 'approved'} ${obs.kind} write to guarded ${obs.target.slice(0, 128)}`, agentId: obs.agentId, runId: obs.runId, at: obs.at };
    },
  };
}

/** Flags canary tokens appearing anywhere they should not (`CanaryRegistry.scan` fits `scan`). */
export function canaryLeakDetector(registry: { scan(value: unknown): readonly unknown[] }): SentryDetector {
  return {
    name: 'canary-leak',
    inspect(obs) {
      if (obs.text === undefined && obs.target === undefined) return null;
      const hits = registry.scan([obs.text ?? '', obs.target ?? '']);
      return hits.length > 0
        ? { detector: 'canary-leak', level: 'critical', reason: `${hits.length} canary token(s) leaked`, agentId: obs.agentId, runId: obs.runId, at: obs.at }
        : null;
    },
  };
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
}

/** Lexical overlap (Jaccard) between two texts, 0..1. */
export function lexicalSimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}

/**
 * Flags goal drift: outputs whose similarity to the declared goal stays below
 * `minSimilarity` for `consecutive` outputs in a row. Plug in an embedding
 * similarity for better recall.
 */
export function goalDriftDetector(opts: { goal: string; minSimilarity: number; consecutive?: number; similarity?: (a: string, b: string) => number; level?: AlertLevel }): SentryDetector {
  const sim = opts.similarity ?? lexicalSimilarity;
  const need = opts.consecutive ?? 3;
  const streak = new Map<string, number>();
  return {
    name: 'goal-drift',
    inspect(obs) {
      if (obs.kind !== 'output' || typeof obs.text !== 'string') return null;
      const key = obs.runId ?? obs.agentId ?? '?';
      const s = sim(opts.goal, obs.text.slice(0, 50_000));
      const n = s < opts.minSimilarity ? (streak.get(key) ?? 0) + 1 : 0;
      streak.set(key, n);
      return n === need
        ? { detector: 'goal-drift', level: opts.level ?? 'warning', reason: `${n} consecutive outputs below goal similarity ${opts.minSimilarity}`, agentId: obs.agentId, runId: obs.runId, at: obs.at }
        : null;
    },
  };
}

/** Options for {@link Sentry}. */
export interface SentryOptions {
  id: string;
  detectors: readonly SentryDetector[];
  control: SentryControl;
  /** Tightening applied on a `warning` finding (e.g. shorter leases, observe tier) */
  tightenOnWarning?: TightenDelta;
  /** Minimum gap between alerts of the same level (default 10 s) */
  alertCooldownMs?: number;
  onFinding?: (finding: SentryFinding) => void;
  /** Report control-call failures (the sentry keeps running) */
  onError?: (err: unknown) => void;
}

const LEVEL_RANK: Record<AlertLevel, number> = { info: 0, warning: 1, critical: 2 };

/** One sentry: runs detectors over observations and reports findings to the authority. */
export class Sentry {
  private readonly lastAlert = new Map<AlertLevel, number>();
  private tightened = false;

  constructor(private readonly options: SentryOptions) {
    if (!options.id || !Array.isArray(options.detectors) || !options.control) throw new TypeError('Sentry: id, detectors, and control are required');
  }

  /** Inspect one observation; reports any findings and returns them. */
  async observe(obs: SentryObservation): Promise<SentryFinding[]> {
    const findings: SentryFinding[] = [];
    for (const d of this.options.detectors) {
      let f: SentryFinding | null = null;
      try { f = d.inspect(obs); } catch { f = null; }
      if (f) findings.push(f);
    }
    if (findings.length === 0) return findings;
    for (const f of findings) {
      try { this.options.onFinding?.(f); } catch { /* audit only */ }
    }
    const top = findings.reduce((a, b) => (LEVEL_RANK[b.level] > LEVEL_RANK[a.level] ? b : a));
    await this.act(top);
    return findings;
  }

  private async act(finding: SentryFinding): Promise<void> {
    if (finding.level === 'info') return;
    const now = finding.at;
    const last = this.lastAlert.get(finding.level);
    if (last !== undefined && now - last < (this.options.alertCooldownMs ?? 10_000)) return;
    this.lastAlert.set(finding.level, now);
    try {
      if (finding.level === 'warning' && this.options.tightenOnWarning && !this.tightened) {
        await this.options.control.tighten(this.options.tightenOnWarning);
        this.tightened = true;
      }
      await this.options.control.reportAlert(finding.level);
    } catch (err) {
      this.options.onError?.(err);
    }
  }
}

/** HTTP {@link SentryControl} for one sentry identity (its own secret). */
export class HttpSentryControl implements SentryControl {
  constructor(private readonly baseUrl: string, private readonly secret: string, private readonly timeoutMs = 5_000) {
    if (!/^https?:\/\//.test(baseUrl)) throw new TypeError('HttpSentryControl: baseUrl must be http(s)');
    if (!secret || secret.length < 32) throw new TypeError('HttpSentryControl: secret must be at least 32 characters');
  }

  reportAlert(level: AlertLevel): Promise<void> {
    return this.post('/v1/control/alert', { level });
  }

  tighten(delta: TightenDelta): Promise<void> {
    return this.post('/v1/control/tighten', delta);
  }

  private async post(path: string, body: unknown): Promise<void> {
    const res = await fetch(new URL(path, this.baseUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`authority responded ${res.status}`);
  }
}

/** In-process {@link SentryControl} bound to the `sentry` role (tests, single-host setups). */
export function localSentryControl(
  authority: { reportAlert(level: AlertLevel, source: string, role: 'sentry'): void; tighten(delta: TightenDelta, role: 'sentry'): unknown },
  sentryId: string,
): SentryControl {
  return {
    reportAlert: async (level) => { authority.reportAlert(level, `sentry:${sentryId}`, 'sentry'); },
    tighten: async (delta) => { authority.tighten(delta, 'sentry'); },
  };
}

/**
 * Read-only tail of a JSONL audit log. Opens the file read-only on every poll,
 * so the sentry never holds a writable handle on the agent's log.
 */
export class AuditTail {
  private offset = 0;
  private partial = '';

  constructor(private readonly file: string, opts: { fromStart?: boolean } = {}) {
    if (!opts.fromStart) {
      try {
        const fd = openSync(file, 'r');
        try { this.offset = fstatSync(fd).size; } finally { closeSync(fd); }
      } catch {
        this.offset = 0;
      }
    }
  }

  /** New complete lines since the last poll, parsed as JSON (malformed lines skipped). */
  poll(maxBytes = 4 * 1024 * 1024): unknown[] {
    let fd: number;
    try { fd = openSync(this.file, 'r'); } catch { return []; }
    try {
      const size = fstatSync(fd).size;
      if (size < this.offset) { this.offset = 0; this.partial = ''; }
      const len = Math.min(size - this.offset, maxBytes);
      if (len <= 0) return [];
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, this.offset);
      this.offset += len;
      const text = this.partial + buf.toString('utf8');
      const lines = text.split('\n');
      this.partial = lines.pop() ?? '';
      const out: unknown[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line) as unknown); } catch { /* skip */ }
      }
      return out;
    } finally {
      closeSync(fd);
    }
  }
}

/** Map a `SecureAuditLogger` / runtime / egress audit entry to an observation. */
export function observationFromAudit(entry: unknown): SentryObservation | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  const details = (e['details'] && typeof e['details'] === 'object' ? e['details'] : {}) as Record<string, unknown>;
  const at = typeof e['at'] === 'number' ? e['at'] : Date.parse(String(e['timestamp'] ?? '')) || Date.now();
  const s = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const action = s(e['action']) ?? s(e['eventType']);
  const rawOutcome = s(e['outcome']) ?? s(e['result']);
  const outcome = rawOutcome === 'success' || rawOutcome === 'failure' || rawOutcome === 'denied' || rawOutcome === 'blocked'
    ? rawOutcome : rawOutcome === 'forwarded' ? 'success' : undefined;
  const target = s(e['target']) ?? s(e['resource']) ?? s(details['key']) ?? s(e['route']);
  let kind: SentryObservation['kind'] = 'other';
  const a = (action ?? '').toLowerCase();
  if (s(e['source']) === 'egress-proxy' || e['route'] !== undefined) kind = 'egress';
  else if (a.includes('blackboard') || a === 'write' || a === 'delete' || a === 'commit' || a === 'guarded') kind = 'blackboard';
  else if (a.startsWith('file_')) kind = 'file';
  else if (a.includes('shell') || a.includes('tool') || a.includes('exec')) kind = 'tool';
  else if (a.includes('context')) kind = 'context';
  else if (a.includes('output')) kind = 'output';
  return {
    at,
    kind,
    agentId: s(e['agentId']),
    runId: s(e['runId']),
    action,
    outcome,
    target,
    text: s(details['text']) ?? s(e['text']),
  };
}
