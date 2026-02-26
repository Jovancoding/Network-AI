/**
 * SwarmOrchestrator - Multi-Agent Swarm Orchestration Skill
 * 
 * This module implements the core logic for agent-to-agent communication,
 * task decomposition, permission management, and shared blackboard coordination.
 * 
 * @module SwarmOrchestrator
 * @version 3.1.0
 * @license MIT
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { AdapterRegistry } from './adapters/adapter-registry';
import { InputSanitizer, SecureSwarmGateway } from './security';
import type { ConflictResolutionStrategy, AgentPriority, LockedBlackboardOptions } from './lib/locked-blackboard';
import { FileBackend } from './lib/blackboard-backend';
import type { BlackboardBackend } from './lib/blackboard-backend';
import { ConsistentBackend } from './lib/consistency';
import type { ConsistencyLevel, FlushableBackend } from './lib/consistency';
import { QualityGateAgent } from './lib/blackboard-validator';
import { Logger } from './lib/logger';
import {
  IdentityVerificationError,
  NamespaceViolationError,
  ValidationError,
  ParallelLimitError,
  TimeoutError as NetworkAITimeoutError,
} from './lib/errors';
import type { ValidationResult, QualityGateResult, ValidationConfig, AIReviewCallback, CustomValidationRule } from './lib/blackboard-validator';
import type { IAgentAdapter, AgentPayload, AgentContext, AgentResult, AdapterConfig } from './types/agent-adapter';

const log = Logger.create('SwarmOrchestrator');

// Backward-compatible re-exports: OpenClaw types still work
// but are now optional -- the system works without openclaw-core
type OpenClawSkill = {
  name: string;
  version: string;
  execute(action: string, params: Record<string, unknown>, context: SkillContext): Promise<SkillResult>;
};

/**
 * Execution context passed to every skill invocation.
 * Identifies the calling agent and associates the call with a task/session.
 */
interface SkillContext {
  /** The agent initiating the request */
  agentId: string;
  /** Unique task identifier (optional) */
  taskId?: string;
  /** Session identifier for multi-turn interactions */
  sessionId?: string;
  /** Arbitrary metadata from the host system */
  metadata?: Record<string, unknown>;
}

/**
 * Unified result shape returned by every skill action.
 * Includes structured error information with recovery hints.
 */
interface SkillResult {
  /** Whether the action completed successfully */
  success: boolean;
  /** Result data (shape varies by action) */
  data?: unknown;
  /** Structured error when `success` is false */
  error?: {
    /** Machine-readable error code (e.g., `'AUTH_DENIED'`, `'GATEWAY_DENIED'`) */
    code: string;
    /** Human-readable error description */
    message: string;
    /** Whether the caller can retry or adjust and succeed */
    recoverable: boolean;
    /** Suggested remediation step */
    suggestedAction?: string;
    /** Trace metadata for debugging */
    trace?: Record<string, unknown>;
  };
}

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * A task to be delegated to an agent.
 *
 * @example
 * ```typescript
 * const payload: TaskPayload = {
 *   instruction: 'Analyze Q4 revenue trends',
 *   context: { department: 'finance' },
 *   constraints: ['read_only', 'no_pii'],
 *   expectedOutput: 'JSON summary with top-line metrics',
 * };
 * ```
 */
interface TaskPayload {
  /** Natural-language instruction for the agent */
  instruction: string;
  /** Additional context data relevant to the task */
  context?: Record<string, unknown>;
  /** Restrictions or guardrails the agent must respect */
  constraints?: string[];
  /** Description of the expected output format */
  expectedOutput?: string;
}

/**
 * Internal message structure for agent-to-agent task handoffs.
 * The orchestrator creates these when delegating work between agents.
 */
interface HandoffMessage {
  /** Unique handoff identifier */
  handoffId: string;
  /** Agent initiating the handoff */
  sourceAgent: string;
  /** Agent receiving the task */
  targetAgent: string;
  /** How the target agent should process the task */
  taskType: 'delegate' | 'collaborate' | 'validate';
  /** The task to execute */
  payload: TaskPayload;
  /** Scheduling and priority metadata */
  metadata: {
    /** Priority level (0=low, 3=critical) */
    priority: number;
    /** Unix timestamp deadline */
    deadline: number;
    /** Parent task for sub-task tracking */
    parentTaskId: string | null;
  };
}

/**
 * Result of a permission request through the AuthGuardian.
 * Contains the grant token (if approved) and any restrictions.
 */
interface PermissionGrant {
  /** Whether permission was granted */
  granted: boolean;
  /** Opaque token to present when using the granted resource */
  grantToken: string | null;
  /** ISO 8601 expiration timestamp */
  expiresAt: string | null;
  /** Restrictions applied to this grant (e.g., `'read_only'`, `'max_records:100'`) */
  restrictions: string[];
  /** Human-readable denial reason (when `granted` is false) */
  reason?: string;
}

/** Full snapshot of the swarm's runtime state. */
interface SwarmState {
  /** ISO 8601 timestamp when the snapshot was taken */
  timestamp: string;
  /** All registered agents and their current status */
  activeAgents: AgentStatus[];
  /** Tasks currently pending or in progress */
  pendingTasks: TaskRecord[];
  /** Namespace-scoped blackboard entries visible to the querying agent */
  blackboardSnapshot: Record<string, BlackboardEntry>;
  /** Active permission grants */
  permissionGrants: ActiveGrant[];
}

/** Runtime status of a registered agent. */
interface AgentStatus {
  /** Unique agent identifier */
  agentId: string;
  /** Current operational state */
  status: 'available' | 'busy' | 'waiting_auth' | 'offline';
  /** ID of the task currently being executed, or null */
  currentTask: string | null;
  /** ISO 8601 timestamp of the last heartbeat */
  lastHeartbeat: string;
}

interface TaskRecord {
  taskId: string;
  agentId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  startedAt: string;
  description: string;
}

/** A single entry stored on the shared blackboard. */
interface BlackboardEntry {
  /** Entry key (namespace-prefixed, e.g., `'task:analyze'`) */
  key: string;
  /** Stored value (any serializable data) */
  value: unknown;
  /** Agent that wrote this entry */
  sourceAgent: string;
  /** ISO 8601 timestamp of the write */
  timestamp: string;
  /** Time-to-live in seconds, or null for no expiry */
  ttl: number | null;
}

/** An active permission grant held by an agent. */
interface ActiveGrant {
  /** Opaque grant token */
  grantToken: string;
  /** Resource type this grant covers (e.g., `'FILE_SYSTEM'`, `'DATABASE'`) */
  resourceType: string;
  /** Agent holding the grant */
  agentId: string;
  /** ISO 8601 expiration timestamp */
  expiresAt: string;
  /** Restrictions bound to this grant */
  restrictions: string[];
  /** Optional scope narrowing (e.g., `'read'`, `'staging_only'`) */
  scope?: string;
}

/**
 * Configurable resource profile -- makes the system domain-agnostic.
 * Users can define any resource type (coding, finance, devops, etc.)
 */
interface ResourceProfile {
  /** Base risk score 0-1 */
  baseRisk: number;
  /** Default restrictions applied when access is granted */
  defaultRestrictions: string[];
  /** Human-readable description */
  description?: string;
}

/**
 * Configuration for agent trust levels.
 * Pass your own agents with their trust scores.
 */
interface AgentTrustConfig {
  agentId: string;
  trustLevel: number;
  /** Namespace prefixes this agent can read from the blackboard */
  allowedNamespaces?: string[];
  /** Resource types this agent can request */
  allowedResources?: string[];
}

/**
 * Options for creating a named blackboard via `orchestrator.getBlackboard(name)`.
 * All fields are optional -- sensible defaults are applied automatically.
 */
