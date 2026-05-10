/**
 * SwarmOrchestrator - Multi-Agent Orchestration Framework for TypeScript/Node.js
 *
 * Connects 12 AI frameworks (LangChain, AutoGen, CrewAI, OpenAI Assistants, LlamaIndex,
 * Semantic Kernel, Haystack, DSPy, Agno, MCP, OpenClaw) via a shared atomic blackboard,
 * FSM governance, per-agent token budget enforcement, and HMAC audit trails.
 * OpenClaw skill interface is implemented for backward compatibility.
 *
 * @module SwarmOrchestrator
 * @version 4.0.17
 * @license MIT
 */

import { mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { AdapterRegistry } from './adapters/adapter-registry';
import { InputSanitizer, SecureSwarmGateway, PromptInjectionShield } from './security';
import { FileBackend } from './lib/blackboard-backend';
import type { BlackboardBackend } from './lib/blackboard-backend';
import { ConsistentBackend } from './lib/consistency';
import { QualityGateAgent } from './lib/blackboard-validator';
import { Logger } from './lib/logger';
import {
  ValidationError,
  TimeoutError as NetworkAITimeoutError,
} from './lib/errors';
import type { ValidationConfig, AIReviewCallback } from './lib/blackboard-validator';
import type { IAgentAdapter, AgentPayload, AgentContext, AdapterConfig } from './types/agent-adapter';

// Extracted modules (Phase 1.1 — split god-file)
import { SharedBlackboard } from './lib/shared-blackboard';
import { AuthGuardian } from './lib/auth-guardian';
import { ExplainabilityTracer } from './lib/explainability';
import type { DecisionCard, DecisionFactor } from './lib/explainability';
import { OrchestratorEventBus } from './lib/event-bus';
import { AgentConversationLog } from './lib/agent-conversation';
import { OTelBridge } from './lib/otel-bridge';
import { createOrchestratorMetrics } from './lib/metrics';
import type { MetricsRegistry } from './lib/metrics';
import { CostHeatmap } from './lib/cost-heatmap';
import { AnomalyDetector } from './lib/anomaly-detector';
import { OrchestratorLifecycleHooks } from './lib/lifecycle-hooks';
import { TaskDecomposer } from './lib/task-decomposer';
import {
  CONFIG,
} from './lib/orchestrator-types';
import type {
  OpenClawSkill,
  SkillContext,
  SkillResult,
  TaskPayload,
  HandoffMessage,
  PermissionGrant,
  SwarmState,
  AgentStatus,
  TaskRecord,
  BlackboardEntry,
  ActiveGrant,
  ResourceProfile,
  AgentTrustConfig,
  NamedBlackboardOptions,
  ParallelTask,
  ParallelExecutionResult,
  SynthesisStrategy,
} from './lib/orchestrator-types';

const log = Logger.create('SwarmOrchestrator');

// Types, interfaces, CONFIG, and default profiles are now in ./lib/orchestrator-types.ts
// SharedBlackboard is now in ./lib/shared-blackboard.ts
// AuthGuardian is now in ./lib/auth-guardian.ts
// TaskDecomposer is now in ./lib/task-decomposer.ts


// ============================================================================
// SWARM ORCHESTRATOR - MAIN SKILL IMPLEMENTATION
// ============================================================================

/**
 * The main orchestrator class — coordinates agents, permissions, blackboard,
 * quality gates, and adapter routing in a single entry point.
 *
 * Implements the OpenClaw skill interface for backward compatibility and
 * can also be used standalone via {@link createSwarmOrchestrator}.
 *
 * @example
 * ```typescript
 * import { createSwarmOrchestrator, LangChainAdapter } from 'network-ai';
 *
 * const orchestrator = createSwarmOrchestrator({
 *   adapters: [{ adapter: new LangChainAdapter() }],
 *   trustLevels: [{ agentId: 'my-agent', trustLevel: 0.8 }],
 * });
 *
 * const result = await orchestrator.execute('delegate_task', {
 *   targetAgent: 'my-agent',
 *   taskPayload: { instruction: 'Summarize the quarterly report' },
 * }, { agentId: 'orchestrator' });
 * ```
 */
export class SwarmOrchestrator implements OpenClawSkill {
  name = 'SwarmOrchestrator';
  version = '3.1.0';

  private blackboard: SharedBlackboard;
  private authGuardian: AuthGuardian;
  private taskDecomposer: TaskDecomposer;
  private agentRegistry: Map<string, AgentStatus> = new Map();
  private gateway: SecureSwarmGateway;
  private qualityGate: QualityGateAgent;
  private injectionShield: PromptInjectionShield;
  public readonly tracer: ExplainabilityTracer;
  public readonly eventBus: OrchestratorEventBus;
  public readonly conversationLog: AgentConversationLog;
  public readonly otel: OTelBridge;
  public readonly metrics: ReturnType<typeof createOrchestratorMetrics>;
  public readonly heatmap: CostHeatmap;
  public readonly anomalyDetector: AnomalyDetector;
  public readonly lifecycleHooks: OrchestratorLifecycleHooks;

  /** Named isolated blackboards, keyed by board name */
  private namedBlackboards: Map<string, SharedBlackboard> = new Map();
  /** Root workspace path -- used as the parent for named board subdirectories */
  private _workspacePath: string;

  /** The adapter registry -- routes requests to the right agent framework */
  public readonly adapters: AdapterRegistry;

  constructor(
    workspacePath: string = process.cwd(),
    adapterRegistry?: AdapterRegistry,
    options?: {
      trustLevels?: AgentTrustConfig[];
      resourceProfiles?: Record<string, ResourceProfile>;
      validationConfig?: Partial<ValidationConfig>;
      qualityThreshold?: number;
      aiReviewCallback?: AIReviewCallback;
    }
  ) {
    if (workspacePath !== undefined && typeof workspacePath !== 'string') {
      throw new ValidationError('workspacePath must be a string');
    }
    if (workspacePath !== undefined && workspacePath.trim() === '') {
      throw new ValidationError('workspacePath must not be empty');
    }
    this._workspacePath = workspacePath;
    this.blackboard = new SharedBlackboard(workspacePath);
    this.authGuardian = new AuthGuardian({
      trustLevels: options?.trustLevels,
      resourceProfiles: options?.resourceProfiles,
    });
    this.adapters = adapterRegistry ?? new AdapterRegistry();
    this.taskDecomposer = new TaskDecomposer(this.blackboard, this.authGuardian, this.adapters);
    this.gateway = new SecureSwarmGateway();
    this.qualityGate = new QualityGateAgent({
      validationConfig: options?.validationConfig,
      qualityThreshold: options?.qualityThreshold,
      aiReviewCallback: options?.aiReviewCallback,
    });
    this.injectionShield = new PromptInjectionShield();
    this.tracer = new ExplainabilityTracer();
    this.eventBus = new OrchestratorEventBus({ snapshotInterval: 100 });
    this.conversationLog = new AgentConversationLog();
    this.otel = new OTelBridge();
    this.metrics = createOrchestratorMetrics();
    this.heatmap = new CostHeatmap();
    this.anomalyDetector = new AnomalyDetector();
    this.lifecycleHooks = new OrchestratorLifecycleHooks();

    // Register the orchestrator agent on the blackboard with full access
    this.blackboard.registerAgent('orchestrator', 'system-orchestrator-token', ['*']);
  }

  /**
   * Add an agent framework adapter (LangChain, AutoGen, CrewAI, MCP, custom, etc.)
   * This is the plug-and-play entry point.
   */
  async addAdapter(adapter: IAgentAdapter, config: AdapterConfig = {}): Promise<void> {
    if (!adapter || typeof adapter !== 'object') {
      throw new ValidationError('adapter is required and must be an object');
    }
    if (typeof adapter.name !== 'string' || adapter.name.trim() === '') {
      throw new ValidationError('adapter.name must be a non-empty string');
    }
    await this.adapters.addAdapter(adapter, config);
  }

  /**
   * Main entry point for the skill.
   * Now integrates SecureSwarmGateway: every request flows through
   * input sanitization, rate limiting, and agent ID validation.
   */
  async execute(action: string, params: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    if (!action || typeof action !== 'string') {
      return {
        success: false,
        error: {
          code: 'INVALID_PARAMS',
          message: 'action is required and must be a non-empty string',
          recoverable: false,
        },
      };
    }
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return {
        success: false,
        error: {
          code: 'INVALID_PARAMS',
          message: 'params is required and must be a plain object',
          recoverable: false,
        },
      };
    }
    if (!context || typeof context !== 'object' || !context.agentId || typeof context.agentId !== 'string') {
      return {
        success: false,
        error: {
          code: 'INVALID_PARAMS',
          message: 'context is required and must include a non-empty agentId string',
          recoverable: false,
        },
      };
    }
    const traceId = randomUUID();

    // P0: Route through SecureSwarmGateway -- sanitization + rate limiting
    const gatewayResult = await this.gateway.handleSecureRequest(
      context.agentId,
      action,
      params,
    );

    if (!gatewayResult.allowed) {
      return {
        success: false,
        error: {
          code: 'GATEWAY_DENIED',
          message: `Security gateway denied request: ${gatewayResult.reason}`,
          recoverable: true,
          suggestedAction: 'Check agent ID, rate limits, or input format',
        },
      };
    }

    // Use sanitized params from gateway
    const safeParams = gatewayResult.sanitizedParams ?? params;

    if (CONFIG.enableTracing) {
      try {
        this.blackboard.write(`trace:${traceId}`, {
          action,
          startTime: new Date().toISOString(),
        }, context.agentId, undefined, 'system-orchestrator-token');
      } catch {
        // Non-fatal -- tracing failure shouldn't block execution
      }
    }

    try {
      switch (action) {
        case 'delegate_task':
          return await this.delegateTask(safeParams, context);

        case 'query_swarm_state':
          return await this.querySwarmState(safeParams, context);

        case 'spawn_parallel_agents':
          return await this.spawnParallelAgents(safeParams, context);

        case 'request_permission':
          return await this.handlePermissionRequest(safeParams, context);

        case 'update_blackboard':
          return await this.handleBlackboardUpdate(safeParams, context);

        case 'quality_gate_status':
          return this.handleQualityGateStatus();

        case 'review_quarantine':
          return this.handleQuarantineReview(safeParams);

        default:
          return {
            success: false,
            error: {
              code: 'UNKNOWN_ACTION',
              message: `Unknown action: ${action}`,
              recoverable: false,
            },
          };
      }
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          recoverable: true,
          trace: { traceId, action },
        },
      };
    }
  }

  // -------------------------------------------------------------------------
  // CAPABILITY: delegate_task
  // -------------------------------------------------------------------------

  private async delegateTask(params: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const targetAgent = params.targetAgent as string;
    const taskPayload = params.taskPayload as TaskPayload;
    const priority = (params.priority as string) ?? 'normal';
    const timeout = (params.timeout as number) ?? CONFIG.defaultTimeout;
    const requiresAuth = (params.requiresAuth as boolean) ?? false;
    const resourceType = (params.resourceType as string) ?? 'EXTERNAL_SERVICE';

    const delegationTraceId = this.tracer.record({
      source: 'SwarmOrchestrator',
      decision: 'delegation_start',
      outcome: 'initiated',
      agentId: context.agentId,
      factors: [
        { name: 'targetAgent', value: targetAgent },
        { name: 'priority', value: priority },
        { name: 'requiresAuth', value: requiresAuth },
        { name: 'timeout', value: timeout },
      ],
    });

    this.eventBus.publish('orchestrator', 'delegation_start', 'info', {
      targetAgent, priority, requiresAuth, timeout, traceId: delegationTraceId,
    }, context.agentId, delegationTraceId);
    this.metrics.delegationsTotal.inc({ agent: targetAgent });
    const delegationStartMs = Date.now();

    // Orchestrator-level beforeSpawn hook
    const spawnCtx = await this.lifecycleHooks.runBeforeSpawn({
      agentId: targetAgent,
      instruction: taskPayload.instruction,
      priority,
      requiresAuth,
      metadata: { timeout, resourceType },
      aborted: false,
    });
    if (spawnCtx.aborted) {
      return {
        success: false,
        error: {
          code: 'LIFECYCLE_ABORTED',
          message: spawnCtx.abortReason ?? 'Aborted by beforeSpawn hook',
          recoverable: true,
        },
      };
    }

    // Check permission wall if required -- now returns bound restrictions
    let grantToken: string | null = null;
    if (requiresAuth) {
      const authResult = await this.authGuardian.requestPermission(
        context.agentId,
        resourceType,
        `Delegating task to ${targetAgent}: ${taskPayload.instruction}`,
        'delegate'
      );

      if (!authResult.granted) {
        this.tracer.record({
          source: 'AuthGuardian', decision: 'permission_check', outcome: 'denied',
          agentId: context.agentId, parentTraceId: delegationTraceId,
          factors: [{ name: 'reason', value: authResult.reason }],
        });
        this.eventBus.publish('auth', 'permission_denied', 'warn', {
          reason: authResult.reason, resourceType,
        }, context.agentId, delegationTraceId);
        this.metrics.permissionDenials.inc({ agent: context.agentId });
        return {
          success: false,
          error: {
            code: 'AUTH_DENIED',
            message: `Permission denied: ${authResult.reason}`,
            recoverable: true,
            suggestedAction: 'Provide more specific justification or narrow scope',
          },
        };
      }

      grantToken = authResult.grantToken;

      // Enforce restrictions at point of use
      if (grantToken) {
        const restrictionViolation = this.authGuardian.enforceRestrictions(grantToken, {
          type: 'execute',
        });
        if (restrictionViolation) {
          return {
            success: false,
            error: {
              code: 'RESTRICTION_VIOLATED',
              message: restrictionViolation,
              recoverable: true,
              suggestedAction: 'Request a grant with broader scope',
            },
          };
        }
      }
    }

    // Check blackboard for existing work
    const cacheKey = `task:${targetAgent}:${JSON.stringify(taskPayload).slice(0, 50)}`;
    const existingWork = this.blackboard.read(cacheKey);
    if (existingWork) {
      return {
        success: true,
        data: {
          taskId: 'cached',
          status: 'completed',
          result: existingWork.value,
          agentTrace: ['blackboard-cache'],
          fromCache: true,
        },
      };
    }

    // Build handoff message
    const handoff: HandoffMessage = {
      handoffId: randomUUID(),
      sourceAgent: context.agentId,
      targetAgent,
      taskType: 'delegate',
      payload: taskPayload,
      metadata: {
        priority: this.priorityToNumber(priority),
        deadline: Date.now() + timeout,
        parentTaskId: context.taskId ?? null,
      },
    };

    // Execute via adapter registry (routes to the right framework)
    try {
      // Sanitize instruction before sending to adapter
      let sanitizedInstruction = taskPayload.instruction;
      try {
        sanitizedInstruction = InputSanitizer.sanitizeString(taskPayload.instruction, 10000);
      } catch { /* use original if sanitization fails */ }

      // Prompt injection detection
      const injectionResult = this.injectionShield.analyze(sanitizedInstruction);
      if (!injectionResult.safe) {
        this.tracer.record({
          source: 'PromptInjectionShield', decision: 'injection_scan', outcome: 'blocked',
          agentId: context.agentId, parentTraceId: delegationTraceId,
          factors: [
            { name: 'score', value: injectionResult.score },
            { name: 'matchedRules', value: injectionResult.matchedRules },
          ],
        });
        this.eventBus.publish('injection', 'blocked', 'error', {
          score: injectionResult.score, rules: injectionResult.matchedRules,
        }, context.agentId, delegationTraceId);
        this.metrics.injectionBlocks.inc({ agent: context.agentId });
        return {
          success: false,
          error: {
            code: 'PROMPT_INJECTION_BLOCKED',
            message: `Prompt injection detected (score=${injectionResult.score.toFixed(2)}, rules: ${injectionResult.matchedRules.join(', ')})`,
            recoverable: true,
            suggestedAction: 'Rephrase the instruction to remove injection patterns',
          },
        };
      }

      // P1: Namespace-scoped snapshot -- target agent only sees keys it's allowed to see
      const scopedSnapshot = this.blackboard.getScopedSnapshot(targetAgent);

      const agentPayload: AgentPayload = {
        action: 'execute',
        params: {},
        handoff: {
          handoffId: handoff.handoffId,
          sourceAgent: handoff.sourceAgent,
          targetAgent: handoff.targetAgent,
          taskType: handoff.taskType,
          instruction: sanitizedInstruction,
          context: taskPayload.context,
          constraints: taskPayload.constraints,
          expectedOutput: taskPayload.expectedOutput,
          metadata: handoff.metadata as unknown as Record<string, unknown>,
        },
        blackboardSnapshot: scopedSnapshot as Record<string, unknown>,
      };

      const agentContext: AgentContext = {
        agentId: context.agentId,
        taskId: context.taskId,
        sessionId: context.sessionId,
      };

      const otelSpan = this.otel.startDelegation(context.agentId, targetAgent, handoff.handoffId);
      const result = await Promise.race([
        this.adapters.executeAgent(targetAgent, agentPayload, agentContext),
        this.timeoutPromise(timeout),
      ]);
      otelSpan.setAttribute('agent.result.success', result.success);
      otelSpan.end();

      // P1: Sanitize adapter output before caching
      let sanitizedResult = result;
      try {
        sanitizedResult = InputSanitizer.sanitizeObject(result) as typeof result;
      } catch { /* use raw if sanitization fails */ }

      // Quality gate: validate result before committing to blackboard
      const gateResult = await this.qualityGate.gate(cacheKey, sanitizedResult, targetAgent, {
        taskInstruction: taskPayload.instruction,
        expectedOutput: taskPayload.expectedOutput,
      });

      this.tracer.record({
        source: 'QualityGateAgent', decision: 'quality_gate', outcome: gateResult.decision,
        agentId: targetAgent, parentTraceId: delegationTraceId,
        factors: [
          { name: 'score', value: gateResult.validation.score },
          { name: 'issueCount', value: gateResult.validation.issues.length },
        ],
      });
      this.eventBus.publish('quality', gateResult.decision, gateResult.decision === 'reject' ? 'warn' : 'info', {
        score: gateResult.validation.score, issueCount: gateResult.validation.issues.length,
      }, targetAgent, delegationTraceId);

      if (gateResult.decision === 'reject') {
        this.metrics.qualityRejections.inc({ agent: targetAgent });
        return {
          success: false,
          error: {
            code: 'QUALITY_REJECTED',
            message: `Result from ${targetAgent} failed quality validation: ${gateResult.validation.issues.filter(i => i.severity === 'error').map(i => i.message).join('; ')}`,
            recoverable: gateResult.validation.recoverable,
            suggestedAction: gateResult.validation.issues.find(i => i.suggestion)?.suggestion,
          },
        };
      }

      if (gateResult.decision === 'quarantine') {
        // Still return the result but flag it
        return {
          success: true,
          data: {
            taskId: handoff.handoffId,
            status: 'quarantined',
            result: sanitizedResult,
            agentTrace: [context.agentId, targetAgent],
            qualityGate: {
              decision: 'quarantine',
              quarantineKey: gateResult.quarantineKey,
              score: gateResult.validation.score,
              issues: gateResult.validation.issues,
              reviewNotes: gateResult.reviewNotes,
            },
          },
        };
      }

      // Approved -- cache result
      this.blackboard.write(cacheKey, sanitizedResult, context.agentId, 1800, 'system-orchestrator-token'); // 30 min TTL
      this.metrics.delegationDurationMs.observe({ agent: targetAgent }, Date.now() - delegationStartMs);
      this.heatmap.record(targetAgent, {
        durationMs: Date.now() - delegationStartMs,
        inputTokens: 0, outputTokens: 0, success: true,
      });
      this.anomalyDetector.observe(targetAgent, {
        latencyMs: Date.now() - delegationStartMs, tokens: 0, success: true,
      });

      const resultMeta = (sanitizedResult as unknown as Record<string, unknown>)?.metadata as Record<string, unknown> | undefined;
      this.conversationLog.recordTurn(targetAgent, {
        instruction: taskPayload.instruction,
        result: JSON.stringify(sanitizedResult).slice(0, 2000),
        success: true,
        tokensUsed: resultMeta?.tokensUsed as number | undefined,
        executionTimeMs: resultMeta?.executionTimeMs as number | undefined,
        adapter: resultMeta?.adapter as string | undefined,
        qualityDecision: gateResult.decision,
        correlationId: delegationTraceId,
        sourceAgent: context.agentId,
      });

      // Orchestrator-level afterComplete hook
      await this.lifecycleHooks.runAfterComplete({
        agentId: targetAgent,
        instruction: taskPayload.instruction,
        result: sanitizedResult,
        durationMs: Date.now() - delegationStartMs,
        tokensUsed: (resultMeta?.tokensUsed as number) ?? 0,
        metadata: { qualityDecision: gateResult.decision },
      });

      return {
        success: true,
        data: {
          taskId: handoff.handoffId,
          status: 'completed',
          result: sanitizedResult,
          agentTrace: [context.agentId, targetAgent],
          qualityGate: {
            decision: 'approve',
            score: gateResult.validation.score,
          },
        },
      };
    } catch (error) {
      this.metrics.delegationErrors.inc({ agent: targetAgent });
      this.conversationLog.recordTurn(targetAgent, {
        instruction: taskPayload.instruction,
        success: false,
        errorCode: 'DELEGATION_FAILED',
        correlationId: delegationTraceId,
        sourceAgent: context.agentId,
      });
      this.eventBus.publish('orchestrator', 'delegation_failed', 'error', {
        error: error instanceof Error ? error.message : 'unknown',
      }, targetAgent, delegationTraceId);

      // Orchestrator-level onFailure hook
      const failCtx = await this.lifecycleHooks.runOnFailure({
        agentId: targetAgent,
        instruction: taskPayload.instruction,
        error: error instanceof Error ? error : String(error),
        durationMs: Date.now() - delegationStartMs,
        metadata: {},
        suppress: false,
      });
      if (failCtx.suppress) {
        return { success: true, data: { status: 'suppressed', agentTrace: [context.agentId, targetAgent] } };
      }

      return {
        success: false,
        error: {
          code: 'DELEGATION_FAILED',
          message: error instanceof Error ? error.message : 'Task delegation failed',
          recoverable: true,
        },
      };
    }
  }

  // -------------------------------------------------------------------------
  // CAPABILITY: query_swarm_state
  // -------------------------------------------------------------------------

  private async querySwarmState(params: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const scope = (params.scope as string) ?? 'all';
    const agentFilter = params.agentFilter as string[] | undefined;
    const _includeHistory = (params.includeHistory as boolean) ?? false;

    const state: Partial<SwarmState> = {
      timestamp: new Date().toISOString(),
    };

    if (scope === 'all' || scope === 'agents') {
      let agents = Array.from(this.agentRegistry.values());
      if (agentFilter) {
        agents = agents.filter(a => agentFilter.includes(a.agentId));
      }
      state.activeAgents = agents;
    }

    if (scope === 'all' || scope === 'blackboard') {
      // P1: Namespace-scoped -- agent only sees keys it's allowed to access
      state.blackboardSnapshot = this.blackboard.getScopedSnapshot(context.agentId);
    }

    if (scope === 'all' || scope === 'permissions') {
      state.permissionGrants = this.authGuardian.getActiveGrants();
    }

    if (scope === 'all' || scope === 'tasks') {
      // Extract tasks from scoped blackboard
      const snapshot = this.blackboard.getScopedSnapshot(context.agentId);
      state.pendingTasks = Object.entries(snapshot)
        .filter(([key]) => key.startsWith('task:'))
        .map(([, entry]) => ({
          taskId: entry.key,
          agentId: entry.sourceAgent,
          status: 'in_progress' as const,
          startedAt: entry.timestamp,
          description: String(entry.value),
        }));
    }

    return {
      success: true,
      data: state,
    };
  }

  // -------------------------------------------------------------------------
  // CAPABILITY: spawn_parallel_agents
  // -------------------------------------------------------------------------

  private async spawnParallelAgents(
    params: Record<string, unknown>,
    context: SkillContext
  ): Promise<SkillResult> {
    const tasks = params.tasks as ParallelTask[];
    const synthesisStrategy = (params.synthesisStrategy as SynthesisStrategy) ?? 'merge';

    if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
      return {
        success: false,
        error: {
          code: 'INVALID_PARAMS',
          message: 'Tasks array is required and must not be empty',
          recoverable: false,
        },
      };
    }

    try {
      const result = await this.taskDecomposer.executeParallel(tasks, synthesisStrategy, context);

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'PARALLEL_EXECUTION_FAILED',
          message: error instanceof Error ? error.message : 'Parallel execution failed',
          recoverable: true,
        },
      };
    }
  }

  // -------------------------------------------------------------------------
  // CAPABILITY: request_permission
  // -------------------------------------------------------------------------

  private async handlePermissionRequest(
    params: Record<string, unknown>,
    context: SkillContext
  ): Promise<SkillResult> {
    const resourceType = params.resourceType as string;
    const justification = params.justification as string;
    const scope = params.scope as string | undefined;

    if (!resourceType || !justification) {
      return {
        success: false,
        error: {
          code: 'INVALID_PARAMS',
          message: 'resourceType and justification are required',
          recoverable: false,
        },
      };
    }

    const grant = await this.authGuardian.requestPermission(
      context.agentId,
      resourceType,
      justification,
      scope
    );

    return {
      success: grant.granted,
      data: grant,
    };
  }

  // -------------------------------------------------------------------------
  // CAPABILITY: update_blackboard
  // -------------------------------------------------------------------------

  private async handleBlackboardUpdate(
    params: Record<string, unknown>,
    context: SkillContext
  ): Promise<SkillResult> {
    const key = params.key as string;
    const value = params.value;
    const ttl = params.ttl as number | undefined;

    if (!key || value === undefined) {
      return {
        success: false,
        error: {
          code: 'INVALID_PARAMS',
          message: 'key and value are required',
          recoverable: false,
        },
      };
    }

    const previousValue = this.blackboard.read(key)?.value ?? null;

    // Quality gate: validate before writing to blackboard
    const gateResult = await this.qualityGate.gate(key, value, context.agentId);

    if (gateResult.decision === 'reject') {
      return {
        success: false,
        error: {
          code: 'QUALITY_REJECTED',
          message: `Blackboard write rejected: ${gateResult.validation.issues.filter(i => i.severity === 'error').map(i => i.message).join('; ')}`,
          recoverable: gateResult.validation.recoverable,
          suggestedAction: gateResult.validation.issues.find(i => i.suggestion)?.suggestion,
        },
      };
    }

    if (gateResult.decision === 'quarantine') {
      return {
        success: true,
        data: {
          success: true,
          quarantined: true,
          quarantineKey: gateResult.quarantineKey,
          qualityScore: gateResult.validation.score,
          issues: gateResult.validation.issues,
          previousValue,
        },
      };
    }

    this.blackboard.write(key, value, context.agentId, ttl, 'system-orchestrator-token');

    return {
      success: true,
      data: {
        success: true,
        previousValue,
        qualityScore: gateResult.validation.score,
      },
    };
  }

  // -------------------------------------------------------------------------
  // QUALITY GATE MANAGEMENT
  // -------------------------------------------------------------------------

  /** Returns quality gate metrics and quarantined entries */
  private handleQualityGateStatus(): SkillResult {
    return {
      success: true,
      data: {
        metrics: this.qualityGate.getMetrics(),
        quarantined: this.qualityGate.getQuarantined(),
      },
    };
  }

  /** Approve or reject a quarantined entry */
  private handleQuarantineReview(params: Record<string, unknown>): SkillResult {
    const quarantineId = params.quarantineId as string;
    const decision = params.decision as 'approve' | 'reject';

    if (!quarantineId || !decision) {
      return {
        success: false,
        error: {
          code: 'INVALID_PARAMS',
          message: 'quarantineId and decision ("approve" or "reject") are required',
          recoverable: false,
        },
      };
    }

    let entry: unknown;
    if (decision === 'approve') {
      entry = this.qualityGate.approveQuarantined(quarantineId);
      if (entry) {
        // Write the approved entry to the blackboard
        this.blackboard.write(`approved:${quarantineId}`, entry, 'orchestrator', undefined, 'system-orchestrator-token');
      }
    } else {
      entry = this.qualityGate.rejectQuarantined(quarantineId);
    }

    return {
      success: !!entry,
      data: entry ? { quarantineId, decision, resolved: true } : undefined,
      error: entry ? undefined : {
        code: 'NOT_FOUND',
        message: `Quarantine entry ${quarantineId} not found`,
        recoverable: false,
      },
    };
  }

  /** Expose the quality gate for external configuration */
  public getQualityGate(): QualityGateAgent {
    return this.qualityGate;
  }

  // -------------------------------------------------------------------------
  // NAMED MULTI-BLACKBOARD API (Phase 5)
  // -------------------------------------------------------------------------

  /**
   * Get or create a named, isolated blackboard managed by this orchestrator.
   *
   * Each named board is stored in its own subdirectory:
   *   `<workspacePath>/boards/<name>/`
   *
   * Calling `getBlackboard(name)` a second time returns the same instance --
   * no duplicate boards are created.
   *
   * All existing APIs (`orchestrator.blackboard`, adapters, AuthGuardian, etc.)
   * are completely unaffected. This is a purely additive method.
   *
   * @example
   * ```typescript
   * const board = orchestrator.getBlackboard('project-alpha');
   * board.registerAgent('analyst', 'tok-1', ['analysis:']);
   * board.write('analysis:result', { score: 0.9 }, 'analyst', 3600, 'tok-1');
   * const entry = board.read('analysis:result');
   * ```
   *
   * @param name    - Board name: alphanumeric, hyphens and underscores only
   * @param options - Optional creation options (ignored on subsequent calls)
   * @returns The isolated `SharedBlackboard` instance for this name
   * @throws {@link ValidationError} if `name` is empty or contains invalid characters
   */
  public getBlackboard(name: string, options?: NamedBlackboardOptions): SharedBlackboard {
    if (!name || typeof name !== 'string' || name.trim() === '') {
      throw new ValidationError('name must be a non-empty string');
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new ValidationError(
        'name must contain only alphanumeric characters, hyphens, or underscores'
      );
    }

    // Return existing board (idempotent)
    if (this.namedBlackboards.has(name)) {
      return this.namedBlackboards.get(name)!;
    }

    let board: SharedBlackboard;
    let selectedBackend: BlackboardBackend;
    if (options?.backend) {
      // Custom backend — no disk directory needed
      selectedBackend = options.backend;
      log.info('Named blackboard created (custom backend)', { name });
    } else {
      // Default: file backend persisted to <workspacePath>/boards/<name>/
      const boardPath = join(this._workspacePath, 'boards', name);
      mkdirSync(boardPath, { recursive: true });
      selectedBackend = new FileBackend(boardPath);
      log.info('Named blackboard created', { name, boardPath: join(this._workspacePath, 'boards', name) });
    }

    // Auto-wrap with ConsistentBackend when a non-default consistency level is requested
    if (options?.consistency && options.consistency !== 'eventual') {
      selectedBackend = new ConsistentBackend(selectedBackend, options.consistency);
      log.info('Named blackboard wrapped with ConsistentBackend', { name, consistency: options.consistency });
    }

    board = new SharedBlackboard(selectedBackend);

    // Register the orchestrator agent on this board
    board.registerAgent(
      'orchestrator',
      'system-orchestrator-token',
      options?.allowedNamespaces ?? ['*'],
    );

    this.namedBlackboards.set(name, board);
    return board;
  }

  /**
   * Returns the names of all currently active named blackboards.
   *
   * @example
   * ```typescript
   * orchestrator.getBlackboard('alpha');
   * orchestrator.getBlackboard('beta');
   * orchestrator.listBlackboards(); // ['alpha', 'beta']
   * ```
   */
  public listBlackboards(): string[] {
    return Array.from(this.namedBlackboards.keys());
  }

  /**
   * Returns `true` if a named blackboard with the given name is currently active.
   *
   * @param name - The board name to check
   */
  public hasBlackboard(name: string): boolean {
    if (!name || typeof name !== 'string') return false;
    return this.namedBlackboards.has(name);
  }

  /**
   * Removes a named blackboard from the in-memory registry.
   *
   * **On-disk data is NOT deleted** -- call `getBlackboard(name)` again to
   * re-attach to the same persistent board at a later point.
   *
   * @param name - The board name to remove
   * @returns `true` if the board existed and was removed, `false` otherwise
   *
   * @example
   * ```typescript
   * orchestrator.destroyBlackboard('project-alpha'); // true
   * orchestrator.hasBlackboard('project-alpha');     // false
   * ```
   */
  public destroyBlackboard(name: string): boolean {
    if (!name || typeof name !== 'string') return false;
    const existed = this.namedBlackboards.has(name);
    this.namedBlackboards.delete(name);
    if (existed) log.info('Named blackboard removed from registry', { name });
    return existed;
  }

  // -------------------------------------------------------------------------
  // UTILITY METHODS
  // -------------------------------------------------------------------------

  private priorityToNumber(priority: string): number {
    const map: Record<string, number> = {
      low: 0,
      normal: 1,
      high: 2,
      critical: 3,
    };
    return map[priority] ?? 1;
  }

  private timeoutPromise(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new NetworkAITimeoutError(ms)), ms);
    });
  }

  /**
   * Register an agent with the swarm
   */
  registerAgent(agentId: string, status: AgentStatus['status'] = 'available'): void {
    if (!agentId || typeof agentId !== 'string' || agentId.trim() === '') {
      throw new ValidationError('agentId must be a non-empty string');
    }
    const validStatuses = ['available', 'busy', 'waiting_auth', 'offline'] as const;
    if (!validStatuses.includes(status as any)) {
      throw new ValidationError(`status must be one of: ${validStatuses.join(', ')}`);
    }
    this.agentRegistry.set(agentId, {
      agentId,
      status,
      currentTask: null,
      lastHeartbeat: new Date().toISOString(),
    });
  }

  /**
   * Update agent status
   */
  updateAgentStatus(agentId: string, status: AgentStatus['status'], currentTask?: string): void {
    if (!agentId || typeof agentId !== 'string' || agentId.trim() === '') {
      throw new ValidationError('agentId must be a non-empty string');
    }
    const existing = this.agentRegistry.get(agentId);
    if (existing) {
      existing.status = status;
      existing.currentTask = currentTask ?? null;
      existing.lastHeartbeat = new Date().toISOString();
    }
  }
}

