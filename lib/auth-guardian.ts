/**
 * Universal permission wall for multi-agent systems.
 *
 * Evaluates permission requests using a weighted formula of justification
 * quality (40%), agent trust level (30%), and risk score (30%).
 * Resource types, risk profiles, trust levels, and restrictions are all
 * configurable — works for coding, finance, DevOps, or any domain.
 *
 * @module AuthGuardian
 */

import { existsSync, readFileSync, writeFile, appendFile, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID, generateKeyPairSync, sign as ed25519Sign, verify as ed25519Verify, createHmac, KeyObject } from 'crypto';
import { InputSanitizer } from '../security';
import { ValidationError } from './errors';
import {
  CONFIG,
  DEFAULT_RESOURCE_PROFILES,
  DEFAULT_AGENT_TRUST,
} from './orchestrator-types';
import type {
  ActiveGrant,
  PermissionGrant,
  ResourceProfile,
  AgentTrustConfig,
} from './orchestrator-types';

/**
 * Universal permission wall for multi-agent systems.
 *
 * Evaluates permission requests using a weighted formula of justification
 * quality (40%), agent trust level (30%), and risk score (30%).
 * Resource types, risk profiles, trust levels, and restrictions are all
 * configurable — works for coding, finance, DevOps, or any domain.
 *
 * **Advisory tokens notice:** Grant tokens produced by `requestPermission()`
 * are **advisory scoring outputs only**. The caller-supplied `agentId` is not
 * cryptographically verified — any caller can claim any identity. Do **not**
 * treat these tokens as authenticated credentials for PAYMENTS, DATABASE, or
 * FILE_EXPORT operations without adding a separate identity-verification step
 * (e.g. a platform auth layer or human approval gate).
 *
 * @example
 * ```typescript
 * const guardian = new AuthGuardian({
 *   trustLevels: [{ agentId: 'analyst', trustLevel: 0.8 }],
 *   resourceProfiles: { CUSTOM_API: { baseRisk: 0.5, defaultRestrictions: ['audit_required'] } },
 * });
 *
 * const grant = await guardian.requestPermission(
 *   'analyst', 'CUSTOM_API', 'Need to fetch Q4 revenue data for report', 'read'
 * );
 * if (grant.granted) {
 *   // Use grant.grantToken to prove authorization
 * }
 * ```
 */
export class AuthGuardian {
  private activeGrants: Map<string, ActiveGrant> = new Map();
  private agentTrustLevels: Map<string, number> = new Map();
  private agentTrustConfigs: Map<string, AgentTrustConfig> = new Map();
  private resourceProfiles: Map<string, ResourceProfile> = new Map();
  private auditLog: Array<{ timestamp: string; action: string; details: unknown }> = [];
  private auditLogPath: string;
  private trustConfigPath: string;
  private readonly signingAlgorithm: 'hmac-sha256' | 'ed25519';
  private readonly hmacSecret: string;
  private readonly ed25519PrivateKey: KeyObject | null;
  private readonly ed25519PublicKey: KeyObject | null;
  /** Per-agent consecutive unsupported-claim counters (ClaimVerifier integration) */
  private _consecutiveClaims: Map<string, number> = new Map();

