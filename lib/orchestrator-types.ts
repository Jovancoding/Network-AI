/**
 * Shared type definitions, configuration, and default profiles for the
 * SwarmOrchestrator engine.
 *
 * Extracted from index.ts to break the god-file pattern. All types are
 * re-exported from the main index.ts barrel.
 *
 * @module OrchestratorTypes
 */

import type { BlackboardBackend } from './blackboard-backend';
import type { ConsistencyLevel } from './consistency';
import type { ValidationConfig } from './blackboard-validator';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Backward-compatible OpenClaw skill interface.
 * The system works without openclaw-core — this keeps the contract.
 */
export type OpenClawSkill = {
  name: string;
  version: string;
  execute(action: string, params: Record<string, unknown>, context: SkillContext): Promise<SkillResult>;
};

/**
 * Execution context passed to every skill invocation.
 * Identifies the calling agent and associates the call with a task/session.
 */
export interface SkillContext {
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
export interface SkillResult {
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
export interface TaskPayload {
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
export interface HandoffMessage {
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
export interface PermissionGrant {
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
export interface SwarmState {
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
export interface AgentStatus {
  /** Unique agent identifier */
  agentId: string;
  /** Current operational state */
  status: 'available' | 'busy' | 'waiting_auth' | 'offline';
  /** ID of the task currently being executed, or null */
  currentTask: string | null;
  /** ISO 8601 timestamp of the last heartbeat */
  lastHeartbeat: string;
}

export interface TaskRecord {
  taskId: string;
  agentId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  startedAt: string;
  description: string;
}

/** A single entry stored on the shared blackboard. */
export interface BlackboardEntry {
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
export interface ActiveGrant {
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
export interface ResourceProfile {
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
export interface AgentTrustConfig {
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
export interface ParallelTask {
  /** Agent type or adapter-prefixed ID to route the task to */
  agentType: string;
  /** The task payload to execute */
  taskPayload: TaskPayload;
}

/** Result of a parallel execution batch, including synthesis and metrics. */
export interface ParallelExecutionResult {
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
export type SynthesisStrategy = 'merge' | 'vote' | 'chain' | 'first-success';

// ============================================================================
// CONFIGURATION
// ============================================================================

export const CONFIG = {
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

export const DEFAULT_RESOURCE_PROFILES: Record<string, ResourceProfile> = {
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

export const DEFAULT_AGENT_TRUST: AgentTrustConfig[] = [
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
