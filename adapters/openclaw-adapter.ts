/**
 * OpenClaw Adapter -- Preserves all existing OpenClaw functionality
 * 
 * This adapter wraps the original `callSkill()` / `OpenClawSkill` interface
 * so the SwarmOrchestrator continues to work exactly as before for OpenClaw users.
 * 
 * @module OpenClawAdapter
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

// Re-export OpenClaw types for users who still need them directly
export type { OpenClawSkill, SkillContext, SkillResult } from 'openclaw-core';

/**
 * Type for the OpenClaw callSkill function
 */
type CallSkillFn = (
  skillName: string,
  params: Record<string, unknown>
) => Promise<{ success: boolean; data?: unknown; error?: { code: string; message: string; recoverable: boolean; suggestedAction?: string } }>;

export class OpenClawAdapter extends BaseAdapter {
  readonly name = 'openclaw';
  readonly version = '1.0.0';
  private callSkill: CallSkillFn | null = null;

  get capabilities(): AdapterCapabilities {
    return {
      streaming: false,
      parallel: true,
      bidirectional: true,
      discovery: false,
      authentication: true,
      statefulSessions: true,
    };
  }

  async initialize(config: AdapterConfig): Promise<void> {
    await super.initialize(config);

    // Try to import callSkill from openclaw-core
    try {
      const openclawCore = await import('openclaw-core');
      this.callSkill = openclawCore.callSkill;
    } catch {
      // If openclaw-core is provided via config, use that
      if (config.options?.callSkill && typeof config.options.callSkill === 'function') {
        this.callSkill = config.options.callSkill as CallSkillFn;
      } else {
        console.warn('[OpenClawAdapter] openclaw-core not available. Provide callSkill via config.options.callSkill');
        this.ready = false;
        return;
      }
    }

    this.ready = true;
  }

  async executeAgent(
    agentId: string,
    payload: AgentPayload,
    context: AgentContext
  ): Promise<AgentResult> {
    this.ensureReady();

    if (!this.callSkill) {
      return this.errorResult('NO_CALLSKILL', 'callSkill function is not available', false);
    }

    const startTime = Date.now();

    try {
      // Translate universal payload -> OpenClaw callSkill format
      const openclawParams: Record<string, unknown> = {
        action: payload.action,
        ...payload.params,
      };

      // Include handoff context if present (preserves existing handoff protocol)
      if (payload.handoff) {
        openclawParams.handoff = {
          handoffId: payload.handoff.handoffId,
          sourceAgent: payload.handoff.sourceAgent,
          targetAgent: payload.handoff.targetAgent,
          taskType: payload.handoff.taskType,
          payload: {
            instruction: payload.handoff.instruction,
            context: payload.handoff.context,
            constraints: payload.handoff.constraints,
            expectedOutput: payload.handoff.expectedOutput,
          },
          metadata: payload.handoff.metadata,
        };
      }

      // Include blackboard snapshot if present
      if (payload.blackboardSnapshot) {
        openclawParams.context = {
          ...(openclawParams.context as Record<string, unknown> || {}),
          blackboardSnapshot: payload.blackboardSnapshot,
        };
      }

      // Call the OpenClaw skill
      const result = await this.callSkill(agentId, openclawParams);

      // Translate OpenClaw result -> universal AgentResult
      return {
        success: result.success,
        data: result.data,
        error: result.error ? {
          code: result.error.code,
          message: result.error.message,
          recoverable: result.error.recoverable,
          suggestedAction: result.error.suggestedAction,
        } : undefined,
        metadata: {
          adapter: this.name,
          executionTimeMs: Date.now() - startTime,
        },
      };
    } catch (error) {
      return this.errorResult(
        'OPENCLAW_ERROR',
        error instanceof Error ? error.message : 'OpenClaw skill execution failed',
        true,
        error
      );
    }
  }
}
