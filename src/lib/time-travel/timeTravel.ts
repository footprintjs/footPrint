/**
 * timeTravel — a reader's cursor over a finished trace.
 *
 * The five laws this file implements (and the folder README states with an
 * example each):
 *
 *   1. ONE cursor. This object holds the only position. `drill()` returns a
 *      separate cursor over a separate log, never a second position here.
 *   2. A miss never moves. Every refusal returns the reason and leaves the
 *      cursor exactly where it was.
 *   3. A fold result is detached. `stateAt` returns frozen, cloned state that
 *      shares nothing with the engine.
 *   4. Marks live beside the log. They are the reader's notes, never written
 *      into the run's record.
 *   5. Stops are DERIVED from the recorded log — read-time queries over
 *      collected data, never a re-walk that invents what was not recorded.
 */

import type { CommitBundle, StageSnapshot } from '../memory/types.js';
import { commitStopsStrategy } from './commitStops.js';
import { commitsOf, stateAt } from './stateAt.js';
import type { FoldedState, Mark, Move, Stop, TimeTravel, TimeTravelOptions, TimeTravelSource } from './types.js';

/** A subflow result as this module needs to read it — duck-typed on purpose. */
interface SubflowResultShape {
  subflowId?: string;
  treeContext?: {
    history?: unknown[];
    initialState?: Record<string, unknown>;
    stageContexts?: Record<string, unknown>;
  };
}

class Cursor implements TimeTravel {
  readonly stops: readonly Stop[];
  readonly path: string | undefined;
  readonly mountRuntimeStageId: string | undefined;
  readonly parent: TimeTravel | undefined;

  private readonly log: readonly CommitBundle[];
  private readonly source: TimeTravelSource;
  private readonly options: TimeTravelOptions;
  private readonly _marks: Mark[];
  private step: number;

  constructor(
    source: TimeTravelSource,
    options: TimeTravelOptions,
    path?: string,
    parent?: TimeTravel,
    mountRuntimeStageId?: string,
  ) {
    this.source = source;
    this.options = options;
    this.path = path;
    this.parent = parent;
    this.mountRuntimeStageId = mountRuntimeStageId;
    this.log = commitsOf(source as never);
    const strategy = options.strategy ?? commitStopsStrategy;
    this.stops = Object.freeze(strategy.stopsFor(this.log, source.executionTree as StageSnapshot | undefined));
    this._marks = [...(options.marks ?? [])];
    this.step = 0;
  }

  // ── Position ─────────────────────────────────────────────────────────────

  at(): Stop | undefined {
    return this.stops[this.step];
  }

  private moveTo(step: number): Move {
    const from = this.at();
    this.step = step;
    return { moved: true, from, to: this.stops[step] };
  }

  /** Law 2: a refusal never touches `this.step`. */
  private refuse(reason: 'clamped' | 'miss' | 'empty', nearest?: Stop): Move {
    const at = this.at();
    return nearest ? { moved: false, reason, at, nearest } : { moved: false, reason, at };
  }

  first(): Move {
    if (this.stops.length === 0) return this.refuse('empty');
    if (this.step === 0) return this.refuse('clamped');
    return this.moveTo(0);
  }

  last(): Move {
    if (this.stops.length === 0) return this.refuse('empty');
    const end = this.stops.length - 1;
    if (this.step === end) return this.refuse('clamped');
    return this.moveTo(end);
  }

  prev(): Move {
    if (this.stops.length === 0) return this.refuse('empty');
    if (this.step === 0) return this.refuse('clamped');
    return this.moveTo(this.step - 1);
  }

  next(): Move {
    if (this.stops.length === 0) return this.refuse('empty');
    if (this.step >= this.stops.length - 1) return this.refuse('clamped');
    return this.moveTo(this.step + 1);
  }

  jumpTo(target: number | string): Move {
    if (this.stops.length === 0) return this.refuse('empty');

    if (typeof target === 'number') {
      const step = Math.trunc(target);
      if (Number.isNaN(step)) return this.refuse('miss');
      if (step < 0) return this.refuse('clamped', this.stops[0]);
      if (step > this.stops.length - 1) return this.refuse('clamped', this.stops[this.stops.length - 1]);
      if (step === this.step) return this.refuse('clamped');
      return this.moveTo(step);
    }

    // `''` is not an address: it is what the bookends and any pre-stage
    // root commit carry. Those are reached by step, never by id.
    if (target === '') return this.refuse('miss');
    const hit = this.stops.find((stop) => stop.runtimeStageId === target);
    if (!hit) return this.refuse('miss', this.nearestTo(target));
    if (hit.step === this.step) return this.refuse('clamped');
    return this.moveTo(hit.step);
  }

