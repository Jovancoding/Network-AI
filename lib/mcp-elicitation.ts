/**
 * MCP Elicitation — native in-client approval prompts.
 *
 * Implements the MCP elicitation capability (spec revision 2025-06-18):
 * the server sends an `elicitation/create` JSON-RPC request *to the client*,
 * the client renders it natively (Claude Code, Codex, Gemini CLI, Cursor…),
 * and the user's answer comes back as the response.
 *
 * Network-AI uses this to surface `ApprovalGate` / `ApprovalInbox` decisions
 * directly inside the MCP client instead of a separate HTTP inbox: wrap a
 * request sender with {@link createElicitationApprovalCallback} and pass the
 * resulting callback to `ApprovalGate`.
 *
 * Transport plumbing for stdio servers is provided by
 * {@link StdioElicitationChannel}: it assigns request ids, writes
 * newline-delimited JSON-RPC to the client, and resolves pending promises
 * when responses arrive.
 *
 * @example
 * ```ts
 * const channel = new StdioElicitationChannel((line) => process.stdout.write(line + '\n'));
 * // in the stdin loop: if (channel.handleMessage(parsed)) return; // consumed a response
 * const approvalCallback = createElicitationApprovalCallback(
 *   (params) => channel.request('elicitation/create', params),
 * );
 * const gate = new ApprovalGate(approvalCallback);
 * ```
 *
 * @module McpElicitation
 * @version 1.0.0
 */

import type { ApprovalRequest, ApprovalDecision } from './agent-runtime';

// ============================================================================
// TYPES
// ============================================================================

/** Flat-primitive schema property allowed by MCP elicitation */
export interface ElicitationSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean';
  title?: string;
  description?: string;
  enum?: string[];
  default?: string | number | boolean;
}

/** The restricted object schema MCP elicitation requests may carry */
export interface ElicitationRequestedSchema {
  type: 'object';
  properties: Record<string, ElicitationSchemaProperty>;
  required?: string[];
}

/** Params for an `elicitation/create` request */
export interface ElicitationCreateParams {
  /** Human-readable message presented to the user */
  message: string;
  /** Schema describing the structured content requested from the user */
  requestedSchema: ElicitationRequestedSchema;
}

/** Result of an `elicitation/create` request */
export interface ElicitationResult {
  /** 'accept' (user submitted), 'decline' (explicit no), 'cancel' (dismissed) */
  action: 'accept' | 'decline' | 'cancel';
  /** The user's structured answer — present only when action is 'accept' */
  content?: Record<string, unknown>;
}

/**
 * Sends an elicitation request to the connected client and resolves its
 * result. Implementations own the transport (stdio, streamable HTTP, …).
 */
export type ElicitationRequestSender = (params: ElicitationCreateParams) => Promise<ElicitationResult>;

/** Options for {@link createElicitationApprovalCallback} */
export interface ElicitationApprovalOptions {
  /** Identity recorded on decisions approved via elicitation (default: 'mcp-client') */
  approvedBy?: string;
  /** Overall timeout for the elicitation round-trip in ms (default: 300000 = 5 min) */
  timeoutMs?: number;
}

// ============================================================================
// APPROVAL CALLBACK FACTORY
// ============================================================================

/**
 * Build an `ApprovalCallback` (as used by `ApprovalGate` / `AgentRuntime`)
 * that resolves approvals by asking the connected MCP client through
 * elicitation. Fail-closed: timeouts, transport errors, declines, and
 * cancellations all resolve to `approved: false`.
 */