export interface NamedBlackboardOptions {
  /**
   * Namespace prefixes the orchestrator agent is allowed to use on this board.
   * Defaults to `['*']` (full access). Pass e.g. `['analysis:', 'result:']` to
   * restrict the board to specific key prefixes.
   */
  allowedNamespaces?: string[];
  /**
   * Custom validation config applied to writes on this board.
   * Falls back to the orchestrator's global config when omitted.
   */
  validationConfig?: Partial<ValidationConfig>;
  /**
   * Pluggable storage backend for this board.
   *
   * - Omit (default): `FileBackend` — persisted to disk at `<workspacePath>/boards/<name>/`
   * - `new MemoryBackend()`: pure in-memory, no disk writes
   * - Custom class implementing `BlackboardBackend`: Redis, CRDT, cloud KV, etc.
   *
   * @example
   * ```typescript
   * // Ephemeral board (testing / short-lived tasks)
   * const board = orchestrator.getBlackboard('tmp', { backend: new MemoryBackend() });
   *
   * // Custom Redis backend
   * const board = orchestrator.getBlackboard('prod', { backend: new RedisBackend(client) });
   * ```
   */
  backend?: BlackboardBackend;
  /**
   * Consistency level applied to this board's backend.
   *
   * When provided, the backend is automatically wrapped in a `ConsistentBackend`
   * with the specified level. Omitting this (or passing `'eventual'`) leaves the
   * backend unwrapped for maximum performance.
   *
   * - `'eventual'` (default): no wrapping — highest throughput
   * - `'session'`: read-your-writes guarantee via a local session cache
   * - `'strong'`: use `board.writeAsync()` to await `backend.flush()` confirmation
   *
   * @example
   * ```typescript
   * const board = orchestrator.getBlackboard('live', {
   *   backend: new RedisBackend(client),
   *   consistency: 'strong',
   * });
   * ```
   */
  consistency?: ConsistencyLevel;
}

/** A single task within a parallel execution batch. */
interface ParallelTask {
  /** Agent type or adapter-prefixed ID to route the task to */
  agentType: string;
  /** The task payload to execute */
  taskPayload: TaskPayload;
}

/** Result of a parallel execution batch, including synthesis and metrics. */
interface ParallelExecutionResult {
  /** Combined result produced by the synthesis strategy */
  synthesizedResult: unknown;
  /** Per-agent results with timing */
  individualResults: Array<{
    agentType: string;
    success: boolean;
    result: unknown;
    /** Wall-clock execution time in milliseconds */
    executionTime: number;
  }>;
  /** Aggregate execution metrics */
  executionMetrics: {
    /** Total wall-clock time in milliseconds */
    totalTime: number;
    /** Fraction of tasks that succeeded (0-1) */
    successRate: number;
    /** Strategy used to combine results */
    synthesisStrategy: string;
  };
}

/**
 * Strategy for combining results from parallel agent executions.
 * - `'merge'`  — Combine all successful results into one object
 * - `'vote'`   — Pick the result with the highest confidence/size
 * - `'chain'`  — Use the final result in sequence
 * - `'first-success'` — Return the first successful result
 */
type SynthesisStrategy = 'merge' | 'vote' | 'chain' | 'first-success';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  blackboardPath: './swarm-blackboard.md',
  maxParallelAgents: Infinity,
  defaultTimeout: 30000,
  enableTracing: true,
  grantTokenTTL: 300000, // 5 minutes in milliseconds
  maxBlackboardValueSize: 1024 * 1024, // 1 MB max per entry
  auditLogPath: './data/audit_log.jsonl',
  trustConfigPath: './data/trust_levels.json',
};

// ============================================================================
// DEFAULT RESOURCE PROFILES -- Universal, domain-agnostic
// Users can override/extend these for any domain (coding, finance, devops, etc.)
// ============================================================================

const DEFAULT_RESOURCE_PROFILES: Record<string, ResourceProfile> = {
  // --- Financial / Enterprise ---
  SAP_API:          { baseRisk: 0.5, defaultRestrictions: ['read_only', 'max_records:100'], description: 'SAP enterprise API' },
  FINANCIAL_API:    { baseRisk: 0.7, defaultRestrictions: ['read_only', 'no_pii_fields', 'audit_required'], description: 'Financial data API' },
  DATA_EXPORT:      { baseRisk: 0.6, defaultRestrictions: ['anonymize_pii', 'local_only'], description: 'Data export operations' },
  // --- Coding / Development ---
  FILE_SYSTEM:      { baseRisk: 0.5, defaultRestrictions: ['workspace_only', 'no_system_dirs', 'max_file_size:10mb'], description: 'Read/write files in workspace' },
  SHELL_EXEC:       { baseRisk: 0.8, defaultRestrictions: ['sandbox_only', 'no_sudo', 'timeout:30s', 'audit_required'], description: 'Execute shell commands' },
  GIT:              { baseRisk: 0.4, defaultRestrictions: ['local_repo_only', 'no_force_push'], description: 'Git operations' },
  PACKAGE_MANAGER:  { baseRisk: 0.6, defaultRestrictions: ['audit_required', 'no_global_install', 'lockfile_required'], description: 'npm/pip/cargo package management' },
  BUILD_TOOL:       { baseRisk: 0.5, defaultRestrictions: ['workspace_only', 'timeout:120s'], description: 'Build and compilation' },
  // --- Infrastructure / DevOps ---
  DOCKER:           { baseRisk: 0.7, defaultRestrictions: ['no_privileged', 'no_host_network', 'audit_required'], description: 'Container operations' },
  CLOUD_DEPLOY:     { baseRisk: 0.9, defaultRestrictions: ['staging_only', 'approval_required', 'rollback_ready'], description: 'Cloud deployment' },
  DATABASE:         { baseRisk: 0.6, defaultRestrictions: ['read_only', 'max_records:1000', 'no_schema_changes'], description: 'Database access' },
  // --- Communication / External ---
  EXTERNAL_SERVICE: { baseRisk: 0.4, defaultRestrictions: ['rate_limit:10_per_minute'], description: 'External API calls' },
  EMAIL:            { baseRisk: 0.5, defaultRestrictions: ['rate_limit:5_per_minute', 'no_attachments'], description: 'Email sending' },
  WEBHOOK:          { baseRisk: 0.4, defaultRestrictions: ['allowed_domains_only', 'no_credentials'], description: 'Webhook dispatch' },
};

const DEFAULT_AGENT_TRUST: AgentTrustConfig[] = [
  { agentId: 'orchestrator', trustLevel: 0.9, allowedNamespaces: ['*'], allowedResources: ['*'] },
  { agentId: 'data_analyst', trustLevel: 0.8, allowedNamespaces: ['task:', 'analytics:', 'agent:'], allowedResources: ['SAP_API', 'DATABASE', 'DATA_EXPORT', 'EXTERNAL_SERVICE'] },
  { agentId: 'strategy_advisor', trustLevel: 0.7, allowedNamespaces: ['task:', 'strategy:'], allowedResources: ['EXTERNAL_SERVICE', 'DATA_EXPORT'] },
  { agentId: 'risk_assessor', trustLevel: 0.85, allowedNamespaces: ['task:', 'risk:', 'analytics:'], allowedResources: ['EXTERNAL_SERVICE', 'DATABASE'] },
  // Coding agents
  { agentId: 'code_writer', trustLevel: 0.75, allowedNamespaces: ['task:', 'code:', 'build:'], allowedResources: ['FILE_SYSTEM', 'GIT', 'BUILD_TOOL', 'PACKAGE_MANAGER'] },
  { agentId: 'code_reviewer', trustLevel: 0.8, allowedNamespaces: ['task:', 'code:', 'review:'], allowedResources: ['FILE_SYSTEM', 'GIT'] },
  { agentId: 'test_runner', trustLevel: 0.75, allowedNamespaces: ['task:', 'test:', 'build:'], allowedResources: ['FILE_SYSTEM', 'SHELL_EXEC', 'BUILD_TOOL'] },
  { agentId: 'devops_agent', trustLevel: 0.7, allowedNamespaces: ['task:', 'deploy:', 'infra:'], allowedResources: ['DOCKER', 'SHELL_EXEC', 'CLOUD_DEPLOY', 'GIT'] },
];

// ============================================================================
// BLACKBOARD MANAGEMENT -- Secured with LockedBlackboard, identity verification,
// namespace scoping, value validation, and input sanitization
// ============================================================================

/**
 * Namespace-scoped, identity-verified shared state for multi-agent coordination.
 *
 * Every write is identity-verified (agent token), namespace-checked,
 * size-validated, input-sanitized, and atomically persisted through
 * {@link LockedBlackboard}.
 *
 * @example
 * ```typescript
 * const bb = new SharedBlackboard('./workspace');
 * bb.registerAgent('analyst', 'secret-token', ['task:', 'analytics:']);
 * bb.write('task:revenue', { q4: 42_000 }, 'analyst', 3600, 'secret-token');
 * const entry = bb.read('task:revenue');
 * ```
 */
class SharedBlackboard {
  private backend: BlackboardBackend;
  private agentTokens: Map<string, string> = new Map(); // agentId -> verified token
  private agentNamespaces: Map<string, string[]> = new Map(); // agentId -> allowed prefixes

  constructor(backendOrPath: string | BlackboardBackend) {
    if (typeof backendOrPath === 'string') {
      if (!backendOrPath || backendOrPath.trim() === '') {
        throw new ValidationError('basePath must be a non-empty string');
      }
      this.backend = new FileBackend(backendOrPath);
    } else {
      if (!backendOrPath || typeof backendOrPath !== 'object') {
        throw new ValidationError('backend must be a BlackboardBackend instance');
      }
      this.backend = backendOrPath;
    }
  }

