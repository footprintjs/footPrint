/**
 * detach/spawn.ts — One-call detach primitive used by both scope and
 * executor surfaces.
 *
 * Pattern:  Facade (GoF). Hides driver invocation + refId minting +
 *           registry registration behind two named functions
 *           (`detachAndJoinLater`, `detachAndForget`). Same helper is
 *           called from `scope.$detachAndJoinLater(...)` and from
 *           `executor.detachAndJoinLater(...)` — single source of truth.
 *
 * Why a separate module:
 *   - Avoids duplicating the "validate driver, mint refId, call schedule"
 *     sequence in both scope and executor entry points
 *   - Keeps the scope/executor files free of driver knowledge — they
 *     just call this and forward the result
 *
 * refId scheme:
 *   - When the caller is a stage (scope path): refId = `${runtimeStageId}:detach:${counter}`
 *     — the runtimeStageId prefix lets diagnostics correlate the handle
 *     back to the source stage
 *   - When the caller is bare executor (executor path):
 *     refId = `__executor__:detach:${counter}` — uniform "no source stage"
 *     marker
 *   - Counter is module-private + monotonic for the process lifetime —
 *     safe across re-entrant detach calls
 */

import type { FlowChart } from '../builder/types.js';
import type { DetachDriver, DetachHandle } from './types.js';

let counter = 0;

/** Reset the counter for tests — never call from production code. */
export function _resetSpawnCounterForTests(): void {
  counter = 0;
}

/**
 * Mint a refId. Format: `${prefix}:detach:${counter}`. The prefix carries
 * source-stage provenance (or `__executor__` when there is none).
 */
function mintRefId(prefix: string): string {
  counter += 1;
  return `${prefix}:detach:${counter}`;
}

/**
 * Schedule `child` on the given driver, with the consumer's `input`,
 * and return the resulting `DetachHandle`. Callers can `wait()` on it,
 * read its `.status` property, or just hold the reference for later.
 *
 * **Joinable variant** — the caller wants to be able to await the result
 * (or check its status). The `forget` variant simply discards the handle.
 *
 * @param driver - The driver implementation to use. Required (no
 *   library-default — passing it explicitly avoids global state and
 *   keeps the engine free of driver imports).
 * @param child - The child flowchart to run.
 * @param input - The input to hand to the child's run() call.
 * @param sourcePrefix - Refix prefix for the minted refId; pass the
 *   parent's `runtimeStageId` from a stage caller, or `'__executor__'`
 *   from a bare-executor caller.
 */
export function detachAndJoinLater(
  driver: DetachDriver,
  child: FlowChart,
  input: unknown,
  sourcePrefix: string,
): DetachHandle {
  if (!driver || typeof driver.schedule !== 'function') {
    throw new TypeError(
      `[detach] expected a DetachDriver as the first argument; got ${typeof driver}. ` +
        "Pass e.g. `microtaskBatchDriver` from 'footprintjs/detach'.",
    );
  }
  const refId = mintRefId(sourcePrefix);
  return driver.schedule(child, input, refId);
}

/**
 * Same as `detachAndJoinLater` but discards the handle. Use when the
 * caller doesn't care about the result and doesn't need to await — e.g.,
 * fire-and-forget telemetry exports.
 *
 * The handle still exists internally (driver creates it, registry holds
 * it briefly) — but the caller cannot reference it. This is intentional:
 * having no handle reference is what gives "forget" its semantic — there
 * is no chance of the caller accidentally awaiting it.
 *
 * Errors raised by the child are STILL routed to the handle's failed
 * state (the driver does that). They just go unobserved unless something
 * else (a recorder, logging) is wired to surface them. See the docs in
 * T7 for recommended observability patterns for "forget" detach.
 */
export function detachAndForget(driver: DetachDriver, child: FlowChart, input: unknown, sourcePrefix: string): void {
  // Reuse the joinable path — the caller just chooses not to keep the
  // returned handle. We don't even bind it to a variable to make the
  // "forget" semantic explicit at the call site.
  detachAndJoinLater(driver, child, input, sourcePrefix);
}
