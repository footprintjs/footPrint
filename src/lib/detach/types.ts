/**
 * detach/types.ts — Type definitions for the fire-and-forget primitive.
 *
 * Pattern:  Strategy + Bridge (GoF). Same shape as cache strategies in
 *           agentfootprint v2.6 — ONE interface, N concrete drivers,
 *           consumer picks via explicit import.
 * Role:     Foundation. Every other detach file imports from here.
 *           This is the lockable contract; downstream files implement it.
 *
 * Two sibling concepts:
 *
 *   1. `DetachDriver` — the algorithm that decides WHEN/HOW the work runs.
 *      Six built-in algorithms ship as algorithm-named exports
 *      (`microtaskBatchDriver`, `setImmediateDriver`, `sendBeaconDriver`,
 *      `setTimeoutDriver`, `immediateDriver`, `workerThreadDriver`).
 *      Consumers can implement their own (BYOS — bring your own driver).
 *
 *   2. `DetachHandle` — the consumer-facing handle returned by
 *      `detachAndJoinLater`. Exposes status as PROPERTIES (sync read)
 *      and `wait()` (Promise — opt-in async join). Style 2 from the
 *      panel review: properties for sync, single method for async.
 *
 * Naming policy (locked from naming review):
 *   - Public API uses simple verbs / properties (product-engineer friendly)
 *   - Internal class names CAN use CS terms (Scheduler, Continuation, etc.)
 *   - Drivers are algorithm-named (semantic at the algorithm level)
 *
 * Locked design decisions (panel review captured in
 * `docs/inspiration/detach-primitive.md`):
 *   - Sync hot path; async only at flush boundaries
 *   - Errors → commitLog + typed event, NEVER thrown to parent
 *   - Scope isolation between parent and detached child
 *   - Lifecycle tied to executor disposal
 *   - Type-level rejection of `outputMapper` on detach options
 */

import type { FlowChart } from '../builder/types.js';

// ─── DetachHandle — what the consumer gets back ──────────────────────

/**
 * Snapshot of a detached handle's state. Returned by `handle.poll()`
 * (when added in a follow-up; v1 exposes properties directly on
 * `DetachHandle`).
 */
export interface DetachPollResult {
  readonly status: DetachHandle['status'];
  /** Present iff status === 'done'. */
  readonly result?: unknown;
  /** Present iff status === 'failed'. */
  readonly error?: Error;
}

/**
 * Result delivered when the handle's `wait()` Promise resolves
 * successfully (status reached 'done'). Rejection delivers the
 * native `Error` directly — no wrapping shape.
 */
export interface DetachWaitResult {
  readonly result: unknown;
}

/**
 * Handle returned by `chart.detachAndJoinLater(...)` and
 * `executor.detachAndJoinLater(...)`. Exposes status as PROPERTIES so
 * sync access is property-read (cheap, no allocation). The single
 * method `wait()` returns a Promise for opt-in async join.
 *
 * The handle is **not** Promise-shaped (no `.then()`) — that would
 * make it accidentally awaitable, defeating the fire-and-forget
 * semantics. To await, the consumer must call `.wait()` explicitly.
 *
 * Lifecycle:
 *
 *   queued  → driver received the work, hasn't started it
 *   running → driver started the work
 *   done    → terminal: result available
 *   failed  → terminal: error available
 *
 * `done` and `failed` are TERMINAL — once reached, status never
 * changes again.
 */
export interface DetachHandle {
  /** Stable id assigned at detach time. Used as the lookup key in
   *  `detachRegistry` and as the scope-storage key prefix. */
  readonly id: string;

  /** Current state. Read directly for sync access. */
  readonly status: 'queued' | 'running' | 'done' | 'failed';

  /** The work's result. Present iff `status === 'done'`. Reading
   *  before terminal returns `undefined`. */
  readonly result?: unknown;

  /** The work's error. Present iff `status === 'failed'`. Reading
   *  before terminal returns `undefined`. */
  readonly error?: Error;

