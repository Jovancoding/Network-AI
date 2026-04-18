/**
 * Tests for Live Agent Topology (Phase 11)
 *
 * Tests: TopologyTracker, DashboardServer
 * Suite: test-topology
 */

// ============================================================================
// MINIMAL TEST HARNESS
// ============================================================================

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
  if (!condition) {
    failed++;
    failures.push(message);
    console.error(`  ✗ ${message}`);
  } else {
    passed++;
    console.log(`  ✓ ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    failed++;
    const detail = `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    failures.push(detail);
    console.error(`  ✗ ${detail}`);
  } else {
    passed++;
    console.log(`  ✓ ${message}`);
  }
}

function section(name: string): void {
  console.log(`\n─── ${name} ───`);
}

// ============================================================================
// IMPORTS
// ============================================================================

import {
  TopologyTracker,
} from './lib/topology';
import type {
  AgentNode,
  TopologyEdge,
  TopologyEvent,
  TopologySnapshot,
  AgentNodeStatus,
  AgentCluster,
  TopologyDelta,
} from './lib/topology';
import { DashboardServer } from './lib/dashboard-server';
import { QuadTree } from './lib/quadtree';
import type { QTPoint, QTBounds } from './lib/quadtree';
import { WorkTree } from './lib/work-tree';
import type { WorkNode } from './lib/work-tree';
import { WorkTreeUI } from './lib/work-tree-ui';
import { WorkTreeDashboard } from './lib/work-tree-dashboard';
import * as http from 'http';

// ============================================================================
// TopologyTracker — Node Operations
// ============================================================================

section('TopologyTracker — Node Operations');

{
  const topo = new TopologyTracker();

  // Add agent
  const node = topo.addAgent({ id: 'agent-1', label: 'Test Agent', role: 'worker' });
  assertEqual(node.id, 'agent-1', 'addAgent returns correct id');
  assertEqual(node.label, 'Test Agent', 'addAgent returns correct label');
  assertEqual(node.role, 'worker', 'addAgent returns correct role');
  assertEqual(node.status, 'idle', 'addAgent defaults to idle status');
  assertEqual(node.tokensUsed, 0, 'addAgent starts with 0 tokens');
  assert(!!node.registeredAt, 'addAgent sets registeredAt');
  assertEqual(topo.nodeCount(), 1, 'nodeCount is 1 after adding');

  // Get agent
  const fetched = topo.getAgent('agent-1');
  assert(fetched !== undefined, 'getAgent returns the agent');
  assertEqual(fetched!.id, 'agent-1', 'getAgent returns correct id');

  // Get non-existent
  assertEqual(topo.getAgent('nope'), undefined, 'getAgent returns undefined for unknown');

  // Add second agent
  topo.addAgent({ id: 'agent-2', role: 'planner', adapter: 'langchain' });
  assertEqual(topo.nodeCount(), 2, 'nodeCount is 2');

  // Get all agents
  const all = topo.getAgents();
  assertEqual(all.length, 2, 'getAgents returns 2 agents');

  // Add agent with default label
  const auto = topo.addAgent({ id: 'agent-3' });
  assertEqual(auto.label, 'agent-3', 'label defaults to id');
  assertEqual(auto.role, 'worker', 'role defaults to worker');

  // Update existing agent (addAgent merges)
  topo.addAgent({ id: 'agent-1', adapter: 'crewai', metadata: { custom: true } });
  const updated = topo.getAgent('agent-1');
  assertEqual(updated!.adapter, 'crewai', 'addAgent updates adapter on existing node');
  assertEqual((updated!.metadata as any).custom, true, 'addAgent merges metadata');

  // Remove agent
  const removed = topo.removeAgent('agent-3');
  assertEqual(removed, true, 'removeAgent returns true');
  assertEqual(topo.nodeCount(), 2, 'nodeCount decreases after removal');

  // Remove non-existent
  assertEqual(topo.removeAgent('ghost'), false, 'removeAgent returns false for unknown');
}

// ============================================================================
// TopologyTracker — Status & Task
// ============================================================================

section('TopologyTracker — Status & Task');

{
  const topo = new TopologyTracker();
  topo.addAgent({ id: 'a1' });

  // Set status
  topo.setStatus('a1', 'running');
  assertEqual(topo.getAgent('a1')!.status, 'running', 'setStatus updates to running');

  // Set same status — no event
  const events: TopologyEvent[] = [];
  topo.on('event', (e: TopologyEvent) => events.push(e));
  topo.setStatus('a1', 'running'); // same status
  // The 'event' listener was added after this call, so we check no duplicate status event
  assertEqual(events.filter(e => e.type === 'agent:status').length, 0, 'setStatus skips duplicate status');

  topo.setStatus('a1', 'completed');
  assertEqual(events.filter(e => e.type === 'agent:status').length, 1, 'setStatus emits on change');
  assertEqual(topo.getAgent('a1')!.status, 'completed', 'status updated to completed');

  // Set status on unknown agent — no crash
  topo.setStatus('unknown', 'failed');
  assertEqual(topo.getAgent('unknown'), undefined, 'setStatus on unknown is a no-op');

  // Set task
  topo.setTask('a1', 'Analyzing code');
  assertEqual(topo.getAgent('a1')!.currentTask, 'Analyzing code', 'setTask sets task');

  // Clear task
  topo.setTask('a1', undefined);
  assertEqual(topo.getAgent('a1')!.currentTask, undefined, 'setTask clears task with undefined');

  topo.removeAllListeners();
}

// ============================================================================
// TopologyTracker — Tokens
// ============================================================================

section('TopologyTracker — Tokens');

{
  const topo = new TopologyTracker();
  topo.addAgent({ id: 't1', tokenBudget: 1000 });

  topo.addTokens('t1', 250);
  assertEqual(topo.getAgent('t1')!.tokensUsed, 250, 'addTokens adds 250');

  topo.addTokens('t1', 350);
  assertEqual(topo.getAgent('t1')!.tokensUsed, 600, 'addTokens accumulates to 600');

  // Tokens event
  let tokenEvent: TopologyEvent | null = null;
  topo.on('event', (e: TopologyEvent) => {
    if (e.type === 'agent:tokens') tokenEvent = e;
  });
  topo.addTokens('t1', 100);
  assert(tokenEvent !== null, 'addTokens emits event');
  assertEqual((tokenEvent!.data as any).tokens, 700, 'token event has total');
  assertEqual((tokenEvent!.data as any).delta, 100, 'token event has delta');

  topo.removeAllListeners();
}

// ============================================================================
// TopologyTracker — Edge Operations
// ============================================================================

section('TopologyTracker — Edge Operations');

{
  const topo = new TopologyTracker();
  topo.addAgent({ id: 'src' });
  topo.addAgent({ id: 'dst' });

  // Add edge
  const edge = topo.addEdge('src', 'dst', 'delegation', 'task-1');
  assert(!!edge.id, 'addEdge returns edge with id');
  assertEqual(edge.from, 'src', 'edge.from is correct');
  assertEqual(edge.to, 'dst', 'edge.to is correct');
  assertEqual(edge.type, 'delegation', 'edge.type is correct');
  assertEqual(edge.label, 'task-1', 'edge.label is correct');
  assertEqual(topo.edgeCount(), 1, 'edgeCount is 1');

  // Add more edges
  topo.addEdge('src', '_blackboard', 'blackboard_write', 'key1');
  topo.addEdge('dst', '_blackboard', 'blackboard_read', 'key1');
  assertEqual(topo.edgeCount(), 3, 'edgeCount is 3');

  // Get all edges
  assertEqual(topo.getEdges().length, 3, 'getEdges returns 3');

  // Get edges for agent
  assertEqual(topo.getEdges('src').length, 2, 'getEdges(src) returns 2');
  assertEqual(topo.getEdges('dst').length, 2, 'getEdges(dst) returns 2');
  assertEqual(topo.getEdges('_blackboard').length, 2, 'getEdges(_blackboard) returns 2');

  // Get edges between
  assertEqual(topo.getEdgesBetween('src', 'dst').length, 1, 'getEdgesBetween returns 1');
  assertEqual(topo.getEdgesBetween('dst', 'src').length, 0, 'getEdgesBetween is directional');

  // Remove edge
  const removed = topo.removeEdge(edge.id);
  assertEqual(removed, true, 'removeEdge returns true');
  assertEqual(topo.edgeCount(), 2, 'edgeCount after removal is 2');
  assertEqual(topo.removeEdge('fake'), false, 'removeEdge returns false for unknown');

  // Removing an agent removes its edges
  topo.removeAgent('src');
  assertEqual(topo.edgeCount(), 1, 'removing agent removes its edges');
}

