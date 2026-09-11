/**
 * reactive/structuralWrite -- Build the NEXT value without touching the last one.
 *
 * Every deep write the typed scope intercepts has the same shape: "at this
 * path inside the value I read, put this". The value it read is BORROWED —
 * before a stage's first staged write it is a bare reference into committed
 * shared memory, and committed state is immutable-after-swap (see
 * `StageContext.firstTouchState`). Editing it in place would corrupt every
 * in-flight stage AND leave the commit log with nothing to record.
 *
 * So the write path never mutates. It COPIES the containers along the path
 * (and only those) and returns a new root, leaving every untouched sibling
 * shared by reference — the same zero-clone bargain the first-touch view
 * already makes. The buffer `structuredClone`s what it stages, so the
 * detaching happens once, at the boundary that needs it.
 */

/**
 * Strip Proxy wrappers from a value about to be stored.
 *
 * `structuredClone` in TransactionBuffer cannot clone a Proxy, and every deep
 * read of state hands back one — so `scope.backup = scope.customer` would
 * otherwise stage an unclonable value.
 *
 * KNOWN COST (landmine 1): this is a JSON round-trip, so a `Date` becomes a
 * string, a `Map` becomes `{}` and an own `undefined` drops. `$setValue`
 * bypasses it, which is why the two write paths can store different bytes.
 * The round-trip is applied to the ASSIGNED VALUE only — never to the
 * surrounding state, which reaches the buffer by reference and is detached by
 * `structuredClone` (Dates and Maps intact).
 */
export function unwrapProxy(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  try {
    // JSON round-trip strips Proxies. Safe because state values must be JSON-serializable.
    return JSON.parse(JSON.stringify(value));
  } catch {
    // Non-serializable (functions, symbols, etc.) — return as-is
    return value;
  }
}

/** Shallow copy that preserves array-ness — the one container copy this module makes. */
function copyContainer(node: unknown): any {
  if (Array.isArray(node)) return [...node];
  if (node !== null && typeof node === 'object') return { ...(node as Record<string, unknown>) };
  // Not a container (primitive, null, undefined): the path continues INTO it,
  // so it becomes a fresh object — the same coercion `nativeSet` performs.
  return {};
}

/** An array index segment, or `undefined` when the segment names a property. */
function indexOf(node: unknown, segment: string): number | undefined {
  if (!Array.isArray(node)) return undefined;
  const i = Number(segment);
  return Number.isInteger(i) && i >= 0 ? i : undefined;
}

/**
 * Return a copy of `root` with `value` at `segments`, mutating nothing.
 *
 * Containers on the path are shallow-copied (arrays stay arrays); everything
 * off the path is shared by reference. An empty path returns `value` itself.
 */
export function setInPath(root: unknown, segments: readonly string[], value: unknown): unknown {
  if (segments.length === 0) return value;
  const next = copyContainer(root);
  const segment = segments[0];
  const index = indexOf(next, segment);
  const child = index !== undefined ? next[index] : (next as Record<string, unknown>)[segment];
  const replaced = setInPath(child, segments.slice(1), value);
  if (index !== undefined) next[index] = replaced;
  else (next as Record<string, unknown>)[segment] = replaced;
  return next;
}

/**
 * Return a copy of `root` with the key at `segments` REMOVED, mutating nothing.
 *
 * On an array the slot is removed with `splice` (the array shrinks — `delete`
 * on an array index would leave a hole, which cannot survive
 * `structuredClone` round-trips as the same value). A path that does not
 * exist returns the root unchanged, by reference.
 */
export function deleteInPath(root: unknown, segments: readonly string[]): unknown {
  if (segments.length === 0) return undefined;
  if (root === null || typeof root !== 'object') return root;
  const segment = segments[0];
  const index = indexOf(root, segment);
  if (segments.length === 1) {
    if (index !== undefined) {
      if (index >= (root as unknown[]).length) return root;
      const copy = [...(root as unknown[])];
      copy.splice(index, 1);
      return copy;
    }
    if (!Object.prototype.hasOwnProperty.call(root, segment)) return root;
    const copy = { ...(root as Record<string, unknown>) };
    delete copy[segment];
    return copy;
  }
  const child = index !== undefined ? (root as unknown[])[index] : (root as Record<string, unknown>)[segment];
  const replaced = deleteInPath(child, segments.slice(1));
  if (replaced === child) return root;
  const copy = copyContainer(root);
  if (index !== undefined) copy[index] = replaced;
  else copy[segment] = replaced;
  return copy;
}
