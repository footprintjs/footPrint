/**
 * -----------------------------------------------------------------------------
 *  PatchedMemoryContext
 * -----------------------------------------------------------------------------
 *  ▸ Collects *two* kinds of patches during a stage execution:
 *      1. overwritePatch – values written through setObject()/set()
 *      2. updatePatch    – values written through merge()/updateObject()
 *  ▸ Additionally records – in constant‑time – the canonical "path strings"
 *    touched by each API so downstream callers know *exactly* which branches
 *    of the tree changed.  Those strings are stored in Set<string> so multiple
 *    writes to the same path are deduplicated automatically.
 *  ▸ commit() now returns an object containing BOTH patches and BOTH path lists
 *    for maximum visibility as well as future time‑travel support.
 *
 *  Path→string normalisation:
 *  --------------------------------
 *      [ 'pipelines',   flowId,  'config', 'tags' ]
 *    → 'pipelines\u001F' + flowId + '\u001Fconfig\u001Ftags'
 *
 *  We use the ASCII Unit‑Separator (U+001F) as delimiter because it cannot
 *  appear unescaped in a JS identifier and renders invisibly in logs.
 * -----------------------------------------------------------------------------
 */

import _cloneDeep from 'lodash.clonedeep';
import _get from 'lodash.get';
import _set from 'lodash.set';

export interface MemoryPatch {
  [key: string]: any;
}

export const DELIM = '\u001F'; // delimiter for path serialisation

/** helper –> turn an array path into a stable string key */
const norm = (path: (string | number)[]): string => path.map(String).join(DELIM);

export class PatchedMemoryContext {
  private readonly baseSnapshot: any;
  private workingCopy: any;

  // ----------------------------------- patch buckets
  private overwritePatch: MemoryPatch = {};
  private updatePatch: MemoryPatch = {};

  // ----------------------------------- touched‑path sets
  /** chronological write log  — used to replay in the same order */
  private opTrace: { path: string; verb: 'set' | 'merge' }[] = [];

  private redactedPaths = new Set<string>();

  constructor(base: any) {
    this.baseSnapshot = _cloneDeep(base);
    this.workingCopy = _cloneDeep(base);
  }

  /* ----- setters ----------------------------------------------------------- */
  /**
   * set() – hard overwrite (shallow‑merge for object vs object kept by caller).
   * Records the canonical path in overwritePaths so commit() can replay it.
   */
  set(path: (string | number)[], value: any, shouldRedact = false): void {
    _set(this.workingCopy, path, value);
    _set(this.overwritePatch, path, _cloneDeep(value));
    if (shouldRedact) {
      this.redactedPaths.add(norm(path));
    }
    this.opTrace.push({ path: norm(path), verb: 'set' });
  }

  /**
   * merge() – deep union merge.  Path recorded in updatePaths.
   */
  merge(path: (string | number)[], value: any, shouldRedact = false): void {
    const existing = _get(this.workingCopy, path) ?? {};
    const merged = deepSmartMerge(existing, value);
    _set(this.workingCopy, path, merged);
    _set(this.updatePatch, path, deepSmartMerge(_get(this.updatePatch, path) ?? {}, value));
    if (shouldRedact) {
      this.redactedPaths.add(norm(path));
    }
    this.opTrace.push({ path: norm(path), verb: 'merge' });
  }

  /* -------- getters ------------------------------------------------------- */
  get(path: (string | number)[], defaultValue?: any) {
    return _get(this.workingCopy, path, defaultValue);
  }

  /* --------- commit() ------------------------------------------------------ */
  commit(): {
    overwrite: MemoryPatch;
    updates: MemoryPatch;
    redactedPaths: Set<string>;
    trace: { path: string; verb: 'set' | 'merge' }[];
  } {
    const payload = {
      overwrite: _cloneDeep(this.overwritePatch),
      updates: _cloneDeep(this.updatePatch),
      redactedPaths: new Set(this.redactedPaths),
      trace: [...this.opTrace],
    };

    // reset for next stage
    this.overwritePatch = {};
    this.updatePatch = {};
    this.opTrace.length = 0;
    this.redactedPaths.clear();
    this.workingCopy = _cloneDeep(this.baseSnapshot); // defensive reset

    return payload;
  }
}

/* --------------------------------------------------------------------------
 * deepSmartMerge – union‑merge helper used by merge().
 * Arrays   → union without duplicates (encounter order preserved)
 * Objects  → recurse
 * Primitives / explicit undefined  → source wins
 * -------------------------------------------------------------------------- */
function deepSmartMerge(dst: any, src: any): any {
  if (src === null || typeof src !== 'object') return src;

  // array vs array -> union
  if (Array.isArray(src) && Array.isArray(dst)) {
    return [...new Set([...dst, ...src])];
  }

  // array vs Object -> src wins (replace)
  if (Array.isArray(src)) {
    return [...src];
  }

  // Object-merge
  const out: any = { ...(dst && typeof dst === 'object' ? dst : {}) };
  for (const k of Object.keys(src)) {
    out[k] = deepSmartMerge(out[k], src[k]);
  }
  return out;
}

/* =====================================================================================
 *  applySmartMerge – final patch application utility
 * =====================================================================================
 *  UPDATE phase   – union‑merge via deepSmartMerge
 *  OVERWRITE phase – iterate owPaths and _set() final values; this guarantees
 *                    "last writer wins" and preserves explicit undefined.
 * ------------------------------------------------------------------------------------- */
export function applySmartMerge(
  base: any,
  updates: MemoryPatch,
  overwrite: MemoryPatch,
  trace: { path: string; verb: 'set' | 'merge' }[],
): any {
  const out = _cloneDeep(base);
  for (const { path, verb } of trace) {
    const segs = path.split(DELIM);
    if (verb === 'set') {
      const val = _get(overwrite, segs);
      _set(out, segs, _cloneDeep(val));
    } else {
      // merge
      const current = _get(out, segs) ?? {};
      const merged = deepSmartMerge(current, _get(updates, segs));
      _set(out, segs, merged);
    }
  }
  return out;
}
