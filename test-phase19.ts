/**
 * test-phase19.ts
 *
 * v5.15.0 — Context signal-over-noise suite:
 *   1. estimateTokens — heuristic token estimation
 *   2. ContextComposer — ranking (relevance/recency/affinity), pinning,
 *      token-budget enforcement, staleness exclusion, position-aware layout,
 *      semantic ranker integration + fallback, fromSnapshot conversion
 *   3. ContextMcpTools — context_pack and blackboard_search MCP tools
 *      (lexical + semantic modes, scoped snapshots, arg validation)
 */

import {
  ContextComposer,
  estimateTokens,
  createSemanticMemoryRanker,
} from './lib/context-composer';
import type { ContextSource, SemanticRanker } from './lib/context-composer';
import { ContextMcpTools, CONTEXT_TOOL_DEFINITIONS } from './lib/mcp-tools-context';
import type { IBlackboard } from './lib/mcp-blackboard-tools';

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

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function src(key: string, text: string, overrides: Partial<ContextSource> = {}): ContextSource {
  return { key, text, timestamp: iso(0), ...overrides };
}

// ---------------------------------------------------------------------------
// 1. estimateTokens
// ---------------------------------------------------------------------------

function testEstimateTokens() {
  header('estimateTokens — heuristic estimation');

  assert(estimateTokens('') === 0, 'empty string → 0 tokens');
  assert(estimateTokens('word') >= 1, 'single word → ≥ 1 token');

  const prose = 'The quick brown fox jumps over the lazy dog near the river bank today.';
  const t = estimateTokens(prose);
  assert(t >= 10 && t <= 25, 'short prose lands in a plausible range', String(t));

  const longer = prose.repeat(10);
  assert(estimateTokens(longer) > estimateTokens(prose) * 8, 'estimation scales roughly linearly');

  const json = JSON.stringify({ alpha: 1, beta: [1, 2, 3], gamma: { nested: true } });
  assert(estimateTokens(json) > 0, 'JSON text estimates > 0');
}

// ---------------------------------------------------------------------------
// 2. ContextComposer
// ---------------------------------------------------------------------------

async function testComposerRankingAndBudget() {
  header('ContextComposer — relevance ranking + budget enforcement');

  const composer = new ContextComposer();
  const sources: ContextSource[] = [
    src('task:payment-webhook', 'The payment webhook fails with a 401 from the billing api endpoint'),
    src('task:frontend-theme', 'Dark mode color palette tokens for the settings page'),
    src('notes:lunch', 'Team lunch is at noon on Friday'),
  ];

  const pack = await composer.compose(sources, {
    task: 'diagnose the failing payment webhook 401 error',
    budgetTokens: 2000,
  });

  assert(pack.included.length > 0, 'compose returns included items');
  assert(pack.included[0]?.key === 'task:payment-webhook', 'most relevant item ranked first',
    pack.included[0]?.key);
  const rel = pack.included.find((i) => i.key === 'task:payment-webhook');
  const irrel = [...pack.included, ...[]].find((i) => i.key === 'notes:lunch');
  assert((rel?.relevance ?? 0) > 0.3, 'relevant item has high relevance score', String(rel?.relevance));
  assert(irrel === undefined || irrel.relevance < (rel?.relevance ?? 0), 'irrelevant item scores lower');
  assert(pack.text.includes('payment webhook'), 'composed text contains the relevant entry');
  assert(pack.usedTokens > 0 && pack.usedTokens <= pack.budgetTokens, 'used tokens within budget');
  assert(pack.utilization > 0 && pack.utilization <= 1, 'utilization in (0, 1]');

  // Tight budget: only the top item(s) fit
  const tight = await composer.compose(sources, {
    task: 'diagnose the failing payment webhook 401 error',
    budgetTokens: 30,
  });
  assert(tight.usedTokens <= 30, 'tight budget respected', String(tight.usedTokens));
  assert(tight.excluded.some((e) => e.reason === 'budget'), 'over-budget items excluded with reason "budget"');
  assert(tight.included.length < sources.length, 'not everything fits a tight budget');

  // minScore excludes noise
  const strict = await composer.compose(sources, {
    task: 'diagnose the failing payment webhook 401 error',
    budgetTokens: 2000,
    minScore: 0.5,
  });
  assert(strict.excluded.some((e) => e.reason === 'score'), 'low-score items excluded with reason "score"');

  // maxItems cap
  const capped = await composer.compose(sources, {
    task: 'diagnose the failing payment webhook 401 error',
    budgetTokens: 2000,
    maxItems: 1,
  });
  assert(capped.included.length === 1, 'maxItems caps included entries', String(capped.included.length));
}

