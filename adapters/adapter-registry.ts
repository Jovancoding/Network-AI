/**
 * Adapter Registry -- Routes agent requests to the correct adapter
 * 
 * The registry is the single entry point the SwarmOrchestrator uses.
 * It manages multiple adapters, routes requests based on agent ID patterns,
 * and provides unified agent discovery across all registered adapters.
 * 
 * @module AdapterRegistry
 * @version 1.0.0
 */

import type {
  IAgentAdapter,
  AdapterConfig,
  AdapterRoute,
  RegistryConfig,
  AgentPayload,
  AgentContext,
  AgentResult,
  AgentInfo,
  AdapterEvent,
  AdapterEventHandler,
  AdapterEventType,
} from '../types/agent-adapter';

export class AdapterRegistry {
  private adapters: Map<string, IAgentAdapter> = new Map();
  private routes: AdapterRoute[] = [];
  private defaultAdapterName: string | null = null;
  private eventHandlers: Map<AdapterEventType, AdapterEventHandler[]> = new Map();
  private agentCache: Map<string, string> = new Map(); // agentId -> adapterName

  constructor(config?: RegistryConfig) {
    if (config) {
      this.defaultAdapterName = config.defaultAdapter ?? null;
      this.routes = config.routes ?? [];
    }
  }

  // =========================================================================
  // ADAPTER MANAGEMENT
  // =========================================================================

  /**
   * Register an adapter with the registry.
   * Call this for each agent framework you want to support.
   */
  registerAdapter(adapter: IAgentAdapter): void {
    if (this.adapters.has(adapter.name)) {
      throw new Error(`Adapter "${adapter.name}" is already registered`);
    }
    this.adapters.set(adapter.name, adapter);
    this.emit('adapter:registered', adapter.name);
  }

  /**
   * Initialize a registered adapter with its configuration
   */
  async initializeAdapter(adapterName: string, config: AdapterConfig = {}): Promise<void> {
    const adapter = this.adapters.get(adapterName);
    if (!adapter) {
      throw new Error(`Adapter "${adapterName}" is not registered`);
    }
    await adapter.initialize(config);
    this.emit('adapter:initialized', adapterName);
  }

  /**
   * Register + initialize in one call (convenience)
   */
  async addAdapter(adapter: IAgentAdapter, config: AdapterConfig = {}): Promise<void> {
    this.registerAdapter(adapter);
    await this.initializeAdapter(adapter.name, config);
  }

  /**
   * Remove an adapter and shut it down
   */
  async removeAdapter(adapterName: string): Promise<void> {
    const adapter = this.adapters.get(adapterName);
    if (adapter) {
      await adapter.shutdown();
      this.adapters.delete(adapterName);
      // Clear agent cache entries for this adapter
      for (const [agentId, name] of this.agentCache.entries()) {
        if (name === adapterName) this.agentCache.delete(agentId);
      }
      this.emit('adapter:shutdown', adapterName);
    }
  }

  /**
   * Get a registered adapter by name
   */
  getAdapter(adapterName: string): IAgentAdapter | undefined {
    return this.adapters.get(adapterName);
  }

  /**
   * List all registered adapters
   */
  listAdapters(): Array<{ name: string; version: string; ready: boolean }> {
    return Array.from(this.adapters.values()).map(a => ({
      name: a.name,
      version: a.version,
      ready: a.isReady(),
    }));
  }

  /**
   * Set the default adapter for unrouted requests
   */
  setDefaultAdapter(adapterName: string): void {
    if (!this.adapters.has(adapterName)) {
      throw new Error(`Adapter "${adapterName}" is not registered`);
    }
    this.defaultAdapterName = adapterName;
  }

  // =========================================================================
  // ROUTING
  // =========================================================================

  /**
   * Add a routing rule: agent IDs matching the pattern go to the specified adapter.
   * 
   * Patterns:
   *   "lc:*"        -> all agents prefixed with "lc:" go to the LangChain adapter
   *   "autogen:*"   -> AutoGen agents
   *   "crew:*"      -> CrewAI agents
   *   "*"           -> catch-all
   *   "data_analyst" -> exact match
   */
  addRoute(route: AdapterRoute): void {
    this.routes.push(route);
    // Sort by priority (highest first)
    this.routes.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  /**
   * Resolve which adapter should handle a given agent ID
   */
  resolveAdapter(agentId: string): IAgentAdapter | null {
    // 1. Check cache
    const cached = this.agentCache.get(agentId);
    if (cached) {
      const adapter = this.adapters.get(cached);
      if (adapter?.isReady()) return adapter;
      this.agentCache.delete(agentId); // Stale cache
    }

    // 2. Check routing rules
    for (const route of this.routes) {
      if (this.matchPattern(agentId, route.pattern)) {
        const adapter = this.adapters.get(route.adapterName);
        if (adapter?.isReady()) {
          this.agentCache.set(agentId, route.adapterName);
          return adapter;
        }
      }
    }

    // 3. Check if agent ID has a prefix indicating the adapter (convention: "adapter:agentId")
    const colonIndex = agentId.indexOf(':');
    if (colonIndex > 0) {
      const prefix = agentId.substring(0, colonIndex);
      const adapter = this.adapters.get(prefix);
      if (adapter?.isReady()) {
        this.agentCache.set(agentId, prefix);
        return adapter;
      }
    }

    // 4. Fall back to default adapter
    if (this.defaultAdapterName) {
      const adapter = this.adapters.get(this.defaultAdapterName);
      if (adapter?.isReady()) return adapter;
    }

    // 5. If only one adapter is registered, use it
    if (this.adapters.size === 1) {
      const adapter = Array.from(this.adapters.values())[0];
      if (adapter.isReady()) return adapter;
    }

    return null;
  }

  private matchPattern(agentId: string, pattern: string): boolean {
    if (pattern === '*') return true;
    if (pattern === agentId) return true;

    // Simple glob: "prefix:*" or "prefix*"
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      return agentId.startsWith(prefix);
    }

    // Regex pattern (wrapped in /.../)
    if (pattern.startsWith('/') && pattern.endsWith('/')) {
      try {
        return new RegExp(pattern.slice(1, -1)).test(agentId);
      } catch {
        return false;
      }
    }

    return false;
  }