// ============================================================================
// EXPORTS & MODULE INITIALIZATION
// ============================================================================

// Default export for OpenClaw skill loader (backward compatible)
export default SwarmOrchestrator;

// Named exports for direct usage (re-exported from extracted modules)
export { SharedBlackboard } from './lib/shared-blackboard';
export { AuthGuardian } from './lib/auth-guardian';
export { TaskDecomposer } from './lib/task-decomposer';
export { ExplainabilityTracer } from './lib/explainability';
export type { DecisionCard, DecisionFactor } from './lib/explainability';
export { OrchestratorEventBus } from './lib/event-bus';
export type { BusEvent, StateSnapshot, ReplayOptions, ReplayResult, EventSource, EventSeverity } from './lib/event-bus';
export { AgentConversationLog } from './lib/agent-conversation';
export type { AgentTurn, AgentStats, AgentConversation } from './lib/agent-conversation';
export { OTelBridge, SpanStatus } from './lib/otel-bridge';
export type { OTelSpan, OTelTracer, OTelSpanOptions } from './lib/otel-bridge';
export { MetricsRegistry, Counter, Gauge, Histogram, createOrchestratorMetrics } from './lib/metrics';
export type { Labels, HistogramBuckets } from './lib/metrics';
export { CostHeatmap } from './lib/cost-heatmap';
export type { HeatmapCell, HeatmapSnapshot, CostRate, ExecutionSample } from './lib/cost-heatmap';
export { TimelineScrubber } from './lib/timeline-scrubber';
export type { TimelineFrame, TimelineRange } from './lib/timeline-scrubber';
export { AnomalyDetector } from './lib/anomaly-detector';
export type { Anomaly, AnomalyMetric, BaselineSummary } from './lib/anomaly-detector';
export { CostGovernor, LookupCostModel } from './lib/cost-governor';
export type { DAGCostPrediction, NodeCostEstimate, CostModel, CostDAGNode, CostBudget } from './lib/cost-governor';
export { DryRunSimulator } from './lib/dry-run';
export type { DryRunReport, SimulatedNode, DryRunNode, DryRunBudget } from './lib/dry-run';
export { ConfigWatcher } from './lib/config-watcher';
export type { ReloadableConfig, TrustEntry, BudgetOverrides, ConfigTargets, ReloadEvent, ReloadError } from './lib/config-watcher';
export { OrchestratorLifecycleHooks } from './lib/lifecycle-hooks';
export type { LifecyclePhase, BeforeSpawnContext, AfterCompleteContext, OnFailureContext, LifecycleHandler, LifecycleHookEntry } from './lib/lifecycle-hooks';
export { AgentMemory, EpisodicMemory, ProceduralMemory, SharedLongTermMemory } from './lib/agent-memory';
export type { MemoryEntry, EpisodicEntry, ProceduralEntry, SharedEntry, RecallOptions } from './lib/agent-memory';
export { LearningLoop } from './lib/learning-loop';
export type { DAGPattern, PatternStep, DAGOutcome, PatternMatch } from './lib/learning-loop';
export { SpeculativeExecutor } from './lib/speculative-executor';
export type { SpeculativeCandidate, SpeculativeResult, SpeculativeOutcome, SpeculativeOptions, SpeculativeExecutorFn } from './lib/speculative-executor';
export { AgentDebate } from './lib/agent-debate';
export type { DebateTurn, DebateConfig, DebateOutcome, CritiqueResult, RevisionResult, ProposerFn, CriticFn } from './lib/agent-debate';
export { ApprovalInbox } from './lib/approval-inbox';
export type { ApprovalEntry, ApprovalInboxOptions, ApprovalStatus, InboxEvent, InboxEventType, InboxStats } from './lib/approval-inbox';
export { createAdapterTestSuite } from './lib/adapter-test-harness';
export type { AdapterTestSuiteConfig, AdapterTestResult, AssertFn, SectionFn } from './lib/adapter-test-harness';
export { SwarmTransportServer, SwarmTransportClient } from './lib/swarm-transport';
export type { TransportEnvelope, TransportMeta, TransportResponse, TransportServerConfig, TransportClientConfig, TransportHandler } from './lib/swarm-transport';
export { JobQueue, FileJobStore } from './lib/job-queue';
export type { JobRecord, JobCreateOptions, JobHandler, JobQueueConfig, JobQueueStats, JobStatus, JobPriority, IJobStore } from './lib/job-queue';
export { startPlayground, MockAgentRegistry } from './lib/playground';
export type { PlaygroundConfig, PlaygroundInstance } from './lib/playground';
export { parseGoal, goalFromObject, validateGoal, compileGoal } from './lib/goal-dsl';
export type { GoalDefinition, GoalTask, GoalConstraints, GoalOutput, GoalValidationError, GoalValidationResult, ExecutionLayer, CompiledGoal } from './lib/goal-dsl';
export { AgentVCR } from './lib/agent-vcr';
export type { VCRMode, VCRInteraction, VCRCassette, VCRConfig, VCRHandler, VCRMatchResult } from './lib/agent-vcr';
export { CoverageReporter } from './lib/coverage-reporter';
export type { FileCoverage, CoverageReport, CoverageThresholds, CoverageReporterConfig } from './lib/coverage-reporter';
export { ComparisonRunner } from './lib/comparison-runner';
export type { ComparisonHandler, ComparisonOutput, ComparisonConfig, ComparisonInput, RunResult, SideResult, ComparisonResult } from './lib/comparison-runner';
export { NoOpAuthValidator } from './lib/auth-validator';
export type { IAuthValidator, PermissionRequest, PermissionResult, AgentTrust } from './lib/auth-validator';

