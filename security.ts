/**
 * SwarmOrchestrator Security Module
 * 
 * This module addresses security vulnerabilities in the multi-agent system:
 * 
 * 1. Token Security - HMAC-signed tokens with expiration
 * 2. Input Sanitization - Prevent injection attacks
 * 3. Rate Limiting - Prevent DoS from rogue agents
 * 4. Audit Integrity - Cryptographically signed audit logs
 * 5. Data Encryption - Encrypt sensitive blackboard entries
 * 6. Permission Hardening - Prevent privilege escalation
 * 7. Path Traversal Protection - Sanitize file paths
 * 
 * @module SwarmSecurity
 * @version 1.0.0
 */

import { createHmac, createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join, normalize, isAbsolute } from 'path';

// ============================================================================
// SECURITY CONFIGURATION
// ============================================================================

interface SecurityConfig {
  // Token settings
  tokenSecret: string;
  tokenAlgorithm: 'sha256' | 'sha512';
  maxTokenAge: number; // milliseconds
  
  // Rate limiting
  maxRequestsPerMinute: number;
  maxFailedAuthAttempts: number;
  lockoutDuration: number; // milliseconds
  
  // Encryption
  encryptionKey: string;
  encryptSensitiveData: boolean;
  
  // Audit
  signAuditLogs: boolean;
  auditLogPath: string;
  
  // Paths
  allowedBasePath: string;
}

const DEFAULT_CONFIG: SecurityConfig = {
  tokenSecret: process.env.SWARM_TOKEN_SECRET || randomBytes(32).toString('hex'),
  tokenAlgorithm: 'sha256',
  maxTokenAge: 300000, // 5 minutes
  
  maxRequestsPerMinute: 100,
  maxFailedAuthAttempts: 5,
  lockoutDuration: 900000, // 15 minutes
  
  encryptionKey: process.env.SWARM_ENCRYPTION_KEY || randomBytes(32).toString('hex'),
  encryptSensitiveData: true,
  
  signAuditLogs: true,
  auditLogPath: './security-audit.log',
  
  allowedBasePath: process.cwd(),
};

// ============================================================================
// 1. SECURE TOKEN MANAGER
// ============================================================================

interface SecureToken {
  tokenId: string;
  agentId: string;
  resourceType: string;
  scope: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

/**
 * Cryptographically signed token manager using HMAC.
 *
 * Generates, validates, and revokes tokens with configurable expiration.
 * Uses constant-time comparison to prevent timing attacks.
 *
 * @example
 * ```typescript
 * const mgr = new SecureTokenManager({ maxTokenAge: 60000 });
 * const token = mgr.generateToken('agent-1', 'DATABASE', 'read');
 * const { valid } = mgr.validateToken(token);
 * ```
 */
export class SecureTokenManager {
  private config: SecurityConfig;
  private revokedTokens: Set<string> = new Set();
  
