/**
 * CrewAI Adapter
 * 
 * Allows CrewAI agents and crews to plug into the SwarmOrchestrator.
 * CrewAI uses a role-based agent model with tools, so this adapter
 * maps task payloads to CrewAI's Task/Agent execution model.
 * 
 * Usage:
 *   const adapter = new CrewAIAdapter();
 *   adapter.registerAgent("researcher", myCrewAIAgent);
 *   adapter.registerCrew("analysis_crew", myCrew);
 *   await registry.addAdapter(adapter);
 * 
 * Then in the orchestrator:
 *   delegateTask({ targetAgent: "crewai:researcher", ... })
 *   spawnParallel({ agentType: "crewai:analysis_crew", ... })
 * 
 * @module CrewAIAdapter
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

/**
 * CrewAI-compatible agent interface
 */
export interface CrewAIAgent {
  role: string;
  goal: string;
  backstory?: string;
  /** Execute a task with this agent */
  execute?: (task: string, context?: Record<string, unknown>) => Promise<string>;
  /** Tools available to this agent */
  tools?: Array<{ name: string; description: string }>;
}

/**
 * CrewAI-compatible crew interface
 */
export interface CrewAICrew {
  agents: CrewAIAgent[];
  /** Kick off the crew with a set of inputs */
  kickoff?: (inputs?: Record<string, unknown>) => Promise<unknown>;
  /** Run with a specific task description */
  run?: (task: string) => Promise<unknown>;
}

export class CrewAIAdapter extends BaseAdapter {
  readonly name = 'crewai';
  readonly version = '1.0.0';
  private agents: Map<string, CrewAIAgent> = new Map();
  private crews: Map<string, CrewAICrew> = new Map();

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

  /**
   * Register a single CrewAI agent
   */
  registerAgent(
    agentId: string,
    agent: CrewAIAgent,
    metadata?: { description?: string; capabilities?: string[] }
  ): void {
    this.agents.set(agentId, agent);
    this.registerLocalAgent({
      id: agentId,
      name: agent.role,
      description: metadata?.description ?? agent.goal,
      capabilities: metadata?.capabilities ?? agent.tools?.map(t => t.name),
      status: 'available',
    });
  }

  /**
   * Register an entire CrewAI crew as a single callable unit
   */
  registerCrew(
    crewId: string,
    crew: CrewAICrew,
    metadata?: { description?: string }
  ): void {
    this.crews.set(crewId, crew);
    this.registerLocalAgent({
      id: crewId,
      name: crewId,
      description: metadata?.description ?? `CrewAI crew with ${crew.agents.length} agents`,
      capabilities: crew.agents.map(a => a.role),
      status: 'available',
    });
  }

  async executeAgent(
    agentId: string,
    payload: AgentPayload,
    context: AgentContext
  ): Promise<AgentResult> {
    this.ensureReady();

    const startTime = Date.now();

    // Check if it's a crew first
    const crew = this.crews.get(agentId);
    if (crew) {
      return this.executeCrew(crew, payload, startTime);
    }

    // Then check individual agents
    const agent = this.agents.get(agentId);
    if (!agent) {
      return this.errorResult(
        'AGENT_NOT_FOUND',
        `CrewAI agent/crew "${agentId}" is not registered`,
        false
      );
    }

    return this.executeSingleAgent(agent, payload, context, startTime);
  }

  private async executeSingleAgent(
    agent: CrewAIAgent,
    payload: AgentPayload,
    context: AgentContext,
    startTime: number
  ): Promise<AgentResult> {
    try {
      if (!agent.execute) {
        return this.errorResult('NO_EXECUTE', `CrewAI agent "${agent.role}" has no execute method`, false);
      }

      const task = this.buildTask(payload);
      const taskContext: Record<string, unknown> = {
        agentId: context.agentId,
        taskId: context.taskId,
        ...(payload.blackboardSnapshot ? { shared_state: payload.blackboardSnapshot } : {}),
      };

      const result = await agent.execute(task, taskContext);

      return this.successResult({
        response: result,
        agentRole: agent.role,
      }, Date.now() - startTime);
    } catch (error) {
      return this.errorResult(
        'CREWAI_ERROR',
        error instanceof Error ? error.message : 'CrewAI agent execution failed',
        true,
        error
      );
    }
  }

  private async executeCrew(
    crew: CrewAICrew,
    payload: AgentPayload,
    startTime: number
  ): Promise<AgentResult> {
    try {
      let result: unknown;

      if (crew.kickoff) {
        const inputs: Record<string, unknown> = {
          ...payload.params,
        };
        if (payload.handoff) {
          inputs.task = payload.handoff.instruction;
          inputs.context = payload.handoff.context;
        }
        result = await crew.kickoff(inputs);
      } else if (crew.run) {
        result = await crew.run(this.buildTask(payload));
      } else {
        return this.errorResult('NO_METHOD', 'CrewAI crew has no kickoff or run method', false);
      }

      return this.successResult({
        crewResult: result,
        agentCount: crew.agents.length,
      }, Date.now() - startTime);
    } catch (error) {
      return this.errorResult(
        'CREWAI_ERROR',
        error instanceof Error ? error.message : 'CrewAI crew execution failed',
        true,
        error
      );
    }
  }

  private buildTask(payload: AgentPayload): string {
    if (payload.handoff?.instruction) {
      let task = payload.handoff.instruction;
      if (payload.handoff.constraints?.length) {
        task += `\n\nConstraints:\n${payload.handoff.constraints.map(c => `- ${c}`).join('\n')}`;
      }
      if (payload.handoff.expectedOutput) {
        task += `\n\nExpected Output: ${payload.handoff.expectedOutput}`;
      }
      if (payload.handoff.context) {
        task += `\n\nContext: ${JSON.stringify(payload.handoff.context)}`;
      }
      return task;
    }
    return JSON.stringify(payload.params);
  }
}