// Quality gate & validation exports
export { BlackboardValidator, QualityGateAgent, validateJsonSchema } from './lib/blackboard-validator';
export type { JsonSchema } from './lib/blackboard-validator';
export type {
  ValidationResult,
  ValidationIssue,
  ValidationConfig,
  QualityGateResult,
  GateDecision,
  AIReviewCallback,
  CustomValidationRule,
} from './lib/blackboard-validator';

// Adapter system re-exports for convenience
export { AdapterRegistry } from './adapters/adapter-registry';
export type { AdapterFactory } from './adapters/adapter-registry';
export { BaseAdapter } from './adapters/base-adapter';
export { OpenClawAdapter } from './adapters/openclaw-adapter';
export { LangChainAdapter } from './adapters/langchain-adapter';
export { AutoGenAdapter } from './adapters/autogen-adapter';
export { CrewAIAdapter } from './adapters/crewai-adapter';
export { MCPAdapter } from './adapters/mcp-adapter';
export { CustomAdapter } from './adapters/custom-adapter';
export { MCPToolConsumer, StdioClientTransport, HttpClientTransport } from './lib/mcp-tool-consumer';
export type { MCPConsumerOptions, RemoteToolInfo, MCPClientTransport, JsonRpcRequest, JsonRpcResponse, ToolCallResult } from './lib/mcp-tool-consumer';

