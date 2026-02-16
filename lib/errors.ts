/**
 * Typed Error Classes for Network-AI
 * 
 * Provides specific error types so consumers can catch and handle
 * different failure modes independently (e.g., retry on rate limit,
 * re-authenticate on token expiry, alert on namespace violation).
 * 
 * All errors extend NetworkAIError, which extends Error.
 * 
 * @module Errors
 * @version 1.0.0
 * @license MIT
 */

// ============================================================================
// BASE ERROR
// ============================================================================

/**
 * Base error class for all Network-AI errors.
 * Every error includes a machine-readable `code` and optional `details`.
 * 
 * @example
 * ```typescript
 * try {
 *   blackboard.write('key', value, 'agent');
 * } catch (err) {
 *   if (err instanceof NetworkAIError) {
 *     console.log(err.code);    // e.g., 'IDENTITY_VERIFICATION_FAILED'
 *     console.log(err.details); // { agentId: 'agent' }
 *   }
 * }
 * ```
 */
export class NetworkAIError extends Error {
  /** Machine-readable error code */
  readonly code: string;
  /** Additional structured context */
  readonly details?: Record<string, unknown>;

  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'NetworkAIError';
    this.code = code;
    this.details = details;
    // Fix prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ============================================================================
// BLACKBOARD ERRORS
// ============================================================================

/**
 * Thrown when an agent fails identity verification on blackboard write.
 */
export class IdentityVerificationError extends NetworkAIError {
  constructor(agentId: string) {
    super(
      `Identity verification failed for agent '${agentId}'`,
      'IDENTITY_VERIFICATION_FAILED',
      { agentId },
    );
    this.name = 'IdentityVerificationError';
  }
}

/**
 * Thrown when an agent tries to write to a namespace it doesn't have access to.
 */
export class NamespaceViolationError extends NetworkAIError {
  constructor(agentId: string, key: string) {
    super(
      `Agent '${agentId}' not allowed to write to key '${key}'`,
      'NAMESPACE_VIOLATION',
      { agentId, key },
    );
    this.name = 'NamespaceViolationError';
  }
}

/**
 * Thrown when a value fails size or structure validation before write.
 */
export class ValidationError extends NetworkAIError {
  constructor(reason: string) {
    super(
      `Value validation failed: ${reason}`,
      'VALIDATION_FAILED',
      { reason },
    );
    this.name = 'ValidationError';
  }
}

// ============================================================================
// LOCK ERRORS
// ============================================================================

/**
 * Thrown when a file-system lock cannot be acquired within the timeout.
 */
export class LockAcquisitionError extends NetworkAIError {
  constructor(operation: string) {
    super(
      `Failed to acquire lock for ${operation}`,
      'LOCK_ACQUISITION_FAILED',
      { operation },
    );
    this.name = 'LockAcquisitionError';
  }
}

/**
 * Thrown when a conflict is detected during the atomic commit workflow.
 */
export class ConflictError extends NetworkAIError {
  constructor(key: string, expectedHash: string | null, actualHash: string | null) {
    super(
      `Conflict detected for key '${key}': data changed since proposal`,
      'CONFLICT_DETECTED',
      { key, expectedHash, actualHash },
    );
    this.name = 'ConflictError';
  }
}

// ============================================================================
// ADAPTER ERRORS
// ============================================================================

/**
 * Thrown when an adapter is already registered under the same name.
 */
export class AdapterAlreadyRegisteredError extends NetworkAIError {
  constructor(adapterName: string) {
    super(
      `Adapter "${adapterName}" is already registered`,
      'ADAPTER_ALREADY_REGISTERED',
      { adapterName },
    );
    this.name = 'AdapterAlreadyRegisteredError';
  }
}

/**
 * Thrown when referencing an adapter name that isn't in the registry.
 */
export class AdapterNotFoundError extends NetworkAIError {
  constructor(adapterName: string) {
    super(
      `Adapter "${adapterName}" is not registered`,
      'ADAPTER_NOT_FOUND',
      { adapterName },
    );
    this.name = 'AdapterNotFoundError';
  }
}

/**
 * Thrown when calling executeAgent on an adapter before it has been initialized.
 */
export class AdapterNotInitializedError extends NetworkAIError {
  constructor(adapterName: string) {
    super(
      `Adapter "${adapterName}" is not initialized. Call initialize() first.`,
      'ADAPTER_NOT_INITIALIZED',
      { adapterName },
    );
    this.name = 'AdapterNotInitializedError';
  }
}

// ============================================================================
// ORCHESTRATOR ERRORS
// ============================================================================

/**
 * Thrown when too many parallel agents are requested.
 */
export class ParallelLimitError extends NetworkAIError {
  constructor(requested: number, maximum: number) {
    super(
      `Cannot spawn ${requested} agents. Maximum is ${maximum}. Decompose further or use 'chain' strategy.`,
      'PARALLEL_LIMIT_EXCEEDED',
      { requested, maximum },
    );
    this.name = 'ParallelLimitError';
  }
}

/**
 * Thrown when an operation exceeds its timeout.
 */
export class TimeoutError extends NetworkAIError {
  constructor(timeoutMs: number) {
    super(
      `Operation timed out after ${timeoutMs}ms`,
      'TIMEOUT',
      { timeoutMs },
    );
    this.name = 'TimeoutError';
  }
}