export function createElicitationApprovalCallback(
  send: ElicitationRequestSender,
  options: ElicitationApprovalOptions = {}
): (request: ApprovalRequest) => Promise<ApprovalDecision> {
  const approvedBy = options.approvedBy ?? 'mcp-client';
  const timeoutMs = options.timeoutMs ?? 300_000;

  return async (request: ApprovalRequest): Promise<ApprovalDecision> => {
    const params: ElicitationCreateParams = {
      message:
        `Approval required — agent "${request.agentId}" requests ${request.type} ` +
        `on "${request.target}" (risk: ${request.risk})` +
        (request.justification ? `\nJustification: ${request.justification}` : ''),
      requestedSchema: {
        type: 'object',
        properties: {
          approve: {
            type: 'boolean',
            title: 'Approve this action?',
            description: `Allow ${request.type} on ${request.target}`,
          },
          reason: {
            type: 'string',
            title: 'Reason (optional)',
            description: 'Why you approved or denied this action',
          },
        },
        required: ['approve'],
      },
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const result = await Promise.race([
        send(params),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`elicitation timed out after ${timeoutMs}ms`)),
            timeoutMs
          );
        }),
      ]);

      if (result.action === 'accept' && result.content?.['approve'] === true) {
        const reason = typeof result.content['reason'] === 'string'
          ? result.content['reason'] as string
          : undefined;
        return { approved: true, approvedBy, ...(reason ? { reason } : {}) };
      }

      const why = result.action === 'accept'
        ? 'user answered no'
        : `user ${result.action === 'decline' ? 'declined' : 'cancelled'} the prompt`;
      return { approved: false, reason: `Denied via MCP elicitation — ${why}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Fail closed: any transport failure is a denial, never an approval.
      return { approved: false, reason: `Elicitation failed — ${message}` };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

// ============================================================================
// STDIO CHANNEL
// ============================================================================

/** A JSON-RPC message as seen on the wire (request or response) */
interface JsonRpcWireMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Server→client request channel for newline-delimited JSON-RPC transports
 * (stdio). Assigns unique ids to outgoing requests and resolves the pending
 * promise when the matching response arrives.
 *
 * Integration contract for the stdin loop: for every parsed inbound message,
 * call {@link handleMessage} first — if it returns `true` the message was a
 * response to a server-initiated request and must not be dispatched as a
 * client request.
 */
export class StdioElicitationChannel {
  private readonly write: (line: string) => void;
  private readonly pending = new Map<number, {
    resolve: (result: ElicitationResult) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }>();
  private nextId = 1_000_000; // high offset avoids collisions with client request ids
  private readonly defaultTimeoutMs: number;

  /**
   * @param write            Writes one serialized JSON-RPC line to the client.
   * @param defaultTimeoutMs Per-request timeout (default: 300000 = 5 min).
   */
  constructor(write: (line: string) => void, defaultTimeoutMs = 300_000) {
    this.write = write;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /** Number of requests currently awaiting a client response */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Send a server→client request and resolve its result.
   * Rejects on timeout, client error response, or malformed result.
   */
  request(method: string, params: ElicitationCreateParams, timeoutMs?: number): Promise<ElicitationResult> {
    const id = this.nextId++;
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    return new Promise<ElicitationResult>((resolve, reject) => {
      const effective = timeoutMs ?? this.defaultTimeoutMs;
      const timer = effective > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`request ${id} (${method}) timed out after ${effective}ms`));
          }, effective)
        : null;

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write(line);
      } catch (err) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Route an inbound message. Returns `true` when the message was a response
   * to a pending server-initiated request (and was consumed); `false` when it
   * is a client request the caller should dispatch normally.
   */
  handleMessage(message: unknown): boolean {
    if (message === null || typeof message !== 'object') return false;
    const msg = message as JsonRpcWireMessage;

    // Requests (and notifications) carry a method — not ours to consume.
    if (typeof msg.method === 'string') return false;
    if (msg.id === null || msg.id === undefined) return false;

    const id = typeof msg.id === 'number' ? msg.id : Number(msg.id);
    const entry = this.pending.get(id);
    if (!entry) return false;

    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);

    if (msg.error) {
      entry.reject(new Error(`client error ${msg.error.code}: ${msg.error.message}`));
      return true;
    }

    const result = msg.result as ElicitationResult | undefined;
    if (!result || (result.action !== 'accept' && result.action !== 'decline' && result.action !== 'cancel')) {
      entry.reject(new Error('malformed elicitation result from client'));
      return true;
    }

    entry.resolve(result);
    return true;
  }

  /** Reject every pending request (e.g. on shutdown or client disconnect). */
  rejectAll(reason = 'channel closed'): void {
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error(`request ${id} aborted — ${reason}`));
    }
    this.pending.clear();
  }
}
