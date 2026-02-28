#!/usr/bin/env node
/**
 * Network-AI MCP Server — Phase 6 Part 3
 *
 * Starts an HTTP/SSE server that exposes the full Network-AI tool suite to
 * any MCP-compatible AI agent (Claude Desktop, Cursor, Cline, etc.).
 *
 * Usage:
 *   npx ts-node bin/mcp-server.ts [options]
 *   npx network-ai-server [options]              (after clawhub publish)
 *
 * Options:
 *   --port <n>           TCP port to listen on (default: 3001)
 *   --host <h>           Hostname to bind to   (default: 0.0.0.0)
 *   --board <name>       Named blackboard to expose (default: main)
 *   --ceiling <n>        Initial FederatedBudget token ceiling (default: 1_000_000)
 *   --no-budget          Disable budget tools
 *   --no-token           Disable token tools
 *   --no-extended        Disable all extended tools (budget + token + audit)
 *   --no-control         Disable control-plane tools
 *   --audit-log <path>   Path to audit log file (default: ./data/audit_log.jsonl)
 *   --heartbeat <ms>     SSE heartbeat interval in ms (default: 15000)
 *   --help               Print this help text
 *
 * Connect any MCP client to:
 *   http://localhost:3001           (SSE stream — GET /sse)
 *   http://localhost:3001/mcp       (JSON-RPC POST)
 *   http://localhost:3001/health    (health check)
 *   http://localhost:3001/tools     (list all tools)
 *
 * @module bin/mcp-server
 * @version 4.0.8
 */

import {
  createSwarmOrchestrator,
  FederatedBudget,
  McpBlackboardBridge,
  getConfig,
  setConfig,
} from '../index';
import { SecureTokenManager } from '../security';
import {
  McpSseServer,
  McpCombinedBridge,
  McpBlackboardBridgeAdapter,
} from '../lib/mcp-transport-sse';
import { ExtendedMcpTools } from '../lib/mcp-tools-extended';
import { ControlMcpTools } from '../lib/mcp-tools-control';

// ============================================================================
// ARGUMENT PARSING
// ============================================================================

interface ServerArgs {
  port: number;
  host: string;
  board: string;
  ceiling: number;
  noBudget: boolean;
  noToken: boolean;
  noExtended: boolean;
  noControl: boolean;
  auditLog: string;
  heartbeat: number;
  help: boolean;
}

