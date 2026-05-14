/**
 * BoundaryStateStore<TState> — concrete, composable per-boundary
 * transient state storage.
 *
 * Pattern: COMPOSITION primitive. Concrete class — instantiate with
 *          `new BoundaryStateStore<TState>()` and own it as a field
 *          on your recorder. Replaces the abstract
 *          `BoundaryStateTracker<TState>` base class for the v5
 *          "one purpose per recorder" rule.
 * Role:    "What's the LIVE transient state of every currently-active
 *          boundary?" A boundary is a matched event pair `[start, stop]`
 *          bracketing an interval (e.g., `(llm_start, llm_end)`).
 *          Between the brackets, intermediate events evolve the
 *          boundary's state. On `stop`, the state clears.
 *
 * Algorithmically this is the **DFS bracket-sequence pattern** — the
 * `active` map is the open-brackets stack at any moment.
 *
 * **Lifecycle contract — STRICT:** every `start(key, ...)` call MUST
 * be paired with a `stop(key)` call. Failure to wire stop produces a
 * memory leak: the active map grows without bound.
 *
 * **Concurrency / nesting:** concurrent boundaries (parallel branches
 * with two LLM calls active at once) work correctly — each is keyed
 * independently. Nested boundaries of DIFFERENT KINDS require
 * SEPARATE store instances — one per kind.
 *
 * @example
 * ```typescript
 * import { BoundaryStateStore } from 'footprintjs/trace';
 * import type { CombinedRecorder, EmitEvent } from 'footprintjs';
 *
 * interface LLMLiveState { partial: string; tokens: number; }
 *
 * class LiveLLMTracker implements CombinedRecorder {
 *   readonly id = 'live-llm';
 *   private readonly store = new BoundaryStateStore<LLMLiveState>();
 *
 *   onEmit(event: EmitEvent): void {
 *     if (event.name === 'agentfootprint.stream.llm_start') {
 *       this.store.start(event.runtimeStageId, { partial: '', tokens: 0 });
 *     } else if (event.name === 'agentfootprint.stream.llm_end') {
 *       this.store.stop(event.runtimeStageId);
 *     } else if (event.name === 'agentfootprint.stream.token') {
 *       this.store.update(event.runtimeStageId, (s) => ({
 *         partial: s.partial + (event.payload as { content: string }).content,
 *         tokens: s.tokens + 1,
 *       }));
 *     }
 *   }
 *
 *   isInFlight(): boolean { return this.store.hasActive; }
 *   getPartial(rid: string): string {
 *     return this.store.get(rid)?.partial ?? '';
 *   }
 *
 *   clear() { this.store.clear(); }
 * }
 * ```
 */

import { isDevMode } from '../scope/detectCircular.js';

export class BoundaryStateStore<TState> {
  /** Open-brackets stack: key → current transient state. */
  private readonly active = new Map<string, TState>();

  /** Per-key count of `update` calls that landed without a matching
   *  active boundary. Drives rate-limited dev-mode warnings so a
   *  stuck loop doesn't spam the console. */
  private readonly missedUpdates = new Map<string, number>();

  /** Optional id for diagnostics — passed to dev-mode warnings so the
   *  source of the leak is easy to find when multiple stores coexist. */
  private readonly diagnosticId: string;

  constructor(diagnosticId = 'boundary-state-store') {
    this.diagnosticId = diagnosticId;
  }

  // ── Mutators ─────────────────────────────────────────────────────────

  /**
   * Open a new boundary with initial transient state. If a boundary
   * with the same `key` is already active, the prior state is
   * overwritten (last-writer-wins). Dev mode warns — usually
   * indicates a missed `stop` upstream.
   */
  start(key: string, initial: TState): void {
    if (this.active.has(key) && isDevMode()) {
      console.warn(
        `[${this.diagnosticId}] start('${key}') called while an active boundary ` +
          'already exists. Overwriting prior state — likely a missed stop upstream.',
      );
    }
    this.active.set(key, initial);
  }

  /**
   * Evolve the transient state of an active boundary using a pure
   * updater function. Silent no-op if no boundary is active for `key`
   * (defensive against out-of-order events). Dev mode logs a rate-
   * limited warning.
   */
  update(key: string, updater: (prev: TState) => TState): void {
    const cur = this.active.get(key);
    if (cur === undefined) {
      if (isDevMode()) {
        const n = (this.missedUpdates.get(key) ?? 0) + 1;
        this.missedUpdates.set(key, n);
        if (n === 1) {
          console.warn(`[${this.diagnosticId}] update('${key}') — no active boundary. Update dropped.`);
        } else if (n === 10 || n === 100) {
          console.warn(`[${this.diagnosticId}] update('${key}') — ${n} dropped updates. Wiring bug?`);
        }
      }
      return;
    }
    this.active.set(key, updater(cur));
  }

  /**
   * Close the boundary identified by `key` and return its FINAL
   * transient state (so the consumer can do any cleanup — e.g., emit
   * a snapshot to a SequenceStore for durable storage).
   */
  stop(key: string): TState | undefined {
    const final = this.active.get(key);
    this.active.delete(key);
    return final;
  }

  // ── Read (O(1)) ──────────────────────────────────────────────────────

  /** Current transient state of ONE active boundary. `undefined` if no
   *  boundary is active for `key`. */
  get(key: string): TState | undefined {
    return this.active.get(key);
  }

  /** All currently-active boundaries.
   *
   *  **Type-only readonly:** TypeScript prevents mutation through
   *  `ReadonlyMap`, but a runtime cast or non-TS consumer can mutate
   *  the underlying Map and corrupt state. Don't. */
  getAll(): ReadonlyMap<string, TState> {
    return this.active;
  }

  /** True if any boundary is currently active. O(1). */
  get hasActive(): boolean {
    return this.active.size > 0;
  }

  /** Number of currently-active boundaries. O(1). */
  get activeCount(): number {
    return this.active.size;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Reset all transient state. Called by recorder composers from
   * their own `clear()` method, which the executor invokes before
   * each run.
   *
   * Dev mode warns if any boundaries are still active when called —
   * likely indicates a missed `stop` upstream. Leaked keys are listed
   * (truncated to 10) so the wiring bug is findable.
   */
  clear(): void {
    if (this.active.size > 0 && isDevMode()) {
      const keys = [...this.active.keys()];
      const head = keys.slice(0, 10).join(', ');
      const more = keys.length > 10 ? ` ...(+${keys.length - 10} more)` : '';
      console.warn(
        `[${this.diagnosticId}] clear() called with ${this.active.size} ` +
          'still-active boundaries. Missed stop? ' +
          `Leaked keys: ${head}${more}`,
      );
    }
    this.active.clear();
    this.missedUpdates.clear();
  }
}