// ============================================================================
// TopologyTracker — Edge Limits
// ============================================================================

section('TopologyTracker — Edge Limits');

{
  const topo = new TopologyTracker({ maxEdges: 5 });
  topo.addAgent({ id: 'a' });
  topo.addAgent({ id: 'b' });

  for (let i = 0; i < 8; i++) {
    topo.addEdge('a', 'b', 'message', `msg-${i}`);
  }

  assert(topo.edgeCount() <= 6, 'edge count stays near maxEdges limit');
}

// ============================================================================
// TopologyTracker — Events
// ============================================================================

section('TopologyTracker — Events');

{
  const topo = new TopologyTracker({ maxEvents: 10 });
  const events: TopologyEvent[] = [];
  topo.on('event', (e: TopologyEvent) => events.push(e));

  topo.addAgent({ id: 'e1' });
  topo.setStatus('e1', 'running');
  topo.setTask('e1', 'work');
  topo.addTokens('e1', 100);
  topo.addEdge('e1', '_bb', 'blackboard_write', 'key');
  topo.removeEdge(topo.getEdges()[0].id);
  topo.removeAgent('e1');

  assertEqual(events.length, 7, 'all events emitted (status + task + tokens + edge-add + edge-remove + agent-edge-remove + agent-remove)');

  // Sequence numbers are monotonic
  let monotonic = true;
  for (let i = 1; i < events.length; i++) {
    if (events[i].seq <= events[i - 1].seq) {
      monotonic = false;
      break;
    }
  }
  assert(monotonic, 'event seq numbers are monotonically increasing');

  // Event log pruning
  const topo2 = new TopologyTracker({ maxEvents: 5 });
  for (let i = 0; i < 20; i++) {
    topo2.addAgent({ id: `n-${i}` });
  }
  assert(topo2.getEvents().length <= 6, 'event log respects maxEvents');

  topo.removeAllListeners();
}

// ============================================================================
// TopologyTracker — Snapshot
// ============================================================================

section('TopologyTracker — Snapshot');

{
  const topo = new TopologyTracker();
  topo.addAgent({ id: 'x1', role: 'orchestrator' });
  topo.addAgent({ id: 'x2', role: 'worker' });
  topo.addEdge('x1', 'x2', 'delegation');
  topo.setStatus('x1', 'running');

  const snap = topo.snapshot();
  assertEqual(snap.nodes.length, 2, 'snapshot has 2 nodes');
  assertEqual(snap.edges.length, 1, 'snapshot has 1 edge');
  assert(snap.events.length > 0, 'snapshot has events');
  assert(!!snap.timestamp, 'snapshot has timestamp');

  // Snapshot event emitted
  let snapEvent = false;
  topo.on('snapshot', () => { snapEvent = true; });
  topo.snapshot();
  assert(snapEvent, 'snapshot emits snapshot event');

  topo.removeAllListeners();
}

// ============================================================================
// TopologyTracker — Clear
// ============================================================================

section('TopologyTracker — Clear');

{
  const topo = new TopologyTracker();
  topo.addAgent({ id: 'c1' });
  topo.addAgent({ id: 'c2' });
  topo.addEdge('c1', 'c2', 'message');

  let cleared = false;
  topo.on('clear', () => { cleared = true; });
  topo.clear();

  assertEqual(topo.nodeCount(), 0, 'clear removes all nodes');
  assertEqual(topo.edgeCount(), 0, 'clear removes all edges');
  assertEqual(topo.getEvents().length, 0, 'clear removes all events');
  assert(cleared, 'clear emits clear event');

  topo.removeAllListeners();
}

// ============================================================================
// TopologyTracker — Edge TTL
// ============================================================================

section('TopologyTracker — Edge TTL');

{
  const topo = new TopologyTracker({ edgeTtlMs: 50 });
  topo.addAgent({ id: 'ttl1' });
  topo.addAgent({ id: 'ttl2' });
  topo.addEdge('ttl1', 'ttl2', 'message', 'old');

  // Edges exist initially
  assertEqual(topo.edgeCount(), 1, 'edge exists before TTL');

  // After TTL, snapshot prunes
  // We create a manually-backdated edge for testing
  const edgeMap = (topo as any).edges as Map<string, TopologyEdge>;
  for (const edge of edgeMap.values()) {
    (edge as any).timestamp = new Date(Date.now() - 100).toISOString();
  }

  topo.snapshot(); // triggers prune
  assertEqual(topo.edgeCount(), 0, 'expired edges pruned on snapshot');
}

// ============================================================================
// TopologyTracker — EventEmitter Events
// ============================================================================

section('TopologyTracker — Typed Events');

{
  const topo = new TopologyTracker();
  const events: string[] = [];

  topo.on('agent:added', (node: AgentNode) => events.push(`added:${node.id}`));
  topo.on('agent:removed', (id: string) => events.push(`removed:${id}`));
  topo.on('agent:status', (id: string, status: AgentNodeStatus) => events.push(`status:${id}:${status}`));
  topo.on('agent:task', (id: string, task: string | undefined) => events.push(`task:${id}:${task}`));
  topo.on('agent:tokens', (id: string, tokens: number) => events.push(`tokens:${id}:${tokens}`));
  topo.on('edge:added', (edge: TopologyEdge) => events.push(`edge:${edge.from}->${edge.to}`));
  topo.on('edge:removed', (edgeId: string) => events.push(`edge-rm:${edgeId}`));

  topo.addAgent({ id: 'ev1' });
  topo.setStatus('ev1', 'running');
  topo.setTask('ev1', 'work');
  topo.addTokens('ev1', 50);
  const edge = topo.addEdge('ev1', 'ev2', 'delegation');
  topo.removeEdge(edge.id);
  topo.removeAgent('ev1');

  assert(events.includes('added:ev1'), 'agent:added event fired');
  assert(events.includes('status:ev1:running'), 'agent:status event fired');
  assert(events.includes('task:ev1:work'), 'agent:task event fired');
  assert(events.includes('tokens:ev1:50'), 'agent:tokens event fired');
  assert(events.includes('edge:ev1->ev2'), 'edge:added event fired');
  assert(events.some(e => e.startsWith('edge-rm:')), 'edge:removed event fired');
  assert(events.includes('removed:ev1'), 'agent:removed event fired');

  topo.removeAllListeners();
}

// ============================================================================
// TopologyTracker — getEvents(since)
// ============================================================================

section('TopologyTracker — getEvents(since)');

{
  const topo = new TopologyTracker();
  topo.addAgent({ id: 's1' });
  topo.addAgent({ id: 's2' });
  topo.setStatus('s1', 'running');

  const all = topo.getEvents();
  assert(all.length >= 3, 'all events returned');

  const since = all[1].seq;
  const after = topo.getEvents(since);
  assert(after.length < all.length, 'getEvents(since) filters older');
  assert(after.every(e => e.seq > since), 'all returned events have seq > since');
}

