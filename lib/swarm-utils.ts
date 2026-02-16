/**
 * SwarmOrchestrator - Standalone TypeScript Utilities
 * 
 * This module provides TypeScript/Node.js utilities for the Swarm Orchestrator skill.
 * It can be used alongside the Python scripts or as an alternative implementation.
 * 
 * NOTE: This is a standalone library - it does NOT import from 'openclaw-core'.
 * OpenClaw integration happens through the SKILL.md instructions and Python scripts.
 * 
 * @module SwarmOrchestrator
 * @version 2.0.0
 * @license MIT
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID, createHmac, createCipheriv, createDecipheriv, randomBytes, CipherGCM, DecipherGCM } from 'crypto';
import { Logger } from './logger';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface TaskPayload {
  instruction: string;
  context?: Record<string, unknown>;
  constraints?: string[];
  expectedOutput?: string;
}

export interface HandoffMessage {
  handoffId: string;
  sourceAgent: string;
  targetAgent: string;
  taskType: 'delegate' | 'collaborate' | 'validate';
  payload: TaskPayload;
  metadata: {
    priority: number;
    deadline: number;
    parentTaskId: string | null;
  };
}

export interface PermissionGrant {
  granted: boolean;
  token: string | null;
  expiresAt: string | null;
  restrictions: string[];
  reason?: string;
  scores?: {
    justification: number;
    trust: number | null;
    risk: number | null;
    weighted?: number;
  };
}

export interface BlackboardEntry {
  key: string;
  value: unknown;
  source_agent: string;
  timestamp: string;
  ttl: number | null;
}

export interface ActiveGrant {
  token: string;
  agent_id: string;
  resource_type: string;
  scope: string | null;
  expires_at: string;
  restrictions: string[];
  granted_at: string;
}

export type ResourceType = 'SAP_API' | 'FINANCIAL_API' | 'EXTERNAL_SERVICE' | 'DATA_EXPORT';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  blackboardPath: './swarm-blackboard.md',
  dataDir: './data',
  grantTokenTTLMinutes: 5,
  defaultTrustLevels: {
    orchestrator: 0.9,
    risk_assessor: 0.85,
    data_analyst: 0.8,
    strategy_advisor: 0.7,
  } as Record<string, number>,
  baseRisks: {
    SAP_API: 0.5,
    FINANCIAL_API: 0.7,
    EXTERNAL_SERVICE: 0.4,
    DATA_EXPORT: 0.6,
  } as Record<string, number>,
  restrictions: {
    SAP_API: ['read_only', 'max_records:100'],
    FINANCIAL_API: ['read_only', 'no_pii_fields', 'audit_required'],
    EXTERNAL_SERVICE: ['rate_limit:10_per_minute'],
    DATA_EXPORT: ['anonymize_pii', 'local_only'],
  } as Record<string, string[]>,
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function ensureDataDir(basePath: string = '.'): string {
  const dataDir = join(basePath, 'data');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// SHARED BLACKBOARD
// ============================================================================

export class SharedBlackboard {
  private path: string;
  private cache: Map<string, BlackboardEntry> = new Map();

  constructor(basePath: string = '.') {
    this.path = join(basePath, 'swarm-blackboard.md');
    this.initialize();
  }

  private initialize(): void {
    ensureDir(this.path);
    if (!existsSync(this.path)) {
      const initialContent = `# Swarm Blackboard
Last Updated: ${new Date().toISOString()}

## Active Tasks
| TaskID | Agent | Status | Started | Description |
|--------|-------|--------|---------|-------------|

## Knowledge Cache
<!-- Cached results from agent operations -->

## Coordination Signals
<!-- Agent availability status -->

## Execution History
<!-- Chronological log of completed tasks -->
`;
      writeFileSync(this.path, initialContent, 'utf-8');
    }
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      const content = readFileSync(this.path, 'utf-8');
      const cacheSection = content.match(/## Knowledge Cache\n([\s\S]*?)(?=\n## |$)/);
      if (cacheSection) {
        const entries = cacheSection[1].matchAll(/### (\S+)\n([\s\S]*?)(?=\n### |$)/g);
        for (const entry of entries) {
          const key = entry[1];
          try {
            const metadata = JSON.parse(entry[2].trim());
            this.cache.set(key, metadata);
          } catch {
            // Skip malformed entries
          }
        }
      }
    } catch (error) {
      const log = Logger.create('Blackboard');
      log.error('Failed to load from disk', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private persistToDisk(): void {
    const sections = [
      `# Swarm Blackboard`,
      `Last Updated: ${new Date().toISOString()}`,
      ``,
      `## Active Tasks`,
      `| TaskID | Agent | Status | Started | Description |`,
      `|--------|-------|--------|---------|-------------|`,
      ``,
      `## Knowledge Cache`,
    ];

    for (const [key, entry] of this.cache.entries()) {
      if (this.isExpired(entry)) {
        this.cache.delete(key);
        continue;
      }
      sections.push(`### ${key}`);
      sections.push(JSON.stringify(entry, null, 2));
      sections.push('');
    }

    sections.push(`## Coordination Signals`);
    sections.push(`## Execution History`);

    writeFileSync(this.path, sections.join('\n'), 'utf-8');
  }

  private isExpired(entry: BlackboardEntry): boolean {
    if (!entry.ttl) return false;
    const expiresAt = new Date(entry.timestamp).getTime() + entry.ttl * 1000;
    return Date.now() > expiresAt;
  }

  read(key: string): BlackboardEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (this.isExpired(entry)) {
      this.cache.delete(key);
      this.persistToDisk();
      return null;
    }

    return entry;
  }

  write(key: string, value: unknown, sourceAgent: string, ttl?: number): BlackboardEntry {
    const entry: BlackboardEntry = {
      key,
      value,
      source_agent: sourceAgent,
      timestamp: new Date().toISOString(),
      ttl: ttl ?? null,
    };

    this.cache.set(key, entry);
    this.persistToDisk();
    return entry;
  }

  delete(key: string): boolean {
    if (this.cache.has(key)) {
      this.cache.delete(key);
      this.persistToDisk();
      return true;
    }
    return false;
  }

  exists(key: string): boolean {
    return this.read(key) !== null;
  }

  listKeys(): string[] {
    const validKeys: string[] = [];
    for (const key of this.cache.keys()) {
      if (this.read(key) !== null) {
        validKeys.push(key);
      }
    }
    return validKeys;
  }

  getSnapshot(): Record<string, BlackboardEntry> {
    const snapshot: Record<string, BlackboardEntry> = {};
    for (const key of this.cache.keys()) {
      const entry = this.read(key);
      if (entry) {
        snapshot[key] = entry;
      }
    }
    return snapshot;
  }
}

// ============================================================================
// AUTH GUARDIAN
// ============================================================================

export class AuthGuardian {
  private basePath: string;
  private grantsFile: string;
  private auditLog: string;

  constructor(basePath: string = '.') {
    this.basePath = basePath;
    const dataDir = ensureDataDir(basePath);
    this.grantsFile = join(dataDir, 'active_grants.json');
    this.auditLog = join(dataDir, 'audit_log.jsonl');
  }

  private loadGrants(): Record<string, ActiveGrant> {
    if (!existsSync(this.grantsFile)) {
      return {};
    }
    try {
      return JSON.parse(readFileSync(this.grantsFile, 'utf-8'));
    } catch {
      return {};
    }
  }

  private saveGrants(grants: Record<string, ActiveGrant>): void {
    ensureDir(this.grantsFile);
    writeFileSync(this.grantsFile, JSON.stringify(grants, null, 2), 'utf-8');
  }

  private logAudit(action: string, details: unknown): void {
    ensureDir(this.auditLog);
    const entry = {
      timestamp: new Date().toISOString(),
      action,
      details,
    };
    const line = JSON.stringify(entry) + '\n';
    
    try {
      const existing = existsSync(this.auditLog) ? readFileSync(this.auditLog, 'utf-8') : '';
      writeFileSync(this.auditLog, existing + line, 'utf-8');
    } catch {
      writeFileSync(this.auditLog, line, 'utf-8');
    }
  }

  private scoreJustification(justification: string): number {
    let score = 0;
    if (justification.length > 20) score += 0.2;
    if (justification.length > 50) score += 0.2;
    if (/task|purpose|need|require|generate|analyze|create|process/i.test(justification)) score += 0.2;
    if (/specific|particular|exact|quarterly|annual|report|summary/i.test(justification)) score += 0.2;
    if (!/test|debug|try|experiment/i.test(justification)) score += 0.2;
    return Math.min(score, 1);
  }

  private assessRisk(resourceType: string, scope?: string): number {
    let risk = CONFIG.baseRisks[resourceType] ?? 0.5;
    if (!scope || scope === '*' || scope === 'all') risk += 0.2;
    if (scope && /write|delete|update|modify|create/i.test(scope)) risk += 0.2;
    return Math.min(risk, 1);
  }

  private generateToken(): string {
    return `grant_${randomUUID().replace(/-/g, '')}`;
  }

  requestPermission(
    agentId: string,
    resourceType: ResourceType,
    justification: string,
    scope?: string
  ): PermissionGrant {
    this.logAudit('permission_request', { agentId, resourceType, justification, scope });

    // 1. Justification Quality (40%)
    const justificationScore = this.scoreJustification(justification);
    if (justificationScore < 0.3) {
      return {
        granted: false,
        token: null,
        expiresAt: null,
        restrictions: [],
        reason: 'Justification is insufficient. Please provide specific task context.',
        scores: { justification: justificationScore, trust: null, risk: null },
      };
    }

    // 2. Agent Trust Level (30%)
    const trustLevel = CONFIG.defaultTrustLevels[agentId] ?? 0.5;
    if (trustLevel < 0.4) {
      return {
        granted: false,
        token: null,
        expiresAt: null,
        restrictions: [],
        reason: 'Agent trust level is below threshold. Escalate to human operator.',
        scores: { justification: justificationScore, trust: trustLevel, risk: null },
      };
    }

    // 3. Risk Assessment (30%)
    const riskScore = this.assessRisk(resourceType, scope);
    if (riskScore > 0.8) {
      return {
        granted: false,
        token: null,
        expiresAt: null,
        restrictions: [],
        reason: 'Risk assessment exceeds acceptable threshold. Narrow the requested scope.',
        scores: { justification: justificationScore, trust: trustLevel, risk: riskScore },
      };
    }

    // Calculate weighted score
    const weightedScore = (justificationScore * 0.4) + (trustLevel * 0.3) + ((1 - riskScore) * 0.3);
    
    if (weightedScore < 0.5) {
      return {
        granted: false,
        token: null,
        expiresAt: null,
        restrictions: [],
        reason: `Combined evaluation score (${weightedScore.toFixed(2)}) below threshold (0.5).`,
        scores: { justification: justificationScore, trust: trustLevel, risk: riskScore, weighted: weightedScore },
      };
    }

    // Generate grant
    const token = this.generateToken();
    const expiresAt = new Date(Date.now() + CONFIG.grantTokenTTLMinutes * 60 * 1000).toISOString();
    const restrictions = CONFIG.restrictions[resourceType] ?? [];

    const grant: ActiveGrant = {
      token,
      agent_id: agentId,
      resource_type: resourceType,
      scope: scope ?? null,
      expires_at: expiresAt,
      restrictions,
      granted_at: new Date().toISOString(),
    };

    const grants = this.loadGrants();
    grants[token] = grant;
    this.saveGrants(grants);

    this.logAudit('permission_granted', grant);

    return {
      granted: true,
      token,
      expiresAt,
      restrictions,
      scores: { justification: justificationScore, trust: trustLevel, risk: riskScore, weighted: weightedScore },
    };
  }

  validateToken(token: string): { valid: boolean; grant?: ActiveGrant; reason?: string } {
    const grants = this.loadGrants();
    const grant = grants[token];

    if (!grant) {
      return { valid: false, reason: 'Token not found' };
    }

    if (new Date(grant.expires_at) < new Date()) {
      return { valid: false, reason: 'Token has expired', grant };
    }

    return { valid: true, grant };
  }

  revokeToken(token: string): boolean {
    const grants = this.loadGrants();
    if (token in grants) {
      const grant = grants[token];
      delete grants[token];
      this.saveGrants(grants);
      this.logAudit('permission_revoked', { token, original_grant: grant });
      return true;
    }
    return false;
  }

  getActiveGrants(): ActiveGrant[] {
    const grants = this.loadGrants();
    const now = new Date();
    const active: ActiveGrant[] = [];

    for (const [token, grant] of Object.entries(grants)) {
      if (new Date(grant.expires_at) > now) {
        active.push(grant);
      } else {
        delete grants[token];
      }
    }

    this.saveGrants(grants);
    return active;
  }
}

// ============================================================================
// SECURE DATA ENCRYPTOR
// ============================================================================

export class DataEncryptor {
  private key: Buffer;
  private algorithm = 'aes-256-gcm';

  constructor(secretKey: string) {
    // Derive 32-byte key from secret
    this.key = createHmac('sha256', secretKey).update('encryption-key').digest();
  }

  encrypt(data: string): string {
    const iv = randomBytes(16);
    const cipher = createCipheriv(this.algorithm, this.key, iv) as CipherGCM;
    
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  decrypt(encryptedData: string): string | null {
    try {
      const [ivHex, authTagHex, encrypted] = encryptedData.split(':');
      
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');
      
      const decipher = createDecipheriv(this.algorithm, this.key, iv) as DecipherGCM;
      decipher.setAuthTag(authTag);
      
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      
      return decrypted;
    } catch {
      return null;
    }
  }

  encryptObject(obj: unknown): string {
    return this.encrypt(JSON.stringify(obj));
  }

  decryptObject<T>(encryptedData: string): T | null {
    const decrypted = this.decrypt(encryptedData);
    if (!decrypted) return null;
    
    try {
      return JSON.parse(decrypted) as T;
    } catch {
      return null;
    }
  }
}

// ============================================================================
// HANDOFF MESSAGE BUILDER
// ============================================================================

export class HandoffBuilder {
  /**
   * Create a handoff message for task delegation
   */
  static createHandoff(
    sourceAgent: string,
    targetAgent: string,
    payload: TaskPayload,
    options: {
      taskType?: 'delegate' | 'collaborate' | 'validate';
      priority?: number;
      timeoutMs?: number;
      parentTaskId?: string;
    } = {}
  ): HandoffMessage {
    const {
      taskType = 'delegate',
      priority = 1,
      timeoutMs = 30000,
      parentTaskId = null,
    } = options;

    return {
      handoffId: randomUUID(),
      sourceAgent,
      targetAgent,
      taskType,
      payload,
      metadata: {
        priority,
        deadline: Date.now() + timeoutMs,
        parentTaskId,
      },
    };
  }

  /**
   * Format handoff message for sessions_send
   */
  static formatForSessionSend(handoff: HandoffMessage): string {
    return `[HANDOFF]
Instruction: ${handoff.payload.instruction}
Context: ${handoff.payload.context ? JSON.stringify(handoff.payload.context) : 'N/A'}
Constraints: ${handoff.payload.constraints?.join(', ') || 'None'}
Expected Output: ${handoff.payload.expectedOutput || 'Any appropriate response'}
[/HANDOFF]

Handoff ID: ${handoff.handoffId}
From: ${handoff.sourceAgent}
Priority: ${handoff.metadata.priority}`;
  }

  /**
   * Parse handoff message from text
   */
  static parseHandoff(text: string): Partial<TaskPayload> | null {
    const match = text.match(/\[HANDOFF\]([\s\S]*?)\[\/HANDOFF\]/);
    if (!match) return null;

    const content = match[1];
    const instruction = content.match(/Instruction:\s*(.+)/)?.[1]?.trim();
    const contextStr = content.match(/Context:\s*(.+)/)?.[1]?.trim();
    const constraintsStr = content.match(/Constraints:\s*(.+)/)?.[1]?.trim();
    const expectedOutput = content.match(/Expected Output:\s*(.+)/)?.[1]?.trim();

    return {
      instruction: instruction || '',
      context: contextStr && contextStr !== 'N/A' ? JSON.parse(contextStr) : undefined,
      constraints: constraintsStr && constraintsStr !== 'None' ? constraintsStr.split(', ') : undefined,
      expectedOutput: expectedOutput && expectedOutput !== 'Any appropriate response' ? expectedOutput : undefined,
    };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export { CONFIG };

// Default instances for convenience
let defaultBlackboard: SharedBlackboard | null = null;
let defaultAuthGuardian: AuthGuardian | null = null;

export function getBlackboard(basePath?: string): SharedBlackboard {
  if (!defaultBlackboard || basePath) {
    defaultBlackboard = new SharedBlackboard(basePath);
  }
  return defaultBlackboard;
}

export function getAuthGuardian(basePath?: string): AuthGuardian {
  if (!defaultAuthGuardian || basePath) {
    defaultAuthGuardian = new AuthGuardian(basePath);
  }
  return defaultAuthGuardian;
}