  /**
   * Register a verified agent identity. Only agents with registered tokens
   * can write to the blackboard. The orchestrator registers agents after
   * verifying their identity through the AuthGuardian.
   */
  registerAgent(agentId: string, verificationToken: string, allowedNamespaces: string[] = ['*']): void {
    if (!agentId || typeof agentId !== 'string' || agentId.trim() === '') {
      throw new ValidationError('agentId must be a non-empty string');
    }
    if (!verificationToken || typeof verificationToken !== 'string') {
      throw new ValidationError('verificationToken must be a non-empty string');
    }
    if (!Array.isArray(allowedNamespaces)) {
      throw new ValidationError('allowedNamespaces must be an array of strings');
    }
    this.agentTokens.set(agentId, verificationToken);
    this.agentNamespaces.set(agentId, allowedNamespaces);
  }

  /**
   * Check if an agent is allowed to access a key based on namespace rules.
   */
  private canAccessKey(agentId: string, key: string): boolean {
    const namespaces = this.agentNamespaces.get(agentId);
    if (!namespaces) return false;
    if (namespaces.includes('*')) return true;
    return namespaces.some(ns => key.startsWith(ns));
  }

  /**
   * Verify that the calling agent is who they claim to be.
   */
  private verifyAgent(agentId: string, token?: string): boolean {
    const registeredToken = this.agentTokens.get(agentId);
    // If no token system is configured for this agent, allow (backward compat)
    if (!registeredToken) return true;
    return token === registeredToken;
  }

  /**
   * Validate value size and structure before writing.
   * Prevents DoS via oversized writes and circular data.
   */
  private validateValue(value: unknown): { valid: boolean; reason?: string } {
    try {
      const serialized = JSON.stringify(value);
      if (serialized.length > CONFIG.maxBlackboardValueSize) {
        return { valid: false, reason: `Value exceeds max size (${serialized.length} > ${CONFIG.maxBlackboardValueSize} bytes)` };
      }
      return { valid: true };
    } catch {
      return { valid: false, reason: 'Value cannot be serialized (circular reference or invalid structure)' };
    }
  }

  /**
   * Sanitize a key to prevent markdown injection.
   */
  private sanitizeKey(key: string): string {
    // Keys must be safe for markdown headings -- no #, newlines, or markdown syntax
    return key.replace(/[#\n\r|`]/g, '_').slice(0, 256);
  }

  /**
   * Read an entry from the blackboard by key.
   *
   * @param key - The entry key to look up
   * @returns The entry, or `null` if not found or expired
   * @throws {@link ValidationError} if `key` is not a non-empty string
   */
  read(key: string): BlackboardEntry | null {
    if (!key || typeof key !== 'string') {
      throw new ValidationError('key must be a non-empty string');
    }
    const entry = this.backend.read(key);
    if (!entry) return null;
    // Normalize field name for backward compatibility
    return {
      key: entry.key,
      value: entry.value,
      sourceAgent: (entry as any).source_agent ?? (entry as any).sourceAgent ?? 'unknown',
      timestamp: entry.timestamp,
      ttl: entry.ttl,
    };
  }

  /**
   * Write to the blackboard with identity verification, namespace checks,
   * value validation, and input sanitization. Uses LockedBlackboard for
   * atomic file-system writes.
   *
   * @param key - The key to write
   * @param value - The value (will be sanitized and size-checked)
   * @param sourceAgent - Agent claiming to write (verified against registered token)
   * @param ttl - Optional TTL in seconds
   * @param agentToken - Optional verification token for identity check
   */
  write(key: string, value: unknown, sourceAgent: string, ttl?: number, agentToken?: string): BlackboardEntry {
    // 1. Verify agent identity
    if (!this.verifyAgent(sourceAgent, agentToken)) {
      throw new IdentityVerificationError(sourceAgent);
    }

    // 2. Namespace check
    if (!this.canAccessKey(sourceAgent, key)) {
      throw new NamespaceViolationError(sourceAgent, key);
    }

    // 3. Sanitize key
    const safeKey = this.sanitizeKey(key);

    // 4. Validate value size/structure
    const validation = this.validateValue(value);
    if (!validation.valid) {
      throw new ValidationError(validation.reason!);
    }

    // 5. Sanitize value -- strip injection payloads from string content
    let sanitizedValue: unknown;
    try {
      sanitizedValue = InputSanitizer.sanitizeObject(value);
    } catch {
      sanitizedValue = value; // Fall back to raw if sanitization can't handle it
    }

    // 6. Write through backend (atomic when using FileBackend; in-memory for MemoryBackend)
    const entry = this.backend.write(safeKey, sanitizedValue, sourceAgent, ttl);

    // Normalize for backward compat
    return {
      key: entry.key,
      value: entry.value,
      sourceAgent: (entry as any).source_agent ?? sourceAgent,
      timestamp: entry.timestamp,
      ttl: entry.ttl,
    };
  }

  /**
   * Check whether a key exists on the blackboard (not expired).
   * @param key - The entry key to check
   */
  exists(key: string): boolean {
    return this.read(key) !== null;
  }

  /**
   * Get a full snapshot of all blackboard entries.
   */
  getSnapshot(): Record<string, BlackboardEntry> {
    const raw = this.backend.getSnapshot();
    const normalized: Record<string, BlackboardEntry> = {};
    for (const [key, entry] of Object.entries(raw)) {
      normalized[key] = {
        key: entry.key,
        value: entry.value,
        sourceAgent: (entry as any).source_agent ?? (entry as any).sourceAgent ?? 'unknown',
        timestamp: entry.timestamp,
        ttl: entry.ttl,
      };
    }
    return normalized;
  }

  /**
   * Get a namespace-scoped snapshot -- only returns keys an agent is allowed to see.
   * Prevents data leakage between agents.
   */
  getScopedSnapshot(agentId: string): Record<string, BlackboardEntry> {
    if (!agentId || typeof agentId !== 'string') {
      throw new ValidationError('agentId must be a non-empty string');
    }
    const full = this.getSnapshot();
    const scoped: Record<string, BlackboardEntry> = {};
    for (const [key, entry] of Object.entries(full)) {
      if (this.canAccessKey(agentId, key)) {
        scoped[key] = entry;
      }
    }
    return scoped;
  }

  /**
   * Clear all entries (for testing).
   */
  clear(): void {
    // Write an empty state through locked backend
    const keys = this.backend.listKeys();
    for (const key of keys) {
      this.backend.delete(key);
    }
  }
}

// ============================================================================
// AUTH GUARDIAN - UNIVERSAL PERMISSION WALL IMPLEMENTATION
// Now domain-agnostic: resource types, risk profiles, trust levels, and
// restrictions are all configurable. Works for coding, finance, devops, etc.
// Integrates with SecureSwarmGateway for HMAC tokens, rate limiting, 
// input sanitization, and cryptographic audit logs.
// ============================================================================

/**
 * Universal permission wall for multi-agent systems.
 *
 * Evaluates permission requests using a weighted formula of justification
 * quality (40%), agent trust level (30%), and risk score (30%).
 * Resource types, risk profiles, trust levels, and restrictions are all
 * configurable — works for coding, finance, DevOps, or any domain.
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
class AuthGuardian {
  private activeGrants: Map<string, ActiveGrant> = new Map();
  private agentTrustLevels: Map<string, number> = new Map();
  private agentTrustConfigs: Map<string, AgentTrustConfig> = new Map();
  private resourceProfiles: Map<string, ResourceProfile> = new Map();
  private auditLog: Array<{ timestamp: string; action: string; details: unknown }> = [];
  private auditLogPath: string;
  private trustConfigPath: string;

  constructor(options?: {
    trustLevels?: AgentTrustConfig[];
    resourceProfiles?: Record<string, ResourceProfile>;
    auditLogPath?: string;
    trustConfigPath?: string;
  }) {
    this.auditLogPath = options?.auditLogPath ?? CONFIG.auditLogPath;
    this.trustConfigPath = options?.trustConfigPath ?? CONFIG.trustConfigPath;

    // Load resource profiles (user-provided + defaults)
    const profiles = { ...DEFAULT_RESOURCE_PROFILES, ...(options?.resourceProfiles ?? {}) };
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
   * Validate a token and return the bound restrictions and scope.
   * Used to enforce restrictions at the point of use.
   */
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
   * the operation violates any restriction, or null if allowed.
   */
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
    return `grant_${randomUUID().replace(/-/g, '')}`;
  }

