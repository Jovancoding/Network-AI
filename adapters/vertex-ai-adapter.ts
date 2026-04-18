/**
 * Vertex AI Adapter
 *
 * Integrates Google Vertex AI (Gemini models, PaLM, custom endpoints)
 * with the SwarmOrchestrator.
 *
 * Supports:
 *   - Gemini chat/generation (via user-supplied client)
 *   - Function calling / tool use
 *   - Multi-modal inputs (text + images)
 *   - Custom Vertex AI endpoints
 *
 * Usage:
 *   const adapter = new VertexAIAdapter();
 *   adapter.registerModel('analyst', {
 *     client: myVertexClient,
 *     model: 'gemini-2.0-flash',
 *   });
 *
 * @module VertexAIAdapter
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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Vertex AI function declaration for tool use */
export interface VertexFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** A content part (text or inline data) */
export interface VertexContentPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

/** Response from Vertex AI */
export interface VertexGenerateResponse {
  /** Generated text content */
  text: string;
  /** Function calls requested by the model */
  functionCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  /** Safety ratings */
  safetyRatings?: Array<{ category: string; probability: string }>;
  /** Token usage */
  usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number };
  /** Finish reason */
  finishReason?: string;
}

/**
 * Minimal interface for a Vertex AI generative model client.
 * Compatible with `@google-cloud/vertexai` GenerativeModel.
 */
export interface VertexGenerativeClient {
  generateContent(request: {
    contents: Array<{ role: string; parts: VertexContentPart[] }>;
    systemInstruction?: { parts: VertexContentPart[] };
    tools?: Array<{ functionDeclarations: VertexFunctionDeclaration[] }>;
  }): Promise<{
    response: VertexGenerateResponse;
  }>;
}

/**
 * Function executor for tool use.
 * Called when Gemini requests a function call.
 */
export type VertexFunctionExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/** Configuration for a registered Vertex AI agent */
export interface VertexAIAgentConfig {
  /** The Vertex AI client instance */
  client: VertexGenerativeClient;
  /** Model name (default: 'gemini-2.0-flash') */
  model?: string;
  /** System instruction */
  systemInstruction?: string;
  /** Function declarations for tool use */
  functions?: VertexFunctionDeclaration[];
  /** Function executor for tool calls */
  functionExecutor?: VertexFunctionExecutor;
  /** Maximum tool-use loop iterations (default: 10) */
  maxIterations?: number;
  /** Per-invocation timeout in ms (default: 60000) */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Adapter for Google Vertex AI (Gemini, PaLM, custom endpoints).
 *
 * Each registered model is exposed as a named agent. Supports
 * multi-turn tool use loops when functions are configured.
 */
export class VertexAIAdapter extends BaseAdapter {
  readonly name = 'vertex-ai';
  readonly version = '1.0.0';

  private models = new Map<string, VertexAIAgentConfig>();

  get capabilities(): AdapterCapabilities {
    return {
      streaming: false,
      parallel: true,
      bidirectional: false,
      discovery: true,
      authentication: true,
      statefulSessions: false,
    };
  }

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  /**
   * Register a Vertex AI model as a named agent.
   */
  registerModel(agentId: string, config: VertexAIAgentConfig): void {
    this.models.set(agentId, config);
    this.registerLocalAgent({
      id: agentId,
      name: agentId,
      status: 'available',
      capabilities: [
        'generation',
        ...(config.functions?.length ? ['tool-use'] : []),
      ],
      metadata: {
        adapter: 'vertex-ai',
        model: config.model ?? 'gemini-2.0-flash',
      },
    });
  }

  // -----------------------------------------------------------------------
  // Execution
  // -----------------------------------------------------------------------

  async executeAgent(agentId: string, payload: AgentPayload, _context: AgentContext): Promise<AgentResult> {
    this.ensureReady();

    const config = this.models.get(agentId);
    if (!config) {
      return this.errorResult('VERTEX_AGENT_NOT_FOUND', `No model registered as '${agentId}'`);
    }

    const instruction = payload.handoff?.instruction
      ?? (payload.params?.instruction as string)
      ?? payload.action;

    const timeoutMs = config.timeoutMs ?? 60_000;
    const maxIterations = config.maxIterations ?? 10;
    const start = Date.now();

    // Build initial contents
    const userParts: VertexContentPart[] = [{ text: instruction }];

    // Add image if provided
    const imageData = payload.params?.image as string | undefined;
    const imageMime = (payload.params?.imageMimeType as string) ?? 'image/png';
    if (imageData) {
      userParts.push({ inlineData: { mimeType: imageMime, data: imageData } });
    }

    const contents: Array<{ role: string; parts: VertexContentPart[] }> = [
      { role: 'user', parts: userParts },
    ];

    const systemInstruction = config.systemInstruction
      ? { parts: [{ text: config.systemInstruction }] }
      : undefined;

    const tools = config.functions?.length
      ? [{ functionDeclarations: config.functions }]
      : undefined;

    let iterations = 0;
    let totalTokens = 0;

    try {
      while (iterations < maxIterations) {
        iterations++;

        const result = await Promise.race([
          config.client.generateContent({ contents, systemInstruction, tools }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Vertex AI invocation timed out')), timeoutMs),
          ),
        ]);

        const response = result.response;
        if (response.usageMetadata) {
          totalTokens += response.usageMetadata.totalTokenCount;
        }

        // If no function calls or no executor, return text result
        if (!response.functionCalls?.length || !config.functionExecutor) {
          const durationMs = Date.now() - start;
          return this.successResult({
            text: response.text,
            finishReason: response.finishReason,
            tokensUsed: totalTokens,
            safetyRatings: response.safetyRatings,
            iterations,
          }, durationMs);
        }

        // Execute function calls
        contents.push({
          role: 'model',
          parts: response.functionCalls.map((fc) => ({
            text: JSON.stringify({ functionCall: { name: fc.name, args: fc.args } }),
          })),
        });

        const functionResults: VertexContentPart[] = [];
        for (const fc of response.functionCalls) {
          const fnResult = await config.functionExecutor(fc.name, fc.args);
          functionResults.push({
            text: JSON.stringify({ functionResponse: { name: fc.name, response: fnResult } }),
          });
        }

        contents.push({ role: 'function', parts: functionResults });
      }

      // Max iterations
      const durationMs = Date.now() - start;
      return this.successResult({
        text: 'Max function-call iterations reached',
        tokensUsed: totalTokens,
        iterations,
        exhausted: true,
      }, durationMs);
    } catch (err) {
      return this.errorResult(
        'VERTEX_EXECUTION_FAILED',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async shutdown(): Promise<void> {
    this.models.clear();
    await super.shutdown();
  }
}
