/**
 * BoundaryRecorder — captures subflow execution as entry/exit boundary pairs.
 *
 * The gap this fills:
 *   Every subflow execution has two natural step boundaries baked into the
 *   engine: `inputMapper` runs and `outputMapper` runs. Together they bracket
 *   the subflow body in time AND carry the data crossing the boundary.
 *
 *   `TopologyRecorder` captures the SHAPE of composition (who nests inside
 *   whom). `BoundaryRecorder` captures the PAYLOADS at each boundary —
 *   what flowed IN at entry, what flowed OUT at exit.
 *
 *   Together they're the universal "step" primitive that downstream layers
 *   project: Trace view (per-stage), Lens StepGraph (agent semantics),
 *   custom dashboards (domain rollups). All bind by `runtimeStageId`,
 *   which the engine already produces.
 *
 * Two boundary phases per subflow execution:
 *   1. `phase: 'entry'`  — fires after `inputMapper`, payload = mapped input.
 *   2. `phase: 'exit'`   — fires after `outputMapper`, payload = output state.
 *
 *   Loops re-entering the same subflow get distinct `runtimeStageId`s
 *   automatically (parent stage's executionIndex increments per iteration).
 *
 * Pause semantics:
 *   When a stage pauses inside a subflow, the engine re-throws the pause
 *   signal without firing `onSubflowExit`. The subflow has an `entry` with
 *   no matching `exit` until the run resumes and exits cleanly. Consumers
 *   should handle entry-without-exit gracefully (it means "in progress" or
 *   "paused"). The `getBoundary()` helper returns `{ entry, exit: undefined }`
 *   in that case.
 *
 * Redaction:
 *   Payload redaction is the engine's responsibility (`RedactionPolicy`).
 *   By the time `mappedInput` / `outputState` reach this recorder via
 *   `FlowSubflowEvent`, redactable values are already scrubbed. The
 *   recorder does not (and should not) re-redact.
 *
 * @example
 * ```typescript
 * import { boundaryRecorder } from 'footprintjs/trace';
 *
 * const boundaries = boundaryRecorder();
 * executor.attachCombinedRecorder(boundaries);
 * await executor.run({ input });
 *
 * boundaries.getSteps();                    // entry boundaries — timeline projection
 * boundaries.getBoundary(runtimeStageId);   // { entry, exit } pair for one execution
 * boundaries.getBoundaries();               // flat list (entry+exit interleaved)
 * ```
 *
 * @example Filtering by subflow path (scope queries to a region)
 * ```typescript
 * const agentSteps = boundaries
 *   .getSteps()
 *   .filter((b) => b.subflowPath[0] === 'sf-agent');
 * ```
 */

import type { FlowRecorder, FlowSubflowEvent } from '../engine/narrative/types.js';
import { SequenceRecorder } from './SequenceRecorder.js';

// ── Types ─────────────────────────────────────────────────────────────

export type BoundaryPhase = 'entry' | 'exit';

/**
 * One half of a subflow execution boundary. Entry/exit pairs share `runtimeStageId`.
 *
 * Naming follows the engine: `subflowId` is the path-prefixed identifier the
 * engine emits (e.g. `'sf-outer/sf-inner'` for nested subflows). `subflowPath`
 * is its decomposition into segments — provided as a convenience because
 * downstream consumers often query / group by the path tree.
 */