  private log(action: string, details: unknown): void {
    const entry = {
      timestamp: new Date().toISOString(),
      action,
      details,
    };
    this.auditLog.push(entry);

    // Persist to disk
    try {
      const dir = join('.', 'data');
      if (!existsSync(dir)) {
        require('fs').mkdirSync(dir, { recursive: true });
      }
      appendFileSync(this.auditLogPath, JSON.stringify(entry) + '\n');
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
        require('fs').mkdirSync(dir, { recursive: true });
      }
      const configs = Array.from(this.agentTrustConfigs.values());
      writeFileSync(this.trustConfigPath, JSON.stringify(configs, null, 2));
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

// ============================================================================
// TASK DECOMPOSITION ENGINE
// ============================================================================

/**
 * Decomposes complex tasks into parallel sub-agent executions.
 *
 * Supports four synthesis strategies (`merge`, `vote`, `chain`, `first-success`)
 * and caches results on the blackboard to avoid redundant work.
 * Routes each sub-task through the {@link AdapterRegistry} so any
 * registered framework can participate.
 */
class TaskDecomposer {
  private blackboard: SharedBlackboard;
  private authGuardian: AuthGuardian;
  private adapterRegistry: AdapterRegistry;

  constructor(blackboard: SharedBlackboard, authGuardian: AuthGuardian, adapterRegistry: AdapterRegistry) {
    if (!blackboard || !(blackboard instanceof SharedBlackboard)) {
      throw new ValidationError('blackboard must be an instance of SharedBlackboard');
    }
    if (!authGuardian || !(authGuardian instanceof AuthGuardian)) {
      throw new ValidationError('authGuardian must be an instance of AuthGuardian');
    }
    if (!adapterRegistry || !(adapterRegistry instanceof AdapterRegistry)) {
      throw new ValidationError('adapterRegistry must be an instance of AdapterRegistry');
    }
    this.blackboard = blackboard;
    this.authGuardian = authGuardian;
    this.adapterRegistry = adapterRegistry;
  }

  /**
   * Decomposes a complex task into parallel sub-agent calls
   * This is the "Wall Breaker" - transforms impossible monolithic tasks
   * into manageable parallel executions
   */
  async executeParallel(
    tasks: ParallelTask[],
    synthesisStrategy: SynthesisStrategy = 'merge',
    context: SkillContext
  ): Promise<ParallelExecutionResult> {
    if (!tasks || !Array.isArray(tasks)) {
      throw new ValidationError('tasks must be an array');
    }
    if (tasks.length === 0) {
      throw new ValidationError('tasks array must not be empty');
    }
    if (!context || typeof context !== 'object' || !context.agentId) {
      throw new ValidationError('context is required and must include agentId');
    }
    // No hard parallel limit — caller controls concurrency via task count

    const startTime = Date.now();
    const individualResults: ParallelExecutionResult['individualResults'] = [];

    // Check blackboard for cached results first
    const cachedTasks: ParallelTask[] = [];
    const uncachedTasks: ParallelTask[] = [];

    for (const task of tasks) {
      const cacheKey = `task:${task.agentType}:${this.hashPayload(task.taskPayload)}`;
      const cached = this.blackboard.read(cacheKey);

      if (cached) {
        individualResults.push({
          agentType: task.agentType,
          success: true,
          result: cached.value,
          executionTime: 0, // From cache
        });
        cachedTasks.push(task);
      } else {
        uncachedTasks.push(task);
      }
    }

    // Execute uncached tasks in parallel using Promise.all
    if (uncachedTasks.length > 0) {
      const parallelPromises = uncachedTasks.map(task =>
        this.executeSingleTask(task, context)
      );

      const results = await Promise.all(parallelPromises);

      for (let i = 0; i < results.length; i++) {
        const task = uncachedTasks[i];
        const result = results[i];

        individualResults.push(result);

        // Cache successful results
        if (result.success) {
          const cacheKey = `task:${task.agentType}:${this.hashPayload(task.taskPayload)}`;
          this.blackboard.write(cacheKey, result.result, context.agentId, 3600, 'system-orchestrator-token'); // 1 hour TTL
        }
      }
    }

    // Synthesize results based on strategy
    const synthesizedResult = this.synthesize(individualResults, synthesisStrategy);

    const totalTime = Date.now() - startTime;
    const successCount = individualResults.filter(r => r.success).length;

    return {
      synthesizedResult,
      individualResults,
      executionMetrics: {
        totalTime,
        successRate: successCount / individualResults.length,
        synthesisStrategy,
      },
    };
  }

  private async executeSingleTask(
    task: ParallelTask,
    context: SkillContext
  ): Promise<ParallelExecutionResult['individualResults'][0]> {
    const taskStart = Date.now();

    try {
      // Build the handoff message
      const handoff: HandoffMessage = {
        handoffId: randomUUID(),
        sourceAgent: context.agentId,
        targetAgent: task.agentType,
        taskType: 'delegate',
        payload: task.taskPayload,
        metadata: {
          priority: 1,
          deadline: Date.now() + CONFIG.defaultTimeout,
          parentTaskId: context.taskId ?? null,
        },
      };

      // Sanitize the instruction before sending to adapter
      let sanitizedInstruction = task.taskPayload.instruction;
      try {
        sanitizedInstruction = InputSanitizer.sanitizeString(task.taskPayload.instruction, 10000);
      } catch { /* use original if sanitization fails */ }

      // Use namespace-scoped snapshot -- target agent only sees keys it's allowed to see
      const scopedSnapshot = this.blackboard.getScopedSnapshot(task.agentType);

      // Route through the adapter registry (framework-agnostic)
      const agentPayload: AgentPayload = {
        action: 'execute',
        params: {},
        handoff: {
          handoffId: handoff.handoffId,
          sourceAgent: handoff.sourceAgent,
          targetAgent: handoff.targetAgent,
          taskType: handoff.taskType,
          instruction: sanitizedInstruction,
          context: handoff.payload.context,
          constraints: handoff.payload.constraints,
          expectedOutput: handoff.payload.expectedOutput,
          metadata: handoff.metadata as unknown as Record<string, unknown>,
        },
        blackboardSnapshot: scopedSnapshot as Record<string, unknown>,
      };

      const agentContext: AgentContext = {
        agentId: context.agentId,
        taskId: context.taskId,
        sessionId: context.sessionId,
      };

      const result = await this.adapterRegistry.executeAgent(task.agentType, agentPayload, agentContext);

      // Sanitize adapter output before returning/caching
      let sanitizedData = result.data;
      try {
        sanitizedData = InputSanitizer.sanitizeObject(result.data);
      } catch { /* use raw if sanitization fails */ }

      return {
        agentType: task.agentType,
        success: true,
        result: sanitizedData,
        executionTime: Date.now() - taskStart,
      };
    } catch (error) {
      return {
        agentType: task.agentType,
        success: false,
        result: {
          error: error instanceof Error ? error.message : 'Unknown error',
          recoverable: true,
        },
        executionTime: Date.now() - taskStart,
      };
    }
  }

  private synthesize(
    results: ParallelExecutionResult['individualResults'],
    strategy: SynthesisStrategy
  ): unknown {
    const successfulResults = results.filter(r => r.success);

    if (successfulResults.length === 0) {
      return {
        error: 'All parallel tasks failed',
        individualErrors: results.map(r => ({
          agent: r.agentType,
          error: r.result,
        })),
      };
    }

    switch (strategy) {
      case 'merge':
        // Combine all results into a unified object
        return {
          merged: true,
          contributions: successfulResults.map(r => ({
            source: r.agentType,
            data: r.result,
          })),
          summary: this.generateMergeSummary(successfulResults),
        };

      case 'vote':
        // Return the result with highest "confidence" (simplified: most data)
        const scored = successfulResults.map(r => ({
          result: r,
          score: JSON.stringify(r.result).length,
        }));
        scored.sort((a, b) => b.score - a.score);
        return {
          voted: true,
          winner: scored[0].result.agentType,
          result: scored[0].result.result,
        };

      case 'chain':
        // Results should already be ordered; return the final one
        return {
          chained: true,
          finalResult: successfulResults[successfulResults.length - 1].result,
          chainLength: successfulResults.length,
        };

      case 'first-success':
        // Return the first successful result
        return {
          firstSuccess: true,
          source: successfulResults[0].agentType,
          result: successfulResults[0].result,
        };

      default:
        return successfulResults.map(r => r.result);
    }
  }

  private generateMergeSummary(results: ParallelExecutionResult['individualResults']): string {
    const agents = results.map(r => r.agentType).join(', ');
    return `Synthesized from ${results.length} agents: ${agents}`;
  }

  private hashPayload(payload: TaskPayload): string {
    // Simple hash for cache key generation
    const str = JSON.stringify(payload);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }
}

// ============================================================================
// SWARM ORCHESTRATOR - MAIN SKILL IMPLEMENTATION
// ============================================================================

/**
 * The main orchestrator class — coordinates agents, permissions, blackboard,
 * quality gates, and adapter routing in a single entry point.
 *
 * Implements the OpenClaw skill interface for backward compatibility and
 * can also be used standalone via {@link createSwarmOrchestrator}.
 *
 * @example
 * ```typescript
 * import { createSwarmOrchestrator, LangChainAdapter } from 'network-ai';
 *
 * const orchestrator = createSwarmOrchestrator({
 *   adapters: [{ adapter: new LangChainAdapter() }],
 *   trustLevels: [{ agentId: 'my-agent', trustLevel: 0.8 }],
 * });
 *
 * const result = await orchestrator.execute('delegate_task', {
 *   targetAgent: 'my-agent',
 *   taskPayload: { instruction: 'Summarize the quarterly report' },
 * }, { agentId: 'orchestrator' });
 * ```
 */
export class SwarmOrchestrator implements OpenClawSkill {
  name = 'SwarmOrchestrator';
  version = '3.1.0';

  private blackboard: SharedBlackboard;
  private authGuardian: AuthGuardian;
  private taskDecomposer: TaskDecomposer;
  private agentRegistry: Map<string, AgentStatus> = new Map();
  private gateway: SecureSwarmGateway;
  private qualityGate: QualityGateAgent;

  /** Named isolated blackboards, keyed by board name */
  private namedBlackboards: Map<string, SharedBlackboard> = new Map();
  /** Root workspace path -- used as the parent for named board subdirectories */
  private _workspacePath: string;

  /** The adapter registry -- routes requests to the right agent framework */
  public readonly adapters: AdapterRegistry;

  constructor(
    workspacePath: string = process.cwd(),
    adapterRegistry?: AdapterRegistry,
    options?: {
      trustLevels?: AgentTrustConfig[];
      resourceProfiles?: Record<string, ResourceProfile>;
      validationConfig?: Partial<ValidationConfig>;
      qualityThreshold?: number;
      aiReviewCallback?: AIReviewCallback;
    }
  ) {
    if (workspacePath !== undefined && typeof workspacePath !== 'string') {
      throw new ValidationError('workspacePath must be a string');
    }
    if (workspacePath !== undefined && workspacePath.trim() === '') {
      throw new ValidationError('workspacePath must not be empty');
    }
    this._workspacePath = workspacePath;
    this.blackboard = new SharedBlackboard(workspacePath);
    this.authGuardian = new AuthGuardian({
      trustLevels: options?.trustLevels,
      resourceProfiles: options?.resourceProfiles,
    });
    this.adapters = adapterRegistry ?? new AdapterRegistry();
    this.taskDecomposer = new TaskDecomposer(this.blackboard, this.authGuardian, this.adapters);
    this.gateway = new SecureSwarmGateway();
    this.qualityGate = new QualityGateAgent({
      validationConfig: options?.validationConfig,
      qualityThreshold: options?.qualityThreshold,
      aiReviewCallback: options?.aiReviewCallback,
    });

    // Register the orchestrator agent on the blackboard with full access
    this.blackboard.registerAgent('orchestrator', 'system-orchestrator-token', ['*']);
  }

  /**
   * Add an agent framework adapter (LangChain, AutoGen, CrewAI, MCP, custom, etc.)
   * This is the plug-and-play entry point.
   */
  async addAdapter(adapter: IAgentAdapter, config: AdapterConfig = {}): Promise<void> {
    if (!adapter || typeof adapter !== 'object') {
      throw new ValidationError('adapter is required and must be an object');
    }
    if (typeof adapter.name !== 'string' || adapter.name.trim() === '') {
      throw new ValidationError('adapter.name must be a non-empty string');
    }
    await this.adapters.addAdapter(adapter, config);
  }

  /**
   * Main entry point for the skill.
   * Now integrates SecureSwarmGateway: every request flows through
   * input sanitization, rate limiting, and agent ID validation.
   */
  async execute(action: string, params: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    if (!action || typeof action !== 'string') {
      return {
        success: false,
        error: {
          code: 'INVALID_PARAMS',
          message: 'action is required and must be a non-empty string',
          recoverable: false,
        },
      };
    }
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return {
        success: false,
        error: {
          code: 'INVALID_PARAMS',
          message: 'params is required and must be a plain object',
          recoverable: false,
        },
      };
    }
    if (!context || typeof context !== 'object' || !context.agentId || typeof context.agentId !== 'string') {
      return {
        success: false,
        error: {
          code: 'INVALID_PARAMS',
          message: 'context is required and must include a non-empty agentId string',
          recoverable: false,
        },
      };
    }
    const traceId = randomUUID();

    // P0: Route through SecureSwarmGateway -- sanitization + rate limiting
    const gatewayResult = await this.gateway.handleSecureRequest(
      context.agentId,
      action,
      params,
    );

    if (!gatewayResult.allowed) {
      return {
        success: false,
        error: {
          code: 'GATEWAY_DENIED',
          message: `Security gateway denied request: ${gatewayResult.reason}`,
          recoverable: true,
          suggestedAction: 'Check agent ID, rate limits, or input format',
        },
      };
    }

    // Use sanitized params from gateway
    const safeParams = gatewayResult.sanitizedParams ?? params;

    if (CONFIG.enableTracing) {
      try {
        this.blackboard.write(`trace:${traceId}`, {
          action,
          startTime: new Date().toISOString(),
        }, context.agentId, undefined, 'system-orchestrator-token');
      } catch {
        // Non-fatal -- tracing failure shouldn't block execution
      }
    }

    try {
      switch (action) {
        case 'delegate_task':
          return await this.delegateTask(safeParams, context);

        case 'query_swarm_state':
          return await this.querySwarmState(safeParams, context);

        case 'spawn_parallel_agents':
          return await this.spawnParallelAgents(safeParams, context);

        case 'request_permission':
          return await this.handlePermissionRequest(safeParams, context);

        case 'update_blackboard':
          return await this.handleBlackboardUpdate(safeParams, context);

        case 'quality_gate_status':
          return this.handleQualityGateStatus();

        case 'review_quarantine':
          return this.handleQuarantineReview(safeParams);

        default:
          return {
            success: false,
            error: {
              code: 'UNKNOWN_ACTION',
              message: `Unknown action: ${action}`,
              recoverable: false,
            },
          };
      }
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          recoverable: true,
          trace: { traceId, action },
        },
      };
    }
  }

  // -------------------------------------------------------------------------
  // CAPABILITY: delegate_task
  // -------------------------------------------------------------------------

  private async delegateTask(params: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const targetAgent = params.targetAgent as string;
    const taskPayload = params.taskPayload as TaskPayload;
    const priority = (params.priority as string) ?? 'normal';
    const timeout = (params.timeout as number) ?? CONFIG.defaultTimeout;
    const requiresAuth = (params.requiresAuth as boolean) ?? false;
    const resourceType = (params.resourceType as string) ?? 'EXTERNAL_SERVICE';

    // Check permission wall if required -- now returns bound restrictions
    let grantToken: string | null = null;
    if (requiresAuth) {
      const authResult = await this.authGuardian.requestPermission(
        context.agentId,
        resourceType,
        `Delegating task to ${targetAgent}: ${taskPayload.instruction}`,
        'delegate'
      );

      if (!authResult.granted) {
        return {
          success: false,
          error: {
            code: 'AUTH_DENIED',
            message: `Permission denied: ${authResult.reason}`,
            recoverable: true,
            suggestedAction: 'Provide more specific justification or narrow scope',
          },
        };
      }

      grantToken = authResult.grantToken;

      // Enforce restrictions at point of use
      if (grantToken) {
        const restrictionViolation = this.authGuardian.enforceRestrictions(grantToken, {
          type: 'execute',
        });
        if (restrictionViolation) {
          return {
            success: false,
            error: {
              code: 'RESTRICTION_VIOLATED',
              message: restrictionViolation,
              recoverable: true,
              suggestedAction: 'Request a grant with broader scope',
            },
          };
        }
      }
    }

    // Check blackboard for existing work
    const cacheKey = `task:${targetAgent}:${JSON.stringify(taskPayload).slice(0, 50)}`;
    const existingWork = this.blackboard.read(cacheKey);
    if (existingWork) {
      return {
        success: true,
        data: {
          taskId: 'cached',
          status: 'completed',
          result: existingWork.value,
          agentTrace: ['blackboard-cache'],
          fromCache: true,
        },
      };
    }

    // Build handoff message
    const handoff: HandoffMessage = {
      handoffId: randomUUID(),
      sourceAgent: context.agentId,
      targetAgent,
      taskType: 'delegate',
      payload: taskPayload,
      metadata: {
        priority: this.priorityToNumber(priority),
        deadline: Date.now() + timeout,
        parentTaskId: context.taskId ?? null,
      },
    };

    // Execute via adapter registry (routes to the right framework)
    try {
      // Sanitize instruction before sending to adapter
      let sanitizedInstruction = taskPayload.instruction;
      try {
        sanitizedInstruction = InputSanitizer.sanitizeString(taskPayload.instruction, 10000);
      } catch { /* use original if sanitization fails */ }

      // P1: Namespace-scoped snapshot -- target agent only sees keys it's allowed to see
      const scopedSnapshot = this.blackboard.getScopedSnapshot(targetAgent);

      const agentPayload: AgentPayload = {
        action: 'execute',
        params: {},
        handoff: {
          handoffId: handoff.handoffId,
          sourceAgent: handoff.sourceAgent,
          targetAgent: handoff.targetAgent,
          taskType: handoff.taskType,
          instruction: sanitizedInstruction,
          context: taskPayload.context,
          constraints: taskPayload.constraints,
          expectedOutput: taskPayload.expectedOutput,
          metadata: handoff.metadata as unknown as Record<string, unknown>,
        },
        blackboardSnapshot: scopedSnapshot as Record<string, unknown>,
      };

      const agentContext: AgentContext = {
        agentId: context.agentId,
        taskId: context.taskId,
        sessionId: context.sessionId,
      };

      const result = await Promise.race([
        this.adapters.executeAgent(targetAgent, agentPayload, agentContext),
        this.timeoutPromise(timeout),
      ]);

      // P1: Sanitize adapter output before caching
      let sanitizedResult = result;
      try {
        sanitizedResult = InputSanitizer.sanitizeObject(result) as typeof result;
      } catch { /* use raw if sanitization fails */ }

      // Quality gate: validate result before committing to blackboard
      const gateResult = await this.qualityGate.gate(cacheKey, sanitizedResult, targetAgent, {
        taskInstruction: taskPayload.instruction,
        expectedOutput: taskPayload.expectedOutput,
      });

      if (gateResult.decision === 'reject') {
        return {
          success: false,
          error: {
            code: 'QUALITY_REJECTED',
            message: `Result from ${targetAgent} failed quality validation: ${gateResult.validation.issues.filter(i => i.severity === 'error').map(i => i.message).join('; ')}`,
            recoverable: gateResult.validation.recoverable,
            suggestedAction: gateResult.validation.issues.find(i => i.suggestion)?.suggestion,
          },
        };
      }

      if (gateResult.decision === 'quarantine') {
        // Still return the result but flag it
        return {
          success: true,
          data: {
            taskId: handoff.handoffId,
            status: 'quarantined',
            result: sanitizedResult,
            agentTrace: [context.agentId, targetAgent],
            qualityGate: {
              decision: 'quarantine',
              quarantineKey: gateResult.quarantineKey,
              score: gateResult.validation.score,
              issues: gateResult.validation.issues,
              reviewNotes: gateResult.reviewNotes,
            },
          },
        };
      }

      // Approved -- cache result
      this.blackboard.write(cacheKey, sanitizedResult, context.agentId, 1800, 'system-orchestrator-token'); // 30 min TTL

      return {
        success: true,
        data: {
          taskId: handoff.handoffId,
          status: 'completed',
          result: sanitizedResult,
          agentTrace: [context.agentId, targetAgent],
          qualityGate: {
            decision: 'approve',
            score: gateResult.validation.score,
          },
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DELEGATION_FAILED',
          message: error instanceof Error ? error.message : 'Task delegation failed',
          recoverable: true,
        },
      };
    }
  }

  // -------------------------------------------------------------------------
  // CAPABILITY: query_swarm_state
  // -------------------------------------------------------------------------

  private async querySwarmState(params: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const scope = (params.scope as string) ?? 'all';
    const agentFilter = params.agentFilter as string[] | undefined;
    const _includeHistory = (params.includeHistory as boolean) ?? false;

    const state: Partial<SwarmState> = {
      timestamp: new Date().toISOString(),
    };

    if (scope === 'all' || scope === 'agents') {
      let agents = Array.from(this.agentRegistry.values());
      if (agentFilter) {
        agents = agents.filter(a => agentFilter.includes(a.agentId));
      }
      state.activeAgents = agents;
    }

    if (scope === 'all' || scope === 'blackboard') {
      // P1: Namespace-scoped -- agent only sees keys it's allowed to access
      state.blackboardSnapshot = this.blackboard.getScopedSnapshot(context.agentId);
    }

    if (scope === 'all' || scope === 'permissions') {
      state.permissionGrants = this.authGuardian.getActiveGrants();
    }

    if (scope === 'all' || scope === 'tasks') {
      // Extract tasks from scoped blackboard
      const snapshot = this.blackboard.getScopedSnapshot(context.agentId);
      state.pendingTasks = Object.entries(snapshot)
        .filter(([key]) => key.startsWith('task:'))
        .map(([, entry]) => ({
          taskId: entry.key,
          agentId: entry.sourceAgent,
          status: 'in_progress' as const,
          startedAt: entry.timestamp,
          description: String(entry.value),
        }));
    }

    return {
      success: true,
      data: state,
    };
  }

  // -------------------------------------------------------------------------
  // CAPABILITY: spawn_parallel_agents
  // -------------------------------------------------------------------------

  private async spawnParallelAgents(
    params: Record<string, unknown>,
    context: SkillContext
  ): Promise<SkillResult> {
    const tasks = params.tasks as ParallelTask[];
    const synthesisStrategy = (params.synthesisStrategy as SynthesisStrategy) ?? 'merge';

    if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
      return {
        success: false,
        error: {
          code: 'INVALID_PARAMS',
          message: 'Tasks array is required and must not be empty',
          recoverable: false,
        },
      };
    }

    try {
      const result = await this.taskDecomposer.executeParallel(tasks, synthesisStrategy, context);

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'PARALLEL_EXECUTION_FAILED',
          message: error instanceof Error ? error.message : 'Parallel execution failed',
          recoverable: true,
        },
      };
    }
  }

  // -------------------------------------------------------------------------
  // CAPABILITY: request_permission
  // -------------------------------------------------------------------------

  private async handlePermissionRequest(
    params: Record<string, unknown>,
    context: SkillContext
  ): Promise<SkillResult> {
    const resourceType = params.resourceType as string;
    const justification = params.justification as string;
    const scope = params.scope as string | undefined;

    if (!resourceType || !justification) {
      return {
        success: false,
        error: {
          code: 'INVALID_PARAMS',
          message: 'resourceType and justification are required',
          recoverable: false,
        },
      };
    }

    const grant = await this.authGuardian.requestPermission(
      context.agentId,
      resourceType,
      justification,
      scope
    );

    return {
      success: grant.granted,
      data: grant,
    };
  }

  // -------------------------------------------------------------------------
  // CAPABILITY: update_blackboard
  // -------------------------------------------------------------------------

  private async handleBlackboardUpdate(
    params: Record<string, unknown>,
    context: SkillContext
  ): Promise<SkillResult> {
    const key = params.key as string;
    const value = params.value;
    const ttl = params.ttl as number | undefined;

    if (!key || value === undefined) {
      return {
        success: false,
        error: {
          code: 'INVALID_PARAMS',
          message: 'key and value are required',
          recoverable: false,
        },
      };
    }

    const previousValue = this.blackboard.read(key)?.value ?? null;

    // Quality gate: validate before writing to blackboard
    const gateResult = await this.qualityGate.gate(key, value, context.agentId);

    if (gateResult.decision === 'reject') {
      return {
        success: false,
        error: {
          code: 'QUALITY_REJECTED',
          message: `Blackboard write rejected: ${gateResult.validation.issues.filter(i => i.severity === 'error').map(i => i.message).join('; ')}`,
          recoverable: gateResult.validation.recoverable,
          suggestedAction: gateResult.validation.issues.find(i => i.suggestion)?.suggestion,
        },
      };
    }

    if (gateResult.decision === 'quarantine') {
      return {
        success: true,
        data: {
          success: true,
          quarantined: true,
          quarantineKey: gateResult.quarantineKey,
          qualityScore: gateResult.validation.score,
          issues: gateResult.validation.issues,
          previousValue,
        },
      };
    }

    this.blackboard.write(key, value, context.agentId, ttl, 'system-orchestrator-token');

    return {
      success: true,
      data: {
        success: true,
        previousValue,
        qualityScore: gateResult.validation.score,
      },
    };
  }

  // -------------------------------------------------------------------------
  // QUALITY GATE MANAGEMENT
  // -------------------------------------------------------------------------

  /** Returns quality gate metrics and quarantined entries */
  private handleQualityGateStatus(): SkillResult {
    return {
      success: true,
      data: {
        metrics: this.qualityGate.getMetrics(),
        quarantined: this.qualityGate.getQuarantined(),
      },
    };
  }

  /** Approve or reject a quarantined entry */
  private handleQuarantineReview(params: Record<string, unknown>): SkillResult {
    const quarantineId = params.quarantineId as string;
    const decision = params.decision as 'approve' | 'reject';

    if (!quarantineId || !decision) {
      return {
        success: false,
        error: {
          code: 'INVALID_PARAMS',
          message: 'quarantineId and decision ("approve" or "reject") are required',
          recoverable: false,
        },
      };
    }

    let entry: unknown;
    if (decision === 'approve') {
      entry = this.qualityGate.approveQuarantined(quarantineId);
      if (entry) {
        // Write the approved entry to the blackboard
        this.blackboard.write(`approved:${quarantineId}`, entry, 'orchestrator', undefined, 'system-orchestrator-token');
      }
    } else {
      entry = this.qualityGate.rejectQuarantined(quarantineId);
    }

    return {
      success: !!entry,
      data: entry ? { quarantineId, decision, resolved: true } : undefined,
      error: entry ? undefined : {
        code: 'NOT_FOUND',
        message: `Quarantine entry ${quarantineId} not found`,
        recoverable: false,
      },
    };
  }

  /** Expose the quality gate for external configuration */
  public getQualityGate(): QualityGateAgent {
    return this.qualityGate;
  }

  // -------------------------------------------------------------------------
  // NAMED MULTI-BLACKBOARD API (Phase 5)
  // -------------------------------------------------------------------------

  /**
   * Get or create a named, isolated blackboard managed by this orchestrator.
   *
   * Each named board is stored in its own subdirectory:
   *   `<workspacePath>/boards/<name>/`
   *
   * Calling `getBlackboard(name)` a second time returns the same instance --
   * no duplicate boards are created.
   *
   * All existing APIs (`orchestrator.blackboard`, adapters, AuthGuardian, etc.)
   * are completely unaffected. This is a purely additive method.
   *
   * @example
   * ```typescript
   * const board = orchestrator.getBlackboard('project-alpha');
   * board.registerAgent('analyst', 'tok-1', ['analysis:']);
   * board.write('analysis:result', { score: 0.9 }, 'analyst', 3600, 'tok-1');
   * const entry = board.read('analysis:result');
   * ```
   *
   * @param name    - Board name: alphanumeric, hyphens and underscores only
   * @param options - Optional creation options (ignored on subsequent calls)
   * @returns The isolated `SharedBlackboard` instance for this name
   * @throws {@link ValidationError} if `name` is empty or contains invalid characters
   */
  public getBlackboard(name: string, options?: NamedBlackboardOptions): SharedBlackboard {
    if (!name || typeof name !== 'string' || name.trim() === '') {
      throw new ValidationError('name must be a non-empty string');
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new ValidationError(
        'name must contain only alphanumeric characters, hyphens, or underscores'
      );
    }

    // Return existing board (idempotent)
    if (this.namedBlackboards.has(name)) {
      return this.namedBlackboards.get(name)!;
    }

    let board: SharedBlackboard;
    let selectedBackend: BlackboardBackend;
    if (options?.backend) {
      // Custom backend — no disk directory needed
      selectedBackend = options.backend;
      log.info('Named blackboard created (custom backend)', { name });
    } else {
      // Default: file backend persisted to <workspacePath>/boards/<name>/
      const boardPath = join(this._workspacePath, 'boards', name);
      mkdirSync(boardPath, { recursive: true });
      selectedBackend = new FileBackend(boardPath);
      log.info('Named blackboard created', { name, boardPath: join(this._workspacePath, 'boards', name) });
    }

    // Auto-wrap with ConsistentBackend when a non-default consistency level is requested
    if (options?.consistency && options.consistency !== 'eventual') {
      selectedBackend = new ConsistentBackend(selectedBackend, options.consistency);
      log.info('Named blackboard wrapped with ConsistentBackend', { name, consistency: options.consistency });
    }

    board = new SharedBlackboard(selectedBackend);

    // Register the orchestrator agent on this board
    board.registerAgent(
      'orchestrator',
      'system-orchestrator-token',
      options?.allowedNamespaces ?? ['*'],
    );

    this.namedBlackboards.set(name, board);
    return board;
  }

  /**
   * Returns the names of all currently active named blackboards.
   *
   * @example
   * ```typescript
   * orchestrator.getBlackboard('alpha');
   * orchestrator.getBlackboard('beta');
   * orchestrator.listBlackboards(); // ['alpha', 'beta']
   * ```
   */
  public listBlackboards(): string[] {
    return Array.from(this.namedBlackboards.keys());
  }

  /**
   * Returns `true` if a named blackboard with the given name is currently active.
   *
   * @param name - The board name to check
   */
  public hasBlackboard(name: string): boolean {
    if (!name || typeof name !== 'string') return false;
    return this.namedBlackboards.has(name);
  }

  /**
   * Removes a named blackboard from the in-memory registry.
   *
   * **On-disk data is NOT deleted** -- call `getBlackboard(name)` again to
   * re-attach to the same persistent board at a later point.
   *
   * @param name - The board name to remove
   * @returns `true` if the board existed and was removed, `false` otherwise
   *
   * @example
   * ```typescript
   * orchestrator.destroyBlackboard('project-alpha'); // true
   * orchestrator.hasBlackboard('project-alpha');     // false
   * ```
   */
  public destroyBlackboard(name: string): boolean {
    if (!name || typeof name !== 'string') return false;
    const existed = this.namedBlackboards.has(name);
    this.namedBlackboards.delete(name);
    if (existed) log.info('Named blackboard removed from registry', { name });
    return existed;
  }

  // -------------------------------------------------------------------------
  // UTILITY METHODS
  // -------------------------------------------------------------------------

  private priorityToNumber(priority: string): number {
    const map: Record<string, number> = {
      low: 0,
      normal: 1,
      high: 2,
      critical: 3,
    };
    return map[priority] ?? 1;
  }

  private timeoutPromise(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new NetworkAITimeoutError(ms)), ms);
    });
  }

  /**
   * Register an agent with the swarm
   */
  registerAgent(agentId: string, status: AgentStatus['status'] = 'available'): void {
    if (!agentId || typeof agentId !== 'string' || agentId.trim() === '') {
      throw new ValidationError('agentId must be a non-empty string');
    }
    const validStatuses = ['available', 'busy', 'waiting_auth', 'offline'] as const;
    if (!validStatuses.includes(status as any)) {
      throw new ValidationError(`status must be one of: ${validStatuses.join(', ')}`);
    }
    this.agentRegistry.set(agentId, {
      agentId,
      status,
      currentTask: null,
      lastHeartbeat: new Date().toISOString(),
    });
  }

  /**
   * Update agent status
   */
  updateAgentStatus(agentId: string, status: AgentStatus['status'], currentTask?: string): void {
    if (!agentId || typeof agentId !== 'string' || agentId.trim() === '') {
      throw new ValidationError('agentId must be a non-empty string');
    }
    const existing = this.agentRegistry.get(agentId);
    if (existing) {
      existing.status = status;
      existing.currentTask = currentTask ?? null;
      existing.lastHeartbeat = new Date().toISOString();
    }
  }
}

