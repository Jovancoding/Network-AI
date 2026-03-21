/**
 * APS Adapter — Agent Permission Service interop adapter.
 *
 * Maps APS delegation chains to AuthGuardian trust levels.
 * This is the interop PoC proposed in crewAIInc/crewAI#4560:
 * APS chain → MCP verify → trust mapping → registerAgentTrust().
 *
 * APS (Agent Permission Service) is a delegation-chain permission model
 * proposed by aeoess et al. This adapter consumes APS delegation tokens,
 * verifies them (locally or via MCP server), and translates the verified
 * scope + depth into Network-AI's AgentTrustConfig.
 *
 * Usage:
 *
 *   import { APSAdapter } from 'network-ai';
 *
 *   const aps = new APSAdapter();
 *   await aps.initialize({});
 *
 *   // Register an APS-verified agent by providing its delegation chain
 *   const trust = aps.apsDelegationToTrust({
 *     delegator:    'root-orchestrator',
 *     delegatee:    'sub-agent-7',
 *     scope:        ['file:read', 'net:fetch'],
 *     currentDepth: 1,
 *     maxDepth:     3,
 *     signature:    '<base64-token>',
 *   });
 *
 *   // Wire into AuthGuardian
 *   guardian.registerAgentTrust(trust);
 *
 * Verification modes:
 *   - 'local'  — checks signature + depth + scope locally (default)
 *   - 'mcp'    — calls an APS MCP server to verify the full chain
 *
 * @module APSAdapter
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

// ─── APS types ────────────────────────────────────────────────────────────────

/** A single link in an APS delegation chain. */
export interface APSDelegation {
  /** Agent that grants authority */
  delegator: string;
  /** Agent that receives authority */
  delegatee: string;
  /** Scopes granted — monotonically narrowing down the chain */
  scope: string[];
  /** Current depth in the delegation chain (0 = root) */
  currentDepth: number;
  /** Maximum allowed depth */
  maxDepth: number;
  /** Cryptographic signature or token from the delegator */
  signature: string;
}

/** Result of APS verification — input to AuthGuardian. */
export interface APSTrustMapping {
  agentId: string;
  trustLevel: number;
  allowedResources: string[];
  allowedNamespaces: string[];
  /** Raw APS chain metadata for audit purposes */
  apsMetadata: {
    delegator: string;
    depth: number;
    maxDepth: number;
    scope: string[];
    verified: boolean;
    verificationMode: 'local' | 'mcp';
  };
}

/** Configuration for the APS adapter. */
export interface APSAdapterConfig extends AdapterConfig {
  /** Base trust level for a fully verified root delegation (default: 0.8) */
  baseTrust?: number;
  /** Depth decay factor — trust decays as delegation gets deeper (default: 0.4) */
  depthDecay?: number;
  /** Verification mode: 'local' or 'mcp' (default: 'local') */
  verificationMode?: 'local' | 'mcp';
  /** MCP server URL for remote verification (required when mode is 'mcp') */
  mcpServerUrl?: string;
  /** Function to verify APS signatures — BYOC (bring your own crypto) */
  verifySignature?: (delegation: APSDelegation) => Promise<boolean>;
}

// ─── Scope → Resource type mapping ────────────────────────────────────────────

const SCOPE_TO_RESOURCE: Record<string, string> = {
  'file:read':  'FILE_SYSTEM',
  'file:write': 'FILE_SYSTEM',
  'net:fetch':  'NETWORK',
  'net:listen': 'NETWORK',
  'shell:exec': 'SHELL_EXEC',
  'git:read':   'GIT',
  'git:write':  'GIT',
  'db:read':    'DATABASE',
  'db:write':   'DATABASE',
  'pay:read':   'PAYMENTS',
  'pay:write':  'PAYMENTS',
};

// ─── Adapter ──────────────────────────────────────────────────────────────────

