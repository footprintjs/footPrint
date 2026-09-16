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
 *
 * A CHAIN (9.18.0) does not add a sixth law and does not bend these five: it
 * is still one cursor, over sources that are still only read. What it adds is
 * that the STEPS run across a pause/resume — see `chain.ts` for the ordering
 * and lineage checks, and for why commit indices stay run-local.
 */

import { isPlainish, readTree } from './bundles.js';
import { refuseChain } from './chain.js';
import { commitStopsStrategy } from './commitStops.js';
import { type FoldMemo, type ReadSource, foldLegsFrom, readSource } from './stateAt.js';
import type {
  FoldedState,
  Mark,
  Move,
  Stop,
  TimeTravel,
  TimeTravelOptions,
  TimeTravelSource,
  TimeTravelStrategy,
} from './types.js';

/** A subflow result as this module needs to read it — duck-typed on purpose. */
interface SubflowResultShape {
  subflowId?: string;
  treeContext?: {
    history?: unknown[];
    initialState?: Record<string, unknown>;
    stageContexts?: Record<string, unknown>;
  };
}

class Cursor<TMeta> implements TimeTravel<TMeta> {
  readonly stops: readonly Stop<TMeta>[];
  readonly path: string | undefined;
  readonly mountRuntimeStageId: string | undefined;
  readonly parent: TimeTravel<TMeta> | undefined;
  readonly sourceCount: number;

  private readonly legs: readonly ReadSource[];
  private readonly sources: readonly TimeTravelSource[];
  private readonly options: TimeTravelOptions<TMeta>;
  private readonly _marks: Mark[];
  private step: number;
  /** The last fold's working copy, so a step forward applies one bundle (9.25.0). */
  private foldMemo: FoldMemo | undefined;

  constructor(
    sources: readonly TimeTravelSource[],
    options: TimeTravelOptions<TMeta>,
    path?: string,
    parent?: TimeTravel<TMeta>,
    mountRuntimeStageId?: string,
  ) {
    this.sources = sources;
    this.options = options;
    this.path = path;
    this.parent = parent;
    this.mountRuntimeStageId = mountRuntimeStageId;
    this.legs = sources.map((source) => readSource(source));
    this.sourceCount = sources.length;

    // The shipped strategy has no vocabulary of its own (`meta` is never set),
    // so it serves any `TMeta` a caller asked for.
    const strategy = options.strategy ?? (commitStopsStrategy as TimeTravelStrategy<TMeta>);
    // ONE CALL PER SOURCE, with that source's own log and tree: a strategy
    // never has to know it is part of a chain, and its indices stay local to
    // the leg it was handed.
    const perSource = this.legs.map((leg, i) => strategy.stopsFor(leg.log, readTree(sources[i].executionTree)));
    this.stops = Object.freeze(sources.length === 1 ? perSource[0] : chainStops(perSource));
    this._marks = [...(options.marks ?? [])];
    this.step = 0;
  }

  // ── Position ─────────────────────────────────────────────────────────────

  at(): Stop<TMeta> | undefined {
    return this.stops[this.step];
  }

  private moveTo(step: number): Move<TMeta> {
    const from = this.at();
    this.step = step;
    return { moved: true, from, to: this.stops[step] };
  }

  /** Law 2: a refusal never touches `this.step`. */
  private refuse(reason: 'clamped' | 'miss' | 'empty', nearest?: Stop<TMeta>): Move<TMeta> {
    const at = this.at();
    return nearest ? { moved: false, reason, at, nearest } : { moved: false, reason, at };
  }

  first(): Move<TMeta> {
    if (this.stops.length === 0) return this.refuse('empty');
    if (this.step === 0) return this.refuse('clamped');
    return this.moveTo(0);
  }

  last(): Move<TMeta> {
    if (this.stops.length === 0) return this.refuse('empty');
    const end = this.stops.length - 1;
    if (this.step === end) return this.refuse('clamped');
    return this.moveTo(end);
  }

  prev(): Move<TMeta> {
    if (this.stops.length === 0) return this.refuse('empty');
    if (this.step === 0) return this.refuse('clamped');
    return this.moveTo(this.step - 1);
  }

  next(): Move<TMeta> {
    if (this.stops.length === 0) return this.refuse('empty');
    if (this.step >= this.stops.length - 1) return this.refuse('clamped');
    return this.moveTo(this.step + 1);
  }