// Type exports (re-exported from orchestrator-types)
export type {
  TaskPayload,
  HandoffMessage,
  PermissionGrant,
  SwarmState,
  AgentStatus,
  TaskRecord,
  BlackboardEntry,
  ActiveGrant,
  ParallelTask,
  ParallelExecutionResult,
  SynthesisStrategy,
  ResourceProfile,
  AgentTrustConfig,
  NamedBlackboardOptions,
} from './lib/orchestrator-types';

export type {
  IAgentAdapter,
  AgentPayload,
  AgentContext,
  AgentResult,
  AgentInfo,
  AdapterConfig,
  AdapterCapabilities,
} from './types/agent-adapter';

// Backward-compatible OpenClaw types
export type { OpenClawSkill, SkillContext, SkillResult } from './lib/orchestrator-types';

// Phase 3: Priority & Preemption types
export type { ConflictResolutionStrategy, AgentPriority, LockedBlackboardOptions, BlackboardEntryMetadata } from './lib/locked-blackboard';

// Phase 5 Part 2: Pluggable Backend API
export { FileBackend, MemoryBackend } from './lib/blackboard-backend';
export type { BlackboardBackend } from './lib/blackboard-backend';

// Phase 5 Part 3: Redis Backend
export { RedisBackend } from './lib/blackboard-backend-redis';
export type { RedisClient, RedisPipeline, RedisBackendOptions } from './lib/blackboard-backend-redis';

