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
import { ValidationError } from './errors';

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
  /**
   * Tool names / targets matching any of these are denied outright (checked first).
   * Invalid, oversized (>512 chars), or nested-quantifier patterns throw at construction.
   */
  denyPatterns?: Array<string | RegExp>;
  /**
   * Tool names / targets matching any of these are allowed without gating.
   * Matched against the tool name and primary target only, never other fields.
   */
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
  /**
   * Maximum length (in characters) of the extracted target string that will
   * be evaluated for deny/allow pattern matching. Targets longer than this
   * are DENIED outright (fail closed) instead of matched. This closes the
   * truncation-vs-execution mismatch where a security decision made against
   * a shortened preview could differ from the full command Claude Code
   * actually executes (GHSA-743h-jr5x-mpcr), and bounds regex evaluation
   * cost against unbounded attacker-supplied strings. Default: 65536 (64 KiB)
   * — far beyond any realistic single command/path/URL/prompt field.
   */
  maxTargetLength?: number;
  /**
   * Maximum total characters across all string values in `tool_input` that
   * deny patterns will inspect. Inputs beyond this (or nested deeper than 32
   * levels) are denied outright when any deny pattern is configured, since
   * they cannot be fully checked (GHSA-9p2w-prp8-5722). Default: 1,048,576.
   */
  maxInputLength?: number;
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

/**
 * Extract the most meaningful target string from a tool input, IN FULL —
 * used for security-critical deny/allow pattern matching. This MUST NOT be
 * truncated: Claude Code always executes the complete, untruncated tool
 * input, so any truncation here would let dangerous content beyond the cut
 * point evade `denyPatterns` while still running (GHSA-743h-jr5x-mpcr).
 */
function extractFullTarget(toolName: string, toolInput: Record<string, unknown> | undefined): string {
  if (!toolInput) return toolName;
  const candidates = ['command', 'file_path', 'filePath', 'path', 'url', 'query', 'pattern', 'prompt'];
  for (const key of candidates) {
    const v = toolInput[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  try {
    return JSON.stringify(toolInput);
  } catch {
    return toolName;
  }
}

/**
 * Collect every string value in a tool input, recursively. Deny patterns are
 * matched against all of them so a payload in a non-primary field (Write
 * `content`, Edit `new_string`, an MCP tool's `script`) cannot hide behind a
 * benign primary field (GHSA-9p2w-prp8-5722). Returns false when nesting
 * exceeds MAX_INPUT_DEPTH, meaning the input could not be fully inspected.
 */
function collectInputStrings(value: unknown, out: string[], depth = 0): boolean {
  if (typeof value === 'string') {
    out.push(value);
    return true;
  }
  if (value === null || typeof value !== 'object') return true;
  if (depth >= MAX_INPUT_DEPTH) return false;
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const child of children) {
    if (!collectInputStrings(child, out, depth + 1)) return false;
  }
  return true;
}

const MAX_INPUT_DEPTH = 32;

/**
 * Shorten a target string for audit-log / decision-reason DISPLAY only.
 * Never use this output for security matching — see {@link extractFullTarget}.
 */
function truncateForDisplay(target: string, maxLen = 500): string {
  return target.length > maxLen
    ? `${target.slice(0, maxLen)}…[+${target.length - maxLen} more chars]`
    : target;
}

/** Maximum length of a single deny/allow regex pattern source. */
const MAX_PATTERN_LENGTH = 512;

/**
 * Reject pattern shapes prone to catastrophic backtracking (ReDoS): a
 * quantified group that itself contains a quantifier, e.g. `(a+)+`, `(\w*)*`,
 * `(a|b+){2,}`. Escaped characters and character classes are skipped.
 */
function hasNestedQuantifier(source: string): boolean {
  const groupHasQuantifier: boolean[] = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') { i++; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') { inClass = true; continue; }
    if (ch === '(') { groupHasQuantifier.push(false); continue; }
    if (ch === ')') {
      const inner = groupHasQuantifier.pop() ?? false;
      const next = source[i + 1];
      const quantified = next === '*' || next === '+' || next === '{' || next === '?';
      if (inner && quantified && next !== '?') return true;
      if (inner || quantified) {
        if (groupHasQuantifier.length > 0) groupHasQuantifier[groupHasQuantifier.length - 1] = true;
      }
      continue;
    }
    if ((ch === '*' || ch === '+' || ch === '{') && groupHasQuantifier.length > 0) {
      groupHasQuantifier[groupHasQuantifier.length - 1] = true;
    }
  }
  return false;
}

/**
 * Validate an operator-supplied regex source. Deny/allow patterns are
 * intentionally regexes, so they are validated rather than escaped: throws
 * on oversized or backtracking-prone sources, otherwise returns it unchanged.
 */
function sanitizeRegExp(source: string, label: string): string {
  if (source.length === 0 || source.length > MAX_PATTERN_LENGTH) {
    throw new ValidationError(`${label} must be 1-${MAX_PATTERN_LENGTH} characters`);
  }
  if (hasNestedQuantifier(source)) {
    throw new ValidationError(`${label} contains a nested quantifier prone to catastrophic backtracking: ${source}`);
  }
  return source;
}

/**
 * Compile and validate deny/allow patterns once, up front. A bad pattern
 * throws so it fails closed instead of silently disabling the deny list or
 * hanging the hook until it times out (which Claude Code treats as allow).
 */