  jumpTo(target: number | string): Move<TMeta> {
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
  private nearestTo(runtimeStageId: string): Stop<TMeta> | undefined {
    const hash = runtimeStageId.lastIndexOf('#');
    if (hash === -1) return undefined;
    const stagePart = runtimeStageId.slice(0, hash);
    const wanted = Number.parseInt(runtimeStageId.slice(hash + 1), 10);

    let sameStage: Stop<TMeta> | undefined;
    let byIndex: Stop<TMeta> | undefined;
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

  stateAt(stop?: Stop<TMeta>): FoldedState {
    const target = stop ?? this.at();
    const leg = target?.sourceIdx ?? 0;
    const fold = foldLegsFrom(this.legs, leg, target ? target.lastCommitIdx : -1, this.foldMemo);
    this.foldMemo = fold.memo;
    const folded = fold.folded;
    // Which leg the index belongs to, but only when there is more than one —
    // a single-source fold keeps the 9.17.0 shape exactly.
    return this.legs.length > 1 ? { ...folded, sourceIdx: leg } : folded;
  }

  changedSince(from?: Stop<TMeta>): readonly string[] {
    const to = this.at();
    if (!to) return Object.freeze([]);
    const start = from ?? this.stops[this.step - 1];
    // No earlier stop (we are at `'start'`) ⇒ everything up to here: nothing
    // on a run cursor, and the subflow's `inputMapper` seed on a drilled one
    // (the start bookend covers the id-less commits that precede stage one).
    const toLeg = to.sourceIdx ?? 0;
    const fromLeg = start ? start.sourceIdx ?? 0 : toLeg;
    const afterIdx = start ? start.lastCommitIdx : -1;
    const keys = new Set<string>();
    // A range that crosses a chain seam is walked leg by leg: the tail of the
    // leg it started in, every leg in between whole, then the head of the leg
    // it ends in. Backwards ranges walk nothing and give `[]`, as before.
    for (let leg = fromLeg; leg <= toLeg && leg < this.legs.length; leg++) {
      const log = this.legs[leg].log;
      const lo = leg === fromLeg ? afterIdx + 1 : 0;
      const hi = leg === toLeg ? to.lastCommitIdx : log.length - 1;
      for (let i = lo; i <= hi; i++) {
        const bundle = log[i];
        if (!bundle) continue;
        for (const entry of bundle.trace) keys.add(entry.path);
      }
    }
    return Object.freeze([...keys].sort());
  }

  // ── Marks (law 4: beside the log, never in it) ───────────────────────────

  mark(name: string, stop?: Stop<TMeta>): Mark | undefined {
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

  jumpToMark(name: string): Move<TMeta> {
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

  drill(mountRuntimeStageId: string): TimeTravel<TMeta> | undefined {
    // On a chain, the mount is looked for in every leg — a subflow that ran
    // before the pause is in the first snapshot's results, one that ran after
    // is in the second's. Ids are unique across a sound chain (chain.ts
    // refuses one where they are not), so the first hit is the only hit.
    let results: Record<string, unknown> | undefined;
    let result: SubflowResultShape | undefined;
    for (const source of this.sources) {
      // A stored recording's results are parsed JSON: read them as a map only
      // when they are one, and as "no subflows" otherwise.
      if (!isPlainish(source.subflowResults)) continue;
      const hit = source.subflowResults[mountRuntimeStageId] as SubflowResultShape | undefined;
      if (hit) {
        results = source.subflowResults;
        result = hit;
        break;
      }
    }
    const tree = result?.treeContext;
    if (!results || !result || !tree || !Array.isArray(tree.history)) return undefined;

    // `path` is the subflow PATH — the same string for every iteration of a
    // mount inside a loop. `mountRuntimeStageId` is the iteration actually
    // opened, so a UI can label and key three drill panels over `sfx#2`,
    // `sfx#8`, `sfx#14` apart instead of calling all three 'sfx'.
    const childPath = result.subflowId ?? mountRuntimeStageId;
    const child: TimeTravelSource = {
      // Rows are narrowed per bundle when the child reads them — a stored
      // recording's inner history needs no cast either.
      commitLog: tree.history,
      initialState: tree.initialState,
      executionTree: tree.stageContexts,
      // Nested subflow results are merged UP into one flat, dual-keyed map, so
      // the child can drill further through the same map.
      subflowResults: results,
    };
    return new Cursor<TMeta>([child], { strategy: this.options.strategy }, childPath, this, mountRuntimeStageId);
  }
}

/**
 * Re-step per-source stops into ONE axis.
 *
 * The INTERIOR bookends go: a `'start'` on any leg but the first, and an
 * `'end'` on any leg but the last, are bookends of a leg and not of the run —
 * keeping them would put "the run is over" in the middle of the axis. The
 * commits they covered are not orphaned: a fold always replays its leg from
 * that leg's own base, and `changedSince` walks a seam-crossing range leg by
 * leg (including the head of the leg it ends in). The stops' `commitIdx` /
 * `lastCommitIdx` ranges PARTITION EACH LEG, never span the seam: a stop's
 * range ends at its own leg's last index, and the next leg's first stop opens
 * at that leg's 0.
 */
function chainStops<TMeta>(perSource: readonly Stop<TMeta>[][]): Stop<TMeta>[] {
  // "Interior" is measured against the legs that actually CONTRIBUTE stops: a
  // leg whose log was empty has no bookends to drop and must not make its
  // neighbour's `'start'` or `'end'` interior — the chained axis still opens
  // with the first stop that exists and closes with the last.
  const contributing = perSource.map((stops) => stops.length > 0);
  const firstLeg = contributing.indexOf(true);
  const lastLeg = contributing.lastIndexOf(true);
  const out: Stop<TMeta>[] = [];
  for (const [sourceIdx, stops] of perSource.entries()) {
    for (const stop of stops) {
      if (sourceIdx > firstLeg && stop.kind === 'start') continue;
      if (sourceIdx < lastLeg && stop.kind === 'end') continue;
      out.push({ ...stop, step: out.length, sourceIdx });
    }
  }
  return out;
}

/**
 * Open a reader's cursor over a finished run.
 *
 * Nothing here executes anything: `snapshot` is a record of a run that already
 * happened, and every question is answered by reading it. A stored JSON
 * snapshot works exactly like a live one — since 9.18.0 its `commitLog` may be
 * an unvalidated `unknown[]`, narrowed per bundle where the fold reads it, so
 * a replayed recording needs no cast.
 *
 * @param snapshot `executor.getSnapshot()`, or any object with the same
 *   shape — including one round-tripped through JSON, or a subflow subtree
 *   (`getSubtreeSnapshot()`, whose log is spelled `history`). An ARRAY of them
 *   is a CHAIN: a pause and its resume read as one axis (see below).
 * @param options `strategy` chooses how stops are derived (default:
 *   `commitStops`, one stop per executed stage); `marks` seeds the cursor with
 *   bookmarks, e.g. restored from a saved reading session.
 *
 * @throws when a chain is not in run order, or its legs are not from one
 *   lineage — three checks, each with its own reason (see `chain.ts`):
 *   no `runtimeStageId` may appear in two legs; each leg's first execution
 *   index must be past the previous leg's last (the engine never resets the
 *   counter across a resume); and each leg's `initialState` must deep-equal
 *   the state the legs before it fold to — on a resume that base IS the state
 *   at the pause, so a foreign leg whose indices merely happen to be higher
 *   is refused too. The third check runs only where the record allows it: the
 *   later leg must carry an `initialState` and the earlier legs must fold from
 *   a real base with no unreadable rows; otherwise (an older recording with
 *   no base) the chain rests on the two index checks alone, and the fold's
 *   `basis` says what it stood on.
 *
 * @example
 * ```typescript
 * const tt = timeTravel(executor.getSnapshot());
 * tt.jumpTo('score-risk#4');
 * console.log(tt.changedSince());        // ['riskScore', 'tier']
 * console.log(tt.stateAt().state);       // state as that stage left it
 * tt.mark('the bad one');
 * const inner = tt.drill('sf-payment#7'); // a separate cursor, its own log
 *
 * // A pause and its resume, read as ONE axis:
 * const chained = timeTravel([pausedSnapshot, resumedSnapshot]);
 * chained.last();                         // the run's real end
 * chained.at()!.sourceIdx;                // 1 — which leg the indices are in
 * chained.jumpTo('approve#3');            // finds it in either leg
 * ```
 */
export function timeTravel<TMeta = unknown>(
  snapshot: TimeTravelSource | readonly TimeTravelSource[],
  options: TimeTravelOptions<TMeta> = {},
): TimeTravel<TMeta> {
  const sources = Array.isArray(snapshot) ? (snapshot as readonly TimeTravelSource[]) : [snapshot as TimeTravelSource];
  // A one-element array is not a chain: it is the plain cursor, and skips the
  // lineage checks a single source cannot fail.
  if (sources.length !== 1) {
    const refusal = refuseChain(sources.map((source) => readSource(source)));
    if (refusal) throw new Error(refusal);
  }
  return new Cursor<TMeta>(sources, options);
}