// Phase 5 Part 4: CRDT Backend
export { CrdtBackend } from './lib/blackboard-backend-crdt';
export type { CrdtBackendOptions, VectorClock, CrdtEntry } from './lib/blackboard-backend-crdt';
export { tickClock, mergeClock, happensBefore, isConcurrent, compareClock, mergeEntry } from './lib/crdt';

// Phase 5 Part 5: Configurable Consistency Levels
export { ConsistentBackend, isFlushable } from './lib/consistency';
export type { ConsistencyLevel, FlushableBackend } from './lib/consistency';

// Phase 5 Part 6: Federated Budget Tracking
export { FederatedBudget } from './lib/federated-budget';
export type { FederatedBudgetOptions, SpendResult, SpendLogEntry } from './lib/federated-budget';

// Phase 5 Part 7: MCP Networking
export {
  McpBlackboardBridge,
  McpBridgeClient,
  McpBridgeRouter,
  McpInProcessTransport,
} from './lib/mcp-bridge';
export type {
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpJsonRpcError,
  McpListToolsResult,
  McpCallToolResult,
  McpContentBlock,
  McpTransport,
  McpBlackboardBridgeOptions,
} from './lib/mcp-bridge';

// Logger
export { Logger, LogLevel } from './lib/logger';
export type { LogEntry, LogTransport, LoggerConfig } from './lib/logger';

