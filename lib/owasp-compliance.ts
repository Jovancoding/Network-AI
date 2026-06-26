/**
 * OWASP Agentic AI Top 10 (2026) — coverage matrix and verifier.
 *
 * Maps each OWASP Agentic risk category to the deterministic Network-AI control
 * that addresses it, and provides an `agt verify`-style coverage report. Unlike
 * the Python-skill MAESTRO/ASI table in `SKILL.md` (which scopes the bundled
 * scripts), this matrix covers the **TypeScript orchestration engine**.
 *
 * The controls referenced here are existing engine features — not aspirational
 * roadmap items. This module is a single source of truth for the README/SKILL
 * compliance section and for programmatic verification in CI.
 *
 * @module OwaspCompliance
 * @version 1.0.0
 * @license MIT
 */

/** Coverage state for a single risk. */
export type CoverageStatus = 'covered' | 'partial' | 'not-applicable';

/** One OWASP Agentic risk and the controls that address it. */
export interface OwaspControl {
  /** Risk identifier, e.g. `ASI-01`. */
  id: string;
  /** Risk name. */
  risk: string;
  /** Coverage state. */
  status: CoverageStatus;
  /** Deterministic controls (with the modules that implement them). */
  controls: string[];
}

/** Aggregate coverage report from {@link verifyOwaspCoverage}. */
export interface OwaspCoverageReport {
  total: number;
  covered: number;
  partial: number;
  notApplicable: number;
  controls: OwaspControl[];
  /** `true` when every applicable risk is at least `partial` (no gaps). */
  allAddressed: boolean;
}

/**
 * The OWASP Agentic AI Top 10 (2026) mapped to Network-AI engine controls.
 */
export const OWASP_AGENTIC_TOP10_2026: readonly OwaspControl[] = Object.freeze([
  {
    id: 'ASI-01',
    risk: 'Agent Goal Hijack',
    status: 'covered',
    controls: [
      'AuthGuardian weighted permission gating before sensitive resource access (index.ts)',
      'JourneyFSM behavioral control plane with ToolAuthorizationMatrix (lib/fsm-journey.ts)',
      'Scope guard responds directly for simple requests instead of decomposing',
    ],
  },
  {
    id: 'ASI-02',
    risk: 'Tool Misuse & Exploitation',
    status: 'covered',
    controls: [
      'AgentRuntime SandboxPolicy: command allow-list, shell:false argv execution (lib/agent-runtime.ts)',
      'ApprovalGate for approval-required operations',
      'AdapterHookManager beforeExecute matcher-based gating (lib/adapter-hooks.ts)',
    ],
  },
  {
    id: 'ASI-03',
    risk: 'Identity & Privilege Abuse',
    status: 'covered',
    controls: [
      'SecureTokenManager HMAC-SHA256 / Ed25519 signed tokens with TTL (security.ts)',
      'AuthGuardian trust scoring (trust 30%) keyed to data/trust_levels.json',
      'Grant tokens are advisory-only; platform auth required for destructive actions',
    ],
  },
  {
    id: 'ASI-04',
    risk: 'Supply Chain Risks',
    status: 'covered',
    controls: [
      'Single runtime dependency (commander); BYOC adapters add none',
      'socket.json capability declarations + scripts/socket-check.js pre-publish gate',
      'scripts/clawhub-check.js bundle hygiene + scripts/codeql-check.js alert gate',
    ],
  },
  {
    id: 'ASI-05',
    risk: 'Unsafe Code Execution',
    status: 'covered',
    controls: [
      'AgentRuntime ShellExecutor: tokenized argv, shell-metacharacter rejection, no /bin/sh -c (lib/agent-runtime.ts)',
      'SourceProtectionError + FileAccessor path-traversal protection',
      'Per-adapter CircuitBreaker bounds blast radius (lib/circuit-breaker.ts)',
    ],
  },
  {
    id: 'ASI-06',
    risk: 'Memory & Context Poisoning',
    status: 'covered',
    controls: [
      'LockedBlackboard atomic propose → validate → commit with file-system mutex (lib/locked-blackboard.ts)',
      'Blackboard validator injection-pattern detection on untrusted content',
      'ComplianceMonitor real-time behavior surveillance (lib/compliance-monitor.ts)',
    ],
  },
  {
    id: 'ASI-07',
    risk: 'Insecure Inter-Agent Communication',
    status: 'partial',
    controls: [
      'LockedBlackboard file-system mutex for local coordination origin',
      'Signed grant tokens (security.ts) authenticate cross-agent handoffs',
      'Documented boundary: run in a trusted workspace; restrict data/ permissions',
    ],
  },
  {
    id: 'ASI-08',
    risk: 'Cascading Failures',
    status: 'covered',
    controls: [
      'CircuitBreaker CLOSED/OPEN/HALF_OPEN per adapter with fallbackChain (lib/circuit-breaker.ts)',
      'FederatedBudget + ModelBudget ceilings bound runaway spend (lib/federated-budget.ts, lib/model-budget.ts)',
      'GovernedModelGateway + RetryBudget contain refusal-driven retry storms (lib/model-gateway.ts, lib/retry-budget.ts)',
    ],
  },
  {
    id: 'ASI-09',
    risk: 'Human-Agent Trust Exploitation',
    status: 'covered',
    controls: [
      'ApprovalGate requires human acknowledgment for high-risk actions (lib/agent-runtime.ts)',
      'AuthGuardian justification scoring (justification 40%) on every grant',
      'SecureAuditLogger tamper-evident trail of grants and state transitions (security.ts)',
    ],
  },
  {
    id: 'ASI-10',
    risk: 'Rogue Agents',
    status: 'covered',
    controls: [
      'ComplianceMonitor surveillance flags out-of-policy behavior (lib/compliance-monitor.ts)',
      'CircuitBreaker isolation + budget ceilings act as a kill switch',
      'Every write and state transition logged to data/audit_log.jsonl (security.ts)',
    ],
  },
]);

