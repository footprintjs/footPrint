/** Identity metadata only. Semantic ValueFact bytes remain unchanged. */
export type IdentityGraph = readonly Readonly<{ path: readonly string[]; object: number }>[];
export function identityGraph(value: unknown, objectId: (value: object) => number): IdentityGraph {
  const rows: { path: readonly string[]; object: number }[] = [];
  let visits = 0;
  const walk = (at: unknown, path: readonly string[], ancestors: ReadonlySet<object>) => {
    if (++visits > 10_000 || path.length > 128) throw new Error('Identity observation bound exceeded.');
    if (at === null || typeof at !== 'object') return;
    rows.push(Object.freeze({ path: Object.freeze([...path]), object: objectId(at) }));
    if (ancestors.has(at)) return; // Retain the actual cycle/alias edge, never unfold it indefinitely.
    const next = new Set(ancestors);
    next.add(at);
    for (const key of Reflect.ownKeys(at)) {
      if (typeof key !== 'string') throw new Error('Unsupported identity property.');
      const descriptor = Object.getOwnPropertyDescriptor(at, key)!;
      if (!Object.hasOwn(descriptor, 'value')) throw new Error('Accessor identity is unproven.');
      walk(descriptor.value, [...path, key], next);
    }
  };
  walk(value, [], new Set());
  return Object.freeze(rows);
}
