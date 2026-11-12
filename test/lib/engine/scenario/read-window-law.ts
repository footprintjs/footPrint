/**
 * The read-window law — the named record change (foottrace 1.13.0) that the older byte references
 * predate: a step's FIRST bundle says what the step could have seen of the log while it ran.
 *
 *   - `beganAt`: how many commits the log held at the earliest moment one of the step's reads saw
 *     state, written only when ANOTHER step committed between that moment and the step's own commit;
 *   - `sawUntil`: how many it held at the latest such moment, written only when that is after such a
 *     commit (then `beganAt < sawUntil`).
 *
 * A step that only wrote carries neither, and so does every step of a run whose steps go one after
 * another: their bytes do not move. Steps that run side by side (fork children, a `parallelForEach`
 * fan-out whose branches commit while it runs) gain the stamps where a sibling committed under them.
 * foottrace enforces the shape: whole numbers, `beganAt` before the bundle's own `idx`, `sawUntil`
 * after `beganAt` and not past `idx` (`foottrace · readWindow`).
 *
 * A reference written by an older engine (or captured from one) cannot carry them, and it is never
 * regenerated (it exists to be old). So a byte pin takes the stamps out of the BUILD's bytes and
 * compares every remaining byte. Each stamp is checked before it is taken out, so the law stays
 * visible: it sits on a first bundle (no `phase`), its numbers are a valid window, and a commit of
 * ANOTHER step lies inside `[beganAt, idx)` of the same log, i.e. the step really ran beside another.
 * A caller then asserts WHICH steps carry them (exactly, for a hand-written scenario; on which kind
 * of step and that the generated programs reach them, for a property), so a build that lost the
 * stamps, or put one on a step that ran alone, fails.
 */

import { type Json, isBundle, takeFromBundlesInLogs } from './bundles-in-logs.js';

/** The two field names of the law: the only bytes it may move. */
export const READ_WINDOW_FIELDS = ['beganAt', 'sawUntil'] as const;

/** One stamped bundle, as taken out. */
export interface ReadWindow {
  readonly runtimeStageId: string;
  readonly beganAt: number;
  readonly sawUntil?: number;
}

const isStamped = (bundle: Json) => READ_WINDOW_FIELDS.some((field) => Object.hasOwn(bundle, field));

/** Check one stamped bundle against the log it sits in, then take its stamps out. */
function takeOne(bundle: Json, log: readonly unknown[]): ReadWindow {
  const where = `read-window law at ${bundle.runtimeStageId} (idx ${bundle.idx})`;
  const { beganAt, sawUntil, idx } = bundle;
  if (bundle.phase !== undefined) throw new Error(`${where}: a stamp on a '${bundle.phase}' bundle, not a first one`);
  if (!Number.isInteger(beganAt) || beganAt < 0 || !Number.isInteger(idx) || beganAt >= idx) {
    throw new Error(`${where}: beganAt ${beganAt} is not a whole number before idx ${idx}`);
  }
  if (sawUntil !== undefined && (!Number.isInteger(sawUntil) || sawUntil <= beganAt || sawUntil > idx)) {
    throw new Error(`${where}: sawUntil ${sawUntil} is not after beganAt ${beganAt} and within idx ${idx}`);
  }
  const besideAnother = log.some(
    (other) =>
      isBundle(other) &&
      other.runtimeStageId !== bundle.runtimeStageId &&
      Number.isInteger(other.idx) &&
      other.idx >= beganAt &&
      other.idx < idx,
  );
  if (!besideAnother) throw new Error(`${where}: no other step committed inside [${beganAt}, ${idx})`);
  delete bundle.beganAt;
  delete bundle.sawUntil;
  return { runtimeStageId: bundle.runtimeStageId, beganAt, ...(sawUntil === undefined ? {} : { sawUntil }) };
}

/**
 * Take the law's stamps out of every commit bundle inside `value`, in place, each checked first (see
 * the header). Returns them in walk order (depth first, object keys in order, a log's bundles in log
 * order). A stamped bundle that is not inside a log (an array of bundles) cannot be checked and fails.
 */
export function takeReadWindows(value: unknown): ReadWindow[] {
  return takeFromBundlesInLogs(value, 'read-window law', isStamped, takeOne);
}

/**
 * The same on a record's JSON text, re-serialised in the same layout, with the stamps asserted to be
 * EXACTLY `expected` (walk order). The only bytes this can move are the two fields.
 */
export function withoutReadWindowsText(json: string, expected: readonly ReadWindow[]): string {
  const space = json.includes('\n') ? 2 : undefined;
  const parsed = JSON.parse(json);
  // Without an edit the re-serialised text IS the input — so the only bytes this can move are the law's.
  if (JSON.stringify(parsed, null, space) !== json)
    throw new Error('withoutReadWindowsText: the text does not round-trip');
  const taken = takeReadWindows(parsed);
  if (JSON.stringify(taken) !== JSON.stringify(expected)) {
    throw new Error(
      `read-window law: the record carries ${JSON.stringify(taken)}, expected ${JSON.stringify(expected)}`,
    );
  }
  return JSON.stringify(parsed, null, space);
}
