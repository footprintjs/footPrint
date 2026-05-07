/**
 * BoundaryStateTracker<TState> — third storage primitive on the recorder
 * shelf, alongside `SequenceRecorder<T>` and `KeyedRecorder<T>`.
 *
 * **Mental model — observers vs. bookkeepers:**
 *
 *   `Recorder` / `FlowRecorder` / `EmitRecorder` / `CombinedRecorder`
 *     are OBSERVER interfaces — they describe how a recorder hears
 *     events from the executor.
 *
 *   `SequenceRecorder<T>` / `KeyedRecorder<T>` / `BoundaryStateTracker<TState>`
 *     are STORAGE primitives — three different bookkeeping shelves with
 *     different durability and indexing properties. A real recorder
 *     class typically picks ONE observer interface AND ONE storage
 *     shelf, combining them via `extends + implements`.
 *
 * **What this primitive answers:** "At any moment during the run, what
 * is the LIVE transient state of every currently-active boundary?"
 *
 * A "boundary" is a matched event pair `[start, stop]` bracketing an
 * interval — for example, `(llm_start, llm_end)` for an LLM call,
 * `(tool_start, tool_end)` for tool execution, `(turn_start, turn_end)`
 * for an agent turn. Between the brackets, intermediate events evolve
 * the boundary's state (token chunks accumulating into a partial
 * answer, args streaming in, etc.). On `stop`, the state clears.
 *
 * Algorithmically this is the **DFS bracket-sequence pattern** —
 * stack-frame state during a graph-traversal interval. Same shape used
 * by Tarjan's SCC algorithm, tree decomposition, and push-down
 * automata. The `active` map is the open-brackets stack at any moment.
 *
 * **Comparison with the other storage primitives:**
 *
 * | Primitive                       | Stores                               | Time scope          | Memory      |
 * |---------------------------------|--------------------------------------|---------------------|-------------|
 * | `SequenceRecorder<T>`           | append-only ordered + keyed entries  | durable across run  | O(N events) |
 * | `KeyedRecorder<T>`              | 1:1 entry per `runtimeStageId`       | durable across run  | O(N steps)  |
 * | `BoundaryStateTracker<TState>`  | transient bracket-scoped state       | live; clears on stop | O(K active) |
 *
 * **When to pick which:**
 *
 *   - "I need to keep a permanent log of every event for time-travel"
 *      → `SequenceRecorder<T>`
 *   - "I want one durable record per stage execution (e.g., metrics)"
 *      → `KeyedRecorder<T>`
 *   - "I need to know what's happening RIGHT NOW inside an in-flight
 *     boundary (e.g., partial LLM stream, partial tool args)"
 *      → `BoundaryStateTracker<TState>` (this class)
 *
 * **What this is NOT for:**
 *
 *   - Time-travel queries ("what was the state at past slider step N?")
 *     — transient state clears on stop. For time-travel, snapshot the
 *     state at each emit into a separate `SequenceRecorder<TState>`,
 *     or wait for a future `BoundarySnapshotRecorder<TState>` primitive.
 *
 *   - Aggregations across the whole run (totals, counts) — those are
 *     `SequenceRecorder.aggregate()` / `KeyedRecorder.aggregate()`.
 *
 *   - Stage-level concerns — those use `Recorder.onStageStart` /
 *     `Recorder.onStageEnd`. This primitive operates at finer
 *     granularity (events emitted DURING a stage execution).
 *
 * **Lifecycle contract — STRICT:**
 *
 *   Every `startBoundary(key, ...)` call MUST be paired with a
 *   `stopBoundary(key)` call. Failure to wire the stop side produces a
 *   memory leak: the active map grows without bound, and `getAllActive()`
 *   returns stale entries that look in-flight but aren't. Common cause:
 *   subclass wires `start` to one event handler and forgets to wire
 *   `stop`. **Always wire both at the same time.**
 *
 *   Dev mode (`enableDevMode()`) detects leaks at `clear()` time —
 *   warning includes the leaked keys so you can find the missing wiring.
 *
 * **Concurrency / nesting:**
 *
 *   - Concurrent boundaries (parallel branches with two LLM calls
 *     active at once) work correctly: each is keyed independently in
 *     the active map.
 *   - Nested boundaries of DIFFERENT KINDS (Agent boundary contains
 *     LLM boundary) require SEPARATE tracker instances — one per kind.
 *     The base class tracks one boundary kind per instance.
 *
 * **Key convention:**
 *
 *   The `key: string` is whatever your subclass picks. Convention:
 *   use `runtimeStageId` when the boundary maps 1:1 to a stage
 *   execution — this gives free interop with `SequenceRecorder
 *   .getEntriesForStep`, `KeyedRecorder.getByKey`, `findCommit` /
 *   `findLastWriter`, and the rest of the trace ecosystem. Use a more
 *   granular key (e.g., `toolCallId`) only when there are multiple
 *   concurrent boundaries WITHIN one stage execution.
 *
 * @example Build a live LLM tracker (combining storage + observer):
 *
 * ```typescript
 * import {
 *   BoundaryStateTracker,
 *   type CombinedRecorder,
 *   type EmitEvent,
 * } from 'footprintjs';
 *
 * interface LLMLiveState {
 *   readonly partial: string;
 *   readonly tokens: number;
 * }
 *
 * class LiveLLMTracker
 *   extends BoundaryStateTracker<LLMLiveState>   // STORAGE shelf
 *   implements CombinedRecorder                   // OBSERVER interface
 * {
 *   readonly id = 'live-llm';
 *
 *   // Observer half — translate events into bracket mutations.
 *   onEmit(event: EmitEvent): void {
 *     if (event.name === 'agentfootprint.stream.llm_start') {
 *       this.startBoundary(event.runtimeStageId, { partial: '', tokens: 0 });
 *     } else if (event.name === 'agentfootprint.stream.llm_end') {
 *       this.stopBoundary(event.runtimeStageId);
 *     } else if (event.name === 'agentfootprint.stream.token') {
 *       this.updateBoundary(event.runtimeStageId, (s) => ({
 *         partial: s.partial + (event.payload as { content: string }).content,
 *         tokens: s.tokens + 1,
 *       }));
 *     }
 *   }
 *
 *   // Public read API — O(1) at any moment.
 *   isInFlight(): boolean { return this.hasActive; }
 *   getPartial(stageId: string): string {
 *     return this.getActive(stageId)?.partial ?? '';
 *   }
 * }
 *
 * // Attached the same way as any other CombinedRecorder.
 * const tracker = new LiveLLMTracker();
 * executor.attachCombinedRecorder(tracker);
 * await executor.run({ input });
 *
 * // Read live state at any time during or after the run.
 * tracker.isInFlight();
 * tracker.getPartial(rid);
 * ```
 */

