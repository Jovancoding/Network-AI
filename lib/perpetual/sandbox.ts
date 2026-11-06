/**
 * Perpetual Runtime — sandboxed execution.
 *
 * `ISandboxRunner` is the containment boundary for long-running agents: each
 * command runs in a fresh, disposable environment with a read-only root, a
 * single writable workspace, resource limits, and either no network or only
 * the egress proxy. Backends are bring-your-own; {@link ContainerSandboxRunner}
 * drives Docker/Podman with gVisor (`runsc`) by default. MicroVM backends
 * (Firecracker, Kata) implement the same interface.
 *
 * @module Sandbox
 */

import { spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { isAbsolute, resolve } from 'path';
import { statSync } from 'fs';

/** Resource limits for one sandboxed run. */
export interface SandboxLimits {
  memoryMb: number;
  cpus: number;
  pids: number;
  timeoutMs: number;
}

/** Network policy: nothing, only the egress proxy, or only the framed relay socket (no IP network at all). */
export type SandboxNetwork = 'none' | 'egress-proxy-only' | 'relay-only';

/** One command to run in a sandbox. */
export interface SandboxRequest {
  /** Program and arguments; never interpreted by a shell */
  argv: readonly string[];
  /** Host directory mounted read-write at `/workspace` (the only writable mount) */
  workspace: string;
  env?: Readonly<Record<string, string>>;
  limits?: Partial<SandboxLimits>;
  /** Default `'none'` */
  network?: SandboxNetwork;
  /** Max combined stdout+stderr bytes kept (default 1 MiB) */
  maxOutputBytes?: number;
}

/** Evidence of what ran, under which limits, with which outcome. */
export interface SandboxReceipt {
  v: 'nai-sandbox-v1';
  runner: string;
  argvHash: string;
  workspace: string;
  network: SandboxNetwork;
  limits: SandboxLimits;
  startedAt: number;
  endedAt: number;
  exitCode: number;
  timedOut: boolean;
  stdoutHash: string;
  stderrHash: string;
}

/** Result of a sandboxed run. */
export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  receipt: SandboxReceipt;
}

/** A sandbox backend. Implementations must destroy the environment after each run. */
export interface ISandboxRunner {
  readonly name: string;
  run(request: SandboxRequest): Promise<SandboxResult>;
}

/** Defaults applied to missing limits. */
export const DEFAULT_SANDBOX_LIMITS: Readonly<SandboxLimits> = { memoryMb: 512, cpus: 1, pids: 128, timeoutMs: 120_000 };

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_LIMITS: SandboxLimits = { memoryMb: 64 * 1024, cpus: 64, pids: 65_536, timeoutMs: 24 * 60 * 60 * 1000 };

/** A request with defaults applied and every field validated. */
export interface NormalizedSandboxRequest {
  argv: string[];
  workspace: string;
  env: Record<string, string>;
  limits: SandboxLimits;
  network: SandboxNetwork;
  maxOutputBytes: number;
}

