/**
 * Lets a working copy of the program, in a folder far from any install,
 * import `footprintjs` and `foottrace`: a bare `footprintjs…` or
 * `foottrace…` import resolves as if written beside this file, so Node finds
 * the `node_modules` of the runtime folder this file is copied into
 * (harness/runtime.mjs). Every other import resolves as usual.
 *
 * Why `registerHooks` (in-thread): `module.register` runs its hooks on a
 * worker thread, and the children that load this file run under Node's
 * permission model with workers denied (harness/child.mjs).
 * Loaded with `node --import <this file>`.
 * Example: `import { decide } from 'footprintjs'` in `/tmp/agent-debug-run-1/src/…`
 * → `<runtime>/node_modules/footprintjs/dist/esm/index.js`.
 */
import { registerHooks } from 'node:module';

const HERE = import.meta.url;
const OWN = /^(footprintjs|foottrace)(\/|$)/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (OWN.test(specifier)) return nextResolve(specifier, { ...context, parentURL: HERE });
    return nextResolve(specifier, context);
  },
});
