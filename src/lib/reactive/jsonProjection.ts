/**
 * reactive/jsonProjection -- the serialization view behind a nested proxy's toJSON.
 *
 * ## The law this exists to keep
 *
 *   JSON.stringify(scope.key) === JSON.stringify(scope.$getValue('key'))
 *
 * A stage reads `scope.results` and gets a Proxy. That Proxy must serialize to
 * exactly what the underlying state serializes to -- nested objects, arrays,
 * Dates and all. Two read paths for one value that disagree on the bytes is a
 * bug the consumer only finds in production.
 *
 * ## Why a projection is needed at all
 *
 * The nested get trap mints a NEW proxy object on every property access, so
 * `raw.a` and `raw.a` are two different objects to JSON.stringify. That defeats
 * its identity-based cycle detection: a circular value recurses forever instead
 * of throwing. So `toJSON` must hand JSON.stringify plain, un-proxied values.
 *
 * ## Cycle handling: prune the back-edge, not the data
 *
 * Only a reference back to an ANCESTOR on the current chain is pruned (object
 * key omitted, array slot -> null). A diamond -- the same object reachable by
 * two sibling paths -- is NOT a cycle and serializes twice, exactly as
 * JSON.stringify does for plain state. Circular scope values still never throw
 * through the property path; that is a pre-existing contract, and it is the one
 * place this view deliberately diverges from `$getValue` (which throws, as
 * standard JSON.stringify does).
 *
 * ## Borrowed, not cloned
 *
 * When nothing is pruned -- the case for every acyclic value, which is all
 * state that must survive structuredClone -- the ORIGINAL reference is
 * returned. No allocation, no copy, and `scope.x.toJSON() === rawX` holds.
 * A copy is built only along the path to a pruned cycle, and only then.
 */

/**
 * Containers this projection recurses into: plain objects and arrays.
 *
 * Everything else (Date, Map, class instances) passes through BY REFERENCE so
 * JSON.stringify applies its own rules -- Date.toJSON gives the ISO string,
 * a Map gives `{}` -- identical to serializing the raw state value.
 *
 * Deliberately NOT `shouldWrapWithProxy`: that one rejects frozen objects
 * (which must not get write traps). A frozen plain object still needs walking
 * here, because a frozen object can sit on a cycle.
 */
function isPlainContainer(value: object): boolean {
  if (Array.isArray(value)) return true;
  const ctor = (value as Record<string, unknown>).constructor;
  return ctor === undefined || ctor === Object;
}

/** Returns `undefined` for a pruned cycle back-edge, else the value or its pruned copy. */
function project(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value !== 'object') return value;

  const container = value as object;
  if (!isPlainContainer(container)) return value;
  if (ancestors.has(container)) return undefined; // back-edge to an ancestor -- prune

  // One shared set with add/delete around the recursion (not a per-branch copy):
  // ancestor-chain membership is exactly what cycle detection needs, and this
  // costs O(1) per node instead of O(depth) allocations.
  ancestors.add(container);
  try {
    return Array.isArray(container)
      ? projectArray(container, ancestors)
      : projectObject(container as Record<string, unknown>, ancestors);
  } finally {
    ancestors.delete(container);
  }
}

function projectArray(src: unknown[], ancestors: Set<object>): unknown[] {
  let copy: unknown[] | null = null;
  for (let i = 0; i < src.length; i++) {
    const original = src[i];
    const projected = project(original, ancestors);
    if (projected === original) {
      if (copy) copy.push(original);
      continue;
    }
    if (!copy) copy = src.slice(0, i);
    // A pruned element keeps its slot -- JSON.stringify writes `null` for
    // undefined in arrays, so indices still line up with the raw array.
    copy.push(projected);
  }
  return copy ?? src;
}

function projectObject(src: Record<string, unknown>, ancestors: Set<object>): Record<string, unknown> {
  const keys = Object.keys(src);
  let copy: Record<string, unknown> | null = null;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const original = src[key];
    const projected = project(original, ancestors);
    if (projected === original) {
      if (copy) copy[key] = original;
      continue;
    }
    if (!copy) {
      copy = {};
      for (let j = 0; j < i; j++) copy[keys[j]] = src[keys[j]];
    }
    // Pruned -> key omitted, matching how JSON.stringify drops undefined props.
    if (projected !== undefined) copy[key] = projected;
  }
  return copy ?? src;
}

/**
 * The value a proxied object hands to JSON.stringify.
 *
 * @param raw - The proxy's underlying state object (already redacted by the facade)
 * @returns `raw` itself when acyclic; a cycle-pruned copy otherwise
 */
export function toJSONView(raw: object): unknown {
  return project(raw, new Set<object>());
}