  constructor(options?: {
    trustLevels?: AgentTrustConfig[];
    resourceProfiles?: Record<string, ResourceProfile>;
    auditLogPath?: string;
    trustConfigPath?: string;
    /** Signing algorithm for grant tokens. Default: 'hmac-sha256'. */
    algorithm?: 'hmac-sha256' | 'ed25519';
    /** HMAC secret (only used when algorithm is 'hmac-sha256'). Auto-generated if omitted. */
    hmacSecret?: string;
  }) {
    this.auditLogPath = options?.auditLogPath ?? CONFIG.auditLogPath;
    this.trustConfigPath = options?.trustConfigPath ?? CONFIG.trustConfigPath;
    this.signingAlgorithm = options?.algorithm ?? 'hmac-sha256';

    if (this.signingAlgorithm === 'ed25519') {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      this.ed25519PrivateKey = privateKey;
      this.ed25519PublicKey = publicKey;
      this.hmacSecret = '';
    } else {
      this.ed25519PrivateKey = null;
      this.ed25519PublicKey = null;
      this.hmacSecret = options?.hmacSecret ?? randomUUID();
    }

    // Load resource profiles (file → user-provided → defaults)
    const fileProfiles = this.loadResourceProfilesFromDisk();
    const profiles = { ...DEFAULT_RESOURCE_PROFILES, ...fileProfiles, ...(options?.resourceProfiles ?? {}) };
    for (const [name, profile] of Object.entries(profiles)) {
      this.resourceProfiles.set(name, profile);
    }

    // Load trust levels (try disk first, then user-provided, then defaults)
    const trustConfigs = options?.trustLevels ?? this.loadTrustFromDisk() ?? DEFAULT_AGENT_TRUST;
    for (const config of trustConfigs) {
      this.agentTrustLevels.set(config.agentId, config.trustLevel);
      this.agentTrustConfigs.set(config.agentId, config);
    }

    // Load existing audit log from disk
    this.loadAuditFromDisk();
  }

  /**
   * Register a new resource type at runtime.
   * Makes the system extensible for any domain.
   */
  registerResourceType(name: string, profile: ResourceProfile): void {
    if (!name || typeof name !== 'string' || name.trim() === '') {
      throw new ValidationError('resource name must be a non-empty string');
    }
    if (!profile || typeof profile !== 'object' || typeof profile.baseRisk !== 'number') {
      throw new ValidationError('profile must be an object with a numeric baseRisk');
    }
    if (profile.baseRisk < 0 || profile.baseRisk > 1) {
      throw new ValidationError('profile.baseRisk must be between 0 and 1');
    }
    if (!Array.isArray(profile.defaultRestrictions)) {
      throw new ValidationError('profile.defaultRestrictions must be an array');
    }
    this.resourceProfiles.set(name, profile);
  }

  /**
   * Register or update an agent's trust configuration at runtime.
   */
  registerAgentTrust(config: AgentTrustConfig): void {
    if (!config || typeof config !== 'object') {
      throw new ValidationError('config must be an object');
    }
    if (!config.agentId || typeof config.agentId !== 'string' || config.agentId.trim() === '') {
      throw new ValidationError('config.agentId must be a non-empty string');
    }
    if (typeof config.trustLevel !== 'number' || config.trustLevel < 0 || config.trustLevel > 1) {
      throw new ValidationError('config.trustLevel must be a number between 0 and 1');
    }
    this.agentTrustLevels.set(config.agentId, config.trustLevel);
    this.agentTrustConfigs.set(config.agentId, config);
    this.persistTrustToDisk();
  }

