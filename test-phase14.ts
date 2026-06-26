/**
 * test-phase14.ts
 *
 * v5.13.0 — Model-interaction lifecycle governance (Tier 1):
 *   #1 GovernedModelGateway + AnthropicMessagesAdapter
 *   #2 ModelBudget (cross-model cost + fallback-credit repricing)
 *   #3 RefusalTelemetry (refusal observability; refusal ≠ error)
 */

import {
  GovernedModelGateway,
  isRefusal,
  type ModelResponse,
  type ModelRequest,
  type ModelMessage,
  type EffortLevel,
} from './lib/model-gateway';
import { ModelBudget, costOfUsage } from './lib/model-budget';
import { RefusalTelemetry, CapturingTelemetryProvider } from './lib/telemetry-provider';
import {
  AnthropicMessagesAdapter,
  createAnthropicCaller,
  normalizeAnthropicResponse,
  type AnthropicRawResponse,
  type AnthropicMessagesApiClient,
} from './adapters/anthropic-messages-adapter';
import type { AgentContext } from './types/agent-adapter';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function pass(label: string) { passed++; process.stdout.write(`  ✓ ${label}\n`); }
function fail(label: string, reason: string) { failed++; failures.push(`${label}: ${reason}`); process.stdout.write(`  ✗ ${label} — ${reason}\n`); }
function assert(cond: boolean, label: string, detail = '') { if (cond) pass(label); else fail(label, detail || 'assertion failed'); }
function header(t: string) { process.stdout.write(`\n=== ${t} ===\n`); }
function near(a: number, b: number, eps = 1e-9): boolean { return Math.abs(a - b) <= eps; }

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function served(model: string, text = 'ok'): ModelResponse {
  return {
    model,
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    refusal: null,
    usage: { inputTokens: 100, outputTokens: 50 },
  };
}

function refusal(model: string, opts: { category?: string; creditToken?: string | null } = {}): ModelResponse {
  return {
    model,
    content: [],
    stopReason: 'refusal',
    refusal: {
      category: (opts.category ?? 'cyber') as 'cyber',
      explanation: 'declined',
      fallbackCreditToken: opts.creditToken ?? null,
      fallbackHasPrefillClaim: false,
    },
    usage: { inputTokens: 80, outputTokens: 0 },
  };
}

const PRIMARY = 'claude-fable-5';
const FALLBACK = 'claude-opus-4-8';

// ---------------------------------------------------------------------------
// #1 Gateway
// ---------------------------------------------------------------------------

async function testGatewayPrimaryServes() {
  header('#1 Gateway — primary serves (no fallback)');
  const seen: ModelRequest[] = [];
  const gw = new GovernedModelGateway({
    caller: async (req) => { seen.push(req); return served(req.model); },
    primaryModel: PRIMARY,
    fallbackModels: [FALLBACK],
  });
  const r = await gw.send({ messages: [{ role: 'user', content: 'hi' }] });
  assert(!r.refused, 'not refused');
  assert(!r.servedByFallback, 'served by primary, not fallback');
  assert(r.servedModel === PRIMARY, 'servedModel is primary', r.servedModel);
  assert(r.attempts.length === 1, 'exactly one attempt', String(r.attempts.length));
  assert(seen.length === 1, 'caller invoked once');
}

async function testGatewayRefusalThenFallback() {
  header('#1 Gateway — refusal → fallback served');
  const seen: ModelRequest[] = [];
  const gw = new GovernedModelGateway({
    caller: async (req) => {
      seen.push(req);
      return req.model === PRIMARY ? refusal(req.model, { creditToken: 'tok1' }) : served(req.model, 'fallback-answer');
    },
    primaryModel: PRIMARY,
    fallbackModels: [FALLBACK],
  });
  const r = await gw.send({ messages: [{ role: 'user', content: 'hi' }], agentId: 'a1' });
  assert(!r.refused, 'overall not refused (fallback served)');
  assert(r.servedByFallback, 'served by fallback');
  assert(r.servedModel === FALLBACK, 'servedModel is fallback', r.servedModel);
  assert(r.attempts.length === 2, 'two attempts recorded', String(r.attempts.length));
  assert(r.refusalCategories.length === 1 && r.refusalCategories[0] === 'cyber', 'one cyber refusal category');
  assert(seen.length === 2 && seen[1].fallbackCreditToken === 'tok1', 'credit token forwarded to fallback', String(seen[1]?.fallbackCreditToken));
}