// ============================================================================
// EXPORTS & MODULE INITIALIZATION
// ============================================================================

// Default export for OpenClaw skill loader (backward compatible)
export default SwarmOrchestrator;

// Named exports for direct usage
export { SharedBlackboard, AuthGuardian, TaskDecomposer };

// Quality gate & validation exports
export { BlackboardValidator, QualityGateAgent } from './lib/blackboard-validator';
export type {
  ValidationResult,
  ValidationIssue,
  ValidationConfig,
  QualityGateResult,
  GateDecision,
  AIReviewCallback,
  CustomValidationRule,
} from './lib/blackboard-validator';

// Adapter system re-exports for convenience
export { AdapterRegistry } from './adapters/adapter-registry';
export { BaseAdapter } from './adapters/base-adapter';
export { OpenClawAdapter } from './adapters/openclaw-adapter';
export { LangChainAdapter } from './adapters/langchain-adapter';
export { AutoGenAdapter } from './adapters/autogen-adapter';
export { CrewAIAdapter } from './adapters/crewai-adapter';
export { MCPAdapter } from './adapters/mcp-adapter';
export { CustomAdapter } from './adapters/custom-adapter';

// Type exports
export type {
  TaskPayload,
  HandoffMessage,
  PermissionGrant,
  SwarmState,
  AgentStatus,
  ParallelTask,
  ParallelExecutionResult,
  SynthesisStrategy,
  ResourceProfile,
  AgentTrustConfig,
};

