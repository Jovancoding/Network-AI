/**
 * MCP (Model Context Protocol) Adapter
 * 
 * Connects the SwarmOrchestrator to MCP servers, enabling agent communication
 * over the Model Context Protocol. This enables cross-network agent discovery
 * and execution via MCP's tool-calling interface.
 * 
 * MCP servers expose "tools" -- this adapter maps each tool to an agent
 * that the orchestrator can delegate tasks to.
 * 
 * Usage:
 *   const adapter = new MCPAdapter();
 *   await registry.addAdapter(adapter, {
 *     connection: { url: 'http://localhost:3000/mcp' }
 *   });
 * 
 * Or with pre-registered tool functions:
 *   const adapter = new MCPAdapter();
 *   adapter.registerTool("search", searchFunction);
 *   await registry.addAdapter(adapter);
 * 
 * Then in the orchestrator:
 *   delegateTask({ targetAgent: "mcp:search", ... })
 * 
 * @module MCPAdapter
 * @version 1.0.0
 */

import { BaseAdapter } from './base-adapter';
import type {
  AdapterConfig,
  AdapterCapabilities,
  AgentPayload,
  AgentContext,
  AgentResult,
} from '../types/agent-adapter';

/**
 * MCP Tool definition (matches MCP spec)
 */
export interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * MCP tool execution function
 */
export type MCPToolHandler = (
  args: Record<string, unknown>
) => Promise<{ content: Array<{ type: string; text?: string; data?: unknown }>; isError?: boolean }>;

/**
 * MCP Server connection interface
 */
export interface MCPServerConnection {
  /** List available tools from the MCP server */
  listTools(): Promise<MCPTool[]>;
  /** Call a tool on the MCP server */
  callTool(name: string, args: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text?: string; data?: unknown }>;
    isError?: boolean;
  }>;
  /** Close the connection */
  close(): Promise<void>;
}

export class MCPAdapter extends BaseAdapter {
  readonly name = 'mcp';
  readonly version = '1.0.0';
  private tools: Map<string, MCPToolHandler> = new Map();
  private toolMetadata: Map<string, MCPTool> = new Map();
  private serverConnection: MCPServerConnection | null = null;

  get capabilities(): AdapterCapabilities {
    return {
      streaming: true,
      parallel: true,
      bidirectional: false,
      discovery: true,
      authentication: true,
      statefulSessions: false,
    };
  }

  async initialize(config: AdapterConfig): Promise<void> {
    await super.initialize(config);

    // If a server connection factory is provided, use it
    if (config.options?.serverConnection) {
      this.serverConnection = config.options.serverConnection as MCPServerConnection;
      // Discover tools from the server
      await this.discoverServerTools();
    }

    // If a URL is provided, the user needs to set up the connection themselves
    // (We don't bundle an MCP client library -- keep it dependency-free)
    if (config.connection?.url && !this.serverConnection) {
      console.info(
        `[MCPAdapter] URL configured: ${config.connection.url}. ` +
        `Provide a serverConnection via config.options.serverConnection or register tools manually.`
      );
    }

    this.ready = true;
  }

  /**
   * Register a local tool handler (no MCP server needed)
   */
  registerTool(
    name: string,
    handler: MCPToolHandler,
    metadata?: { description?: string; inputSchema?: Record<string, unknown> }
  ): void {
    this.tools.set(name, handler);
    this.toolMetadata.set(name, {
      name,
      description: metadata?.description,
      inputSchema: metadata?.inputSchema,
    });
    this.registerLocalAgent({
      id: name,
      name,
      description: metadata?.description ?? `MCP tool: ${name}`,
      capabilities: ['tool'],
      status: 'available',
    });
  }

  private async discoverServerTools(): Promise<void> {
    if (!this.serverConnection) return;

    try {
      const tools = await this.serverConnection.listTools();
      for (const tool of tools) {
        this.toolMetadata.set(tool.name, tool);
        this.registerLocalAgent({
          id: tool.name,
          name: tool.name,
          description: tool.description ?? `MCP server tool: ${tool.name}`,
          capabilities: ['tool'],
          status: 'available',
          metadata: { inputSchema: tool.inputSchema },
        });
      }
    } catch (error) {
      console.error('[MCPAdapter] Failed to discover server tools:', error);
    }
  }

  async executeAgent(
    agentId: string,
    payload: AgentPayload,
    context: AgentContext
  ): Promise<AgentResult> {
    this.ensureReady();

    const startTime = Date.now();

    // Strategy 1: Local tool handler
    const localHandler = this.tools.get(agentId);
    if (localHandler) {
      return this.executeLocalTool(agentId, localHandler, payload, startTime);
    }

    // Strategy 2: Remote MCP server
    if (this.serverConnection) {
      return this.executeRemoteTool(agentId, payload, startTime);
    }

    return this.errorResult(
      'TOOL_NOT_FOUND',
      `MCP tool "${agentId}" not found locally or on any connected server`,
      false
    );
  }

  private async executeLocalTool(
    name: string,
    handler: MCPToolHandler,
    payload: AgentPayload,
    startTime: number
  ): Promise<AgentResult> {
    try {
      const args = this.buildToolArgs(payload);
      const result = await handler(args);

      if (result.isError) {
        const errorText = result.content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n');
        return this.errorResult('TOOL_ERROR', errorText || 'Tool returned an error', true);
      }

      // Extract text content from MCP response format
      const data = this.extractContent(result.content);
      return this.successResult(data, Date.now() - startTime);
    } catch (error) {
      return this.errorResult(
        'MCP_ERROR',
        error instanceof Error ? error.message : 'MCP tool execution failed',
        true,
        error
      );
    }
  }

  private async executeRemoteTool(
    name: string,
    payload: AgentPayload,
    startTime: number
  ): Promise<AgentResult> {
    if (!this.serverConnection) {
      return this.errorResult('NO_CONNECTION', 'No MCP server connection', false);
    }

    try {
      const args = this.buildToolArgs(payload);
      const result = await this.serverConnection.callTool(name, args);

      if (result.isError) {
        const errorText = result.content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n');
        return this.errorResult('TOOL_ERROR', errorText || 'Remote tool returned an error', true);
      }

      const data = this.extractContent(result.content);
      return this.successResult(data, Date.now() - startTime);
    } catch (error) {
      return this.errorResult(
        'MCP_REMOTE_ERROR',
        error instanceof Error ? error.message : 'Remote MCP tool call failed',
        true,
        error
      );
    }
  }

  private buildToolArgs(payload: AgentPayload): Record<string, unknown> {
    const args: Record<string, unknown> = { ...payload.params };

    if (payload.handoff) {
      args.instruction = payload.handoff.instruction;
      if (payload.handoff.context) {
        args.context = payload.handoff.context;
      }
    }

    return args;
  }

  private extractContent(content: Array<{ type: string; text?: string; data?: unknown }>): unknown {
    if (content.length === 1) {
      if (content[0].type === 'text' && content[0].text) {
        // Try to parse as JSON
        try {
          return JSON.parse(content[0].text);
        } catch {
          return content[0].text;
        }
      }
      return content[0].data ?? content[0].text;
    }

    // Multiple content blocks -- return structured
    return content.map(c => ({
      type: c.type,
      value: c.type === 'text' ? c.text : c.data,
    }));
  }

  async shutdown(): Promise<void> {
    if (this.serverConnection) {
      try {
        await this.serverConnection.close();
      } catch {
        // Best-effort
      }
      this.serverConnection = null;
    }
    await super.shutdown();
  }
}
