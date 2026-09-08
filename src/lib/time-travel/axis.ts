/**
 * axis.ts — the shape of an axis, and the one safe way to narrow it.
 *
 * WHY THIS FILE EXISTS. `commitStops` returns `Stop[]`, and every strategy
 * that COMPOSES it (keep the stages my domain recognises, drop the rest) rests
 * on a shape the type never stated: `[start, …stages, end]` for a non-empty
 * log, empty for an empty one. Each composer therefore wrote its own runtime
 * guard against its own reading of the contract, plus a mocked-substrate test
 * to prove the guard fires. That is one invariant, discovered three times, and
 * the library that owns the invariant should be the one that states it.
 *
 * {@link splitAxis} states it. {@link filterStops} then does the whole
 * composition — check the shape, keep what the caller keeps, RE-PARTITION the
 * log so the dropped stages' commits are still folded somewhere, and mark the
 * `'start'` bookend as carrying a prologue — because getting the
 * re-partitioning right by hand is the other thing every composer had to
 * rediscover.
 */

import type { AxisSplit, Stop, StopKind } from './types.js';

/**
 * Split a strategy's stops into `{ start, stages, end }`, or say why it cannot.
 *
 * THE INVARIANT, stated once: for a non-EMPTY log, `commitStops` returns at
 * least the two bookends, `'start'` first and `'end'` last, with one stop per
 * executed stage in execution order between them. For an EMPTY log it returns
 * `[]` — no bookends around nothing, because a cursor with nowhere to stand
 * should say `reason: 'empty'` rather than offer two positions that are the
 * same position.
 *
 * The two refusals are different facts and must not be collapsed: `'empty'`
 * means the run committed nothing, `'not-bookended'` means a strategy broke
 * the contract. A composer that treats them alike reports a broken strategy as
 * an empty run.
 *
 * @example
 * ```typescript
 * import { commitStops, splitAxis } from 'footprintjs/trace';
 *
 * const axis = splitAxis(commitStops(snapshot.commitLog, snapshot.executionTree));
 * if (axis.ok) {
 *   axis.start.commitIdx;          // -1 — the fold base
 *   axis.stages.map((s) => s.label);
 *   axis.end.lastCommitIdx;        // the last bundle in the log
 * } else {
 *   axis.reason;                   // 'empty' | 'not-bookended'
 * }
 * ```
 */
export function splitAxis<TMeta = unknown>(stops: readonly Stop<TMeta>[]): AxisSplit<TMeta> {
  const kinds: readonly StopKind[] = Object.freeze(stops.map((stop) => stop.kind));
  if (stops.length === 0) return { ok: false, reason: 'empty', kinds };
  const start = stops[0];
  const end = stops[stops.length - 1];
  if (start.kind !== 'start' || end.kind !== 'end' || stops.length < 2) {
    return { ok: false, reason: 'not-bookended', kinds };
  }
  return { ok: true, start, stages: Object.freeze(stops.slice(1, -1)), end };
}

/**
 * What {@link filterStops} does with one stop: drop it, keep it, or keep it
 * carrying the strategy's own label and vocabulary.
 *
 * `false` / `null` / `undefined` drop. `true` keeps it unchanged. An object
 * keeps it and overrides `label` and/or sets `meta` — the strategy's own
 * classification, travelling ON the stop instead of being re-derived from
 * `runtimeStageId` at every read.
 */
export type StopFilter<TMeta> = boolean | null | undefined | { readonly label?: string; readonly meta?: TMeta };

/**
 * `stop` retyped to the OUTPUT vocabulary, with any meta it already carried
 * left behind. The input axis may itself be a filtered one (a Beat axis being
 * narrowed into a Tag axis), and a `true` decision keeps the STOP, not the
 * other strategy's classification: a `Stop<Tag>` whose `meta` is a Beat would
 * be a lie the type could not catch. Only the decision may supply a meta.
 */
function retyped<TMeta>(stop: Stop<unknown>): Stop<TMeta> {
  if (stop.meta === undefined) return stop as Stop<TMeta>;
  const out: Record<string, unknown> = {};
  const fields = stop as unknown as Record<string, unknown>;
  for (const key of Object.keys(fields)) if (key !== 'meta') out[key] = fields[key];
  return out as unknown as Stop<TMeta>;
}

