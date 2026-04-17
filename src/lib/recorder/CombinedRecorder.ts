/**
 * CombinedRecorder — a single observer that can hook into MULTIPLE event
 * streams (currently: scope data-flow + control-flow). One object, one `id`,
 * one consistent view of the execution.
 *
 * ## Why this exists
 *
 * Before `CombinedRecorder`, a consumer who wanted to observe both streams
 * had to:
 *   1. Implement both `Recorder` (8 methods) and `FlowRecorder` (12 methods)
 *      fully — stubbing every event they didn't care about.
 *   2. Remember to call BOTH `attachRecorder(r)` AND `attachFlowRecorder(r)`.
 *      Forgetting the second call silently dropped half their events — no
 *      warning, no runtime error.
 *   3. Re-implement coordination logic (buffering, ordering) themselves.
 *
 * `CombinedRecorder` collapses that into a single type and a single attach
 * call (`executor.attachCombinedRecorder(r)`), with the library handling the
 * routing internally. Consumers implement only the events they care about
 * (`Partial<...>`) and the attach method duck-types at runtime to dispatch
 * to the relevant channels.
 *
 * ## Forward compatibility
 *
 * When a third observer type is added (e.g. an `OperationRecorder`), the
 * `CombinedRecorder` type gains an `& Partial<OperationRecorder>` clause and
 * `attachCombinedRecorder` gains one more runtime branch in its dispatch.
 * Consumers writing a `CombinedRecorder` today are NOT affected — their
 * code keeps compiling and attaching correctly, because every new layer is
 * optional.
 *
 * ## Example
 *
 * ```typescript
 * import type { CombinedRecorder } from 'footprintjs';
 *
 * const audit: CombinedRecorder = {
 *   id: 'audit',
 *   onWrite: (e) => logWrite(e.key, e.value),        // Recorder method
 *   onDecision: (e) => logDecision(e.chosen),        // FlowRecorder method
 * };
 *
 * executor.attachCombinedRecorder(audit);
 * // ^ internally: detects both sets of methods, routes to both channels.
 * ```
 *
 * ## Contract with existing APIs
 *
 * - `attachRecorder(r)` and `attachFlowRecorder(r)` remain unchanged.
 *   Consumers who want only ONE channel keep using them — explicit is good.
 * - `attachCombinedRecorder(r)` is the ONLY way to guarantee an object is
 *   hooked into every stream it has methods for, without maintaining two
 *   attach calls at the call site.
 * - Idempotency by `id` is preserved across channels: re-attaching with the
 *   same `id` replaces the previous instance on BOTH channels, not just one.
 */

import type { FlowErrorEvent, FlowPauseEvent, FlowRecorder, FlowResumeEvent } from '../engine/narrative/types.js';
import type { ErrorEvent, PauseEvent, Recorder, ResumeEvent } from '../scope/types.js';
import type { EmitRecorder } from './EmitRecorder.js';

/**
 * Method names that appear on BOTH `Recorder` and `FlowRecorder` but with
 * different event payload types. For these, a `CombinedRecorder` declares
 * ONE handler that receives the union of both payloads — consumers
 * discriminate on `traversalContext`, which only control-flow events carry.
 */
type SharedLifecycleOverlap = 'onError' | 'onPause' | 'onResume';

/** Lifecycle hooks (not event-specific) that both interfaces share identically. */
type SharedLifecycle = 'id' | 'clear' | 'toSnapshot';

/**
 * A recorder that MAY observe any combination of supported event streams.
 *
 * Today's streams:
 *   - Scope data-flow (`Recorder`: onRead/onWrite/onCommit/onStageStart/…)
 *   - Control-flow (`FlowRecorder`: onDecision/onSubflowEntry/onLoop/…)
 *
 * All event handlers are optional — implement only what you care about.
 * `id` is required so the library can deduplicate re-attaches.
 *
 * ## Shared method names (onError / onPause / onResume)
 *
 * Both `Recorder` and `FlowRecorder` declare these with DIFFERENT payload
 * shapes. In a combined recorder, each such handler is called by BOTH
 * channels with its own variant. The parameter type is a union — consumers
 * can either handle both variants uniformly, or discriminate (control-flow
 * variants carry a `traversalContext` field that data-flow variants lack).
 *
 * ## Forward compatibility
 *
 * When a third observer type ships (e.g. `OperationRecorder`), the type
 * gains another `& Partial<…>` clause. Because every clause is `Partial`,
 * existing `CombinedRecorder` implementations remain type-valid.
 */
