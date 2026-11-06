/**
 * Perpetual Runtime — deployment posture gate (Phase 5a.1).
 *
 * Checks that the control plane is deployed so code on the agent host cannot
 * reach it: separate OS users, no operator private key on the authority host,
 * owner-only key files, strong distinct role secrets, TLS for remote binds,
 * a strong sandbox runtime, and hardened Node flags for agent processes.
 *
 * `perpetual authority|proxy` refuse to start on a failed check unless the
 * operator passes `--accept-risk <check-id>`, which is audited.
 *
 * @module PerpetualPosture
 */

import * as fs from 'fs';
import * as os from 'os';
import type { KeyObject } from 'crypto';
import { isLoopbackHost } from '../http-guards';
import { keyIdOf } from './signing';
import { readKeyPair } from './files';
import { checkHardenedNode } from './sandbox';

/** Identifier of a posture check (stable; used with `--accept-risk`). */
export type PostureCheckId =
  | 'operator-key-present'
  | 'key-file-mode'
  | 'runs-as-agent-user'
  | 'runs-as-root'
  | 'weak-secret'
  | 'duplicate-secret'
  | 'remote-bind-no-tls'
  | 'weak-sandbox-runtime'
  | 'hardened-node'
  | 'single-authority'
  | 'agent-user-unset';

/** Every check id, for validating `--accept-risk`. */
export const POSTURE_CHECK_IDS: readonly PostureCheckId[] = [
  'operator-key-present', 'key-file-mode', 'runs-as-agent-user', 'runs-as-root', 'weak-secret', 'duplicate-secret',
  'remote-bind-no-tls', 'weak-sandbox-runtime', 'hardened-node', 'single-authority', 'agent-user-unset',
];

/** One check result. `severity: 'fail'` blocks startup unless accepted; `'warn'` never blocks. */
export interface PostureCheck {
  id: PostureCheckId;
  ok: boolean;
  severity: 'fail' | 'warn';
  detail: string;
}

/** What to check. Omit a field to skip the checks that need it. */
export interface PostureInput {
  /** Which process is starting */
  role: 'authority' | 'proxy' | 'sentry' | 'agent';
  /** Private key files this process will load */
  privateKeyFiles?: readonly string[];
  /** Operator public key; any local private key that matches it fails `operator-key-present` */
  operatorPublicKey?: KeyObject;
  /** Extra paths where an operator key must not exist on this host */
  operatorKeyPaths?: readonly string[];
  /** OS user (name or numeric uid) the agents run as */
  agentUser?: string;
  /** Override the current user (tests) */
  currentUser?: { username: string; uid: number };
  /** Role secrets this process uses or accepts, keyed by name */
  secrets?: Readonly<Record<string, string | undefined>>;
  /** Listener this process binds */
  bind?: { host: string; allowRemote?: boolean; tlsTerminated?: boolean };
  /** OCI runtime used for agent sandboxes */
  sandboxRuntime?: string;
  /** Node flags of the agent process (default for `agent`: `process.execArgv`) */
  nodeExecArgv?: readonly string[];
  /** Configured lease-authority quorum threshold (k) */
  authorityThreshold?: number;
  /** Override the platform (tests) */
  platform?: NodeJS.Platform;
}

/** Report from {@link runPostureChecks}. */
export interface PostureReport {
  ok: boolean;
  checks: PostureCheck[];
}

const STRONG_RUNTIMES = /^(runsc|kata[A-Za-z0-9_.-]*|io\.containerd\.kata[A-Za-z0-9_.-]*|firecracker[A-Za-z0-9_.-]*)$/;