// ============================================================================
// DashboardServer — Construction & Start/Stop
// ============================================================================

section('DashboardServer — Lifecycle');

{
  const topo = new TopologyTracker();
  const srv = new DashboardServer(topo, { port: 0, host: '127.0.0.1' });

  // Just test construction — don't actually bind a port in test
  assert(srv instanceof DashboardServer, 'DashboardServer constructs');
  assertEqual(srv.clientCount(), 0, 'starts with 0 clients');
  assertEqual(srv.url, 'http://127.0.0.1:0', 'url is correct');
}

// ============================================================================
// TopologyTracker — Narrative Generation
// ============================================================================

section('TopologyTracker — Narrative');

{
  const topo = new TopologyTracker();
  assertEqual(topo.generateNarrative(), 'No agents registered.', 'narrative with no agents');

  topo.addAgent({ id: 'a1', role: 'worker' });
  topo.addAgent({ id: 'a2', role: 'worker' });
  assert(topo.generateNarrative().includes('idle'), 'narrative shows idle when all idle');

  topo.setStatus('a1', 'running');
  assert(topo.generateNarrative().includes('running'), 'narrative includes running');

  topo.setStatus('a2', 'completed');
  assert(topo.generateNarrative().includes('completed'), 'narrative includes completed count');

  topo.addAgent({ id: 'a3', role: 'worker' });
  topo.setStatus('a3', 'failed');
  assert(topo.generateNarrative().includes('failed'), 'narrative includes failed count');

  topo.addAgent({ id: 'a4', role: 'worker' });
  topo.setStatus('a4', 'waiting');
  assert(topo.generateNarrative().includes('waiting'), 'narrative includes waiting');
}

// ============================================================================
// TopologyTracker — Phase Progress
// ============================================================================

section('TopologyTracker — Phase Progress');

{
  const topo = new TopologyTracker();
  const emptyPhase = topo.computePhase();
  assertEqual(emptyPhase.milestones.length, 0, 'no milestones when no agents');
  assertEqual(emptyPhase.progress, 0, 'zero progress when no agents');
  assertEqual(emptyPhase.currentPhase, 'idle', 'idle phase when no agents');

  topo.addAgent({ id: 'orch', role: 'orchestrator' });
  topo.addAgent({ id: 'plan', role: 'planner' });
  topo.addAgent({ id: 'w1', role: 'worker' });
  topo.addAgent({ id: 'val', role: 'validator' });
  topo.addAgent({ id: 'agg', role: 'aggregator' });

  const initPhase = topo.computePhase();
  assertEqual(initPhase.milestones.length, 5, 'all 5 milestones created');
  assert(initPhase.milestones.every(m => m.status === 'pending'), 'all milestones pending initially');

  topo.setStatus('orch', 'running');
  const p1 = topo.computePhase();
  assertEqual(p1.milestones[0].status, 'active', 'orchestrate phase is active');
  assertEqual(p1.currentPhase, 'Orchestrate', 'current phase is Orchestrate');

  topo.setStatus('orch', 'completed');
  topo.setStatus('plan', 'running');
  const p2 = topo.computePhase();
  assertEqual(p2.milestones[0].status, 'completed', 'orchestrate completed');
  assertEqual(p2.milestones[1].status, 'active', 'plan is active');
  assertEqual(p2.currentPhase, 'Plan', 'current phase is Plan');
  assert(p2.progress > 0, 'progress is nonzero after phase completion');
  assertEqual(p2.progress, 1 / 5, 'progress is 1/5 after first phase complete');

  topo.setStatus('plan', 'completed');
  topo.setStatus('w1', 'completed');
  topo.setStatus('val', 'completed');
  topo.setStatus('agg', 'completed');
  const pFinal = topo.computePhase();
  assertEqual(pFinal.progress, 1, 'progress is 1 when all phases completed');
  assert(pFinal.milestones.every(m => m.status === 'completed'), 'all milestones completed');
}

// ============================================================================
// TopologyTracker — Attention Panel
// ============================================================================

section('TopologyTracker — Attention Panel');

{
  const topo = new TopologyTracker();
  const empty = topo.computeAttention();
  assertEqual(empty.needsAttention.length, 0, 'no attention items when empty');
  assertEqual(empty.activeNow.length, 0, 'no active items when empty');
  assertEqual(empty.recentlyCompleted.length, 0, 'no completed items when empty');

  topo.addAgent({ id: 'run1', role: 'worker', label: 'Runner' });
  topo.setStatus('run1', 'running');
  const attn1 = topo.computeAttention();
  assertEqual(attn1.activeNow.length, 1, 'running agent shows in activeNow');
  assertEqual(attn1.activeNow[0].agentId, 'run1', 'correct agent in activeNow');

  topo.addAgent({ id: 'fail1', role: 'worker', label: 'Failer' });
  topo.setStatus('fail1', 'failed');
  const attn2 = topo.computeAttention();
  assertEqual(attn2.needsAttention.length, 1, 'failed agent needs attention');
  assert(attn2.needsAttention[0].severity === 'critical', 'failed agent is critical');

  topo.addAgent({ id: 'done1', role: 'worker', label: 'Doner' });
  topo.setStatus('done1', 'running');
  topo.setStatus('done1', 'completed');
  const attn3 = topo.computeAttention();
  assert(attn3.recentlyCompleted.length >= 1, 'completed agent in recentlyCompleted');

  // Budget overrun detection
  topo.addAgent({ id: 'budget1', role: 'worker', label: 'Big Spender', tokenBudget: 100 });
  topo.setStatus('budget1', 'running');
  topo.addTokens('budget1', 95);
  const attn4 = topo.computeAttention();
  const budgetItem = attn4.needsAttention.find(a => a.agentId === 'budget1');
  assert(budgetItem !== undefined, 'budget overrun agent needs attention');
  assert(budgetItem!.summary.includes('Budget'), 'budget item mentions budget');
}

// ============================================================================
// TopologyTracker — Timeline Spans
// ============================================================================

section('TopologyTracker — Timeline Spans');

{
  const topo = new TopologyTracker();
  assertEqual(topo.getTimelineSpans().length, 0, 'no spans initially');

  topo.addAgent({ id: 't1', role: 'worker', label: 'Timeline Agent' });
  const spans1 = topo.getTimelineSpans();
  assertEqual(spans1.length, 1, 'span created on agent add');
  assertEqual(spans1[0].agentId, 't1', 'span has correct agentId');
  assertEqual(spans1[0].status, 'idle', 'initial span is idle');
  assert(spans1[0].startMs > 0, 'span has startMs');
  assertEqual(spans1[0].endMs, undefined, 'initial span has no endMs');

  topo.setStatus('t1', 'running');
  const spans2 = topo.getTimelineSpans();
  assertEqual(spans2.length, 2, 'new span created on status change');
  assert(spans2[0].endMs !== undefined, 'previous span closed');
  assertEqual(spans2[1].status, 'running', 'new span tracks running');
  assertEqual(spans2[1].endMs, undefined, 'new span still open');

  topo.setStatus('t1', 'completed');
  const spans3 = topo.getTimelineSpans();
  assertEqual(spans3.length, 3, 'third span on completed');
  assert(spans3[1].endMs !== undefined, 'running span closed');
  assertEqual(spans3[2].status, 'completed', 'completed span recorded');

  // Agent removal closes spans
  topo.addAgent({ id: 't2', role: 'worker' });
  topo.setStatus('t2', 'running');
  topo.removeAgent('t2');
  const spans4 = topo.getTimelineSpans();
  const t2Spans = spans4.filter(s => s.agentId === 't2');
  assert(t2Spans.every(s => s.endMs !== undefined), 'removal closes all spans for agent');

  // Clear resets timeline
  topo.clear();
  assertEqual(topo.getTimelineSpans().length, 0, 'clear resets timeline spans');
}

