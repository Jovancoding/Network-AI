/**
 * test-perpetual-fuzz.ts — Perpetual Runtime Phase 5a.4: fuzz the doors.
 *
 * Seeded, dependency-free, structure-aware fuzzing of every input that crosses
 * into the control plane. Properties:
 * - never throws past the handler (no 500s, no unhandled rejections);
 * - never grants, forwards, or approves on malformed or tampered input;
 * - bounded time per input.
 *
 * CI uses a fixed seed and budget. Nightly / long mode:
 *   NAI_FUZZ_SEED=<n> NAI_FUZZ_ITERATIONS=<n> npx ts-node test-perpetual-fuzz.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as net from 'net';
import { randomBytes } from 'crypto';
import type { AddressInfo } from 'net';
import { canonicalJson } from './lib/asi/canonical';
import {
  EgressProxy,
  FrameDecoder,
  FrameError,
  GuardedMatcher,
  LeaseAuthority,
  MerkleAuditLog,
  StateSnapshotter,
  TripwireSet,
  VsockRelay,
  encodeFrame,
  encodeLeaseHeader,
  generateEd25519KeyPair,
  leafHashOf,
  loadRoutes,
  normalizeSandboxRequest,
  parseRelayRequest,
  policyHash,
  scopeWithin,
  signCapabilityEval,
  signCheckpoint,
  signLease,
  signPolicy,
  validatePolicy,
  verifyCapabilityEval,
  verifyCheckpoint,
  verifyConsistency,
  verifyInclusion,
  verifyLease,
  verifySignedPolicy,
} from './lib/perpetual';
import type { RenewalPolicy, SignedLease } from './lib/perpetual';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];
function pass(label: string) { passed++; process.stdout.write(`  ✓ ${label}\n`); }
function fail(label: string, reason: string) { failed++; failures.push(`${label}: ${reason}`); process.stdout.write(`  ✗ ${label} — ${reason}\n`); }
function assert(cond: boolean, label: string, detail = '') { if (cond) pass(label); else fail(label, detail || 'assertion failed'); }
function section(name: string) { process.stdout.write(`\n${name}\n`); }

const SEED = Number(process.env['NAI_FUZZ_SEED'] ?? 0x5eed5);
const N = Math.max(10, Number(process.env['NAI_FUZZ_ITERATIONS'] ?? 300));
const MAX_MS_PER_INPUT = 500;

/** mulberry32: small, fast, reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Fuzzer {
  readonly rnd: () => number;
  constructor(seed: number) { this.rnd = prng(seed); }
  int(n: number): number { return Math.floor(this.rnd() * n); }
  pick<T>(xs: readonly T[]): T { return xs[this.int(xs.length)]; }
  chance(p: number): boolean { return this.rnd() < p; }

  str(): string {
    return this.pick([
      '', ' ', '..', '../..', '/', '\\', '\0', 'a\0b', '%2e%2e', '__proto__', 'constructor', 'null', 'true', '-1', '1e309',
      'x'.repeat(this.int(5000)), '\u202e\u200b', '🙂', 'A'.repeat(129), '\r\n', '${jndi}', '<script>', 'run-1', 'lease_x', 'llm',
    ]);
  }

  scalar(): unknown {
    return this.pick<() => unknown>([
      () => null, () => true, () => false, () => 0, () => -1, () => 1.5, () => Number.MAX_SAFE_INTEGER, () => -Number.MAX_VALUE,
      () => 1e308, () => this.str(), () => [], () => ({}), () => [this.str()], () => ({ [this.str()]: this.str() }),
    ])();
  }

  /** Mutate a JSON-like value: replace, delete, add, or retype a random node. */
  mutate(value: unknown, depth = 0): unknown {
    if (depth > 6 || value === null || typeof value !== 'object') return this.chance(0.7) ? this.scalar() : value;
    const clone: Record<string, unknown> | unknown[] = Array.isArray(value) ? [...value] : { ...(value as Record<string, unknown>) };
    const keys = Object.keys(clone);
    const op = this.int(5);
    if (op === 0 && keys.length > 0) {
      const k = this.pick(keys);
      if (Array.isArray(clone)) clone.splice(Number(k), 1); else delete clone[k];
    } else if (op === 1) {
      const k = this.chance(0.3) ? '__proto__' : this.str().slice(0, 32);
      if (Array.isArray(clone)) clone.push(this.scalar()); else Object.defineProperty(clone, k, { value: this.scalar(), enumerable: true, configurable: true, writable: true });
    } else if (op === 2 && keys.length > 0) {
      const k = this.pick(keys);
      (clone as Record<string, unknown>)[k] = this.scalar();
    } else if (keys.length > 0) {
      const k = this.pick(keys);
      (clone as Record<string, unknown>)[k] = this.mutate((clone as Record<string, unknown>)[k], depth + 1);
    } else {
      return this.scalar();
    }
    return clone;
  }

  /** 1–3 stacked mutations. */
  mutateMany(value: unknown): unknown {
    let v = value;
    for (let i = 0, n = 1 + this.int(3); i < n; i++) v = this.mutate(v);
    return v;
  }

  bytes(): Buffer {
    const n = this.int(2048);
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = this.int(256);
    return b;
  }
}

