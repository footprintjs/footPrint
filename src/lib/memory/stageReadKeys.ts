import type { StageSnapshot } from './frameTypes.js';

/**
 * Return the distinct tracked read names on a stage, in lexical order.
 * Works on live snapshots and reopened records. Old records can only report
 * the names they retained. Read tracking set to off reports an empty list.
 */
export function readKeysOf(stage: Pick<StageSnapshot, 'stageReads' | 'unvaluedReadKeys'>): string[] {
  const reads = stage.stageReads;
  const names = new Set(reads && typeof reads === 'object' && !Array.isArray(reads) ? Object.keys(reads) : []);
  const unvalued = stage.unvaluedReadKeys;
  if (Array.isArray(unvalued)) {
    for (const key of unvalued) if (typeof key === 'string') names.add(key);
  }
  return [...names].sort();
}
