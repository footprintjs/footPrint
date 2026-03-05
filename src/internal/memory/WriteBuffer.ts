/**
 * WriteBuffer - Transactional write buffer for stage mutations
 * 
 * WHY: Stages need atomic commit semantics - all mutations succeed or none do.
 * This buffer collects writes during execution and commits them atomically.
 * 
 * DESIGN: Similar to a database transaction buffer or compiler IR:
 * - Changes are staged here before being committed to GlobalStore
 * - Enables read-after-write consistency within a stage
 * - Records operation trace for time-travel debugging
 * 
 * RESPONSIBILITIES:
 * - Collect overwrite patches (set operations)
 * - Collect update patches (merge operations)
 * - Track operation order for deterministic replay
 * - Provide atomic commit with all patches and trace
 * 
 * RELATED:
 * - {@link GlobalStore} - Receives committed patches
 * - {@link StageContext} - Uses WriteBuffer for stage-scoped mutations
 * 
 * @example
 * ```typescript
 * const buffer = new WriteBuffer(baseState);
 * buffer.set(['user', 'name'], 'Alice');
 * buffer.merge(['user', 'tags'], ['admin']);
 * const { overwrite, updates, trace } = buffer.commit();
 * ```
 */

import _get from 'lodash.get';
import _set from 'lodash.set';

export interface MemoryPatch {
  [key: string]: any;
}

/**
 * Delimiter for path serialization.
 * WHY: ASCII Unit-Separator (U+001F) cannot appear in JS identifiers
 * and renders invisibly in logs, making it ideal for path joining.
 */
export const DELIM = '\u001F';

/**
 * Normalizes an array path into a stable string key.
 * WHY: Enables efficient path comparison and deduplication in Sets.
 */
const norm = (path: (string | number)[]): string => path.map(String).join(DELIM);

export class WriteBuffer {
  private readonly baseSnapshot: any;
  private workingCopy: any;

  // Patch buckets - separate tracking for overwrites vs merges
  private overwritePatch: MemoryPatch = {};
  private updatePatch: MemoryPatch = {};

  // Operation trace - chronological log for deterministic replay
  private opTrace: { path: string; verb: 'set' | 'merge' }[] = [];

  // Redacted paths - for sensitive data that shouldn't appear in logs
  private redactedPaths = new Set<string>();

  constructor(base: any) {
    // DESIGN: Deep clone to ensure isolation from external mutations
    this.baseSnapshot = structuredClone(base);
    this.workingCopy = structuredClone(base);
  }

  /**
   * Hard overwrite at the specified path.
   * WHY: Some operations need to completely replace a value, not merge.
   * 
   * @param path - Array path to the target location
   * @param value - Value to set (will be deep cloned)
   * @param shouldRedact - If true, path won't appear in debug logs
   */
  set(path: (string | number)[], value: any, shouldRedact = false): void {
    _set(this.workingCopy, path, value);
    _set(this.overwritePatch, path, structuredClone(value));
    if (shouldRedact) {
      this.redactedPaths.add(norm(path));
    }
    this.opTrace.push({ path: norm(path), verb: 'set' });
  }

  /**
   * Deep union merge at the specified path.
   * WHY: Enables additive updates without losing existing data.
   * Arrays are unioned, objects are recursively merged.
   * 
   * @param path - Array path to the target location
   * @param value - Value to merge (will be deep merged with existing)
   * @param shouldRedact - If true, path won't appear in debug logs
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

  /**
   * Read current value at path (includes uncommitted changes).
   * WHY: Enables read-after-write consistency within a stage.
   */
  get(path: (string | number)[], defaultValue?: any) {
    return _get(this.workingCopy, path, defaultValue);
  }

  /**
   * Flush all staged mutations and return the commit bundle.
   * WHY: Atomic commit ensures all-or-nothing semantics.
   * 
   * @returns Commit bundle with patches, redacted paths, and operation trace
   */
  commit(): {
    overwrite: MemoryPatch;
    updates: MemoryPatch;
    redactedPaths: Set<string>;
    trace: { path: string; verb: 'set' | 'merge' }[];
  } {
    const payload = {
      overwrite: structuredClone(this.overwritePatch),
      updates: structuredClone(this.updatePatch),
      redactedPaths: new Set(this.redactedPaths),
      trace: [...this.opTrace],
    };

    // Reset buffer to empty state after commit.
    // FIX: Previously reset workingCopy to baseSnapshot, causing stale reads
    // (buffer returned old baseSnapshot values instead of falling through to
    // GlobalStore). Empty buffer ensures post-commit reads go to GlobalStore.
    this.overwritePatch = {};
    this.updatePatch = {};
    this.opTrace.length = 0;
    this.redactedPaths.clear();
    this.workingCopy = {};

    return payload;
  }
}

/**
 * Deep union merge helper.
 * WHY: Standard Object.assign doesn't handle nested objects or arrays correctly.
 * 
 * DESIGN DECISIONS:
 * - Arrays: Union without duplicates (encounter order preserved)
 * - Objects: Recursive merge
 * - Primitives: Source wins
 */
function deepSmartMerge(dst: any, src: any): any {
  if (src === null || typeof src !== 'object') return src;

  // Array vs array -> union (preserves encounter order)
  if (Array.isArray(src) && Array.isArray(dst)) {
    return [...new Set([...dst, ...src])];
  }

  // Array vs Object -> source wins (replace)
  if (Array.isArray(src)) {
    return [...src];
  }

  // Object merge - recurse into nested properties
  const out: any = { ...(dst && typeof dst === 'object' ? dst : {}) };
  for (const k of Object.keys(src)) {
    out[k] = deepSmartMerge(out[k], src[k]);
  }
  return out;
}

/**
 * Applies a commit bundle to a base state by replaying operations in order.
 * WHY: Deterministic replay ensures consistent state reconstruction.
 * 
 * DESIGN: Two-phase application:
 * 1. UPDATE phase: Union-merge via deepSmartMerge
 * 2. OVERWRITE phase: Direct set for final values
 * 
 * This guarantees "last writer wins" semantics.
 */
export function applySmartMerge(
  base: any,
  updates: MemoryPatch,
  overwrite: MemoryPatch,
  trace: { path: string; verb: 'set' | 'merge' }[],
): any {
  const out = structuredClone(base);
  for (const { path, verb } of trace) {
    const segs = path.split(DELIM);
    if (verb === 'set') {
      const val = _get(overwrite, segs);
      _set(out, segs, structuredClone(val));
    } else {
      // merge
      const current = _get(out, segs) ?? {};
      const merged = deepSmartMerge(current, _get(updates, segs));
      _set(out, segs, merged);
    }
  }
  return out;
}