  constructor(config: Partial<SecurityConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  
  /**
   * Generate a cryptographically signed token
   */
  generateToken(agentId: string, resourceType: string, scope: string): SecureToken {
    const tokenId = randomBytes(16).toString('hex');
    const issuedAt = Date.now();
    const expiresAt = issuedAt + this.config.maxTokenAge;
    
    // Create token payload
    const payload = `${tokenId}:${agentId}:${resourceType}:${scope}:${issuedAt}:${expiresAt}`;
    
    // Sign the payload
    const signature = this.sign(payload);
    
    return {
      tokenId,
      agentId,
      resourceType,
      scope,
      issuedAt,
      expiresAt,
      signature,
    };
  }
  
  /**
   * Validate a token's authenticity and expiration
   */
  validateToken(token: SecureToken): { valid: boolean; reason?: string } {
    // Check if revoked
    if (this.revokedTokens.has(token.tokenId)) {
      return { valid: false, reason: 'Token has been revoked' };
    }
    
    // Check expiration
    if (Date.now() > token.expiresAt) {
      return { valid: false, reason: 'Token has expired' };
    }
    
    // Verify signature
    const payload = `${token.tokenId}:${token.agentId}:${token.resourceType}:${token.scope}:${token.issuedAt}:${token.expiresAt}`;
    const expectedSignature = this.sign(payload);
    
    if (!this.constantTimeCompare(token.signature, expectedSignature)) {
      return { valid: false, reason: 'Invalid token signature' };
    }
    
    return { valid: true };
  }
  
  /**
   * Revoke a token
   */
  revokeToken(tokenId: string): void {
    this.revokedTokens.add(tokenId);
  }
  
  /**
   * HMAC sign a payload
   */
  private sign(payload: string): string {
    return createHmac(this.config.tokenAlgorithm, this.config.tokenSecret)
      .update(payload)
      .digest('hex');
  }
  
  /**
   * Constant-time string comparison to prevent timing attacks
   */
  private constantTimeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  }
}

// ============================================================================
// 2. INPUT SANITIZER
// ============================================================================

/**
 * Static utility for sanitizing user-supplied strings, objects, agent IDs,
 * and file paths. Strips XSS payloads, template injection, command injection
 * characters, and prototype pollution attempts.
 *
 * All methods are static — no instantiation required.
 *
 * @example
 * ```typescript
 * const safe = InputSanitizer.sanitizeString(userInput, 2000);
 * const safeObj = InputSanitizer.sanitizeObject(payload);
 * const safeId = InputSanitizer.sanitizeAgentId(rawId);
 * ```
 */
export class InputSanitizer {
  // Dangerous patterns that could indicate injection attempts
  private static DANGEROUS_PATTERNS = [
    /\$\{.*\}/g,           // Template injection
    /<script.*?>.*?<\/script>/gi, // XSS
    /javascript:/gi,        // JavaScript protocol
    /on\w+\s*=/gi,         // Event handlers
    /\.\.\//g,             // Path traversal
    /[;&|`$]/g,            // Command injection chars
    /__proto__/gi,         // Prototype pollution
    /constructor/gi,       // Prototype pollution
  ];
  
  /**
   * Sanitize a string input
   */
  static sanitizeString(input: string, maxLength: number = 10000): string {
    if (typeof input !== 'string') {
      throw new SecurityError('Input must be a string', 'INVALID_INPUT_TYPE');
    }
    
    // Truncate to max length
    let sanitized = input.slice(0, maxLength);
    
    // Remove dangerous patterns
    for (const pattern of this.DANGEROUS_PATTERNS) {
      sanitized = sanitized.replace(pattern, '');
    }
    
    // Encode special characters
    sanitized = sanitized
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
    
    return sanitized;
  }
  
  /**
   * Sanitize an object recursively
   */
  static sanitizeObject(obj: unknown, depth: number = 0, maxDepth: number = 10): unknown {
    if (depth > maxDepth) {
      throw new SecurityError('Object nesting too deep', 'MAX_DEPTH_EXCEEDED');
    }
    
    if (obj === null || obj === undefined) {
      return obj;
    }
    
    if (typeof obj === 'string') {
      return this.sanitizeString(obj);
    }
    
    if (typeof obj === 'number' || typeof obj === 'boolean') {
      return obj;
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.sanitizeObject(item, depth + 1, maxDepth));
    }
    
    if (typeof obj === 'object') {
      const sanitized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        // Sanitize keys too
        const sanitizedKey = this.sanitizeString(key, 100);
        
        // Block prototype pollution attempts
        if (sanitizedKey === '__proto__' || sanitizedKey === 'constructor' || sanitizedKey === 'prototype') {
          continue;
        }
        
        sanitized[sanitizedKey] = this.sanitizeObject(value, depth + 1, maxDepth);
      }
      return sanitized;
    }
    
    return undefined; // Unknown types are dropped
  }
  
  /**
   * Validate and sanitize an agent ID
   */
  static sanitizeAgentId(agentId: string): string {
    if (typeof agentId !== 'string' || agentId.length === 0) {
      throw new SecurityError('Invalid agent ID', 'INVALID_AGENT_ID');
    }
    
    // Agent IDs should be alphanumeric with underscores/hyphens only
    const sanitized = agentId.replace(/[^a-zA-Z0-9_-]/g, '');
    
    if (sanitized.length === 0 || sanitized.length > 64) {
      throw new SecurityError('Agent ID format invalid', 'INVALID_AGENT_ID_FORMAT');
    }
    
    return sanitized;
  }
  
  /**
   * Validate and sanitize a file path
   */
  static sanitizePath(inputPath: string, basePath: string): string {
    // Normalize the path
    const normalized = normalize(inputPath);
    
    // Resolve to absolute
    const absolute = isAbsolute(normalized) 
      ? normalized 
      : join(basePath, normalized);
    
    // Ensure it's within the allowed base path
    const resolvedBase = normalize(basePath);
    const resolvedPath = normalize(absolute);
    
    if (!resolvedPath.startsWith(resolvedBase)) {
      throw new SecurityError('Path traversal attempt detected', 'PATH_TRAVERSAL');
    }
    
    return resolvedPath;
  }
}

// ============================================================================
// 3. RATE LIMITER
// ============================================================================

interface RateLimitEntry {
  count: number;
  windowStart: number;
  failedAttempts: number;
  lockedUntil: number | null;
}

/**
 * Per-agent rate limiter with sliding window and lockout on repeated
 * authentication failures. Prevents DoS from rogue agents.
 *
 * @example
 * ```typescript
 * const limiter = new RateLimiter({ maxRequestsPerMinute: 50 });
 * const { limited } = limiter.isRateLimited('agent-1');
 * if (limited) { /* back off *\/ }
 * ```
 */
export class RateLimiter {
  private limits: Map<string, RateLimitEntry> = new Map();
  private config: SecurityConfig;
  
  constructor(config: Partial<SecurityConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  
  /**
   * Check if an agent is rate limited
   */
  isRateLimited(agentId: string): { limited: boolean; retryAfter?: number } {
    const entry = this.limits.get(agentId);
    const now = Date.now();
    
    if (!entry) {
      this.limits.set(agentId, {
        count: 1,
        windowStart: now,
        failedAttempts: 0,
        lockedUntil: null,
      });
      return { limited: false };
    }
    
    // Check if locked out
    if (entry.lockedUntil && now < entry.lockedUntil) {
      return { 
        limited: true, 
        retryAfter: Math.ceil((entry.lockedUntil - now) / 1000) 
      };
    }
    
    // Reset window if expired (1 minute)
    if (now - entry.windowStart > 60000) {
      entry.count = 1;
      entry.windowStart = now;
      entry.lockedUntil = null;
      return { limited: false };
    }
    
    // Increment counter
    entry.count++;
    
    // Check if over limit
    if (entry.count > this.config.maxRequestsPerMinute) {
      return { 
        limited: true, 
        retryAfter: Math.ceil((entry.windowStart + 60000 - now) / 1000) 
      };
    }
    
    return { limited: false };
  }
  
  /**
   * Record a failed authentication attempt
   */
  recordFailedAuth(agentId: string): { locked: boolean; attemptsRemaining?: number } {
    const entry = this.limits.get(agentId) || {
      count: 0,
      windowStart: Date.now(),
      failedAttempts: 0,
      lockedUntil: null,
    };
    
    entry.failedAttempts++;
    
    if (entry.failedAttempts >= this.config.maxFailedAuthAttempts) {
      entry.lockedUntil = Date.now() + this.config.lockoutDuration;
      this.limits.set(agentId, entry);
      return { locked: true };
    }
    
    this.limits.set(agentId, entry);
    return { 
      locked: false, 
      attemptsRemaining: this.config.maxFailedAuthAttempts - entry.failedAttempts 
    };
  }
  
  /**
   * Reset failed attempts after successful auth
   */
  resetFailedAttempts(agentId: string): void {
    const entry = this.limits.get(agentId);
    if (entry) {
      entry.failedAttempts = 0;
      entry.lockedUntil = null;
    }
  }
  
  /**
   * Get rate limit status for an agent
   */
  getStatus(agentId: string): RateLimitEntry | null {
    return this.limits.get(agentId) || null;
  }
}

// ============================================================================
// 4. SECURE AUDIT LOGGER
// ============================================================================

interface AuditEntry {
  timestamp: string;
  eventId: string;
  eventType: string;
  agentId: string;
  action: string;
  resource?: string;
  outcome: 'success' | 'failure' | 'denied';
  details: Record<string, unknown>;
  signature?: string;
}

/**
 * Append-only audit logger with HMAC-chained integrity verification.
 *
 * Each entry is signed with a hash that includes the previous entry's
 * signature, forming a tamper-evident chain. Supports verification
 * across process restarts.
 *
 * @example
 * ```typescript
 * const logger = new SecureAuditLogger();
 * logger.log('ACCESS', 'agent-1', 'read_file', 'success', { path: '/data' });
 * const { valid } = logger.verifyLogIntegrity();
 * ```
 */
export class SecureAuditLogger {
  private config: SecurityConfig;
  private previousHash: string = '';
  
  constructor(config: Partial<SecurityConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initializeLog();
  }
  
  private initializeLog(): void {
    const logPath = this.config.auditLogPath;
    if (!existsSync(logPath)) {
      writeFileSync(logPath, '');
    } else {
      // Continue the hash chain from the last entry so integrity
      // verification works across process restarts.
      try {
        const content = readFileSync(logPath, 'utf-8').trim();
        if (content) {
          const lines = content.split('\n').filter((l: string) => l);
          const lastLine = lines[lines.length - 1];
          const lastEntry = JSON.parse(lastLine) as AuditEntry;
          if (lastEntry.signature) {
            this.previousHash = lastEntry.signature;
          }
        }
      } catch {
        // If we can't read the last entry, start fresh chain
      }
    }
  }
  
  /**
   * Log a security event with cryptographic integrity
   */
  log(
    eventType: string,
    agentId: string,
    action: string,
    outcome: 'success' | 'failure' | 'denied',
    details: Record<string, unknown> = {},
    resource?: string
  ): AuditEntry {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      eventId: randomBytes(8).toString('hex'),
      eventType,
      agentId: InputSanitizer.sanitizeAgentId(agentId),
      action,
      resource,
      outcome,
      details: InputSanitizer.sanitizeObject(details) as Record<string, unknown>,
    };
    
    // Sign the entry if configured
    if (this.config.signAuditLogs) {
      const payload = JSON.stringify({
        ...entry,
        previousHash: this.previousHash,
      });
      
      entry.signature = createHmac('sha256', this.config.tokenSecret)
        .update(payload)
        .digest('hex');
      
      this.previousHash = entry.signature ?? '';
    }
    
    // Append to log file
    const logLine = JSON.stringify(entry) + '\n';
    appendFileSync(this.config.auditLogPath, logLine);
    
    return entry;
  }
  
  /**
   * Log a permission request
   */
  logPermissionRequest(
    agentId: string,
    resourceType: string,
    scope: string,
    granted: boolean,
    reason?: string
  ): void {
    this.log(
      'PERMISSION_REQUEST',
      agentId,
      `request_${resourceType}`,
      granted ? 'success' : 'denied',
      { resourceType, scope, reason },
      resourceType
    );
  }
  
  /**
   * Log a security violation
   */
  logViolation(
    agentId: string,
    violationType: string,
    details: Record<string, unknown>
  ): void {
    this.log(
      'SECURITY_VIOLATION',
      agentId,
      violationType,
      'denied',
      details
    );
  }
  
  /**
   * Verify audit log integrity
   */
  verifyLogIntegrity(): { valid: boolean; invalidEntries: number[] } {
    const logContent = readFileSync(this.config.auditLogPath, 'utf-8');
    const lines = logContent.trim().split('\n').filter((l: string) => l);
    
    let previousHash = '';
    const invalidEntries: number[] = [];
    
    for (let i = 0; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]) as AuditEntry;
        
        if (entry.signature) {
          const { signature, ...rest } = entry;
          const payload = JSON.stringify({
            ...rest,
            previousHash,
          });
          
          const expectedSignature = createHmac('sha256', this.config.tokenSecret)
            .update(payload)
            .digest('hex');
          
          if (signature !== expectedSignature) {
            invalidEntries.push(i);
          }
          
          previousHash = signature;
        }
      } catch {
        invalidEntries.push(i);
      }
    }
    
    return {
      valid: invalidEntries.length === 0,
      invalidEntries,
    };
  }
}

// ============================================================================
// 5. DATA ENCRYPTION
// ============================================================================

/**
 * AES-256-GCM encryptor for sensitive blackboard entries.
 *
 * Uses `scryptSync` key derivation with a unique salt per instance.
 * The salt is required for decryption and can be retrieved via {@link getSalt}.
 *
 * @example
 * ```typescript
 * const enc = new DataEncryptor('my-secret-key');
 * const cipher = enc.encrypt('sensitive data');
 * const plain = enc.decrypt(cipher);
 * ```
 */
export class DataEncryptor {
  private key: Buffer;
  private algorithm = 'aes-256-gcm' as const;
  private salt: Buffer;
  
