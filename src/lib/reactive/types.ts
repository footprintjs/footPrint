/**
 * reactive/types -- Type definitions for the TypedScope<T> reactive proxy system.
 *
 * TypedScope<T> wraps a ReactiveTarget (ScopeFacade) in a Proxy that provides
 * typed property access. All scope infrastructure methods are $-prefixed to
 * avoid collisions with user state keys.
 *
 * Dependency: type-only imports from engine/ and scope/ (zero runtime cost).
 */

import type { ExecutionEnv } from '../engine/types.js';
import type { Recorder } from '../scope/types.js';

// -- ReactiveTarget ----------------------------------------------------------
// Minimum protocol required by TypedScope -- a curated subset of ScopeFacade's
// public API. Not a full mirror: excludes internal/redaction methods that are
// handled at the executor level (useRedactionPolicy, useSharedRedactedKeys, etc.)
// and infrastructure methods (getPipelineId, setGlobal, getGlobal, etc.).

export interface ReactiveTarget {
  // State access (tracked by recorders)
  getValue(key?: string): unknown;
  setValue(key: string, value: unknown, shouldRedact?: boolean, description?: string): void;
  updateValue(key: string, value: unknown, description?: string): void;
  deleteValue(key: string, description?: string): void;

  // Non-tracking state inspection (for proxy internals — no recorder dispatch)
  /** Returns all state keys without firing onRead. Used by ownKeys/has traps. */
  getStateKeys?(): string[];
  /** Check key existence without firing onRead. Used by has trap. */
  hasKey?(key: string): boolean;
  /** Read state without firing onRead. Used by array proxy getCurrent(). */
  getValueSilent?(key?: string): unknown;

  // Input & environment (readonly, NOT tracked)
  getArgs<T = Record<string, unknown>>(): T;
  getEnv(): Readonly<ExecutionEnv>;

  // Recorder management
  attachRecorder(recorder: Recorder): void;
  detachRecorder(recorderId: string): void;
  getRecorders(): Recorder[];

  // Diagnostics
  addDebugInfo(key: string, value: unknown): void;
  addDebugMessage(value: unknown): void;
  addErrorInfo(key: string, value: unknown): void;
  addMetric(name: string, value: unknown): void;
  addEval(name: string, value: unknown): void;

  // Emit channel (Phase 3) — structured user-authored events to EmitRecorders.
  emitEvent(name: string, payload?: unknown): void;

  // Detach (T4) — fire-and-forget child flowcharts. ScopeFacade
  // delegates to `detach/spawn`, minting refIds from this stage's
  // runtimeStageId for diagnostic correlation.
  detachAndJoinLater(
    driver: import('../detach/types.js').DetachDriver,
    child: import('../builder/types.js').FlowChart,
    input?: unknown,
  ): import('../detach/types.js').DetachHandle;

  detachAndForget(
    driver: import('../detach/types.js').DetachDriver,
    child: import('../builder/types.js').FlowChart,
    input?: unknown,
  ): void;
}

// -- ScopeMethods ------------------------------------------------------------
// $-prefixed escape hatches. Non-enumerable on the proxy -- don't appear in
// Object.keys(), destructuring, or for...in. Only state keys are visible.

export interface ScopeMethods {
  // State (untyped escape hatch -- for dynamic keys, redaction, description)
  $getValue(key: string): unknown;
  $setValue(key: string, value: unknown, shouldRedact?: boolean, description?: string): void;
  $update(key: string, value: unknown, description?: string): void;
  $delete(key: string, description?: string): void;
  /** Proxy-synthesized: calls getValue(rootKey) then lodash.get for nested path. Not a direct delegation. */
  $read(dotPath: string): unknown;

  // Input & environment (readonly)
  $getArgs<T = Record<string, unknown>>(): T;
  $getEnv(): Readonly<ExecutionEnv>;

  // Observability — legacy diagnostic primitives.
  //
  // As of Phase 3 these ALSO dispatch on the emit channel (in addition to
  // their existing `DiagnosticCollector` side-bag writes for snapshot
  // inclusion). Any attached `EmitRecorder` will see these events with
  // the corresponding namespaced names:
  //
  //   $debug(key, value)    -> emits `log.debug.${key}`
  //   $error(key, value)    -> emits `log.error.${key}`
  //   $metric(name, value)  -> emits `metric.${name}`
  //   $eval (name, value)   -> emits `eval.${name}`
  //   $log(value)           -> emits `log.debug.messages`
  //
  // This makes the calls observable in real time — no loss of backward
  // compat; the side bag continues to populate for consumers that inspect
  // the snapshot directly.
  $debug(key: string, value: unknown): void;
  $log(value: unknown): void;
  $error(key: string, value: unknown): void;
  $metric(name: string, value: unknown): void;
  $eval(name: string, value: unknown): void;

