/**
 * Scope Type Definitions
 *
 * Core types for the composable Scope system with pluggable Recorders.
 * Architecture follows composition-over-inheritance: Recorders are
 * attached to Scope instances to observe read/write/commit operations.
 */

// ============================================================================
// Event Types
// ============================================================================

export interface RecorderContext {
  stageName: string;
  pipelineId: string;
  timestamp: number;
}

export interface ReadEvent extends RecorderContext {
  key?: string;
  value: unknown;
  /** True when the value has been redacted for PII protection. */
  redacted?: boolean;
}

export interface WriteEvent extends RecorderContext {
  key: string;
  value: unknown;
  operation: 'set' | 'update' | 'delete';
  /** True when the value has been redacted for PII protection. */
  redacted?: boolean;
}

export interface CommitEvent extends RecorderContext {
  mutations: Array<{
    key: string;
    value: unknown;
    operation: 'set' | 'update' | 'delete';
  }>;
}

export interface ErrorEvent extends RecorderContext {
  error: Error;
  operation: 'read' | 'write' | 'commit';
  key?: string;
}

export interface StageEvent extends RecorderContext {
  duration?: number;
}

// ============================================================================
// Recorder Interface
// ============================================================================

/**
 * Pluggable observer for scope operations.
 *
 * All methods are optional — implement only the hooks you need.
 * Recorders are invoked synchronously in attachment order.
 * If a recorder throws, the error is caught and passed to onError
 * hooks of other recorders; the scope operation continues normally.
 */
export interface Recorder {
  readonly id: string;
  onRead?(event: ReadEvent): void;
  onWrite?(event: WriteEvent): void;
  onCommit?(event: CommitEvent): void;
  onError?(event: ErrorEvent): void;
  onStageStart?(event: StageEvent): void;
  onStageEnd?(event: StageEvent): void;
}
