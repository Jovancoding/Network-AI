#!/usr/bin/env node
/**
 * Network-AI Developer Setup Script
 * 
 * One-command setup for developers integrating with the SwarmOrchestrator.
 * 
 * Usage:
 *   npx ts-node setup.ts              # Interactive setup
 *   npx ts-node setup.ts --all        # Install everything
 *   npx ts-node setup.ts --adapter X  # Install specific adapter config
 *   npx ts-node setup.ts --check      # Verify installation
 *   npx ts-node setup.ts --example    # Generate example file
 * 
 * @module Setup
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';

const COLORS = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
};

// ============================================================================
// ADAPTER REGISTRY -- All supported frameworks
// ============================================================================

interface AdapterInfo {
  name: string;
  importName: string;
  description: string;
  npmPackages: string[];
  exampleCode: string;
}

const ADAPTERS: Record<string, AdapterInfo> = {
  custom: {
    name: 'Custom',
    importName: 'CustomAdapter',
    description: 'Any agent via plain functions or HTTP endpoints',
    npmPackages: [],
    exampleCode: `
import { CustomAdapter, AdapterRegistry } from './adapters';

const adapter = new CustomAdapter();

// Register a simple function-based agent
adapter.registerHandler('my-agent', async (payload) => {
  const instruction = payload.handoff?.instruction || 'No instruction';
  return { result: \`Processed: \${instruction}\` };
});

// Register an HTTP-based agent  
adapter.registerHttpAgent('remote-agent', {
  url: 'https://my-api.example.com/agent',
  method: 'POST',
  headers: { 'Authorization': 'Bearer YOUR_KEY' },
});

const registry = new AdapterRegistry();
await registry.addAdapter(adapter);
// Use: delegateTask({ targetAgent: 'custom:my-agent', ... })`,
  },

  langchain: {
    name: 'LangChain',
    importName: 'LangChainAdapter',
    description: 'LangChain/LangGraph agents, chains, and runnables',
    npmPackages: ['langchain', '@langchain/core', '@langchain/openai'],
    exampleCode: `
import { LangChainAdapter, AdapterRegistry } from './adapters';

const adapter = new LangChainAdapter();

// Register a LangChain runnable (chain, agent, etc.)
adapter.registerAgent('summarizer', myChain, {
  description: 'Summarises text using GPT-4',
});

const registry = new AdapterRegistry();
await registry.addAdapter(adapter);
// Use: delegateTask({ targetAgent: 'langchain:summarizer', ... })`,
  },

  autogen: {
    name: 'AutoGen',
    importName: 'AutoGenAdapter',
    description: 'Microsoft AutoGen/AG2 conversable agents',
    npmPackages: ['autogen-agentchat'],
    exampleCode: `
import { AutoGenAdapter, AdapterRegistry } from './adapters';

const adapter = new AutoGenAdapter();

// Register an AutoGen agent
adapter.registerAgent('coder', myAutoGenAgent, {
  description: 'Code generation agent',
});

const registry = new AdapterRegistry();
await registry.addAdapter(adapter);
// Use: delegateTask({ targetAgent: 'autogen:coder', ... })`,
  },

  crewai: {
    name: 'CrewAI',
    importName: 'CrewAIAdapter',
    description: 'CrewAI agents and crews for role-playing orchestration',
    npmPackages: [],
    exampleCode: `
import { CrewAIAdapter, AdapterRegistry } from './adapters';

const adapter = new CrewAIAdapter();

// Register individual agents or entire crews
adapter.registerAgent('researcher', myAgent);
adapter.registerCrew('dev-team', myCrew);

const registry = new AdapterRegistry();
await registry.addAdapter(adapter);
// Use: delegateTask({ targetAgent: 'crewai:researcher', ... })`,
  },

  mcp: {
    name: 'MCP',
    importName: 'MCPAdapter',
    description: 'Model Context Protocol tools and servers',
    npmPackages: ['@modelcontextprotocol/sdk'],
    exampleCode: `
import { MCPAdapter, AdapterRegistry } from './adapters';

const adapter = new MCPAdapter();

// Register local tools
adapter.registerTool('calculator', {
  name: 'calculator',
  description: 'Basic math operations',
  inputSchema: { type: 'object', properties: { expression: { type: 'string' } } },
}, async (args) => \`Result: \${String(args.expression)}\`);

const registry = new AdapterRegistry();
await registry.addAdapter(adapter);
// Use: delegateTask({ targetAgent: 'mcp:calculator', ... })`,
  },

  llamaindex: {
    name: 'LlamaIndex',
    importName: 'LlamaIndexAdapter',
    description: 'LlamaIndex query engines, chat engines, and agent runners',
    npmPackages: ['llamaindex'],
    exampleCode: `
import { LlamaIndexAdapter, AdapterRegistry } from './adapters';

const adapter = new LlamaIndexAdapter();

// Register different engine types
adapter.registerQueryEngine('search', myQueryEngine);
adapter.registerChatEngine('assistant', myChatEngine);
adapter.registerAgentRunner('researcher', myAgentRunner);

const registry = new AdapterRegistry();
await registry.addAdapter(adapter);
// Use: delegateTask({ targetAgent: 'llamaindex:search', ... })`,
  },

  'semantic-kernel': {
    name: 'Semantic Kernel',
    importName: 'SemanticKernelAdapter',
    description: 'Microsoft Semantic Kernel with planners and plugins',
    npmPackages: ['semantic-kernel'],
    exampleCode: `
import { SemanticKernelAdapter, AdapterRegistry } from './adapters';

const adapter = new SemanticKernelAdapter();

// Register a kernel or individual SK functions
adapter.registerKernel('planner', myKernel);
adapter.registerFunction('summarize', mySKFunction);

const registry = new AdapterRegistry();
await registry.addAdapter(adapter);
// Use: delegateTask({ targetAgent: 'semantic-kernel:planner', ... })`,
  },

  'openai-assistants': {
    name: 'OpenAI Assistants',
    importName: 'OpenAIAssistantsAdapter',
    description: 'OpenAI Assistants API with threads & function calling',
    npmPackages: ['openai'],
    exampleCode: `
import { OpenAIAssistantsAdapter, AdapterRegistry } from './adapters';
import OpenAI from 'openai';

const adapter = new OpenAIAssistantsAdapter();
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Wrap the OpenAI client to match our interface
adapter.registerAssistant('analyst', {
  assistantId: 'asst_abc123',
}, {
  chat: async (id, msg) => {
    // Use OpenAI SDK to create thread, run, and get response
    const thread = await client.beta.threads.create();
    await client.beta.threads.messages.create(thread.id, { role: 'user', content: msg });
    const run = await client.beta.threads.runs.createAndPoll(thread.id, { assistant_id: id });
    const messages = await client.beta.threads.messages.list(thread.id);
    return { response: messages.data[0]?.content[0]?.text?.value || '' };
  },
});

const registry = new AdapterRegistry();
await registry.addAdapter(adapter);
// Use: delegateTask({ targetAgent: 'openai-assistants:analyst', ... })`,
  },

  haystack: {
    name: 'Haystack',
    importName: 'HaystackAdapter',
    description: 'deepset Haystack pipelines and agents',
    npmPackages: [],
    exampleCode: `
import { HaystackAdapter, AdapterRegistry } from './adapters';

const adapter = new HaystackAdapter();

// Register pipelines, agents, or individual components
adapter.registerPipeline('rag', myPipeline);
adapter.registerAgent('qa', myHaystackAgent);
adapter.registerComponent('retriever', myRetriever);

const registry = new AdapterRegistry();
await registry.addAdapter(adapter);
// Use: delegateTask({ targetAgent: 'haystack:rag', ... })`,
  },

  dspy: {
    name: 'DSPy',
    importName: 'DSPyAdapter',
    description: 'Stanford DSPy modules, programs, and predictors',
    npmPackages: [],
    exampleCode: `
import { DSPyAdapter, AdapterRegistry } from './adapters';

const adapter = new DSPyAdapter();

// Register DSPy modules, compiled programs, or simple predictors
adapter.registerModule('classifier', myDSPyModule);
adapter.registerProgram('rag', myCompiledProgram);
adapter.registerPredictor('simple', async (inputs) => ({
  answer: \`Predicted: \${inputs.question}\`,
}));

const registry = new AdapterRegistry();
await registry.addAdapter(adapter);
// Use: delegateTask({ targetAgent: 'dspy:classifier', ... })`,
  },

  agno: {
    name: 'Agno',
    importName: 'AgnoAdapter',
    description: 'Agno (formerly Phidata) agents and teams',
    npmPackages: [],
    exampleCode: `
import { AgnoAdapter, AdapterRegistry } from './adapters';

const adapter = new AgnoAdapter();

// Register agents, teams, or simple functions
adapter.registerAgent('researcher', myAgnoAgent);
adapter.registerTeam('dev-team', myAgnoTeam);
adapter.registerFunction('helper', async (msg) => \`Processed: \${msg}\`);

const registry = new AdapterRegistry();
await registry.addAdapter(adapter);
// Use: delegateTask({ targetAgent: 'agno:researcher', ... })`,
  },
};

// ============================================================================
// SETUP FUNCTIONS
// ============================================================================

function printBanner(): void {
  console.log(`
${COLORS.cyan}${COLORS.bold}+==========================================================+
|            Network-AI  --  Developer Setup                |
|          Multi-Agent Swarm Orchestrator v3.0              |
+==========================================================+${COLORS.reset}
`);
}

function printAdapterList(): void {
  console.log(`${COLORS.bold}Supported Frameworks (12 adapters):${COLORS.reset}\n`);
  const entries = Object.entries(ADAPTERS);
  for (let i = 0; i < entries.length; i++) {
    const [key, info] = entries[i];
    const deps = info.npmPackages.length > 0
      ? `${COLORS.dim}(npm: ${info.npmPackages.join(', ')})${COLORS.reset}`
      : `${COLORS.green}(no dependencies)${COLORS.reset}`;
    console.log(`  ${COLORS.cyan}${(i + 1).toString().padStart(2)}.${COLORS.reset} ${COLORS.bold}${info.name.padEnd(20)}${COLORS.reset} ${info.description} ${deps}`);
  }
  console.log();
}

function checkInstallation(): void {
  console.log(`${COLORS.bold}Installation Check:${COLORS.reset}\n`);

  // Check Node.js
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1));
  const nodeOk = nodeMajor >= 18;
  console.log(`  ${nodeOk ? COLORS.green + '[v]' : COLORS.red + '[x]'} Node.js ${nodeVersion} ${nodeOk ? '' : '(need >=18)'}${COLORS.reset}`);

  // Check TypeScript
  try {
    const tsconfigPath = path.join(process.cwd(), 'tsconfig.json');
    if (fs.existsSync(tsconfigPath)) {
      console.log(`  ${COLORS.green}[v]${COLORS.reset} tsconfig.json found`);
    } else {
      console.log(`  ${COLORS.yellow}[!]${COLORS.reset} tsconfig.json not found`);
    }
  } catch {
    console.log(`  ${COLORS.yellow}[!]${COLORS.reset} Could not check tsconfig.json`);
  }

  // Check key files
  const requiredFiles = [
    'index.ts',
    'adapters/index.ts',
    'adapters/base-adapter.ts',
    'types/agent-adapter.d.ts',
  ];

  for (const file of requiredFiles) {
    const filePath = path.join(process.cwd(), file);
    const exists = fs.existsSync(filePath);
    console.log(`  ${exists ? COLORS.green + '[v]' : COLORS.red + '[x]'} ${file}${COLORS.reset}`);
  }

  // Check adapters
  console.log(`\n${COLORS.bold}  Adapter Files:${COLORS.reset}`);
  const adapterFiles = [
    'openclaw-adapter.ts', 'langchain-adapter.ts', 'autogen-adapter.ts',
    'crewai-adapter.ts', 'mcp-adapter.ts', 'custom-adapter.ts',
    'llamaindex-adapter.ts', 'semantic-kernel-adapter.ts',
    'openai-assistants-adapter.ts', 'haystack-adapter.ts',
    'dspy-adapter.ts', 'agno-adapter.ts',
  ];

  let adapterCount = 0;
  for (const file of adapterFiles) {
    const filePath = path.join(process.cwd(), 'adapters', file);
    const exists = fs.existsSync(filePath);
    if (exists) adapterCount++;
    console.log(`  ${exists ? COLORS.green + '[v]' : COLORS.red + '[x]'} adapters/${file}${COLORS.reset}`);
  }

  console.log(`\n  ${COLORS.bold}${adapterCount}/${adapterFiles.length} adapters available${COLORS.reset}\n`);
}

function generateExample(adapterKey?: string): void {
  const adaptersToShow = adapterKey
    ? { [adapterKey]: ADAPTERS[adapterKey] }
    : ADAPTERS;

  if (adapterKey && !ADAPTERS[adapterKey]) {
    console.log(`${COLORS.red}Unknown adapter: ${adapterKey}${COLORS.reset}`);
    console.log(`Available: ${Object.keys(ADAPTERS).join(', ')}`);
    return;
  }

  const exampleCode = `/**
 * Network-AI Quick Start Example
 * 
 * This file demonstrates how to set up the SwarmOrchestrator
 * with various agent framework adapters.
 * 
 * Generated by: npx ts-node setup.ts --example
 */

