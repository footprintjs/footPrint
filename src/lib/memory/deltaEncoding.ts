/**
 * deltaEncoding.ts — the delta encoding's pure helpers (`commitValues:
 * 'delta'`, #13c-B; docs/design/13c-b-delta-commit-verb.md), out of
 * `TransactionBuffer` since 9.30.0: the overlap families of rule 3 and the
 * order rows are emitted in (which now also places the admitted record's
 * re-encoded families), the append detection, and the row that carries a
 * value. The verb CHOICE stays in `TransactionBuffer · deltaRows`; nothing
 * here replays the verb law.
 */

import type { Rows } from './admission.js';
import { nativeSet as _set } from './pathOps.js';
import { deepEqual, DELIM } from './utils.js';

/** Op-level verbs staged into `opTrace`. `'delete'` is staged distinctly so
 *  delta-mode commits (#13c-B) can emit a real `delete` trace entry; under
 *  the default `'full'` mode it commits as `'set'` (of `undefined`) —
 *  byte-identical to the historical flattening. */
export type OpVerb = 'set' | 'merge' | 'delete';

/** A path that passed the net-change filter, with everything the delta
 *  encoder needs to decide its verb — resolved once, then reused by the
 *  overlap-family grouping (`toDeltaPayload` rule 3). */
export type Survivor = {
  path: string;
  segments: string[];
  verbs: OpVerb[];
  readKeys?: string[];
  /** Index in `opTrace` of this path's last op (its last touch). */
  last: number;
  /** Value at this path when the stage began (the append/diff base). */
  before: unknown;
  /** Value at this path after every staged op (read-your-writes view). */
  after: unknown;
};

/**
 * A delta row carrying a VALUE: an `append` of the tail when `before` is a
 * strict prefix of `value` ({@link isStrictArrayPrefix}), else a `set` of it.
 * The value is cloned here — the one copy the record takes.
 *
 * `marked` — a redaction mark sits BELOW this path (`list.1.token`): its
 * indices count from the start of the WHOLE array, and an `append` row holds
 * only the tail, where `scrubPatch` would find no element 1 and leave the
 * secret in the log and the redacted mirror. Such a path always takes the
 * `set` of the whole value, where the mark lands (9.30.0; the same gap was
 * open in 9.29.0 for a hard write of base + tail).
 */
export function pushValueRow(
  rows: Rows,
  path: string,
  segments: string[],
  before: unknown,
  value: unknown,
  prov: { readKeys: string[] } | undefined,
  marked = false,
): void {
  if (!marked && isStrictArrayPrefix(before, value)) {
    rows.trace.push({ path, verb: 'append', ...prov });
    _set(rows.overwrite, segments, structuredClone((value as unknown[]).slice(before.length)));
  } else {
    rows.trace.push({ path, verb: 'set', ...prov });
    _set(rows.overwrite, segments, structuredClone(value));
  }
}

/**
 * Group survivors into OVERLAP FAMILIES (`toDeltaPayload` rule 3): each path's
 * family is keyed by its SHALLOWEST surviving ancestor — walking prefixes
 * shallow first means the first hit is that root, and a depth-1 path (the
 * common case) never enters the loop at all. Any two paths sharing a root
 * are exactly the paths whose patch storage overlaps.
 */
export function groupIntoFamilies(
  survivors: Survivor[],
  survivingPaths: Set<string>,
): { rootOf: Map<string, string>; byRoot: Map<string, Survivor[]> } {
  const rootOf = new Map<string, string>();
  const byRoot = new Map<string, Survivor[]>();
  for (const s of survivors) {
    let root = s.path;
    for (let i = 1; i < s.segments.length; i++) {
      const ancestor = s.segments.slice(0, i).join(DELIM);
      if (survivingPaths.has(ancestor)) {
        root = ancestor;
        break;
      }
    }
    rootOf.set(s.path, root);
    const family = byRoot.get(root);
    if (family) family.push(s);
    else byRoot.set(root, [s]);
  }
  return { rootOf, byRoot };
}

/**
 * Emit survivors in last-touch order, with one exception: in an overlapping
 * family the ROOT is emitted LAST — its whole-subtree set is what makes the
 * replayed subtree exactly the family value (a descendant applied afterwards
 * could only re-state a value already inside it, but would also leave behind
 * the `key: undefined` shells 'full' mode never has). `before(touch)` runs
 * ahead of each survivor with that survivor's last touch — where the
 * re-encoded families of the admitted record take their places.
 */
export function emitInFamilyOrder(
  survivors: Survivor[],
  rootOf: Map<string, string>,
  byRoot: Map<string, Survivor[]>,
  emit: (s: Survivor) => void,
  before: (touch: number) => void,
): void {
  for (const s of survivors) {
    before(s.last);
    const root = rootOf.get(s.path) as string;
    const family = byRoot.get(root) as Survivor[];
    if (family.length === 1) {
      emit(s);
      continue;
    }
    if (s.path !== root) emit(s);
    if (family[family.length - 1] === s) emit(family.find((m) => m.path === root) as Survivor);
  }
}

/**
 * Append-detection predicate (#13c-B §2.2): both values are arrays, the
 * final is strictly longer, and the base is a structural prefix of the
 * final. Element compares short-circuit on reference identity (`deepEqual`'s
 * `===` fast path) before walking structure, and bail at the first mismatch
 * — worst case one structural compare of the base array, strictly cheaper
 * than the full-value `structuredClone` the fallback pays.
 *
 * `before === undefined` (first write) fails `Array.isArray` → `set`, which
 * keeps the first write as the causal anchor for "who initialized this key".
 *
 * BOTH arrays must also be plain and dense ({@link isIndexOnly}): replay
 * reconstructs an append as `[...current, ...tail]`, and that spread carries
 * ONLY indexed elements — a named property parked on an array (a nested write
 * like `set(['history','note'], …)`, which `nativeSet` happily hangs off the
 * array object) or a hole would be silently dropped, where `'full'` mode
 * stores the value whole and keeps it.
 */
function isStrictArrayPrefix(before: unknown, after: unknown): before is unknown[] {
  if (!Array.isArray(before) || !Array.isArray(after)) return false;
  if (after.length <= before.length) return false;
  for (let i = 0; i < before.length; i++) {
    if (!deepEqual(before[i], after[i])) return false;
  }
  return isIndexOnly(before) && isIndexOnly(after);
}

/** True when an array's own enumerable keys are exactly its indices — no
 *  extra named properties and no holes, i.e. the array survives a spread
 *  intact. One `Object.keys` pass, same order as the prefix compare above
 *  and paid only after it succeeds. */
function isIndexOnly(arr: unknown[]): boolean {
  return Object.keys(arr).length === arr.length;
}
