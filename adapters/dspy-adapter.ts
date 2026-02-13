/**
 * DSPy Adapter
 * 
 * Integrates Stanford DSPy modules and programs with the SwarmOrchestrator.
 * DSPy is a framework for algorithmically optimising LM prompts and weights,
 * enabling systematic prompt engineering and agent compilation.
 * 
 * Usage:
 *   const adapter = new DSPyAdapter();
 *   adapter.registerModule("classifier", myDSPyModule);
 *   adapter.registerProgram("rag-pipeline", myCompiledProgram);
 *   await registry.addAdapter(adapter);
 * 
 * Then in the orchestrator:
 *   delegateTask({ targetAgent: "dspy:classifier", ... })
 * 
 * @module DSPyAdapter
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
// DSPy-compatible interfaces (self-contained)
// ---------------------------------------------------------------------------

/** Matches DSPy Module (ChainOfThought, Predict, ReAct, etc.) */
export interface DSPyModule {
  /** Forward pass / inference */
  forward(inputs: Record<string, unknown>): Promise<DSPyPrediction>;
  /** Alternative call interface */
  __call__?(inputs: Record<string, unknown>): Promise<DSPyPrediction>;
}

/** Matches a compiled DSPy program */
export interface DSPyProgram {
  /** Run the compiled program */
  run(inputs: Record<string, unknown>): Promise<DSPyPrediction>;
  /** Compile / optimise (optional) */
  compile?(trainset?: unknown[], options?: Record<string, unknown>): Promise<void>;
}

/** DSPy prediction result */
export interface DSPyPrediction {
  /** Named output fields */
  [key: string]: unknown;
  /** Common output: answer, response, output */
  answer?: string;
  rationale?: string;
  response?: string;
  /** Completion metadata */
  completions?: Record<string, unknown>;
}

/** A simple function-based predictor (for lightweight usage) */
export type DSPyPredictor = (
  inputs: Record<string, unknown>
) => Promise<DSPyPrediction>;

type DSPyEntry =
  | { type: 'module'; module: DSPyModule }
  | { type: 'program'; program: DSPyProgram }
  | { type: 'predictor'; predictor: DSPyPredictor };

export class DSPyAdapter extends BaseAdapter {
  readonly name = 'dspy';
  readonly version = '1.0.0';
  private entries: Map<string, DSPyEntry> = new Map();

  get capabilities(): AdapterCapabilities {
    return {
      streaming: false,
      parallel: true,
      bidirectional: false,
      discovery: true,
      authentication: false,
      statefulSessions: false,
    };
  }

  // --- Registration ---

  registerModule(
    agentId: string,
    module: DSPyModule,
    metadata?: { description?: string; capabilities?: string[] }
  ): void {
    this.entries.set(agentId, { type: 'module', module });
    this.registerLocalAgent({
      id: agentId,
      name: agentId,
      description: metadata?.description ?? `DSPy Module: ${agentId}`,
      capabilities: metadata?.capabilities ?? ['module', 'prompt-optimization'],
      status: 'available',
    });
  }

  registerProgram(
    agentId: string,
    program: DSPyProgram,
    metadata?: { description?: string; capabilities?: string[] }
  ): void {
    this.entries.set(agentId, { type: 'program', program });
    this.registerLocalAgent({
      id: agentId,
      name: agentId,
      description: metadata?.description ?? `DSPy Program: ${agentId}`,
      capabilities: metadata?.capabilities ?? ['program', 'compiled', 'optimized'],
      status: 'available',
    });
  }

  registerPredictor(
    agentId: string,
    predictor: DSPyPredictor,
    metadata?: { description?: string; capabilities?: string[] }
  ): void {
    this.entries.set(agentId, { type: 'predictor', predictor });
    this.registerLocalAgent({
      id: agentId,
      name: agentId,
      description: metadata?.description ?? `DSPy Predictor: ${agentId}`,
      capabilities: metadata?.capabilities ?? ['predictor'],
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
        `DSPy entry "${agentId}" is not registered`,
        false
      );
    }

    const inputs = this.buildInputs(payload);
    const startTime = Date.now();

    try {
      let prediction: DSPyPrediction;

      switch (entry.type) {
        case 'module':
          prediction = entry.module.__call__
            ? await entry.module.__call__(inputs)
            : await entry.module.forward(inputs);
          break;
        case 'program':
          prediction = await entry.program.run(inputs);
          break;
        case 'predictor':
          prediction = await entry.predictor(inputs);
          break;
        default:
          return this.errorResult('UNKNOWN_TYPE', 'Unknown DSPy entry type', false);
      }

      return this.successResult(
        this.normalizePrediction(prediction),
        Date.now() - startTime
      );
    } catch (error) {
      return this.errorResult(
        'DSPY_ERROR',
        error instanceof Error ? error.message : 'DSPy execution failed',
        true,
        error
      );
    }
  }

  // --- Private helpers ---

  private buildInputs(payload: AgentPayload): Record<string, unknown> {
    const inputs: Record<string, unknown> = { ...payload.params };
    if (payload.handoff?.instruction) {
      inputs.question = payload.handoff.instruction;
      inputs.query = payload.handoff.instruction;
    }
    if (payload.blackboardSnapshot) {
      inputs.context = payload.blackboardSnapshot;
    }
    return inputs;
  }

  private normalizePrediction(prediction: DSPyPrediction): Record<string, unknown> {
    // DSPy predictions have named output fields
    const response =
      prediction.answer ??
      prediction.response ??
      prediction.rationale ??
      '';

    return {
      response,
      prediction: { ...prediction },
      rationale: prediction.rationale,
    };
  }
}