import { createSwarmOrchestrator } from './index';
import { AdapterRegistry } from './adapters';
${Object.values(adaptersToShow).map((a) => `import { ${a.importName} } from './adapters';`).join('\n')}

async function main() {
  // 1. Create the orchestrator
  const orchestrator = createSwarmOrchestrator({
    agentId: 'my-app',
    swarmName: 'My Multi-Agent System',
  });

  // 2. Create the adapter registry
  const registry = new AdapterRegistry();
  await registry.initialize({});

  // 3. Set up your adapters
${Object.entries(adaptersToShow).map(([key, info]) => {
    const lines = info.exampleCode.trim().split('\n');
    // Skip import lines from individual examples
    const bodyLines = lines.filter((l) => !l.startsWith('import '));
    return `  // --- ${info.name} ---\n  // ${info.description}\n${bodyLines.map((l) => `  ${l}`).join('\n')}`;
  }).join('\n\n')}

  // 4. Use the orchestrator
  console.log('SwarmOrchestrator ready with', registry.getAdapters().length, 'adapters');
  console.log('Available agents:', (await registry.listAllAgents()).map(a => a.id));
}

main().catch(console.error);
`;

  const outPath = path.join(process.cwd(), 'example.ts');
  fs.writeFileSync(outPath, exampleCode);
  console.log(`${COLORS.green}[v]${COLORS.reset} Generated ${COLORS.bold}example.ts${COLORS.reset}`);
  console.log(`  Run with: ${COLORS.cyan}npx ts-node example.ts${COLORS.reset}\n`);
}

// ============================================================================
// MAIN
// ============================================================================

function main(): void {
  printBanner();

  const args = process.argv.slice(2);

  if (args.includes('--check')) {
    checkInstallation();
    return;
  }

  if (args.includes('--example')) {
    const adapterIdx = args.indexOf('--adapter');
    const adapterKey = adapterIdx >= 0 ? args[adapterIdx + 1] : undefined;
    generateExample(adapterKey);
    return;
  }

  if (args.includes('--list')) {
    printAdapterList();
    return;
  }

  // Default: show everything
  printAdapterList();

  console.log(`${COLORS.bold}Quick Start:${COLORS.reset}`);
  console.log(`  ${COLORS.cyan}npx ts-node setup.ts --check${COLORS.reset}     Verify installation`);
  console.log(`  ${COLORS.cyan}npx ts-node setup.ts --example${COLORS.reset}   Generate example file`);
  console.log(`  ${COLORS.cyan}npx ts-node setup.ts --list${COLORS.reset}      List all adapters`);
  console.log();
  console.log(`${COLORS.bold}Run tests:${COLORS.reset}`);
  console.log(`  ${COLORS.cyan}npx ts-node test-adapters.ts${COLORS.reset}     All adapter tests`);
  console.log(`  ${COLORS.cyan}npx ts-node test-standalone.ts${COLORS.reset}   Core orchestrator tests`);
  console.log(`  ${COLORS.cyan}npx ts-node test-security.ts${COLORS.reset}     Security tests`);
  console.log();
  console.log(`${COLORS.bold}Documentation:${COLORS.reset}`);
  console.log(`  ${COLORS.cyan}QUICKSTART.md${COLORS.reset}    Get started in 5 minutes`);
  console.log(`  ${COLORS.cyan}README.md${COLORS.reset}        Full documentation`);
  console.log(`  ${COLORS.cyan}SKILL.md${COLORS.reset}         Skill manifest for AI agents`);
  console.log();
}

main();