async function testGatewayAllRefuse() {
  header('#1 Gateway — all models refuse');
  const gw = new GovernedModelGateway({
    caller: async (req) => refusal(req.model, { category: 'bio' }),
    primaryModel: PRIMARY,
    fallbackModels: [FALLBACK],
  });
  const r = await gw.send({ messages: [{ role: 'user', content: 'x' }] });
  assert(r.refused, 'refused when every model declines');
  assert(!r.servedByFallback, 'no model served');
  assert(r.attempts.length === 2, 'both models attempted', String(r.attempts.length));
}

async function testGatewayThinkingStripVsCredit() {
  header('#1 Gateway — thinking stripped on switch, kept when redeeming credit');
  const withThinking: ModelMessage[] = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '...', signature: 'sig' }, { type: 'text', text: 'partial' }] },
  ];

  // Case A: refusal WITHOUT credit → strip should run
  let stripCalls = 0;
  const seenA: ModelRequest[] = [];
  const gwA = new GovernedModelGateway({
    caller: async (req) => { seenA.push(req); return req.model === PRIMARY ? refusal(req.model, { creditToken: null }) : served(req.model); },
    primaryModel: PRIMARY,
    fallbackModels: [FALLBACK],
    thinking: { stripForModelSwitch: (m) => { stripCalls++; return m.filter((x) => x.role !== 'assistant'); } },
  });
  await gwA.send({ messages: withThinking });
  assert(stripCalls === 1, 'strip invoked once on credit-less switch', String(stripCalls));
  assert(Array.isArray(seenA[1].messages) && seenA[1].messages.length === 1, 'fallback got stripped messages', String(seenA[1]?.messages.length));

  // Case B: refusal WITH credit → strip must NOT run (exact body match required)
  let stripCallsB = 0;
  const seenB: ModelRequest[] = [];
  const gwB = new GovernedModelGateway({
    caller: async (req) => { seenB.push(req); return req.model === PRIMARY ? refusal(req.model, { creditToken: 'credit-xyz' }) : served(req.model); },
    primaryModel: PRIMARY,
    fallbackModels: [FALLBACK],
    thinking: { stripForModelSwitch: (m) => { stripCallsB++; return m; } },
  });
  await gwB.send({ messages: withThinking });
  assert(stripCallsB === 0, 'strip NOT invoked when redeeming credit', String(stripCallsB));
  assert(seenB[1].messages.length === withThinking.length, 'credit retry sends body unchanged', String(seenB[1]?.messages.length));
}

async function testGatewayEffortPolicy() {
  header('#1 Gateway — effort governance clamps requested effort');
  const seen: ModelRequest[] = [];
  const gw = new GovernedModelGateway({
    caller: async (req) => { seen.push(req); return served(req.model); },
    primaryModel: PRIMARY,
    effort: { resolve: (_req: EffortLevel | undefined) => 'low' },
  });
  await gw.send({ messages: [{ role: 'user', content: 'hi' }], effort: 'max' });
  assert(seen[0].effort === 'low', 'requested max effort clamped to low', String(seen[0]?.effort));
}

async function testGatewayBudgetAndTelemetry() {
  header('#1 Gateway — budget accounting + refusal telemetry');
  const budget = new ModelBudget({
    ceilingUsd: 100,
    pricing: { [PRIMARY]: { inputPerMTok: 10, outputPerMTok: 50 }, [FALLBACK]: { inputPerMTok: 5, outputPerMTok: 25 } },
  });
  const telemetry = new RefusalTelemetry(new CapturingTelemetryProvider());
  const gw = new GovernedModelGateway({
    caller: async (req) => (req.model === PRIMARY ? refusal(req.model, { creditToken: 't' }) : served(req.model)),
    primaryModel: PRIMARY,
    fallbackModels: [FALLBACK],
    budget,
    telemetry,
  });
  const r = await gw.send({ messages: [{ role: 'user', content: 'hi' }] });
  assert(typeof r.totalCostUsd === 'number' && r.totalCostUsd! > 0, 'totalCostUsd computed', String(r.totalCostUsd));
  assert(telemetry.refusalCount === 1, 'one refusal recorded', String(telemetry.refusalCount));
  assert(telemetry.fallbackServedCount === 1, 'one fallback-served recorded', String(telemetry.fallbackServedCount));
  assert(telemetry.unservedRefusalCount === 0, 'no unserved refusals (gap closed)', String(telemetry.unservedRefusalCount));
}

function testIsRefusalHelper() {
  header('#1 Gateway — isRefusal helper');
  assert(isRefusal(refusal(PRIMARY)), 'isRefusal true for refusal');
  assert(!isRefusal(served(PRIMARY)), 'isRefusal false for served');
}

// ---------------------------------------------------------------------------
// #2 ModelBudget
// ---------------------------------------------------------------------------

