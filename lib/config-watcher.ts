/**
 * ConfigWatcher — Hot-reload configuration from disk.
 *
 * Uses `fs.watch()` to monitor config files and applies changes to
 * live CONFIG, trust levels, resource profiles, and budget ceilings.
 * Emits events on reload so components can react.
 *
 * @module ConfigWatcher
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// TYPES
// ============================================================================

/** Fields that can be hot-reloaded on CONFIG */
export interface ReloadableConfig {
  maxParallelAgents?: number;
  defaultTimeout?: number;
  enableTracing?: boolean;
  grantTokenTTL?: number;
  maxBlackboardValueSize?: number;
  [key: string]: unknown;
}

/** Trust level entry */
export interface TrustEntry {
  agentId: string;
  level: number;
  tags?: string[];
}

/** Budget overrides */
export interface BudgetOverrides {
  ceiling?: number;
  perAgentCeiling?: number;
}

/** Callback targets for reloaded config */
export interface ConfigTargets {
  /** Mutable CONFIG object to patch in-place */
  config?: Record<string, unknown>;
  /** AuthGuardian instance — for trust level updates */
  authGuardian?: { setTrustLevel?(agentId: string, level: number): void };
  /** FederatedBudget instance — for ceiling updates */
  budget?: { setCeiling?(ceiling: number): void };
}

/** Emitted on successful reload */
export interface ReloadEvent {
  file: string;
  timestamp: number;
  changes: string[];
}

/** Emitted on reload error */
export interface ReloadError {
  file: string;
  timestamp: number;
  error: string;
}

// ============================================================================
// CONFIG WATCHER
// ============================================================================

/**
 * Watches config files on disk and applies changes to live objects.
 *
 * Supports three config file types:
 * - **config.json** — patches `CONFIG` object fields
 * - **trust_levels.json** — array of `{ agentId, level }` applied to AuthGuardian
 * - **budget.json** — `{ ceiling, perAgentCeiling }` applied to FederatedBudget
 *
 * @example
 * ```ts
 * const watcher = new ConfigWatcher({
 *   configPath: './data/config.json',
 *   trustPath: './data/trust_levels.json',
 *   targets: { config: CONFIG, authGuardian: guardian, budget: fed },
 * });
 * watcher.on('reload', (evt) => console.log('Reloaded:', evt.file));
 * watcher.start();
 * // ... later
 * watcher.stop();
 * ```
 */
export class ConfigWatcher extends EventEmitter {
  private watchers: fs.FSWatcher[] = [];
  private targets: ConfigTargets;
  private configPath?: string;
  private trustPath?: string;
  private budgetPath?: string;
  private debounceMs: number;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private running = false;

  constructor(options: {
    configPath?: string;
    trustPath?: string;
    budgetPath?: string;
    targets?: ConfigTargets;
    debounceMs?: number;
  } = {}) {
    super();
    this.configPath = options.configPath;
    this.trustPath = options.trustPath;
    this.budgetPath = options.budgetPath;
    this.targets = options.targets ?? {};
    this.debounceMs = options.debounceMs ?? 300;
  }

  /** Update targets after construction */
  setTargets(targets: ConfigTargets): void {
    Object.assign(this.targets, targets);
  }

  /** Start watching all configured paths */
  start(): void {
    if (this.running) return;
    this.running = true;

    const paths = [this.configPath, this.trustPath, this.budgetPath].filter(Boolean) as string[];
    for (const filePath of paths) {
      try {
        if (!fs.existsSync(filePath)) continue;
        const watcher = fs.watch(filePath, { persistent: false }, (_event) => {
          this.debouncedReload(filePath);
        });
        this.watchers.push(watcher);
      } catch {
        // File doesn't exist or not watchable — skip silently
      }
    }
  }

  /** Stop all watchers */
  stop(): void {
    this.running = false;
    for (const w of this.watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    this.watchers = [];
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
  }

  /** Manually trigger a reload for a specific file */
  reload(filePath: string): void {
    this.applyReload(filePath);
  }

  /** Whether the watcher is currently active */
  isRunning(): boolean {
    return this.running;
  }

  // --------------------------------------------------------------------------
  // INTERNAL
  // --------------------------------------------------------------------------

  private debouncedReload(filePath: string): void {
    const existing = this.debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(filePath, setTimeout(() => {
      this.debounceTimers.delete(filePath);
      this.applyReload(filePath);
    }, this.debounceMs));
  }

  private applyReload(filePath: string): void {
    try {
      const resolved = path.resolve(filePath);
      const raw = fs.readFileSync(resolved, 'utf-8');
      const data: unknown = JSON.parse(raw);
      const changes: string[] = [];

      if (resolved === path.resolve(this.configPath ?? '')) {
        this.applyConfig(data, changes);
      } else if (resolved === path.resolve(this.trustPath ?? '')) {
        this.applyTrust(data, changes);
      } else if (resolved === path.resolve(this.budgetPath ?? '')) {
        this.applyBudget(data, changes);
      }

      const evt: ReloadEvent = { file: filePath, timestamp: Date.now(), changes };
      this.emit('reload', evt);
    } catch (err) {
      const errEvt: ReloadError = {
        file: filePath,
        timestamp: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      };
      this.emit('error', errEvt);
    }
  }

  private applyConfig(data: unknown, changes: string[]): void {
    if (!this.targets.config || typeof data !== 'object' || data === null) return;
    const obj = data as Record<string, unknown>;
    const allowed = new Set([
      'maxParallelAgents', 'defaultTimeout', 'enableTracing',
      'grantTokenTTL', 'maxBlackboardValueSize',
    ]);
    for (const [key, value] of Object.entries(obj)) {
      if (allowed.has(key)) {
        this.targets.config[key] = value;
        changes.push(`config.${key}=${JSON.stringify(value)}`);
      }
    }
  }

  private applyTrust(data: unknown, changes: string[]): void {
    if (!this.targets.authGuardian?.setTrustLevel || !Array.isArray(data)) return;
    for (const entry of data) {
      if (typeof entry === 'object' && entry !== null &&
          'agentId' in entry && 'level' in entry &&
          typeof (entry as Record<string, unknown>).agentId === 'string' &&
          typeof (entry as Record<string, unknown>).level === 'number') {
        const { agentId, level } = entry as TrustEntry;
        this.targets.authGuardian.setTrustLevel(agentId, level);
        changes.push(`trust.${agentId}=${level}`);
      }
    }
  }

  private applyBudget(data: unknown, changes: string[]): void {
    if (!this.targets.budget?.setCeiling || typeof data !== 'object' || data === null) return;
    const obj = data as Record<string, unknown>;
    if (typeof obj.ceiling === 'number') {
      this.targets.budget.setCeiling(obj.ceiling);
      changes.push(`budget.ceiling=${obj.ceiling}`);
    }
  }
}