export type {
  IAgentAdapter,
  AgentPayload,
  AgentContext,
  AgentResult,
  AgentInfo,
  AdapterConfig,
  AdapterCapabilities,
} from './types/agent-adapter';

// Backward-compatible OpenClaw types
export type { OpenClawSkill, SkillContext, SkillResult };

// Phase 3: Priority & Preemption types
export type { ConflictResolutionStrategy, AgentPriority, LockedBlackboardOptions };

// Phase 5 Part 2: Pluggable Backend API
export { FileBackend, MemoryBackend } from './lib/blackboard-backend';
export type { BlackboardBackend } from './lib/blackboard-backend';

// Phase 5 Part 3: Redis Backend
export { RedisBackend } from './lib/blackboard-backend-redis';
export type { RedisClient, RedisPipeline, RedisBackendOptions } from './lib/blackboard-backend-redis';

// Phase 5 Part 4: CRDT Backend
export { CrdtBackend } from './lib/blackboard-backend-crdt';
export type { CrdtBackendOptions, VectorClock, CrdtEntry } from './lib/blackboard-backend-crdt';
export { tickClock, mergeClock, happensBefore, isConcurrent, compareClock, mergeEntry } from './lib/crdt';

// Phase 5 Part 5: Configurable Consistency Levels
export { ConsistentBackend, isFlushable } from './lib/consistency';
export type { ConsistencyLevel, FlushableBackend } from './lib/consistency';