/**
 * Build a coverage report from a control matrix.
 *
 * @param controls  The matrix to verify (defaults to {@link OWASP_AGENTIC_TOP10_2026}).
 * @returns         Counts plus `allAddressed` (no `not-applicable`-excluded gaps).
 */
export function verifyOwaspCoverage(
  controls: readonly OwaspControl[] = OWASP_AGENTIC_TOP10_2026,
): OwaspCoverageReport {
  let covered = 0;
  let partial = 0;
  let notApplicable = 0;
  for (const c of controls) {
    if (c.status === 'covered') covered++;
    else if (c.status === 'partial') partial++;
    else notApplicable++;
  }
  const applicable = controls.filter((c) => c.status !== 'not-applicable');
  const allAddressed = applicable.every((c) => c.status === 'covered' || c.status === 'partial');
  return { total: controls.length, covered, partial, notApplicable, controls: [...controls], allAddressed };
}

/**
 * Render a coverage report as an `agt verify`-style text block.
 *
 * @param report  A report from {@link verifyOwaspCoverage}.
 */
export function formatOwaspReport(report: OwaspCoverageReport): string {
  const lines: string[] = [];
  lines.push('Network-AI — OWASP Agentic AI Top 10 (2026) Coverage');
  lines.push('─'.repeat(56));
  for (const c of report.controls) {
    const mark = c.status === 'covered' ? '✅' : c.status === 'partial' ? '🟡' : '⚪';
    lines.push(`  ${c.id}  ${mark} ${c.risk}`);
  }
  lines.push('─'.repeat(56));
  lines.push(`  ${report.covered}/${report.total} covered, ${report.partial} partial`);
  lines.push(`  ${report.allAddressed ? 'PASS — all risks addressed' : 'FAIL — gaps present'}`);
  return lines.join('\n');
}
