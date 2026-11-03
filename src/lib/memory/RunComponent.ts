/** Weak graph keys hold opaque tokens only: no token points back to a graph. */
const canonicalRoots = new WeakMap<object, object>();
const declaredRoots = new WeakSet<object>();

export function canonicalRunComponentRoot(root: object): object {
  let token = canonicalRoots.get(root);
  if (!token) {
    token = Object.freeze({});
    canonicalRoots.set(root, token);
  }
  return token;
}

/** Every clone is associated, including clones made before any declaration. */
export function copyRunComponentRoot(source: object, clone: object): void {
  canonicalRoots.set(clone, canonicalRunComponentRoot(source));
}

/** Called only by lifecycle component-slot issuance; not a public registration door. */
export function declareRunComponentRoot(root: object): object {
  const canonical = canonicalRunComponentRoot(root);
  declaredRoots.add(canonical);
  return canonical;
}

/** Capture once at actual entry, before callbacks. Later declarations cannot retarget it. */
export function declaredRunComponentRoot(root: object | undefined): object | undefined {
  if (!root) return undefined;
  const canonical = canonicalRunComponentRoot(root);
  return declaredRoots.has(canonical) ? canonical : undefined;
}