async function testComposerRecencyAndAffinity() {
  header('ContextComposer — recency decay + scope affinity');

  const composer = new ContextComposer({ halfLifeMs: 60_000 }); // 1-minute half-life
  const fresh = src('report:new', 'quarterly revenue analysis report with anomalies');
  const old = src('report:old', 'quarterly revenue analysis report with anomalies', { timestamp: iso(10 * 60_000) });

  const pack = await composer.compose([old, fresh], {
    task: 'quarterly revenue anomalies',
    budgetTokens: 4000,
  });
  const freshItem = pack.included.find((i) => i.key === 'report:new');
  const oldItem = pack.included.find((i) => i.key === 'report:old');
  assert((freshItem?.recency ?? 0) > 0.9, 'fresh entry has recency ≈ 1', String(freshItem?.recency));
  assert((oldItem?.recency ?? 1) < 0.01, '10-half-lives-old entry decays to ≈ 0', String(oldItem?.recency));
  assert((freshItem?.score ?? 0) > (oldItem?.score ?? 0), 'fresh beats stale at equal relevance');

  // Affinity: scope tags boost matching namespaces
  const tagged = await composer.compose(
    [src('analytics:q3', 'metrics dashboard numbers'), src('random:q3', 'metrics dashboard numbers')],
    { task: 'metrics dashboard', budgetTokens: 4000, scopeTags: ['analytics'] },
  );
  const inScope = tagged.included.find((i) => i.key === 'analytics:q3');
  const outScope = tagged.included.find((i) => i.key === 'random:q3');
  assert((inScope?.affinity ?? 0) === 1, 'scope-tag match → affinity 1');
  assert((outScope?.affinity ?? 1) === 0, 'no tag match → affinity 0');
  assert((inScope?.score ?? 0) > (outScope?.score ?? 0), 'affinity boosts total score');

  // No tags → neutral affinity
  const neutral = await composer.compose([src('a:x', 'alpha')], { task: 'alpha', budgetTokens: 500 });
  assert(neutral.included[0]?.affinity === 0.5, 'no scopeTags → neutral affinity 0.5');
}

async function testComposerPinnedStaleAndLayout() {
  header('ContextComposer — pinning, staleness, position-aware layout');

  const composer = new ContextComposer();

  // Pinned always first, even when irrelevant
  const pinnedPack = await composer.compose(
    [
      src('bb:relevant', 'the exact matching topic text for searching'),
      src('project:context', 'Project goals: ship v2. Banned: direct DB writes.', { pinned: true }),
    ],
    { task: 'matching topic text', budgetTokens: 4000 },
  );
  assert(pinnedPack.text.startsWith('### project:context'), 'pinned item leads the composed text');
  assert(pinnedPack.included.find((i) => i.key === 'project:context')?.score === 1, 'pinned items carry score 1');

  // Stale entries (TTL elapsed) are dropped
  const stalePack = await composer.compose(
    [
      src('fresh:key', 'relevant topic alpha', { ttl: 3600 }),
      src('stale:key', 'relevant topic alpha', { ttl: 60, timestamp: iso(2 * 3600 * 1000) }),
    ],
    { task: 'relevant topic alpha', budgetTokens: 4000 },
  );
  assert(stalePack.included.some((i) => i.key === 'fresh:key'), 'fresh TTL entry included');
  assert(stalePack.excluded.some((e) => e.key === 'stale:key' && e.reason === 'stale'), 'expired TTL entry excluded as stale');

  // Empty text excluded
  const emptyPack = await composer.compose(
    [src('empty:key', '   '), src('ok:key', 'real content topic')],
    { task: 'content topic', budgetTokens: 1000 },
  );
  assert(emptyPack.excluded.some((e) => e.key === 'empty:key' && e.reason === 'empty'), 'blank entries excluded as empty');

  // Position-aware layout: with 3 ranked items, #2-ranked ends up LAST in the text
  const many = [
    src('rank:first', 'payment webhook failure diagnosis payment webhook'),
    src('rank:second', 'payment webhook failure notes'),
    src('rank:third', 'payment mention only'),
  ];
  const layoutPack = await composer.compose(many, {
    task: 'payment webhook failure diagnosis',
    budgetTokens: 8000,
  });
  const order = layoutPack.text.split('### ').filter(Boolean).map((b) => b.split('\n')[0]?.trim());
  assert(order[0]?.startsWith('rank:first') === true, 'strongest item first in layout', order.join(','));
  assert(order[order.length - 1]?.startsWith('rank:second') === true, 'second-strongest item last (serpentine)', order.join(','));

  // positionAware: false → strict ranked order
  const flatPack = await composer.compose(many, {
    task: 'payment webhook failure diagnosis',
    budgetTokens: 8000,
    positionAware: false,
  });
  const flatOrder = flatPack.text.split('### ').filter(Boolean).map((b) => b.split('\n')[0]?.trim());
  assert(flatOrder[1]?.startsWith('rank:second') === true, 'positionAware:false keeps strict rank order');
}