  constructor(encryptionKey: string, salt?: string | Buffer) {
    // Use provided salt or generate a random one
    this.salt = salt 
      ? (typeof salt === 'string' ? Buffer.from(salt, 'hex') : salt)
      : randomBytes(16);
    // Derive a proper key from the provided key with unique salt
    this.key = scryptSync(encryptionKey, this.salt, 32);
  }
  
  /**
   * Get the salt (needed to recreate the same encryptor for decryption)
   */
  getSalt(): string {
    return this.salt.toString('hex');
  }
  
  /**
   * Encrypt sensitive data
   */
  encrypt(data: string): string {
    const iv = randomBytes(16);
    const cipher = createCipheriv(this.algorithm, this.key, iv);
    
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    // Return iv:authTag:encryptedData
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }
  
  /**
   * Decrypt sensitive data
   */
  decrypt(encryptedData: string): string {
    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
      throw new SecurityError('Invalid encrypted data format', 'INVALID_ENCRYPTED_FORMAT');
    }
    
    const [ivHex, authTagHex, encrypted] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    
    const decipher = createDecipheriv(this.algorithm, this.key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }
  
  /**
   * Encrypt an object
   */
  encryptObject(obj: unknown): string {
    return this.encrypt(JSON.stringify(obj));
  }
  