/** Validate a request and apply defaults. Throws `TypeError` on anything unsafe. */
export function normalizeSandboxRequest(req: SandboxRequest): NormalizedSandboxRequest {
  if (!req || !Array.isArray(req.argv) || req.argv.length === 0 || req.argv.length > 1024) throw new TypeError('sandbox: argv must be a non-empty array');
  for (const a of req.argv) {
    if (typeof a !== 'string' || a.includes('\0') || a.length > 32_768) throw new TypeError('sandbox: argv entries must be strings without NUL');
  }
  if (typeof req.workspace !== 'string' || !isAbsolute(req.workspace)) throw new TypeError('sandbox: workspace must be an absolute path');
  const workspace = resolve(req.workspace);
  if (workspace.includes(',') || (workspace.includes(':') && process.platform !== 'win32')) {
    throw new TypeError('sandbox: workspace path may not contain "," or ":"');
  }
  if (!statSync(workspace).isDirectory()) throw new TypeError('sandbox: workspace must be a directory');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.env ?? {})) {
    if (!ENV_KEY.test(k) || typeof v !== 'string' || v.includes('\0')) throw new TypeError(`sandbox: invalid env entry ${k}`);
    env[k] = v;
  }
  if (req.limits !== undefined && (req.limits === null || typeof req.limits !== 'object' || Array.isArray(req.limits))) throw new TypeError('sandbox: limits must be an object');
  // Only known limit keys are copied, so nothing unvalidated reaches the engine or the receipt.
  const limits: SandboxLimits = { ...DEFAULT_SANDBOX_LIMITS };
  for (const key of Object.keys(MAX_LIMITS) as (keyof SandboxLimits)[]) {
    if (req.limits?.[key] !== undefined) limits[key] = req.limits[key] as number;
    const v = limits[key];
    if (!(typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_LIMITS[key])) throw new TypeError(`sandbox: limits.${key} out of range`);
  }
  const network = req.network ?? 'none';
  if (network !== 'none' && network !== 'egress-proxy-only' && network !== 'relay-only') throw new TypeError('sandbox: network must be "none", "egress-proxy-only", or "relay-only"');
  const maxOutputBytes = req.maxOutputBytes ?? 1024 * 1024;
  if (!(Number.isInteger(maxOutputBytes) && maxOutputBytes > 0 && maxOutputBytes <= 64 * 1024 * 1024)) throw new TypeError('sandbox: maxOutputBytes out of range');
  return { argv: [...req.argv], workspace, env, limits, network, maxOutputBytes };
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Options for {@link ContainerSandboxRunner}. */
export interface ContainerSandboxOptions {
  /** Image to run (pin by digest in production) */
  image: string;
  /** Container engine binary (default `docker`; `podman` works too) */
  engine?: string;
  /** Arguments placed before the engine subcommand (rarely needed) */
  engineArgs?: readonly string[];
  /** OCI runtime (default `runsc`, i.e. gVisor) */
  runtime?: string;
  /** Required to use a runtime other than `runsc` or `kata*` (shared-kernel isolation) */
  allowWeakIsolation?: boolean;
  /** Engine network where the only reachable host is the egress proxy; required for `egress-proxy-only` */
  egressNetwork?: string;
  /** Proxy URL exposed to the workload as `NETWORK_AI_EGRESS_PROXY` */
  egressProxyUrl?: string;
  /** Host path of the `VsockRelay` socket; required for `relay-only` (mounted at `/run/network-ai/relay.sock`) */
  relaySocket?: string;
  /** User inside the container (default `65534:65534`, i.e. nobody). uid 0 (root) is refused. */
  user?: string;
  /**
   * `'hardened'`: the workload must be `node`; the runner inserts
   * `--no-addons --disallow-code-generation-from-strings --permission`
   * with file-system access limited to `/workspace` (see {@link hardenedNodeArgs}).
   */
  nodeProfile?: 'hardened';
  /** Options for the hardened profile */
  nodeHardening?: HardenedNodeOptions;
}

/** Options for {@link hardenedNodeArgs}. */
export interface HardenedNodeOptions {
  /** Directory the process may read and write (default `/workspace`) */
  workspace?: string;
  /** Extra read-only directories (e.g. a mounted `node_modules`) */
  readOnly?: readonly string[];
  allowChildProcess?: boolean;
  allowWorker?: boolean;
  /** `--permission` (Node ≥ 22.13 / 23.5) or `--experimental-permission` (Node 20–22). Default `--permission`. */
  permissionFlag?: '--permission' | '--experimental-permission';
  /** Absolute path of the image's node binary, if workloads name it explicitly (outside the workspace) */
  nodePath?: string;
}

const SAFE_DIR = /^\/[A-Za-z0-9_./-]{0,511}$/;