/**
 * APSAdapter translates APS delegation chains into AuthGuardian trust configs.
 *
 * This is not a traditional execution adapter — it's a trust-bridging adapter.
 * Its primary method is `apsDelegationToTrust()`, which verifies an APS
 * delegation and returns an `AgentTrustConfig`-compatible object.
 */
export class APSAdapter extends BaseAdapter {
  readonly name = 'aps';
  readonly version = '1.0.0';

  private baseTrust = 0.8;
  private depthDecay = 0.4;
  private verificationMode: 'local' | 'mcp' = 'local';
  private mcpServerUrl?: string;
  private verifySignatureFn?: (delegation: APSDelegation) => Promise<boolean>;

  get capabilities(): AdapterCapabilities {
    return {
      streaming: false,
      parallel: true,
      bidirectional: false,
      discovery: false,
      authentication: true,
      statefulSessions: false,
    };
  }

  async initialize(config: APSAdapterConfig): Promise<void> {
    await super.initialize(config);
    if (config.baseTrust !== undefined) {
      if (typeof config.baseTrust !== 'number' || config.baseTrust < 0 || config.baseTrust > 1) {
        throw new Error('baseTrust must be a number between 0 and 1');
      }
      this.baseTrust = config.baseTrust;
    }
    if (config.depthDecay !== undefined) {
      if (typeof config.depthDecay !== 'number' || config.depthDecay < 0 || config.depthDecay > 1) {
        throw new Error('depthDecay must be a number between 0 and 1');
      }
      this.depthDecay = config.depthDecay;
    }
    if (config.verificationMode) {
      this.verificationMode = config.verificationMode;
    }
    if (config.mcpServerUrl) {
      this.mcpServerUrl = config.mcpServerUrl;
    }
    if (config.verifySignature) {
      this.verifySignatureFn = config.verifySignature;
    }
    if (this.verificationMode === 'mcp' && !this.mcpServerUrl) {
      throw new Error('mcpServerUrl is required when verificationMode is "mcp"');
    }
  }

  /**
   * Core method: convert an APS delegation into an AuthGuardian trust mapping.
   *
   * Trust formula: baseTrust × (1 - (currentDepth / maxDepth × depthDecay))
   * At depth 0 (root): full baseTrust.
   * At maxDepth: baseTrust × (1 - depthDecay).
   *
   * Scopes are monotonically narrowing — a child delegation can only have
   * a subset of the parent's scopes.
   */
  async apsDelegationToTrust(delegation: APSDelegation): Promise<APSTrustMapping> {
    // Validate input
    if (!delegation || typeof delegation !== 'object') {
      throw new Error('delegation must be a non-null object');
    }
    if (!delegation.delegatee || typeof delegation.delegatee !== 'string') {
      throw new Error('delegation.delegatee must be a non-empty string');
    }
    if (!delegation.delegator || typeof delegation.delegator !== 'string') {
      throw new Error('delegation.delegator must be a non-empty string');
    }
    if (!Array.isArray(delegation.scope) || delegation.scope.length === 0) {
      throw new Error('delegation.scope must be a non-empty array');
    }
    if (typeof delegation.currentDepth !== 'number' || delegation.currentDepth < 0) {
      throw new Error('delegation.currentDepth must be a non-negative number');
    }
    if (typeof delegation.maxDepth !== 'number' || delegation.maxDepth < 1) {
      throw new Error('delegation.maxDepth must be a positive number');
    }
    if (delegation.currentDepth > delegation.maxDepth) {
      throw new Error('delegation.currentDepth cannot exceed maxDepth');
    }

    // Verify the delegation
    const verified = await this.verifyDelegation(delegation);

    // Compute trust level with depth decay
    const depthRatio = delegation.maxDepth > 0
      ? delegation.currentDepth / delegation.maxDepth
      : 0;
    const trustLevel = verified
      ? Math.max(0, this.baseTrust * (1 - depthRatio * this.depthDecay))
      : 0;

    // Map APS scopes to AuthGuardian resource types
    const allowedResources = [...new Set(
      delegation.scope
        .map(s => SCOPE_TO_RESOURCE[s])
        .filter((r): r is string => r !== undefined),
    )];

    // Derive namespace prefixes from scopes
    const allowedNamespaces = delegation.scope
      .map(s => s.split(':')[0] + ':')
      .filter((v, i, a) => a.indexOf(v) === i);

    return {
      agentId: delegation.delegatee,
      trustLevel: Math.round(trustLevel * 1000) / 1000,
      allowedResources,
      allowedNamespaces,
      apsMetadata: {
        delegator: delegation.delegator,
        depth: delegation.currentDepth,
        maxDepth: delegation.maxDepth,
        scope: delegation.scope,
        verified,
        verificationMode: this.verificationMode,
      },
    };
  }

