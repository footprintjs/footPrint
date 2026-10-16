/**
 * InOutRecorder — captures every chart's input/output as entry/exit pairs.
 *
 * The gap this fills:
 *   Every chart in footprintjs has two natural data boundaries:
 *     - the **input** that flowed in (top-level: `run({input})`;
 *       subflow: `inputMapper` result)
 *     - the **output** that flowed out (top-level: chart return value;
 *       subflow: shared state at exit / `outputMapper` result)
 *
 *   Together with `TopologyRecorder` (composition shape) this is the
 *   universal "step" primitive that downstream layers project — a Lens
 *   StepGraph, a Trace view, custom dashboards. All bind by `runtimeStageId`.
 *
 *   The root chart is treated identically to any subflow: an `entry`
 *   boundary on `onRunStart` and an `exit` boundary on `onRunEnd`, with
 *   `subflowId: '__root__'`. So consumers building "every step has an
 *   in/out arrow" views can close the chain at the top level — no
 *   special-case rendering required.
 *
 * Two boundary phases per chart execution:
 *   1. `phase: 'entry'` — payload = the input crossing the boundary IN
 *   2. `phase: 'exit'`  — payload = the output crossing the boundary OUT
 *
 *   Loops re-entering the same subflow get distinct `runtimeStageId`s
 *   automatically (parent stage's executionIndex increments per iteration).
 *
 * Pause semantics:
 *   When a stage pauses inside a subflow, the engine re-throws the pause
 *   signal without firing `onSubflowExit` (or `onRunEnd`). The subflow
 *   has an `entry` with no matching `exit` until the run resumes and
 *   exits cleanly. Consumers should handle entry-without-exit gracefully
 *   (it means "in progress" or "paused"). The `getBoundary()` helper
 *   returns `{ entry, exit: undefined }` in that case.
 *
 * Attempts (10.1):
 *   An `exit` entry carries `attempts` — the count of attempts made inside
 *   the boundary, at any depth, by outcome, and how many series gave up —
 *   and `failedAttempts`, the failed / timed-out / aborted ones by name. Only
 *   series that retried, gave up or timed out count (`recorder/attemptSeries.ts ·
 *   isRetryEvidence`), so both fields are absent when nothing retried, and a
 *   boundary pair says what it cost to get through. An `entry` never carries
 *   them: the cost is known only at the exit — so a boundary that never
 *   exits (a run or subflow that failed, e.g. because a stage gave up, or a
 *   pause) carries no count; the attempts are then on the execution tree and
 *   the attempt-aware recorders (Topology, Debug, Quality).
 *
 * Redaction:
 *   Payload redaction is the engine's responsibility (`RedactionPolicy`).
 *   By the time payloads reach this recorder via `FlowSubflowEvent` or
 *   `FlowRunEvent`, named values have passed the run's rule. Root run
 *   payloads are walked at every depth (a nested key by its own name or
 *   dotted path) plus explicit nested fields; scalars pass through, and fork
 *   child-ID envelopes need explicit result paths. This is not content scanning. The recorder
 *   does not (and should not) re-redact or reconstruct the run.
 *
 * @example
 * ```typescript
 * import { inOutRecorder } from 'footprintjs/trace';
 *
 * const inOut = inOutRecorder();
 * executor.attachCombinedRecorder(inOut);
 * await executor.run({ input });
 *
 * inOut.getSteps();                    // entry boundaries — timeline projection
 * inOut.getBoundary(runtimeStageId);   // { entry, exit } pair for one execution
 * inOut.getBoundaries();               // flat list (entry+exit interleaved)
 * inOut.getRootBoundary();             // { entry, exit } for the top-level run
 * ```
 *
 * @example Filtering by subflow path
 * ```typescript
 * const agentSteps = inOut
 *   .getSteps()
 *   .filter((b) => b.subflowPath[1] === 'sf-agent');  // path[0] is the root
 * ```
 */

import { idPathSegments as pathSegments } from 'foottrace';

import type { AttemptOutcome } from '../attempt/types.js';
import type { FlowAttemptEvent, FlowRecorder, FlowRunEvent, FlowSubflowEvent } from '../engine/narrative/types.js';
import type { AttemptOutcomeCounts, AttemptRef } from './attemptSeries.js';
import {
  attemptFailed,
  attemptRef,
  emptyOutcomeCounts,
  gaveUp,
  isRetryEvidence,
  subflowOfAttempt,
} from './attemptSeries.js';
import { SequenceStore } from './SequenceStore.js';

