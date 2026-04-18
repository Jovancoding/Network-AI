import { WorkTree } from './lib/work-tree';
import { WorkTreeDashboard } from './lib/work-tree-dashboard';

async function main() {
  const tree = new WorkTree('root', 'Build Feature X — Code Review Swarm');

  const dashboard = new WorkTreeDashboard(tree, { port: 4821 });
  dashboard.setOrchestrator('lead');
  await dashboard.start();
  console.log(`\n  Dashboard: ${dashboard.url}\n`);
  console.log('  Open the Agents tab to see agent orchestration view.\n');

  // Build tree structure
  tree.addChild('root', { id: 'design', label: 'Design API', agent: 'architect' });
  tree.addChild('root', { id: 'impl', label: 'Implement', agent: 'lead' });
  tree.addChild('root', { id: 'test', label: 'Test Suite', agent: 'qa' });

  tree.addChild('design', { id: 'd1', label: 'Schema design', agent: 'architect' });
  tree.addChild('design', { id: 'd2', label: 'Review endpoints', agent: 'architect' });

  tree.addChild('impl', { id: 'i1', label: 'Auth module', agent: 'worker-1' });
  tree.addChild('impl', { id: 'i2', label: 'DB schema', agent: 'worker-2' });
  tree.addChild('impl', { id: 'i3', label: 'REST handlers', agent: 'worker-3' });

  tree.addChild('i1', { id: 'i1a', label: 'JWT tokens', agent: 'worker-1' });
  tree.addChild('i1', { id: 'i1b', label: 'OAuth flow', agent: 'worker-1' });

  tree.addChild('test', { id: 't1', label: 'Unit tests', agent: 'qa' });
  tree.addChild('test', { id: 't2', label: 'Integration tests', agent: 'qa' });

  // Simulate agent work with timed updates (now with pushLog calls)
  const steps: Array<[number, () => void]> = [
    [500,   () => { dashboard.pushNarrative('Orchestration started. Dispatching design phase to architect.'); }],
    [1000,  () => {
      tree.setStatus('d1', 'running');
      dashboard.pushLog('architect', 'Starting schema design for Feature X');
      dashboard.pushLog('lead', 'Assigned design tasks to architect agent', 'info');
    }],
    [2000,  () => {
      tree.setStatus('d1', 'completed'); tree.addTokens('d1', 120);
      dashboard.pushLog('architect', 'Schema design complete — 3 tables, 12 fields');
      dashboard.pushNarrative('Schema design finished. Moving to endpoint review.');
    }],
    [2500,  () => {
      tree.setStatus('d2', 'running');
      dashboard.pushLog('architect', 'Reviewing REST endpoint definitions');
    }],
    [4000,  () => {
      tree.setStatus('d2', 'completed'); tree.addTokens('d2', 80);
      dashboard.pushLog('architect', 'Endpoint review done — 5 endpoints approved');
      dashboard.pushNarrative('Design phase complete. Starting parallel implementation.');
    }],
    [5000,  () => {
      tree.setStatus('i1a', 'running'); tree.setStatus('i2', 'running');
      dashboard.pushLog('worker-1', 'Implementing JWT token signing/verification');
      dashboard.pushLog('worker-2', 'Creating database schema migrations');
      dashboard.pushLog('lead', 'Dispatched auth + DB work to workers in parallel');
      dashboard.pushNarrative('Implementation phase: 2 workers running in parallel.');
    }],
    [6500,  () => {
      tree.addTokens('i1a', 200);
      dashboard.pushLog('worker-1', 'Generated RSA-256 key pair for JWT');
      dashboard.pushLog('worker-2', 'Migration 001: users table created');
    }],
    [8000,  () => {
      tree.setStatus('i1a', 'completed'); tree.addTokens('i1a', 150);
      dashboard.pushLog('worker-1', 'JWT module done — sign, verify, refresh implemented');
    }],
    [8500,  () => {
      tree.setStatus('i1b', 'running');
      dashboard.pushLog('worker-1', 'Starting OAuth2 flow implementation');
      dashboard.pushLog('lead', 'Worker-1 moving to OAuth after JWT completion');
    }],
    [9500,  () => {
      tree.setStatus('i2', 'completed'); tree.addTokens('i2', 180);
      dashboard.pushLog('worker-2', 'All DB migrations complete — 3 tables ready');
      dashboard.pushNarrative('DB schema done. Worker-2 now idle.');
    }],
    [10000, () => {
      tree.setStatus('i3', 'running');
      dashboard.pushLog('worker-3', 'Building REST handler boilerplate');
      dashboard.pushLog('lead', 'Assigned REST handlers to worker-3');
    }],
    [11000, () => {
      tree.addTokens('i1b', 300);
      dashboard.pushLog('worker-1', 'OAuth callback + token exchange working');
      dashboard.pushLog('worker-3', 'GET /api/users endpoint implemented');
    }],
    [12000, () => {
      tree.setStatus('i3', 'failed'); tree.addTokens('i3', 90);
      dashboard.pushLog('worker-3', 'FAILED: POST /api/auth — validation error in schema', 'error');
      dashboard.pushNarrative('⚠ Worker-3 failed on REST handlers. Needs investigation.');
    }],
    [13000, () => {
      tree.setStatus('i1b', 'completed'); tree.addTokens('i1b', 100);
      dashboard.pushLog('worker-1', 'OAuth flow complete with PKCE support');
      dashboard.pushNarrative('Auth module fully complete. Moving to test phase.');
    }],
    [14000, () => {
      tree.setStatus('t1', 'running');
      dashboard.pushLog('qa', 'Running unit test suite (47 test cases)');
      dashboard.pushLog('lead', 'Test phase started — QA agent running unit tests');
    }],
    [16000, () => {
      tree.setStatus('t1', 'completed'); tree.addTokens('t1', 250);
      dashboard.pushLog('qa', 'Unit tests: 47/47 passed ✔');
    }],
    [17000, () => {
      tree.setStatus('t2', 'running');
      dashboard.pushLog('qa', 'Starting integration test suite');
      dashboard.pushNarrative('Integration testing in progress. Almost done.');
    }],
    [19000, () => {
      tree.setStatus('t2', 'completed'); tree.addTokens('t2', 300);
      dashboard.pushLog('qa', 'Integration tests: 12/12 passed ✔');
      dashboard.pushNarrative('All tests passed. Orchestration nearly complete (1 failure in REST handlers).');
    }],
    [20000, () => {
      dashboard.pushNarrative('Orchestration finished. Summary: 10/11 tasks succeeded, 1 failed.');
      console.log('\n  Simulation complete. Press Ctrl+C to exit.\n');
    }],
  ];

  for (const [delay, fn] of steps) {
    setTimeout(fn, delay);
  }
}

main().catch(console.error);
