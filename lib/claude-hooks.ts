/**
 * Claude Code Hooks Bridge — AuthGuardian-gated tool calls for coding agents.
 *
 * Claude Code (and other hook-capable agent CLIs) can call an external
 * command on every tool use (PreToolUse / PostToolUse hooks). This module
 * turns Network-AI into that command: every tool call an agent makes is
 * audited — and optionally permission-gated — through the same
 * `AuthGuardian` weighted scoring used for swarm agents (justification 40%,
 * trust 30%, risk 30%).
 *
 * Two modes:
 * - `'observe'` (default) — every tool call is audit-logged, nothing is
 *   blocked. Zero-risk visibility into what the agent is doing.
 * - `'enforce'` — tool calls are mapped to Network-AI resource types
 *   (Bash → SHELL_EXEC, Write/Edit → FILE_SYSTEM, WebFetch →
 *   EXTERNAL_SERVICE, …) and must pass `AuthGuardian.requestPermission()`.
 *   Denied calls return `'ask'` (escalate to the human) or `'deny'`.
 *
 * Wire-up (Claude Code `settings.json`):
 * ```json
 * {
 *   "hooks": {
 *     "PreToolUse": [{
 *       "matcher": "Bash|Write|Edit|WebFetch",
 *       "hooks": [{ "type": "command",
 *                   "command": "npx -y -p network-ai network-ai hook pre-tool-use --mode enforce" }]
 *     }]
 *   }
 * }
 * ```
 * See `examples/claude-code-hooks.json` for a complete config.
 *
 * @module ClaudeHooks
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { AuthGuardian } from './auth-guardian';

// ============================================================================
// TYPES
// ============================================================================

/** Hook events supported by the bridge */
export type ClaudeHookEvent = 'PreToolUse' | 'PostToolUse';

/** JSON payload Claude Code writes to the hook's stdin */
export interface ClaudeHookInput {
  /** Claude Code session identifier */
  session_id?: string;
  /** Path to the session transcript */
  transcript_path?: string;
  /** Working directory of the session */
  cwd?: string;
  /** Which hook event fired */
  hook_event_name: string;
  /** Tool being invoked — e.g. 'Bash', 'Write', 'mcp__github__create_issue' */
  tool_name?: string;
  /** Tool input parameters (shape depends on the tool) */
  tool_input?: Record<string, unknown>;
  /** Tool response (PostToolUse only) */
  tool_response?: unknown;
}

/** Permission decision for a PreToolUse hook */
export type HookPermissionDecision = 'allow' | 'deny' | 'ask';

/** JSON the bridge writes to stdout for PreToolUse */
export interface PreToolUseHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: HookPermissionDecision;
    permissionDecisionReason: string;
  };
}

/** Audit entry emitted for every processed hook call */
export interface HookAuditEntry {
  timestamp: string;
  event: ClaudeHookEvent;
  toolName: string;
  target: string;
  decision?: HookPermissionDecision;
  reason?: string;
  sessionId?: string;
  agentId: string;
  mode: 'observe' | 'enforce';
}

/** Options for the ClaudeHookBridge */
export interface ClaudeHookBridgeOptions {
  /** Existing AuthGuardian to gate through. Auto-created in enforce mode if omitted. */
  guardian?: AuthGuardian;
  /** Agent identity used for permission requests (default: 'claude-code') */
  agentId?: string;
  /** 'observe' (audit only, default) or 'enforce' (AuthGuardian-gated) */
  mode?: 'observe' | 'enforce';
  /** Trust level for the auto-created guardian identity (default: 0.7) */
  trustLevel?: number;
  /** Tool names / targets matching any of these are denied outright (checked first) */
  denyPatterns?: Array<string | RegExp>;
  /** Tool names / targets matching any of these are allowed without gating */
  allowPatterns?: Array<string | RegExp>;
  /** Override the tool → resource-type mapping (merged over the defaults) */
  toolResourceMap?: Record<string, string>;
  /** Decision to return when the guardian denies: 'ask' escalates to the human (default), 'deny' blocks */
  blockedDecision?: 'deny' | 'ask';
  /** JSONL file to append hook audit entries to (observe mode has no guardian log) */
  auditLogPath?: string;
  /** Audit log path for the auto-created guardian (defaults to AuthGuardian's standard path) */
  guardianAuditLogPath?: string;
  /** Trust config path for the auto-created guardian */
  trustConfigPath?: string;
  /** Callback invoked with every audit entry */
  onAudit?: (entry: HookAuditEntry) => void;
}

// ============================================================================
// DEFAULTS
// ============================================================================

/**
 * Default mapping from Claude Code tool names to Network-AI resource types.
 * MCP tools (`mcp__*`) and unknown tools map to EXTERNAL_SERVICE.
 */