// ── Types ─────────────────────────────────────────────────────────────

export type InOutPhase = 'entry' | 'exit';

/** Synthetic id for the top-level run's boundary pair. */
export const ROOT_SUBFLOW_ID = '__root__';

/** Synthetic runtimeStageId for the top-level run boundary pair. */
export const ROOT_RUNTIME_STAGE_ID = '__root__#0';

/**
 * One half of a chart execution boundary. Entry/exit pairs share `runtimeStageId`.
 *
 * Naming follows the engine: `subflowId` is the path-prefixed identifier the
 * engine emits (e.g. `'sf-outer/sf-inner'` for nested subflows). For the
 * top-level run, it's the synthetic `'__root__'`. `subflowPath` is the
 * decomposition into segments — provided as a convenience because consumers
 * often query / group by the path tree.
 */
export interface InOutEntry {
  /** runtimeStageId — same value for the entry/exit pair of one execution.
   *  Top-level run uses the synthetic `ROOT_RUNTIME_STAGE_ID`. */
  readonly runtimeStageId: string;
  /** Path-prefixed subflow identifier (matches the engine's `FlowSubflowEvent.subflowId`).
   *  Top-level → `'__root__'`. Subflow → `'sf-outer'` or `'sf-outer/sf-inner'`. */
  readonly subflowId: string;
  /** Last segment of `subflowId` — convenience for consumers that group by leaf name.
   *  Top-level → `'__root__'`. */
  readonly localSubflowId: string;
  /** Human-readable display name (from the builder; `'Run'` for the top-level run). */
  readonly subflowName: string;
  /** Build-time description from the subflow's root stage.
   *  Carries taxonomy markers (e.g. `'Agent: ReAct loop'`). Undefined for root. */
  readonly description?: string;
  /** Decomposition of `subflowId` into segments. Top-level → `['__root__']`.
   *  Subflows live UNDER the root: a top-level subflow has path `['__root__', 'sf-x']`. */
  readonly subflowPath: readonly string[];
  /** Depth in the subflow tree. Root → 0. First-level subflow → 1. */
  readonly depth: number;
  /** Which side of the boundary this entry represents. */
  readonly phase: InOutPhase;
  /** Data crossing the boundary.
   *  - `phase: 'entry'` → `inputMapper` result (subflow) or `run({input})` (root)
   *  - `phase: 'exit'`  → subflow shared state at exit (subflow) or chart return value (root)
   *
   *  Undefined when no mapper / no input was provided. */
  readonly payload?: unknown;
  /** True when this entry came from the top-level run (`onRunStart` / `onRunEnd`)
   *  rather than from a subflow (`onSubflowEntry` / `onSubflowExit`).
   *  Lens uses this to render the root pair as `user → run → user` instead of
   *  the regular subflow shape. */
  readonly isRoot: boolean;
  /** `phase: 'exit'` only, and only when something inside retried, gave up or timed out — see {@link InOutAttempts}. */
  readonly attempts?: InOutAttempts;
  /** With `attempts`: the attempts inside that failed, timed out or were aborted, in the order they ended. */
  readonly failedAttempts?: readonly AttemptRef[];
}

/** Attempts accumulated inside one open boundary. */
class BoundaryAttempts {
  private count = 0;
  private readonly byOutcome = emptyOutcomeCounts();
  private gaveUp = 0;
  private readonly failed: AttemptRef[] = [];

  add(outcome: AttemptOutcome, gave: boolean, failed: AttemptRef | undefined): void {
    this.count += 1;
    this.byOutcome[outcome] += 1;
    if (gave) this.gaveUp += 1;
    if (failed) this.failed.push(failed);
  }

  /** The exit entry's fields — none when nothing retried inside. */
  fields(): Pick<InOutEntry, 'attempts' | 'failedAttempts'> {
    if (this.count === 0) return {};
    return {
      attempts: { count: this.count, byOutcome: { ...this.byOutcome }, gaveUp: this.gaveUp },
      failedAttempts: [...this.failed],
    };
  }
}

