/**
 * markPlaces.ts — where the value of a redaction mark lives.
 *
 * A mark is a NAME (`redaction.ts · RedactionRule`): a value that came from a hidden key and was
 * written under another name stays hidden under that name for the rest of the run. The law lets a
 * delete end a mark, because a key that is gone holds nothing to hide.
 *
 * WHY THIS FILE EXISTS. A run has more than one key of a name: every sub-flowchart has its own state,
 * and every parallel branch its own namespace. "The key was deleted" is true of ONE of them. The mark
 * was kept by name alone, so the first delete of the name anywhere ended it everywhere: a
 * sub-flowchart that deleted its own `copy` un-hid the parent's `copy`, which still held the secret,
 * and the parent's next write of it went into the commit log in the clear.
 *
 * So a mark remembers every PLACE a hidden value under its name landed: the state it landed in and the
 * address under it. THE LAW: a delete ends a mark only by taking away its LAST place. A delete at a
 * place where no value of that name ever landed takes nothing, and changes nothing.
 *
 * A value can also be ON ITS WAY: decided hidden, and written later. The fan-out over hidden items
 * marks `item` and its results key before any branch runs, and the values land as the branches are
 * mounted and when the last one is done. Until then the one who decided holds a place of its own
 * ({@link pendingPlace}) and lets go of it once the values have landed, so nothing that runs in
 * between can end the mark first.
 *
 * And a delete ends nothing while it is only STAGED. A retry may throw the try away, the commit may
 * fail, and the stage may write the key again before it commits. So the frame asks the state once its
 * commit has landed, and takes the place away only when the key is really gone
 * (`StageContext · endMarksOfLandedDeletes`).
 *
 * WHY A LEDGER BESIDE THE MARKS, and not one mark for each place. Marking stays run-wide and by name,
 * exactly as it was: a name hidden in one place is hidden in every place, which errs on the hiding
 * side. Only the way a mark ENDS changed: it ends when no value it stands for is left, or still to
 * come.
 *
 * WHAT THIS COSTS IN HIDING. A place is taken away only by a delete that lands there, so a name stays
 * hidden for the rest of the run once a hidden value under it landed in a place nothing deletes:
 *   - a sub-flowchart's state (also after the sub-flowchart is over, and whatever its parent deletes);
 *   - a parallel branch's namespace (a branch that only CHANGED a hidden list wrote its own copy there);
 *   - each branch of a fan-out over hidden items (`item` stays hidden after the fan-out);
 *   - a place a failed try wrote to, and both names of a fan-out that failed (it never lets go);
 *   - anything that came over a pause (the checkpoint carries names, not places).
 * And a stage that deletes a key and writes it again keeps the name hidden: to show a new value,
 * delete in one stage and write in a later one.
 *
 * WHERE IT HIDES LESS THAN BEFORE, the one case: a mark that never had a value ends when its asker
 * lets go. A fan-out over hidden items that handed out NO items used to leave `item` marked with
 * nothing under it; now that mark ends with the fan-out.
 *
 * In memory it costs one short text for each place a hidden name landed, kept until the run's rule is
 * gone (measured by the second reader of this change: about 94 bytes a place on a fan-out of 5,000).
 *
 * The idea is plain reference counting: a mark is held by its places. No outside source.
 *
 * A leaf: it imports nothing, and only the rule and the frame ask it.
 */

const heapNumbers = new WeakMap<object, number>();
let heapsNumbered = 0;

/**
 * The place a staged write lands, as text: the state (heap) it lands in and the address under it.
 * Two writes are at the same place exactly when both are the same. The heap is named by a number, not
 * held, so a mark keeps no state alive.
 *
 * ```ts
 * placeOf(parentState, []) === placeOf(parentState, []);            // the parent's own keys
 * placeOf(parentState, []) !== placeOf(subflowState, []);           // a sub-flowchart has its own state
 * placeOf(parentState, []) !== placeOf(parentState, ['runs', 'a']); // a parallel branch has its own namespace
 * ```
 */
export function placeOf(heap: object, address: readonly string[]): string {
  let number = heapNumbers.get(heap);
  if (number === undefined) heapNumbers.set(heap, (number = ++heapsNumbered));
  return `${number}\u0000${address.join('\u001f')}`;
}

/**
 * The place of a mark that came over a pause. The names travel in the checkpoint; where their values
 * live in the resumed state does not. No write lands here, so no delete can take it away.
 */
export const CARRIED_OVER_A_PAUSE = '\u0000carried over a pause';

let pendingNumbered = 0;

/**
 * A place for a value that is on its way: decided hidden, not yet written. No write lands here, so no
 * delete can take it. Whoever asked for it marks the name with it (`RedactionRule · mark`) and lets go
 * of it (`RedactionRule · unmark`, with this place) once the value has landed.
 *
 * ```ts
 * const pending = pendingPlace();
 * rule.mark('results', pending);   // decided: what lands under `results` is hidden
 * // … other stages run; one of them deletes its own `results` — the mark stays …
 * // … the value lands under `results` (the write funnel notes its place) …
 * rule.unmark('results', pending); // let go: the mark now ends with the key that holds the value
 * ```
 */
export function pendingPlace(): string {
  return `\u0000on its way ${++pendingNumbered}`;
}

/** Name → the places a hidden value under it landed. Kept for one shared set of marked names: rules that share the set share this. */
const placesByMarkedSet = new WeakMap<Set<string>, Map<string, Set<string>>>();

/** A hidden value under `key` landed at `place`. */
export function notePlace(marked: Set<string>, key: string, place: string): void {
  let places = placesByMarkedSet.get(marked);
  if (places === undefined) placesByMarkedSet.set(marked, (places = new Map()));
  const at = places.get(key);
  if (at === undefined) places.set(key, new Set([place]));
  else at.add(place);
}

/**
 * A delete of `key` at `place`: take that place away. Says whether the place was one of the key's
 * (`taken`) and whether another place still holds a value under the name (`held`). A key with no
 * known place answers `{ taken: false, held: false }`.
 */
export function takePlace(marked: Set<string>, key: string, place: string): { taken: boolean; held: boolean } {
  const at = placesByMarkedSet.get(marked)?.get(key);
  if (at === undefined) return { taken: false, held: false };
  return { taken: at.delete(place), held: at.size > 0 };
}

/** The mark of `key` ended: it has no places any more. */
export function forgetPlaces(marked: Set<string>, key: string): void {
  placesByMarkedSet.get(marked)?.delete(key);
}