function same(a: unknown, b: unknown): boolean {
  try { return canonicalJson(a) === canonicalJson(b); } catch { return false; }
}

/** Run `fn` N times; record throws (other than allowed) and slow inputs. */
function campaign(label: string, fn: (fz: Fuzzer, i: number) => string | null, iterations = N): void {
  const fz = new Fuzzer(SEED ^ hashLabel(label));
  let slowest = 0;
  let problem: string | null = null;
  for (let i = 0; i < iterations && !problem; i++) {
    const t0 = performance.now();
    try {
      problem = fn(fz, i);
    } catch (err) {
      problem = `iteration ${i} threw ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
    }
    slowest = Math.max(slowest, performance.now() - t0);
  }
  assert(problem === null, `${label} (${iterations} inputs)`, problem ?? '');
  assert(slowest < MAX_MS_PER_INPUT, `${label}: bounded time per input (max ${slowest.toFixed(1)} ms)`);
}

function hashLabel(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

const T0 = 1_800_000_000_000;

function basePolicy(overrides: Partial<RenewalPolicy> = {}): RenewalPolicy {
  return {
    v: 'nai-policy-v1', policyId: 'fuzz', issuedAt: T0, leaseTtlMs: 60_000, autoRenew: true, heartbeatMaxAgeMs: 30_000,
    scope: { tier: 'standard', tools: ['shell_exec'], paths: ['data/work'], destinations: ['llm'] },
    budget: { runCeilingUsd: 10, runCeilingTokens: 1_000_000 },
    stopWhen: { sentryAlertAtOrAbove: 'critical' },
    humanCheckpointEveryMs: 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure decoders and validators
// ---------------------------------------------------------------------------

function fuzzSigned(): void {
  section('Signed objects: tampering never verifies, malformed input never throws');
  const operator = generateEd25519KeyPair();
  const authorityKey = generateEd25519KeyPair();
  const signed = signPolicy(basePolicy(), operator);
  const authority = new LeaseAuthority({ operatorPublicKey: operator.publicKey, authorityKey, policy: signed, now: () => T0 });
  const lease = authority.issue('run-fuzz').lease!;

  // A verifying object must carry the exact signed content and key id. Unsigned envelope
  // fields, signature hex case, and keys canonical JSON ignores do not change what was signed.
  campaign('verifyLease', (fz) => {
    const m = fz.mutateMany(lease) as SignedLease;
    const r = verifyLease(m, authorityKey.publicKey, T0);
    if (r === null && !(same(m.claims, lease.claims) && m.keyId === lease.keyId)) return `tampered lease verified: ${JSON.stringify(m).slice(0, 200)}`;
    return null;
  });

  campaign('verifySignedPolicy', (fz) => {
    const m = fz.mutateMany(signed) as typeof signed;
    const r = verifySignedPolicy(m, operator.publicKey);
    if (r === null && !(same(m.policy, signed.policy) && m.keyId === signed.keyId)) return 'tampered policy verified';
    return null;
  });

  campaign('validatePolicy (TypeError only)', (fz) => {
    const m = fz.mutateMany(basePolicy()) as RenewalPolicy;
    try {
      validatePolicy(m);
    } catch (err) {
      if (!(err instanceof TypeError)) return `non-TypeError: ${String(err)}`;
    }
    return null;
  });

  const ph = policyHash(signed);
  const cp = signCheckpoint({ policyHash: ph, scope: { all: true }, now: T0 }, operator);
  campaign('verifyCheckpoint', (fz) => {
    const m = fz.mutateMany(cp) as typeof cp;
    const r = verifyCheckpoint(m, operator.publicKey, ph, T0);
    if (r === null && !(same(m.checkpoint, cp.checkpoint) && m.keyId === cp.keyId)) return 'tampered checkpoint verified';
    return null;
  });

  campaign('authority.checkpoint never accepts tampered checkpoints', (fz) => {
    const m = fz.mutateMany(cp) as typeof cp;
    if (m && typeof m === 'object' && same(m.checkpoint, cp.checkpoint)) return null;
    try {
      authority.checkpoint(m, 'operator');
      return 'tampered checkpoint accepted';
    } catch {
      return null;
    }
  });

  campaign('authority.renew with malformed heartbeats never grants', (fz) => {
    const hb = { leaseId: lease.claims.leaseId, runId: 'run-fuzz', at: T0, spentUsd: 0, spentTokens: 0, health: 'ok' };
    const m = fz.mutateMany(hb) as typeof hb;
    const fresh = new LeaseAuthority({ operatorPublicKey: operator.publicKey, authorityKey, policy: signed, now: () => T0 });
    const l = fresh.issue('run-fuzz').lease!;
    const d = fresh.renew({ ...m, leaseId: typeof m === 'object' && m && m.leaseId === lease.claims.leaseId ? l.claims.leaseId : (m as { leaseId?: string })?.leaseId } as never, 'runner');
    if (d.granted) {
      const ok = typeof m === 'object' && m !== null && m.runId === 'run-fuzz' && Number.isFinite(m.at) && (m.spentUsd as unknown as number) >= 0 && (m.spentTokens as unknown as number) >= 0;
      if (!ok) return `granted on malformed heartbeat ${JSON.stringify(m).slice(0, 200)}`;
      if (verifyLease(d.lease!, authorityKey.publicKey, T0) !== null) return 'granted lease does not verify';
    }
    return null;
  });
}

function fuzzInputs(): void {
  section('Input normalizers: reject or normalize safely');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-fuzz-ws-'));
  try {
    const base = { argv: ['node', 'x.js'], workspace: ws, env: { A: 'b' }, limits: { memoryMb: 256 }, network: 'none' };
    campaign('normalizeSandboxRequest', (fz) => {
      const m = fz.mutateMany(base) as Parameters<typeof normalizeSandboxRequest>[0];
      let r: ReturnType<typeof normalizeSandboxRequest>;
      try {
        r = normalizeSandboxRequest(m);
      } catch (err) {
        return err instanceof TypeError || (err as NodeJS.ErrnoException).code !== undefined ? null : `unexpected ${String(err)}`;
      }
      if (!r.argv.every((a) => typeof a === 'string' && !a.includes('\0'))) return 'argv with NUL accepted';
      if (r.network !== 'none' && r.network !== 'egress-proxy-only') return 'unknown network accepted';
      if (!Object.values(r.limits).every((v) => Number.isFinite(v) && v > 0)) return 'invalid limit accepted';
      return null;
    });

    const matcher = new GuardedMatcher({ projectRoot: ws });
    campaign('GuardedMatcher', (fz) => {
      const p = fz.chance(0.5) ? fz.str() : path.join(ws, fz.str(), fz.str());
      const a = matcher.isGuardedPath(p);
      const b = matcher.isGuardedKey(fz.str());
      return typeof a === 'boolean' && typeof b === 'boolean' ? null : 'non-boolean';
    });

    const routesFile = path.join(ws, 'routes.json');
    const baseRoutes = [{ name: 'llm', upstream: 'https://api.example.com', credential: { header: 'Authorization', env: 'FUZZ_KEY', prefix: 'Bearer ' } }];
    campaign('loadRoutes', (fz) => {
      fs.writeFileSync(routesFile, fz.chance(0.2) ? fz.bytes() : JSON.stringify(fz.mutateMany(baseRoutes)));
      try {
        const routes = loadRoutes(routesFile, { FUZZ_KEY: 'k'.repeat(40) });
        for (const r of routes) if (!/^https?:$/.test(new URL(r.upstream).protocol)) return 'non-http upstream accepted';
      } catch (err) {
        if (!(err instanceof Error)) return `non-Error thrown: ${String(err)}`;
      }
      return null;
    });

    const set = new TripwireSet();
    set.createFile('.env', 'env');
    const manifest = set.toJSON();
    campaign('TripwireSet.fromJSON', (fz) => {
      const m = fz.mutateMany(manifest);
      try {
        const s = TripwireSet.fromJSON(m);
        for (const p of s.decoyPaths) if (p.split('/').includes('..') || path.isAbsolute(p)) return 'escaping decoy path accepted';
      } catch (err) {
        if (!(err instanceof TypeError)) return `non-TypeError: ${String(err)}`;
      }
      return null;
    });
    campaign('TripwireSet.scan on random bytes', (fz) => {
      const hits = set.scan(fz.chance(0.5) ? fz.bytes() : fz.mutateMany({ a: fz.str() }));
      return Array.isArray(hits) ? null : 'scan returned a non-array';
    });

    const snapDir = path.join(ws, 'snaps');
    const snapper = new StateSnapshotter(snapDir, randomBytes(32).toString('hex'));
    const board = { listKeys: () => ['a', 'b'], read: (k: string) => ({ value: `v-${k}`, source_agent: 'agent', timestamp: 'now', ttl: null }) };
    const entry = snapper.snapshot(board as never, 'fuzz');
    const snapFile = path.join(snapDir, `${entry.id}.json`);
    const original = fs.readFileSync(snapFile);
    const manifestFile = path.join(snapDir, 'manifest.jsonl');
    const originalManifest = fs.readFileSync(manifestFile);
    campaign('StateSnapshotter.verify on corrupted files', (fz) => {
      const target = fz.chance(0.5) ? snapFile : manifestFile;
      const before = target === snapFile ? original : originalManifest;
      const mutated = Buffer.from(before);
      for (let i = 0, n = 1 + fz.int(4); i < n; i++) mutated[fz.int(mutated.length)] = fz.int(256);
      fs.writeFileSync(target, mutated);
      const r = snapper.verify(entry.id);
      fs.writeFileSync(target, before);
      if (r === null && !mutated.equals(before)) {
        // Only acceptable if the bytes still parse to the same content.
        try {
          const a = target === snapFile ? JSON.parse(mutated.toString('utf8')) : mutated.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
          const b = target === snapFile ? JSON.parse(before.toString('utf8')) : before.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
          if (!same(a, b)) return 'corrupted snapshot verified';
        } catch {
          return 'unparseable snapshot verified';
        }
      }
      return null;
    }, Math.min(N, 200));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// HTTP doors
// ---------------------------------------------------------------------------

function rawRequest(port: number, method: string, pathName: string, headers: Record<string, string>, body: Buffer | null): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathName, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => resolve({ status: -1, body: e.message }));
    });
    req.on('error', (e) => resolve({ status: -1, body: e.message }));
    if (body) req.write(body);
    req.end();
  });
}

function safePath(fz: Fuzzer, bases: readonly string[]): string {
  const p = fz.chance(0.7) ? fz.pick(bases) : `/${encodeURIComponent(fz.str()).slice(0, 200)}`;
  return fz.chance(0.2) ? `${p}?${encodeURIComponent(fz.str()).slice(0, 100)}=${encodeURIComponent(fz.str()).slice(0, 100)}` : p;
}

async function fuzzAuthorityHttp(): Promise<void> {
  section('Authority HTTP router: no 500s, no grants on malformed input');
  const operator = generateEd25519KeyPair();
  const authorityKey = generateEd25519KeyPair();
  const authority = new LeaseAuthority({ operatorPublicKey: operator.publicKey, authorityKey, policy: signPolicy(basePolicy({ issuedAt: Date.now() }), operator) });
  const secrets = { operator: randomBytes(32).toString('hex'), sentry: randomBytes(32).toString('hex'), runner: randomBytes(32).toString('hex') };
  const server = http.createServer(authority.httpHandler(secrets));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const fz = new Fuzzer(SEED ^ 0xa11);
  const routes = ['/v1/leases/issue', '/v1/leases/renew', '/v1/leases/x/status', '/v1/runs', '/v1/control/revoke', '/v1/control/pause', '/v1/control/tighten', '/v1/control/alert', '/v1/policy', '/v1/checkpoint', '/v1/public-key'];
  const bodies: unknown[] = [{ runId: 'run-1' }, { leaseId: 'x', runId: 'run-1', at: Date.now(), spentUsd: 0, spentTokens: 0, health: 'ok' }, { level: 'critical', kind: 'tripwire' }, { scope: { tier: 'observe', tools: [] } }];
  let problem: string | null = null;
  let slowest = 0;
  const iterations = Math.min(N, 400);
  try {
    for (let i = 0; i < iterations && !problem; i++) {
      const authChoice = fz.int(5);
      // Only the runner and sentry may be used with valid secrets: pausing/revoking as operator would end the campaign early.
      const auth = authChoice === 0 ? undefined : authChoice === 1 ? `Bearer ${fz.str().slice(0, 200)}` : authChoice === 2 ? `Bearer ${secrets.runner}` : authChoice === 3 ? `Bearer ${secrets.sentry}` : `Basic ${fz.str().slice(0, 50)}`;
      const body = fz.chance(0.3) ? fz.bytes() : Buffer.from(JSON.stringify(fz.mutateMany(fz.pick(bodies))) ?? '');
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (auth && !/[\r\n\0]/.test(auth) && /^[\x20-\x7e]*$/.test(auth)) headers['authorization'] = auth;
      const t0 = performance.now();
      const method = fz.pick(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
      const target = safePath(fz, routes);
      const r = await rawRequest(port, method, target, headers, body);
      slowest = Math.max(slowest, performance.now() - t0);
      if (r.status === 500 || r.status === -1) problem = `status ${r.status} (${r.body}) for ${method} ${target.slice(0, 80)} auth=${authChoice} body=${body.length}B, iteration ${i}`;
      if (r.status === 200 && r.body.includes('"granted":true')) {
        const d = JSON.parse(r.body) as { lease?: SignedLease };
        if (!d.lease || verifyLease(d.lease, authorityKey.publicKey) !== null || !/^[A-Za-z0-9_.:-]{1,128}$/.test(d.lease.claims.runId)) problem = 'granted an invalid lease';
      }
      if (headers['authorization'] === undefined && r.status === 200 && !r.body.includes('publicKeyPem')) problem = 'unauthenticated request succeeded';
    }
  } finally {
    server.close();
  }
  assert(problem === null, `authority router (${iterations} requests)`, problem ?? '');
  assert(slowest < 2_000, `authority router: bounded time per request (max ${slowest.toFixed(1)} ms)`);
}

async function fuzzProxyHttp(): Promise<void> {
  section('Egress proxy: tampered leases and garbage never reach the upstream');
  const operator = generateEd25519KeyPair();
  const authorityKey = generateEd25519KeyPair();
  const authority = new LeaseAuthority({ operatorPublicKey: operator.publicKey, authorityKey, policy: signPolicy(basePolicy({ issuedAt: Date.now() }), operator) });
  const lease = authority.issue('run-proxy').lease!;
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => { upstreamHits++; res.end('ok'); });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const set = new TripwireSet();
  const decoy = set.createCredential('decoy', 'openai');
  const proxy = new EgressProxy({
    authorityPublicKey: authority.publicKey,
    isLeaseActive: async (id) => authority.isLeaseActive(id),
    routes: [{ name: 'llm', upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` }],
    tripwires: set,
    ratePerMinute: 100_000,
  });
  const server = http.createServer(proxy.httpHandler());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const fz = new Fuzzer(SEED ^ 0xb22);
  let problem: string | null = null;
  const iterations = Math.min(N, 400);
  try {
    for (let i = 0; i < iterations && !problem; i++) {
      const mutated = fz.mutateMany(lease) as SignedLease;
      if (mutated && typeof mutated === 'object' && same(mutated.claims, lease.claims) && mutated.keyId === lease.keyId) continue;
      const headers: Record<string, string> = {};
      let header: string;
      try { header = encodeLeaseHeader(mutated); } catch { header = fz.str(); }
      if (/^[\x20-\x7e]*$/.test(header)) headers['x-network-ai-lease'] = header.slice(0, 20_000);
      const body = fz.chance(0.2) ? Buffer.from(`{"prompt":"${decoy}"}`) : fz.bytes();
      const before = upstreamHits;
      const r = await rawRequest(port, fz.pick(['GET', 'POST']), safePath(fz, ['/llm/v1/chat', '/llm/../x', '/nope/x']), headers, body);
      if (upstreamHits !== before) problem = `tampered lease forwarded upstream (iteration ${i})`;
      if (r.status === -1) problem = `connection error (${r.body}) iteration ${i}`;
    }
    const hitsBefore = upstreamHits;
    const ok = await rawRequest(port, 'POST', '/llm/v1/chat', { 'x-network-ai-lease': encodeLeaseHeader(lease) }, Buffer.from('{"prompt":"hi"}'));
    assert(ok.status === 200 && upstreamHits === hitsBefore + 1, 'control: the genuine lease is still forwarded after the campaign', String(ok.status));
  } finally {
    server.close();
    upstream.close();
  }
  assert(problem === null, `egress proxy (${iterations} requests)`, problem ?? '');
}