import { isDevMode } from '../scope/detectCircular.js';

export abstract class BoundaryStateTracker<TState> {
  /** Stable id — same idempotency contract as other recorders. */
  abstract readonly id: string;

  /** Open-brackets stack: key → current transient state. */
  private readonly active = new Map<string, TState>();

  /** Per-key count of `updateBoundary` calls that landed without a
   *  matching active boundary. Drives rate-limited dev-mode warnings
   *  so a stuck loop doesn't spam the console. */
  private readonly missedUpdates = new Map<string, number>();

  // ── Mutator API (subclass calls these from observer hooks) ──────────

  /**
   * Open a new boundary with initial transient state.
   *
   * If a boundary with the same `key` is already active, the prior
   * state is overwritten (last-writer-wins). In dev mode, a warning
   * is logged because re-starting an active key usually indicates a
   * missed `stopBoundary` call upstream.
   *
   * @param key Boundary identifier — by convention, `runtimeStageId`
   *            for 1:1-with-stage boundaries, or a more granular id
   *            (e.g., `toolCallId`) when multiple concurrent boundaries
   *            run within one stage execution.
   * @param initial Initial state — typed by `TState`.
   */
  protected startBoundary(key: string, initial: TState): void {
    if (this.active.has(key) && isDevMode()) {
      console.warn(
        `[${this.id}] startBoundary('${key}') called while an active boundary already exists. ` +
          'Overwriting prior state — likely a missed stopBoundary upstream.',
      );
    }
    this.active.set(key, initial);
  }

  /**
   * Evolve the transient state of an active boundary using an updater
   * function. Silent no-op if no boundary is active for `key`
   * (defensive against out-of-order events). In dev mode, a rate-limited
   * warning is logged on the 1st, 10th, and 100th missed update per key.
   *
   * @param key      Boundary identifier (must match a prior `startBoundary`).
   * @param updater  Pure function: previous state → next state.
   */
  protected updateBoundary(key: string, updater: (prev: TState) => TState): void {
    const cur = this.active.get(key);
    if (cur === undefined) {
      if (isDevMode()) {
        const n = (this.missedUpdates.get(key) ?? 0) + 1;
        this.missedUpdates.set(key, n);
        if (n === 1) {
          console.warn(`[${this.id}] updateBoundary('${key}') — no active boundary. Update dropped.`);
        } else if (n === 10 || n === 100) {
          console.warn(`[${this.id}] updateBoundary('${key}') — ${n} dropped updates. Wiring bug?`);
        }
      }
      return;
    }
    this.active.set(key, updater(cur));
  }

  /**
   * Close the boundary identified by `key` and return its FINAL
   * transient state (for any cleanup the subclass wants — e.g., emit a
   * snapshot to a SequenceRecorder for durable storage).
   *
   * @param key Boundary identifier.
   * @returns The final state, or `undefined` if no boundary was active.
   */
  protected stopBoundary(key: string): TState | undefined {
    const final = this.active.get(key);
    this.active.delete(key);
    return final;
  }

  // ── Read API (consumers call these — O(1)) ─────────────────────────

  /** Current transient state of ONE active boundary. `undefined` if no
   *  boundary is active for `key`. */
  getActive(key: string): TState | undefined {
    return this.active.get(key);
  }

  /**
   * All currently-active boundaries.
   *
   * **Type-only readonly:** the returned reference IS the internal Map.
   * TypeScript prevents mutation through the `ReadonlyMap` type, but a
   * runtime cast or non-TS consumer can mutate it and corrupt internal
   * state. **Do not mutate.**
   */
  getAllActive(): ReadonlyMap<string, TState> {
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

  // ── Lifecycle ───────────────────────────────────────────────────────

  /**
   * Reset all transient state. Called by executors before each `run()`
   * so consumers get a clean slate per run — same lifecycle contract
   * as `SequenceRecorder.clear()`.
   *
   * In dev mode, warns if any boundaries are still active when called
   * — likely indicates a missed `stopBoundary` upstream. The leaked
   * keys are listed (truncated to 10) so the wiring bug is findable.
   */
  clear(): void {
    if (this.active.size > 0 && isDevMode()) {
      const keys = [...this.active.keys()];
      const head = keys.slice(0, 10).join(', ');
      const more = keys.length > 10 ? ` ...(+${keys.length - 10} more)` : '';
      console.warn(
        `[${this.id}] clear() called with ${this.active.size} ` +
          'still-active boundaries. Missed stopBoundary? ' +
          `Leaked keys: ${head}${more}`,
      );
    }
    this.active.clear();
    this.missedUpdates.clear();
  }
}