// Phase 5 Part 6: Federated Budget Tracking
export { FederatedBudget } from './lib/federated-budget';
export type { FederatedBudgetOptions, SpendResult, SpendLogEntry } from './lib/federated-budget';

// Phase 5 Part 7: MCP Networking
export {
  McpBlackboardBridge,
  McpBridgeClient,
  McpBridgeRouter,
  McpInProcessTransport,
} from './lib/mcp-bridge';
export type {
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpJsonRpcError,
  McpListToolsResult,
  McpCallToolResult,
  McpContentBlock,
  McpTransport,
  McpBlackboardBridgeOptions,
} from './lib/mcp-bridge';

// Logger
export { Logger, LogLevel } from './lib/logger';
export type { LogEntry, LogTransport, LoggerConfig } from './lib/logger';

// Typed errors
export {
  NetworkAIError,
  IdentityVerificationError,
  NamespaceViolationError,
  ValidationError,
  LockAcquisitionError,
  ConflictError,
  AdapterAlreadyRegisteredError,
  AdapterNotFoundError,
  AdapterNotInitializedError,
  ParallelLimitError,
  TimeoutError,
} from './lib/errors';

// ============================================================================
// Phase 4: Behavioral Control Plane
// ============================================================================

// FSM Journey Layer
export {
  JourneyFSM,
  ToolAuthorizationMatrix,
  ComplianceMiddleware,
  ComplianceViolationError,
  createDeliveryPipelineFSM,
  WORKFLOW_STATES,
} from './lib/fsm-journey';
export type {
  WorkflowStateDefinition,
  StateTransition,
  TransitionResult,
  ComplianceCheckResult,
  JourneyFSMOptions,
} from './lib/fsm-journey';

