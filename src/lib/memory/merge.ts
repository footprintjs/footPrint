/**
 * merge.ts — the union merge the `merge` verb applies. A leaf (L0, imports
 * only the own-slot writer): `deepSmartMerge`, the law every replay, fold and reader
 * of a recorded `merge` row runs. Re-exported from `utils.ts`, so no importer
 * moved.
 */

import { putOwn } from '../capture/ownData.js';

/**
 * Deep union merge helper.
 * - Arrays (non-empty): union without duplicates (encounter order preserved)
 * - Arrays (empty):     replace — src `[]` clears the destination array.
 *   Rationale: writing `scope.tags = []` means "clear tags", not "append nothing".
 *   Without this rule, an empty-array write silently becomes a no-op which is
 *   impossible to distinguish from a bug.
 * - Objects: recursive merge of own enumerable string keys, including special keys;
 *   inherited destination values and setters never participate.
 * - Primitives: source wins
 *
 * Terminates on a CYCLIC `src` (9.18.1, same law as {@link deepEqual}: a
 * state value survives `structuredClone`, which preserves cycles). A `src`
 * object re-entered while it is still being merged higher up the stack hands
 * back the output being built for it, so the merged value mirrors the cycle
 * instead of unrolling it forever. Only the ancestors on the stack are
 * guarded — a shared (acyclic) `src` reference met again at a different
 * `dst` merges against THAT `dst`, exactly as before.
 */
export function deepSmartMerge(dst: any, src: any): any {
  return mergeGuarded(dst, src, undefined);
}

function mergeGuarded(dst: any, src: any, inFlight: WeakMap<object, any> | undefined): any {
  if (src === null || typeof src !== 'object') return src;

  if (Array.isArray(src)) {
    if (src.length === 0) return []; // empty src = clear, not no-op
    if (Array.isArray(dst)) return [...new Set([...dst, ...src])];
    return [...src];
  }

  if (inFlight?.has(src)) return inFlight.get(src); // cycle — re-enter the value being built

  const out: any = { ...(dst && typeof dst === 'object' ? dst : {}) };
  (inFlight ??= new WeakMap()).set(src, out);
  for (const k of Object.keys(src)) {
    const owns = Object.prototype.hasOwnProperty.call(out, k);
    const value = mergeGuarded(owns ? out[k] : undefined, src[k], inFlight);
    putOwn(out, k, value);
  }
  inFlight.delete(src);
  return out;
}