  /**
   * Decrypt to object
   */
  decryptObject<T = unknown>(encryptedData: string): T {
    return JSON.parse(this.decrypt(encryptedData));
  }
}

// ============================================================================
// 6. PERMISSION HARDENING
// ============================================================================

interface TrustPolicy {
  agentId: string;
  trustLevel: number;
  allowedResources: string[];
  maxScope: string[];
  createdBy: string;
  immutable: boolean;
}

/**
 * Trust-policy-based permission hardener with privilege escalation prevention.
 *
 * Manages per-agent trust policies that control which resources and scopes
 * an agent can access. Prevents agents from granting trust levels higher
 * than their own.
 *
 * @example
 * ```typescript
 * const hardener = new PermissionHardener(auditLogger);
 * hardener.registerPolicy({ agentId: 'bot', trustLevel: 0.6, allowedResources: ['DATABASE'] });
 * const { allowed } = hardener.canAccess('bot', 'DATABASE', 'read');
 * ```
 */
export class PermissionHardener {
  private trustPolicies: Map<string, TrustPolicy> = new Map();
  private auditLogger: SecureAuditLogger;
  
  constructor(auditLogger: SecureAuditLogger, defaultPolicies?: Array<{
    agentId: string;
    trustLevel: number;
    allowedResources: string[];
    maxScope?: string[];
    immutable?: boolean;
  }>) {
    this.auditLogger = auditLogger;
    this.initializeDefaultPolicies(defaultPolicies);
  }
  
