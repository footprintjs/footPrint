/**
 * postbuild-esm — mark the ESM build as TRUE ESM.
 *
 * tsc emits dist/esm/*.js with ESM syntax + explicit `.js` import extensions,
 * but Node only treats them as ESM when a `package.json` with
 * `"type":"module"` sits alongside. Without it, Node loads them via
 * syntax-detection fallback (MODULE_TYPELESS_PACKAGE_JSON warning + per-file
 * reparse) and stricter loaders can fail. This writes that 2-line manifest.
 *
 * Safe because every relative import in src already carries a `.js` extension
 * (true-ESM-resolvable) and the only `require()` (worker-thread detach driver)
 * is guarded by `typeof require === 'function'`, so it degrades gracefully in
 * ESM instead of crashing.
 */
import { writeFileSync } from 'node:fs';

writeFileSync(
  new URL('../dist/esm/package.json', import.meta.url),
  JSON.stringify({ type: 'module' }, null, 0) + '\n',
);
console.log('postbuild-esm: wrote dist/esm/package.json {type:module} ✓');
