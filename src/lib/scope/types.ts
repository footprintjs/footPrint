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
  /** Stable stage identifier (matches spec node id). */
  stageId: string;
  /** Unique per-execution-step identifier. Format: [subflowPath/]stageId#executionIndex */
  runtimeStageId: string;
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
  /**
   * Explicit channel discriminant — `'scope'` on every engine-dispatched
   * event. `isFlowEvent()` checks it first (backlog B3); optional so
   * consumer-fabricated events (tests, replays) remain type-valid and fall
   * back to the legacy pipelineId-presence heuristic.
   */
  channel?: 'scope';
}

export interface StageEvent extends RecorderContext {
  duration?: number;
}

export interface PauseEvent extends RecorderContext {
  pauseData?: unknown;
  /** Explicit channel discriminant — see {@link ErrorEvent.channel}. */
  channel?: 'scope';
}

export interface ResumeEvent extends RecorderContext {
  hasInput: boolean;
  /** Explicit channel discriminant — see {@link ErrorEvent.channel}. */
  channel?: 'scope';
}

// ============================================================================
// Redaction Policy
// ============================================================================

/**
 * `RedactionPolicy` and `RedactionReport` are OWNED by `memory/redaction.ts`
 * (the ONE owner of the verdict — see the law there); they are re-exported
 * here so the public path `footprintjs` → `RedactionPolicy` is unchanged.
 */
export type { RedactionPolicy, RedactionReport } from '../memory/redaction.js';

// ============================================================================
// ScopeRecorder Interface
// ============================================================================

/**
 * Pluggable observer for scope operations.
 *
 * All methods are optional — implement only the hooks you need.
 * Recorders are invoked synchronously in attachment order.
 * If a recorder throws, the error is caught and passed to onError
 * hooks of other recorders; the scope operation continues normally.
 */
export interface ScopeRecorder {
  readonly id: string;
  onRead?(event: ReadEvent): void;
  onWrite?(event: WriteEvent): void;
  onCommit?(event: CommitEvent): void;
  onError?(event: ErrorEvent): void;
  onStageStart?(event: StageEvent): void;
  onStageEnd?(event: StageEvent): void;
  onPause?(event: PauseEvent): void;
  onResume?(event: ResumeEvent): void;
  /**
   * Fires for every `scope.$emit(name, payload)` call during a stage.
   * Optional — implement only if you want to observe consumer-emitted
   * structured events. See `EmitRecorder` for the focused interface
   * (structurally compatible; this field is the same shape).
   *
   * @see EmitRecorder in `src/lib/recorder/EmitRecorder.ts`
   */
  onEmit?(event: import('../recorder/EmitRecorder.js').EmitEvent): void;
  /** Reset state before each executor.run() — prevents cross-run accumulation. */
  clear?(): void;
  /** Expose collected data for inclusion in executor.getSnapshot().recorders. */
  toSnapshot?(): {
    name: string;
    description?: string;
    preferredOperation?: 'translate' | 'accumulate' | 'aggregate';
    data: unknown;
    /** Machine-readable facts about the bundle itself — see
     *  {@link import('../runner/ExecutionRuntime.js').RecorderSnapshot.meta}. */
    meta?: Readonly<Record<string, unknown>>;
  };
}
