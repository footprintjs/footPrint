/**
 * The mapped input, detached from the parent's state ONCE per mount (D1,
 * 9.29.0 — docs/design/2026-10-copy-on-write-commit.md).
 *
 * The inputMapper reads the parent's LIVE state (`mapperScope.ts`), so a value it
 * passes through (`(p) => ({ cfg: p.cfg })`) is the parent's committed
 * object — and the subflow's args are deep-FROZEN in place
 * (`readonlyInput · createFrozenArgs`). The typed scope does not proxy a
 * frozen value (`allowlist · shouldWrapWithProxy`), so a later
 * `scope.cfg.x = 1` in the parent met the raw frozen object: a TypeError in
 * strict code. Before 9.29.0 the parent's next whole-state clone replaced the
 * frozen object (a mount that committed nothing left it in place — the bug
 * existed, it was only short-lived); under copy-on-write nothing re-clones,
 * so the freeze would last until the key is rewritten. A mount must never
 * edit — or freeze — the parent's committed objects: every plain object,
 * array, `Date`, `Map` and `Set` the mapper returns is cloned here, before it
 * becomes the args. A class instance passes by reference, as before (it
 * cannot come from committed state, and a clone would drop its prototype).
 * The seed is cloned again at its commit, so the subflow's state is
 * unchanged.
 *
 * A GETTER among the result's own keys is taken as its value here too. It reads when it is asked,
 * and the mapper's view of the parent is closed right after this call (`mapperScope.ts`): left as a
 * getter, it would be asked later (the narrative, the seed, the frozen copy of the args) and refused.
 * Found by the second reader of the change that closes the view: `(p) => ({ get late() { return p.a } })`
 * made the run throw. EVERY own getter is taken, also one that is not enumerable or sits under a symbol:
 * the copy of the args made for the subflow asks for those keys too.
 */
export function detachMappedInput(input: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> | undefined = withGettersRead(input);
  for (const [key, value] of Object.entries(out ?? input)) {
    if (!isDetachable(value)) continue;
    (out ??= { ...input })[key] = structuredClone(value);
  }
  return out ?? input;
}

/**
 * A copy of `record` in which each own getter is a plain value (read once, now), every other own key
 * as it was; `undefined` when it has no getter, which is nearly always. (A mapper's result: a few keys.)
 */
function withGettersRead(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const hasGetter = Reflect.ownKeys(record).some((key) => Object.getOwnPropertyDescriptor(record, key)?.get);
  if (!hasGetter) return undefined;
  // Built from descriptors, not edited in place: a getter defined with `defineProperty` cannot be redefined.
  const descriptors = Object.getOwnPropertyDescriptors(record) as Record<string | symbol, PropertyDescriptor>;
  for (const key of Reflect.ownKeys(descriptors)) {
    const own = descriptors[key];
    if (own.get === undefined) continue;
    const value = Reflect.get(record, key, record);
    descriptors[key] = { value, writable: true, enumerable: own.enumerable, configurable: true };
  }
  return Object.create(Object.getPrototypeOf(record), descriptors) as Record<string, unknown>;
}

/** A value `structuredClone` reproduces with its own type: plain object, array, `Date`, `Map`, `Set`. */
function isDetachable(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value) || value instanceof Date || value instanceof Map || value instanceof Set) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