  // Recorder management
  $attachRecorder(recorder: Recorder): void;
  $detachRecorder(recorderId: string): void;
  $getRecorders(): Recorder[];

  /**
   * Batch-mutate an array key in a single clone+write cycle.
   *
   * Every `scope.items.push(x)` clones the entire array and commits it — O(N) per call.
   * For N mutations on an M-length array that is O(N×M). Use `$batchArray` to clone once,
   * apply all mutations inside `fn`, then commit once — O(M) total.
   *
   * ```typescript
   * // Before: 1000 clones × growing array = O(N²)
   * for (let i = 0; i < 1000; i++) scope.items.push(i);
   *
   * // After: 1 clone + 1 commit = O(N)
   * scope.$batchArray('items', (arr) => {
   *   for (let i = 0; i < 1000; i++) arr.push(i);
   * });
   * ```
   *
   * `fn` receives a plain (non-proxy) mutable **shallow copy** of the current array.
   * The array itself is a new instance, but object references inside it are shared with
   * the original state — mutations to nested objects inside `fn` affect those originals.
   * Only push/pop/sort/splice and other operations that change the array's own slots are
   * safely isolated.
   *
   * Mutations inside `fn` are NOT tracked individually — only the final committed array
   * appears in the narrative as a single write. If the key does not exist or is not an
   * array, `fn` receives an empty array and the result is committed as the new value.
   *
   * If `fn` throws, `setValue` is never called and state remains unchanged (atomic on
   * error). The exception propagates to the caller.
   *
   * `key` is untyped (`string`) — TypeScript will not catch typos. `arr` is typed as
   * `unknown[]` because `ScopeMethods` is not parameterized by `T`; cast inside `fn`
   * when element types are known: `(arr as string[]).push(x)`.
   */
  $batchArray(key: string, fn: (arr: unknown[]) => void): void;

  // Observability — Emit channel (Phase 3)
  /**
   * Fire a structured event to every attached recorder implementing
   * `onEmit`. The primary primitive for consumer-authored observability
   * events (LLM tokens, billing metrics, domain milestones, etc.) that
   * shouldn't live in scope state.
   *
   * Synchronous, pass-through — delivered to recorders immediately, in
   * call order. Zero-allocation when no recorders are attached.
   *
   * ## Naming convention
   *
   * Use hierarchical dotted names: `'<namespace>.<category>.<event>'`.
   * Examples:
   *   - `'agentfootprint.llm.tokens'`
   *   - `'myapp.billing.spend'`
   *   - `'auth.check.denied'`
   *
   * The library stays vocabulary-agnostic — no central registry, no
   * reserved prefixes. Namespace prefixes prevent collisions across
   * libraries and apps naturally.
   *
   * ## Redaction
   *
   * If `RedactionPolicy.emitPatterns` matches the name, the payload is
   * replaced with `'[REDACTED]'` before dispatch. No recorder ever sees
   * the raw value for redacted event names.
   *
   * @param name - Consumer-chosen event identifier (see naming convention).
   * @param payload - Structured data to attach. Shape is up to the
   *   consumer; library treats it as opaque.
   *
   * @example
   * ```typescript
   * scope.$emit('agentfootprint.llm.tokens', { input: 100, output: 50 });
   * scope.$emit('myapp.decision', { branch: 'approved', confidence: 0.92 });
   * ```
   */
  $emit(name: string, payload?: unknown): void;

