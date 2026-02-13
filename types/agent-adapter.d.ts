/**
 * Universal Agent Adapter Interface
 * 
 * This is the core contract that makes the SwarmOrchestrator plug-and-play
 * with ANY agent system. Each framework (OpenClaw, LangChain, AutoGen, CrewAI,
 * MCP, or custom agents) implements this interface via an adapter.
 * 
 * The SwarmOrchestrator never talks to a specific framework directly —
 * it talks through this universal interface.
 * 
 * @module AgentAdapter
 * @version 1.0.0
 */

// ============================================================================
// CORE TYPES — The universal language all adapters speak
// ============================================================================

/**
 * Payload sent to an agent for execution.
 * Framework adapters translate this into their native format.
 */
export interface AgentPayload {
  /** The action or task to perform */
  action: string;
  /** Parameters for the action */
  params: Record<string, unknown>;
  /** Optional handoff context from the orchestrator */
  handoff?: {
    handoffId: string;
    sourceAgent: string;
    targetAgent: string;
    taskType: 'delegate' | 'collaborate' | 'validate';
    instruction: string;
    context?: Record<string, unknown>;
    constraints?: string[];
    expectedOutput?: string;
    metadata?: Record<string, unknown>;
  };
  /** Shared state snapshot from the blackboard */
  blackboardSnapshot?: Record<string, unknown>;
}

/**
 * Universal execution context for agent operations
 */
export interface AgentContext {
  /** The agent initiating the request */
  agentId: string;
  /** Unique task identifier */
  taskId?: string;
  /** Session identifier for multi-turn interactions */
  sessionId?: string;
  /** Arbitrary metadata from the host system */
  metadata?: Record<string, unknown>;
}

/**
 * Universal result returned from agent execution.
 * Framework adapters normalize their native results into this shape.
 */
export interface AgentResult {
  /** Whether execution succeeded */
  success: boolean;
  /** Result data (any shape — adapters normalize this) */
  data?: unknown;
  /** Error information if execution failed */
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
    suggestedAction?: string;
    /** Framework-specific error details */
    nativeError?: unknown;
  };
  /** Execution metadata */
  metadata?: {
    /** Time taken in milliseconds */
    executionTimeMs?: number;
    /** Which adapter handled this */
    adapter?: string;
    /** Framework-specific trace data */
    trace?: Record<string, unknown>;
  };
}

/**
 * Information about a discoverable agent
 */
export interface AgentInfo {
  /** Unique agent identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Agent description */
  description?: string;
  /** Which adapter provides this agent */
  adapter: string;
  /** What the agent can do */
  capabilities?: string[];
  /** Current availability */
  status: 'available' | 'busy' | 'offline' | 'unknown';
  /** Framework-specific metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Configuration passed to an adapter during initialization
 */
export interface AdapterConfig {
  /** Working directory for file-based operations */
  workspacePath?: string;
  /** Framework-specific connection/API settings */
  connection?: {
    url?: string;
    apiKey?: string;
    headers?: Record<string, string>;
    timeout?: number;
  };
  /** Adapter-specific options */
  options?: Record<string, unknown>;
}

/**
 * Capabilities an adapter can declare support for
 */
export interface AdapterCapabilities {
  /** Can stream partial results */
  streaming: boolean;
  /** Can run multiple agents concurrently */
  parallel: boolean;
  /** Supports two-way agent communication */
  bidirectional: boolean;
  /** Can discover agents at runtime */
  discovery: boolean;
  /** Supports authentication/trust levels */
  authentication: boolean;
  /** Supports stateful multi-turn sessions */
  statefulSessions: boolean;
}

// ============================================================================
// ADAPTER INTERFACE — The contract every adapter must implement
// ============================================================================

/**
 * The core adapter interface. Every agent system (OpenClaw, LangChain, etc.)
 * implements this to plug into the SwarmOrchestrator.
 * 
 * Minimal implementation requires: name, version, initialize, executeAgent
 * Everything else has sensible defaults in BaseAdapter.
 */
export interface IAgentAdapter {
  /** Unique adapter identifier (e.g., "openclaw", "langchain", "autogen") */
  readonly name: string;
  /** Adapter version */
  readonly version: string;
  /** What this adapter can do */
  readonly capabilities: AdapterCapabilities;

  // --- Lifecycle ---

  /** Initialize the adapter with configuration */
  initialize(config: AdapterConfig): Promise<void>;
  /** Gracefully shut down the adapter */
  shutdown(): Promise<void>;
  /** Check if the adapter is ready */
  isReady(): boolean;

  // --- Agent Execution (REQUIRED) ---

  /** Execute a task on an agent — this is the core operation */
  executeAgent(
    agentId: string,
    payload: AgentPayload,
    context: AgentContext
  ): Promise<AgentResult>;

  // --- Agent Discovery (optional) ---

  /** List all agents available through this adapter */
  listAgents(): Promise<AgentInfo[]>;
  /** Check if a specific agent is available */
  isAgentAvailable(agentId: string): Promise<boolean>;

  // --- Health ---

  /** Health check for the adapter and its backing system */
  healthCheck(): Promise<{ healthy: boolean; details?: string }>;
}

// ============================================================================
// REGISTRY TYPES — Managing multiple adapters
// ============================================================================

/**
 * Route a request to the right adapter based on agent ID patterns
 */
export interface AdapterRoute {
  /** Glob or regex pattern to match agent IDs (e.g., "lc:*", "autogen:*") */
  pattern: string;
  /** Which adapter handles matching agents */
  adapterName: string;
  /** Priority if multiple routes match (higher = preferred) */
  priority?: number;
}

/**
 * Configuration for the adapter registry
 */
export interface RegistryConfig {
  /** Default adapter to use when no route matches */
  defaultAdapter?: string;
  /** Routing rules to map agent IDs to adapters */
  routes?: AdapterRoute[];
  /** Enable automatic agent discovery across all adapters */
  enableDiscovery?: boolean;
  /** How often to refresh agent discovery (ms) */
  discoveryIntervalMs?: number;
}

// ============================================================================
// EVENT TYPES — For adapter lifecycle hooks
// ============================================================================

export type AdapterEventType =
  | 'adapter:registered'
  | 'adapter:initialized'
  | 'adapter:shutdown'
  | 'adapter:error'
  | 'agent:execution:start'
  | 'agent:execution:complete'
  | 'agent:execution:error'
  | 'agent:discovered'
  | 'agent:unavailable';

export interface AdapterEvent {
  type: AdapterEventType;
  adapter: string;
  timestamp: string;
  data?: unknown;
}

export type AdapterEventHandler = (event: AdapterEvent) => void;