  /**
   * The closest namable stop for a `runtimeStageId` that is not on this axis:
   * the last stop of the same STAGE (a different iteration of the same node),
   * else the last stop whose commit precedes the missed id's execution index.
   * Naming a neighbour is a courtesy for the UI — it never moves the cursor.
   */
  private nearestTo(runtimeStageId: string): Stop | undefined {
    const hash = runtimeStageId.lastIndexOf('#');
    if (hash === -1) return undefined;
    const stagePart = runtimeStageId.slice(0, hash);
    const wanted = Number.parseInt(runtimeStageId.slice(hash + 1), 10);

    let sameStage: Stop | undefined;
    let byIndex: Stop | undefined;
    for (const stop of this.stops) {
      const stopHash = stop.runtimeStageId.lastIndexOf('#');
      if (stopHash === -1) continue;
      if (stop.runtimeStageId.slice(0, stopHash) === stagePart) sameStage = stop;
      if (!Number.isNaN(wanted)) {
        const idx = Number.parseInt(stop.runtimeStageId.slice(stopHash + 1), 10);
        if (!Number.isNaN(idx) && idx <= wanted) byIndex = stop;
      }
    }
    return sameStage ?? byIndex;
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  stateAt(stop?: Stop): FoldedState {
    const target = stop ?? this.at();
    return stateAt(this.source as never, target ? target.lastCommitIdx : -1);
  }

  changedSince(from?: Stop): readonly string[] {
    const to = this.at();
    if (!to) return Object.freeze([]);
    const start = from ?? this.stops[this.step - 1];
    // No earlier stop (we are at `'start'`) ⇒ everything up to here: nothing
    // on a run cursor, and the subflow's `inputMapper` seed on a drilled one
    // (the start bookend covers the id-less commits that precede stage one).
    const afterIdx = start ? start.lastCommitIdx : -1;
    const keys = new Set<string>();
    for (let i = afterIdx + 1; i <= to.lastCommitIdx; i++) {
      const bundle = this.log[i];
      if (!bundle) continue;
      for (const entry of bundle.trace) keys.add(entry.path);
    }
    return Object.freeze([...keys].sort());
  }

  // ── Marks (law 4: beside the log, never in it) ───────────────────────────

  mark(name: string, stop?: Stop): Mark | undefined {
    const target = stop ?? this.at();
    if (!target) return undefined;
    const entry: Mark = Object.freeze({ name, runtimeStageId: target.runtimeStageId, step: target.step });
    const existing = this._marks.findIndex((m) => m.name === name);
    if (existing >= 0) this._marks[existing] = entry;
    else this._marks.push(entry);
    return entry;
  }

  marks(): readonly Mark[] {
    return Object.freeze([...this._marks]);
  }

  jumpToMark(name: string): Move {
    if (this.stops.length === 0) return this.refuse('empty');
    const entry = this._marks.find((m) => m.name === name);
    if (!entry) return this.refuse('miss');
    // Resolve by runtimeStageId first — the address that survives a change of
    // strategy — and fall back to the remembered step only for the bookends,
    // which have no stage id of their own.
    const byId = entry.runtimeStageId
      ? this.stops.find((stop) => stop.runtimeStageId === entry.runtimeStageId)
      : this.stops[entry.step];
    if (!byId) return this.refuse('miss', this.nearestTo(entry.runtimeStageId));
    if (byId.step === this.step) return this.refuse('clamped');
    return this.moveTo(byId.step);
  }

  // ── Drilling (law 1: a separate cursor, not a second position) ───────────

  drill(mountRuntimeStageId: string): TimeTravel | undefined {
    const results = this.source.subflowResults;
    if (!results) return undefined;
    const result = results[mountRuntimeStageId] as SubflowResultShape | undefined;
    const tree = result?.treeContext;
    if (!tree || !Array.isArray(tree.history)) return undefined;

    // `path` is the subflow PATH — the same string for every iteration of a
    // mount inside a loop. `mountRuntimeStageId` is the iteration actually
    // opened, so a UI can label and key three drill panels over `sfx#2`,
    // `sfx#8`, `sfx#14` apart instead of calling all three 'sfx'.
    const childPath = result.subflowId ?? mountRuntimeStageId;
    const child: TimeTravelSource = {
      commitLog: tree.history as CommitBundle[],
      initialState: tree.initialState,
      executionTree: tree.stageContexts as unknown as StageSnapshot | undefined,
      // Nested subflow results are merged UP into one flat, dual-keyed map, so
      // the child can drill further through the same map.
      subflowResults: results,
    };
    return new Cursor(child, { strategy: this.options.strategy }, childPath, this, mountRuntimeStageId);
  }
}

/**
 * Open a reader's cursor over a finished run.
 *
 * Nothing here executes anything: `snapshot` is a record of a run that already
 * happened, and every question is answered by reading it. A stored JSON
 * snapshot works exactly like a live one.
 *
 * @param snapshot `executor.getSnapshot()`, or any object with the same
 *   shape — including one round-tripped through JSON, or a subflow subtree
 *   (`getSubtreeSnapshot()`, whose log is spelled `history`).
 * @param options `strategy` chooses how stops are derived (default:
 *   `commitStops`, one stop per executed stage); `marks` seeds the cursor with
 *   bookmarks, e.g. restored from a saved reading session.
 *
 * @example
 * ```typescript
 * const tt = timeTravel(executor.getSnapshot());
 * tt.jumpTo('score-risk#4');
 * console.log(tt.changedSince());        // ['riskScore', 'tier']
 * console.log(tt.stateAt().state);       // state as that stage left it
 * tt.mark('the bad one');
 * const inner = tt.drill('sf-payment#7'); // a separate cursor, its own log
 * ```
 */
export function timeTravel(snapshot: TimeTravelSource, options: TimeTravelOptions = {}): TimeTravel {
  return new Cursor(snapshot, options);
}
