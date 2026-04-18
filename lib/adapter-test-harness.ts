/**
 * Parameterized Adapter Test Harness
 *
 * Provides `createAdapterTestSuite()` — a reusable function that runs
 * a standard battery of tests against any adapter that extends BaseAdapter.
 *
 * Verifies:
 *   1. Lifecycle (initialize, isReady, shutdown)
 *   2. Agent listing after registration
 *   3. Health check
 *   4. Agent availability
 *   5. Execution with registered agent
 *   6. Execution with unknown agent returns error
 *   7. Capabilities shape
 *   8. Shutdown clears agents
 *
 * Usage in test suites:
 *   await createAdapterTestSuite({
 *     name: 'LangGraph',
 *     create: () => new LangGraphAdapter(),
 *     registerAgent: (adapter) => adapter.registerGraph('test', mockGraph),
 *     agentId: 'test',
 *     payload: { action: 'run', params: {} },
 *   });
 *
 * @module AdapterTestHarness
 * @version 1.0.0
 */

import type { AgentPayload, AgentContext, AgentResult, AdapterCapabilities, AgentInfo } from '../types/agent-adapter';
import type { BaseAdapter } from '../adapters/base-adapter';

// ============================================================================
// TYPES
// ============================================================================

/** Test assertion function — compatible with test-adapters.ts pattern */
export type AssertFn = (condition: boolean, message: string) => void;

/** Section header function */
export type SectionFn = (title: string) => void;

/** Configuration for the parameterized test suite */
export interface AdapterTestSuiteConfig {
  /** Display name for the adapter under test */
  name: string;
  /** Factory function that creates a fresh adapter instance */
  create: () => BaseAdapter;
  /**
   * Register at least one agent on the adapter.
   * Called after initialize(). Should register an agent with the given agentId.
   */
  registerAgent: (adapter: BaseAdapter) => void | Promise<void>;
  /** The agent ID registered by registerAgent() */
  agentId: string;
  /** A valid payload to use for execution tests */
  payload: AgentPayload;
  /** Optional config to pass to initialize() */
  initConfig?: Record<string, unknown>;
  /** Optional custom context for execution */
  context?: AgentContext;
  /**
   * If true, expect executeAgent to succeed.
   * If false, expect it to return an error (e.g. no backend configured).
   * Default: true.
   */
  expectSuccess?: boolean;
  /** Custom assert function (defaults to built-in) */
  assert?: AssertFn;
  /** Custom section function (defaults to built-in) */
  section?: SectionFn;
}

/** Result from running the test suite */
export interface AdapterTestResult {
  /** Adapter name */
  adapterName: string;
  /** Total assertions */
  total: number;
  /** Passed assertions */
  passed: number;
  /** Failed assertions */
  failed: number;
  /** Individual test results */
  results: Array<{ ok: boolean; message: string }>;
}

// ============================================================================
// HARNESS
// ============================================================================

/**
 * Run a standard battery of tests against any adapter.
 *
 * Uses the provided assert/section functions for output, or
 * falls back to console-based defaults.
 */
export async function createAdapterTestSuite(
  config: AdapterTestSuiteConfig,
): Promise<AdapterTestResult> {
  const results: Array<{ ok: boolean; message: string }> = [];
  let passedCount = 0;
  let failedCount = 0;

  const assertFn: AssertFn = config.assert ?? ((condition, message) => {
    if (condition) {
      console.log(`  \x1b[32m[v]\x1b[0m ${message}`);
    } else {
      console.log(`  \x1b[31m[x]\x1b[0m ${message}`);
    }
  });

  const sectionFn: SectionFn = config.section ?? ((title) => {
    console.log(`\n\x1b[36m\x1b[1m> ${title}\x1b[0m`);
  });

  const check = (condition: boolean, message: string): void => {
    results.push({ ok: condition, message });
    if (condition) passedCount++;
    else failedCount++;
    assertFn(condition, message);
  };

  sectionFn(`${config.name} — Parameterized Test Suite`);

  const adapter = config.create();
  const defaultContext: AgentContext = config.context ?? { agentId: 'test-harness', taskId: 'harness-task-1' };

  // ── 1. Pre-init state ───────────────────────────────────
  check(adapter.isReady() === false, `${config.name}: not ready before init`);

  // ── 2. Initialize ───────────────────────────────────────
  await adapter.initialize(config.initConfig ?? {});
  check(adapter.isReady() === true, `${config.name}: ready after init`);

  // ── 3. Capabilities shape ───────────────────────────────
  const caps = adapter.capabilities;
  check(typeof caps.streaming === 'boolean', `${config.name}: capabilities.streaming is boolean`);
  check(typeof caps.parallel === 'boolean', `${config.name}: capabilities.parallel is boolean`);
  check(typeof caps.discovery === 'boolean', `${config.name}: capabilities.discovery is boolean`);

  // ── 4. Health check ─────────────────────────────────────
  const health = await adapter.healthCheck();
  check(health.healthy === true, `${config.name}: health check passes`);

  // ── 5. Register agent ───────────────────────────────────
  await config.registerAgent(adapter);
  const agents = await adapter.listAgents();
  check(agents.length >= 1, `${config.name}: lists ≥1 agent after registration (got ${agents.length})`);
  check(agents.some((a) => a.id === config.agentId), `${config.name}: finds registered agent '${config.agentId}'`);

  // ── 6. Agent availability ───────────────────────────────
  const available = await adapter.isAgentAvailable(config.agentId);
  check(available === true, `${config.name}: registered agent is available`);
  const notAvailable = await adapter.isAgentAvailable('nonexistent-agent-xyz');
  check(notAvailable === false, `${config.name}: unknown agent is not available`);

  // ── 7. Execute registered agent ─────────────────────────
  const result = await adapter.executeAgent(config.agentId, config.payload, defaultContext);
  if (config.expectSuccess !== false) {
    check(result.success === true, `${config.name}: execution succeeds`);
    check(result.data !== undefined && result.data !== null, `${config.name}: execution returns data`);
    check(result.metadata?.adapter === adapter.name, `${config.name}: metadata.adapter matches`);
  } else {
    // Some adapters may error without a real backend — just check it returned
    check(typeof result.success === 'boolean', `${config.name}: execution returns a result`);
  }

  // ── 8. Execute unknown agent → error ────────────────────
  const errResult = await adapter.executeAgent('nonexistent-agent-xyz', config.payload, defaultContext);
  check(errResult.success === false, `${config.name}: unknown agent returns error`);
  check(errResult.error !== undefined, `${config.name}: error has details`);

  // ── 9. Shutdown ─────────────────────────────────────────
  await adapter.shutdown();
  check(adapter.isReady() === false, `${config.name}: not ready after shutdown`);
  const postShutdownAgents = await adapter.listAgents();
  check(postShutdownAgents.length === 0, `${config.name}: agents cleared after shutdown`);

  return {
    adapterName: config.name,
    total: passedCount + failedCount,
    passed: passedCount,
    failed: failedCount,
    results,
  };
}