/**
 * What it cost to get through a boundary: the attempts made inside it (at any depth) by series that retried, gave
 * up or timed out — `count`, per outcome (`timeout` included), and how many of those series gave up (`exhausted`,
 * `declined`, `no-time-left`).
 */
export interface InOutAttempts {
  readonly count: number;
  readonly byOutcome: AttemptOutcomeCounts;
  readonly gaveUp: number;
}

export interface InOutRecorderOptions {
  /** ScopeRecorder id. Defaults to `inout-N` (auto-incremented). */
  id?: string;
}

let _counter = 0;

/**
 * Factory — matches the `topologyRecorder()` / `narrative()` style.
 */
export function inOutRecorder(options: InOutRecorderOptions = {}): InOutRecorder {
  return new InOutRecorder(options);
}

/**
 * Stateful accumulator that watches `FlowRecorder` chart-boundary events
 * (run start/end + subflow entry/exit) and pushes `InOutEntry` records to
 * its composed `SequenceStore` (Convention 1 — one purpose per recorder).
 *
 * Attach via `executor.attachCombinedRecorder(recorder)` — footprintjs
 * detects the `FlowRecorder` method shape and routes events.
 */
export class InOutRecorder implements FlowRecorder {
  readonly id: string;
  /** 1:N ordered storage with per-step index (Convention 1 — composed). */
  private readonly store = new SequenceStore<InOutEntry>();
  /** The root run's attempts — every attempt is inside it. */
  private rootAttempts = new BoundaryAttempts();
  /** Open subflow boundaries' attempts, by path-prefixed subflowId. */
  private readonly openAttempts = new Map<string, BoundaryAttempts>();

  constructor(options: InOutRecorderOptions = {}) {
    this.id = options.id ?? `inout-${++_counter}`;
  }

  // ── FlowRecorder hooks ────────────────────────────────────────────────

  onRunStart(event: FlowRunEvent): void {
    this.rootAttempts = new BoundaryAttempts();
    this.openAttempts.clear();
    this.store.push(buildRootEntry('entry', event.payload));
  }

  onRunEnd(event: FlowRunEvent): void {
    this.store.push({ ...buildRootEntry('exit', event.payload), ...this.rootAttempts.fields() });
  }

  onSubflowEntry(event: FlowSubflowEvent): void {
    const entry = buildSubflowEntry(event, 'entry');
    if (!entry) return;
    this.openAttempts.set(entry.subflowId, new BoundaryAttempts());
    this.store.push(entry);
  }

  onSubflowExit(event: FlowSubflowEvent): void {
    const entry = buildSubflowEntry(event, 'exit');
    if (!entry) return;
    const attempts = this.openAttempts.get(entry.subflowId);
    this.openAttempts.delete(entry.subflowId);
    this.store.push(attempts ? { ...entry, ...attempts.fields() } : entry);
  }

  /**
   * Counts an attempt in the root boundary and in every open subflow boundary that contains the stage — the
   * subflow the stage ran in is that subflow's id or below it.
   */
  onAttempt(event: FlowAttemptEvent): void {
    const { record } = event;
    if (!isRetryEvidence(record)) return;
    const gave = gaveUp(record);
    const failed = attemptFailed(record) ? attemptRef(record) : undefined;
    this.rootAttempts.add(record.outcome, gave, failed);
    const path = subflowOfAttempt(event);
    if (path === undefined) return;
    for (const [subflowId, attempts] of this.openAttempts) {
      if (path === subflowId || path.startsWith(`${subflowId}/`)) attempts.add(record.outcome, gave, failed);
    }
  }

  // ── Query API ─────────────────────────────────────────────────────────

  /** All entries in execution order (entry+exit interleaved). */
  getBoundaries(): InOutEntry[] {
    return this.store.getAll();
  }

  /** Entry/exit pair for one chart execution.
   *  Returns `{ entry, exit }` — `exit` is `undefined` for in-progress / paused
   *  charts or if `runtimeStageId` is unknown. */
  getBoundary(runtimeStageId: string): { entry?: InOutEntry; exit?: InOutEntry } {
    const entries = this.store.getByKey(runtimeStageId);
    return {
      entry: entries.find((e) => e.phase === 'entry'),
      exit: entries.find((e) => e.phase === 'exit'),
    };
  }

