/**
 * tagStops — the stops a chart DECLARED, read back off its commit log.
 *
 * WHY THIS FILE EXISTS. `commitStops` is the only stop grammar the substrate
 * knows: one stop per executed stage. Every richer axis — milestones, turns,
 * tool calls — was a consumer's classifier over `runtimeStageId`: a switch
 * that parses `#` and `/`, lives outside the recording, and goes stale when
 * a stage is renamed. Since 9.21.0 the author can put NAMES on a stage at
 * build time (`FlowChartBuilder.tag` / `options.tags`) and the engine stamps
 * them on the stage's commit bundle (`CommitBundle.tags`). This strategy
 * reads them back: a stored recording from ANY chart scrubs by its own
 * milestones, with no id conventions in the reader.
 *
 * WHAT IT IS. One expression over `filterStops(commitStops(...))`: keep the
 * stops whose FIRST bundle carries a tag (any of the asked-for ones, or any
 * tag at all when none are asked for), give the survivors the log back, and
 * carry the bundle's whole tag array as `Stop.meta`. Everything a filtering
 * axis owes — the bookend guard, the re-partition so a dropped stage's
 * commits fold into the tagged stop BEFORE them, `prologue` on a start that
 * absorbed stages — comes from `filterStops`, stated once, in `axis.ts`.
 *
 * WHAT IT IS NOT. Not a second vocabulary: the strings are the consumer's,
 * carried verbatim. Not a derivation: a stage with no declared tag gets no
 * stop here, however recognisable its id — a reader that wants ids classified
 * writes that keep rule itself (`filterStops`), or reads the fold
 * (`stateAt`) and keeps by what changed. And not a re-walk: only a tag the
 * engine actually stamped can put a stop on this axis.
 */

import type { CommitBundle, StageSnapshot } from '../memory/types.js';
import { filterStops } from './axis.js';
import { commitStops } from './commitStops.js';
import type { Stop, TimeTravelStrategy } from './types.js';

/**
 * The tags a stop's first bundle carries, or `undefined` when it carries
 * none. Reads the bundle at `stop.commitIdx` — the FIRST commit of the
 * stage, which is where `StageContext.commit` records the stamp (a fork
 * child's empty repeat and a mount's exit bundle carry none).
 */
function tagsAt(log: readonly CommitBundle[], stop: Stop<unknown>): readonly string[] | undefined {
  const raw = log[stop.commitIdx]?.tags;
  // A stored row is `unknown[]`-shaped until narrowed: keep only the strings,
  // so a damaged row can never put a non-name into `Stop.meta`.
  const tags = Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : [];
  return tags.length > 0 ? tags : undefined;
}

/**
 * A {@link TimeTravelStrategy} whose stops are the stages that carry a
 * declared tag.
 *
 * **Keep rule: any-of.** A stop survives when its bundle's `tags` shares at
 * least one name with `tags`; with `tags` omitted (or empty), every tagged
 * stop survives. All-of, or a rule over more than the tags, is a
 * `filterStops` call away — the library owns no vocabulary, so it owns no
 * richer rule either.
 *
 * **Attribution by precedence.** An untagged stage's commits fold into the
 * tagged stop BEFORE it (what `filterStops` does); the commits before the
 * first tagged stage are absorbed by `'start'`, which then says
 * `prologue: true`. A run with no tagged stage yields the two bookends only.
 *
 * **`meta` is the array.** Each kept stop carries its bundle's full `tags`
 * (not just the ones asked for), so a reader that filtered on
 * `'milestone:llm-turn'` can still see the stage was also `'audit'`.
 *
 * **The equivalence law.** `stateAt(stop)` at every kept stop equals
 * `commitStops`'s fold at the same commit index — a filtering axis moves the
 * stops, never the log.
 *
 * @example
 * ```typescript
 * import { flowChart } from 'footprintjs';
 * import { tagStops, timeTravel } from 'footprintjs/trace';
 *
 * const chart = flowChart<State>('Seed', seedFn, 'seed')
 *   .addFunction('Call model', callFn, 'call-llm')
 *   .tag('milestone:llm-turn')
 *   .addFunction('Route', routeFn, 'route')
 *   .tag('milestone:decision')
 *   .build();
 *
 * // …run it, keep the snapshot…
 * const cursor = timeTravel(snapshot, { strategy: tagStops(['milestone:llm-turn']) });
 * cursor.stops.map((s) => s.label);   // ['Run start', 'Call model', 'Run end']
 * cursor.stops[1].meta;               // ['milestone:llm-turn']
 * cursor.stops[0].prologue;           // true — 'seed' ran before the first turn
 * ```
 */
export function tagStops(tags?: readonly string[]): TimeTravelStrategy<readonly string[]> {
  const wanted = tags && tags.length > 0 ? new Set(tags) : undefined;
  return {
    stopsFor(commitLog: readonly CommitBundle[], executionTree?: StageSnapshot): Stop<readonly string[]>[] {
      return filterStops<readonly string[]>(commitStops(commitLog, executionTree), (stop) => {
        const stamped = tagsAt(commitLog, stop);
        if (!stamped) return null;
        if (wanted && !stamped.some((tag) => wanted.has(tag))) return null;
        return { meta: stamped };
      });
    },
  };
}
