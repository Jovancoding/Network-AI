/**
 * NemoClaw Adapter
 *
 * Integrates NVIDIA NemoClaw sandboxed agent execution with the
 * SwarmOrchestrator. NemoClaw runs agents inside OpenShell sandboxes
 * with deny-by-default network policies and Landlock filesystem isolation.
 *
 * This adapter manages:
 *  - Sandbox lifecycle (create, status, connect, destroy)
 *  - Network policy generation and application
 *  - Blueprint execution (plan, apply, status, rollback)
 *  - Command execution inside sandboxes
 *
 * BYOC (Bring Your Own Client): No runtime dependency on openshell CLI
 * or NemoClaw. Provide an executor via config, or let the adapter shell
 * out to `openshell` if available on PATH.
 *
 * Usage — default (CLI on PATH):
 *   const adapter = new NemoClawAdapter();
 *   await adapter.initialize({ options: { sandboxImage: 'ghcr.io/nvidia/...' } });
 *   adapter.registerSandboxAgent('worker-1', { sandboxName: 'my-sandbox' });
 *
 * Usage — custom executor (bring-your-own):
 *   adapter.registerSandboxAgent('worker-1', {
 *     sandboxName: 'my-sandbox',
 *     executor: async (cmd, args) => myOpenShellWrapper(cmd, args),
 *   });
 *
 * @module NemoClawAdapter
 * @version 1.0.0
 */

import { BaseAdapter } from './base-adapter';
import type {
  AdapterConfig,
  AdapterCapabilities,
  AgentPayload,
  AgentContext,
  AgentResult,
} from '../types/agent-adapter';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Blueprint execution action */
export type BlueprintAction = 'plan' | 'apply' | 'status' | 'rollback';

/** Sandbox state as reported by openshell */
export type SandboxState = 'running' | 'stopped' | 'creating' | 'error' | 'unknown';

/**
 * User-supplied executor for openshell CLI commands.
 * Receives the subcommand and arguments, returns stdout string.
 * Throw on non-zero exit.
 */
export type OpenShellExecutor = (
  subcommand: string,
  args: string[],
  options?: { timeout?: number; env?: Record<string, string> }
) => Promise<string>;

/** Network policy endpoint definition */
export interface PolicyEndpoint {
  /** Hostname to allow (e.g. "api.nvidia.com") */
  host: string;
  /** Port number (default: 443) */
  port?: number;
  /** Protocol — "rest" or "grpc" */
  protocol?: 'rest' | 'grpc';
  /** Enforcement mode */
  enforcement?: 'enforce' | 'log';
  /** TLS handling */
  tls?: 'terminate' | 'passthrough';
  /** HTTP method/path rules */
  rules?: Array<{ allow: { method: string; path: string } }>;
}

/** Named network policy group */
export interface NetworkPolicy {
  /** Policy group name (e.g. "nvidia", "mcp_server") */
  name: string;
  /** Allowed endpoints */
  endpoints: PolicyEndpoint[];
  /** Binaries allowed to use this policy */
  binaries?: string[];
}

/** Blueprint run result */
export interface BlueprintRunResult {
  success: boolean;
  runId: string;
  action: BlueprintAction;
  output: string;
  exitCode: number;
}

/** Sandbox status information */
export interface SandboxStatus {
  name: string;
  state: SandboxState;
  uptime?: number;
  image?: string;
  policies?: string[];
}

/** Configuration for a registered NemoClaw agent */
export interface NemoClawAgentConfig {
  /** Sandbox name this agent runs in */
  sandboxName: string;
  /** Container image for sandbox creation (used if sandbox doesn't exist) */
  sandboxImage?: string;
  /** Network policies to apply to this agent's sandbox */
  policies?: NetworkPolicy[];
  /** Blueprint path for plan/apply operations */
  blueprintPath?: string;
  /** Blueprint profile name */
  profile?: string;
  /** Custom executor — overrides the adapter-level executor */
  executor?: OpenShellExecutor;
  /** Command to run inside the sandbox for agent execution */
  command?: string;
  /** Ports to forward from the sandbox */
  forwardPorts?: number[];
  /** Environment variables to set inside the sandbox */
  env?: Record<string, string>;
}