// ---------------------------------------------------------------------------
// Phase 5b/5c doors: relay frames, co-sign, Merkle proofs, capability evals
// ---------------------------------------------------------------------------

async function fuzzPhase5Doors(): Promise<void> {
  section('Relay frames: decoder and schema never throw past the relay, never pass admin messages');
  campaign('FrameDecoder on random bytes (FrameError only)', (fz) => {
    const dec = new FrameDecoder(4096);
    try {
      for (let i = 0; i < 3; i++) dec.push(fz.bytes());
    } catch (err) {
      if (!(err instanceof FrameError)) return `non-FrameError: ${String(err)}`;
    }
    return null;
  });
  const valid = [
    { t: 'lease-issue', id: 'a1', runId: 'run-1' },
    { t: 'lease-challenge', id: 'a2', runId: 'run-1' },
    { t: 'lease-status', id: 'a3', leaseId: 'lease_x' },
    { t: 'lease-renew', id: 'a4', heartbeat: { leaseId: 'lease_x', runId: 'run-1', at: 1, spentUsd: 0, spentTokens: 0, health: 'ok' } },
    { t: 'egress', id: 'a5', route: 'llm', method: 'POST', path: '/v1/chat', lease: 'abc' },
  ];
  campaign('parseRelayRequest accepts only the fixed schemas', (fz) => {
    const m = fz.mutateMany(fz.pick(valid));
    const r = parseRelayRequest(m);
    if (typeof r === 'string') return null;
    if (!['lease-issue', 'lease-challenge', 'lease-status', 'lease-renew', 'egress'].includes(r.t)) return `unknown type accepted: ${String(r.t)}`;
    if (r.t === 'egress' && (r.path.includes('..') || /%2e/i.test(r.path))) return 'traversal path accepted';
    return null;
  });

  const operator = generateEd25519KeyPair();
  const authorityKey = generateEd25519KeyPair();
  const authority = new LeaseAuthority({ operatorPublicKey: operator.publicKey, authorityKey, policy: signPolicy(basePolicy({ issuedAt: Date.now() }), operator) });
  const sock = process.platform === 'win32' ? `\\\\.\\pipe\\nai-fuzz-${randomBytes(6).toString('hex')}` : path.join(os.tmpdir(), `nai-fuzz-${randomBytes(6).toString('hex')}.sock`);
  let issued = 0;
  const relay = new VsockRelay({
    runIds: ['run-1'], ratePerSecond: 10_000, maxInFlight: 64,
    leases: { issue: async (r) => { issued++; return authority.issue(r, 'runner'); }, renew: async (h) => authority.renew(h, 'runner'), isActive: async (id) => authority.isLeaseActive(id) },
  });
  const server = relay.listen(sock);
  await new Promise<void>((done) => server.on('listening', () => done()));
  const fz = new Fuzzer(SEED ^ 0xc33);
  let problem: string | null = null;
  const iterations = Math.min(N, 300);
  try {
    for (let i = 0; i < iterations; i++) {
      const payload = fz.chance(0.4) ? fz.bytes() : encodeFrame(fz.mutateMany(fz.pick(valid)));
      await new Promise<void>((done) => {
        const s = net.connect(sock);
        s.on('connect', () => s.end(payload));
        s.on('error', () => done());
        s.on('close', () => done());
        s.resume();
        setTimeout(() => { s.destroy(); done(); }, 500);
      });
    }
    const status = authority.status();
    if (status.some((r) => r.runId !== 'run-1')) problem = 'relay issued a lease for a run it does not serve';
    if (status.some((r) => r.state === 'paused')) problem = 'relay frame reached an admin action';
  } finally {
    server.close();
  }
  assert(problem === null, `live relay (${iterations} connections; ${issued} issue requests reached the authority)`, problem ?? '');

  section('Co-sign: tampered claims never widen the policy (even when the issuer signed them)');
  const keys = [generateEd25519KeyPair(), generateEd25519KeyPair()];
  const peers = keys.map((k) => k.publicKey);
  const qPolicy = signPolicy(basePolicy({ authorityQuorum: { threshold: 2, keyIds: keys.map((k) => k.keyId) } }), operator);
  campaign('authority.cosign with mutated, issuer-signed claims', (fz2) => {
    const a = new LeaseAuthority({ operatorPublicKey: operator.publicKey, authorityKey: keys[0], policy: qPolicy, now: () => T0, peerAuthorityKeys: peers });
    const b = new LeaseAuthority({ operatorPublicKey: operator.publicKey, authorityKey: keys[1], policy: qPolicy, now: () => T0, peerAuthorityKeys: peers });
    const lease = a.issue('run-c').lease!;
    const mutated = fz2.mutateMany(lease.claims) as typeof lease.claims;
    let claims = mutated;
    let sig: { keyId: string; signature: string } | undefined;
    if (mutated && typeof mutated === 'object' && !Array.isArray(mutated)) {
      // Model a compromised issuer: it signs whatever it is given; the co-signer must still refuse widening.
      const signed = signLease({ ...mutated, issuer: keys[0].keyId }, keys[0]);
      claims = signed.claims;
      sig = { keyId: signed.keyId, signature: signed.signature };
    }
    const d = b.cosign(claims, undefined, 'runner', sig);
    if (!d.granted) return null;
    const pol = b.effectivePolicy();
    if (!claims || claims.policyHash !== lease.claims.policyHash) return 'co-signed claims under another policy';
    if (!(claims.expiresAt <= T0 + pol.leaseTtlMs + 30_000)) return 'co-signed an over-long lease';
    if (!(claims.budget.runCeilingUsd <= pol.budget.runCeilingUsd)) return 'co-signed a higher budget';
    if (!scopeWithin(claims.scope, pol.scope)) return 'co-signed a wider scope';
    return null;
  });
  campaign('authority.cosign never signs without a valid issuer signature', (fz2) => {
    const b = new LeaseAuthority({ operatorPublicKey: operator.publicKey, authorityKey: keys[1], policy: qPolicy, now: () => T0, peerAuthorityKeys: peers });
    const a = new LeaseAuthority({ operatorPublicKey: operator.publicKey, authorityKey: keys[0], policy: qPolicy, now: () => T0, peerAuthorityKeys: peers });
    const lease = a.issue('run-d').lease!;
    const claims = fz2.mutateMany(lease.claims) as typeof lease.claims;
    const sig = fz2.mutateMany({ keyId: lease.keyId, signature: lease.signature }) as { keyId: string; signature: string };
    const d = b.cosign(claims, undefined, 'runner', sig);
    if (d.granted && !(same(claims, lease.claims) && sig && sig.keyId === lease.keyId && sig.signature?.toLowerCase() === lease.signature)) return 'co-signed claims the issuer never signed';
    return null;
  });

  section('Merkle proofs: mutated proofs and heads never verify for other content');
  const log = new MerkleAuditLog();
  for (let i = 0; i < 37; i++) log.append({ i });
  const root = log.root();
  campaign('verifyInclusion with mutated inputs', (fz2) => {
    const idx = fz2.int(37);
    const proof = log.inclusionProof(idx);
    const mutated = fz2.mutateMany({ leaf: leafHashOf({ i: idx }), idx, size: 37, proof, root }) as { leaf: string; idx: number; size: number; proof: string[]; root: string };
    let ok = false;
    try { ok = verifyInclusion(mutated?.leaf, mutated?.idx, mutated?.size, mutated?.proof, mutated?.root); } catch (err) { return `threw ${String(err)}`; }
    if (ok && !(same(mutated.leaf, leafHashOf({ i: idx })) && mutated.idx === idx && mutated.size === 37 && same(mutated.proof, proof) && mutated.root === root)) return 'mutated inclusion proof verified';
    return null;
  });
  campaign('verifyConsistency with mutated inputs', (fz2) => {
    const m = 1 + fz2.int(36);
    const proof = log.consistencyProof(m);
    const x = fz2.mutateMany({ m, n: 37, a: log.root(m), b: root, proof }) as { m: number; n: number; a: string; b: string; proof: string[] };
    let ok = false;
    try { ok = verifyConsistency(x?.m, x?.n, x?.a, x?.b, x?.proof); } catch (err) { return `threw ${String(err)}`; }
    if (ok && !(x.m === m && x.n === 37 && x.a === log.root(m) && x.b === root && same(x.proof, proof))) return 'mutated consistency proof verified';
    return null;
  });

  section('Capability evaluations: tampering never passes');
  const evaluator = generateEd25519KeyPair();
  const req = { evaluatorPublicKeysPem: [evaluator.publicKey.export({ type: 'spki', format: 'pem' }).toString()], thresholds: { deception: { max: 0.1 } }, maxAgeMs: 60 * 60 * 1000 };
  const signedEval = signCapabilityEval({ v: 'nai-capeval-v1', evalId: 'e1', suite: 's', scores: { deception: 0.5 }, evaluatedAt: T0 }, evaluator);
  campaign('verifyCapabilityEval on a failing evaluation', (fz2) => {
    const m = fz2.mutateMany(signedEval) as typeof signedEval;
    return verifyCapabilityEval(m, req, T0) === null ? 'a failing or tampered evaluation passed' : null;
  });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  process.stdout.write(`Perpetual Runtime — fuzz (seed ${SEED}, ${N} iterations per target)\n`);
  const heap0 = process.memoryUsage().heapUsed;
  fuzzSigned();
  fuzzInputs();
  await fuzzAuthorityHttp();
  await fuzzProxyHttp();
  await fuzzPhase5Doors();
  const growthMb = (process.memoryUsage().heapUsed - heap0) / 1024 / 1024;
  assert(growthMb < 256, `bounded memory (heap grew ${growthMb.toFixed(1)} MB)`);

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    for (const f of failures) process.stdout.write(`  - ${f}\n`);
    process.exit(1);
  }
}

process.on('unhandledRejection', (err) => {
  process.stdout.write(`  ✗ unhandled rejection — ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

void main().catch((err) => {
  process.stdout.write(`  ✗ unhandled — ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