  // =========================================================================
  // EXECUTION -- The main interface the orchestrator uses
  // =========================================================================

  /**
   * Execute an agent task, automatically routing to the correct adapter.
   * This is the primary method the SwarmOrchestrator calls.
   */
  async executeAgent(
    agentId: string,
    payload: AgentPayload,
    context: AgentContext
  ): Promise<AgentResult> {
    const adapter = this.resolveAdapter(agentId);
    if (!adapter) {
      return {
        success: false,
        error: {
          code: 'NO_ADAPTER',
          message: `No adapter found for agent "${agentId}". Register an adapter or add a routing rule.`,
          recoverable: false,
          suggestedAction: 'Register an adapter using registry.addAdapter() and optionally add routes with registry.addRoute()',
        },
      };
    }

    this.emit('agent:execution:start', adapter.name, { agentId, payload });
    const startTime = Date.now();

    try {
      // Strip adapter prefix from agentId if present (e.g., "lc:research" -> "research")
      const colonIndex = agentId.indexOf(':');
      const resolvedAgentId = colonIndex > 0 && this.adapters.has(agentId.substring(0, colonIndex))
        ? agentId.substring(colonIndex + 1)
        : agentId;

      const result = await adapter.executeAgent(resolvedAgentId, payload, context);

      // Enrich result with routing metadata
      result.metadata = {
        ...result.metadata,
        adapter: adapter.name,
        executionTimeMs: Date.now() - startTime,
      };

      this.emit('agent:execution:complete', adapter.name, { agentId, result });
      return result;
    } catch (error) {
      this.emit('agent:execution:error', adapter.name, { agentId, error });
      return {
        success: false,
        error: {
          code: 'ADAPTER_ERROR',
          message: error instanceof Error ? error.message : 'Unknown adapter error',
          recoverable: true,
          nativeError: error,
        },
        metadata: {
          adapter: adapter.name,
          executionTimeMs: Date.now() - startTime,
        },
      };
    }
  }

  // =========================================================================
  // DISCOVERY -- Unified agent listing across all adapters
  // =========================================================================

  /**
   * Discover all agents across all registered adapters
   */
  async discoverAgents(): Promise<AgentInfo[]> {
    const allAgents: AgentInfo[] = [];

    for (const adapter of this.adapters.values()) {
      if (!adapter.isReady()) continue;

      try {
        const agents = await adapter.listAgents();
        allAgents.push(...agents);
        for (const agent of agents) {
          this.agentCache.set(agent.id, adapter.name);
          this.emit('agent:discovered', adapter.name, { agent });
        }
      } catch {
        // Skip adapters that fail discovery
      }
    }

    return allAgents;
  }

  /**
   * Check if any adapter can handle a specific agent
   */
  async isAgentAvailable(agentId: string): Promise<boolean> {
    const adapter = this.resolveAdapter(agentId);
    if (!adapter) return false;

    const colonIndex = agentId.indexOf(':');
    const resolvedId = colonIndex > 0 && this.adapters.has(agentId.substring(0, colonIndex))
      ? agentId.substring(colonIndex + 1)
      : agentId;

    return adapter.isAgentAvailable(resolvedId);
  }

  // =========================================================================
  // HEALTH -- System-wide health status
  // =========================================================================

  async healthCheck(): Promise<Record<string, { healthy: boolean; details?: string }>> {
    const results: Record<string, { healthy: boolean; details?: string }> = {};

    for (const [name, adapter] of this.adapters.entries()) {
      try {
        results[name] = await adapter.healthCheck();
      } catch (error) {
        results[name] = {
          healthy: false,
          details: error instanceof Error ? error.message : 'Health check failed',
        };
      }
    }

    return results;
  }

  // =========================================================================
  // EVENTS
  // =========================================================================

  on(event: AdapterEventType, handler: AdapterEventHandler): void {
    const handlers = this.eventHandlers.get(event) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(event, handlers);
  }

  off(event: AdapterEventType, handler: AdapterEventHandler): void {
    const handlers = this.eventHandlers.get(event) ?? [];
    this.eventHandlers.set(event, handlers.filter(h => h !== handler));
  }

  private emit(type: AdapterEventType, adapter: string, data?: unknown): void {
    const event: AdapterEvent = {
      type,
      adapter,
      timestamp: new Date().toISOString(),
      data,
    };

    const handlers = this.eventHandlers.get(type) ?? [];
    for (const handler of handlers) {
      try {
        handler(event);
      } catch {
        // Don't let event handler errors break execution
      }
    }
  }

  // =========================================================================
  // CLEANUP
  // =========================================================================

  /**
   * Shut down all adapters and clear the registry
   */
  async shutdownAll(): Promise<void> {
    for (const [name, adapter] of this.adapters.entries()) {
      try {
        await adapter.shutdown();
        this.emit('adapter:shutdown', name);
      } catch {
        // Best-effort shutdown
      }
    }
    this.adapters.clear();
    this.agentCache.clear();
    this.routes = [];
  }
}

// Default singleton registry
let defaultRegistry: AdapterRegistry | null = null;

export function getRegistry(config?: RegistryConfig): AdapterRegistry {
  if (!defaultRegistry || config) {
    defaultRegistry = new AdapterRegistry(config);
  }
  return defaultRegistry;
}