export interface StepBoundary {
  /** runtimeStageId — same value for the entry/exit pair of one execution. */
  readonly runtimeStageId: string;
  /** Path-prefixed subflow identifier (matches the engine's `FlowSubflowEvent.subflowId`).
   *  Top-level → `'sf-outer'`. Nested → `'sf-outer/sf-inner'`. Loop re-entry of
   *  the same subflow is disambiguated by `runtimeStageId`, not by suffixing here. */
  readonly subflowId: string;
  /** Subflow's local identifier (last segment of `subflowId`).
   *  Convenience for consumers that group by leaf name. */
  readonly localSubflowId: string;
  /** Human-readable display name (from the builder). */
  readonly subflowName: string;
  /** Build-time description from the subflow's root stage.
   *  Carries taxonomy markers (e.g. `'Agent: ReAct loop'`) that downstream
   *  layers use to classify the subflow. Undefined when no description set. */
  readonly description?: string;
  /** Decomposition of `subflowId` into segments — top-level → `['sf-x']`,
   *  nested → `['sf-outer', 'sf-inner']`. */
  readonly subflowPath: readonly string[];
  /** Depth of this subflow in the run's subflow tree (0 = top-level). */
  readonly depth: number;
  /** Which side of the boundary this entry represents. */
  readonly phase: BoundaryPhase;
  /** Data crossing the boundary.
   *  - `phase: 'entry'` → `inputMapper` result (what came IN to this subflow)
   *  - `phase: 'exit'`  → subflow shared state at exit (what went OUT)
   *
   *  Undefined when no mapper was defined or the mapper returned empty. */
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface BoundaryRecorderOptions {
  /** Recorder id. Defaults to `boundaries-N` (auto-incremented). */
  id?: string;
}

let _counter = 0;

/**
 * Factory — matches the `topologyRecorder()` / `narrative()` style.
 */
export function boundaryRecorder(options: BoundaryRecorderOptions = {}): BoundaryRecorder {
  return new BoundaryRecorder(options);
}

/**
 * Stateful accumulator that watches `FlowRecorder` subflow events and emits
 * `StepBoundary` entries to its underlying `SequenceRecorder` storage.
 *
 * Attach via `executor.attachCombinedRecorder(recorder)` — footprintjs
 * detects the `FlowRecorder` method shape and routes events.
 */
export class BoundaryRecorder extends SequenceRecorder<StepBoundary> implements FlowRecorder {
  readonly id: string;

  constructor(options: BoundaryRecorderOptions = {}) {
    super();
    this.id = options.id ?? `boundaries-${++_counter}`;
  }

  // ── FlowRecorder hooks ────────────────────────────────────────────────

  onSubflowEntry(event: FlowSubflowEvent): void {
    const boundary = buildBoundary(event, 'entry');
    if (boundary) this.emit(boundary);
  }

  onSubflowExit(event: FlowSubflowEvent): void {
    const boundary = buildBoundary(event, 'exit');
    if (boundary) this.emit(boundary);
  }

  // ── Query API ─────────────────────────────────────────────────────────

  /** All boundaries in execution order (entry+exit interleaved).
   *  Alias for `getEntries()` with domain-clearer naming. */
  getBoundaries(): StepBoundary[] {
    return this.getEntries();
  }

  /** Entry/exit pair for one subflow execution.
   *  Returns `{ entry, exit }` — `exit` is `undefined` for in-progress / paused
   *  subflows or if `runtimeStageId` is unknown. */
  getBoundary(runtimeStageId: string): { entry?: StepBoundary; exit?: StepBoundary } {
    const entries = this.getEntriesForStep(runtimeStageId);
    return {
      entry: entries.find((e) => e.phase === 'entry'),
      exit: entries.find((e) => e.phase === 'exit'),
    };
  }

  /** Just the `entry`-phase boundaries — the "step list" projection in
   *  execution order. This is the natural timeline of subflow executions
   *  for slider / scrubbing UIs. */
  getSteps(): StepBoundary[] {
    const steps: StepBoundary[] = [];
    for (const b of this.getEntries()) {
      if (b.phase === 'entry') steps.push(b);
    }
    return steps;
  }

  /** Snapshot bundle for inclusion in `executor.getSnapshot()`. */
  toSnapshot() {
    return {
      name: 'Boundaries',
      description: 'Subflow boundary stream — entry/exit pairs with mapper payloads',
      preferredOperation: 'translate' as const,
      data: this.getBoundaries(),
    };
  }
}

// ── Internal helpers ──────────────────────────────────────────────────

/**
 * Build a `StepBoundary` from a `FlowSubflowEvent`.
 *
 * Returns `undefined` when the event lacks a `subflowId` (anonymous /
 * malformed subflow events — same defensive policy as `TopologyRecorder`).
 *
 * Path derivation: the engine emits `subflowId` already prefixed with the
 * full path of parent subflows (e.g. `'sf-outer/sf-inner'`). We decompose
 * that into segments to populate `subflowPath` and compute `depth`.
 * `traversalContext.subflowPath` is intentionally NOT consulted — it
 * carries the parent's path, but the prefixed `subflowId` is the
 * authoritative source the engine already produces.
 */
function buildBoundary(event: FlowSubflowEvent, phase: BoundaryPhase): StepBoundary | undefined {
  const subflowId = event.subflowId;
  if (!subflowId) return undefined;

  const runtimeStageId = event.traversalContext?.runtimeStageId ?? '';
  const subflowPath = subflowId.split('/').filter((s) => s.length > 0);
  const depth = Math.max(0, subflowPath.length - 1);
  const localSubflowId = subflowPath[subflowPath.length - 1] ?? subflowId;
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
  };
}