/** Internal registry entry for a sandbox agent */
interface SandboxAgentEntry {
  config: NemoClawAgentConfig;
  sandboxReady: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a YAML network policy document from policy objects.
 * Produces the format expected by `openshell policy set`.
 */
function generatePolicyYaml(policies: NetworkPolicy[]): string {
  const lines: string[] = ['version: 1', '', 'network_policies:'];

  for (const policy of policies) {
    lines.push(`  ${sanitizePolicyName(policy.name)}:`);
    lines.push(`    name: ${sanitizePolicyName(policy.name)}`);
    lines.push('    endpoints:');

    for (const ep of policy.endpoints) {
      lines.push(`      - host: "${escapeYamlString(ep.host)}"`);
      if (ep.port != null) lines.push(`        port: ${ep.port}`);
      if (ep.protocol) lines.push(`        protocol: ${ep.protocol}`);
      if (ep.enforcement) lines.push(`        enforcement: ${ep.enforcement}`);
      if (ep.tls) lines.push(`        tls: ${ep.tls}`);
      if (ep.rules && ep.rules.length > 0) {
        lines.push('        rules:');
        for (const rule of ep.rules) {
          lines.push(`          - allow:`);
          lines.push(`              method: "${escapeYamlString(rule.allow.method)}"`);
          lines.push(`              path: "${escapeYamlString(rule.allow.path)}"`);
        }
      }
    }

    if (policy.binaries && policy.binaries.length > 0) {
      lines.push('    binaries:');
      for (const bin of policy.binaries) {
        lines.push(`      - path: "${escapeYamlString(bin)}"`);
      }
    }
  }

  return lines.join('\n') + '\n';
}

/** Sanitize policy name to alphanumeric + underscore only */
function sanitizePolicyName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
}

