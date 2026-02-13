/**
 * Semantic Kernel Adapter
 * 
 * Integrates Microsoft Semantic Kernel agents and functions with the
 * SwarmOrchestrator. Semantic Kernel is Microsoft's enterprise SDK for
 * building AI-powered apps with plugins, planners, and memory.
 * 
 * Usage:
 *   const adapter = new SemanticKernelAdapter();
 *   adapter.registerKernel("planner", myKernel);
 *   adapter.registerFunction("summarise", mySKFunction);
 *   await registry.addAdapter(adapter);
 * 
 * Then in the orchestrator:
 *   delegateTask({ targetAgent: "semantic-kernel:planner", ... })
 * 
 * @module SemanticKernelAdapter
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
// Semantic Kernel-compatible interfaces (self-contained)
// ---------------------------------------------------------------------------

/** Matches SK's Kernel interface */
export interface SKKernel {
  /** Invoke a function within the kernel */
  invokeFunction?(
    functionName: string,
    args?: Record<string, unknown>
  ): Promise<SKFunctionResult>;
  /** Invoke a prompt directly */
  invokePrompt?(
    prompt: string,
    args?: Record<string, unknown>
  ): Promise<SKFunctionResult>;
  /** Run a planner */
  runPlan?(goal: string, options?: Record<string, unknown>): Promise<SKPlanResult>;
}

/** Matches SK's KernelFunction */
export interface SKFunction {
  /** Function name */
  name: string;
  /** Invoke the function */
  invoke(args?: Record<string, unknown>): Promise<SKFunctionResult>;
}

/** Matches SK's FunctionResult */
export interface SKFunctionResult {
  value?: unknown;
  toString?(): string;
  metadata?: Record<string, unknown>;
}

/** Planner result */
export interface SKPlanResult {
  result?: string;
  steps?: Array<{ plugin: string; function: string; result?: string }>;
  error?: string;
}

type SKEntry =
  | { type: 'kernel'; kernel: SKKernel }
  | { type: 'function'; fn: SKFunction };

export class SemanticKernelAdapter extends BaseAdapter {
  readonly name = 'semantic-kernel';
  readonly version = '1.0.0';
  private entries: Map<string, SKEntry> = new Map();

  get capabilities(): AdapterCapabilities {
    return {
      streaming: false,
      parallel: true,
      bidirectional: false,
      discovery: true,
      authentication: true,
      statefulSessions: true,
    };
  }

  // --- Registration ---

  registerKernel(
    agentId: string,
    kernel: SKKernel,
    metadata?: { description?: string; capabilities?: string[] }
  ): void {
    this.entries.set(agentId, { type: 'kernel', kernel });
    this.registerLocalAgent({
      id: agentId,
      name: agentId,
      description: metadata?.description ?? `Semantic Kernel: ${agentId}`,
      capabilities: metadata?.capabilities ?? ['planner', 'plugins', 'prompt'],
      status: 'available',
    });
  }

  registerFunction(
    agentId: string,
    fn: SKFunction,
    metadata?: { description?: string; capabilities?: string[] }
  ): void {
    this.entries.set(agentId, { type: 'function', fn });
    this.registerLocalAgent({
      id: agentId,
      name: fn.name || agentId,
      description: metadata?.description ?? `SK Function: ${fn.name || agentId}`,
      capabilities: metadata?.capabilities ?? ['function'],
      status: 'available',
    });
  }

  // --- Execution ---

  async executeAgent(
    agentId: string,
    payload: AgentPayload,
    context: AgentContext
  ): Promise<AgentResult> {
    this.ensureReady();

    const entry = this.entries.get(agentId);
    if (!entry) {
      return this.errorResult(
        'AGENT_NOT_FOUND',
        `Semantic Kernel entry "${agentId}" is not registered`,
        false
      );
    }

    const startTime = Date.now();

    try {
      if (entry.type === 'function') {
        return await this.executeSKFunction(entry.fn, payload, startTime);
      }
      return await this.executeKernel(entry.kernel, payload, startTime);
    } catch (error) {
      return this.errorResult(
        'SK_ERROR',
        error instanceof Error ? error.message : 'Semantic Kernel execution failed',
        true,
        error
      );
    }
  }

  // --- Private helpers ---

  private async executeSKFunction(
    fn: SKFunction,
    payload: AgentPayload,
    startTime: number
  ): Promise<AgentResult> {
    const args = this.buildArgs(payload);
    const result = await fn.invoke(args);
    return this.successResult(this.normalizeResult(result), Date.now() - startTime);
  }

  private async executeKernel(
    kernel: SKKernel,
    payload: AgentPayload,
    startTime: number
  ): Promise<AgentResult> {
    const goal = payload.handoff?.instruction || JSON.stringify(payload.params);
    const args = this.buildArgs(payload);

    // Strategy 1: Use planner if available and we have a goal
    if (kernel.runPlan && payload.handoff?.instruction) {
      const plan = await kernel.runPlan(goal, args);
      return this.successResult({
        response: plan.result,
        steps: plan.steps,
        error: plan.error,
      }, Date.now() - startTime);
    }

    // Strategy 2: Invoke a named function
    if (kernel.invokeFunction && payload.params?.functionName) {
      const result = await kernel.invokeFunction(
        String(payload.params.functionName),
        args
      );
      return this.successResult(this.normalizeResult(result), Date.now() - startTime);
    }

    // Strategy 3: Invoke a prompt directly
    if (kernel.invokePrompt) {
      const result = await kernel.invokePrompt(goal, args);
      return this.successResult(this.normalizeResult(result), Date.now() - startTime);
    }

    return this.errorResult(
      'NO_METHOD',
      'Kernel has no callable method (runPlan, invokeFunction, invokePrompt)',
      false
    );
  }

  private buildArgs(payload: AgentPayload): Record<string, unknown> {
    const args: Record<string, unknown> = { ...payload.params };
    if (payload.handoff?.instruction) args.input = payload.handoff.instruction;
    if (payload.blackboardSnapshot) args.context = payload.blackboardSnapshot;
    return args;
  }

  private normalizeResult(result: SKFunctionResult): Record<string, unknown> {
    return {
      response: result.value ?? result.toString?.() ?? '',
      metadata: result.metadata,
    };
  }
}
