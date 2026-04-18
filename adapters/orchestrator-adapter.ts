/**
 * Orchestrator Adapter — Wrap a child SwarmOrchestrator as an agent
 *
 * This adapter enables hierarchical multi-orchestrator coordination.
 * A parent SwarmOrchestrator treats a child SwarmOrchestrator as just
 * another agent via the adapter system. Each child has its own
 * LockedBlackboard with its own filesystem mutex, so the propose →
 * validate → commit pattern prevents overwrites at every level.
 *
 * Usage:
 *   const child = new SwarmOrchestrator('./boards/child-project', childRegistry);
 *   const adapter = new OrchestratorAdapter();
 *   adapter.registerOrchestrator('child-team', child, {
 *     description: 'Backend team orchestrator',
 *   });
 *
 *   // Parent orchestrator delegates to the child as a normal agent
 *   await parentOrchestrator.addAdapter(adapter);
 *   await parentOrchestrator.execute('delegate_task', {
 *     targetAgent: 'orchestrator:child-team',
 *     taskPayload: { instruction: 'Refactor the auth module' },
 *   }, { agentId: 'root' });
 *
 * The child orchestrator receives the task, decomposes it across its own
 * agents, and returns the aggregated result. The parent sees it as one
 * atomic response — the hierarchy is transparent.
 *
 * @module OrchestratorAdapter
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
import type { SkillResult } from '../lib/orchestrator-types';

/**
 * Configuration for a child orchestrator registered with this adapter.
 */
export interface ChildOrchestratorConfig {
  /** Human-readable description of the child orchestrator's domain */
  description?: string;
  /** Capabilities the child orchestrator advertises */
  capabilities?: string[];
  /** Default agent in the child swarm to target (if not specified in payload) */
  defaultTargetAgent?: string;
  /** Timeout for child orchestrator execution in ms (default: 120_000) */
  timeout?: number;
}

/**
 * Minimal interface for a SwarmOrchestrator. We don't import the concrete
 * class to avoid circular dependencies — adapters stay self-contained.
 */
export interface OrchestratorLike {
  name: string;
  execute(
    action: string,
    params: Record<string, unknown>,
    context: { agentId: string; taskId?: string; sessionId?: string }
  ): Promise<SkillResult>;
}

/**
 * Snapshot of a child orchestrator's internal state, surfaced to the
 * parent for unified visibility.
 */
export interface ChildOrchestratorState {
  /** The registered orchestrator id */
  orchestratorId: string;
  /** Whether the child is currently processing a task */
  busy: boolean;
  /** The swarm state snapshot (agents, blackboard, tasks) */
  swarmState: unknown;
  /** Timestamp of the last query */
  queriedAt: string;
}

interface RegisteredChild {
  orchestrator: OrchestratorLike;
  config: ChildOrchestratorConfig;
  busy: boolean;
}

export class OrchestratorAdapter extends BaseAdapter {
  readonly name = 'orchestrator';
  readonly version = '1.0.0';

  private children: Map<string, RegisteredChild> = new Map();

  get capabilities(): AdapterCapabilities {
    return {
      streaming: false,
      parallel: true,
      bidirectional: false,
      discovery: true,
      authentication: false,
      statefulSessions: true,
    };
  }

  /**
   * Register a child SwarmOrchestrator as an agent.
   * The child keeps its own blackboard, adapters, and lock — full isolation.
   */
  registerOrchestrator(
    orchestratorId: string,
    orchestrator: OrchestratorLike,
    config?: ChildOrchestratorConfig
  ): void {
    if (!orchestratorId || typeof orchestratorId !== 'string') {
      throw new Error('orchestratorId must be a non-empty string');
    }
    if (!orchestrator || typeof orchestrator.execute !== 'function') {
      throw new Error('orchestrator must implement execute()');
    }

    const childConfig: ChildOrchestratorConfig = {
      description: config?.description ?? `Child orchestrator: ${orchestratorId}`,
      capabilities: config?.capabilities ?? ['orchestration', 'delegation', 'parallel'],
      defaultTargetAgent: config?.defaultTargetAgent,
      timeout: config?.timeout ?? 120_000,
    };

    this.children.set(orchestratorId, {
      orchestrator,
      config: childConfig,
      busy: false,
    });

    this.registerLocalAgent({
      id: orchestratorId,
      name: orchestrator.name ?? orchestratorId,
      description: childConfig.description,
      capabilities: childConfig.capabilities,
      status: 'available',
      metadata: {
        type: 'orchestrator',
        timeout: childConfig.timeout,
        defaultTargetAgent: childConfig.defaultTargetAgent,
      },
    });
  }

  /**
   * Remove a child orchestrator from this adapter.
   */
  removeOrchestrator(orchestratorId: string): boolean {
    const removed = this.children.delete(orchestratorId);
    if (removed) {
      this.unregisterAgent(orchestratorId);
    }
    return removed;
  }