// Typed errors
export {
  NetworkAIError,
  IdentityVerificationError,
  NamespaceViolationError,
  ValidationError,
  LockAcquisitionError,
  ConflictError,
  AdapterAlreadyRegisteredError,
  AdapterNotFoundError,
  AdapterNotInitializedError,
  ParallelLimitError,
  TimeoutError,
  mapErrorToSkillResult,
} from './lib/errors';

// ============================================================================
// Phase 4: Behavioral Control Plane
// ============================================================================

// FSM Journey Layer
export {
  JourneyFSM,
  ToolAuthorizationMatrix,
  ComplianceMiddleware,
  ComplianceViolationError,
  createDeliveryPipelineFSM,
  WORKFLOW_STATES,
} from './lib/fsm-journey';
export type {
  WorkflowStateDefinition,
  StateTransition,
  TransitionResult,
  ComplianceCheckResult,
  JourneyFSMOptions,
} from './lib/fsm-journey';

// Real-Time Compliance Monitor
export { ComplianceMonitor } from './lib/compliance-monitor';
export type {
  ComplianceViolation,
  ViolationType,
  AgentAction,
  AgentMonitorConfig,
  ComplianceMonitorOptions,
} from './lib/compliance-monitor';

// QA Orchestrator Agent
export { QAOrchestratorAgent } from './lib/qa-orchestrator';
export type {
  QAScenario,
  QAScenarioResult,
  QAFeedback,
  QASnapshot,
  QAOrchestratorOptions,
  Contradiction,
  QAHarnessResult,
  RegressionReport,
} from './lib/qa-orchestrator';

// Adapter Hook Middleware (Phase 7b)
export { AdapterHookManager, matchGlob, matchToolPattern } from './lib/adapter-hooks';
export type {
  HookPhase,
  HookContext,
  ExecutionHook,
  HookMatcher,
} from './lib/adapter-hooks';

// Skill Composer (Phase 7d)
export { SkillComposer } from './lib/skill-composer';
export type {
  ComposableStep,
  ComposedResult,
  LoopOptions,
  VerifyOptions,
} from './lib/skill-composer';

// Semantic Memory Search (Phase 7e)
export { SemanticMemory } from './lib/semantic-search';
export type {
  EmbeddingFn,
  SearchResult,
} from './lib/semantic-search';

// Phase Pipeline — Multi-phase workflows with approval gates (Phase 8a)
export { PhasePipeline } from './lib/phase-pipeline';
export type {
  PhaseDefinition,
  PhaseResult,
  PhaseStatus,
  PipelineResult,
  PipelineExecutionContext,
  ApprovalCallback,
  PhasePipelineOptions,
  CompactionOptions,
} from './lib/phase-pipeline';