function testCostOfUsage() {
  header('#2 ModelBudget — costOfUsage pricing');
  const p = { inputPerMTok: 10, outputPerMTok: 50 };
  assert(near(costOfUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, p), 60), 'base input+output = $60');
  assert(near(costOfUsage({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000 }, p), 1), 'cache read at 0.1× input = $1');
  assert(near(costOfUsage({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 1_000_000 }, p), 12.5), 'cache write at 1.25× input = $12.5');
  assert(near(costOfUsage({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 1_000_000 }, p, { creditRedeemed: true }), 1), 'credit reprices cache write as read = $1');
}

function testModelBudgetCeiling() {
  header('#2 ModelBudget — recordAttempt ceiling');
  const b = new ModelBudget({ ceilingUsd: 50, pricing: { [PRIMARY]: { inputPerMTok: 10, outputPerMTok: 50 } } });
  const rec = b.recordAttempt(PRIMARY, { inputTokens: 1_000_000, outputTokens: 1_000_000 }); // $60
  assert(near(rec.costUsd, 60), 'attempt cost $60', String(rec.costUsd));
  assert(rec.allowed === false, 'over-ceiling attempt marks allowed=false');
  assert(rec.remainingUsd === 0, 'remaining clamped to 0', String(rec.remainingUsd));
}

function testModelBudgetIterations() {
  header('#2 ModelBudget — accountIterations (server-side fallback)');
  const b = new ModelBudget({
    ceilingUsd: 1000,
    pricing: { [PRIMARY]: { inputPerMTok: 10, outputPerMTok: 50 }, [FALLBACK]: { inputPerMTok: 5, outputPerMTok: 25 } },
  });
  const total = b.accountIterations([
    { type: 'message', model: PRIMARY, inputTokens: 408, outputTokens: 0 },
    { type: 'fallback_message', model: FALLBACK, inputTokens: 412, outputTokens: 264, cacheCreationInputTokens: 1000 },
  ]);
  assert(total > 0, 'total cost across iterations > 0', String(total));
  const perModel = b.getPerModelUsd();
  assert(perModel[PRIMARY] !== undefined && perModel[FALLBACK] !== undefined, 'both models accounted');
}

function testModelBudgetTokenForward() {
  header('#2 ModelBudget — forwards tokens to a token budget');
  let forwarded = 0;
  const tokenBudget = { spend: (_id: string, t: number) => { forwarded += t; return { allowed: true }; } };
  const b = new ModelBudget({ ceilingUsd: 100, pricing: { [PRIMARY]: { inputPerMTok: 10, outputPerMTok: 50 } }, tokenBudget });
  b.recordAttempt(PRIMARY, { inputTokens: 100, outputTokens: 50 });
  assert(forwarded === 150, 'token budget debited 150 tokens', String(forwarded));
}

// ---------------------------------------------------------------------------
// #3 RefusalTelemetry
// ---------------------------------------------------------------------------

function testRefusalTelemetry() {
  header('#3 RefusalTelemetry — counters and the unserved gap');
  const t = new RefusalTelemetry();
  t.recordRefusal({ model: PRIMARY, category: 'cyber' });
  t.recordRefusal({ model: PRIMARY, category: 'bio' });
  t.recordFallbackServed({ requestedModel: PRIMARY, servedModel: FALLBACK });
  const snap = t.snapshot();
  assert(snap.refusals === 2, 'two refusals', String(snap.refusals));
  assert(snap.fallbackServed === 1, 'one fallback served', String(snap.fallbackServed));
  assert(snap.unservedRefusals === 1, 'unserved gap = 1', String(snap.unservedRefusals));
  assert(snap.byCategory['cyber'] === 1 && snap.byCategory['bio'] === 1, 'per-category counts correct');
}

function testRefusalTelemetryEmitsNonError() {
  header('#3 RefusalTelemetry — emits non-error spans');
  const cap = new CapturingTelemetryProvider();
  const t = new RefusalTelemetry(cap);
  t.recordRefusal({ model: PRIMARY, category: 'cyber' });
  const span = cap.spans.find((s) => s.name === 'model.refusal');
  assert(span !== undefined, 'refusal span emitted');
  assert(span?.status === 'ok', 'refusal span closed ok, not error', String(span?.status));
}

// ---------------------------------------------------------------------------
// Anthropic adapter binding
// ---------------------------------------------------------------------------