/**
 * Build a FILTERING strategy's axis out of another strategy's stops.
 *
 * The rule, in one sentence: keep the stages `keep` recognises, and give the
 * survivors the log back.
 *
 * **Meta is the decision's, never inherited.** The input may already be a
 * filtered axis carrying another strategy's `meta`; a `true` (or a meta-less
 * object) keeps the stop and DROPS that meta, so a `Stop<TMeta>` never carries
 * a value of some other type under `TMeta`. The bookends carry none either.
 *
 * **The survivors re-partition the log.** A dropped stage's commits still
 * happened, so they fold into the stop that PRECEDES them: every kept stop's
 * `lastCommitIdx` runs to just before the next kept stop begins. Nothing is
 * orphaned and `stateAt(stop)` stays "the state that existed when the next
 * kept stage started".
 *
 * **What that costs `'start'`, said out loud.** The commits before the first
 * survivor have nowhere else to go, so `'start'` absorbs them: its fold is the
 * run's base PLUS that prologue — the state the first stop READ, not the raw
 * base. The returned start therefore carries `prologue: true` whenever it
 * actually absorbed a stage, and a renderer that means "before anything ran"
 * checks `kind === 'start' && !prologue`. That flag is the whole reason this
 * helper exists rather than a `.filter()` call.
 *
 * **A log with nothing kept** yields the two bookends and nothing between
 * them: `'start'` folds the whole log, `'end'` folds the whole log, and
 * `jumpTo` on any stage id refuses with `reason: 'miss'`. An axis with nowhere
 * meaningful to stand — which is the truthful shape for a run this strategy
 * recognises nothing in, and NOT the `[]` that says the log was empty.
 *
 * @throws when `stops` is non-empty but not bookended — see {@link splitAxis}.
 *   Only a strategy can cause that; a run cannot, so it is a contract error
 *   and not a condition to fold into the data.
 *
 * @example
 * ```typescript
 * import { commitStops, filterStops } from 'footprintjs/trace';
 * import type { Stop, TimeTravelStrategy } from 'footprintjs/trace';
 *
 * type Milestone = { kind: 'llm-turn' | 'tool-call'; label: string };
 * declare function milestoneFor(runtimeStageId: string): Milestone | null;
 *
 * const milestoneStops: TimeTravelStrategy<Milestone> = {
 *   stopsFor: (log, tree) =>
 *     filterStops<Milestone>(commitStops(log, tree), (stop) => {
 *       const m = milestoneFor(stop.runtimeStageId);
 *       return m ? { label: m.label, meta: m } : null;
 *     }),
 * };
 *
 * const cursor = timeTravel(snapshot, { strategy: milestoneStops });
 * cursor.at()?.meta?.kind;        // 'llm-turn' — no re-derivation
 * cursor.stops[0].prologue;       // true when stages ran before the first turn
 * ```
 */
export function filterStops<TMeta = unknown>(
  stops: readonly Stop<unknown>[],
  keep: (stop: Stop<unknown>) => StopFilter<TMeta>,
): Stop<TMeta>[] {
  const axis = splitAxis(stops);
  if (!axis.ok) {
    if (axis.reason === 'empty') return [];
    throw new Error(
      'filterStops: expected a bookended axis — [start, …stages, end] — got kinds ' +
        `[${axis.kinds.join(', ')}]. Only a strategy can produce that shape; a run cannot.`,
    );
  }

  const kept: { stop: Stop<unknown>; label?: string; meta?: TMeta }[] = [];
  for (const stop of axis.stages) {
    const decision = keep(stop);
    if (!decision) continue;
    if (decision === true) kept.push({ stop });
    else kept.push({ stop, label: decision.label, meta: decision.meta });
  }

  // The log's last index, taken from the `'end'` bookend rather than a length:
  // `end` is the one stop guaranteed to fold the whole log, and this function
  // is never handed the log itself.
  const lastIdx = axis.end.lastCommitIdx;
  const first = kept[0];
  const out: Stop<TMeta>[] = [
    {
      ...retyped<TMeta>(axis.start),
      step: 0,
      lastCommitIdx: first ? first.stop.commitIdx - 1 : lastIdx,
      // Only when a STAGE was actually absorbed. An axis that kept everything
      // has the same start it always had, and says nothing it need not say.
      ...(first && first.stop.step > 1 ? { prologue: true as const } : {}),
      ...(!first && axis.stages.length > 0 ? { prologue: true as const } : {}),
    },
  ];

  for (const [i, row] of kept.entries()) {
    const next = kept[i + 1];
    out.push({
      ...retyped<TMeta>(row.stop),
      step: out.length,
      lastCommitIdx: next ? next.stop.commitIdx - 1 : lastIdx,
      ...(row.label !== undefined ? { label: row.label } : {}),
      ...(row.meta !== undefined ? { meta: row.meta } : {}),
    });
  }

  out.push({ ...retyped<TMeta>(axis.end), step: out.length });
  return out;
}