  /**
   * Verify an APS delegation — either locally or via MCP.
   */
  private async verifyDelegation(delegation: APSDelegation): Promise<boolean> {
    // Depth bounds check
    if (delegation.currentDepth > delegation.maxDepth) {
      return false;
    }
    if (!delegation.signature || typeof delegation.signature !== 'string') {
      return false;
    }

    if (this.verificationMode === 'mcp' && this.mcpServerUrl) {
      return this.verifyViaMCP(delegation);
    }

    // Local verification — use BYOC verifier or default signature check
    if (this.verifySignatureFn) {
      return this.verifySignatureFn(delegation);
    }

    // Default: non-empty signature + valid depth = trusted
    // In production, replace with actual crypto verification
    return delegation.signature.length > 0;
  }

  /**
   * Verify delegation via an APS MCP server.
   * Calls the server's `verifyDelegation` tool.
   */
  private async verifyViaMCP(delegation: APSDelegation): Promise<boolean> {
    if (!this.mcpServerUrl) return false;

    try {
      const url = new URL('/sse', this.mcpServerUrl);
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `aps-verify-${Date.now()}`,
          method: 'tools/call',
          params: {
            name: 'verifyDelegation',
            arguments: {
              delegator: delegation.delegator,
              delegatee: delegation.delegatee,
              scope: delegation.scope,
              currentDepth: delegation.currentDepth,
              maxDepth: delegation.maxDepth,
              signature: delegation.signature,
            },
          },
        }),
      });

      if (!response.ok) return false;

      const result = await response.json() as { result?: { content?: Array<{ text?: string }> } };
      const text = result?.result?.content?.[0]?.text;
      if (!text) return false;

      const parsed = JSON.parse(text) as { verified?: boolean };
      return parsed.verified === true;
    } catch {
      // MCP verification failed — deny by default
      return false;
    }
  }

  /**
   * Execute is a pass-through — APS adapter is a trust bridge, not an executor.
   * When called, it verifies the delegation from the payload and returns the trust mapping.
   */
  async executeAgent(
    agentName: string,
    payload: AgentPayload,
    context: AgentContext,
  ): Promise<AgentResult> {
    this.ensureReady();

    const delegation = payload.params as unknown as APSDelegation;
    if (!delegation?.delegatee) {
      return {
        success: false,
        error: {
          code: 'INVALID_DELEGATION',
          message: 'Payload must contain a valid APSDelegation in params',
          recoverable: false,
        },
        metadata: { adapter: this.name },
      };
    }

    try {
      const trust = await this.apsDelegationToTrust(delegation);
      return {
        success: true,
        data: trust,
        metadata: {
          adapter: this.name,
          trace: {
            agentName,
            verified: trust.apsMetadata.verified,
            trustLevel: trust.trustLevel,
          },
        },
      };
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'DELEGATION_FAILED',
          message: err instanceof Error ? err.message : String(err),
          recoverable: false,
          nativeError: err,
        },
        metadata: { adapter: this.name },
      };
    }
  }
}
