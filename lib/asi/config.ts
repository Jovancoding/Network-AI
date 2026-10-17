/**
 * ASI Strict Mode — configuration.
 *
 * The process-wide setting is read from `ASI_STRICT_MODE` exactly once, the
 * first time it is needed, and deep-frozen. Later changes to `process.env`
 * have no effect, and the only runtime change allowed is
 * {@link tightenAsiConfig}, which can make the mode stricter but never looser.
 * Lowering it requires a process restart by the operator.
 *
 * Components also accept an explicit config object, so tests and embedders
 * never need to touch the global.
 *
 * Limitation: an agent that can run arbitrary commands on the same host can
 * still restart the process with different settings. Pair strict mode with
 * `SandboxPolicy` (strict mode turns on `sourceProtection`) and, for real
 * isolation, an out-of-process {@link ExternalAuthority}.
 *
 * @module AsiConfig
 */

import { AgentTrustLevel } from './types';
import type { AsiEvent, AsiStrictConfig, AsiStrictConfigInput, AsiStrictModeSetting } from './types';

const MODE_RANK: Record<AsiStrictModeSetting, number> = { off: 0, audit: 1, enforce: 2 };
const TRUST_RANK: Record<AgentTrustLevel, number> = {
  [AgentTrustLevel.LOW]: 0,
  [AgentTrustLevel.HIGH]: 1,
  [AgentTrustLevel.AUDITOR]: 2,
};

/** Rank of a trust tier (LOW < HIGH < AUDITOR). */
export function trustRank(level: AgentTrustLevel): number {
  return TRUST_RANK[level];
}

/** Parse `ASI_STRICT_MODE`. Unknown values fail closed to `'enforce'`. */
export function parseStrictMode(raw: string | undefined): AsiStrictModeSetting {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'false' || v === '0' || v === 'off' || v === 'no') return 'off';
  if (v === 'audit' || v === 'dry-run' || v === 'shadow') return 'audit';
  return 'enforce';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Freeze plain data recursively; class instances and functions are left alone. */
function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach((item) => deepFreeze(item));
    return Object.freeze(value);
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    return Object.freeze(value);
  }
  return value;
}

/**
 * Build a validated, deep-frozen strict-mode config.
 *
 * @param input  Explicit settings; `mode` defaults to `'off'`.
 * @throws TypeError on invalid thresholds.
 */
export function createAsiConfig(input: AsiStrictConfigInput = {}): AsiStrictConfig {
  const lowTrustBelow = input.lowTrustBelow ?? 0.4;
  if (typeof lowTrustBelow !== 'number' || lowTrustBelow < 0 || lowTrustBelow > 1) {
    throw new TypeError('AsiStrictConfig.lowTrustBelow must be between 0 and 1');
  }
  if (input.consensus && (!Number.isInteger(input.consensus.maxFaulty) || input.consensus.maxFaulty < 0)) {
    throw new TypeError('AsiStrictConfig.consensus.maxFaulty must be a non-negative integer');
  }
  const config: AsiStrictConfig = {
    mode: input.mode ?? 'off',
    lowTrustBelow,
    auditors: [...(input.auditors ?? [])],
    context: input.context ? { ...input.context } : undefined,
    cognitive: input.cognitive ? { ...input.cognitive } : undefined,
    consensus: input.consensus ? { ...input.consensus } : undefined,
    requireReceiptAtOrBelow: input.requireReceiptAtOrBelow ?? AgentTrustLevel.LOW,
    sink: input.sink,
  };
  return deepFreeze(config);
}

let active: AsiStrictConfig | undefined;

/**
 * The process-wide config. Read from `ASI_STRICT_MODE` on first call, then
 * frozen for the lifetime of the process.
 */
export function getAsiConfig(): AsiStrictConfig {
  if (!active) active = createAsiConfig({ mode: parseStrictMode(process.env['ASI_STRICT_MODE']) });
  return active;
}

/**
 * Replace the process-wide config with a stricter one. The mode can only move
 * `off → audit → enforce`; auditors can only be removed, and the LOW-trust
 * threshold and receipt tier can only rise. Anything looser throws.
 *
 * @returns The new frozen config.
 */
export function tightenAsiConfig(next: AsiStrictConfigInput): AsiStrictConfig {
  const current = getAsiConfig();
  const mode = next.mode ?? current.mode;
  if (MODE_RANK[mode] < MODE_RANK[current.mode]) {
    throw new Error(`ASI strict mode cannot be lowered at runtime (${current.mode} → ${mode}); restart the process`);
  }
  const lowTrustBelow = next.lowTrustBelow ?? current.lowTrustBelow;
  if (lowTrustBelow < current.lowTrustBelow) {
    throw new Error('ASI lowTrustBelow can only be raised at runtime');
  }
  const auditors = next.auditors ?? current.auditors;
  if (auditors.some((a) => !current.auditors.includes(a)) && current.mode !== 'off') {
    throw new Error('ASI auditors cannot be added at runtime once strict mode is active');
  }
  const receiptTier = next.requireReceiptAtOrBelow ?? current.requireReceiptAtOrBelow;
  if (trustRank(receiptTier) < trustRank(current.requireReceiptAtOrBelow)) {
    throw new Error('ASI requireReceiptAtOrBelow can only be raised at runtime');
  }
  // Policies and the event sink may be set once; replacing them could loosen limits or hide events.
  for (const field of ['context', 'cognitive', 'consensus', 'sink'] as const) {
    if (next[field] !== undefined && current[field] !== undefined && next[field] !== current[field]) {
      throw new Error(`ASI ${field} cannot be replaced at runtime once set; restart the process`);
    }
  }
  active = createAsiConfig({
    ...current,
    ...next,
    mode,
    lowTrustBelow,
    auditors,
    requireReceiptAtOrBelow: receiptTier,
  });
  emitAsiEvent(active, { kind: 'config', outcome: 'allowed', reason: `strict mode tightened to ${mode}`, at: Date.now() });
  return active;
}

/** Whether strict-mode checks run at all (`audit` or `enforce`). */
export function isAsiActive(config: AsiStrictConfig = getAsiConfig()): boolean {
  return config.mode !== 'off';
}

/** Whether strict-mode violations block (`enforce`). */
export function isAsiEnforcing(config: AsiStrictConfig = getAsiConfig()): boolean {
  return config.mode === 'enforce';
}

/** Deliver an event to the configured sink without ever throwing. */
export function emitAsiEvent(config: AsiStrictConfig, event: AsiEvent): void {
  if (!config.sink) return;
  try {
    const r = config.sink.record(event);
    if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => undefined);
  } catch {
    // Event delivery is best-effort; it must never break the guarded operation.
  }
}

/**
 * Report a strict-mode violation and say whether to block it: `true` in
 * `enforce` (event outcome `'denied'`), `false` in `audit` (`'would-deny'`).
 */
export function asiViolation(
  config: AsiStrictConfig,
  event: Omit<AsiEvent, 'outcome' | 'at'>,
): boolean {
  const block = isAsiEnforcing(config);
  emitAsiEvent(config, { ...event, outcome: block ? 'denied' : 'would-deny', at: Date.now() });
  return block;
}

/** Thrown when strict mode blocks an operation. */
export class AsiPolicyError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'AsiPolicyError';
  }
}