function parseArgs(argv: string[]): ServerArgs {
  const args: ServerArgs = {
    port: 3001,
    host: '0.0.0.0',
    board: 'main',
    ceiling: 1_000_000,
    noBudget: false,
    noToken: false,
    noExtended: false,
    noControl: false,
    auditLog: './data/audit_log.jsonl',
    heartbeat: 15000,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--port':       args.port = parseInt(next ?? '3001', 10); i++; break;
      case '--host':       args.host = next ?? '0.0.0.0'; i++; break;
      case '--board':      args.board = next ?? 'main'; i++; break;
      case '--ceiling':    args.ceiling = parseFloat(next ?? '1000000'); i++; break;
      case '--audit-log':  args.auditLog = next ?? './data/audit_log.jsonl'; i++; break;
      case '--heartbeat':  args.heartbeat = parseInt(next ?? '15000', 10); i++; break;
      case '--no-budget':    args.noBudget = true; break;
      case '--no-token':     args.noToken = true; break;
      case '--no-extended':  args.noExtended = true; break;
      case '--no-control':   args.noControl = true; break;
      case '--help': case '-h': args.help = true; break;
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`
network-ai-server — Network-AI MCP Server v4.0.8

Usage: npx ts-node bin/mcp-server.ts [options]

Options:
  --port <n>           TCP port (default: 3001)
  --host <h>           Bind host (default: 0.0.0.0)
  --board <name>       Named blackboard to expose (default: main)
  --ceiling <n>        Budget token ceiling (default: 1000000)
  --audit-log <path>   Audit log path (default: ./data/audit_log.jsonl)
  --heartbeat <ms>     SSE heartbeat interval (default: 15000)
  --no-budget          Disable budget tools
  --no-token           Disable token tools
  --no-extended        Disable extended tools (budget + token + audit)
  --no-control         Disable control-plane tools
  --help               Show this help

Connect to:
  GET  http://localhost:3001/sse     SSE stream
  POST http://localhost:3001/mcp     JSON-RPC 2.0 tool calls
  GET  http://localhost:3001/health  Health check
  GET  http://localhost:3001/tools   All available tools
`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  console.log(`\n[network-ai-server] Starting MCP Server v4.0.8`);
  console.log(`[network-ai-server] Board: ${args.board} | Port: ${args.port}`);

  // --------------------------------------------------------------------------
  // 1. Create orchestrator + blackboard
  // --------------------------------------------------------------------------
  const orchestrator = createSwarmOrchestrator();
  const blackboard = orchestrator.getBlackboard(args.board);

  // --------------------------------------------------------------------------
  // 2. Create MCP bridge for blackboard tools (5 tools)
  // --------------------------------------------------------------------------
  const blackboardBridge = new McpBlackboardBridge(blackboard, { name: args.board });
  const blackboardAdapter = new McpBlackboardBridgeAdapter(blackboardBridge);

  // --------------------------------------------------------------------------
  // 3. Create extended tools (budget + token + audit) — optional
  // --------------------------------------------------------------------------
  let extendedTools: ExtendedMcpTools | null = null;
  if (!args.noExtended) {
    const budget = !args.noBudget
      ? new FederatedBudget({ ceiling: args.ceiling })
      : undefined;

    const tokenManager = !args.noToken
      ? new SecureTokenManager()
      : undefined;

    extendedTools = new ExtendedMcpTools({
      budget,
      tokenManager,
      auditLogPath: args.auditLog,
    });

    const toolsEnabled: string[] = [];
    if (budget) toolsEnabled.push('budget (5 tools)');
    if (tokenManager) toolsEnabled.push('token (3 tools)');
    toolsEnabled.push('audit (2 tools)');
    console.log(`[network-ai-server] Extended tools: ${toolsEnabled.join(', ')}`);
  }

  // --------------------------------------------------------------------------
  // 4. Create control-plane tools — optional
  // --------------------------------------------------------------------------
  let controlTools: ControlMcpTools | null = null;
  if (!args.noControl) {
    // Get the live CONFIG reference via the exported accessor
    const liveConfig = getConfig() as Record<string, unknown>;

    // Create a proxy config object that both reads from and writes to CONFIG
    const configProxy = new Proxy(liveConfig, {
      get(_t, key: string) {
        return getConfig(key);
      },
      set(_t, key: string, value: unknown) {
        setConfig(key, value);
        return true;
      },
      ownKeys() {
        return Object.keys(getConfig() as object);
      },
      getOwnPropertyDescriptor(_t, key: string) {
        return { value: getConfig(key), writable: true, enumerable: true, configurable: true };
      },
    }) as unknown as import('../lib/mcp-tools-control').IConfig;

    controlTools = new ControlMcpTools({
      config: configProxy,
      blackboard: blackboard as unknown as import('../lib/mcp-tools-control').IControlBlackboard,
      systemToken: 'system-orchestrator-token',
    });

    console.log(`[network-ai-server] Control tools: config (2), agent (3), fsm (1), info (1)`);
  }

  // --------------------------------------------------------------------------
  // 5. Assemble combined bridge
  // --------------------------------------------------------------------------
  const combined = new McpCombinedBridge('network-ai');
  combined.register(blackboardAdapter);
  if (extendedTools) combined.register(extendedTools);
  if (controlTools) combined.register(controlTools);

  const totalTools = combined.allDefinitions().length;
  console.log(`[network-ai-server] Total tools exposed: ${totalTools}`);

  // --------------------------------------------------------------------------
  // 6. Start SSE server
  // --------------------------------------------------------------------------
  const server = new McpSseServer(combined, {
    port: args.port,
    host: args.host,
    heartbeatMs: args.heartbeat,
  });

  await server.listen();

  const localUrl = `http://localhost:${args.port}`;
  console.log(`\n[network-ai-server] ✓ Listening on ${localUrl}`);
  console.log(`[network-ai-server]   SSE stream : ${localUrl}/sse`);
  console.log(`[network-ai-server]   Tool calls : ${localUrl}/mcp  (POST)`);
  console.log(`[network-ai-server]   Health     : ${localUrl}/health`);
  console.log(`[network-ai-server]   All tools  : ${localUrl}/tools\n`);
  console.log(`[network-ai-server] Connect any MCP client to: ${localUrl}`);
  console.log(`[network-ai-server] Press Ctrl+C to stop.\n`);

  // --------------------------------------------------------------------------
  // 7. Graceful shutdown
  // --------------------------------------------------------------------------
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[network-ai-server] Received ${signal} — shutting down...`);
    await server.close();
    console.log('[network-ai-server] Server stopped. Goodbye.\n');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('\n[network-ai-server] Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