export type CombinedRecorder = Partial<Omit<Recorder, SharedLifecycleOverlap | SharedLifecycle>> &
  Partial<Omit<FlowRecorder, SharedLifecycleOverlap | SharedLifecycle>> &
  // Emit channel — new third stream (Phase 3). No method-name overlap with
  // the other two interfaces, so a plain intersection is sound — no
  // union-payload discriminator needed.
  Partial<Omit<EmitRecorder, SharedLifecycle>> & {
    readonly id: string;

    // Shared lifecycle hooks — same on both interfaces, shape compatible.
    clear?(): void;
    toSnapshot?(): {
      name: string;
      description?: string;
      preferredOperation?: 'translate' | 'accumulate' | 'aggregate';
      data: unknown;
    };

    // Shared event method names with DIVERGENT payloads — declared as unions.
    // Consumers either handle both variants, or discriminate using the
    // exported helper `isFlowEvent()` (which checks for the
    // `traversalContext` field — present only on control-flow variants).
    //
    // @example
    // ```ts
    // const audit: CombinedRecorder = {
    //   id: 'audit',
    //   onError: (e) => {
    //     if (isFlowEvent(e)) {
    //       // e is FlowErrorEvent — has stageName, message, structuredError
    //       log('flow error in stage', e.stageName);
    //     } else {
    //       // e is ErrorEvent — has error, operation, key?
    //       log('scope error during', e.operation, e.error.message);
    //     }
    //   },
    // };
    // ```
    onError?(event: ErrorEvent | FlowErrorEvent): void;
    onPause?(event: PauseEvent | FlowPauseEvent): void;
    onResume?(event: ResumeEvent | FlowResumeEvent): void;
  };

/**
 * Discriminator for the union payload types on `CombinedRecorder`'s shared
 * methods (`onError`, `onPause`, `onResume`). Returns `true` if the event
 * was emitted from the control-flow channel (FlowRecorder).
 *
 * ## How it discriminates
 *
 * Scope-channel events extend `RecorderContext`, which carries `pipelineId`.
 * Flow-channel events do not carry `pipelineId` (they carry an optional
 * `traversalContext` instead, but that field is optional and cannot be
 * relied on as a positive signal). We detect the flow variant by the
 * ABSENCE of `pipelineId` — this is schema-stable as long as scope events
 * continue to extend `RecorderContext`.
 *
 * @example
 * ```ts
 * onError: (e) => {
 *   if (isFlowEvent(e)) {
 *     // Narrowed to FlowErrorEvent: has stageName, message, structuredError
 *   } else {
 *     // Narrowed to ErrorEvent: has error, operation, key?
 *   }
 * }
 * ```
 */
export function isFlowEvent<T>(event: T): event is Exclude<T, { pipelineId: string }> {
  if (typeof event !== 'object' || event === null) return false;
  return (event as Record<string, unknown>).pipelineId === undefined;
}

/**
 * Method names belonging to the `Recorder` (data-flow) interface.
 * Kept as a single source of truth so the runtime duck-type detector stays
 * in sync with the interface. If a method is added to `Recorder`, adding it
 * here is the ONLY change required to route combined-recorders correctly.
 */
const RECORDER_EVENT_METHODS = [
  'onRead',
  'onWrite',
  'onCommit',
  'onError',
  'onStageStart',
  'onStageEnd',
  'onPause',
  'onResume',
] as const;