/**
 * Node flags for agent processes: no native addons, no `eval`-style code
 * generation, and the permission model with file-system access limited to the
 * workspace. Pass them in argv (not `NODE_OPTIONS`, which does not accept
 * every flag on every Node line). Child processes and workers stay disabled
 * unless explicitly allowed.
 */
export function hardenedNodeArgs(opts: HardenedNodeOptions = {}): string[] {
  const ws = opts.workspace ?? '/workspace';
  const dirs = [ws, ...(opts.readOnly ?? [])];
  for (const d of dirs) {
    if (typeof d !== 'string' || !SAFE_DIR.test(d) || d.split('/').includes('..') || d === '/') throw new TypeError('hardenedNodeArgs: directories must be absolute, specific, and free of ".."');
  }
  const flag = opts.permissionFlag ?? '--permission';
  if (flag !== '--permission' && flag !== '--experimental-permission') throw new TypeError('hardenedNodeArgs: invalid permissionFlag');
  if (opts.nodePath !== undefined && (!SAFE_DIR.test(opts.nodePath) || opts.nodePath.split('/').includes('..') || opts.nodePath === ws || opts.nodePath.startsWith(`${ws}/`))) {
    throw new TypeError('hardenedNodeArgs: nodePath must be an absolute path outside the workspace');
  }
  return [
    '--no-addons',
    '--disallow-code-generation-from-strings',
    flag,
    ...dirs.map((d) => `--allow-fs-read=${d}`),
    `--allow-fs-write=${ws}`,
    ...(opts.allowChildProcess ? ['--allow-child-process'] : []),
    ...(opts.allowWorker ? ['--allow-worker'] : []),
  ];
}

/** Node options a caller may put before the script under the hardened profile (no separate values, no widening). */
const SAFE_NODE_OPTION = /^(--enable-source-maps|--no-warnings|--trace-warnings|--trace-uncaught|--no-deprecation|--throw-deprecation|--max-old-space-size=\d{1,6}|--stack-trace-limit=\d{1,4})$/;
/** Environment the hardened profile refuses: loader injection, Node configuration, and executable lookup. */
const HARDENED_FORBIDDEN_ENV = /^(LD_|DYLD_|NODE_|NODE$|PATH$|PRELOAD|GCONV_PATH$|HOSTALIASES$|LOCPATH$|MALLOC_|UV_|OPENSSL_CONF$|SSL_CERT_)/i;

/**
 * Check that a Node process runs with the hardened profile. Pass
 * `process.execArgv` (default). Returns the problems found (empty when hardened).
 */
export function checkHardenedNode(
  execArgv: readonly string[] = process.execArgv,
  opts: { allowChildProcess?: boolean; allowWorker?: boolean } = {},
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const has = (f: string) => execArgv.includes(f);
  if (!has('--no-addons')) problems.push('missing --no-addons');
  if (!has('--disallow-code-generation-from-strings')) problems.push('missing --disallow-code-generation-from-strings');
  if (!has('--permission') && !has('--experimental-permission')) problems.push('permission model not enabled (--permission)');
  for (const a of execArgv) {
    if (/^--allow-fs-(read|write)=(\*|\/)$/.test(a)) problems.push(`file-system permission too broad: ${a}`);
    if (a === '--allow-child-process' && !opts.allowChildProcess) problems.push('child processes allowed (--allow-child-process)');
    if (a === '--allow-worker' && !opts.allowWorker) problems.push('workers allowed (--allow-worker)');
    if (a === '--allow-addons') problems.push('native addons allowed (--allow-addons)');
  }
  return { ok: problems.length === 0, problems };
}

const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,254}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const USER = /^[0-9]{1,10}(:[0-9]{1,10})?$/;
/** Where `relay-only` sandboxes find the relay socket. */
export const RELAY_SOCKET_IN_SANDBOX = '/run/network-ai/relay.sock';

/** Docker/Podman sandbox with gVisor by default. One disposable container per run. */
export class ContainerSandboxRunner implements ISandboxRunner {
  readonly name: string;
  private readonly engine: string;
  private readonly runtime: string;

