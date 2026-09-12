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

/*
 * Until 9.24.0 this module also owned `unwrapProxy`, a JSON round-trip of
 * every ASSIGNED value — the only way then to keep the scope's own Proxies
 * out of the buffer. It cost a `Date` its type and a `Map` its members, and
 * it made the trap and `$setValue` store different bytes for the same value
 * (the old landmine 1). The scope's handles are recognised now
 * (`handles.ts · unwrapHandles`, O(1) each), so the assigned value goes to
 * the sink AS ASSIGNED and the buffer's `structuredClone` at commit is the
 * one detaching step — the same law `$setValue` has always had.
 */

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