function testNormalizeAnthropic() {
  header('Adapter — normalizeAnthropicResponse');
  const rawRefusal: AnthropicRawResponse = {
    model: PRIMARY,
    content: [],
    stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: 'cyber', explanation: 'no', fallback_credit_token: 'tok', fallback_has_prefill_claim: false },
    usage: { input_tokens: 412, output_tokens: 0 },
  };
  const n = normalizeAnthropicResponse(rawRefusal, PRIMARY);
  assert(n.stopReason === 'refusal' && n.refusal?.category === 'cyber', 'refusal mapped with category');
  assert(n.refusal?.fallbackCreditToken === 'tok', 'credit token mapped');

  const rawOk: AnthropicRawResponse = { model: PRIMARY, content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
  const n2 = normalizeAnthropicResponse(rawOk, PRIMARY);
  assert(n2.refusal === null && n2.stopReason === 'end_turn', 'served response has null refusal');
  assert(n2.usage.inputTokens === 10 && n2.usage.outputTokens === 5, 'usage mapped');
}

async function testCreateCallerParams() {
  header('Adapter — createAnthropicCaller maps effort + credit beta');
  let captured: Record<string, unknown> | undefined;
  const client: AnthropicMessagesApiClient = {
    create: async (params) => { captured = params as Record<string, unknown>; return { model: FALLBACK, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }; },
  };
  const caller = createAnthropicCaller(client);
  await caller({ model: FALLBACK, messages: [{ role: 'user', content: 'hi' }], effort: 'medium', fallbackCreditToken: 'tok' });
  assert((captured?.['output_config'] as { effort?: string })?.effort === 'medium', 'effort mapped to output_config');
  assert(captured?.['fallback_credit_token'] === 'tok', 'credit token forwarded');
  assert(Array.isArray(captured?.['betas']) && (captured?.['betas'] as string[]).includes('fallback-credit-2026-06-01'), 'credit beta header set');
}

async function testAdapterExecute() {
  header('Adapter — executeAgent governed served + refused');
  const ctx: AgentContext = { agentId: 'caller' };

  // Served-via-fallback agent
  const okClient: AnthropicMessagesApiClient = {
    create: async (params) => params.model === PRIMARY
      ? { model: PRIMARY, content: [], stop_reason: 'refusal', stop_details: { category: 'cyber' }, usage: { input_tokens: 1, output_tokens: 0 } }
      : { model: FALLBACK, content: [{ type: 'text', text: 'served' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
  };
  const adapter = new AnthropicMessagesAdapter();
  await adapter.initialize({});
  adapter.registerModelAgent('analyst', { client: okClient, model: PRIMARY, fallbackModels: [FALLBACK] });
  const r1 = await adapter.executeAgent('analyst', { action: 'Summarize', params: {} }, ctx);
  assert(r1.success, 'served result is success');
  assert((r1.data as { servedByFallback?: boolean }).servedByFallback === true, 'data marks servedByFallback');

  // Always-refuse agent
  const refuseClient: AnthropicMessagesApiClient = {
    create: async (params) => ({ model: params.model, content: [], stop_reason: 'refusal', stop_details: { category: 'bio' }, usage: { input_tokens: 1, output_tokens: 0 } }),
  };
  adapter.registerModelAgent('blocked', { client: refuseClient, model: PRIMARY, fallbackModels: [FALLBACK] });
  const r2 = await adapter.executeAgent('blocked', { action: 'do', params: {} }, ctx);
  assert(!r2.success && r2.error?.code === 'MODEL_REFUSED', 'all-refuse result is MODEL_REFUSED failure');

  // Unknown agent
  const r3 = await adapter.executeAgent('nope', { action: 'do', params: {} }, ctx);
  assert(!r3.success && r3.error?.code === 'MODEL_AGENT_NOT_FOUND', 'unknown agent reported');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  process.stdout.write('\n========================================\n');
  process.stdout.write('  Phase 14 — Model Lifecycle Governance (Tier 1)\n');
  process.stdout.write('========================================\n');

  await testGatewayPrimaryServes();
  await testGatewayRefusalThenFallback();
  await testGatewayAllRefuse();
  await testGatewayThinkingStripVsCredit();
  await testGatewayEffortPolicy();
  await testGatewayBudgetAndTelemetry();
  testIsRefusalHelper();

  testCostOfUsage();
  testModelBudgetCeiling();
  testModelBudgetIterations();
  testModelBudgetTokenForward();

  testRefusalTelemetry();
  testRefusalTelemetryEmitsNonError();

  testNormalizeAnthropic();
  await testCreateCallerParams();
  await testAdapterExecute();

  process.stdout.write(`\n========================================\n`);
  process.stdout.write(`  Phase 14: ${passed} passed, ${failed} failed\n`);
  process.stdout.write('========================================\n');
  if (failed > 0) {
    process.stdout.write('\nFailures:\n');
    failures.forEach((f) => process.stdout.write(`  - ${f}\n`));
    process.exit(1);
  }
}

main().catch((err) => { process.stdout.write(`\nFATAL: ${err instanceof Error ? err.stack : String(err)}\n`); process.exit(1); });
