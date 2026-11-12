/**
 * The resolve hook behind `register.mjs`: a bare `footprintjs…` or
 * `foottrace…` import resolves as if it were written beside this file.
 * Every other import resolves as usual.
 * Example: `import { decide } from 'footprintjs'` in `/tmp/run-1/src/...` →
 * `<bench>/node_modules/footprintjs/dist/esm/index.js`.
 */
// Resolve as if imported from this file: Node then walks up from here to the
// nearest `node_modules`, the package's own install or the runtime's copy.
const HERE = import.meta.url;
const OWN = /^(footprintjs|foottrace)(\/|$)/;

/** @type {import('node:module').ResolveHook} */
export async function resolve(specifier, context, nextResolve) {
  if (OWN.test(specifier)) return nextResolve(specifier, { ...context, parentURL: HERE });
  return nextResolve(specifier, context);
}
