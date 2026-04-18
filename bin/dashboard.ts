#!/usr/bin/env node
/**
 * Dashboard CLI entry point
 *
 * Launches the live agent topology dashboard on localhost.
 * Usage: npx network-ai-dashboard [--port 4820]
 *
 * @module DashboardCLI
 */

import { TopologyTracker } from '../lib/topology';
import { DashboardServer } from '../lib/dashboard-server';

const args = process.argv.slice(2);
let port = 4820;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    const p = parseInt(args[i + 1], 10);
    if (!isNaN(p) && p > 0 && p < 65536) {
      port = p;
    }
    i++;
  }
}

const tracker = new TopologyTracker();
const dashboard = new DashboardServer(tracker, { port });

async function main(): Promise<void> {
  await dashboard.start();

  console.log(`
  ╔══════════════════════════════════════════════════════╗
  ║  Network-AI Live Agent Topology Dashboard            ║
  ║                                                      ║
  ║  Dashboard: http://127.0.0.1:${String(port).padEnd(5)}                  ║
  ║  WebSocket: ws://127.0.0.1:${String(port).padEnd(5)}                   ║
  ║                                                      ║
  ║  Press Ctrl+C to stop                                ║
  ╚══════════════════════════════════════════════════════╝
  `);

  // Demo: spawn some agents to show the dashboard working
  // In real usage, the orchestrator feeds real events
  if (args.includes('--demo')) {
    runDemo(tracker);
  }
}

/**
 * Runs a demo simulation with fake agents for demonstration purposes.
 */
function runDemo(topo: TopologyTracker): void {
  console.log('  Running demo simulation...\n');

  topo.addAgent({ id: 'orchestrator', label: 'Orchestrator', role: 'orchestrator' });
  topo.addAgent({ id: 'planner', label: 'Planner', role: 'planner', adapter: 'custom' });
  topo.addAgent({ id: 'lc:researcher', label: 'Researcher', role: 'worker', adapter: 'langchain', tokenBudget: 5000 });
  topo.addAgent({ id: 'lc:writer', label: 'Writer', role: 'worker', adapter: 'langchain', tokenBudget: 8000 });
  topo.addAgent({ id: 'crew:reviewer', label: 'Reviewer', role: 'validator', adapter: 'crewai', tokenBudget: 3000 });
  topo.addAgent({ id: 'aggregator', label: 'Aggregator', role: 'aggregator', adapter: 'custom' });

  topo.setStatus('orchestrator', 'running');

  let step = 0;
  const interval = setInterval(() => {
    step++;

    switch (step) {
      case 1:
        topo.setStatus('planner', 'running');
        topo.setTask('planner', 'Decomposing goal into tasks');
        topo.addEdge('orchestrator', 'planner', 'delegation', 'plan');
        break;
      case 3:
        topo.setStatus('planner', 'completed');
        topo.addEdge('planner', 'orchestrator', 'result', 'task DAG');
        topo.setStatus('lc:researcher', 'running');
        topo.setStatus('lc:writer', 'running');
        topo.setTask('lc:researcher', 'Analyzing codebase');
        topo.setTask('lc:writer', 'Drafting documentation');
        topo.addEdge('orchestrator', 'lc:researcher', 'delegation', 'research');
        topo.addEdge('orchestrator', 'lc:writer', 'delegation', 'write');
        break;
      case 5:
        topo.addTokens('lc:researcher', 1200);
        topo.addTokens('lc:writer', 800);
        topo.addEdge('lc:researcher', '_blackboard', 'blackboard_write', 'analysis:result');
        break;
      case 7:
        topo.addTokens('lc:researcher', 2100);
        topo.addTokens('lc:writer', 2500);
        topo.addEdge('lc:writer', '_blackboard', 'blackboard_write', 'draft:v1');
        topo.setStatus('lc:researcher', 'completed');
        topo.setTask('lc:researcher', undefined);
        break;
      case 9:
        topo.addTokens('lc:writer', 4200);
        topo.setStatus('lc:writer', 'completed');
        topo.setTask('lc:writer', undefined);
        topo.setStatus('crew:reviewer', 'running');
        topo.setTask('crew:reviewer', 'Reviewing draft');
        topo.addEdge('crew:reviewer', '_blackboard', 'blackboard_read', 'draft:v1');
        topo.addEdge('orchestrator', 'crew:reviewer', 'delegation', 'review');
        break;
      case 11:
        topo.addTokens('crew:reviewer', 1500);
        topo.setStatus('crew:reviewer', 'completed');
        topo.addEdge('crew:reviewer', '_blackboard', 'blackboard_write', 'review:feedback');
        topo.setStatus('aggregator', 'running');
        topo.setTask('aggregator', 'Merging results');
        topo.addEdge('aggregator', '_blackboard', 'blackboard_read', 'analysis:result');
        topo.addEdge('orchestrator', 'aggregator', 'delegation', 'aggregate');
        break;
      case 13:
        topo.setStatus('aggregator', 'completed');
        topo.addEdge('aggregator', 'orchestrator', 'result', 'final output');
        topo.setStatus('orchestrator', 'completed');
        topo.setTask('orchestrator', 'Done');
        break;
      case 16:
        // Reset for loop
        step = 0;
        topo.clear();
        topo.addAgent({ id: 'orchestrator', label: 'Orchestrator', role: 'orchestrator' });
        topo.addAgent({ id: 'planner', label: 'Planner', role: 'planner', adapter: 'custom' });
        topo.addAgent({ id: 'lc:researcher', label: 'Researcher', role: 'worker', adapter: 'langchain', tokenBudget: 5000 });
        topo.addAgent({ id: 'lc:writer', label: 'Writer', role: 'worker', adapter: 'langchain', tokenBudget: 8000 });
        topo.addAgent({ id: 'crew:reviewer', label: 'Reviewer', role: 'validator', adapter: 'crewai', tokenBudget: 3000 });
        topo.addAgent({ id: 'aggregator', label: 'Aggregator', role: 'aggregator', adapter: 'custom' });
        topo.setStatus('orchestrator', 'running');
        break;
    }
  }, 1500);

  process.on('SIGINT', () => {
    clearInterval(interval);
    dashboard.stop().then(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error('Failed to start dashboard:', err);
  process.exit(1);
});