  private initializeDefaultPolicies(customPolicies?: Array<{
    agentId: string;
    trustLevel: number;
    allowedResources: string[];
    maxScope?: string[];
    immutable?: boolean;
  }>): void {
    if (customPolicies && customPolicies.length > 0) {
      for (const policy of customPolicies) {
        this.trustPolicies.set(policy.agentId, {
          agentId: policy.agentId,
          trustLevel: policy.trustLevel,
          allowedResources: policy.allowedResources,
          maxScope: policy.maxScope ?? ['read'],
          createdBy: 'SYSTEM',
          immutable: policy.immutable ?? false,
        });
      }
      return;
    }
    // Fallback: universal defaults that cover common domains
    this.trustPolicies.set('orchestrator', {
      agentId: 'orchestrator',
      trustLevel: 0.9,
      allowedResources: ['*'],
      maxScope: ['read', 'write', 'execute', 'delegate'],
      createdBy: 'SYSTEM',
      immutable: true,
    });
  }
  
  /**
   * Register or update a trust policy for an agent at runtime.
   */
  registerPolicy(policy: {
    agentId: string;
    trustLevel: number;
    allowedResources: string[];
    maxScope?: string[];
    immutable?: boolean;
  }): void {
    const existing = this.trustPolicies.get(policy.agentId);
    if (existing?.immutable) return; // Cannot overwrite immutable policies
    this.trustPolicies.set(policy.agentId, {
      agentId: policy.agentId,
      trustLevel: policy.trustLevel,
      allowedResources: policy.allowedResources,
      maxScope: policy.maxScope ?? ['read'],
      createdBy: 'RUNTIME',
      immutable: policy.immutable ?? false,
    });
  }
  