  /**
   * Request permission to access a resource.
   * resourceType is now a free string -- validated against registered profiles.
   */
  async requestPermission(
    agentId: string,
    resourceType: string,
    justification: string,
    scope?: string
  ): Promise<PermissionGrant> {
    if (!agentId || typeof agentId !== 'string') {
      throw new ValidationError('agentId must be a non-empty string');
    }
    if (!resourceType || typeof resourceType !== 'string') {
      throw new ValidationError('resourceType must be a non-empty string');
    }
    if (!justification || typeof justification !== 'string') {
      throw new ValidationError('justification must be a non-empty string');
    }
    // Sanitize inputs
    let safeAgentId: string;
    let safeJustification: string;
    try {
      safeAgentId = InputSanitizer.sanitizeAgentId(agentId);
      safeJustification = InputSanitizer.sanitizeString(justification, 2000);
    } catch {
      safeAgentId = agentId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'unknown';
      safeJustification = justification.slice(0, 2000);
    }

    this.log('permission_request', { agentId: safeAgentId, resourceType, justification: safeJustification, scope });

    // Check if agent is allowed to access this resource type
    const agentConfig = this.agentTrustConfigs.get(safeAgentId);
    if (agentConfig && agentConfig.allowedResources && !agentConfig.allowedResources.includes('*')) {
      if (!agentConfig.allowedResources.includes(resourceType)) {
        this.log('permission_denied', { agentId: safeAgentId, resourceType, reason: 'resource_not_in_allowlist' });
        return {
          granted: false,
          grantToken: null,
          expiresAt: null,
          restrictions: [],
          reason: `Agent '${safeAgentId}' is not authorized to access '${resourceType}'. Allowed: ${agentConfig.allowedResources.join(', ')}`,
        };
      }
    }

    // Evaluate the permission request
    const evaluation = this.evaluateRequest(safeAgentId, resourceType, safeJustification, scope);

    if (!evaluation.approved) {
      this.log('permission_denied', { agentId: safeAgentId, resourceType, reason: evaluation.reason });
      return {
        granted: false,
        grantToken: null,
        expiresAt: null,
        restrictions: [],
        reason: evaluation.reason,
      };
    }

    // Generate grant token
    const grantToken = this.generateGrantToken();
    const expiresAt = new Date(Date.now() + CONFIG.grantTokenTTL).toISOString();

    const grant: ActiveGrant = {
      grantToken,
      resourceType,
      agentId: safeAgentId,
      expiresAt,
      restrictions: evaluation.restrictions,
      scope,
    };

    this.activeGrants.set(grantToken, grant);
    this.log('permission_granted', { grantToken, agentId: safeAgentId, resourceType, expiresAt, restrictions: evaluation.restrictions });

    return {
      granted: true,
      grantToken,
      expiresAt,
      restrictions: evaluation.restrictions,
    };
  }

  /**
   * Validate a grant token and return `true` if it is active and not expired.
   *
   * @param token - The grant token to validate
   * @returns `true` if the token is valid, `false` otherwise
   */
  validateToken(token: string): boolean {
    if (!token || typeof token !== 'string') return false;
    const grant = this.activeGrants.get(token);
    if (!grant) return false;

    if (new Date(grant.expiresAt) < new Date()) {
      this.activeGrants.delete(token);
      return false;
    }

    return true;
  }

  /**
   * Validate a token and return the full grant object (including restrictions
   * and scope) for point-of-use enforcement.
   *
   * @param token - The grant token to validate
   * @returns The grant details, or `null` if invalid/expired
   */
  validateTokenWithGrant(token: string): ActiveGrant | null {
    if (!token || typeof token !== 'string') return null;
    const grant = this.activeGrants.get(token);
    if (!grant) return null;

    if (new Date(grant.expiresAt) < new Date()) {
      this.activeGrants.delete(token);
      return null;
    }

    return grant;
  }

  /**
   * Enforce restrictions on an operation. Returns an error string if
   * the operation violates any restriction, or `null` if all restrictions pass.
   *
   * @param grantToken  - The grant token authorizing the operation
   * @param operation   - Description of the operation to check against restrictions
   * @returns Error message string if a restriction is violated, or `null` if allowed
   */
  enforceRestrictions(grantToken: string, operation: {
    type?: string;       // 'read' | 'write' | 'delete' | 'execute'
    recordCount?: number;
    hasAttachments?: boolean;
    targetPath?: string;
    command?: string;
  }): string | null {
    if (!grantToken || typeof grantToken !== 'string') {
      return 'Invalid or expired grant token';
    }
    const grant = this.validateTokenWithGrant(grantToken);
    if (!grant) return 'Invalid or expired grant token';

    for (const restriction of grant.restrictions) {
      // Enforce read_only
      if (restriction === 'read_only' && operation.type && operation.type !== 'read') {
        return `Restriction 'read_only' violated: attempted '${operation.type}'`;
      }

      // Enforce max_records
      const maxRecordsMatch = restriction.match(/^max_records:(\d+)$/);
      if (maxRecordsMatch && operation.recordCount) {
        const max = parseInt(maxRecordsMatch[1], 10);
        if (operation.recordCount > max) {
          return `Restriction '${restriction}' violated: requested ${operation.recordCount} records`;
        }
      }

      // Enforce sandbox_only
      if (restriction === 'sandbox_only' && operation.targetPath) {
        if (/^\/|^[A-Z]:\\(?:Windows|Program)/i.test(operation.targetPath)) {
          return `Restriction 'sandbox_only' violated: path '${operation.targetPath}' is outside sandbox`;
        }
      }

      // Enforce no_sudo
      if (restriction === 'no_sudo' && operation.command) {
        if (/\bsudo\b/i.test(operation.command)) {
          return `Restriction 'no_sudo' violated: command contains sudo`;
        }
      }

      // Enforce workspace_only
      if (restriction === 'workspace_only' && operation.targetPath) {
        if (/\.\.[/\\]/.test(operation.targetPath)) {
          return `Restriction 'workspace_only' violated: path traversal detected`;
        }
      }

      // Enforce no_system_dirs
      if (restriction === 'no_system_dirs' && operation.targetPath) {
        if (/(?:\/etc|\/usr|\/var|\\Windows|\\System32)/i.test(operation.targetPath)) {
          return `Restriction 'no_system_dirs' violated: system directory access`;
        }
      }

      // Enforce no_attachments
      if (restriction === 'no_attachments' && operation.hasAttachments) {
        return `Restriction 'no_attachments' violated`;
      }
    }

    return null; // All restrictions passed
  }

