/**
 * Lets a working copy of the program, in a folder far from any install,
 * import `footprintjs` and `foottrace`: the hook resolves them from the
 * `node_modules` nearest to this file (the runtime folder's copy, see
 * harness/runtime.mjs).
 *
 * Why: a working copy must hold the program and nothing else, so it has no
 * `node_modules` of its own. Loaded with `node --import <this file>`.
 */
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);