  /**
   * Opt-in async join. Returns a Promise that:
   *   - resolves with `{ result }` when status becomes 'done'
   *   - rejects with the captured `Error` when status becomes 'failed'
   *   - resolves/rejects IMMEDIATELY if status is already terminal
   *   - returns the SAME cached Promise on repeated calls (no
   *     re-running, no duplicated I/O)
   *
   * Calling `wait()` does NOT change the handle's lifecycle — it's
   * passive observation. If never called, the work still completes;
   * the handle just goes uncollected (parent execution unaffected).
   *
   * Use when:
   *   - You actually need the result and want to await it
   *   - Coordinating multiple handles via Promise.all / Promise.race
   *   - Backpressure ("don't fire more than N in flight")
   *
   * Don't use when:
   *   - Pure fire-and-forget (use `detachAndForget` — no handle returned)
   *   - You just want to check status (read `handle.status` directly)
   */
  wait(): Promise<DetachWaitResult>;
}

// ─── DetachDriver — the algorithm interface ──────────────────────────

/**
 * Capabilities a driver declares. Drives the runtime decision of
 * "is this driver appropriate for the current environment?" Consumers
 * inspect at construction; the framework doesn't enforce.
 *
 * All capabilities are optional flags — false / undefined means "not
 * supported / no claim." A driver that supports everything sets all
 * to true.
 */
export interface DriverCapabilities {
  /** Driver works in browser environments (window, document, etc.). */
  readonly browserSafe?: boolean;
  /** Driver works in Node.js environments. */
  readonly nodeSafe?: boolean;
  /** Driver works in edge runtimes (Cloudflare Workers, Deno Deploy,
   *  Bun edge, etc. — restricted environments). */
  readonly edgeSafe?: boolean;
  /** Work survives page-unload / process-exit. e.g.,
   *  `sendBeaconDriver` schedules via `navigator.sendBeacon` which
   *  ships even on tab close. */
  readonly survivesUnload?: boolean;
  /** Work runs on a separate OS thread (no event-loop block).
   *  e.g., `workerThreadDriver`. */
  readonly cpuIsolated?: boolean;
}

/**
 * A driver is the WHEN/HOW of the detach. Maps `(child, input, refId)`
 * to a `DetachHandle` whose lifecycle the driver owns.
 *
 * Drivers are themselves footprintjs primitives — internally they may
 * be a single function or a multi-stage flowChart. Either way, the
 * interface they expose to consumers is `schedule(...)`.
 *
 * Drivers MUST:
 *   - Return synchronously (the agent loop never blocks on schedule)
 *   - Not throw — errors during scheduling route through the handle
 *     (`handle.status = 'failed'`, `handle.error = ...`)
 *   - Honor the passive-recorder rule: the parent's `detach*` call
 *     never waits for the driver's deferred work to complete
 *
 * Drivers MAY:
 *   - Implement `validate()` for one-time configuration checks at
 *     registration / use time (e.g., assert `navigator.sendBeacon` exists)
 *   - Build their internal pipeline as a footprintjs flowChart for
 *     observability — driver implementation detail, not consumer-facing
 *
 * @example Built-in
 *   import { microtaskBatchDriver } from 'footprintjs/detach';
 *   const handle = driver.schedule(child, input, refId);
 *
 * @example Custom (BYOS)
 *   const lambdaExtensionDriver: DetachDriver = {
 *     name: 'lambda-extension',
 *     capabilities: { nodeSafe: true, survivesUnload: true },
 *     schedule(child, input, refId) {
 *       sharedBuffer.push({ refId, child, input });
 *       return createHandle(refId, 'queued');
 *     },
 *   };
 */
export interface DetachDriver {
  /** Stable name for diagnostics + registry lookup. Conventionally
   *  algorithm-named (e.g. `'microtask-batch'`, `'send-beacon'`). */
  readonly name: string;

  /** What this driver supports. Used by consumers to pick the right
   *  driver for their environment. */
  readonly capabilities: DriverCapabilities;

  /**
   * Hand the work to the driver's scheduling mechanism. MUST return
   * synchronously with a fresh `DetachHandle`. The actual work may
   * run later (next microtask / setImmediate / browser-beacon-flush /
   * worker-thread / etc.) on the driver's chosen mechanism.
   */
  schedule(child: FlowChart, input: unknown, refId: string): DetachHandle;

  /**
   * Optional one-time validation hook. Called at first use (or
   * registration time, depending on driver) — drivers throw if their
   * configuration is invalid (missing peer dep, unreachable endpoint,
   * wrong API key shape, etc.).
   *
   * Example: `sendBeaconDriver.validate()` checks
   * `typeof navigator?.sendBeacon === 'function'` and throws with a
   * helpful message if absent (e.g., in Node).
   *
   * Per the New Relic panel review: early-fail-with-useful-message
   * beats silent zero-emission.
   */
  validate?(): void;
}