// ============================================================================
// TopologyTracker — Snapshot includes new fields
// ============================================================================

section('TopologyTracker — Snapshot with narrative/phase/attention/timeline');

{
  const topo = new TopologyTracker();
  topo.addAgent({ id: 's1', role: 'orchestrator', label: 'Orch' });
  topo.addAgent({ id: 's2', role: 'worker', label: 'Worker' });
  topo.setStatus('s1', 'running');

  const snap = topo.snapshot();
  assert(typeof snap.narrative === 'string', 'snapshot has narrative string');
  assert(snap.narrative.length > 0, 'narrative is non-empty');
  assert(snap.phase !== undefined, 'snapshot has phase');
  assert(snap.phase.milestones.length > 0, 'phase has milestones');
  assert(snap.attention !== undefined, 'snapshot has attention');
  assert(snap.attention.activeNow.length > 0, 'attention shows active agents');
  assert(Array.isArray(snap.timeline), 'snapshot has timeline array');
  assert(snap.timeline.length > 0, 'timeline has spans');
}

// ============================================================================
// DashboardServer — Start and Stop on ephemeral port
// ============================================================================

section('DashboardServer — Start/Stop');

(async () => {
  const topo = new TopologyTracker();
  // Use a high ephemeral port unlikely to conflict
  const srv = new DashboardServer(topo, { port: 48201, host: '127.0.0.1' });

  let listening = false;
  srv.on('listening', () => { listening = true; });

  try {
    await srv.start();
    assert(listening, 'server emits listening event');

    // Fetch the health endpoint
    const res = await fetch('http://127.0.0.1:48201/api/health');
    assertEqual(res.status, 200, 'health endpoint returns 200');
    const body = await res.json() as { status: string; nodes: number };
    assertEqual(body.status, 'ok', 'health status is ok');
    assertEqual(body.nodes, 0, 'health shows 0 nodes');

    // Fetch the snapshot endpoint
    topo.addAgent({ id: 'http-test', role: 'worker' });
    const snapRes = await fetch('http://127.0.0.1:48201/api/snapshot');
    const snap = await snapRes.json() as TopologySnapshot;
    assertEqual(snap.nodes.length, 1, 'snapshot API returns 1 node');

    // Fetch the dashboard HTML
    const htmlRes = await fetch('http://127.0.0.1:48201/');
    assertEqual(htmlRes.status, 200, 'dashboard HTML returns 200');
    const html = await htmlRes.text();
    assert(html.includes('Network-AI'), 'HTML contains Network-AI');
    assert(html.includes('canvas'), 'HTML contains canvas element');

    // 404
    const notFound = await fetch('http://127.0.0.1:48201/nope');
    assertEqual(notFound.status, 404, '404 for unknown path');

    await srv.stop();
    assert(true, 'server stops cleanly');
  } catch (err) {
    console.error('  ✗ DashboardServer test error:', err);
    failed++;
    try { await srv.stop(); } catch { /* ignore */ }
  }

  // ============================================================================
  // TIER 1 SCALABILITY — QuadTree
  // ============================================================================

  section('QuadTree — Insert & Query');

  {
    const bounds = { x: 100, y: 100, halfW: 150, halfH: 150 };
    const qt = QuadTree.build([
      { id: 'a', x: 10, y: 10 },
      { id: 'b', x: 50, y: 50 },
      { id: 'c', x: 90, y: 90 },
      { id: 'd', x: 200, y: 200 },
    ], bounds);
    assert(qt !== null, 'QuadTree.build returns non-null');

    // Query a region that contains only the first 3 points
    const results = qt.queryRange({ x: 50, y: 50, halfW: 50, halfH: 50 });
    assertEqual(results.length, 3, 'queryRange finds 3 points in 100x100');

    // Query a small region around point d
    const results2 = qt.queryRange({ x: 200, y: 200, halfW: 10, halfH: 10 });
    assertEqual(results2.length, 1, 'queryRange finds 1 point near (200,200)');
    assertEqual(results2[0].id, 'd', 'found point is d');

    // Query empty region
    const results3 = qt.queryRange({ x: 500, y: 500, halfW: 5, halfH: 5 });
    assertEqual(results3.length, 0, 'queryRange returns empty for out-of-bounds');
  }

  section('QuadTree — Barnes-Hut Force Approximation');

  {
    // Insert 100 points in a grid pattern
    const points: QTPoint[] = [];
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 10; j++) {
        points.push({ id: `${i}-${j}`, x: i * 50, y: j * 50 });
      }
    }
    const bounds = { x: 225, y: 225, halfW: 275, halfH: 275 };
    const qt = QuadTree.build(points, bounds);

    // Force on a point should be non-zero
    let totalFx = 0, totalFy = 0;
    qt.forceOnPoint(250, 250, 0.7, (_cx, _cy, mass, dx, dy, distSq) => {
      const dist = Math.sqrt(distSq);
      const f = 4000 * mass / distSq;
      totalFx += (dx / dist) * f;
      totalFy += (dy / dist) * f;
    });
    // The point (250,250) is near center, forces should roughly cancel
    assert(Math.abs(totalFx) < 1000, 'center point has roughly balanced x-force');
    assert(Math.abs(totalFy) < 1000, 'center point has roughly balanced y-force');

    // Force on a corner point should push away from center
    let cornerFx = 0, cornerFy = 0;
    qt.forceOnPoint(0, 0, 0.7, (_cx, _cy, mass, dx, dy, distSq) => {
      const dist = Math.sqrt(distSq);
      const f = 4000 * mass / distSq;
      cornerFx += (dx / dist) * f;
      cornerFy += (dy / dist) * f;
    });
    assert(cornerFx > 0, 'corner (0,0) gets force in +x direction (toward mass)');
    assert(cornerFy > 0, 'corner (0,0) gets force in +y direction (toward mass)');
  }

  section('QuadTree — Cluster Generation');

  {
    const points: QTPoint[] = [];
    // Cluster 1: around (0,0)
    for (let i = 0; i < 20; i++) {
      points.push({ id: `c1-${i}`, x: Math.random() * 10, y: Math.random() * 10 });
    }
    // Cluster 2: around (500,500)
    for (let i = 0; i < 15; i++) {
      points.push({ id: `c2-${i}`, x: 500 + Math.random() * 10, y: 500 + Math.random() * 10 });
    }
    const bounds = { x: 255, y: 255, halfW: 265, halfH: 265 };
    const qt = QuadTree.build(points, bounds);
    const qtClusters = qt.getClusters(50);
    assert(qtClusters.length >= 2, 'getClusters finds at least 2 spatial clusters');
    const totalCount = qtClusters.reduce((s, c) => s + c.count, 0);
    assertEqual(totalCount, 35, 'cluster counts sum to total points');
  }

  // ============================================================================
  // TIER 1 SCALABILITY — Ring Buffer (Timeline Trimming)
  // ============================================================================

  section('Ring Buffer — Timeline Trimming');

  {
    const tracker = new TopologyTracker({ maxTimelineSpans: 5 });
    // Add 3 agents, each creating timeline spans
    tracker.addAgent({ id: 'buf-1', label: 'buf-1', role: 'worker' });
    tracker.addAgent({ id: 'buf-2', label: 'buf-2', role: 'worker' });
    tracker.addAgent({ id: 'buf-3', label: 'buf-3', role: 'worker' });

    // Generate many status changes (each creates a timeline span)
    for (let i = 0; i < 10; i++) {
      tracker.setStatus('buf-1', 'running');
      tracker.setStatus('buf-1', 'idle');
      tracker.setStatus('buf-2', 'running');
      tracker.setStatus('buf-2', 'idle');
    }

    const snap = tracker.snapshot();
    assert(snap.timeline.length <= 5, 'timeline trimmed to maxTimelineSpans=' + snap.timeline.length);
  }

  // ============================================================================
  // TIER 1 SCALABILITY — Cluster Computation
  // ============================================================================

  section('Topology — Cluster Computation');

  {
    const tracker = new TopologyTracker();
    tracker.addAgent({ id: 'cl-w1', label: 'Worker 1', role: 'worker', status: 'running', adapter: 'x', tokenBudget: 100 });
    tracker.addTokens('cl-w1', 10);
    tracker.addAgent({ id: 'cl-w2', label: 'Worker 2', role: 'worker', status: 'idle', adapter: 'x', tokenBudget: 100 });
    tracker.addTokens('cl-w2', 20);
    tracker.addAgent({ id: 'cl-w3', label: 'Worker 3', role: 'worker', status: 'running', adapter: 'x', tokenBudget: 100 });
    tracker.addTokens('cl-w3', 30);
    tracker.addAgent({ id: 'cl-o1', label: 'Orch 1', role: 'orchestrator', status: 'running', adapter: 'x', tokenBudget: 200 });
    tracker.addTokens('cl-o1', 50);
    tracker.addAgent({ id: 'cl-v1', label: 'Val 1', role: 'validator', status: 'idle', adapter: 'x', tokenBudget: 50 });
    tracker.addTokens('cl-v1', 5);

    const clusters = tracker.computeClusters();
    assertEqual(clusters.length, 3, 'computeClusters returns 3 role clusters');

    const workerCluster = clusters.find(c => c.role === 'worker');
    assert(workerCluster !== undefined, 'worker cluster exists');
    assertEqual(workerCluster!.count, 3, 'worker cluster has 3 agents');
    assertEqual(workerCluster!.totalTokensUsed, 60, 'worker cluster total tokens = 60');
    assertEqual(workerCluster!.totalTokenBudget, 300, 'worker cluster total budget = 300');
    assertEqual(workerCluster!.statusCounts.running, 2, 'worker cluster: 2 running');
    assertEqual(workerCluster!.statusCounts.idle, 1, 'worker cluster: 1 idle');

    const orchCluster = clusters.find(c => c.role === 'orchestrator');
    assertEqual(orchCluster!.count, 1, 'orchestrator cluster has 1 agent');
    assert(orchCluster!.sampleIds.includes('cl-o1'), 'orchestrator cluster sample includes cl-o1');
  }

  // ============================================================================
  // TIER 1 SCALABILITY — Delta Protocol
  // ============================================================================

  section('Delta Protocol — Tracking Changes');

  {
    const tracker = new TopologyTracker();
    const seq0 = tracker.currentSeq();
    assertEqual(seq0, 0, 'initial seq is 0');

    tracker.addAgent({ id: 'dx-1', label: 'Delta 1', role: 'worker' });
    tracker.addAgent({ id: 'dx-2', label: 'Delta 2', role: 'planner' });
    tracker.addEdge('dx-1', 'dx-2', 'delegation', 'delegate');

    const delta1 = tracker.delta(seq0);
    assertEqual(delta1.sinceSeq, seq0, 'delta.sinceSeq matches');
    assert(delta1.currentSeq > seq0, 'delta.currentSeq advanced');
    assertEqual(delta1.nodesChanged.length, 2, 'delta contains 2 changed nodes');
    assertEqual(delta1.edgesAdded.length, 1, 'delta contains 1 added edge');
    assertEqual(delta1.nodesRemoved.length, 0, 'delta has 0 removed nodes');

    tracker.resetDelta();
    const delta2 = tracker.delta(delta1.currentSeq);
    assertEqual(delta2.nodesChanged.length, 0, 'after reset, delta has 0 changed nodes');
    assertEqual(delta2.edgesAdded.length, 0, 'after reset, delta has 0 added edges');
  }

  section('Delta Protocol — Remove Tracking');

  {
    const tracker = new TopologyTracker();
    tracker.addAgent({ id: 'dr-1', label: 'R1', role: 'worker' });
    tracker.addAgent({ id: 'dr-2', label: 'R2', role: 'worker' });
    tracker.addEdge('dr-1', 'dr-2', 'delegation', 'e1');
    tracker.resetDelta();

    const seqBefore = tracker.currentSeq();
    tracker.removeAgent('dr-1');

    const delta = tracker.delta(seqBefore);
    assert(delta.nodesRemoved.includes('dr-1'), 'delta tracks removed node dr-1');
    assertEqual(delta.edgesRemoved.length, 1, 'delta tracks removed edge for dr-1');
  }

  section('Delta Protocol — Status & Token Changes');

  {
    const tracker = new TopologyTracker();
    tracker.addAgent({ id: 'ds-1', label: 'S1', role: 'worker', tokenBudget: 100 });
    tracker.resetDelta();

    tracker.setStatus('ds-1', 'running');
    tracker.addTokens('ds-1', 50);
    tracker.setTask('ds-1', 'processing...');

    const delta = tracker.delta(0);
    assertEqual(delta.nodesChanged.length, 1, 'status/token/task changes tracked as node change');
    const changedNode = delta.nodesChanged[0];
    assertEqual(changedNode.status, 'running', 'changed node has running status');
    assertEqual(changedNode.tokensUsed, 50, 'changed node has 50 tokens');
    assertEqual(changedNode.currentTask, 'processing...', 'changed node has task');
  }

  // ============================================================================
  // WORK TREE — BASIC OPERATIONS
  // ============================================================================

  section('WorkTree — construction');
  {
    const tree = new WorkTree('root', 'Build feature');
    assertEqual(tree.size(), 1, 'new tree has 1 node (root)');
    assertEqual(tree.getRootId(), 'root', 'getRootId returns root');
    const root = tree.getRoot();
    assertEqual(root.id, 'root', 'root node id matches');
    assertEqual(root.label, 'Build feature', 'root label matches');
    assertEqual(root.status, 'pending', 'root starts as pending');
    assertEqual(root.depth, 0, 'root depth is 0');
    assertEqual(root.children.length, 0, 'root has no children');
    assertEqual(root.progress, 0, 'root progress starts at 0');
  }

  section('WorkTree — addChild');
  {
    const tree = new WorkTree('root', 'Project');
    const child1 = tree.addChild('root', { id: 'c1', label: 'Task A' });
    assertEqual(child1.id, 'c1', 'addChild returns correct id');
    assertEqual(child1.parentId, 'root', 'addChild sets parentId');
    assertEqual(child1.depth, 1, 'child depth is 1');
    assertEqual(tree.size(), 2, 'tree has 2 nodes');

    const child2 = tree.addChild('root', { id: 'c2', label: 'Task B', agent: 'worker-1' });
    assertEqual(child2.agent, 'worker-1', 'addChild sets agent');
    assertEqual(tree.getRoot().children.length, 2, 'root has 2 children');

    const grandchild = tree.addChild('c1', { id: 'g1', label: 'Subtask A.1' });
    assertEqual(grandchild.depth, 2, 'grandchild depth is 2');
    assertEqual(tree.size(), 4, 'tree has 4 nodes');

    // Errors
    let caught = false;
    try { tree.addChild('nonexistent', { id: 'x', label: 'x' }); } catch { caught = true; }
    assert(caught, 'addChild throws for unknown parent');

    caught = false;
    try { tree.addChild('root', { id: 'c1', label: 'dup' }); } catch { caught = true; }
    assert(caught, 'addChild throws for duplicate id');
  }

  section('WorkTree — removeSubtree');
  {
    const tree = new WorkTree('root', 'Project');
    tree.addChild('root', { id: 'a', label: 'A' });
    tree.addChild('a', { id: 'a1', label: 'A.1' });
    tree.addChild('a', { id: 'a2', label: 'A.2' });
    tree.addChild('root', { id: 'b', label: 'B' });

    assertEqual(tree.size(), 5, 'tree starts with 5 nodes');
    const removed = tree.removeSubtree('a');
    assertEqual(removed, 3, 'removeSubtree removes 3 nodes (a, a1, a2)');
    assertEqual(tree.size(), 2, 'tree has 2 nodes after removal');
    assertEqual(tree.getRoot().children.length, 1, 'root has 1 child after removal');
    assertEqual(tree.getNode('a'), undefined, 'removed node is gone');

    let caught = false;
    try { tree.removeSubtree('root'); } catch { caught = true; }
    assert(caught, 'removeSubtree throws for root');
  }

  // ============================================================================
  // WORK TREE — STATUS & ROLLUP
  // ============================================================================

  section('WorkTree — setStatus');
  {
    const tree = new WorkTree('root', 'Goal');
    tree.addChild('root', { id: 't1', label: 'Task 1' });
    tree.addChild('root', { id: 't2', label: 'Task 2' });

    tree.setStatus('t1', 'running');
    assertEqual(tree.getNode('t1')!.status, 'running', 'setStatus updates to running');

    // Duplicate status is no-op
    const events: string[] = [];
    tree.on('node:status', (id: string) => events.push(id));
    tree.setStatus('t1', 'running');
    assertEqual(events.length, 0, 'setStatus skips duplicate');

    tree.setStatus('t1', 'completed');
    assertEqual(events.length, 1, 'setStatus emits on change');
  }

  section('WorkTree — progress rollup');
  {
    const tree = new WorkTree('root', 'Goal');
    tree.addChild('root', { id: 'a', label: 'A' });
    tree.addChild('root', { id: 'b', label: 'B' });
    tree.addChild('root', { id: 'c', label: 'C' });

    tree.setStatus('a', 'completed');
    const rootAfter1 = tree.getRoot();
    assert(Math.abs(rootAfter1.progress - 1/3) < 0.01, 'root progress is ~0.33 after 1/3 complete');

    tree.setStatus('b', 'completed');
    assert(Math.abs(tree.getRoot().progress - 2/3) < 0.01, 'root progress is ~0.67 after 2/3 complete');

    tree.setStatus('c', 'completed');
    assertEqual(tree.getRoot().progress, 1, 'root progress is 1 when all done');
  }

  section('WorkTree — autoCompleteParent');
  {
    const tree = new WorkTree('root', 'Goal');
    tree.addChild('root', { id: 'x', label: 'X' });
    tree.addChild('root', { id: 'y', label: 'Y' });

    tree.setStatus('x', 'completed');
    assertEqual(tree.getRoot().status, 'pending', 'root stays pending when not all done');

    tree.setStatus('y', 'completed');
    assertEqual(tree.getRoot().status, 'completed', 'root auto-completes when all children done');
  }

  section('WorkTree — autoCompleteParent with skipped');
  {
    const tree = new WorkTree('root', 'Goal');
    tree.addChild('root', { id: 'x', label: 'X' });
    tree.addChild('root', { id: 'y', label: 'Y' });

    tree.setStatus('x', 'completed');
    tree.setStatus('y', 'skipped');
    assertEqual(tree.getRoot().status, 'completed', 'root auto-completes with completed+skipped children');
  }

  section('WorkTree — autoFailParent');
  {
    const tree = new WorkTree('root', 'Goal', { autoFailParent: true });
    tree.addChild('root', { id: 'x', label: 'X' });
    tree.addChild('root', { id: 'y', label: 'Y' });

    tree.setStatus('x', 'failed');
    assertEqual(tree.getRoot().status, 'failed', 'root auto-fails when child fails (opt-in)');
  }

  section('WorkTree — autoBlockChildren');
  {
    const tree = new WorkTree('root', 'Goal');
    tree.addChild('root', { id: 'p', label: 'Parent' });
    tree.addChild('p', { id: 'c1', label: 'Child 1' });
    tree.addChild('p', { id: 'c2', label: 'Child 2' });

    tree.setStatus('p', 'failed');
    assertEqual(tree.getNode('c1')!.status, 'blocked', 'child blocked when parent fails');
    assertEqual(tree.getNode('c2')!.status, 'blocked', 'child blocked when parent fails');
  }

  section('WorkTree — deep rollup');
  {
    const tree = new WorkTree('root', 'Goal');
    tree.addChild('root', { id: 'a', label: 'A' });
    tree.addChild('a', { id: 'a1', label: 'A1' });
    tree.addChild('a', { id: 'a2', label: 'A2' });

    tree.setStatus('a1', 'completed');
    assertEqual(tree.getNode('a')!.progress, 0.5, 'mid-level progress is 0.5');
    assert(tree.getRoot().progress < 1, 'root progress is less than 1');

    tree.setStatus('a2', 'completed');
    assertEqual(tree.getNode('a')!.status, 'completed', 'mid-level auto-completes');
    assertEqual(tree.getRoot().status, 'completed', 'root auto-completes via deep rollup');
  }

  // ============================================================================
  // WORK TREE — TOKENS
  // ============================================================================

  section('WorkTree — token rollup');
  {
    const tree = new WorkTree('root', 'Goal');
    tree.addChild('root', { id: 'a', label: 'A' });
    tree.addChild('root', { id: 'b', label: 'B' });
    tree.addChild('a', { id: 'a1', label: 'A1' });

    tree.addTokens('a1', 100);
    assertEqual(tree.getNode('a1')!.ownTokens, 100, 'a1 ownTokens is 100');
    assertEqual(tree.getNode('a1')!.totalTokens, 100, 'a1 totalTokens is 100 (leaf)');
    assertEqual(tree.getNode('a')!.totalTokens, 100, 'parent totalTokens rolls up');
    assertEqual(tree.getRoot().totalTokens, 100, 'root totalTokens rolls up');

    tree.addTokens('b', 50);
    assertEqual(tree.getRoot().totalTokens, 150, 'root totalTokens is 150');

    tree.addTokens('a', 25);
    assertEqual(tree.getNode('a')!.ownTokens, 25, 'a ownTokens is 25');
    assertEqual(tree.getNode('a')!.totalTokens, 125, 'a totalTokens = 25 own + 100 child');
    assertEqual(tree.getRoot().totalTokens, 175, 'root totalTokens is 175');
  }

  // ============================================================================
  // WORK TREE — QUERIES
  // ============================================================================

  section('WorkTree — getChildren, getAncestors, getDescendants');
  {
    const tree = new WorkTree('root', 'Goal');
    tree.addChild('root', { id: 'a', label: 'A' });
    tree.addChild('root', { id: 'b', label: 'B' });
    tree.addChild('a', { id: 'a1', label: 'A1' });
    tree.addChild('a', { id: 'a2', label: 'A2' });

    const children = tree.getChildren('root');
    assertEqual(children.length, 2, 'root has 2 children');
    assertEqual(children[0].id, 'a', 'first child is a');

    const ancestors = tree.getAncestors('a1');
    assertEqual(ancestors.length, 2, 'a1 has 2 ancestors');
    assertEqual(ancestors[0].id, 'a', 'first ancestor is a');
    assertEqual(ancestors[1].id, 'root', 'second ancestor is root');

    const descendants = tree.getDescendants('root');
    assertEqual(descendants.length, 4, 'root has 4 descendants');

    const leaves = tree.getLeaves();
    assertEqual(leaves.length, 3, 'tree has 3 leaves (a1, a2, b)');
  }

  section('WorkTree — stats');
  {
    const tree = new WorkTree('root', 'Goal');
    tree.addChild('root', { id: 'a', label: 'A' });
    tree.addChild('root', { id: 'b', label: 'B' });
    tree.addChild('a', { id: 'a1', label: 'A1' });

    tree.setStatus('a1', 'completed');
    tree.setStatus('b', 'running');
    tree.addTokens('a1', 200);

    const s = tree.stats();
    assertEqual(s.total, 4, 'stats total is 4');
    assertEqual(s.completed, 2, 'stats completed is 2 (a1 + auto-completed a)');
    assertEqual(s.running, 1, 'stats running is 1');
    assertEqual(s.pending, 1, 'stats pending is 1 (root only)');
    assertEqual(s.totalTokens, 200, 'stats totalTokens is 200');
    assertEqual(s.maxDepth, 2, 'stats maxDepth is 2');
  }

  section('WorkTree — flatten');
  {
    const tree = new WorkTree('root', 'Goal');
    tree.addChild('root', { id: 'a', label: 'A' });
    tree.addChild('a', { id: 'a1', label: 'A1' });
    tree.addChild('root', { id: 'b', label: 'B' });

    const flat = tree.flatten();
    assertEqual(flat.length, 4, 'flatten returns all 4 nodes');
    assertEqual(flat[0].id, 'root', 'flatten[0] is root');
    assertEqual(flat[1].id, 'a', 'flatten[1] is a (DFS order)');
    assertEqual(flat[2].id, 'a1', 'flatten[2] is a1 (DFS order)');
    assertEqual(flat[3].id, 'b', 'flatten[3] is b');
  }

  section('WorkTree — snapshot');
  {
    const tree = new WorkTree('root', 'Goal');
    tree.addChild('root', { id: 't1', label: 'T1' });
    tree.setStatus('t1', 'completed');

    const snap = tree.snapshot();
    assertEqual(snap.rootId, 'root', 'snapshot rootId');
    assert('root' in snap.nodes, 'snapshot has root node');
    assert('t1' in snap.nodes, 'snapshot has t1 node');
    assertEqual(snap.stats.total, 2, 'snapshot stats total is 2');
    assert(!!snap.timestamp, 'snapshot has timestamp');
  }

  // ============================================================================
  // WORK TREE — fromTaskList
  // ============================================================================

  section('WorkTree — fromTaskList');
  {
    const tasks = [
      { id: 'plan', description: 'Plan architecture', agent: 'planner', dependencies: [] as string[] },
      { id: 'impl-auth', description: 'Implement auth', agent: 'worker-1', dependencies: ['plan'] },
      { id: 'impl-db', description: 'Implement DB', agent: 'worker-2', dependencies: ['plan'] },
      { id: 'test', description: 'Run tests', agent: 'tester', dependencies: ['impl-auth', 'impl-db'] },
    ];

    const tree = WorkTree.fromTaskList(tasks, 'Build App');
    assert(tree.size() >= 4, 'fromTaskList creates at least 4 nodes');

    // plan should be the root since it has no deps and is the only top-level task
    const root = tree.getRoot();
    assertEqual(root.id, 'plan', 'single top-level task becomes root');

    // impl-auth and impl-db should be children of plan
    const planChildren = tree.getChildren('plan');
    assert(planChildren.some(c => c.id === 'impl-auth'), 'impl-auth is child of plan');
    assert(planChildren.some(c => c.id === 'impl-db'), 'impl-db is child of plan');

    // test depends on impl-auth and impl-db
    const testNode = tree.getNode('test');
    assert(testNode !== undefined, 'test node exists');
  }

  section('WorkTree — fromTaskList with multiple roots');
  {
    const tasks = [
      { id: 'a', description: 'Independent A', dependencies: [] as string[] },
      { id: 'b', description: 'Independent B', dependencies: [] as string[] },
      { id: 'c', description: 'Depends on A', dependencies: ['a'] },
    ];

    const tree = WorkTree.fromTaskList(tasks, 'Multi-root');
    assertEqual(tree.getRootId(), '__root__', 'virtual root created for multiple top-level tasks');
    const rootChildren = tree.getChildren('__root__');
    assert(rootChildren.some(c => c.id === 'a'), 'a is under virtual root');
    assert(rootChildren.some(c => c.id === 'b'), 'b is under virtual root');
  }

  // ============================================================================
  // WORK TREE — EVENTS
  // ============================================================================

  section('WorkTree — events');
  {
    const tree = new WorkTree('root', 'Goal');
    const addedIds: string[] = [];
    const statusChanges: Array<{ id: string; status: string; prev: string }> = [];
    const progressChanges: Array<{ id: string; progress: number }> = [];
    let treeCompleted = false;

    tree.on('node:added', (node: WorkNode) => addedIds.push(node.id));
    tree.on('node:status', (id: string, status: string, prev: string) => statusChanges.push({ id, status, prev }));
    tree.on('node:progress', (id: string, progress: number) => progressChanges.push({ id, progress }));
    tree.on('tree:complete', () => { treeCompleted = true; });

    tree.addChild('root', { id: 'x', label: 'X' });
    assert(addedIds.includes('x'), 'node:added fires for addChild');

    tree.setStatus('x', 'running');
    assert(statusChanges.some(e => e.id === 'x' && e.status === 'running'), 'node:status fires for running');

    tree.setStatus('x', 'completed');
    assert(statusChanges.some(e => e.id === 'root' && e.status === 'completed'), 'node:status fires for auto-completed root');
    assert(progressChanges.some(e => e.id === 'root' && e.progress === 1), 'node:progress fires');
    assert(treeCompleted, 'tree:complete fires when all done');
  }

  // ============================================================================
  // WORK TREE UI — RENDERER
  // ============================================================================

  section('WorkTreeUI — basic render');
  {
    const tree = new WorkTree('root', 'My Project');
    tree.addChild('root', { id: 'a', label: 'Task A', agent: 'worker-1' });
    tree.addChild('root', { id: 'b', label: 'Task B' });
    tree.setStatus('a', 'completed');
    tree.addTokens('a', 100);

    const ui = new WorkTreeUI(tree, { useColor: false });
    const result = ui.toString();

    assert(result.includes('My Project'), 'render includes title');
    assert(result.includes('Task A'), 'render includes child label');
    assert(result.includes('Task B'), 'render includes second child');
    assert(result.includes('100'), 'render includes token count');
    assert(result.includes('@worker-1'), 'render includes agent');
    assert(result.includes('done'), 'render includes stats done count');
    assert(result.includes('Progress:'), 'render includes progress bar');
  }

  section('WorkTreeUI — tree connectors');
  {
    const tree = new WorkTree('root', 'Goal');
    tree.addChild('root', { id: 'a', label: 'First' });
    tree.addChild('root', { id: 'b', label: 'Last' });

    const ui = new WorkTreeUI(tree, { useColor: false });
    const text = ui.toString();

    assert(text.includes('├─'), 'render has tee connector for non-last child');
    assert(text.includes('└─'), 'render has corner connector for last child');
  }

  section('WorkTreeUI — deep connectors');
  {
    const tree = new WorkTree('root', 'Goal');
    tree.addChild('root', { id: 'a', label: 'A' });
    tree.addChild('a', { id: 'a1', label: 'A1' });
    tree.addChild('root', { id: 'b', label: 'B' });

    const ui = new WorkTreeUI(tree, { useColor: false });
    const text = ui.toString();

    // A is not last child, so its children should have a pipe continuation
    assert(text.includes('│'), 'render has pipe connector for ancestor continuation');
  }

  section('WorkTreeUI — progress bar');
  {
    const tree = new WorkTree('root', 'Goal');
    tree.addChild('root', { id: 'a', label: 'A' });
    tree.addChild('root', { id: 'b', label: 'B' });
    tree.setStatus('a', 'completed');

    const ui = new WorkTreeUI(tree, { useColor: false });
    const text = ui.toString();

    assert(text.includes('50%'), 'render shows 50% for half-complete parent');
    assert(text.includes('█'), 'render has filled bar characters');
    assert(text.includes('░'), 'render has empty bar characters');
  }

  section('WorkTreeUI — status icons');
  {
    const tree = new WorkTree('root', 'Goal');
    tree.addChild('root', { id: 'a', label: 'Pending' });
    tree.addChild('root', { id: 'b', label: 'Running' });
    tree.addChild('root', { id: 'c', label: 'Done' });
    tree.addChild('root', { id: 'd', label: 'Failed' });
    tree.setStatus('b', 'running');
    tree.setStatus('c', 'completed');
    tree.setStatus('d', 'failed');

    const ui = new WorkTreeUI(tree, { useColor: false });
    const text = ui.toString();

    assert(text.includes('○'), 'render shows pending icon');
    assert(text.includes('◑'), 'render shows running icon');
    assert(text.includes('✔'), 'render shows completed icon');
    assert(text.includes('✘'), 'render shows failed icon');
  }

  section('WorkTreeUI — hide options');
  {
    const tree = new WorkTree('root', 'Goal');
    tree.addChild('root', { id: 'a', label: 'Task', agent: 'w1' });
    tree.addTokens('a', 500);

    const ui = new WorkTreeUI(tree, {
      useColor: false,
      showTokens: false,
      showAgents: false,
      showStats: false,
      showProgress: false,
    });
    const text = ui.toString();

    assert(!text.includes('500'), 'tokens hidden when showTokens=false');
    assert(!text.includes('@w1'), 'agent hidden when showAgents=false');
    assert(!text.includes('Progress:'), 'stats hidden when showStats=false');
  }

  section('WorkTreeUI — maxDepth');
  {
    const tree = new WorkTree('root', 'Goal');
    tree.addChild('root', { id: 'a', label: 'Level 1' });
    tree.addChild('a', { id: 'b', label: 'Level 2' });
    tree.addChild('b', { id: 'c', label: 'Level 3 Hidden' });

    const ui = new WorkTreeUI(tree, { useColor: false, maxDepth: 2 });
    const text = ui.toString();

    assert(text.includes('Level 1'), 'depth 1 visible');
    assert(text.includes('Level 2'), 'depth 2 visible');
    assert(!text.includes('Level 3 Hidden'), 'depth 3 hidden when maxDepth=2');
  }

  section('WorkTreeUI — title override');
  {
    const tree = new WorkTree('root', 'Original');
    const ui = new WorkTreeUI(tree, { useColor: false, title: 'Custom Title' });
    const text = ui.toString();

    assert(text.includes('Custom Title'), 'title override works');
    assert(text.includes('Custom Title'), 'custom title shown in header');
  }

  section('WorkTreeUI — RenderResult');
  {
    const tree = new WorkTree('root', 'Goal');
    tree.addChild('root', { id: 'x', label: 'X' });
    tree.setStatus('x', 'completed');

    const chunks: string[] = [];
    const mockOutput = { write: (s: string) => { chunks.push(s); return true; } } as unknown as NodeJS.WritableStream;
    const ui = new WorkTreeUI(tree, { output: mockOutput });
    const result = ui.render();

    assert(result.lineCount > 0, 'RenderResult has lineCount');
    assert(result.text.length > 0, 'RenderResult has text');
    assertEqual(result.stats.total, 2, 'RenderResult stats total is 2');
    assert(chunks.length > 0, 'render writes to output stream');
  }

  section('WorkTreeUI — live mode');
  {
    const tree = new WorkTree('root', 'Goal');
    const chunks: string[] = [];
    const mockOutput = { write: (s: string) => { chunks.push(s); return true; } } as unknown as NodeJS.WritableStream;
    const ui = new WorkTreeUI(tree, { output: mockOutput, live: true });

    // Initial render happened in constructor
    const initialCount = chunks.length;
    assert(initialCount > 0, 'live mode renders initially');

    // Adding a child should trigger re-render
    tree.addChild('root', { id: 'a', label: 'A' });
    assert(chunks.length > initialCount, 'live mode re-renders on node:added');

    const afterAdd = chunks.length;
    tree.setStatus('a', 'completed');
    assert(chunks.length > afterAdd, 'live mode re-renders on node:status');

    ui.stopLive();
    const afterStop = chunks.length;
    tree.addChild('root', { id: 'b', label: 'B' });
    assertEqual(chunks.length, afterStop, 'stopLive stops re-rendering');

    ui.destroy();
  }

  section('WorkTreeUI — token formatting');
  {
    const tree = new WorkTree('root', 'Goal');
    tree.addChild('root', { id: 'a', label: 'Big Task' });
    tree.addTokens('a', 2500);

    const ui = new WorkTreeUI(tree, { useColor: false });
    const text = ui.toString();
    assert(text.includes('2.5k'), 'tokens >= 1000 formatted as k');
  }

  section('WorkTreeUI — render event');
  {
    const tree = new WorkTree('root', 'Goal');
    const mockOutput = { write: () => true } as unknown as NodeJS.WritableStream;
    const ui = new WorkTreeUI(tree, { output: mockOutput });

    let emitted = false;
    ui.on('render', () => { emitted = true; });
    ui.render();
    assert(emitted, 'render emits render event');
    ui.destroy();
  }

  // ============================================================================
  // WORK TREE DASHBOARD — SERVER
  // ============================================================================

  section('WorkTreeDashboard — start and stop');
  {
    const tree = new WorkTree('root', 'Dashboard Test');
    tree.addChild('root', { id: 'a', label: 'Task A', agent: 'w1' });
    tree.setStatus('a', 'completed');

    const dashboard = new WorkTreeDashboard(tree, { port: 0 });

    // Listen on port 0 to get a random available port
    // We test the class instantiation and API surface
    assertEqual(dashboard.clientCount(), 0, 'no clients before start');
    assert(typeof dashboard.url === 'string', 'url getter returns string');
    assert(dashboard.url.startsWith('http://'), 'url starts with http://');
  }

  section('WorkTreeDashboard — start/stop lifecycle');
  {
    const tree = new WorkTree('root', 'LC Test');
    const dashboard = new WorkTreeDashboard(tree, { port: 14821 });

    let listening = false;
    dashboard.on('listening', () => { listening = true; });

    await dashboard.start();
    assert(listening, 'dashboard emits listening event');
    assertEqual(dashboard.url, 'http://127.0.0.1:14821', 'url matches config');

    // HTTP health endpoint
    const health = await new Promise<string>((resolve, reject) => {
      http.get('http://127.0.0.1:14821/api/health', (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });

    const healthObj = JSON.parse(health);
    assertEqual(healthObj.status, 'ok', 'health returns ok');
    assertEqual(healthObj.nodes, 1, 'health reports node count');

    // HTTP serves HTML
    const htmlStatus = await new Promise<number>((resolve, reject) => {
      http.get('http://127.0.0.1:14821/', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on('error', reject);
    });
    assertEqual(htmlStatus, 200, 'serves HTML on /');

    // HTTP snapshot endpoint
    const snapResp = await new Promise<string>((resolve, reject) => {
      http.get('http://127.0.0.1:14821/api/snapshot', (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
    const snap = JSON.parse(snapResp);
    assertEqual(snap.rootId, 'root', 'snapshot returns rootId');
    assert('root' in snap.nodes, 'snapshot has root node');

    // 404 for unknown routes
    const notFoundStatus = await new Promise<number>((resolve, reject) => {
      http.get('http://127.0.0.1:14821/unknown', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on('error', reject);
    });
    assertEqual(notFoundStatus, 404, '404 for unknown routes');

    await dashboard.stop();
  }

  // ============================================================================
  // SUMMARY
  // ============================================================================

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  Topology Tests: ${passed} passed, ${failed} failed`);
  console.log(`${'═'.repeat(50)}`);

  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exit(1);
  }
})();
