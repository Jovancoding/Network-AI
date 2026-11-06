/**
 * Perpetual Runtime — microVM sandbox runners (Phase 5b.3).
 *
 * Reference backends where the agent runs in its own kernel:
 * - {@link KataSandboxRunner}: Docker/containerd with a Kata runtime.
 * - {@link FirecrackerSandboxRunner}: a Firecracker microVM with **no network
 *   interface**; the only channel out is vsock to a host `VsockRelay`.
 *
 * Binaries, kernels, and root images are bring-your-own. Firecracker needs
 * Linux with KVM. No IP network is ever configured by these runners.
 *
 * @module MicroVmSandbox
 */

import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, join } from 'path';
import {
  ContainerSandboxRunner,
  makeSandboxReceipt,
  normalizeSandboxRequest,
  type ContainerSandboxOptions,
  type ISandboxRunner,
  type NormalizedSandboxRequest,
  type SandboxRequest,
  type SandboxResult,
} from './sandbox';

/** Docker/containerd sandbox on a Kata runtime (each container gets its own kernel). */
export class KataSandboxRunner extends ContainerSandboxRunner {
  constructor(options: Omit<ContainerSandboxOptions, 'runtime' | 'allowWeakIsolation'> & { runtime?: string }) {
    const runtime = options.runtime ?? 'kata-runtime';
    if (!/^(kata[A-Za-z0-9_.-]*|io\.containerd\.kata[A-Za-z0-9_.-]*)$/.test(runtime)) throw new TypeError('KataSandboxRunner: runtime must be a Kata runtime');
    // Validated as a Kata runtime above, so the shared-kernel opt-in never applies.
    super({ ...options, runtime, allowWeakIsolation: !runtime.startsWith('kata') });
  }
}

/** Guest vsock port the relay serves (Firecracker maps it to `<uds_path>_<port>` on the host). */
export const DEFAULT_RELAY_VSOCK_PORT = 5000;

/** Host path the `VsockRelay` must listen on for guest connections to `port`. */
export function firecrackerRelayListenPath(udsPath: string, port = DEFAULT_RELAY_VSOCK_PORT): string {
  return `${udsPath}_${port}`;
}

/** Options for {@link FirecrackerSandboxRunner}. */
export interface FirecrackerSandboxOptions {
  /** Absolute path of the guest kernel */
  kernelImage: string;
  /** Absolute path of the read-only root file system image (dm-verity recommended; record its root hash in the policy) */
  rootfsImage: string;
  /** Firecracker binary (default `firecracker`) */
  firecrackerPath?: string;
  /** Kernel command line (default: serial console, no PCI, read-only root) */
  bootArgs?: string;
  /**
   * Build a block-device image holding the workspace and the command to run
   * (e.g. `mkfs.ext4 -d`) and return its absolute path. Bring-your-own: the
   * guest init reads the command from it.
   */
  workspaceDrive: (req: NormalizedSandboxRequest) => string | Promise<string>;
  /** Read the workload's exit code after the VM stops (default: Firecracker's exit status) */
  collectResult?: (req: NormalizedSandboxRequest, drivePath: string) => Promise<{ exitCode: number }>;
  /** Host UDS path for the guest vsock device; required for `relay-only` */
  vsockUdsPath?: string;
  /** Run Firecracker under the jailer as an unprivileged uid/gid (recommended) */
  jailer?: { path?: string; uid: number; gid: number; id?: string; chrootBaseDir?: string };
  /** Replace the launcher program (testing or custom wrappers); Firecracker arguments are appended */
  launcher?: { command: string; args?: readonly string[] };
  /** Refuse to run off Linux (default true) */
  requireLinux?: boolean;
}

/** Firecracker microVM without a network interface; vsock to the relay is the only channel. */
export class FirecrackerSandboxRunner implements ISandboxRunner {
  readonly name = 'firecracker';

  constructor(private readonly options: FirecrackerSandboxOptions) {
    if (!options || !isAbsolute(options.kernelImage ?? '') || !isAbsolute(options.rootfsImage ?? '')) {
      throw new TypeError('FirecrackerSandboxRunner: kernelImage and rootfsImage must be absolute paths');
    }
    if (typeof options.workspaceDrive !== 'function') throw new TypeError('FirecrackerSandboxRunner: workspaceDrive is required');
    if (options.vsockUdsPath !== undefined && !isAbsolute(options.vsockUdsPath)) throw new TypeError('FirecrackerSandboxRunner: vsockUdsPath must be absolute');
    const j = options.jailer;
    if (j) {
      if (!Number.isInteger(j.uid) || !Number.isInteger(j.gid) || j.uid <= 0 || j.gid < 0) throw new TypeError('FirecrackerSandboxRunner: jailer uid must be a non-root integer');
      if (j.id !== undefined && !/^[A-Za-z0-9-]{1,64}$/.test(j.id)) throw new TypeError('FirecrackerSandboxRunner: invalid jailer id');
    }
    if (options.bootArgs !== undefined && (/[\0\n]/.test(options.bootArgs) || options.bootArgs.length > 2048)) throw new TypeError('FirecrackerSandboxRunner: invalid bootArgs');
  }