  /**
   * Check if an agent can access a resource
   */
  canAccess(agentId: string, resourceType: string, requestedScope: string): {
    allowed: boolean;
    reason?: string;
  } {
    const policy = this.trustPolicies.get(agentId);
    
    if (!policy) {
      this.auditLogger.logViolation(agentId, 'UNKNOWN_AGENT', { resourceType, requestedScope });
      return { allowed: false, reason: 'Agent has no trust policy' };
    }
    
    // Check resource access (support '*' wildcard)
    if (!policy.allowedResources.includes('*') && !policy.allowedResources.includes(resourceType)) {
      this.auditLogger.logViolation(agentId, 'RESOURCE_NOT_ALLOWED', { 
        resourceType, 
        allowedResources: policy.allowedResources 
      });
      return { allowed: false, reason: `Agent not allowed to access ${resourceType}` };
    }
    
    // Check scope
    const scopeMatch = policy.maxScope.some(s => requestedScope.startsWith(s));
    if (!scopeMatch) {
      this.auditLogger.logViolation(agentId, 'SCOPE_EXCEEDED', {
        requestedScope,
        maxScope: policy.maxScope,
      });
      return { allowed: false, reason: 'Requested scope exceeds allowed scope' };
    }
    
    return { allowed: true };
  }
  