  /**
   * Revoke a grant token, immediately invalidating it.
   * Silently no-ops if the token doesn't exist.
   *
   * @param token - The grant token to revoke
   */
  revokeToken(token: string): void {
    this.activeGrants.delete(token);
    this.log('permission_revoked', { token });
  }

  /**
   * Return the scoring breakdown for a hypothetical permission request without
   * issuing a token. Useful for `--why` diagnostics in the CLI.
   *
   * @param agentId - The agent requesting the permission
   * @param resourceType - The resource type being requested
   * @param justification - The justification text
   * @param scope - Optional scope string
   * @returns Scoring breakdown and approval verdict
   */
  scoreRequest(
    agentId: string,
    resourceType: string,
    justification: string,
    scope?: string
  ): {
    justificationScore: number;
    trustScore: number;
    riskScore: number;
    weightedScore: number;
    approved: boolean;
    reason?: string;
  } {
    const justificationScore = this.scoreJustification(justification, resourceType);
    const trustScore = this.agentTrustLevels.get(agentId) ?? 0.5;
    const riskScore = this.assessRisk(resourceType, scope);
    const weightedScore = (justificationScore * 0.4) + (trustScore * 0.3) + ((1 - riskScore) * 0.3);
    let approved = weightedScore >= 0.5;
    let reason: string | undefined;

    if (justificationScore < 0.3) {
      approved = false;
      reason = 'Justification is insufficient. Please provide specific task context.';
    } else if (trustScore < 0.4) {
      approved = false;
      reason = 'Agent trust level is below threshold. Escalate to human operator.';
    } else if (riskScore > 0.8) {
      approved = false;
      reason = 'Risk assessment exceeds acceptable threshold. Narrow the requested scope.';
    } else if (!approved) {
      reason = 'Combined evaluation score below threshold.';
    }

    return { justificationScore, trustScore, riskScore, weightedScore, approved, reason };
  }

  private evaluateRequest(
    agentId: string,
    resourceType: string,
    justification: string,
    scope?: string
  ): { approved: boolean; reason?: string; restrictions: string[] } {
    // 1. Justification Quality (40% weight) -- now includes resource-relevance
    const justificationScore = this.scoreJustification(justification, resourceType);
    if (justificationScore < 0.3) {
      return {
        approved: false,
        reason: 'Justification is insufficient. Please provide specific task context.',
        restrictions: [],
      };
    }

    // 2. Agent Trust Level (30% weight)
    const trustLevel = this.agentTrustLevels.get(agentId) ?? 0.5;
    if (trustLevel < 0.4) {
      return {
        approved: false,
        reason: 'Agent trust level is below threshold. Escalate to human operator.',
        restrictions: [],
      };
    }

    // 3. Risk Assessment (30% weight)
    const riskScore = this.assessRisk(resourceType, scope);
    if (riskScore > 0.8) {
      return {
        approved: false,
        reason: 'Risk assessment exceeds acceptable threshold. Narrow the requested scope.',
        restrictions: [],
      };
    }

    // Get restrictions from resource profile (data-driven, not hardcoded)
    const profile = this.resourceProfiles.get(resourceType);
    const restrictions = profile
      ? [...profile.defaultRestrictions]
      : ['audit_required']; // Unknown resources get audited by default

    // Calculate weighted approval
    const weightedScore = (justificationScore * 0.4) + (trustLevel * 0.3) + ((1 - riskScore) * 0.3);
    const approved = weightedScore >= 0.5;

    return {
      approved,
      reason: approved ? undefined : 'Combined evaluation score below threshold.',
      restrictions,
    };
  }

