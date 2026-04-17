/**
 * EmitRecorder — the third observer channel, alongside `Recorder`
 * (scope data-flow) and `FlowRecorder` (control-flow).
 *
 * ## Why this exists
 *
 * The first two channels capture what the LIBRARY knows about — scope
 * reads/writes fired by `setValue`, and control-flow events fired by the
 * traverser. But **user-emitted structured events** — things a stage
 * function wants to surface for observability (LLM tokens, billing metrics,
 * auth decisions, domain milestones) — have nowhere to go today. They land
 * in unobserved `DiagnosticCollector` side bags that no recorder watches.
 *
 * This channel closes that gap. Consumer calls `scope.$emit(name, payload)`
 * from inside a stage; the library enriches the event with stage context
 * and dispatches it synchronously to every attached `EmitRecorder`.
 *
 * ## Design properties
 *
 * - **Pass-through, not buffered.** Zero allocation when no recorder is
 *   attached. Events delivered synchronously, in-order, at call time.
 *   Same semantics as `onRead`/`onWrite` already use.
 * - **Library-agnostic vocabulary.** Event names are consumer-chosen strings.
 *   Convention: hierarchical dotted names, e.g. `'agentfootprint.llm.tokens'`,
 *   `'myapp.billing.spend'`. Library enforces no registry.
 * - **Auto-enriched context.** Every event carries `stageName`,
 *   `runtimeStageId`, `subflowPath`, `pipelineId`, `timestamp`. Consumers
 *   never need to thread execution context through their emit payloads.
 * - **Redaction-aware.** `RedactionPolicy.emitPatterns` matches event names
 *   before dispatch — matched events have their payload replaced with
 *   `'[REDACTED]'` so secrets can't leak via emit.
 *
 * ## Relationship to existing channels
 *
 * | Channel         | Fires when                         | Built-in consumers     |
 * |-----------------|------------------------------------|------------------------|
 * | `Recorder`      | scope read/write/commit            | DebugRecorder, MetricRecorder |
 * | `FlowRecorder`  | traversal transitions              | NarrativeFlowRecorder, etc. |
 * | `EmitRecorder`  | consumer calls `scope.$emit(...)`  | (none ships today; Phase 3.X adds MemoryEmitRecorder) |
 *
 * `CombinedRecorder` (from `./CombinedRecorder.ts`) intersects all three
 * via `Partial<...>`. A consumer can write ONE object implementing any
 * combination; `executor.attachCombinedRecorder(r)` duck-types and routes
 * to the right channel(s).
 *
 * @example
 * ```typescript
 * const tokenMeter: EmitRecorder = {
 *   id: 'token-meter',
 *   onEmit(event) {
 *     if (event.name === 'agentfootprint.llm.tokens') {
 *       this.total += (event.payload as { input: number; output: number }).input;
 *     }
 *   },
 *   total: 0,
 * } as any;
 *
 * executor.attachEmitRecorder(tokenMeter);
 * ```
 */

import type { RecorderOperation } from './RecorderOperation.js';

/**
 * Event delivered to `EmitRecorder.onEmit`.
 *
 * Name + payload are consumer-supplied via `scope.$emit(name, payload)`.
 * Everything else is library-enriched at dispatch time from the current
 * stage's execution context.
 */
export interface EmitEvent {
  /**
   * Consumer-supplied event name. Convention: hierarchical dotted namespace
   * (e.g. `'agentfootprint.llm.tokens'`, `'myapp.billing.spend'`). Keeps
   * vocabularies collision-free across libraries/apps without requiring a
   * central registry.
   */
  readonly name: string;

  /**
   * Consumer-supplied payload. Shape is up to the consumer and their
   * convention; library treats it as opaque and passes through unchanged
   * (modulo redaction — see `RedactionPolicy.emitPatterns`).
   *
   * When redacted, replaced with the string `'[REDACTED]'`.
   */
  readonly payload: unknown;

  /** Name of the stage that emitted this event. */
  readonly stageName: string;

  /**
   * Unique per-execution-step identifier — the same value recorder events
   * and commit-log entries carry. See `runtimeStageId.ts` for format.
   */
  readonly runtimeStageId: string;

  /**
   * Subflow path from the outermost parent down to the subflow that emitted
   * this event. Empty array when the emit came from the root flowchart.
   * Matches the convention used by `FlowPauseEvent.subflowPath`,
   * `FlowchartCheckpoint.subflowPath`, etc.
   */
  readonly subflowPath: readonly string[];

  /** Pipeline/run identifier (matches `RecorderContext.pipelineId`). */
  readonly pipelineId: string;

  /** Emission timestamp in milliseconds since epoch (`Date.now()`). */
  readonly timestamp: number;
}

/**
 * Pluggable observer for consumer-emitted structured events.
 *
 * All methods are optional; implement only what you care about. Recorders
 * are invoked synchronously in attachment order. If a recorder throws, the
 * error is caught and isolated — other recorders continue to receive the
 * event and the emitting stage is unaffected.
 */
export interface EmitRecorder {
  /**
   * Stable identifier for idempotent attach/detach. Re-attaching with the
   * same id replaces the previous registration on the executor.
   */
  readonly id: string;

  /** Called for every `scope.$emit(name, payload)` call in any stage. */
  onEmit?(event: EmitEvent): void;

  /**
   * Optional: reset recorder-internal state between runs. Called by the
   * executor before each `run()`.
   */
  clear?(): void;

  /**
   * Optional: expose collected data for inclusion in
   * `executor.getSnapshot().recorders`.
   */
  toSnapshot?(): {
    name: string;
    description?: string;
    preferredOperation?: RecorderOperation;
    data: unknown;
  };
}
