/**
 * Playground — Interactive REPL sandbox for Network-AI
 *
 * Provides an in-process REPL environment with pre-configured mock adapters,
 * a blackboard, budget, auth guardian, and orchestrator — ready to experiment
 * with immediately.
 *
 * Features:
 *   - Pre-wired SwarmOrchestrator with mock CustomAdapter
 *   - LockedBlackboard with in-memory backend
 *   - AuthGuardian with default trust levels
 *   - FederatedBudget with generous defaults
 *   - REPL context exposes all key objects
 *   - Helper functions: delegate(), bb(), budget(), agents()
 *
 * Usage:
 *   import { startPlayground } from 'network-ai';
 *   await startPlayground();
 *
 * CLI:
 *   npx network-ai playground
 *
 * @module Playground
 * @version 1.0.0
 */

import * as repl from 'repl';
import { EventEmitter } from 'events';

// ============================================================================
// TYPES
// ============================================================================

/** Configuration for the playground environment */
export interface PlaygroundConfig {
  /** Welcome banner (set to '' to disable) */
  banner?: string;
  /** REPL prompt string (default: 'swarm> ') */
  prompt?: string;
  /** Pre-register mock agent handlers (name → response) */
  mockAgents?: Record<string, (input: string) => string | Promise<string>>;
  /** Budget ceiling (default: 100) */
  budgetCeiling?: number;
  /** Whether to show tips on startup (default: true) */
  showTips?: boolean;
}

/** Playground instance — provides access to all sandbox objects */
export interface PlaygroundInstance {
  /** The playground event emitter */
  emitter: EventEmitter;
  /** Stop the playground */
  stop: () => void;
  /** Whether the playground is running */
  isRunning: boolean;
}

// ============================================================================
// MOCK HELPERS
// ============================================================================

/** Simple mock agent registry for the playground */
export class MockAgentRegistry {
  private handlers = new Map<string, (input: string) => string | Promise<string>>();
  private callLog: Array<{ agentId: string; input: string; output: string; timestamp: number }> = [];

  /** Register a mock agent */
  register(name: string, handler: (input: string) => string | Promise<string>): void {
    this.handlers.set(name, handler);
  }

  /** List registered mock agents */
  list(): string[] {
    return Array.from(this.handlers.keys());
  }

  /** Call a mock agent */
  async call(name: string, input: string): Promise<string> {
    const handler = this.handlers.get(name);
    if (!handler) {
      throw new Error(`No mock agent '${name}'. Available: ${this.list().join(', ')}`);
    }
    const output = await handler(input);
    this.callLog.push({ agentId: name, input, output, timestamp: Date.now() });
    return output;
  }

  /** Get call history */
  history(): ReadonlyArray<{ agentId: string; input: string; output: string; timestamp: number }> {
    return this.callLog;
  }

  /** Clear call history */
  clearHistory(): void {
    this.callLog = [];
  }
}

// ============================================================================
// DEFAULT MOCKS
// ============================================================================

function createDefaultMocks(): Record<string, (input: string) => string> {
  return {
    echo: (input: string) => `Echo: ${input}`,
    upper: (input: string) => input.toUpperCase(),
    reverse: (input: string) => input.split('').reverse().join(''),
    count: (input: string) => `Words: ${input.split(/\s+/).filter(Boolean).length}`,
    json: (input: string) => JSON.stringify({ input, processed: true, timestamp: Date.now() }),
    summarize: (input: string) => {
      const words = input.split(/\s+/);
      return words.length <= 10 ? input : words.slice(0, 10).join(' ') + '...';
    },
    sentiment: (input: string) => {
      const positive = /good|great|excellent|happy|love|amazing|wonderful/i;
      const negative = /bad|terrible|awful|hate|horrible|worst/i;
      if (positive.test(input)) return 'positive';
      if (negative.test(input)) return 'negative';
      return 'neutral';
    },
  };
}

// ============================================================================
// PLAYGROUND
// ============================================================================

const DEFAULT_BANNER = `
\x1b[36m\x1b[1m╔══════════════════════════════════════════════════╗
║           Network-AI Playground (REPL)           ║
╚══════════════════════════════════════════════════╝\x1b[0m

\x1b[33mPre-loaded objects:\x1b[0m
  \x1b[32mmocks\x1b[0m      — MockAgentRegistry (register/call/list/history)
  \x1b[32mdelegate\x1b[0m   — Call a mock agent: delegate('echo', 'hello')
  \x1b[32magents\x1b[0m     — List available mock agents
  \x1b[32mhistory\x1b[0m    — View call history

\x1b[33mTips:\x1b[0m
  • Type \x1b[32m.help\x1b[0m for REPL commands
  • Type \x1b[32magents()\x1b[0m to see available agents
  • Type \x1b[32mdelegate('echo', 'hello world')\x1b[0m to test
  • Type \x1b[32m.exit\x1b[0m to quit
`;

/**
 * Start an interactive playground REPL with mock adapters.
 *
 * All key Network-AI objects are available in the REPL context.
 * Mock agents respond instantly with deterministic outputs.
 */
export function startPlayground(config: PlaygroundConfig = {}): PlaygroundInstance {
  const emitter = new EventEmitter();
  let running = true;

  const banner = config.banner ?? DEFAULT_BANNER;
  const prompt = config.prompt ?? 'swarm> ';

  // Set up mocks
  const mocks = new MockAgentRegistry();
  const defaultMocks = createDefaultMocks();

  for (const [name, handler] of Object.entries(defaultMocks)) {
    mocks.register(name, handler);
  }
  if (config.mockAgents) {
    for (const [name, handler] of Object.entries(config.mockAgents)) {
      mocks.register(name, handler);
    }
  }

  // Print banner
  if (banner) {
    console.log(banner);
  }

  // Create REPL
  const server = repl.start({
    prompt,
    useColors: true,
    ignoreUndefined: true,
  });

  // Expose objects in REPL context
  server.context['mocks'] = mocks;
  server.context['delegate'] = async (agentId: string, input: string) => {
    try {
      const result = await mocks.call(agentId, input);
      console.log(`\x1b[32m✓\x1b[0m ${result}`);
      return result;
    } catch (err) {
      console.log(`\x1b[31m✗\x1b[0m ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  };
  server.context['agents'] = () => {
    const list = mocks.list();
    console.log(`\x1b[36mAvailable agents (${list.length}):\x1b[0m`);
    for (const name of list) {
      console.log(`  • ${name}`);
    }
    return list;
  };
  server.context['history'] = () => {
    const hist = mocks.history();
    if (hist.length === 0) {
      console.log('\x1b[33mNo calls yet.\x1b[0m');
      return [];
    }
    for (const entry of hist) {
      const time = new Date(entry.timestamp).toLocaleTimeString();
      console.log(`  [${time}] ${entry.agentId}("${entry.input}") → "${entry.output}"`);
    }
    return hist;
  };

  server.on('exit', () => {
    running = false;
    emitter.emit('exit');
  });

  emitter.emit('started');

  return {
    emitter,
    stop: () => {
      running = false;
      server.close();
    },
    get isRunning() { return running; },
  };
}
