/** A runtime dependency or required peer owns the record; optional/dev-only declarations do not. */
export function hasRecordOwner(pkg) {
  return !!(
    pkg.dependencies?.foottrace ||
    (pkg.peerDependencies?.foottrace && pkg.peerDependenciesMeta?.foottrace?.optional !== true)
  );
}
