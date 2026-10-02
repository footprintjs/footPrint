/**
 * equality.ts — structural equality of committed-state values. A leaf (L0,
 * imports nothing): what `TransactionBuffer`'s net-change filter, the admitted
 * record's compare and the borrowed-mutation guard all ask. Re-exported from
 * `utils.ts`, so no importer moved.
 */

/**
 * Structural deep equality for committed-state values.
 *
 * Used by {@link TransactionBuffer} to decide whether a stage actually CHANGED
 * a path or merely re-wrote / reverted it to the value it already held (a
 * "no-op write"), and by `borrowedMutation.firstDifferingPath` to find where a
 * borrowed read moved. Committed state must survive `structuredClone`, and
 * `structuredClone` keeps `Date`, `Map` and `Set` — so those are legal state
 * values (a `$setValue` bypasses the proxy's JSON round-trip) and this must
 * tell two of them apart. Before 9.22.0 it compared them as plain objects, and
 * a `Date`/`Map`/`Set` has no own enumerable keys: every pair was "equal", so
 * `$setValue('k', new Date(1999))` over a 2020 date was dropped as a no-op —
 * no trace row, state unchanged — and a `setFullYear` in place slipped past
 * the dev-mode guard.
 *
 * Semantics:
 *   - reference / identical-primitive short-circuits first (cheap fast path)
 *   - `NaN` equals `NaN` (primitive compare falls back to `Object.is`)
 *   - `Date`: same `getTime()` (two invalid dates are equal)
 *   - `Map`: same size AND, per key of `a`, `b` holds a deep-equal value —
 *     keys by `Map` identity (`SameValueZero`), values deep
 *   - `Set`: same size AND every member of `a` is deep-equal to SOME member
 *     of `b` (order-insensitive — a Set has no order to compare by)
 *   - a typed value against a plain value, or two different typed kinds → not
 *     equal (a `Date` is never `{}`)
 *   - arrays: equal length AND deep-equal element-wise (order-sensitive)
 *   - objects: identical set of keys that HOLD a value AND deep-equal per key.
 *     An own key whose value is `undefined` counts as ABSENT: it is this
 *     library's other spelling of a deleted key (`'full'` mode flattens
 *     `delete` into `key: undefined`; `'delta'` mode's `delete` verb removes
 *     the key), and every consumer — JSON, the fold, `commitValueAt`, the
 *     mirror — reads the two spellings as one state. So must the net-change
 *     filter (9.19.1): `{}` and `{ k: undefined }` are not a change. Arrays
 *     are untouched — a slot holding `undefined` is still a slot.
 *   - mismatched kinds (array vs object, object vs null) → not equal
 *
 * Cost & safety:
 *   - Allocates NOTHING but transient `Object.keys` arrays — no clones. It is
 *     strictly cheaper than the `structuredClone` the commit already performs.
 *   - Primitive comparisons (the bulk of state) are O(1) via the `===` /
 *     `Object.is` fast paths; only nested objects/arrays incur a walk, bounded
 *     by the value's own size.
 *   - Terminates on CYCLIC values (9.18.1): a state value must survive
 *     `structuredClone`, and `structuredClone` preserves cycles — so a
 *     self-referencing value is a legal value, not an out-of-contract one. A
 *     pair of objects already under comparison is treated as equal (the
 *     structural answer, lodash `isEqual` semantics); acyclic inputs see no
 *     change. Dev mode still warns about cycles at write time
 *     (`ScopeFacade.setValue`) because they surprise narrative and JSON.
 */
export function deepEqual(a: any, b: any): boolean {
  return equalPairs(a, b, undefined);
}

/**
 * Object pairs met so far, keyed `a → the b's it has been paired with`. Created
 * lazily by the first object pair, so primitive compares allocate nothing.
 * Never pruned: every `false` returns straight up to the caller (each recursive
 * call short-circuits on it), so nothing is looked up after a mismatch — a
 * stored pair is either still under comparison or already known equal.
 */
type SeenPairs = WeakMap<object, WeakSet<object>>;

function equalPairs(a: any, b: any, seen: SeenPairs | undefined): boolean {
  if (a === b) return true; // same reference or identical primitive
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b; // one is null, the other isn't
  if (typeof a !== 'object') return Object.is(a, b); // NaN-safe primitive compare

  // Typed arms first — a Date/Map/Set has no own enumerable keys, so the
  // plain-object walk below would call any two of them equal.
  const aKind = typedKind(a);
  if (aKind !== typedKind(b)) return false;
  if (aKind === 'date') return Object.is(a.getTime(), b.getTime());

  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false; // array vs plain object

  // Cycle guard — a pair we are already inside is equal by assumption.
  seen ??= new WeakMap();
  let partners = seen.get(a);
  if (partners?.has(b)) return true;
  if (!partners) seen.set(a, (partners = new WeakSet()));
  partners.add(b);

  if (aKind === 'map') return equalMaps(a, b, seen);
  if (aKind === 'set') return equalSets(a, b, seen);

  if (aIsArray) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!equalPairs(a[i], b[i], seen)) return false;
    }
    return true;
  }

  // Objects: only keys that HOLD a value take part — an own `undefined` is a
  // deleted key, the same state as an absent one (see the contract above).
  let aHeld = 0;
  for (const key of Object.keys(a)) {
    if (a[key] === undefined) continue;
    aHeld++;
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!equalPairs(a[key], b[key], seen)) return false;
  }
  let bHeld = 0;
  for (const key of Object.keys(b)) if (b[key] !== undefined) bHeld++;
  return aHeld === bHeld;
}

/** The typed state values `structuredClone` keeps and a key walk cannot see. */
function typedKind(value: object): 'date' | 'map' | 'set' | undefined {
  if (value instanceof Date) return 'date';
  if (value instanceof Map) return 'map';
  if (value instanceof Set) return 'set';
  return undefined;
}

function equalMaps(a: Map<unknown, unknown>, b: Map<unknown, unknown>, seen: SeenPairs): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (!b.has(key)) return false;
    if (!equalPairs(value, b.get(key), seen)) return false;
  }
  return true;
}

/**
 * Order-insensitive, deep per member. Quadratic in the worst case for sets of
 * objects — a set of primitives (the common shape) is one `has` per member.
 */
function equalSets(a: Set<unknown>, b: Set<unknown>, seen: SeenPairs): boolean {
  if (a.size !== b.size) return false;
  const unmatched = [...b];
  for (const member of a) {
    // SameValueZero first — primitives and shared references, one `has`.
    // Each match retires its slot so two structurally-equal members of `a`
    // cannot both claim the same member of `b`.
    const at = unmatched.indexOf(member);
    const found = at >= 0 ? at : unmatched.findIndex((candidate) => equalPairs(member, candidate, seen));
    if (found < 0) return false;
    unmatched.splice(found, 1);
  }
  return true;
}
