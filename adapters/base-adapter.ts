/**
 * Base Adapter - Abstract base class for all agent system adapters
 * 
 * Provides sensible defaults so adapter authors only need to implement
 * the core `executeAgent` method. Everything else works out of the box.
 * 
 * @module BaseAdapter
 * @version 1.0.0
 */

import type {
  IAgentAdapter,
  AdapterConfig,
  AdapterCapabilities,
  AgentPayload,
  AgentContext,
  AgentResult,
  AgentInfo,
} from '../types/agent-adapter';

export abstract class BaseAdapter implements IAgentAdapter {
  abstract readonly name: string;
  abstract readonly version: string;

  protected config: AdapterConfig = {};
  protected ready = false;
  protected registeredAgents: Map<string, AgentInfo> = new Map();

  /** Override to declare what your adapter supports */
  get capabilities(): AdapterCapabilities {
    return {
      streaming: false,
      parallel: true,
      bidirectional: false,
      discovery: false,
      authentication: false,
      statefulSessions: false,
    };
  }

  // --- Lifecycle ---

  async initialize(config: AdapterConfig): Promise<void> {
    this.config = config;
    this.ready = true;
  }

  async shutdown(): Promise<void> {
    this.ready = false;
    this.registeredAgents.clear();
  }

  isReady(): boolean {
    return this.ready;
  }

  // --- Agent Execution (subclasses MUST implement) ---

  abstract executeAgent(
    agentId: string,
    payload: AgentPayload,
    context: AgentContext
  ): Promise<AgentResult>;

  // --- Agent Discovery (default: use registered agents) ---

  async listAgents(): Promise<AgentInfo[]> {
    return Array.from(this.registeredAgents.values());
  }

  async isAgentAvailable(agentId: string): Promise<boolean> {
    return this.registeredAgents.has(agentId);
  }

  // --- Health ---

  async healthCheck(): Promise<{ healthy: boolean; details?: string }> {
    return { healthy: this.ready, details: this.ready ? 'Adapter is ready' : 'Adapter not initialized' };
  }

  // --- Helpers for subclasses ---

  /**
   * Register an agent as available through this adapter.
   * Adapters call this during init or discovery to declare their agents.
   */
  protected registerLocalAgent(agent: Omit<AgentInfo, 'adapter'>): void {
    this.registeredAgents.set(agent.id, { ...agent, adapter: this.name });
  }

  /**
   * Remove an agent from the registry
   */
  protected unregisterAgent(agentId: string): void {
    this.registeredAgents.delete(agentId);
  }

  /**
   * Create a standard success result
   */
  protected successResult(data: unknown, executionTimeMs?: number): AgentResult {
    return {
      success: true,
      data,
      metadata: {
        adapter: this.name,
        executionTimeMs,
      },
    };
  }

  /**
   * Create a standard error result
   */
  protected errorResult(
    code: string,
    message: string,
    recoverable = true,
    nativeError?: unknown
  ): AgentResult {
    return {
      success: false,
      error: {
        code,
        message,
        recoverable,
        nativeError,
      },
      metadata: { adapter: this.name },
    };
  }

  /**
   * Ensures the adapter is initialized before use
   */
  protected ensureReady(): void {
    if (!this.ready) {
      throw new Error(`Adapter "${this.name}" is not initialized. Call initialize() first.`);
    }
  }
}