  /**
   * Improved justification scoring with resource-relevance checking.
   * Prevents trivial gaming by verifying the justification mentions
   * concepts relevant to the requested resource.
   */
  private scoreJustification(justification: string, resourceType?: string): number {
    let score = 0;

    // Length scoring
    if (justification.length > 20) score += 0.15;
    if (justification.length > 50) score += 0.15;

    // Intent keywords
    if (/task|purpose|need|require|generate|analyze|process|build|deploy|test|review/i.test(justification)) score += 0.15;

    // Specificity keywords
    if (/specific|particular|exact|for\s+the|in\s+order\s+to|because|so\s+that/i.test(justification)) score += 0.15;

    // Penalty for vague/test phrasing
    if (/^test$|^debug$|^try$|^just\s+testing/i.test(justification.trim())) score -= 0.3;

    // Resource-relevance check: does the justification mention anything related
    // to the requested resource? (+0.2 bonus for relevant context)
    if (resourceType) {
      const relevancePatterns: Record<string, RegExp> = {
        SAP_API: /sap|erp|invoice|procurement|purchase|material|vendor/i,
        FINANCIAL_API: /financ|revenue|budget|accounting|payment|ledger|balance/i,
        DATA_EXPORT: /export|report|csv|download|extract|migrate/i,
        FILE_SYSTEM: /file|read|write|save|load|path|directory|workspace/i,
        SHELL_EXEC: /command|script|compile|build|run|execute|terminal/i,
        GIT: /git|commit|branch|merge|pull|push|repository|diff/i,
        PACKAGE_MANAGER: /package|install|dependency|npm|pip|cargo|module/i,
        BUILD_TOOL: /build|compile|webpack|tsc|make|gradle|cargo/i,
        DOCKER: /container|docker|image|deploy|service|compose/i,
        CLOUD_DEPLOY: /deploy|cloud|staging|production|release|infrastructure/i,
        DATABASE: /database|query|sql|table|record|schema|migration/i,
        EXTERNAL_SERVICE: /api|service|endpoint|webhook|request|fetch/i,
        EMAIL: /email|mail|send|notification|alert|message/i,
        WEBHOOK: /webhook|callback|notification|event|dispatch/i,
      };

      const pattern = relevancePatterns[resourceType];
      if (pattern && pattern.test(justification)) {
        score += 0.2;
      } else if (pattern && !pattern.test(justification)) {
        // Justification doesn't mention anything relevant -- small penalty
        score -= 0.1;
      }
    }

    // Bonus for mentioning a task/ticket ID
    if (/(?:task|ticket|issue|jira|pr|bug)[_\-#]?\s*\d+/i.test(justification)) score += 0.1;

    return Math.max(0, Math.min(score, 1));
  }

  private assessRisk(resourceType: string, scope?: string): number {
    // Look up base risk from registered profile (not hardcoded)
    const profile = this.resourceProfiles.get(resourceType);
    let risk = profile?.baseRisk ?? 0.5; // Unknown resources get medium risk

    // Broad scopes increase risk
    if (!scope || scope === '*' || scope === 'all') {
      risk += 0.2;
    }

    // Write/delete operations increase risk
    if (scope && /write|delete|update|modify|execute|deploy/i.test(scope)) {
      risk += 0.2;
    }

    return Math.min(risk, 1);
  }

  private generateGrantToken(): string {
    const id = randomUUID().replace(/-/g, '');
    const payload = `grant_${id}`;
    if (this.signingAlgorithm === 'ed25519' && this.ed25519PrivateKey) {
      const sig = ed25519Sign(null, Buffer.from(payload), this.ed25519PrivateKey).toString('base64url');
      return `${payload}.${sig}`;
    }
    // HMAC: append signature so tokens are tamper-evident
    const sig = createHmac('sha256', this.hmacSecret).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  // --------------------------------------------------------------------------
  // Claim-verifier trust decay integration
  // --------------------------------------------------------------------------

  /**
   * Record one unsupported-claim violation for an agent.
   * After `threshold` consecutive violations the agent's trust is decremented
   * by `decayStep`. Below 0.4 trust, requestPermission() will deny high-risk
   * resources and the agent is effectively forced into ApprovalGate territory.
   *
   * Call this from ClaimVerifier after each UNSUPPORTED_CLAIM violation.
   * The consecutive counter resets when a corroborated turn is recorded.
   *
   * @param agentId    - The lying/hallucinating agent
   * @param threshold  - Consecutive misses before decay (default: 3)
   * @param decayStep  - Trust reduction per threshold breach (default: 0.1)
   */
  recordClaimViolation(agentId: string, threshold = 3, decayStep = 0.1): void {
    const count = (this._consecutiveClaims.get(agentId) ?? 0) + 1;
    this._consecutiveClaims.set(agentId, count);

    if (count >= threshold) {
      const current = this.agentTrustLevels.get(agentId) ?? 0.5;
      const next = Math.max(0, +(current - decayStep).toFixed(4));
      this.registerAgentTrust({ agentId, trustLevel: next });
      this.log('trust_decay', { agentId, previousTrust: current, newTrust: next, consecutiveViolations: count });
      this._consecutiveClaims.set(agentId, 0); // reset after decay fires
    }
  }

  /**
   * Reset the consecutive unsupported-claim counter for an agent.
   * Call this when the agent produces a fully corroborated turn.
   */
  resetClaimViolations(agentId: string): void {
    this._consecutiveClaims.set(agentId, 0);
  }

  /** Current consecutive unsupported-claim count for an agent. */
  getClaimViolationCount(agentId: string): number {
    return this._consecutiveClaims.get(agentId) ?? 0;
  }

  /**
   * Get the current trust level for an agent (0–1).
   * Returns 0.5 (the default) for unknown agents.
   */
  getTrustLevel(agentId: string): number {
    return this.agentTrustLevels.get(agentId) ?? 0.5;
  }

  /**
   * Verify a grant token's cryptographic signature.
   * For Ed25519 tokens, this can be done by any party holding the public key.
   * For HMAC tokens, only the issuing AuthGuardian can verify.
   *
   * @param token - The grant token to verify
   * @returns `true` if the signature is valid
   */
  verifyTokenSignature(token: string): boolean {
    const dotIndex = token.lastIndexOf('.');
    if (dotIndex === -1) return false;
    const payload = token.slice(0, dotIndex);
    const sig = token.slice(dotIndex + 1);
    if (this.signingAlgorithm === 'ed25519' && this.ed25519PublicKey) {
      try {
        return ed25519Verify(null, Buffer.from(payload), this.ed25519PublicKey, Buffer.from(sig, 'base64url'));
      } catch {
        return false;
      }
    }
    const expected = createHmac('sha256', this.hmacSecret).update(payload).digest('base64url');
    // Constant-time comparison
    if (expected.length !== sig.length) return false;
    let result = 0;
    for (let i = 0; i < expected.length; i++) {
      result |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    }
    return result === 0;
  }

  /**
   * Get the signing algorithm used by this AuthGuardian instance.
   */
  getSigningAlgorithm(): 'hmac-sha256' | 'ed25519' {
    return this.signingAlgorithm;
  }

  /**
   * Export the Ed25519 public key in PEM format for third-party verification.
   * Returns `null` if the instance uses HMAC signing.
   */
  exportPublicKey(): string | null {
    if (!this.ed25519PublicKey) return null;
    return this.ed25519PublicKey.export({ type: 'spki', format: 'pem' }) as string;
  }

  private log(action: string, details: unknown): void {
    const entry = {
      timestamp: new Date().toISOString(),
      action,
      details,
    };
    this.auditLog.push(entry);

    // Persist to disk (non-blocking — in-memory array is the source of truth)
    try {
      const dir = join('.', 'data');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      appendFile(this.auditLogPath, JSON.stringify(entry) + '\n', () => {});
    } catch {
      // Non-fatal -- log is also in memory
    }
  }

  /**
   * Get all active (non-expired) permission grants.
   * Automatically cleans up expired grants before returning.
   */
  getActiveGrants(): ActiveGrant[] {
    // Clean expired grants
    const now = new Date();
    for (const [token, grant] of this.activeGrants.entries()) {
      if (new Date(grant.expiresAt) < now) {
        this.activeGrants.delete(token);
      }
    }
    return Array.from(this.activeGrants.values());
  }

  /**
   * Get the full audit log of permission decisions.
   * Returns a defensive copy.
   */
  getAuditLog(): typeof this.auditLog {
    return [...this.auditLog];
  }

  /**
   * Get all registered resource profiles.
   */
  getResourceProfiles(): Record<string, ResourceProfile> {
    return Object.fromEntries(this.resourceProfiles);
  }

  /**
   * Get the allowed namespaces for an agent (used by blackboard scoping).
   */
  getAgentNamespaces(agentId: string): string[] {
    if (!agentId || typeof agentId !== 'string') return ['task:'];
    const config = this.agentTrustConfigs.get(agentId);
    return config?.allowedNamespaces ?? ['task:'];
  }

  // ---- Persistence helpers ----

  /** Path for the resource profiles policy file. */
  private get resourceProfilesPath(): string {
    return join('.', 'data', 'resource-profiles.json');
  }

  /**
   * Load resource profiles from `data/resource-profiles.json` if it exists.
   * Expected format: `{ "PROFILE_NAME": { baseRisk, defaultRestrictions, description? } }`
   */
  private loadResourceProfilesFromDisk(): Record<string, ResourceProfile> | null {
    try {
      if (existsSync(this.resourceProfilesPath)) {
        const raw = readFileSync(this.resourceProfilesPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, ResourceProfile>;
        }
      }
    } catch { /* ignore — fall back to defaults */ }
    return null;
  }

  /**
   * Persist the current resource profiles to `data/resource-profiles.json`.
   * Useful after calling registerResourceType() at runtime.
   */
  persistResourceProfiles(): void {
    try {
      const dir = join('.', 'data');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const profiles: Record<string, ResourceProfile> = {};
      for (const [name, profile] of this.resourceProfiles) {
        profiles[name] = profile;
      }
      writeFile(this.resourceProfilesPath, JSON.stringify(profiles, null, 2), () => {});
    } catch {
      // Non-fatal
    }
  }

  private loadTrustFromDisk(): AgentTrustConfig[] | null {
    try {
      if (existsSync(this.trustConfigPath)) {
        const raw = readFileSync(this.trustConfigPath, 'utf-8');
        return JSON.parse(raw);
      }
    } catch { /* ignore */ }
    return null;
  }

  private persistTrustToDisk(): void {
    try {
      const dir = join('.', 'data');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const configs = Array.from(this.agentTrustConfigs.values());
      writeFile(this.trustConfigPath, JSON.stringify(configs, null, 2), () => {});
    } catch {
      // Non-fatal
    }
  }

  private loadAuditFromDisk(): void {
    try {
      if (existsSync(this.auditLogPath)) {
        const raw = readFileSync(this.auditLogPath, 'utf-8');
        const lines = raw.trim().split('\n').filter(l => l);
        for (const line of lines) {
          try {
            this.auditLog.push(JSON.parse(line));
          } catch { /* skip malformed */ }
        }
      }
    } catch { /* ignore */ }
  }
}