export const DEFAULT_TOOL_RESOURCE_MAP: Record<string, string> = {
  Bash: 'SHELL_EXEC',
  BashOutput: 'SHELL_EXEC',
  KillShell: 'SHELL_EXEC',
  Write: 'FILE_SYSTEM',
  Edit: 'FILE_SYSTEM',
  MultiEdit: 'FILE_SYSTEM',
  NotebookEdit: 'FILE_SYSTEM',
  Read: 'FILE_SYSTEM',
  Glob: 'FILE_SYSTEM',
  Grep: 'FILE_SYSTEM',
  WebFetch: 'EXTERNAL_SERVICE',
  WebSearch: 'EXTERNAL_SERVICE',
  Task: 'EXTERNAL_SERVICE',
};

/** Justification templates per resource type — phrased to carry the
 *  resource-relevant context AuthGuardian's scorer checks for. */
const JUSTIFICATION_TEMPLATES: Record<string, (tool: string, target: string) => string> = {
  SHELL_EXEC: (tool, target) =>
    `Execute shell command via ${tool} in order to complete the current coding task: ${target}`,
  FILE_SYSTEM: (tool, target) =>
    `Access workspace file via ${tool} in order to complete the current coding task: ${target}`,
  GIT: (tool, target) =>
    `Perform git repository operation via ${tool} in order to complete the current coding task: ${target}`,
  EXTERNAL_SERVICE: (tool, target) =>
    `Fetch external api endpoint via ${tool} in order to complete the current coding task: ${target}`,
};

// ============================================================================
// HELPERS
// ============================================================================

/** Extract the most meaningful target string from a tool input */
function extractTarget(toolName: string, toolInput: Record<string, unknown> | undefined): string {
  if (!toolInput) return toolName;
  const candidates = ['command', 'file_path', 'filePath', 'path', 'url', 'query', 'pattern', 'prompt'];
  for (const key of candidates) {
    const v = toolInput[key];
    if (typeof v === 'string' && v.length > 0) return v.slice(0, 500);
  }
  try {
    return JSON.stringify(toolInput).slice(0, 300);
  } catch {
    return toolName;
  }
}

/** Test a tool name / target against a pattern list */
function matchesAny(patterns: Array<string | RegExp> | undefined, toolName: string, target: string): boolean {
  if (!patterns || patterns.length === 0) return false;
  for (const p of patterns) {
    const re = typeof p === 'string' ? new RegExp(p, 'i') : p;
    if (re.test(toolName) || re.test(target)) return true;
  }
  return false;
}

// ============================================================================
// CLAUDE HOOK BRIDGE
// ============================================================================

/**
 * Bridges coding-agent hook events (Claude Code PreToolUse / PostToolUse)
 * into Network-AI's AuthGuardian permission system and audit trail.
 */
export class ClaudeHookBridge {
  private readonly guardian: AuthGuardian | null;
  private readonly agentId: string;
  private readonly mode: 'observe' | 'enforce';
  private readonly denyPatterns: Array<string | RegExp>;
  private readonly allowPatterns: Array<string | RegExp>;
  private readonly toolResourceMap: Record<string, string>;
  private readonly blockedDecision: 'deny' | 'ask';
  private readonly auditLogPath: string | null;
  private readonly onAudit: ((entry: HookAuditEntry) => void) | null;

  constructor(options: ClaudeHookBridgeOptions = {}) {
    this.agentId = options.agentId ?? 'claude-code';
    this.mode = options.mode ?? 'observe';
    this.denyPatterns = options.denyPatterns ?? [];
    this.allowPatterns = options.allowPatterns ?? [];
    this.toolResourceMap = { ...DEFAULT_TOOL_RESOURCE_MAP, ...(options.toolResourceMap ?? {}) };
    this.blockedDecision = options.blockedDecision ?? 'ask';
    this.auditLogPath = options.auditLogPath ? path.resolve(options.auditLogPath) : null;
    this.onAudit = options.onAudit ?? null;

    if (options.guardian) {
      this.guardian = options.guardian;
    } else if (this.mode === 'enforce') {
      // Auto-create a guardian with a trust identity for this agent.
      this.guardian = new AuthGuardian({
        trustLevels: [{
          agentId: this.agentId,
          trustLevel: options.trustLevel ?? 0.7,
          allowedNamespaces: ['*'],
          allowedResources: ['*'],
        }],
        ...(options.guardianAuditLogPath ? { auditLogPath: options.guardianAuditLogPath } : {}),
        ...(options.trustConfigPath ? { trustConfigPath: options.trustConfigPath } : {}),
      });
    } else {
      this.guardian = null;
    }
  }