  /**
   * Attempt to modify trust level (with escalation prevention)
   */
  modifyTrustLevel(
    requestingAgent: string,
    targetAgent: string,
    newTrustLevel: number
  ): { success: boolean; reason?: string } {
    const requestorPolicy = this.trustPolicies.get(requestingAgent);
    const targetPolicy = this.trustPolicies.get(targetAgent);
    
    // Only orchestrator can modify trust
    if (requestingAgent !== 'orchestrator') {
      this.auditLogger.logViolation(requestingAgent, 'UNAUTHORIZED_TRUST_MODIFICATION', {
        targetAgent,
        attemptedTrustLevel: newTrustLevel,
      });
      return { success: false, reason: 'Only orchestrator can modify trust levels' };
    }
    
    // Cannot modify immutable policies
    if (targetPolicy?.immutable) {
      return { success: false, reason: 'Cannot modify immutable policy' };
    }
    
    // Cannot set trust higher than your own
    if (requestorPolicy && newTrustLevel > requestorPolicy.trustLevel) {
      this.auditLogger.logViolation(requestingAgent, 'PRIVILEGE_ESCALATION_ATTEMPT', {
        targetAgent,
        attemptedTrustLevel: newTrustLevel,
        requestorTrustLevel: requestorPolicy.trustLevel,
      });
      return { success: false, reason: 'Cannot grant trust level higher than your own' };
    }
    
    // Apply the modification
    if (targetPolicy) {
      targetPolicy.trustLevel = newTrustLevel;
    } else {
      this.trustPolicies.set(targetAgent, {
        agentId: targetAgent,
        trustLevel: newTrustLevel,
        allowedResources: [],
        maxScope: ['read'],
        createdBy: requestingAgent,
        immutable: false,
      });
    }
    
    return { success: true };
  }
  
  /**
   * Get policy for an agent
   */
  getPolicy(agentId: string): TrustPolicy | undefined {
    return this.trustPolicies.get(agentId);
  }
}

// ============================================================================
// 7. SECURITY ERROR CLASS
// ============================================================================

/**
 * Custom error class for security-related failures.
 *
 * Includes a machine-readable `code` field for programmatic handling.
 */
export class SecurityError extends Error {
  code: string;
  
  constructor(message: string, code: string) {
    super(message);
    this.name = 'SecurityError';
    this.code = code;
  }
}

// ============================================================================
// 8. SECURE SWARM GATEWAY (Integration Point)
// ============================================================================

/**
 * Unified security gateway that integrates all security modules:
 * token management, rate limiting, input sanitization, audit logging,
 * permission hardening, and data encryption.
 *
 * The SwarmOrchestrator routes every request through this gateway
 * before processing.
 *
 * @example
 * ```typescript
 * const gw = new SecureSwarmGateway();
 * const { allowed, sanitizedParams } = await gw.handleSecureRequest(
 *   'agent-1', 'delegate_task', { targetAgent: 'bot' }
 * );
 * ```
 */
export class SecureSwarmGateway {
  private tokenManager: SecureTokenManager;
  private rateLimiter: RateLimiter;
  private auditLogger: SecureAuditLogger;
  private permissionHardener: PermissionHardener;
  private encryptor: DataEncryptor;
  
  constructor(config: Partial<SecurityConfig> = {}) {
    const fullConfig = { ...DEFAULT_CONFIG, ...config };
    
    this.tokenManager = new SecureTokenManager(fullConfig);
    this.rateLimiter = new RateLimiter(fullConfig);
    this.auditLogger = new SecureAuditLogger(fullConfig);
    this.permissionHardener = new PermissionHardener(this.auditLogger);
    this.encryptor = new DataEncryptor(fullConfig.encryptionKey);
  }
  
