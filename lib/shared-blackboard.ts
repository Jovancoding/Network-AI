/**
 * Namespace-scoped, identity-verified shared state for multi-agent coordination.
 *
 * Every write is identity-verified (agent token), namespace-checked,
 * size-validated, input-sanitized, and atomically persisted through
 * the pluggable {@link BlackboardBackend}.
 *
 * @module SharedBlackboard
 */

import { FileBackend } from './blackboard-backend';
import type { BlackboardBackend } from './blackboard-backend';
import { InputSanitizer, PIIRedactor } from '../security';
import {
  IdentityVerificationError,
  NamespaceViolationError,
  ValidationError,
} from './errors';
import { CONFIG } from './orchestrator-types';
import type { BlackboardEntry } from './orchestrator-types';

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
export class SharedBlackboard {
  private backend: BlackboardBackend;
  private agentTokens: Map<string, string> = new Map(); // agentId -> verified token
  private agentNamespaces: Map<string, string[]> = new Map(); // agentId -> allowed prefixes
  private piiRedactor: PIIRedactor | null = null;

  constructor(backendOrPath: string | BlackboardBackend, options?: { enablePIIRedaction?: boolean }) {
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
    if (options?.enablePIIRedaction) {
      this.piiRedactor = new PIIRedactor();
    }
  }

  /**
   * Enable or disable PII redaction on writes.
   */
  setPIIRedaction(enabled: boolean): void {
    this.piiRedactor = enabled ? new PIIRedactor() : null;
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

    // 5b. PII redaction -- strip emails, SSNs, credit cards, phones, IPs
    if (this.piiRedactor) {
      const { redacted } = this.piiRedactor.redactObject(sanitizedValue);
      sanitizedValue = redacted;
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
