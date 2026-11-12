/**
 * servedPlaces.ts — the places a redaction rule hides in a record it serves whole, as paths.
 *
 * WHY THIS FILE EXISTS. A stage is handed its input (`$getArgs()`), and what the library hides when it
 * SHOWS that input is what the stage must not pass on under another name
 * (`hiddenObjectTrail.ts · rememberInput`). The rule that shows it is `RedactionRule · retainBoundary`:
 * a selected name at any depth, a dotted key, a path pattern, a declared field. This file asks that
 * rule and reads its answer back as paths, so the policy is read in one place. The first cut walked
 * the input by itself and matched names only: a dotted key and a path pattern were missed, and a long
 * list ended the walk.
 *
 * HOW. The record is served with a marker where the rule would put its placeholder. The rule copies
 * only the parts it changes (copy-on-write, one decision for each path), so the served record is
 * walked beside the original and only where the two differ. One object can sit at two paths and be
 * served differently at each: a part is passed over only when the SAME served copy comes back (a
 * loop), never because the original was seen at another path.
 *
 * WHY THE ANSWER IS KEPT, AND FOR WHAT. Every stage of a run is handed the same input, and one look at
 * 200,000 records takes about 150 ms (`bench/input-under-policy.ts`, 12 Nov 2026: a run of one stage
 * that asks for its input went from 292 to 434 ms). Asked again for each stage, that would be paid
 * once a stage; kept, twenty stages cost what one does (280 to 430 ms). It is kept only where it
 * cannot go stale:
 *   - for a record that cannot change: every container in it is frozen and plain, with no accessor.
 *     The run's own snapshot of an input is that; a capability or a caller's frozen wrapper inside it
 *     is borrowed and may change, and then nothing is kept;
 *   - while the rule's policy and marks are the same: a rule can be handed a new policy, and a name
 *     marked later hides that key of the input too.
 *
 * No outside source. A leaf beside the rule: it imports the rule's type and asks its one public door.
 */

import type { RedactionRule } from './redaction.js';

/** Put where the rule hides a place, so that the place can be told from any text in the record. */
const HIDDEN_HERE = '\u0000hidden\u0000';

/** What was kept, and what it was true for. */
interface KeptPlaces {
  readonly policy: unknown;
  readonly marks: string;
  readonly places: readonly string[] | undefined;
}

const placesKept = new WeakMap<RedactionRule, WeakMap<object, KeptPlaces>>();
/** Whether a record can change ({@link cannotChange}): asked once for each record. */
const fixedRecords = new WeakMap<object, boolean>();

/**
 * The places `rule` hides in `record` when it serves it whole, as dot-paths from the top. Empty: it
 * hides nothing. `undefined`: the rule cannot serve it (its keys cannot be read), and the caller
 * takes the safe side.
 *
 * ```ts
 * placesHiddenIn(new RedactionRule({ keys: ['secret'] }), { order: { secret: { token: 't' } } }); // ['order.secret']
 * ```
 */
export function placesHiddenIn(rule: RedactionRule, record: object): readonly string[] | undefined {
  let fixed = fixedRecords.get(record);
  if (fixed === undefined) fixedRecords.set(record, (fixed = cannotChange(record)));
  if (!fixed) return served(rule, record);
  const policy = rule.getPolicy();
  const marks = JSON.stringify(rule.marksForCheckpoint() ?? null);
  let ofRule = placesKept.get(rule);
  const kept = ofRule?.get(record);
  if (kept !== undefined && kept.policy === policy && kept.marks === marks) return kept.places;
  const places = served(rule, record);
  if (ofRule === undefined) placesKept.set(rule, (ofRule = new WeakMap()));
  ofRule.set(record, { policy, marks, places });
  return places;
}

/**
 * Serve `record` with the marker and read the hidden places back. `undefined` when the rule cannot
 * serve it. The list is frozen: it becomes a rule's list of paths, and what such a list says is kept
 * for the list only when the list cannot change (`selectedObjects.ts · read`).
 */
function served(rule: RedactionRule, record: object): readonly string[] | undefined {
  try {
    return Object.freeze(hiddenPlaces(record, rule.retainBoundary(record, HIDDEN_HERE)));
  } catch {
    return undefined;
  }
}

/**
 * The places of `record` that `shown` hides: `shown` is the record as the rule serves it, with
 * {@link HIDDEN_HERE} at each hidden place and every untouched part the same object as in `record`.
 */
function hiddenPlaces(record: object, shown: unknown): string[] {
  const places: string[] = [];
  /** The served copies already walked: the same copy again is a loop. Not the originals (file header, why). */
  const walked = new Set<object>();
  const todo: [object, unknown, string][] = [[record, shown, '']];
  for (let next = todo.pop(); next !== undefined; next = todo.pop()) {
    const [node, its, at] = next;
    if (its === node || its === null || typeof its !== 'object' || walked.has(its)) continue;
    walked.add(its);
    const look = (key: string | number): void => {
      const held = (node as Record<string | number, unknown>)[key];
      const served = (its as Record<string | number, unknown>)[key];
      if (served === held) return;
      const place = at === '' ? String(key) : `${at}.${key}`;
      if (served === HIDDEN_HERE) places.push(place);
      else if (held !== null && typeof held === 'object') todo.push([held, served, place]);
    };
    // A list by its indexes: a long one has as many keys as items, and most items were not copied.
    if (Array.isArray(node)) for (let i = 0; i < node.length; i++) look(i);
    else for (const key of Object.keys(node)) look(key);
  }
  return places;
}

/**
 * Can nothing in `record` change? Every container in it is frozen and plain (a record or a list), and
 * no key is an accessor. Anything else (a class instance, a Map, bytes, a getter) may answer
 * differently the next time it is read.
 */
function cannotChange(record: object): boolean {
  const seen = new Set<object>();
  const todo: object[] = [record];
  for (let node = todo.pop(); node !== undefined; node = todo.pop()) {
    if (seen.has(node)) continue;
    seen.add(node);
    const proto: unknown = Object.getPrototypeOf(node);
    const list = Array.isArray(node);
    if (!Object.isFrozen(node) || (list ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)) {
      return false;
    }
    for (const key of Object.keys(node)) {
      const own = Object.getOwnPropertyDescriptor(node, key);
      if (own === undefined || own.get !== undefined || own.set !== undefined) return false;
      if (own.value !== null && typeof own.value === 'object') todo.push(own.value as object);
    }
  }
  return true;
}