/**
 * Method names belonging to the `FlowRecorder` (control-flow) interface.
 * See the note on `RECORDER_EVENT_METHODS`.
 *
 * NOTE: the `onError`, `onPause`, `onResume` methods exist on BOTH interfaces
 * with DIFFERENT event payload shapes. A `CombinedRecorder` that implements
 * any of these receives both variants (one from each channel). Consumers who
 * care about the distinction can discriminate on the presence of
 * `traversalContext` (which only control-flow events carry).
 */
const FLOW_RECORDER_EVENT_METHODS = [
  'onStageExecuted',
  'onNext',
  'onDecision',
  'onFork',
  'onSelected',
  'onSubflowEntry',
  'onSubflowExit',
  'onSubflowRegistered',
  'onLoop',
  'onBreak',
  'onError',
  'onPause',
  'onResume',
] as const;

/**
 * Method names belonging to the `EmitRecorder` (user-emitted events)
 * interface. Same convention as the other two arrays above — kept as
 * the single source of truth for duck-type detection.
 */
const EMIT_RECORDER_EVENT_METHODS = ['onEmit'] as const;

/**
 * True iff the recorder declares a method named `m` either as an own
 * property OR on its class-prototype chain — but NOT inherited from
 * `Object.prototype`.
 *
 * ## Why this layered check
 *
 * A `CombinedRecorder` can be either a plain object literal (handlers as
 * own properties) OR a class instance (handlers as class-prototype
 * methods). Both are legitimate consumer patterns and both MUST attach.
 *
 * But handlers inherited from `Object.prototype` are ALWAYS accidental or
 * malicious (nobody legitimately attaches recorder methods there). So we
 * walk the prototype chain, STOPPING before `Object.prototype`. This
 * accepts class methods while still blocking `Object.prototype`
 * pollution attacks.
 */
function hasOwnOrClassMethod(r: unknown, m: string): boolean {
  if (r === null || typeof r !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(r, m)) {
    return typeof (r as Record<string, unknown>)[m] === 'function';
  }
  let proto: unknown = Object.getPrototypeOf(r);
  while (proto !== null && proto !== Object.prototype) {
    if (Object.prototype.hasOwnProperty.call(proto, m)) {
      return typeof (proto as Record<string, unknown>)[m] === 'function';
    }
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

/**
 * True iff the recorder implements at least one data-flow event method.
 * Used by `executor.attachCombinedRecorder` to decide whether to hook into
 * the scope data-flow channel.
 *
 * ## Detection rule
 *
 * Accepts both object-literal recorders (own-property handlers) AND class
 * instances (handlers declared on the class prototype). Rejects handlers
 * inherited from `Object.prototype` — that's always accidental or
 * malicious pollution, never a legitimate recorder.
 *
 * ## Lifecycle exclusions
 *
 * `clear` and `toSnapshot` are NOT counted as event methods — a recorder
 * that only implements those has nothing to observe and would be a no-op
 * on either channel.
 *
 * ## Return type
 *
 * Returns plain `boolean` (not a type predicate). The full `Recorder`
 * interface has payload types that diverge from `CombinedRecorder`'s union
 * variants for shared methods, so a narrowing predicate would be unsound.
 * Callers that need to treat the recorder as a `Recorder` do so explicitly
 * at the attach site — the cast is the contract that each channel passes
 * its own payload variant.
 */
export function hasRecorderMethods(r: CombinedRecorder): boolean {
  return RECORDER_EVENT_METHODS.some((m) => hasOwnOrClassMethod(r, m));
}

/**
 * True iff the recorder implements at least one control-flow event method.
 * See `hasRecorderMethods`.
 */
export function hasFlowRecorderMethods(r: CombinedRecorder): boolean {
  return FLOW_RECORDER_EVENT_METHODS.some((m) => hasOwnOrClassMethod(r, m));
}

/**
 * True iff the recorder implements at least one emit-channel event method.
 * See `hasRecorderMethods` for the ownership-detection rules (own or
 * class-prototype methods count; `Object.prototype` pollution does not).
 */
export function hasEmitRecorderMethods(r: CombinedRecorder): boolean {
  return EMIT_RECORDER_EVENT_METHODS.some((m) => hasOwnOrClassMethod(r, m));
}
