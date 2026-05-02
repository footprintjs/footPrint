/**
 * detach/handle.ts — DetachHandle implementation.
 *
 * Pattern:  Object-as-state-machine. Mutable status field; transitions
 *           are one-way and irreversible (queued → running → done/failed).
 * Role:     Backs the consumer-facing `DetachHandle` interface. The
 *           public surface is the interface (defined in `types.ts`);
 *           this class is the runtime impl.
 *
 * Internal vs public split:
 *   - PUBLIC (in `types.ts`)   — read-only properties + `wait()`
 *   - INTERNAL (this file)     — `_markRunning` / `_markDone` /
 *                                `_markFailed` mutators called by drivers
 *
 * The class implements `DetachHandle` (which has only readonly fields
 * exposed). Drivers cast to `HandleImpl` via the `asImpl()` helper to
 * call the mutators — a controlled escape from readonly. Consumers
 * cannot do this (they only see the interface).
 *
 * Promise caching contract:
 *   - First `wait()` call:
 *       - if status terminal → returns IMMEDIATELY-resolved Promise
 *       - if not terminal    → returns NEW Promise; resolvers stored
 *                              for use by `_markDone` / `_markFailed`
 *   - Subsequent `wait()` calls → returns the SAME cached Promise
 *   - The resolved/rejected value is the SAME on every call (no
 *     re-running, no duplicated work)
 *
 * Concurrency notes:
 *   - All transitions are sync. JavaScript is single-threaded so no
 *     atomics or locks needed.
 *   - State transitions out of terminal states are forbidden — calling
 *     `_markDone` after `_markFailed` (or vice-versa) is a no-op
 *     (defensive: prevents driver bugs from corrupting state).
 */

import type { DetachHandle, DetachWaitResult } from './types.js';

/**
 * Internal handle implementation. Drivers call the `_mark*` methods
 * to drive state transitions; consumers see only the readonly
 * `DetachHandle` interface.
 */
export class HandleImpl implements DetachHandle {
  readonly id: string;
  status: DetachHandle['status'] = 'queued';
  result: unknown = undefined;
  error: Error | undefined = undefined;

  // Lazy Promise cache — created on first `wait()` call.
  private waitPromise: Promise<DetachWaitResult> | null = null;
  // Resolvers captured when wait() was called BEFORE terminal state.
  private resolveWait: ((v: DetachWaitResult) => void) | null = null;
  private rejectWait: ((e: Error) => void) | null = null;

  constructor(id: string) {
    this.id = id;
  }

  /**
   * Public — opt-in async join. Returns a cached Promise.
   * See `DetachHandle.wait()` docstring for contract.
   */
  wait(): Promise<DetachWaitResult> {
    if (this.waitPromise) return this.waitPromise;

    if (this.status === 'done') {
      this.waitPromise = Promise.resolve({ result: this.result });
    } else if (this.status === 'failed') {
      this.waitPromise = Promise.reject(this.error);
    } else {
      // Pending terminal — store resolvers for _markDone / _markFailed.
      this.waitPromise = new Promise<DetachWaitResult>((resolve, reject) => {
        this.resolveWait = resolve;
        this.rejectWait = reject;
      });
    }
    return this.waitPromise;
  }

  // ── Internal mutators (called by drivers) ──────────────────────────

  /** Transition queued → running. No-op if already past 'queued'. */
  _markRunning(): void {
    if (this.status !== 'queued') return;
    this.status = 'running';
  }

  /**
   * Transition to terminal 'done' with the given result. No-op if
   * already terminal (defensive: prevents driver bugs from corrupting
   * state).
   */
  _markDone(result: unknown): void {
    if (this.status === 'done' || this.status === 'failed') return;
    this.status = 'done';
    this.result = result;
    // If consumer already called wait(), unblock its Promise.
    this.resolveWait?.({ result });
    this.resolveWait = null;
    this.rejectWait = null;
  }

  /**
   * Transition to terminal 'failed' with the given error. No-op if
   * already terminal.
   */
  _markFailed(error: Error): void {
    if (this.status === 'done' || this.status === 'failed') return;
    this.status = 'failed';
    this.error = error;
    this.rejectWait?.(error);
    this.resolveWait = null;
    this.rejectWait = null;
  }
}

/**
 * Type-narrowing helper — cast a public `DetachHandle` to its
 * implementation. Drivers (only) use this to call internal mutators.
 *
 * Throws if the handle isn't actually a `HandleImpl` — defends
 * against consumers passing a hand-rolled object that satisfies the
 * interface shape but lacks the mutators.
 */
export function asImpl(handle: DetachHandle): HandleImpl {
  if (!(handle instanceof HandleImpl)) {
    throw new TypeError(
      '[detach] expected a HandleImpl returned by createHandle(); got an arbitrary DetachHandle. ' +
        'Drivers must use createHandle() to construct handles, not hand-roll them.',
    );
  }
  return handle;
}

/**
 * Driver-facing factory. Drivers MUST use this to create handles
 * (NOT construct `HandleImpl` directly — keeps the impl type private).
 */
export function createHandle(id: string): DetachHandle {
  return new HandleImpl(id);
}
