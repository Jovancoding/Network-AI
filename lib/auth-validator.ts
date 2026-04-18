/**
 * IAuthValidator — Interface to decouple authorization from concrete AuthGuardian
 *
 * Any authorization provider that implements this interface can be used
 * wherever AuthGuardian is currently expected, enabling testability
 * and alternative auth backends.
 *
 * @module IAuthValidator
 * @version 1.0.0
 */

// ============================================================================
// TYPES
// ============================================================================

/** Permission request input */
export interface PermissionRequest {
  /** Agent requesting permission */
  agentId: string;
  /** Resource being accessed */
  resource: string;
  /** Action (read/write/execute/delete) */
  action: string;
  /** Justification for the request */
  justification?: string;
}

/** Permission check result */
export interface PermissionResult {
  /** Whether permission was granted */
  granted: boolean;
  /** Reason for the decision */
  reason: string;
  /** Score (0-100) if scored */
  score?: number;
  /** Expiry time of the grant */
  expiresAt?: number;
}

/** Agent trust information */
export interface AgentTrust {
  /** Trust level (0-1) */
  level: number;
  /** Allowed namespace prefixes */
  namespaces: string[];
}

// ============================================================================
// INTERFACE
// ============================================================================

/**
 * IAuthValidator — Authorization contract for blackboard and task systems.
 *
 * Implementations:
 *   - `AuthGuardian` (default, weighted scoring)
 *   - `NoOpAuthValidator` (testing, always grants)
 *   - Custom implementations for external auth providers
 */
export interface IAuthValidator {
  /**
   * Check whether an agent has permission for an action.
   */
  checkPermission(request: PermissionRequest): Promise<PermissionResult> | PermissionResult;

  /**
   * Get the trust info for an agent.
   */
  getAgentTrust(agentId: string): AgentTrust | undefined;

  /**
   * Get allowed namespaces for an agent.
   */
  getAgentNamespaces(agentId: string): string[];
}

// ============================================================================
// NO-OP IMPLEMENTATION (for testing)
// ============================================================================

/**
 * NoOpAuthValidator — Always grants permission. For testing only.
 */
export class NoOpAuthValidator implements IAuthValidator {
  checkPermission(_request: PermissionRequest): PermissionResult {
    return { granted: true, reason: 'NoOp: always granted' };
  }

  getAgentTrust(_agentId: string): AgentTrust {
    return { level: 1, namespaces: ['*'] };
  }

  getAgentNamespaces(_agentId: string): string[] {
    return ['*'];
  }
}