  /**
   * Execute a task on a child orchestrator.
   *
   * The payload is translated into a `delegate_task` call on the child.
   * If `handoff.targetAgent` is set, it becomes the target within the child
   * swarm. Otherwise, the child's `defaultTargetAgent` is used, or the
   * child decides its own routing.
   */
  async executeAgent(
    agentId: string,
    payload: AgentPayload,
    context: AgentContext
  ): Promise<AgentResult> {
    this.ensureReady();

    const child = this.children.get(agentId);
    if (!child) {
      return this.errorResult(
        'ORCHESTRATOR_NOT_FOUND',
        `Child orchestrator "${agentId}" is not registered. Use registerOrchestrator().`,
        false
      );
    }

    const startTime = Date.now();
    child.busy = true;

    // Update agent status
    const agentInfo = this.registeredAgents.get(agentId);
    if (agentInfo) agentInfo.status = 'busy';

    try {
      const instruction = payload.handoff?.instruction
        ?? (payload.params?.instruction as string)
        ?? JSON.stringify(payload.params);

      // Determine the target agent within the child swarm
      const innerTarget = payload.handoff?.targetAgent
        ?? child.config.defaultTargetAgent
        ?? 'orchestrator';

      const childParams: Record<string, unknown> = {
        targetAgent: innerTarget,
        taskPayload: {
          instruction,
          context: payload.handoff?.context ?? payload.params?.context,
          constraints: payload.handoff?.constraints ?? payload.params?.constraints,
          expectedOutput: payload.handoff?.expectedOutput ?? payload.params?.expectedOutput,
        },
        timeout: child.config.timeout,
      };

      // Forward blackboard snapshot if provided (cross-level context sharing)
      if (payload.blackboardSnapshot) {
        childParams.parentBlackboardSnapshot = payload.blackboardSnapshot;
      }

      const childContext = {
        agentId: context.agentId,
        taskId: context.taskId,
        sessionId: context.sessionId,
      };

      // Execute on the child orchestrator with timeout
      const result = await Promise.race([
        child.orchestrator.execute('delegate_task', childParams, childContext),
        this.timeoutAfter(child.config.timeout ?? 120_000),
      ]);

      const elapsed = Date.now() - startTime;

      if (!result.success) {
        return this.errorResult(
          result.error?.code ?? 'CHILD_EXECUTION_FAILED',
          result.error?.message ?? 'Child orchestrator returned failure',
          result.error?.recoverable ?? true,
          result.error
        );
      }

      return this.successResult(
        {
          orchestratorId: agentId,
          childResult: result.data,
          hierarchy: true,
        },
        elapsed
      );
    } catch (error) {
      const elapsed = Date.now() - startTime;
      if (error instanceof Error && error.message === 'ORCHESTRATOR_TIMEOUT') {
        return this.errorResult(
          'CHILD_TIMEOUT',
          `Child orchestrator "${agentId}" timed out after ${child.config.timeout}ms`,
          true
        );
      }
      return this.errorResult(
        'CHILD_EXECUTION_ERROR',
        error instanceof Error ? error.message : 'Child orchestrator execution failed',
        true,
        error
      );
    } finally {
      child.busy = false;
      const agentInfo2 = this.registeredAgents.get(agentId);
      if (agentInfo2) agentInfo2.status = 'available';
    }
  }

  /**
   * Query the internal state of a child orchestrator.
   * Returns agents, blackboard snapshot, and tasks from the child swarm.
   * The parent can use this for unified visibility across the hierarchy.
   */
  async queryChildState(
    orchestratorId: string,
    scope: 'all' | 'agents' | 'blackboard' | 'tasks' = 'all'
  ): Promise<ChildOrchestratorState | null> {
    const child = this.children.get(orchestratorId);
    if (!child) return null;

    const result = await child.orchestrator.execute(
      'query_swarm_state',
      { scope },
      { agentId: 'parent-orchestrator' }
    );

    return {
      orchestratorId,
      busy: child.busy,
      swarmState: result.success ? result.data : null,
      queriedAt: new Date().toISOString(),
    };
  }

  /**
   * Query state of all registered child orchestrators.
   * This is the foundation for the unified ControlPlane view.
   */
  async queryAllChildStates(
    scope: 'all' | 'agents' | 'blackboard' | 'tasks' = 'all'
  ): Promise<ChildOrchestratorState[]> {
    const entries = Array.from(this.children.keys());
    const results = await Promise.all(
      entries.map(id => this.queryChildState(id, scope))
    );
    return results.filter((s): s is ChildOrchestratorState => s !== null);
  }

  /**
   * Get the list of registered child orchestrator IDs.
   */
  listOrchestrators(): string[] {
    return Array.from(this.children.keys());
  }

  /**
   * Check if a specific child orchestrator is currently busy.
   */
  isChildBusy(orchestratorId: string): boolean {
    return this.children.get(orchestratorId)?.busy ?? false;
  }

  async shutdown(): Promise<void> {
    this.children.clear();
    await super.shutdown();
  }

  private timeoutAfter(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error('ORCHESTRATOR_TIMEOUT')), ms);
    });
  }
}