async function testComposerSemanticRankerAndValidation() {
  header('ContextComposer — semantic ranker, fallback, validation, fromSnapshot');

  // Custom ranker drives relevance
  const ranker: SemanticRanker = async (_q, items) =>
    new Map(items.map((i) => [i.key, i.key === 'vec:winner' ? 0.95 : 0.05]));
  const composer = new ContextComposer({ ranker });
  const pack = await composer.compose(
    [src('vec:winner', 'unrelated words entirely'), src('vec:loser', 'unrelated words entirely')],
    { task: 'anything at all', budgetTokens: 2000 },
  );
  assert(pack.included[0]?.key === 'vec:winner', 'semantic ranker overrides lexical scoring');
  assert((pack.included[0]?.relevance ?? 0) === 0.95, 'ranker score used as relevance');

  // Throwing ranker → lexical fallback (not a crash)
  const failing = new ContextComposer({ ranker: async () => { throw new Error('embeddings down'); } });
  const fallback = await failing.compose(
    [src('lex:match', 'quarterly revenue analysis'), src('lex:miss', 'unrelated content')],
    { task: 'quarterly revenue analysis', budgetTokens: 2000 },
  );
  assert(fallback.included[0]?.key === 'lex:match', 'ranker failure falls back to lexical scoring');

  // createSemanticMemoryRanker adapts SemanticMemory.search and clamps scores
  const memoryLike = {
    search: async () => [
      { key: 'm:1', score: 1.7 },   // clamped to 1
      { key: 'm:2', score: -0.4 },  // clamped to 0
    ],
  };
  const adapted = createSemanticMemoryRanker(memoryLike);
  const scores = await adapted('q', [{ key: 'm:1', text: 'a' }, { key: 'm:2', text: 'b' }]);
  assert(scores.get('m:1') === 1, 'ranker adapter clamps scores above 1');
  assert(scores.get('m:2') === 0, 'ranker adapter clamps negative scores to 0');

  // Validation
  let threw = false;
  try { await composer.compose([], { task: '', budgetTokens: 100 }); } catch { threw = true; }
  assert(threw, 'empty task throws');
  threw = false;
  try { await composer.compose([], { task: 'x', budgetTokens: 0 }); } catch { threw = true; }
  assert(threw, 'zero budget throws');
  threw = false;
  try { new ContextComposer({ halfLifeMs: -5 }); } catch { threw = true; }
  assert(threw, 'negative half-life throws');
  threw = false;
  try { new ContextComposer({ weights: { relevance: 0, recency: 0, affinity: 0 } }); } catch { threw = true; }
  assert(threw, 'all-zero weights throw');

  // fromSnapshot: entry-shaped and plain values, truncation
  const snapshot = {
    'entry:full': { value: { a: 1 }, sourceAgent: 'analyst', timestamp: iso(0), ttl: 3600 },
    'plain:string': 'just a string value',
    'plain:number': 42,
    'entry:long': { value: 'y'.repeat(9000), source_agent: 'writer', timestamp: iso(0), ttl: null },
    'skip:null': null,
  } as Record<string, unknown>;
  const sources = ContextComposer.fromSnapshot(snapshot, { maxValueChars: 4000 });
  assert(sources.length === 4, 'fromSnapshot converts non-null entries', String(sources.length));
  const full = sources.find((s) => s.key === 'entry:full');
  assert(full?.sourceAgent === 'analyst' && full?.ttl === 3600, 'entry metadata preserved');
  assert(sources.find((s) => s.key === 'plain:string')?.text === 'just a string value', 'plain string preserved');
  const long = sources.find((s) => s.key === 'entry:long');
  assert((long?.text.length ?? 0) <= 4020 && (long?.text.includes('[truncated]') ?? false), 'oversized values truncated');
  assert(long?.sourceAgent === 'writer', 'snake_case source_agent accepted');
}

