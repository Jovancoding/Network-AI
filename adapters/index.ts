/**
 * Adapter System -- Plug-and-Play Agent Framework Support
 * 
 * This module exports everything needed to make the SwarmOrchestrator
 * work with any agent system. Import from here for clean access.
 * 
 * Quick Start:
 * 
 *   import { AdapterRegistry, CustomAdapter } from './adapters';
 * 
 *   const registry = new AdapterRegistry();
 *   const custom = new CustomAdapter();
 *   custom.registerHandler("my-agent", async (payload) => {
 *     return { result: "done" };
 *   });
 *   await registry.addAdapter(custom);
 * 
 * @module Adapters
 * @version 1.0.0
 */

// Core infrastructure
export { BaseAdapter } from './base-adapter';
export { AdapterRegistry, getRegistry } from './adapter-registry';

// Framework adapters -- Original 6
export { OpenClawAdapter } from './openclaw-adapter';
export { LangChainAdapter } from './langchain-adapter';
export type { LangChainRunnable } from './langchain-adapter';
export { AutoGenAdapter } from './autogen-adapter';
export type { AutoGenAgent } from './autogen-adapter';
export { CrewAIAdapter } from './crewai-adapter';
export type { CrewAIAgent, CrewAICrew } from './crewai-adapter';
export { MCPAdapter } from './mcp-adapter';
export type { MCPTool, MCPToolHandler, MCPServerConnection } from './mcp-adapter';
export { CustomAdapter } from './custom-adapter';
export type { AgentHandler, HttpAgentConfig } from './custom-adapter';

// Framework adapters -- New 6
export { LlamaIndexAdapter } from './llamaindex-adapter';
export type {
  LlamaIndexQueryEngine,
  LlamaIndexChatEngine,
  LlamaIndexAgentRunner,
  LlamaIndexResponse,
} from './llamaindex-adapter';
export { SemanticKernelAdapter } from './semantic-kernel-adapter';
export type { SKKernel, SKFunction, SKFunctionResult, SKPlanResult } from './semantic-kernel-adapter';
export { OpenAIAssistantsAdapter } from './openai-assistants-adapter';
export type {
  AssistantConfig,
  OpenAIAssistantsClient,
  ThreadMessage,
  RunResult,
} from './openai-assistants-adapter';
export { HaystackAdapter } from './haystack-adapter';
export type {
  HaystackPipeline,
  HaystackPipelineResult,
  HaystackAgent,
  HaystackAgentResult,
  HaystackComponent,
} from './haystack-adapter';
export { DSPyAdapter } from './dspy-adapter';
export type { DSPyModule, DSPyProgram, DSPyPrediction, DSPyPredictor } from './dspy-adapter';
export { AgnoAdapter } from './agno-adapter';
export type {
  AgnoAgent,
  AgnoTeam,
  AgnoResponse,
  AgnoFunction,
} from './agno-adapter';

// Streaming adapters
export { StreamingBaseAdapter, collectStream } from './streaming-base-adapter';
export { LangChainStreamingAdapter } from './langchain-streaming-adapter';
export { CustomStreamingAdapter } from './custom-streaming-adapter';
export type { StreamingAgentHandler } from './custom-streaming-adapter';

// A2A (Agent-to-Agent) adapter
export { A2AAdapter } from './a2a-adapter';
export type {
  A2AAgentCard,
  A2ATask,
  A2ATaskResponse,
  A2ATaskState,
  A2AArtifact,
  A2AAdapterConfig,
} from './a2a-adapter';

// Streaming types
export type { StreamingChunk, IStreamingAdapter, StreamCollector } from '../types/streaming-adapter';

// Re-export types for convenience
export type {
  IAgentAdapter,
  AgentPayload,
  AgentContext,
  AgentResult,
  AgentInfo,
  AdapterConfig,
  AdapterCapabilities,
  AdapterRoute,
  RegistryConfig,
  AdapterEvent,
  AdapterEventHandler,
  AdapterEventType,
} from '../types/agent-adapter';