function compilePatterns(patterns: Array<string | RegExp> | undefined, name: string): RegExp[] {
  if (!patterns) return [];
  return patterns.map((p, idx) => {
    const label = `${name}[${idx}]`;
    if (typeof p !== 'string' && !(p instanceof RegExp)) {
      throw new ValidationError(`${label} must be a string or RegExp`);
    }
    const source = sanitizeRegExp(typeof p === 'string' ? p : p.source, label);
    // Drop stateful g/y flags: RegExp.test() with them carries lastIndex
    // across calls, which can make a deny pattern intermittently miss.
    const flags = typeof p === 'string' ? 'i' : p.flags.replace(/[gy]/g, '');
    try {
      return new RegExp(source, flags);
    } catch (err) {
      throw new ValidationError(`${label} is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

/** Test whether any compiled pattern matches any of the given strings */
function matchesAny(patterns: RegExp[], values: string[]): boolean {
  for (const re of patterns) {
    for (const v of values) {
      if (re.test(v)) return true;
    }
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
  private readonly denyPatterns: RegExp[];
  private readonly allowPatterns: RegExp[];
  private readonly toolResourceMap: Record<string, string>;
  private readonly blockedDecision: 'deny' | 'ask';
  private readonly auditLogPath: string | null;
  private readonly onAudit: ((entry: HookAuditEntry) => void) | null;
  private readonly maxTargetLength: number;
  private readonly maxInputLength: number;

  constructor(options: ClaudeHookBridgeOptions = {}) {
    this.agentId = options.agentId ?? 'claude-code';
    this.mode = options.mode ?? 'observe';
    this.denyPatterns = compilePatterns(options.denyPatterns, 'denyPatterns');
    this.allowPatterns = compilePatterns(options.allowPatterns, 'allowPatterns');
    this.toolResourceMap = { ...DEFAULT_TOOL_RESOURCE_MAP, ...(options.toolResourceMap ?? {}) };
    this.blockedDecision = options.blockedDecision ?? 'ask';
    this.auditLogPath = options.auditLogPath ? path.resolve(options.auditLogPath) : null;
    this.onAudit = options.onAudit ?? null;
    this.maxTargetLength = options.maxTargetLength ?? 65_536;
    this.maxInputLength = options.maxInputLength ?? 1_048_576;

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
    const fullTarget = extractFullTarget(toolName, input.tool_input);
    const displayTarget = truncateForDisplay(fullTarget);

    // 0. Fail closed on oversized targets (GHSA-743h-jr5x-mpcr): evaluating
    // patterns against an unbounded string both reopens truncation-flavored
    // bypasses and risks pathological regex cost, so deny outright instead
    // of attempting to match.
    if (fullTarget.length > this.maxTargetLength) {
      const blocked = this.mode === 'enforce' ? this.blockedDecision : 'deny';
      return this.decide(input, toolName, displayTarget, blocked,
        `Target exceeds maxTargetLength (${fullTarget.length} > ${this.maxTargetLength} chars) — denied for safe evaluation`);
    }

    // 1. Hard deny list — matched against the tool name, the FULL primary
    // target, and every string value in the tool input, so dangerous content
    // can hide neither past a truncation point (GHSA-743h-jr5x-mpcr) nor in a
    // non-primary field (GHSA-9p2w-prp8-5722).
    if (this.denyPatterns.length > 0) {
      const fields: string[] = [];
      const complete = collectInputStrings(input.tool_input, fields);
      const totalLength = fields.reduce((n, s) => n + s.length, 0);
      if (!complete || totalLength > this.maxInputLength) {
        const blocked = this.mode === 'enforce' ? this.blockedDecision : 'deny';
        return this.decide(input, toolName, displayTarget, blocked,
          `Tool input too large or deeply nested to check against deny patterns (${totalLength} chars) — denied for safe evaluation`);
      }
      if (matchesAny(this.denyPatterns, [toolName, fullTarget, ...fields])) {
        return this.decide(input, toolName, displayTarget, 'deny',
          `Blocked by Network-AI deny pattern (tool: ${toolName})`);
      }
    }

    // 2. Explicit allow list — tool name and primary target only; matching
    // any field would let an attacker add a benign field to earn an allow.
    if (matchesAny(this.allowPatterns, [toolName, fullTarget])) {
      return this.decide(input, toolName, displayTarget, 'allow',
        `Allowed by Network-AI allow pattern (tool: ${toolName})`);
    }

    // 3. Observe mode: audit, never block
    if (this.mode === 'observe' || !this.guardian) {
      return this.decide(input, toolName, displayTarget, 'allow',
        'Network-AI observe mode — call audited, not gated');
    }

    // 4. Enforce mode: AuthGuardian weighted permission scoring
    const resourceType = this.toolResourceMap[toolName]
      ?? (toolName.startsWith('mcp__') ? 'EXTERNAL_SERVICE' : 'EXTERNAL_SERVICE');
    const template = JUSTIFICATION_TEMPLATES[resourceType] ?? JUSTIFICATION_TEMPLATES['EXTERNAL_SERVICE'];
    const justification = template(toolName, displayTarget);

    const grant = await this.guardian.requestPermission(
      this.agentId, resourceType, justification, toolName
    );

    if (grant.granted) {
      return this.decide(input, toolName, displayTarget, 'allow',
        `AuthGuardian granted ${resourceType} (restrictions: ${grant.restrictions.join(', ') || 'none'})`);
    }
    return this.decide(input, toolName, displayTarget, this.blockedDecision,
      `AuthGuardian denied ${resourceType}: ${grant.reason ?? 'permission not granted'}`);
  }

  /**
   * Handle a PostToolUse event: audit the completed call. Never blocks.
   * Returns an empty object (the hook-protocol no-op).
   */
  async handlePostToolUse(input: ClaudeHookInput): Promise<Record<string, never>> {
    const toolName = input.tool_name ?? 'unknown';
    const target = truncateForDisplay(extractFullTarget(toolName, input.tool_input));
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