  /**
   * Secure request handler - validates all security requirements
   */
  async handleSecureRequest(
    agentId: string,
    action: string,
    params: Record<string, unknown>,
    token?: SecureToken
  ): Promise<{ allowed: boolean; reason?: string; sanitizedParams?: Record<string, unknown> }> {
    // 1. Sanitize agent ID
    let sanitizedAgentId: string;
    try {
      sanitizedAgentId = InputSanitizer.sanitizeAgentId(agentId);
    } catch (error) {
      this.auditLogger.logViolation(agentId, 'INVALID_AGENT_ID', { error: String(error) });
      return { allowed: false, reason: 'Invalid agent ID' };
    }
    
    // 2. Check rate limit
    const rateLimit = this.rateLimiter.isRateLimited(sanitizedAgentId);
    if (rateLimit.limited) {
      this.auditLogger.log('RATE_LIMITED', sanitizedAgentId, action, 'denied', {
        retryAfter: rateLimit.retryAfter,
      });
      return { allowed: false, reason: `Rate limited. Retry after ${rateLimit.retryAfter}s` };
    }
    
    // 3. Validate token if provided
    if (token) {
      const tokenValidation = this.tokenManager.validateToken(token);
      if (!tokenValidation.valid) {
        const failedAuth = this.rateLimiter.recordFailedAuth(sanitizedAgentId);
        this.auditLogger.log('TOKEN_VALIDATION_FAILED', sanitizedAgentId, action, 'denied', {
          reason: tokenValidation.reason,
          locked: failedAuth.locked,
        });
        
        if (failedAuth.locked) {
          return { allowed: false, reason: 'Account locked due to failed authentication attempts' };
        }
        
        return { allowed: false, reason: tokenValidation.reason };
      }
      
      // Reset failed attempts on successful validation
      this.rateLimiter.resetFailedAttempts(sanitizedAgentId);
    }
    
    // 4. Sanitize parameters
    let sanitizedParams: Record<string, unknown>;
    try {
      sanitizedParams = InputSanitizer.sanitizeObject(params) as Record<string, unknown>;
    } catch (error) {
      this.auditLogger.logViolation(sanitizedAgentId, 'MALICIOUS_INPUT', {
        action,
        error: String(error),
      });
      return { allowed: false, reason: 'Invalid input parameters' };
    }
    
    // 5. Log successful request
    this.auditLogger.log('REQUEST_PROCESSED', sanitizedAgentId, action, 'success', {
      paramKeys: Object.keys(sanitizedParams),
    });
    
    return { allowed: true, sanitizedParams };
  }
  
  /**
   * Request a new permission grant
   */
  async requestPermission(
    agentId: string,
    resourceType: string,
    scope: string,
    justification: string
  ): Promise<{ granted: boolean; token?: SecureToken; reason?: string }> {
    const sanitizedAgentId = InputSanitizer.sanitizeAgentId(agentId);
    
    // Check if agent can access this resource
    const accessCheck = this.permissionHardener.canAccess(sanitizedAgentId, resourceType, scope);
    if (!accessCheck.allowed) {
      this.auditLogger.logPermissionRequest(sanitizedAgentId, resourceType, scope, false, accessCheck.reason);
      return { granted: false, reason: accessCheck.reason };
    }
    
    // Generate secure token
    const token = this.tokenManager.generateToken(sanitizedAgentId, resourceType, scope);
    
    this.auditLogger.logPermissionRequest(sanitizedAgentId, resourceType, scope, true);
    
    return { granted: true, token };
  }
  
  /**
   * Encrypt sensitive data for blackboard storage
   */
  encryptSensitiveData(data: unknown): string {
    return this.encryptor.encryptObject(data);
  }
  
  /**
   * Decrypt sensitive data from blackboard
   */
  decryptSensitiveData<T>(encryptedData: string): T {
    return this.encryptor.decryptObject<T>(encryptedData);
  }
  
  /**
   * Verify audit log integrity
   */
  verifyAuditIntegrity(): { valid: boolean; invalidEntries: number[] } {
    return this.auditLogger.verifyLogIntegrity();
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export {
  SecurityConfig,
  SecureToken,
  AuditEntry,
  TrustPolicy,
  DEFAULT_CONFIG,
};