/** Shannon entropy of `s` in bits per character. */
function entropyPerChar(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Run every applicable posture check. Never throws on missing files; reports them. */
export function runPostureChecks(input: PostureInput): PostureReport {
  const checks: PostureCheck[] = [];
  const add = (id: PostureCheckId, ok: boolean, severity: 'fail' | 'warn', detail: string) => checks.push({ id, ok, severity, detail });
  const platform = input.platform ?? process.platform;
  const controlPlane = input.role === 'authority' || input.role === 'proxy' || input.role === 'sentry';
  const user = input.currentUser ?? safeUser();

  // Operator key must never be on a control-plane host that runs unattended.
  if (controlPlane) {
    const found: string[] = [];
    for (const p of input.operatorKeyPaths ?? []) if (exists(p)) found.push(p);
    if (input.operatorPublicKey) {
      const opId = keyIdOf(input.operatorPublicKey);
      for (const f of input.privateKeyFiles ?? []) {
        try {
          if (readKeyPair(f).keyId === opId) found.push(f);
        } catch {
          // Unreadable key files are reported by key-file-mode.
        }
      }
    }
    add('operator-key-present', found.length === 0, 'fail', found.length === 0 ? 'no operator private key on this host' : `operator private key found: ${found.join(', ')}`);
  }

  // Key files: owner-only and owned by this user (POSIX).
  if (input.privateKeyFiles && input.privateKeyFiles.length > 0) {
    const problems: string[] = [];
    for (const f of input.privateKeyFiles) {
      let st: fs.Stats;
      try {
        st = fs.statSync(f);
      } catch {
        problems.push(`${f}: missing`);
        continue;
      }
      if (platform === 'win32') continue;
      if ((st.mode & 0o077) !== 0) problems.push(`${f}: mode ${(st.mode & 0o777).toString(8)} (want 600)`);
      if (user && user.uid >= 0 && st.uid !== user.uid) problems.push(`${f}: owned by uid ${st.uid}, not ${user.uid}`);
    }
    const detail = problems.length > 0 ? problems.join('; ') : platform === 'win32' ? 'mode not checkable on Windows; restrict the file ACL to this account' : 'owner-only';
    add('key-file-mode', problems.length === 0, 'fail', detail);
  }

  // Separate OS users.
  if (controlPlane) {
    if (input.agentUser === undefined) {
      add('agent-user-unset', false, 'warn', 'agent OS user not configured; cannot verify user separation (--agent-user)');
    } else {
      const same = user !== null && (input.agentUser === user.username || input.agentUser === String(user.uid));
      add('runs-as-agent-user', !same, 'fail', same ? `this process runs as the agent user "${input.agentUser}"` : `runs as "${user?.username ?? '?'}", agents as "${input.agentUser}"`);
    }
    if (user && user.uid === 0) add('runs-as-root', false, 'fail', 'control-plane process runs as root; use a dedicated unprivileged user');
  }

  // Secrets.
  if (input.secrets) {
    const entries = Object.entries(input.secrets).filter((e): e is [string, string] => typeof e[1] === 'string');
    const weak = entries.filter(([, s]) => s.length < 32 || entropyPerChar(s) < 3.0).map(([k]) => k);
    add('weak-secret', weak.length === 0, 'fail', weak.length === 0 ? `${entries.length} secret(s) strong` : `weak or short: ${weak.join(', ')}`);
    const seen = new Map<string, string>();
    const dup: string[] = [];
    for (const [k, s] of entries) {
      const prior = seen.get(s);
      if (prior) dup.push(`${prior}=${k}`);
      else seen.set(s, k);
    }
    add('duplicate-secret', dup.length === 0, 'fail', dup.length === 0 ? 'all secrets distinct' : `shared: ${dup.join(', ')}`);
  }

  // Remote binds need TLS termination.
  if (input.bind) {
    const local = isLoopbackHost(input.bind.host);
    const ok = local || (input.bind.allowRemote === true && input.bind.tlsTerminated === true);
    add('remote-bind-no-tls', ok, 'fail', local ? `loopback (${input.bind.host})` : ok ? `remote ${input.bind.host} behind TLS` : `remote ${input.bind.host} without acknowledged TLS termination (--tls-terminated)`);
  }

  if (input.sandboxRuntime !== undefined) {
    const strong = STRONG_RUNTIMES.test(input.sandboxRuntime);
    add('weak-sandbox-runtime', strong, 'fail', strong ? `runtime ${input.sandboxRuntime}` : `runtime ${input.sandboxRuntime} shares the host kernel (use runsc, kata, or firecracker)`);
  }

  if (input.role === 'agent' || input.nodeExecArgv !== undefined) {
    const r = checkHardenedNode(input.nodeExecArgv ?? process.execArgv);
    add('hardened-node', r.ok, 'fail', r.ok ? 'hardened Node flags present' : r.problems.join('; '));
  }

  if (input.role === 'authority' || input.authorityThreshold !== undefined) {
    const k = input.authorityThreshold ?? 1;
    add('single-authority', k >= 2, 'warn', k >= 2 ? `${k}-of-n authorities` : 'single lease authority; high-risk policies need k >= 2 or an audited acceptRisk');
  }

  return { ok: checks.every((c) => c.ok || c.severity === 'warn'), checks };
}

/**
 * Decide whether a process may start. Failed `fail` checks block unless their
 * id is in `acceptRisk`. Throws on unknown ids so typos never silently accept.
 */
export function postureVerdict(report: PostureReport, acceptRisk: readonly string[] = []): { ok: boolean; blocking: PostureCheck[]; accepted: PostureCheck[] } {
  for (const id of acceptRisk) {
    if (!POSTURE_CHECK_IDS.includes(id as PostureCheckId)) throw new TypeError(`unknown posture check id "${id}"`);
  }
  const failed = report.checks.filter((c) => !c.ok && c.severity === 'fail');
  const accepted = failed.filter((c) => acceptRisk.includes(c.id));
  const blocking = failed.filter((c) => !acceptRisk.includes(c.id));
  return { ok: blocking.length === 0, blocking, accepted };
}

/** Human-readable report lines. */
export function formatPosture(report: PostureReport): string[] {
  return report.checks.map((c) => `${c.ok ? 'PASS' : c.severity === 'warn' ? 'WARN' : 'FAIL'}  ${c.id.padEnd(22)} ${c.detail}`);
}

function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function safeUser(): { username: string; uid: number } | null {
  try {
    const u = os.userInfo();
    return { username: u.username, uid: u.uid };
  } catch {
    return null;
  }
}
