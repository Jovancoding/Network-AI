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
export type { AdapterFactory, RetryPolicy } from './adapter-registry';

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

// Codex adapter (OpenAI Codex CLI / chat / completion)
export { CodexAdapter } from './codex-adapter';
export type {
  CodexMode,
  CodexAgentConfig,
  CodexChatClient,
  CodexCompletionClient,
  CodexCLIExecutor,
} from './codex-adapter';

// MiniMax adapter (MiniMax LLM API — MiniMax-M2.5 / MiniMax-M2.5-highspeed)
export { MiniMaxAdapter } from './minimax-adapter';
export type { MiniMaxAgentConfig, MiniMaxChatClient } from './minimax-adapter';

// APS adapter (Agent Permission Service — delegation chain → trust mapping)
export { APSAdapter } from './aps-adapter';
export type {
  APSDelegation,
  APSTrustMapping,
  APSAdapterConfig,
} from './aps-adapter';

// NemoClaw adapter (NVIDIA NemoClaw — sandboxed agent execution via OpenShell)
export { NemoClawAdapter } from './nemoclaw-adapter';
export type {
  NemoClawAgentConfig,
  OpenShellExecutor,
  BlueprintAction,
  BlueprintRunResult,
  SandboxState,
  SandboxStatus,
  NetworkPolicy,
  PolicyEndpoint,
} from './nemoclaw-adapter';

// Copilot adapter (GitHub Copilot — code generation, review, analysis)
export { CopilotAdapter } from './copilot-adapter';
export type { CopilotTaskType, CopilotOptions, CopilotConnection } from './copilot-adapter';

// Hermes adapter (NousResearch Hermes — Ollama / OpenAI-compatible endpoint, BYOC)
export { HermesAdapter } from './hermes-adapter';
export type { HermesAgentConfig, HermesChatClient } from './hermes-adapter';

// LangGraph adapter (LangChain stateful graph execution)
export { LangGraphAdapter } from './langgraph-adapter';
export type { LangGraphRunnable, LangGraphStreamable, LangGraphAgentConfig } from './langgraph-adapter';

// Anthropic Computer Use adapter (Claude with screen/keyboard/mouse)
export { AnthropicComputerUseAdapter } from './anthropic-computer-use-adapter';
export type {
  ComputerAction,
  ComputerToolCall,
  ComputerToolResult,
  ComputerActionHandler,
  AnthropicMessagesClient,
  ComputerUseAgentConfig,
} from './anthropic-computer-use-adapter';

// Anthropic Messages adapter (governed refusal → fallback → billing lifecycle)
export { AnthropicMessagesAdapter, createAnthropicCaller, normalizeAnthropicResponse } from './anthropic-messages-adapter';
export type { AnthropicMessagesApiClient, AnthropicRawResponse, AnthropicMessagesAgentConfig } from './anthropic-messages-adapter';

// OpenAI Agents SDK adapter (agent runners with tools, handoffs, guardrails)
export { OpenAIAgentsAdapter } from './openai-agents-adapter';
export type {
  OAIAgentTool,
  OAIAgentRunResult,
  OAIAgentRunner,
  OAIAgentsConfig,
} from './openai-agents-adapter';

// Vertex AI adapter (Google Gemini, PaLM, custom endpoints)
export { VertexAIAdapter } from './vertex-ai-adapter';
export type {
  VertexFunctionDeclaration,
  VertexContentPart,
  VertexGenerateResponse,
  VertexGenerativeClient,
  VertexFunctionExecutor,
  VertexAIAgentConfig,
} from './vertex-ai-adapter';

// Pydantic AI adapter (type-safe Python agent framework)
export { PydanticAIAdapter } from './pydantic-ai-adapter';
export type {
  PydanticAIRunResult,
  PydanticAIRunner,
  PydanticAIHttpConfig,
  PydanticAIAgentConfig,
} from './pydantic-ai-adapter';

// Browser Agent adapter (Playwright, Puppeteer, CDP browser automation)
export { BrowserAgentAdapter } from './browser-agent-adapter';
export type {
  BrowserMode,
  BrowserStep,
  BrowserActionResult,
  BrowserDriver,
  BrowserAgentConfig,
} from './browser-agent-adapter';

// Orchestrator adapter (hierarchical multi-orchestrator coordination)
export { OrchestratorAdapter } from './orchestrator-adapter';
export type {
  ChildOrchestratorConfig,
  OrchestratorLike,
  ChildOrchestratorState,
} from './orchestrator-adapter';

// RLM adapter (Recursive Language Model — arxiv 2512.24601)
export { RLMAdapter } from './rlm-adapter';
export type { RLMAgentConfig, RLMHttpClient } from './rlm-adapter';

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
