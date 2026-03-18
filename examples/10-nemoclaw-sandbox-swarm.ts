/**
 * 10-nemoclaw-sandbox-swarm.ts
 * ────────────────────────────
 * Demonstrates three agents running in isolated NemoClaw sandboxes,
 * coordinating through a shared blackboard. Each agent has its own
 * deny-by-default network policy — only the endpoints it needs are
 * accessible.
 *
 * No API key needed — uses mock sandbox executor for demo purposes.
 * In production, replace the mock executor with a real OpenShell CLI.
 *
 * Run:
 *   npx ts-node examples/10-nemoclaw-sandbox-swarm.ts
 */

import {
  createSwarmOrchestrator,
  SharedBlackboard,
} from '..';
import { NemoClawAdapter } from '../adapters/nemoclaw-adapter';
import type { OpenShellExecutor, NetworkPolicy } from '../adapters/nemoclaw-adapter';

// ─── ANSI helpers ─────────────────────────────────────────────────────────────
const c = {
  reset  : '\x1b[0m',
  bold   : '\x1b[1m',
  cyan   : '\x1b[36m',
  green  : '\x1b[32m',
  yellow : '\x1b[33m',
  blue   : '\x1b[34m',
  magenta: '\x1b[35m',
  red    : '\x1b[31m',
  dim    : '\x1b[2m',
};

const banner = (msg: string) => console.log(`\n${c.bold}${c.cyan}---  ${msg}  ---${c.reset}`);
const step   = (agent: string, msg: string) => console.log(`  ${c.green}[${agent}]${c.reset} ${msg}`);
const policy = (msg: string) => console.log(`  ${c.yellow}[policy]${c.reset} ${msg}`);
const info   = (msg: string) => console.log(`  ${c.dim}${msg}${c.reset}`);
const sleep  = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Mock sandbox executor ───────────────────────────────────────────────────
// In production, this would shell out to `openshell` CLI.
// For the demo, it simulates sandbox creation and agent execution.

function createMockExecutor(): OpenShellExecutor {
  const sandboxes = new Map<string, { state: string; image: string }>();

  return async (subcommand: string, args: string[], options?) => {
    await sleep(100); // Simulate I/O latency

    if (subcommand === 'sandbox' && args[0] === 'create') {
      const nameIdx = args.indexOf('--name');
      const name = nameIdx >= 0 ? args[nameIdx + 1] : 'unnamed';
      const fromIdx = args.indexOf('--from');
      const image = fromIdx >= 0 ? args[fromIdx + 1] : 'unknown';
      sandboxes.set(name, { state: 'running', image });
      step('openshell', `Sandbox "${name}" created from ${image}`);
      return `sandbox "${name}" created`;
    }

    if (subcommand === 'sandbox' && args[0] === 'get') {
      const name = args[1];
      const sb = sandboxes.get(name);
      if (sb) return JSON.stringify({ state: sb.state, uptime: 60, image: sb.image });
      throw new Error(`sandbox "${name}" not found`);
    }

    if (subcommand === 'sandbox' && args[0] === 'connect') {
      const name = args[1];
      const cmd = args.slice(3).join(' '); // Skip --
      const env = options?.env ?? {};

      // Simulate agent execution based on environment context
      const handoff = env['NETWORK_AI_HANDOFF'] ? JSON.parse(env['NETWORK_AI_HANDOFF']) : null;
      const context = env['NETWORK_AI_CONTEXT'] ? JSON.parse(env['NETWORK_AI_CONTEXT']) : {};

      step(name, `Executing: ${cmd || 'default task'}`);

      if (handoff?.instruction) {
        info(`  Handoff: "${handoff.instruction}"`);
      }

      // Generate mock responses based on sandbox name
      if (name.includes('researcher')) {
        return JSON.stringify({
          findings: [
            'NemoClaw uses deny-by-default network policies',
            'OpenShell provides Landlock filesystem isolation',
            'Blueprints automate sandbox provisioning',
          ],
          sourceCount: 5,
          confidence: 0.92,
        });
      }

      if (name.includes('analyst')) {
        const findings = context['research:findings']
          ? JSON.parse(JSON.stringify(context['research:findings']))
          : ['No prior research available'];
        return JSON.stringify({
          riskScore: 15,
          recommendation: 'Low risk — sandbox isolation is strong',
          analyzed: Array.isArray(findings) ? findings.length : 1,
          summary: 'NemoClaw sandboxing provides defense-in-depth for multi-agent systems',
        });
      }

      if (name.includes('reporter')) {
        return JSON.stringify({
          report: '# Security Analysis Report\n\n' +
            '## Findings\n' +
            'NemoClaw sandbox isolation provides strong security boundaries.\n\n' +
            '## Risk Assessment\n' +
            'Overall risk: LOW (15/100)\n\n' +
            '## Recommendation\n' +
            'Proceed with sandbox deployment for multi-agent coordination.',
          format: 'markdown',
          wordCount: 42,
        });
      }

      return JSON.stringify({ output: 'task completed' });
    }

    if (subcommand === 'policy') {
      const yaml = options?.env?.['__POLICY_YAML'] ?? '';
      const policyCount = (yaml.match(/endpoints:/g) ?? []).length;
      policy(`Applied ${policyCount} policy group(s)`);
      return 'policies applied';
    }

    if (subcommand === 'sandbox' && args[0] === 'delete') {
      const name = args[1];
      sandboxes.delete(name);
      step('openshell', `Sandbox "${name}" destroyed`);
      return 'deleted';
    }

    return '';
  };
}

