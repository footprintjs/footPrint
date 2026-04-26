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
 * Redaction:
 *   Payload redaction is the engine's responsibility (`RedactionPolicy`).
 *   By the time payloads reach this recorder via `FlowSubflowEvent` or
 *   `FlowRunEvent`, redactable values are already scrubbed. The recorder
 *   does not (and should not) re-redact.
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

import type { FlowRecorder, FlowRunEvent, FlowSubflowEvent } from '../engine/narrative/types.js';
import { SequenceRecorder } from './SequenceRecorder.js';

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
}

export interface InOutRecorderOptions {
  /** Recorder id. Defaults to `inout-N` (auto-incremented). */
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
 * (run start/end + subflow entry/exit) and emits `InOutEntry` records to
 * its underlying `SequenceRecorder` storage.
 *
 * Attach via `executor.attachCombinedRecorder(recorder)` — footprintjs
 * detects the `FlowRecorder` method shape and routes events.
 */
export class InOutRecorder extends SequenceRecorder<InOutEntry> implements FlowRecorder {
  readonly id: string;

  constructor(options: InOutRecorderOptions = {}) {
    super();
    this.id = options.id ?? `inout-${++_counter}`;
  }

  // ── FlowRecorder hooks ────────────────────────────────────────────────

  onRunStart(event: FlowRunEvent): void {
    this.emit(buildRootEntry('entry', event.payload));
  }

  onRunEnd(event: FlowRunEvent): void {
    this.emit(buildRootEntry('exit', event.payload));
  }

  onSubflowEntry(event: FlowSubflowEvent): void {
    const entry = buildSubflowEntry(event, 'entry');
    if (entry) this.emit(entry);
  }

  onSubflowExit(event: FlowSubflowEvent): void {
    const entry = buildSubflowEntry(event, 'exit');
    if (entry) this.emit(entry);
  }

  // ── Query API ─────────────────────────────────────────────────────────

  /** All entries in execution order (entry+exit interleaved).
   *  Alias for `getEntries()` with domain-clearer naming. */
  getBoundaries(): InOutEntry[] {
    return this.getEntries();
  }

  /** Entry/exit pair for one chart execution.
   *  Returns `{ entry, exit }` — `exit` is `undefined` for in-progress / paused
   *  charts or if `runtimeStageId` is unknown. */
  getBoundary(runtimeStageId: string): { entry?: InOutEntry; exit?: InOutEntry } {
    const entries = this.getEntriesForStep(runtimeStageId);
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
    for (const b of this.getEntries()) {
      if (b.phase === 'entry') steps.push(b);
    }
    return steps;
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
  const segments = subflowId.split('/').filter((s) => s.length > 0);
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