// Confidence Filter — Multi-agent result scoring & filtering (Phase 8b)
export { ConfidenceFilter } from './lib/confidence-filter';
export type {
  Finding,
  FilterResult,
  AggregationStrategy,
  AggregatedResult,
  ConfidenceFilterOptions,
} from './lib/confidence-filter';

// Fan-Out / Fan-In — Parallel agent aggregation (Phase 8d)
export { FanOutFanIn } from './lib/fan-out';
export type {
  FanOutStep,
  TaggedResult,
  FanInStrategy,
  FanInResult,
  FanInReducer,
  FanOutOptions,
} from './lib/fan-out';

// Agent Runtime — Sandboxed execution environment (Phase 9a)
export {
  SandboxPolicy,
  ShellExecutor,
  FileAccessor,
  ApprovalGate,
  AgentRuntime,
  RuntimePolicyError,
  RuntimeApprovalError,
  RuntimeExecutionError,
} from './lib/agent-runtime';
export type {
  SandboxPolicyConfig,
  ShellResult,
  ShellOptions,
  FileResult,
  ApprovalRequest,
  ApprovalDecision,
  ApprovalCallback as RuntimeApprovalCallback,
  RuntimeAuditEntry,
  RuntimeEvents,
  AgentRuntimeOptions,
} from './lib/agent-runtime';

// Console UI — Interactive terminal dashboard (Phase 9b)
export { ConsoleUI, ansi } from './lib/console-ui';
export type {
  ConsoleStatus,
  FeedEntry,
  CommandHandler,
  ConsoleUIOptions,
} from './lib/console-ui';

// Strategy Agent — AI Meta-Orchestrator (Phase 9c)
export {
  AgentPool,
  WorkloadPartitioner,
  StrategyAgent,
  adaptiveStrategy,
} from './lib/strategy-agent';
export type {
  AgentTemplate,
  ManagedAgent,
  WorkChunk,
  StrategyPlan,
  SystemSnapshot,
  PoolStatus,
  StrategyFunction,
  StrategyEvents,
  StrategyAgentOptions,
} from './lib/strategy-agent';

// Goal Decomposer — LLM-powered goal → task DAG → parallel execution (Phase 10)
export {
  GoalDecomposer,
  TeamRunner,
  runTeam,
  createLLMPlanner,
  validateDAG,
  topologicalLayers,
  parsePlanJSON,
} from './lib/goal-decomposer';
export type {
  TaskNode,
  TaskDAG,
  TeamAgent,
  PlannedTask,
  PlannerFunction,
  ExecutorFunction,
  RunTeamOptions,
  TeamResult,
  TeamRunnerEvents,
} from './lib/goal-decomposer';

// Context Throttler — Metadata-driven blackboard pruning (Phase 12)
export { ContextThrottler, filterState } from './lib/context-throttler';
export type {
  ScopeMetadata,
  BlackboardSnapshot,
  ThrottleResult,
  ContextThrottlerOptions,
} from './lib/context-throttler';

// Partition Planner — Logical work partitioning to prevent redundant research (Phase 12)
export {
  PartitionPlanner,
  createLexicalOverlapChecker,
  createLLMPartitionPlanner,
  parsePartitionJSON,
} from './lib/partition-planner';
export type {
  PartitionEntry,
  PartitionSchema,
  PartitionPlannerFunction,
  OverlapCheckFunction,
  PartitionPlannerOptions,
  PartitionResult,
} from './lib/partition-planner';

// Coverage Gate — Recursive refinement loop with score-gated completion (Phase 12)
export {
  CoverageGate,
  createKeywordEvaluator,
  createLLMEvaluator,
} from './lib/coverage-gate';
export type {
  CoverageResult,
  CoverageEvaluatorFunction,
  CoverageGateOptions,
  CoverageGateResult,
  RefinementRound,
} from './lib/coverage-gate';

// Route Classifier — Short-circuit routing for factual lookups (Phase 12)
export {
  RouteClassifier,
  createHeuristicClassifier,
  createLLMClassifier,
} from './lib/route-classifier';
export type {
  RouteCategory,
  ClassificationResult,
  ClassifierFunction,
  RouteResult,
  RouteClassifierOptions,
} from './lib/route-classifier';

// Live Agent Topology — Real-time agent graph + dashboard (Phase 11)
export { TopologyTracker } from './lib/topology';
export type {
  AgentNode,
  AgentNodeStatus,
  AgentRole,
  TopologyEdge,
  EdgeType,
  TopologyEvent,
  TopologyEventType,
  TopologySnapshot,
  TopologyTrackerEvents,
  TopologyTrackerOptions,
  PhaseMilestone,
  PhaseProgress,
  AttentionItem,
  AttentionPanel,
  TimelineSpan,
  AgentCluster,
  TopologyDelta,
} from './lib/topology';
export { DashboardServer } from './lib/dashboard-server';
export type { DashboardServerOptions } from './lib/dashboard-server';

// WorkTree — Hierarchical task decomposition tree with rollup
export { WorkTree } from './lib/work-tree';
export type {
  WorkNode,
  WorkNodeStatus,
  WorkTreeStats,
  WorkTreeSnapshot,
  WorkTreeEvents,
  WorkTreeOptions,
} from './lib/work-tree';

// WorkTreeUI — Terminal renderer for WorkTree hierarchies
export { WorkTreeUI } from './lib/work-tree-ui';
export type {
  WorkTreeUIOptions,
  RenderResult,
} from './lib/work-tree-ui';

// WorkTreeDashboard — Browser-based live WorkTree visualization
export { WorkTreeDashboard } from './lib/work-tree-dashboard';
export type { WorkTreeDashboardOptions, AgentLogEntry, DashboardAgentInfo, SystemDiagnostic, SystemHealth } from './lib/work-tree-dashboard';

// ControlPlane — Multi-workspace unified dashboard
export { ControlPlane } from './lib/control-plane';
export type { ControlPlaneOptions, WorkspaceConfig, WorkspaceSummary, CPAgentInfo } from './lib/control-plane';

// ============================================================================
// Phase 13 (v5.4.0): Multi-Environment Isolation
// ============================================================================

// Environment Manager — isolated data dirs, promotion chain, backup/restore
export { EnvironmentManager } from './lib/env-manager';
export type {
  EnvName,
  GateType,
  EnvConfig,
  PromotionResult,
  EnvFileDiff,
  EnvDiff,
  BackupResult,
  BackupEntry,
  RestoreResult,
  PromoteOptions,
} from './lib/env-manager';

// Source Protection — blocks agent access to source code files
export { SourceProtectionError } from './lib/agent-runtime';

// QuadTree — Barnes-Hut spatial indexing (Tier 1 scalability)
export { QuadTree } from './lib/quadtree';
export type { QTPoint, QTBounds, QTMass } from './lib/quadtree';

// MCP Blackboard Tool Bindings
export {
  BlackboardMCPTools,
  registerBlackboardTools,
  BLACKBOARD_TOOL_DEFINITIONS,
} from './lib/mcp-blackboard-tools';
export type {
  MCPToolDefinition,
  MCPJsonSchema,
  BlackboardToolResult,
  IBlackboard,
} from './lib/mcp-blackboard-tools';

/**
 * Factory function for creating a configured SwarmOrchestrator instance.
 * 
 * For plug-and-play with other agent systems, pass adapters:
 * 
 *   const orchestrator = createSwarmOrchestrator({
 *     adapters: [{ adapter: new LangChainAdapter(), config: {} }],
 *   });
 */