// ─── Define network policies per agent ───────────────────────────────────────

const researcherPolicies: NetworkPolicy[] = [
  {
    name: 'web_research',
    endpoints: [
      { host: 'api.arxiv.org', port: 443, protocol: 'rest' },
      { host: 'api.semanticscholar.org', port: 443, protocol: 'rest' },
    ],
  },
  NemoClawAdapter.mcpServerPolicy(), // Connect to Network-AI MCP server
];

const analystPolicies: NetworkPolicy[] = [
  NemoClawAdapter.nvidiaPolicy(),     // Access NVIDIA NIM for analysis
  NemoClawAdapter.mcpServerPolicy(),  // Connect to Network-AI MCP server
];

const reporterPolicies: NetworkPolicy[] = [
  NemoClawAdapter.mcpServerPolicy(),  // Only needs MCP server access
];

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  banner('NemoClaw Sandbox Swarm — Isolated Multi-Agent Coordination');
  console.log();
  info('Three agents in separate sandboxes, each with its own network policy.');
  info('Coordination happens through the shared blackboard (no direct comms).');
  console.log();

  // 1. Shared blackboard
  const blackboard = new SharedBlackboard(process.cwd());
  blackboard.registerAgent('researcher', 'tok-researcher', ['task:', 'research:']);
  blackboard.registerAgent('analyst',    'tok-analyst',    ['task:', 'research:', 'analysis:']);
  blackboard.registerAgent('reporter',   'tok-reporter',   ['task:', 'analysis:', 'report:']);

  // 2. NemoClaw adapter with mock executor
  const adapter = new NemoClawAdapter();
  await adapter.initialize({ options: { executor: createMockExecutor() } });

  // 3. Register each agent in its own isolated sandbox
  banner('Step 1: Register Sandboxed Agents');

  adapter.registerSandboxAgent('researcher', {
    sandboxName: 'researcher-sandbox',
    sandboxImage: 'ghcr.io/nvidia/openshell-community/sandboxes/python:latest',
    policies: researcherPolicies,
    command: 'python3 /app/research.py',
    env: { MAX_SOURCES: '10' },
  });
  info('Researcher: web_research + mcp_server policies');

  adapter.registerSandboxAgent('analyst', {
    sandboxName: 'analyst-sandbox',
    sandboxImage: 'ghcr.io/nvidia/openshell-community/sandboxes/python:latest',
    policies: analystPolicies,
    command: 'python3 /app/analyze.py',
    env: { NVIDIA_API_KEY: 'demo-key-not-real' },
  });
  info('Analyst: nvidia + mcp_server policies');

  adapter.registerSandboxAgent('reporter', {
    sandboxName: 'reporter-sandbox',
    sandboxImage: 'ghcr.io/nvidia/openshell-community/sandboxes/python:latest',
    policies: reporterPolicies,
    command: 'python3 /app/report.py',
  });
  info('Reporter: mcp_server policy only (most restricted)');

  // 4. Execute the pipeline
  banner('Step 2: Research Phase');

  const researchResult = await adapter.executeAgent(
    'researcher',
    {
      action: 'research',
      params: { topic: 'NemoClaw sandbox security model' },
      handoff: {
        handoffId: 'h-001',
        sourceAgent: 'orchestrator',
        targetAgent: 'researcher',
        taskType: 'delegate',
        instruction: 'Research NemoClaw sandboxing capabilities and network isolation',
      },
    },
    { agentId: 'orchestrator', taskId: 'task-001' }
  );

  if (researchResult.success) {
    const findings = researchResult.data as Record<string, unknown>;
    step('Result', `Found ${(findings['findings'] as string[])?.length ?? 0} key findings (confidence: ${findings['confidence']})`);

    // Write findings to blackboard for analyst
    blackboard.write('research:findings', JSON.stringify(findings['findings']), 'researcher', 3600, 'tok-researcher');
    blackboard.write('research:confidence', String(findings['confidence']), 'researcher', 3600, 'tok-researcher');
    info('Findings written to blackboard under "research:" namespace');
  }

  banner('Step 3: Analysis Phase');

  const analysisResult = await adapter.executeAgent(
    'analyst',
    {
      action: 'analyze',
      params: { focus: 'security risk assessment' },
      blackboardSnapshot: {
        'research:findings': blackboard.read('research:findings')?.value,
        'research:confidence': blackboard.read('research:confidence')?.value,
      },
      handoff: {
        handoffId: 'h-002',
        sourceAgent: 'orchestrator',
        targetAgent: 'analyst',
        taskType: 'delegate',
        instruction: 'Analyze research findings for security risks',
      },
    },
    { agentId: 'orchestrator', taskId: 'task-002' }
  );

  if (analysisResult.success) {
    const analysis = analysisResult.data as Record<string, unknown>;
    step('Result', `Risk score: ${analysis['riskScore']}/100 — "${analysis['recommendation']}"`);

    blackboard.write('analysis:risk', String(analysis['riskScore']), 'analyst', 3600, 'tok-analyst');
    blackboard.write('analysis:summary', String(analysis['summary']), 'analyst', 3600, 'tok-analyst');
    info('Analysis written to blackboard under "analysis:" namespace');
  }

  banner('Step 4: Report Phase');

  const reportResult = await adapter.executeAgent(
    'reporter',
    {
      action: 'report',
      params: { format: 'markdown' },
      blackboardSnapshot: {
        'analysis:risk': blackboard.read('analysis:risk')?.value,
        'analysis:summary': blackboard.read('analysis:summary')?.value,
      },
      handoff: {
        handoffId: 'h-003',
        sourceAgent: 'orchestrator',
        targetAgent: 'reporter',
        taskType: 'delegate',
        instruction: 'Generate a security analysis report from the findings',
      },
    },
    { agentId: 'orchestrator', taskId: 'task-003' }
  );

  if (reportResult.success) {
    const report = reportResult.data as Record<string, unknown>;
    step('Result', `Report generated (${report['wordCount']} words, ${report['format']} format)`);
  }

  // 5. Show sandbox isolation summary
  banner('Sandbox Isolation Summary');

  console.log(`
  ${c.bold}Agent${c.reset}         ${c.bold}Sandbox${c.reset}              ${c.bold}Network Access${c.reset}
  ──────────  ──────────────────  ────────────────────────────────────
  Researcher  researcher-sandbox  arxiv, semanticscholar, MCP server
  Analyst     analyst-sandbox     NVIDIA NIM, MCP server
  Reporter    reporter-sandbox    MCP server only (most restricted)

  ${c.yellow}Key:${c.reset} Each sandbox has ${c.red}deny-by-default${c.reset} networking.
       Only explicitly allowlisted endpoints are reachable.
       Agents coordinate ${c.green}only${c.reset} through the shared blackboard.
`);

  // 6. Cleanup
  banner('Step 5: Cleanup');
  await adapter.destroySandbox('researcher-sandbox');
  await adapter.destroySandbox('analyst-sandbox');
  await adapter.destroySandbox('reporter-sandbox');
  await adapter.shutdown();

  banner('Done — All sandboxes destroyed');
}

main().catch((err) => {
  console.error(`${c.red}Error:${c.reset}`, err);
  process.exit(1);
});
