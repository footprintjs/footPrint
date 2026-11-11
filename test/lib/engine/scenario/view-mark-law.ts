/**
 * The view-mark law — the named record change (foottrace 1.14.0) that the older byte references predate:
 * a `set` row the record's writer built on the step's view says so.
 *
 * The writer sometimes stores a `set` of a whole value where the step only added to it: under
 * `commitValues: 'delta'` when a step merged into a key and also wrote a path inside it, and under either
 * encoding when the step's rows would not fold back to what the step read. In the fold such a row replaces
 * the value, and it still holds what the step's view held. Before 1.14.0 nothing in the record told the
 * two kinds of `set` apart, so a walk back ended at such a row. Now:
 *
 *   - `builtOnView: true` on the trace row. Only on a `set`, and never where the step set or deleted the
 *     path, or a container around it, itself;
 *   - `viewAt` on the bundle: how many commits the log held when the step's view was pinned. Only on a
 *     bundle that holds such a row, and only when another commit landed since the pin. Absent, the view
 *     was the state just before the commit.
 *
 * Every other byte of the row and of the bundle is what it was. A step's read stamps (`beganAt`,
 * `sawUntil`, `read-window-law.ts`) do not move either.
 *
 * A reference written by an older engine (or captured from one) cannot carry the two fields, and it is
 * never regenerated (it exists to be old). So a byte pin takes them out of the BUILD's bytes and compares
 * every remaining byte. Each is checked before it is taken out, so the law stays visible: the mark is
 * `true` and sits on a `set` row of a bundle that says its place in the log (`idx`); a `viewAt` sits on a
 * bundle that holds a marked row, is a whole number before that `idx`, and a commit lies inside
 * `[viewAt, idx)` of the same log. A caller then
 * asserts WHICH rows carry the mark (exactly, for a hand-written scenario; that the generated programs
 * reach some, for a property), so a build that lost the mark fails.
 *
 * NOT CHECKED HERE, and why: that the step did not set the path itself. A bundle holds the rows the
 * writer made, not the writes the step asked for, so that half of the law cannot be read off a record.
 * It is the writer's own test, in the package that owns the writer (foottrace · `hardWriteCoverage`).
 */

import { type Json, takeFromBundlesInLogs } from './bundles-in-logs.js';

/** The two field names of the law: the only bytes it may move. `builtOnView` on a row, `viewAt` on its bundle. */
export const VIEW_MARK_FIELDS = ['builtOnView', 'viewAt'] as const;

/**
 * The marks of one bundle, as taken out: the step, where its bundle sits in the log (`idx`), the paths
 * of its marked rows in row order, and its stamp.
 */
export interface ViewMark {
  readonly runtimeStageId: string;
  readonly idx: number;
  readonly paths: readonly string[];
  readonly viewAt?: number;
}

const isRow = (x: unknown): x is Json => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Does this bundle carry the law: a row with the mark, or the stamp? */
const carriesTheLaw = (bundle: Json): boolean =>
  Object.hasOwn(bundle, 'viewAt') ||
  (bundle.trace as unknown[]).some((row) => isRow(row) && Object.hasOwn(row, 'builtOnView'));

/** Check one bundle's mark and stamp against the log it sits in, then take them out. */
function takeOne(bundle: Json, log: readonly unknown[]): ViewMark {
  const where = `view-mark law at ${bundle.runtimeStageId} (idx ${bundle.idx})`;
  const paths: string[] = [];
  for (const row of bundle.trace as unknown[]) {
    if (!isRow(row) || !Object.hasOwn(row, 'builtOnView')) continue;
    if (row.builtOnView !== true) throw new Error(`${where}: a mark that is not true on ${row.path}`);
    if (row.verb !== 'set') throw new Error(`${where}: the mark on a '${row.verb}' row (${row.path}), not a set`);
    paths.push(row.path);
    delete row.builtOnView;
  }
  const { viewAt, idx } = bundle;
  if (!Number.isInteger(idx) || idx < 0) throw new Error(`${where}: a bundle whose idx is not its place in a log`);
  if (viewAt === undefined) return { runtimeStageId: bundle.runtimeStageId, idx, paths };
  if (paths.length === 0) throw new Error(`${where}: viewAt on a bundle with no row built on the view`);
  if (!Number.isInteger(viewAt) || viewAt < 0 || viewAt >= idx) {
    throw new Error(`${where}: viewAt ${viewAt} is not a whole number before idx ${idx}`);
  }
  const sinceThePin = log.some(
    (other) =>
      other !== bundle && isRow(other) && Number.isInteger(other.idx) && other.idx >= viewAt && other.idx < idx,
  );
  if (!sinceThePin) throw new Error(`${where}: no commit landed inside [${viewAt}, ${idx})`);
  delete bundle.viewAt;
  return { runtimeStageId: bundle.runtimeStageId, idx, paths, viewAt };
}

/**
 * Take the law's mark and stamp out of every commit bundle inside `value`, in place, each checked first
 * (see the header). Returns one entry per bundle that carried either, in walk order. A bundle that
 * carries them outside a log (an array of bundles) cannot be checked and fails.
 */
export function takeViewMarks(value: unknown): ViewMark[] {
  return takeFromBundlesInLogs(value, 'view-mark law', carriesTheLaw, takeOne);
}

/** A copy of `value` without the law's fields; what was taken is pushed onto `into`. The original is not touched. */
export function withoutViewMarks<T>(value: T, into: ViewMark[]): T {
  if (value === null || value === undefined) return value;
  const copy = structuredClone(value);
  into.push(...takeViewMarks(copy));
  return copy;
}