  /** Just the `entry`-phase boundaries — the "step list" projection in
   *  execution order. This is the natural timeline of chart executions
   *  for slider / scrubbing UIs. The top-level run's entry is the first
   *  step (depth 0). */
  getSteps(): InOutEntry[] {
    const steps: InOutEntry[] = [];
    for (const b of this.store.getAll()) {
      if (b.phase === 'entry') steps.push(b);
    }
    return steps;
  }

  /** O(1) lookup: all boundary entries (both phases) for one runtimeStageId. */
  getEntriesForStep(runtimeStageId: string): InOutEntry[] {
    return this.store.getByKey(runtimeStageId);
  }

  /** Pre-built per-step range index — O(1) lookups for time-travel scrubbing. */
  getEntryRanges(): ReadonlyMap<string, { readonly firstIdx: number; readonly endIdx: number }> {
    return this.store.getEntryRanges();
  }

  /** Progressive reveal: boundaries whose runtimeStageId is in the visible set. */
  getEntriesUpTo(visibleIds: ReadonlySet<string>): InOutEntry[] {
    return this.store.getEntriesUpTo(visibleIds);
  }

  /** Clear all stored boundaries — called by the executor before each run(). */
  clear(): void {
    this.store.clear();
    this.rootAttempts = new BoundaryAttempts();
    this.openAttempts.clear();
  }

  /** The root run's entry/exit pair, if the run has started.
   *  Convenience for consumers that want to bracket the timeline by the
   *  outermost in/out. */
  getRootBoundary(): { entry?: InOutEntry; exit?: InOutEntry } {
    return this.getBoundary(ROOT_RUNTIME_STAGE_ID);
  }

  /** Snapshot bundle for inclusion in `executor.getSnapshot()`. */
  toSnapshot() {
    return {
      name: 'InOut',
      description: 'Chart in/out stream — entry/exit pairs at every chart boundary (root + subflows)',
      preferredOperation: 'translate' as const,
      data: this.getBoundaries(),
    };
  }
}

// ── Internal helpers ──────────────────────────────────────────────────

/**
 * Build the synthetic root entry/exit. Depth is `0` and the path is
 * `[ROOT_SUBFLOW_ID]` so consumers grouping by path see the root as a
 * regular top-level container.
 */
function buildRootEntry(phase: InOutPhase, payload: unknown): InOutEntry {
  return {
    runtimeStageId: ROOT_RUNTIME_STAGE_ID,
    subflowId: ROOT_SUBFLOW_ID,
    localSubflowId: ROOT_SUBFLOW_ID,
    subflowName: 'Run',
    subflowPath: [ROOT_SUBFLOW_ID],
    depth: 0,
    phase,
    payload,
    isRoot: true,
  };
}

/**
 * Build a subflow `InOutEntry` from a `FlowSubflowEvent`.
 *
 * Returns `undefined` when the event lacks a `subflowId` (anonymous /
 * malformed subflow events — same defensive policy as `TopologyRecorder`).
 *
 * Path derivation: the engine emits `subflowId` already prefixed with the
 * full path of parent subflows (e.g. `'sf-outer/sf-inner'`). We decompose
 * that into segments to populate `subflowPath` and compute `depth`.
 *
 * Subflows nest UNDER the synthetic root in `subflowPath` so the tree is
 * complete: a top-level subflow has path `['__root__', 'sf-x']` and depth 1.
 */
function buildSubflowEntry(event: FlowSubflowEvent, phase: InOutPhase): InOutEntry | undefined {
  const subflowId = event.subflowId;
  if (!subflowId) return undefined;

  const runtimeStageId = event.traversalContext?.runtimeStageId ?? '';
  const segments = pathSegments(subflowId);
  const subflowPath: readonly string[] = [ROOT_SUBFLOW_ID, ...segments];
  const depth = subflowPath.length - 1;
  const localSubflowId = segments[segments.length - 1] ?? subflowId;
  const payload = phase === 'entry' ? event.mappedInput : event.outputState;

  return {
    runtimeStageId,
    subflowId,
    localSubflowId,
    subflowName: event.name,
    description: event.description,
    subflowPath,
    depth,
    phase,
    payload,
    isRoot: false,
  };
}