  constructor(private readonly options: ContainerSandboxOptions) {
    if (!options || typeof options.image !== 'string' || !IMAGE.test(options.image)) throw new TypeError('ContainerSandboxRunner: invalid image');
    this.engine = options.engine ?? 'docker';
    this.runtime = options.runtime ?? 'runsc';
    if (!NAME.test(this.runtime)) throw new TypeError('ContainerSandboxRunner: invalid runtime');
    if (this.runtime !== 'runsc' && !this.runtime.startsWith('kata') && options.allowWeakIsolation !== true) {
      throw new TypeError(`ContainerSandboxRunner: runtime "${this.runtime}" shares the host kernel; set allowWeakIsolation: true to accept that`);
    }
    if (options.egressNetwork !== undefined && !NAME.test(options.egressNetwork)) throw new TypeError('ContainerSandboxRunner: invalid egressNetwork');
    if (options.egressProxyUrl !== undefined && !/^https?:\/\/[^\s]+$/.test(options.egressProxyUrl)) throw new TypeError('ContainerSandboxRunner: invalid egressProxyUrl');
    if (options.relaySocket !== undefined && (!isAbsolute(options.relaySocket) || /[,\0]/.test(options.relaySocket))) throw new TypeError('ContainerSandboxRunner: relaySocket must be an absolute path without ","');
    if (options.user !== undefined && !USER.test(options.user)) throw new TypeError('ContainerSandboxRunner: user must be numeric uid[:gid]');
    if (options.user !== undefined && /^0+(:|$)/.test(options.user)) throw new TypeError('ContainerSandboxRunner: refusing to run the agent as root (uid 0)');
    if (options.nodeProfile !== undefined && options.nodeProfile !== 'hardened') throw new TypeError('ContainerSandboxRunner: nodeProfile must be "hardened"');
    if (options.nodeProfile === 'hardened') hardenedNodeArgs(options.nodeHardening);
    this.name = `container:${this.runtime}`;
  }

  /** Engine arguments for a run (exposed for inspection and tests). */
  buildArgs(req: NormalizedSandboxRequest, containerName: string): string[] {
    const o = this.options;
    let network = 'none';
    const env = { ...req.env };
    const extraMounts: string[] = [];
    if (req.network === 'egress-proxy-only') {
      if (!o.egressNetwork) throw new TypeError('sandbox: egress-proxy-only needs egressNetwork configured');
      network = o.egressNetwork;
      if (o.egressProxyUrl) env['NETWORK_AI_EGRESS_PROXY'] = o.egressProxyUrl;
    } else if (req.network === 'relay-only') {
      if (!o.relaySocket) throw new TypeError('sandbox: relay-only needs relaySocket configured');
      extraMounts.push('--mount', `type=bind,source=${o.relaySocket},target=${RELAY_SOCKET_IN_SANDBOX}`);
      env['NETWORK_AI_RELAY_SOCKET'] = RELAY_SOCKET_IN_SANDBOX;
    }
    const args = [
      ...(o.engineArgs ?? []),
      'run', '--rm', '--name', containerName,
      '--runtime', this.runtime,
      '--network', network,
      '--read-only',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', String(Math.floor(req.limits.pids)),
      '--memory', `${Math.floor(req.limits.memoryMb)}m`,
      '--memory-swap', `${Math.floor(req.limits.memoryMb)}m`,
      '--cpus', String(req.limits.cpus),
      '--user', o.user ?? '65534:65534',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '--mount', `type=bind,source=${req.workspace},target=/workspace`,
      ...extraMounts,
      '--workdir', '/workspace',
    ];
    for (const [k, v] of Object.entries(env)) args.push('--env', `${k}=${v}`);
    args.push(o.image, ...this.workloadArgv(req));
    return args;
  }