/** Escape special YAML characters in strings */
function escapeYamlString(value: string): string {
  return value.replace(/[\\"]/g, '\\$&');
}

/**
 * Build the command string from an AgentPayload for sandbox execution.
 */
function buildSandboxCommand(payload: AgentPayload, config: NemoClawAgentConfig): string {
  if (config.command) return config.command;

  const parts: string[] = [];

  if (payload.action) parts.push(payload.action);

  if (payload.params && Object.keys(payload.params).length > 0) {
    // Pass params as a JSON env var inside the sandbox
    parts.push(`--params '${JSON.stringify(payload.params)}'`);
  }

  return parts.join(' ') || 'echo "No command specified"';
}

/**
 * Parse JSON sandbox status output, handling malformed input safely.
 */
function parseSandboxStatus(output: string, name: string): SandboxStatus {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    return {
      name,
      state: (typeof parsed['state'] === 'string' ? parsed['state'] : 'unknown') as SandboxState,
      uptime: typeof parsed['uptime'] === 'number' ? parsed['uptime'] : undefined,
      image: typeof parsed['image'] === 'string' ? parsed['image'] : undefined,
    };
  } catch {
    return { name, state: 'unknown' };
  }
}

// ---------------------------------------------------------------------------
// NemoClawAdapter
// ---------------------------------------------------------------------------

/**
 * Adapter that connects NVIDIA NemoClaw sandboxed agents to the
 * SwarmOrchestrator. Manages sandbox lifecycle, network policies,
 * and blueprint execution with deny-by-default security.
 */
export class NemoClawAdapter extends BaseAdapter {
  readonly name = 'nemoclaw';
  readonly version = '1.0.0';

  private agents: Map<string, SandboxAgentEntry> = new Map();
  private executor: OpenShellExecutor | null = null;
  private defaultImage =
    'ghcr.io/nvidia/openshell-community/sandboxes/openclaw:latest';

  get capabilities(): AdapterCapabilities {
    return {
      streaming: false,
      parallel: true,
      bidirectional: false,
      discovery: true,
      authentication: true,
      statefulSessions: true,
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async initialize(config: AdapterConfig): Promise<void> {
    await super.initialize(config);

    // Accept a custom executor from config
    if (config.options?.executor && typeof config.options.executor === 'function') {
      this.executor = config.options.executor as OpenShellExecutor;
    }

    // Accept default sandbox image from config
    if (config.options?.sandboxImage && typeof config.options.sandboxImage === 'string') {
      this.defaultImage = config.options.sandboxImage;
    }

    this.ready = true;
  }

  async shutdown(): Promise<void> {
    // Clean up: stop port forwarding, but don't destroy sandboxes
    // (they may be shared across sessions)
    this.agents.clear();
    await super.shutdown();
  }

  // -------------------------------------------------------------------------
  // Agent Registration
  // -------------------------------------------------------------------------

  /**
   * Register an agent that runs inside a NemoClaw sandbox.
   *
   * @param agentId  Unique identifier used in `delegateTask` calls.
   * @param config   Sandbox agent configuration.
   */
  registerSandboxAgent(agentId: string, config: NemoClawAgentConfig): void {
    if (!this.ready) {
      this.ready = true; // Allow pre-initialize registration
    }

    if (!config.sandboxName || typeof config.sandboxName !== 'string') {
      throw new Error(
        `NemoClawAdapter: agent "${agentId}" requires a sandboxName.`
      );
    }

    this.agents.set(agentId, { config, sandboxReady: false });
    this.registeredAgents.set(agentId, {
      id: agentId,
      name: agentId,
      description: `NemoClaw sandbox agent (sandbox: ${config.sandboxName})`,
      capabilities: ['sandbox-execution', 'network-isolation', 'blueprint'],
      adapter: this.name,
      status: 'available',
    });
  }

  // -------------------------------------------------------------------------
  // Sandbox Management (public API for advanced usage)
  // -------------------------------------------------------------------------

  /**
   * Create a sandbox if it doesn't already exist.
   * Returns the sandbox status after creation.
   */
  async createSandbox(
    sandboxName: string,
    image?: string,
    forwardPorts?: number[]
  ): Promise<SandboxStatus> {
    const exec = this.getExecutor();

    // Check if sandbox already exists
    try {
      const statusOutput = await exec('sandbox', ['get', sandboxName, '--json']);
      const status = parseSandboxStatus(statusOutput, sandboxName);
      if (status.state === 'running') return status;
    } catch {
      // Sandbox doesn't exist — proceed to create
    }

    const args = [
      'create',
      '--from', image ?? this.defaultImage,
      '--name', sandboxName,
    ];

    if (forwardPorts && forwardPorts.length > 0) {
      args.push('--forward-ports', forwardPorts.join(','));
    }

    await exec('sandbox', args);

    // Return fresh status
    return this.getSandboxStatus(sandboxName);
  }

  /**
   * Get the current status of a sandbox.
   */
  async getSandboxStatus(sandboxName: string): Promise<SandboxStatus> {
    const exec = this.getExecutor();
    try {
      const output = await exec('sandbox', ['get', sandboxName, '--json']);
      return parseSandboxStatus(output, sandboxName);
    } catch {
      return { name: sandboxName, state: 'unknown' };
    }
  }

  /**
   * Destroy a sandbox. Use with caution — this is irreversible.
   */
  async destroySandbox(sandboxName: string): Promise<void> {
    const exec = this.getExecutor();
    await exec('sandbox', ['delete', sandboxName, '--force']);
  }

  /**
   * Execute a command inside a sandbox and return the output.
   */
  async execInSandbox(
    sandboxName: string,
    command: string,
    env?: Record<string, string>
  ): Promise<string> {
    const exec = this.getExecutor();
    return exec('sandbox', ['connect', sandboxName, '--', ...command.split(' ')], { env });
  }

  // -------------------------------------------------------------------------
  // Network Policy Management
  // -------------------------------------------------------------------------

  /**
   * Apply network policies to a sandbox.
   * Generates YAML and applies via `openshell policy set`.
   */
  async applyPolicies(policies: NetworkPolicy[]): Promise<void> {
    const exec = this.getExecutor();
    const yaml = generatePolicyYaml(policies);
    // openshell policy set reads from stdin or a file path
    // We pass the YAML content via a temp mechanism handled by the executor
    await exec('policy', ['set', '--stdin'], { env: { __POLICY_YAML: yaml } });
  }

  /**
   * Generate a Network-AI MCP server policy preset.
   * This allows the sandbox to connect back to the host's MCP server.
   *
   * @param host  Host address for the MCP server (default: "host.docker.internal")
   * @param port  Port number for the MCP server (default: 3001)
   */
  static mcpServerPolicy(host = 'host.docker.internal', port = 3001): NetworkPolicy {
    return {
      name: 'network_ai_mcp',
      endpoints: [
        {
          host,
          port,
          protocol: 'rest',
          enforcement: 'enforce',
          rules: [
            { allow: { method: '*', path: '/sse' } },
            { allow: { method: 'POST', path: '/messages' } },
          ],
        },
      ],
    };
  }

  /**
   * Generate an NVIDIA NIM API policy preset.
   */
  static nvidiaPolicy(): NetworkPolicy {
    return {
      name: 'nvidia',
      endpoints: [
        { host: 'integrate.api.nvidia.com', port: 443, tls: 'passthrough' },
        { host: 'inference-api.nvidia.com', port: 443, tls: 'passthrough' },
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Blueprint Execution
  // -------------------------------------------------------------------------

  /**
   * Execute a blueprint action (plan, apply, status, rollback).
   */
  async execBlueprint(
    blueprintPath: string,
    action: BlueprintAction,
    options?: { profile?: string; planPath?: string; dryRun?: boolean }
  ): Promise<BlueprintRunResult> {
    const exec = this.getExecutor();

    const args = [action, '--blueprint', blueprintPath];
    if (options?.profile) args.push('--profile', options.profile);
    if (options?.planPath) args.push('--plan', options.planPath);
    if (options?.dryRun) args.push('--dry-run');

    const runId = `run-${Date.now()}`;

    try {
      const output = await exec('blueprint', args, {
        env: {
          NEMOCLAW_BLUEPRINT_PATH: blueprintPath,
          NEMOCLAW_ACTION: action,
        },
      });

      return {
        success: true,
        runId,
        action,
        output,
        exitCode: 0,
      };
    } catch (error) {
      return {
        success: false,
        runId,
        action,
        output: error instanceof Error ? error.message : String(error),
        exitCode: 1,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Agent Execution (BaseAdapter contract)
  // -------------------------------------------------------------------------

  async executeAgent(
    agentId: string,
    payload: AgentPayload,
    context: AgentContext
  ): Promise<AgentResult> {
    this.ensureReady();

    const entry = this.agents.get(agentId);
    if (!entry) {
      return this.errorResult(
        'AGENT_NOT_FOUND',
        `NemoClaw agent "${agentId}" is not registered. Call registerSandboxAgent() first.`,
        false
      );
    }

    const startTime = Date.now();
    const { config } = entry;
    const exec = this.getExecutor(config.executor);

    try {
      // Step 1: Ensure sandbox exists and is running
      if (!entry.sandboxReady) {
        const status = await this.createSandbox(
          config.sandboxName,
          config.sandboxImage ?? this.defaultImage,
          config.forwardPorts
        );

        if (status.state !== 'running') {
          return this.errorResult(
            'SANDBOX_NOT_READY',
            `Sandbox "${config.sandboxName}" is in state "${status.state}"`,
            true
          );
        }

        // Apply network policies if configured
        if (config.policies && config.policies.length > 0) {
          await this.applyPolicies(config.policies);
        }

        entry.sandboxReady = true;
      }

      // Step 2: Build and execute command inside sandbox
      const command = buildSandboxCommand(payload, config);

      // Merge blackboard snapshot into env if present
      const env: Record<string, string> = { ...config.env };
      if (payload.blackboardSnapshot && Object.keys(payload.blackboardSnapshot).length > 0) {
        env['NETWORK_AI_CONTEXT'] = JSON.stringify(payload.blackboardSnapshot);
      }

      // Include handoff info if present
      if (payload.handoff) {
        env['NETWORK_AI_HANDOFF'] = JSON.stringify({
          handoffId: payload.handoff.handoffId,
          sourceAgent: payload.handoff.sourceAgent,
          taskType: payload.handoff.taskType,
          instruction: payload.handoff.instruction,
        });
      }

      const output = await exec(
        'sandbox',
        ['connect', config.sandboxName, '--', ...command.split(' ')],
        { env }
      );

      // Step 3: Parse output
      let data: unknown = output;
      try {
        data = JSON.parse(output);
      } catch {
        // Output is plain text — that's fine
      }

      return this.successResult(data, Date.now() - startTime);
    } catch (error) {
      return this.errorResult(
        'NEMOCLAW_ERROR',
        error instanceof Error ? error.message : 'NemoClaw agent execution failed',
        true,
        error
      );
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Get the executor function — agent-level override > adapter-level > default CLI.
   */
  private getExecutor(agentExecutor?: OpenShellExecutor): OpenShellExecutor {
    if (agentExecutor) return agentExecutor;
    if (this.executor) return this.executor;
    return defaultCliExecutor;
  }
}

// ---------------------------------------------------------------------------
// Default CLI executor — shells out to `openshell` binary
// ---------------------------------------------------------------------------

/**
 * Default executor that spawns `openshell` as a child process.
 * Used when no custom executor is provided.
 */
const defaultCliExecutor: OpenShellExecutor = async (
  subcommand: string,
  args: string[],
  options?: { timeout?: number; env?: Record<string, string> }
): Promise<string> => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  const fullArgs = [subcommand, ...args];
  const env = { ...process.env, ...options?.env } as NodeJS.ProcessEnv;

  // Remove internal transport keys
  if (env['__POLICY_YAML']) {
    delete env['__POLICY_YAML'];
  }

  const { stdout } = await execFileAsync('openshell', fullArgs, {
    env,
    timeout: options?.timeout ?? 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });

  return stdout;
};