// ---------------------------------------------------------------------------
// 3. ContextMcpTools
// ---------------------------------------------------------------------------

type Entry = { key: string; value: unknown; sourceAgent: string; timestamp: string; ttl: number | null };

function mockBlackboard(entries: Entry[], scoped?: Record<string, Entry[]>): IBlackboard {
  const toRecord = (list: Entry[]) => Object.fromEntries(list.map((e) => [e.key, e]));
  return {
    read: (key) => entries.find((e) => e.key === key) ?? null,
    write: (key, value, sourceAgent, ttl) => {
      const entry: Entry = { key, value, sourceAgent, timestamp: new Date().toISOString(), ttl: ttl ?? null };
      entries.push(entry);
      return entry;
    },
    exists: (key) => entries.some((e) => e.key === key),
    getSnapshot: () => toRecord(entries),
    ...(scoped
      ? { getScopedSnapshot: (agentId: string) => toRecord(scoped[agentId] ?? []) as unknown as Record<string, unknown> }
      : {}),
  };
}

const ENTRIES: Entry[] = [
  { key: 'task:webhook', value: 'payment webhook returns 401 from billing api', sourceAgent: 'analyst', timestamp: iso(0), ttl: null },
  { key: 'task:theme', value: 'dark mode palette for settings page', sourceAgent: 'designer', timestamp: iso(0), ttl: null },
  { key: 'notes:standup', value: 'standup moved to 10am', sourceAgent: 'pm', timestamp: iso(0), ttl: null },
];

async function testContextPackTool() {
  header('ContextMcpTools — context_pack');

  const tools = new ContextMcpTools({ blackboard: mockBlackboard([...ENTRIES]) });

  const defs = tools.getDefinitions();
  assert(defs.length === 2, 'provider exposes two tool definitions');
  assert(defs.some((d) => d.name === 'context_pack') && defs.some((d) => d.name === 'blackboard_search'),
    'definitions include context_pack and blackboard_search');
  assert(CONTEXT_TOOL_DEFINITIONS.every((d) => d.inputSchema.required?.includes('agent_id')),
    'both tools require agent_id');

  const res = await tools.call('context_pack', {
    task: 'diagnose the payment webhook 401 billing error',
    agent_id: 'claude-code',
    budget_tokens: 500,
  });
  assert(res.ok === true, 'context_pack succeeds');
  const data = res.data as Record<string, unknown>;
  assert(typeof data.text === 'string' && (data.text as string).includes('payment webhook'), 'pack text contains relevant entry');
  assert(data.mode === 'lexical', 'mode reports lexical without embeddings');
  assert((data.used_tokens as number) <= 500, 'pack respects budget');
  const included = data.included as Array<{ key: string; score: number; tokens: number }>;
  assert(included[0]?.key === 'task:webhook', 'most relevant key ranked first in metadata');
  assert(typeof included[0]?.tokens === 'number', 'per-item token estimates included');

  // Budget as numeric string + clamping
  const strBudget = await tools.call('context_pack', {
    task: 'payment webhook', agent_id: 'a', budget_tokens: '250',
  });
  assert(strBudget.ok === true && ((strBudget.data as Record<string, unknown>).budget_tokens as number) === 250,
    'numeric-string budget accepted');
  const overMax = await tools.call('context_pack', {
    task: 'payment webhook', agent_id: 'a', budget_tokens: 9_999_999,
  });
  assert(((overMax.data as Record<string, unknown>).budget_tokens as number) === 32_000, 'budget clamped to maxBudgetTokens');

  // scope_tags parsing + max_items
  const scoped = await tools.call('context_pack', {
    task: 'anything', agent_id: 'a', scope_tags: 'task, notes', max_items: 1,
  });
  assert(scoped.ok === true, 'scope_tags + max_items accepted');
  assert(((scoped.data as Record<string, unknown>).included as unknown[]).length <= 1, 'max_items enforced');

  // Missing args
  const noTask = await tools.call('context_pack', { agent_id: 'a' });
  assert(noTask.ok === false && /task/.test(noTask.error ?? ''), 'missing task rejected');
  const noAgent = await tools.call('context_pack', { task: 'x' });
  assert(noAgent.ok === false && /agent_id/.test(noAgent.error ?? ''), 'missing agent_id rejected');

  // Unknown tool
  const unknown = await tools.call('context_nope', {});
  assert(unknown.ok === false && /Unknown tool/.test(unknown.error ?? ''), 'unknown tool rejected');
}