// Real-Time Compliance Monitor
export { ComplianceMonitor } from './lib/compliance-monitor';
export type {
  ComplianceViolation,
  ViolationType,
  AgentAction,
  AgentMonitorConfig,
  ComplianceMonitorOptions,
} from './lib/compliance-monitor';

// MCP Blackboard Tool Bindings
export {
  BlackboardMCPTools,
  registerBlackboardTools,
  BLACKBOARD_TOOL_DEFINITIONS,
} from './lib/mcp-blackboard-tools';
export type {
  MCPToolDefinition,
  MCPJsonSchema,
  BlackboardToolResult,
  IBlackboard,
} from './lib/mcp-blackboard-tools';

/**
 * Factory function for creating a configured SwarmOrchestrator instance.
 * 
 * For plug-and-play with other agent systems, pass adapters:
 * 
 *   const orchestrator = createSwarmOrchestrator({
 *     adapters: [{ adapter: new LangChainAdapter(), config: {} }],
 *   });
 */
/**
 * Factory function for creating a fully configured {@link SwarmOrchestrator}.
 *
 * Accepts optional configuration for adapters, trust levels, resource profiles,
 * quality gate settings, and runtime overrides.
 *
 * @param config - Optional configuration object. Pass `undefined` for all defaults.
 * @returns A ready-to-use SwarmOrchestrator instance.
 *
 * @example
 * ```typescript
 * import { createSwarmOrchestrator, LangChainAdapter } from 'network-ai';
 *
 * // Minimal
 * const orc = createSwarmOrchestrator();
 *
 * // With adapters and trust
 * const orc2 = createSwarmOrchestrator({
 *   adapters: [{ adapter: new LangChainAdapter() }],
 *   trustLevels: [{ agentId: 'analyst', trustLevel: 0.8 }],
 *   qualityThreshold: 0.7,
 * });
 * ```
 */
export function createSwarmOrchestrator(config?: Partial<typeof CONFIG> & {
  adapters?: Array<{ adapter: IAgentAdapter; config?: AdapterConfig }>;
  adapterRegistry?: AdapterRegistry;
  trustLevels?: AgentTrustConfig[];
  resourceProfiles?: Record<string, ResourceProfile>;
  validationConfig?: Partial<ValidationConfig>;
  qualityThreshold?: number;
  aiReviewCallback?: AIReviewCallback;
}): SwarmOrchestrator {
  if (config !== undefined && (typeof config !== 'object' || config === null || Array.isArray(config))) {
    throw new ValidationError('config must be a plain object');
  }
  if (config) {
    const { adapters: adapterList, adapterRegistry, trustLevels, resourceProfiles, validationConfig, qualityThreshold, aiReviewCallback, ...rest } = config;
    Object.assign(CONFIG, rest);

    const registry = adapterRegistry ?? new AdapterRegistry();
    const orchestrator = new SwarmOrchestrator(undefined, registry, {
      trustLevels,
      resourceProfiles,
      validationConfig,
      qualityThreshold,
      aiReviewCallback,
    });

    // Initialize adapters if provided
    if (adapterList) {
      Promise.all(
        adapterList.map(({ adapter, config: adapterConfig }) =>
          orchestrator.addAdapter(adapter, adapterConfig ?? {})
        )
      ).catch(err => log.error('Adapter init error', { error: err instanceof Error ? err.message : String(err) }));
    }

    return orchestrator;
  }
  return new SwarmOrchestrator();
}

// ============================================================================
// Phase 6: Full AI Control — config accessors
// ============================================================================

/**
 * Read the current value of a CONFIG key, or the entire CONFIG snapshot.
 *
 * @example
 * ```typescript
 * const cfg = getConfig(); // { maxParallelAgents: Infinity, ... }
 * const timeout = getConfig('defaultTimeout'); // 30000
 * ```
 */
export function getConfig(): Readonly<typeof CONFIG>;
export function getConfig(key: string): unknown;
export function getConfig(key?: string): unknown {
  if (key !== undefined) return (CONFIG as Record<string, unknown>)[key];
  return { ...CONFIG };
}

/**
 * Update a CONFIG key at runtime.  Changes take effect immediately for all
 * subsequent orchestrator operations.
 *
 * @example
 * ```typescript
 * setConfig('maxParallelAgents', 10);
 * setConfig('enableTracing', false);
 * ```
 */
export function setConfig(key: string, value: unknown): void {
  (CONFIG as Record<string, unknown>)[key] = value;
}

// Phase 6: SSE transport + extended/control tools
export {
  McpSseServer,
  McpSseTransport,
  McpCombinedBridge,
  McpBlackboardBridgeAdapter,
} from './lib/mcp-transport-sse';
export type { McpToolProvider, McpSseServerOptions } from './lib/mcp-transport-sse';

export { ExtendedMcpTools } from './lib/mcp-tools-extended';
export type { IBudget, ITokenManager, ExtendedMcpToolsOptions } from './lib/mcp-tools-extended';

export { ControlMcpTools } from './lib/mcp-tools-control';
export type { IConfig, IAgentStatus, ControlMcpToolsOptions } from './lib/mcp-tools-control';