  /** Firecracker JSON configuration (exposed for inspection and tests). Never contains a network interface. */
  buildConfig(req: NormalizedSandboxRequest, drivePath: string): Record<string, unknown> {
    if (req.network === 'egress-proxy-only') throw new TypeError('firecracker: IP networking is not supported; use relay-only');
    if (!isAbsolute(drivePath)) throw new TypeError('firecracker: workspace drive path must be absolute');
    const config: Record<string, unknown> = {
      'boot-source': {
        kernel_image_path: this.options.kernelImage,
        boot_args: `${this.options.bootArgs ?? 'console=ttyS0 reboot=k panic=1 pci=off ro'} nai.network=${req.network}`,
      },
      drives: [
        { drive_id: 'rootfs', path_on_host: this.options.rootfsImage, is_root_device: true, is_read_only: true },
        { drive_id: 'workspace', path_on_host: drivePath, is_root_device: false, is_read_only: false },
      ],
      'machine-config': { vcpu_count: Math.max(1, Math.ceil(req.limits.cpus)), mem_size_mib: Math.floor(req.limits.memoryMb), smt: false },
    };
    if (req.network === 'relay-only') {
      if (!this.options.vsockUdsPath) throw new TypeError('firecracker: relay-only needs vsockUdsPath');
      config['vsock'] = { guest_cid: 3, uds_path: this.options.vsockUdsPath };
    }
    return config;
  }

  /** Launcher argv for a config file (exposed for tests). */
  buildArgs(configPath: string): { command: string; args: string[] } {
    const fc = this.options.firecrackerPath ?? 'firecracker';
    const fcArgs = ['--no-api', '--config-file', configPath];
    if (this.options.launcher) return { command: this.options.launcher.command, args: [...(this.options.launcher.args ?? []), ...fcArgs] };
    const j = this.options.jailer;
    if (!j) return { command: fc, args: fcArgs };
    return {
      command: j.path ?? 'jailer',
      args: ['--id', j.id ?? `nai-${randomBytes(6).toString('hex')}`, '--exec-file', fc, '--uid', String(j.uid), '--gid', String(j.gid),
        ...(j.chrootBaseDir ? ['--chroot-base-dir', j.chrootBaseDir] : []), '--', ...fcArgs],
    };
  }

  async run(request: SandboxRequest): Promise<SandboxResult> {
    if ((this.options.requireLinux ?? true) && process.platform !== 'linux') throw new Error('firecracker: requires Linux with KVM');
    const req = normalizeSandboxRequest(request);
    const drive = await this.options.workspaceDrive(req);
    const dir = mkdtempSync(join(tmpdir(), 'nai-fc-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify(this.buildConfig(req, drive)), { mode: 0o600 });
    const { command, args } = this.buildArgs(configPath);
    const startedAt = Date.now();
    try {
      const outcome = await new Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean; truncated: boolean }>((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true, env: { PATH: process.env['PATH'] ?? '' } });
        let stdout = '';
        let stderr = '';
        let bytes = 0;
        let truncated = false;
        let timedOut = false;
        const take = (c: Buffer, into: 'o' | 'e') => {
          bytes += c.length;
          if (bytes > req.maxOutputBytes) { truncated = true; return; }
          if (into === 'o') stdout += c.toString('utf8'); else stderr += c.toString('utf8');
        };
        child.stdout?.on('data', (c: Buffer) => take(c, 'o'));
        child.stderr?.on('data', (c: Buffer) => take(c, 'e'));
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, req.limits.timeoutMs);
        child.on('error', (err) => { clearTimeout(timer); reject(new Error(`firecracker: failed to start ${command}: ${err.message}`)); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? (timedOut ? 124 : 1), stdout, stderr, timedOut, truncated }); });
      });
      const exitCode = !outcome.timedOut && this.options.collectResult ? (await this.options.collectResult(req, drive)).exitCode : outcome.code;
      const endedAt = Date.now();
      return {
        exitCode, stdout: outcome.stdout, stderr: outcome.stderr, timedOut: outcome.timedOut, truncated: outcome.truncated, durationMs: endedAt - startedAt,
        receipt: makeSandboxReceipt(this.name, req, { startedAt, endedAt, exitCode, timedOut: outcome.timedOut, stdout: outcome.stdout, stderr: outcome.stderr }),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