  /**
   * Parse a raw hook stdin payload. Tolerates a leading UTF-8 BOM (some
   * shells prepend one when piping). Throws on malformed JSON or a payload
   * that is not an object.
   */
  static parseInput(raw: string): ClaudeHookInput {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.replace(/^\uFEFF/, '').trim());
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`ClaudeHookBridge: invalid hook input JSON — ${detail}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('ClaudeHookBridge: hook input must be a JSON object');
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj['hook_event_name'] !== 'string') {
      throw new Error('ClaudeHookBridge: hook input missing hook_event_name');
    }
    return obj as unknown as ClaudeHookInput;
  }

  /**
   * Handle a PreToolUse event: decide allow / deny / ask.
   *
   * Decision order: denyPatterns → allowPatterns → observe-mode allow →
   * AuthGuardian permission request (enforce mode).
   */
  async handlePreToolUse(input: ClaudeHookInput): Promise<PreToolUseHookOutput> {
    const toolName = input.tool_name ?? 'unknown';
    const target = extractTarget(toolName, input.tool_input);

    // 1. Hard deny list
    if (matchesAny(this.denyPatterns, toolName, target)) {
      return this.decide(input, toolName, target, 'deny',
        `Blocked by Network-AI deny pattern (tool: ${toolName})`);
    }

    // 2. Explicit allow list
    if (matchesAny(this.allowPatterns, toolName, target)) {
      return this.decide(input, toolName, target, 'allow',
        `Allowed by Network-AI allow pattern (tool: ${toolName})`);
    }

    // 3. Observe mode: audit, never block
    if (this.mode === 'observe' || !this.guardian) {
      return this.decide(input, toolName, target, 'allow',
        'Network-AI observe mode — call audited, not gated');
    }

    // 4. Enforce mode: AuthGuardian weighted permission scoring
    const resourceType = this.toolResourceMap[toolName]
      ?? (toolName.startsWith('mcp__') ? 'EXTERNAL_SERVICE' : 'EXTERNAL_SERVICE');
    const template = JUSTIFICATION_TEMPLATES[resourceType] ?? JUSTIFICATION_TEMPLATES['EXTERNAL_SERVICE'];
    const justification = template(toolName, target);

    const grant = await this.guardian.requestPermission(
      this.agentId, resourceType, justification, toolName
    );

    if (grant.granted) {
      return this.decide(input, toolName, target, 'allow',
        `AuthGuardian granted ${resourceType} (restrictions: ${grant.restrictions.join(', ') || 'none'})`);
    }
    return this.decide(input, toolName, target, this.blockedDecision,
      `AuthGuardian denied ${resourceType}: ${grant.reason ?? 'permission not granted'}`);
  }

  /**
   * Handle a PostToolUse event: audit the completed call. Never blocks.
   * Returns an empty object (the hook-protocol no-op).
   */
  async handlePostToolUse(input: ClaudeHookInput): Promise<Record<string, never>> {
    const toolName = input.tool_name ?? 'unknown';
    const target = extractTarget(toolName, input.tool_input);
    this.audit({
      timestamp: new Date().toISOString(),
      event: 'PostToolUse',
      toolName,
      target,
      sessionId: input.session_id,
      agentId: this.agentId,
      mode: this.mode,
    });
    return {};
  }

  /**
   * Dispatch a hook input by its `hook_event_name`.
   */
  async handle(input: ClaudeHookInput): Promise<PreToolUseHookOutput | Record<string, never>> {
    if (input.hook_event_name === 'PreToolUse') return this.handlePreToolUse(input);
    if (input.hook_event_name === 'PostToolUse') return this.handlePostToolUse(input);
    throw new Error(`ClaudeHookBridge: unsupported hook event "${input.hook_event_name}"`);
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private decide(
    input: ClaudeHookInput,
    toolName: string,
    target: string,
    decision: HookPermissionDecision,
    reason: string
  ): PreToolUseHookOutput {
    this.audit({
      timestamp: new Date().toISOString(),
      event: 'PreToolUse',
      toolName,
      target,
      decision,
      reason,
      sessionId: input.session_id,
      agentId: this.agentId,
      mode: this.mode,
    });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    };
  }

  private audit(entry: HookAuditEntry): void {
    try {
      this.onAudit?.(entry);
    } catch {
      /* observer errors must never break the hook */
    }
    if (this.auditLogPath) {
      try {
        fs.mkdirSync(path.dirname(this.auditLogPath), { recursive: true });
        fs.appendFileSync(this.auditLogPath, JSON.stringify(entry) + '\n', 'utf8');
      } catch {
        /* audit-write failures must never break the hook */
      }
    }
  }
}