async function testBlackboardSearchTool() {
  header('ContextMcpTools — blackboard_search');

  const tools = new ContextMcpTools({ blackboard: mockBlackboard([...ENTRIES]) });

  const res = await tools.call('blackboard_search', {
    query: 'payment webhook billing 401',
    agent_id: 'claude-code',
    top_k: 2,
  });
  assert(res.ok === true, 'blackboard_search succeeds');
  const data = res.data as { mode: string; results: Array<{ key: string; score: number; snippet: string; sourceAgent?: string }>; count: number };
  assert(data.mode === 'lexical', 'search mode reports lexical');
  assert(data.results.length >= 1 && data.results.length <= 2, 'top_k respected');
  assert(data.results[0]?.key === 'task:webhook', 'most relevant key ranked first', data.results[0]?.key);
  assert(data.results[0]?.sourceAgent === 'analyst', 'sourceAgent surfaced');
  assert(data.results.every((r) => r.snippet.length <= 241), 'snippets truncated');
  assert(data.count === data.results.length, 'count matches results');

  // Irrelevant queries return few/no results (zero-relevance dropped)
  const none = await tools.call('blackboard_search', {
    query: 'zzz qqq xxyyzz totally absent tokens',
    agent_id: 'a',
  });
  const noneData = none.data as { results: unknown[] };
  assert(none.ok === true && noneData.results.length === 0, 'zero-relevance queries return no results');

  // Validation
  const noQuery = await tools.call('blackboard_search', { agent_id: 'a' });
  assert(noQuery.ok === false && /query/.test(noQuery.error ?? ''), 'missing query rejected');
}

async function testScopedAndSemanticModes() {
  header('ContextMcpTools — scoped snapshots + semantic mode');

  // Scoped snapshot: agent only sees its own keys
  const scopedBb = mockBlackboard([...ENTRIES], {
    'limited-agent': [ENTRIES[2] as Entry],
  });
  const scopedTools = new ContextMcpTools({ blackboard: scopedBb });
  const scoped = await scopedTools.call('context_pack', {
    task: 'standup schedule', agent_id: 'limited-agent',
  });
  const scopedData = scoped.data as { included: Array<{ key: string }> };
  assert(scopedData.included.length === 1 && scopedData.included[0]?.key === 'notes:standup',
    'scoped snapshot restricts pack to the agent\'s keys');

  // Semantic mode via SemanticSearchLike
  const memory = {
    search: async (_q: string, topK = 5) =>
      [{ key: 'task:theme', score: 0.99 }, { key: 'task:webhook', score: 0.10 }].slice(0, topK),
  };
  const semanticTools = new ContextMcpTools({ blackboard: mockBlackboard([...ENTRIES]), memory });
  const sem = await semanticTools.call('blackboard_search', {
    query: 'anything', agent_id: 'a', top_k: 2,
  });
  const semData = sem.data as { mode: string; results: Array<{ key: string }> };
  assert(semData.mode === 'semantic', 'mode reports semantic when memory wired');
  assert(semData.results[0]?.key === 'task:theme', 'semantic scores drive ranking');

  const semPack = await semanticTools.call('context_pack', { task: 'anything', agent_id: 'a' });
  assert(((semPack.data as Record<string, unknown>).mode) === 'semantic', 'context_pack reports semantic mode');

  // Constructor validation
  let threw = false;
  try { new ContextMcpTools({} as unknown as ConstructorParameters<typeof ContextMcpTools>[0]); } catch { threw = true; }
  assert(threw, 'missing blackboard throws');
  threw = false;
  try { new ContextMcpTools({ blackboard: mockBlackboard([]), defaultBudgetTokens: 0 }); } catch { threw = true; }
  assert(threw, 'non-positive default budget throws');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  process.stdout.write('\nPhase 19 — Context signal-over-noise (ContextComposer + MCP context tools)\n');

  testEstimateTokens();
  await testComposerRankingAndBudget();
  await testComposerRecencyAndAffinity();
  await testComposerPinnedStaleAndLayout();
  await testComposerSemanticRankerAndValidation();
  await testContextPackTool();
  await testBlackboardSearchTool();
  await testScopedAndSemanticModes();

  process.stdout.write(`\n${passed + failed} checks — ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.stdout.write(failures.map((f) => `  FAIL: ${f}`).join('\n') + '\n');
    process.exit(1);
  }
  process.stdout.write('ALL PHASE 19 TESTS PASSED ✓\n');
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