  private workloadArgv(req: NormalizedSandboxRequest): string[] {
    if (this.options.nodeProfile !== 'hardened') return req.argv;
    const [program, ...rest] = req.argv;
    const fixedPath = this.options.nodeHardening?.nodePath;
    // Exactly `node` (resolved by the image's fixed PATH) or the operator's absolute path; never a workspace binary.
    if (program !== 'node' && !(fixedPath !== undefined && program === fixedPath)) throw new TypeError('sandbox: the hardened node profile only runs `node` (or the configured nodePath)');
    for (const key of Object.keys(req.env)) {
      if (HARDENED_FORBIDDEN_ENV.test(key)) throw new TypeError(`sandbox: ${key} is not allowed under the hardened node profile`);
    }
    // Allowlist: only options that take no separate value and cannot widen permissions may precede the script.
    // Anything else (including options whose value is a separate argument) is refused.
    let i = 0;
    for (; i < rest.length && rest[i].startsWith('-'); i++) {
      if (!SAFE_NODE_OPTION.test(rest[i])) throw new TypeError(`sandbox: node option ${rest[i].split('=')[0]} is not allowed under the hardened node profile`);
    }
    if (i >= rest.length) throw new TypeError('sandbox: the hardened node profile needs a script to run');
    return [program, ...hardenedNodeArgs(this.options.nodeHardening), ...rest];
  }

  /** Run one command in a fresh container; the container is removed afterwards (and killed on timeout). */
  run(request: SandboxRequest): Promise<SandboxResult> {
    const req = normalizeSandboxRequest(request);
    const containerName = `nai-sbx-${randomBytes(8).toString('hex')}`;
    const args = this.buildArgs(req, containerName);
    const startedAt = Date.now();
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.engine, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, env: minimalEnv() });
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let truncated = false;
      let timedOut = false;
      const take = (chunk: Buffer, into: 'out' | 'err') => {
        bytes += chunk.length;
        if (bytes > req.maxOutputBytes) { truncated = true; return; }
        if (into === 'out') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
      };
      child.stdout?.on('data', (c: Buffer) => take(c, 'out'));
      child.stderr?.on('data', (c: Buffer) => take(c, 'err'));
      const timer = setTimeout(() => {
        timedOut = true;
        const killer = spawn(this.engine, [...(this.options.engineArgs ?? []), 'kill', containerName], { stdio: 'ignore', windowsHide: true, shell: false, env: minimalEnv() });
        killer.on('error', () => undefined);
        setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2_000);
      }, req.limits.timeoutMs);
      child.on('error', (err) => { clearTimeout(timer); reject(new Error(`sandbox: failed to start ${this.engine}: ${err.message}`)); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const endedAt = Date.now();
        const exitCode = code ?? (timedOut ? 124 : 1);
        resolvePromise({
          exitCode, stdout, stderr, timedOut, truncated, durationMs: endedAt - startedAt,
          receipt: makeSandboxReceipt(this.name, req, { startedAt, endedAt, exitCode, timedOut, stdout, stderr }),
        });
      });
    });
  }
}

/** Only what the engine CLI needs; agent secrets in `process.env` never reach it. */
function minimalEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TEMP', 'TMP', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'XDG_RUNTIME_DIR', 'CONTAINER_HOST'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

/** Build a receipt for a custom runner. */
export function makeSandboxReceipt(
  runner: string,
  req: NormalizedSandboxRequest,
  outcome: { startedAt: number; endedAt: number; exitCode: number; timedOut: boolean; stdout: string; stderr: string },
): SandboxReceipt {
  return {
    v: 'nai-sandbox-v1', runner, argvHash: sha256(JSON.stringify(req.argv)), workspace: req.workspace, network: req.network,
    limits: req.limits, startedAt: outcome.startedAt, endedAt: outcome.endedAt, exitCode: outcome.exitCode,
    timedOut: outcome.timedOut, stdoutHash: sha256(outcome.stdout), stderrHash: sha256(outcome.stderr),
  };
}
