/**
 * Demo: ControlPlane — Multi-workspace dashboard
 *
 * Creates two workspaces, each with a WorkTree and LockedBlackboard,
 * then simulates concurrent agent work across both.
 *
 * Usage:
 *   npx ts-node demo-control-plane.ts
 *   Open http://127.0.0.1:4800
 */

import { WorkTree } from './lib/work-tree';
import { LockedBlackboard } from './lib/locked-blackboard';
import { ControlPlane } from './lib/control-plane';
import { join } from 'path';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  // ── Workspace 1: Feature-Auth ──────────────────────────────────
  const tree1 = new WorkTree('root-auth', 'Auth System');
  tree1.addChild('root-auth', { id: 'oauth', label: 'OAuth Provider' });
  tree1.addChild('root-auth', { id: 'jwt', label: 'JWT Validation' });
  tree1.addChild('root-auth', { id: 'session', label: 'Session Store' });
  tree1.addChild('root-auth', { id: 'rate-limit', label: 'Rate Limiter' });

  const bb1Dir = join(__dirname, 'data', 'demo-cp-auth');
  const bb1 = new LockedBlackboard(bb1Dir);

  // ── Workspace 2: Feature-Search ────────────────────────────────
  const tree2 = new WorkTree('root-search', 'Search Pipeline');
  tree2.addChild('root-search', { id: 'indexer', label: 'Index Builder' });
  tree2.addChild('root-search', { id: 'query-parser', label: 'Query Parser' });
  tree2.addChild('root-search', { id: 'ranker', label: 'Ranking Engine' });
  tree2.addChild('query-parser', { id: 'tokenizer', label: 'Tokenizer' });
  tree2.addChild('query-parser', { id: 'synonyms', label: 'Synonym Resolver' });

  const bb2Dir = join(__dirname, 'data', 'demo-cp-search');
  const bb2 = new LockedBlackboard(bb2Dir);

  // ── ControlPlane ───────────────────────────────────────────────
  const cp = new ControlPlane({ port: 4800 });
  cp.addWorkspace('feature-auth', { tree: tree1, blackboard: bb1 });
  cp.addWorkspace('feature-search', { tree: tree2, blackboard: bb2 });

  cp.setOrchestrator('feature-auth', 'lead');
  cp.setOrchestrator('feature-search', 'architect');

  await cp.start();
  console.log(`\n  ControlPlane running → ${cp.url}\n  2 workspaces registered\n  Press Ctrl+C to stop.\n`);

  // ── Simulate Auth workspace ────────────────────────────────────
  async function runAuth() {
    cp.pushNarrative('feature-auth', 'Starting Auth System build');
    cp.pushLog('feature-auth', 'lead', 'Orchestrating auth pipeline');

    // OAuth
    tree1.setStatus('oauth', 'running');
    cp.pushLog('feature-auth', 'oauth-bot', 'Connecting to OAuth discovery endpoint');
    await delay(1200);
    const id1 = bb1.propose('auth:provider', { type: 'oauth2', issuer: 'https://auth.example.com' }, 'oauth-bot');
    bb1.validate(id1, 'lead');
    bb1.commit(id1);
    cp.pushLog('feature-auth', 'oauth-bot', 'Provider config written to blackboard');
    tree1.addTokens('oauth', 2400);
    tree1.setStatus('oauth', 'completed');

    // JWT
    tree1.setStatus('jwt', 'running');
    cp.pushLog('feature-auth', 'jwt-agent', 'Generating RS256 key pair');
    await delay(1500);
    const id2 = bb1.propose('auth:jwt_secret', 'RS256:auto-generated', 'jwt-agent');
    bb1.validate(id2, 'lead');
    bb1.commit(id2);
    cp.pushLog('feature-auth', 'jwt-agent', 'JWT validation service ready');
    tree1.addTokens('jwt', 1800);
    tree1.setStatus('jwt', 'completed');

    // Session Store
    tree1.setStatus('session', 'running');
    cp.pushLog('feature-auth', 'session-agent', 'Setting up Redis session store');
    await delay(1000);
    const id3 = bb1.propose('auth:session_ttl', 3600, 'session-agent');
    bb1.validate(id3, 'lead');
    bb1.commit(id3);
    cp.pushLog('feature-auth', 'session-agent', 'Session TTL: 3600s');
    tree1.addTokens('session', 900);
    tree1.setStatus('session', 'completed');

    // Rate Limiter
    tree1.setStatus('rate-limit', 'running');
    cp.pushLog('feature-auth', 'rate-agent', 'Configuring sliding window limiter');
    await delay(800);
    const id4 = bb1.propose('auth:rate_limit', { windowMs: 60000, max: 100 }, 'rate-agent');
    bb1.validate(id4, 'lead');
    bb1.commit(id4);
    cp.pushLog('feature-auth', 'rate-agent', 'Rate limit: 100 req/min');
    tree1.addTokens('rate-limit', 600);
    tree1.setStatus('rate-limit', 'completed');

    cp.pushNarrative('feature-auth', 'Auth system complete — all 4 components done');
    cp.pushLog('feature-auth', 'lead', 'All auth tasks finished');
  }

  // ── Simulate Search workspace ──────────────────────────────────
  async function runSearch() {
    await delay(500); // slight offset
    cp.pushNarrative('feature-search', 'Initializing search pipeline');
    cp.pushLog('feature-search', 'architect', 'Coordinating search build');

    // Tokenizer
    tree2.setStatus('tokenizer', 'running');
    cp.pushLog('feature-search', 'nlp-bot', 'Training BPE tokenizer');
    await delay(1800);
    const sid1 = bb2.propose('search:tokenizer', { type: 'bpe', vocabSize: 32000 }, 'nlp-bot');
    bb2.validate(sid1, 'architect');
    bb2.commit(sid1);
    cp.pushLog('feature-search', 'nlp-bot', 'Tokenizer ready — 32k vocab');
    tree2.addTokens('tokenizer', 3200);
    tree2.setStatus('tokenizer', 'completed');

    // Synonym Resolver
    tree2.setStatus('synonyms', 'running');
    cp.pushLog('feature-search', 'nlp-bot', 'Loading synonym graph');
    await delay(1200);
    const sid2 = bb2.propose('search:synonyms', { count: 45000, source: 'wordnet' }, 'nlp-bot');
    bb2.validate(sid2, 'architect');
    bb2.commit(sid2);
    tree2.addTokens('synonyms', 1800);
    tree2.setStatus('synonyms', 'completed');

    // Query Parser (parent — auto-completes when children done)
    cp.pushLog('feature-search', 'architect', 'Query parser subtasks complete');

    // Index Builder
    tree2.setStatus('indexer', 'running');
    cp.pushLog('feature-search', 'indexer', 'Building inverted index');
    await delay(2000);
    const sid3 = bb2.propose('search:index_status', { shards: 8, docsIndexed: 1_200_000 }, 'indexer');
    bb2.validate(sid3, 'architect');
    bb2.commit(sid3);
    cp.pushLog('feature-search', 'indexer', 'Indexed 1.2M documents across 8 shards');
    tree2.addTokens('indexer', 5400);
    tree2.setStatus('indexer', 'completed');

    // Ranking Engine
    tree2.setStatus('ranker', 'running');
    cp.pushLog('feature-search', 'ranker', 'Training BM25 + neural reranker');
    await delay(1400);
    const sid4 = bb2.propose('search:ranking_model', { algo: 'bm25+neural', ndcg: 0.87 }, 'ranker');
    bb2.validate(sid4, 'architect');
    bb2.commit(sid4);
    cp.pushLog('feature-search', 'ranker', 'NDCG@10 = 0.87');
    tree2.addTokens('ranker', 4100);
    tree2.setStatus('ranker', 'completed');

    cp.pushNarrative('feature-search', 'Search pipeline complete');
    cp.pushLog('feature-search', 'architect', 'All search tasks finished');
  }

  // Run both workspaces concurrently
  await Promise.all([runAuth(), runSearch()]);

  console.log('  Simulation complete. Dashboard remains live. Press Ctrl+C to exit.\n');

  // Keep alive
  await new Promise(() => {});
}

main().catch(console.error);