/**
 * Factory function for creating a fully configured {@link SwarmOrchestrator}.
 *
 * Accepts optional configuration for adapters, trust levels, resource profiles,
 * quality gate settings, and runtime overrides.
 *
 * @param config - Optional configuration object. Pass `undefined` for all defaults.
 * @returns A ready-to-use SwarmOrchestrator instance.
 *
 * @example
 * ```typescript
 * import { createSwarmOrchestrator, LangChainAdapter } from 'network-ai';
 *
 * // Minimal
 * const orc = createSwarmOrchestrator();
 *
 * // With adapters and trust
 * const orc2 = createSwarmOrchestrator({
 *   adapters: [{ adapter: new LangChainAdapter() }],
 *   trustLevels: [{ agentId: 'analyst', trustLevel: 0.8 }],
 *   qualityThreshold: 0.7,
 * });
 * ```
 */
export function createSwarmOrchestrator(config?: Partial<typeof CONFIG> & {
  adapters?: Array<{ adapter: IAgentAdapter; config?: AdapterConfig }>;
  adapterRegistry?: AdapterRegistry;
  trustLevels?: AgentTrustConfig[];
  resourceProfiles?: Record<string, ResourceProfile>;
  validationConfig?: Partial<ValidationConfig>;
  qualityThreshold?: number;
  aiReviewCallback?: AIReviewCallback;
}): SwarmOrchestrator {
  if (config !== undefined && (typeof config !== 'object' || config === null || Array.isArray(config))) {
    throw new ValidationError('config must be a plain object');
  }
  if (config) {
    const { adapters: adapterList, adapterRegistry, trustLevels, resourceProfiles, validationConfig, qualityThreshold, aiReviewCallback, ...rest } = config;
    Object.assign(CONFIG, rest);

    const registry = adapterRegistry ?? new AdapterRegistry();
    const orchestrator = new SwarmOrchestrator(undefined, registry, {
      trustLevels,
      resourceProfiles,
      validationConfig,
      qualityThreshold,
      aiReviewCallback,
    });

    // Initialize adapters if provided
    if (adapterList) {
      Promise.all(
        adapterList.map(({ adapter, config: adapterConfig }) =>
          orchestrator.addAdapter(adapter, adapterConfig ?? {})
        )
      ).catch(err => log.error('Adapter init error', { error: err instanceof Error ? err.message : String(err) }));
    }

    return orchestrator;
  }
  return new SwarmOrchestrator();
}

// ============================================================================
// Phase 6: Full AI Control — config accessors
// ============================================================================

/**
 * Read the current value of a CONFIG key, or the entire CONFIG snapshot.
 *
 * @example
 * ```typescript
 * const cfg = getConfig(); // { maxParallelAgents: Infinity, ... }
 * const timeout = getConfig('defaultTimeout'); // 30000
 * ```
 */
export function getConfig(): Readonly<typeof CONFIG>;
export function getConfig(key: string): unknown;
export function getConfig(key?: string): unknown {
  if (key !== undefined) return (CONFIG as Record<string, unknown>)[key];
  return { ...CONFIG };
}

/**
 * Update a CONFIG key at runtime.  Changes take effect immediately for all
 * subsequent orchestrator operations.
 *
 * @example
 * ```typescript
 * setConfig('maxParallelAgents', 10);
 * setConfig('enableTracing', false);
 * ```
 */
export function setConfig(key: string, value: unknown): void {
  (CONFIG as Record<string, unknown>)[key] = value;
}

// Phase 6: SSE transport + extended/control tools
export {
  McpSseServer,
  McpSseTransport,
  McpCombinedBridge,
  McpBlackboardBridgeAdapter,
} from './lib/mcp-transport-sse';
export type { McpToolProvider, McpSseServerOptions } from './lib/mcp-transport-sse';

export { ExtendedMcpTools } from './lib/mcp-tools-extended';
export type { IBudget, ITokenManager, ExtendedMcpToolsOptions } from './lib/mcp-tools-extended';

export { ControlMcpTools } from './lib/mcp-tools-control';
export type { IConfig, IAgentStatus, ControlMcpToolsOptions } from './lib/mcp-tools-control';

// Streaming adapters
export { StreamingBaseAdapter, collectStream } from './adapters/streaming-base-adapter';
export { LangChainStreamingAdapter } from './adapters/langchain-streaming-adapter';
export { CustomStreamingAdapter } from './adapters/custom-streaming-adapter';
export type { StreamingAgentHandler } from './adapters/custom-streaming-adapter';

// A2A (Agent-to-Agent) protocol adapter
export { A2AAdapter } from './adapters/a2a-adapter';
export type {
  A2AAgentCard,
  A2ATask,
  A2ATaskResponse,
  A2ATaskState,
  A2AArtifact,
  A2AAdapterConfig,
} from './adapters/a2a-adapter';

// Codex adapter (OpenAI Codex CLI / chat / completion)
export { CodexAdapter } from './adapters/codex-adapter';
export type {
  CodexMode,
  CodexAgentConfig,
  CodexChatClient,
  CodexCompletionClient,
  CodexCLIExecutor,
} from './adapters/codex-adapter';

// MiniMax adapter (MiniMax LLM API)
export { MiniMaxAdapter } from './adapters/minimax-adapter';
export type { MiniMaxAgentConfig, MiniMaxChatClient } from './adapters/minimax-adapter';

// NemoClaw adapter (NVIDIA NemoClaw — sandboxed agent execution via OpenShell)
export { NemoClawAdapter } from './adapters/nemoclaw-adapter';
export type {
  NemoClawAgentConfig,
  OpenShellExecutor,
  BlueprintAction,
  BlueprintRunResult,
  SandboxState,
  SandboxStatus,
  NetworkPolicy,
  PolicyEndpoint,
} from './adapters/nemoclaw-adapter';

// Copilot adapter (GitHub Copilot — code generation, review, analysis)
export { CopilotAdapter } from './adapters/copilot-adapter';
export type { CopilotTaskType, CopilotOptions, CopilotConnection } from './adapters/copilot-adapter';

// LangGraph adapter
export { LangGraphAdapter } from './adapters/langgraph-adapter';
export type { LangGraphRunnable, LangGraphStreamable, LangGraphAgentConfig } from './adapters/langgraph-adapter';

// Anthropic Computer Use adapter
export { AnthropicComputerUseAdapter } from './adapters/anthropic-computer-use-adapter';
export type { ComputerAction, ComputerToolCall, ComputerToolResult, ComputerActionHandler, AnthropicMessagesClient, ComputerUseAgentConfig } from './adapters/anthropic-computer-use-adapter';

// OpenAI Agents SDK adapter
export { OpenAIAgentsAdapter } from './adapters/openai-agents-adapter';
export type { OAIAgentTool, OAIAgentRunResult, OAIAgentRunner, OAIAgentsConfig } from './adapters/openai-agents-adapter';

// Vertex AI adapter
export { VertexAIAdapter } from './adapters/vertex-ai-adapter';
export type { VertexFunctionDeclaration, VertexContentPart, VertexGenerateResponse, VertexGenerativeClient, VertexFunctionExecutor, VertexAIAgentConfig } from './adapters/vertex-ai-adapter';

// Pydantic AI adapter
export { PydanticAIAdapter } from './adapters/pydantic-ai-adapter';
export type { PydanticAIRunResult, PydanticAIRunner, PydanticAIHttpConfig, PydanticAIAgentConfig } from './adapters/pydantic-ai-adapter';

// Browser Agent adapter
export { BrowserAgentAdapter } from './adapters/browser-agent-adapter';
export type { BrowserMode, BrowserStep, BrowserActionResult, BrowserDriver, BrowserAgentConfig } from './adapters/browser-agent-adapter';

// Orchestrator adapter (hierarchical multi-orchestrator coordination)
export { OrchestratorAdapter } from './adapters/orchestrator-adapter';
export type { ChildOrchestratorConfig, OrchestratorLike, ChildOrchestratorState } from './adapters/orchestrator-adapter';

// Streaming types
export type { StreamingChunk, IStreamingAdapter, StreamCollector } from './types/streaming-adapter';