  // Detach — fire-and-forget child flowchart execution.
  //
  // `$detachAndJoinLater(driver, child, input?)` schedules the child via
  // the given driver and returns a `DetachHandle` the consumer can read
  // synchronously (`.status`) or await (`.wait()`). The parent stage
  // does NOT block on the child — it returns to the agent loop the
  // moment the driver's `schedule()` returns (passive recorder rule).
  //
  // `$detachAndForget(driver, child, input?)` discards the handle —
  // useful for fire-and-forget telemetry where the caller never needs
  // to know how the child finished. Errors still land on the (now-
  // dropped) handle and go silent unless an observer surfaces them.
  //
  // Driver is REQUIRED — there's no library-default. Pass e.g.
  // `microtaskBatchDriver` (from 'footprintjs/detach') or your own
  // custom driver. Explicit passing avoids global state and keeps the
  // engine free of driver imports.
  $detachAndJoinLater(
    driver: import('../detach/types.js').DetachDriver,
    child: import('../builder/types.js').FlowChart,
    input?: unknown,
  ): import('../detach/types.js').DetachHandle;

  $detachAndForget(
    driver: import('../detach/types.js').DetachDriver,
    child: import('../builder/types.js').FlowChart,
    input?: unknown,
  ): void;

  // Pipeline control
  /**
   * Stop the current execution context.
   *
   * - **In a top-level chart:** the traverser exits cleanly after this stage
   *   completes.
   * - **Inside a subflow:** by default, only the subflow's own execution
   *   stops; control returns to the parent as normal. If the subflow is
   *   mounted with `propagateBreak: true`, the break signal (and its
   *   optional reason) propagates up to the parent scope, terminating the
   *   outer loop too. See `SubflowMountOptions.propagateBreak`.
   *
   * @param reason - Optional free-form string describing why the break
   *   happened. Propagates to `FlowBreakEvent.reason` so recorders and
   *   custom narratives can surface it. Defaults to undefined.
   */
  $break(reason?: string): void;

  // Escape hatch -- unwrap to underlying ReactiveTarget
  $toRaw(): ReactiveTarget;
}

// -- TypedScope<T> -----------------------------------------------------------
// The consumer-facing type. T is the user's state interface.
// Property access is typed; $-methods provide escape hatches.

export type TypedScope<T extends object = Record<string, unknown>> = T & ScopeMethods;

// -- ReactiveOptions ---------------------------------------------------------
// Configuration passed to createTypedScope.

export interface ReactiveOptions {
  /**
   * Pipeline break function — injected by StageRunner after scope creation.
   * Accepts an optional reason string that propagates to `FlowBreakEvent`
   * and (when `propagateBreak` is set on a mount) up to the parent scope.
   */
  breakPipeline?: (reason?: string) => void;
}

// -- Internal: $-method name set ---------------------------------------------
// Used by the Proxy get trap to distinguish $-methods from state keys.

export const SCOPE_METHOD_NAMES = new Set<string>([
  '$getValue',
  '$setValue',
  '$update',
  '$delete',
  '$read',
  '$getArgs',
  '$getEnv',
  '$debug',
  '$log',
  '$error',
  '$metric',
  '$eval',
  '$attachRecorder',
  '$detachRecorder',
  '$getRecorders',
  '$batchArray',
  '$break',
  '$emit',
  '$detachAndJoinLater',
  '$detachAndForget',
  '$toRaw',
]);

// -- Internal: Symbol for deferred break injection ---------------------------
// StageRunner sets this after scope creation so $break() works.
// Private Symbol (not Symbol.for) to prevent cross-module tampering.

export const BREAK_SETTER = Symbol('footprint:reactive:setBreak');

// -- Internal: Symbol for TypedScope detection -------------------------------
// Used by StageRunner to skip createProtectedScope for TypedScope instances.
// Private Symbol prevents string-tag spoofing.

export const IS_TYPED_SCOPE = Symbol('footprint:reactive:isTypedScope');

// -- Internal: executor method allowlist -------------------------------------
// ScopeFacade methods called by FlowChartExecutor wrapping code and StageRunner
// THROUGH a TypedScope proxy. Only add methods with confirmed call sites.
// Shared between createTypedScope.ts and StageRunner.ts to prevent drift.

export const EXECUTOR_INTERNAL_METHODS = new Set([
  'notifyStageStart', // StageRunner.run() line 59
  'notifyStageEnd', // StageRunner.run() line 79
  'notifyPause', // StageRunner.run() — pause detection
  'attachRecorder', // FlowChartExecutor.createTraverser() — narrative + user recorders
  'detachRecorder', // FlowChartExecutor.detachRecorder()
  'getRecorders', // FlowChartExecutor.getRecorders()
  'useSharedRedactedKeys', // FlowChartExecutor.createTraverser() — redaction wrapping
  'useRedactionPolicy', // FlowChartExecutor.createTraverser() — redaction wrapping
]);
