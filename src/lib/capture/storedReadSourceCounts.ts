import type { ReadSourceSnapshot } from 'foottrace/write';

import type { SourceReadCounts } from './sourceReadCounts.js';
import { EMPTY_SOURCE_READ_COUNTS } from './sourceReadCounts.js';

const KINDS = Object.keys(EMPTY_SOURCE_READ_COUNTS.kinds) as (keyof SourceReadCounts['kinds'])[];
export type StoredSourceCounts = SourceReadCounts & { readonly invocations?: number };

function countsOf(value: unknown): SourceReadCounts | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const counts = value as SourceReadCounts;
  if (
    Object.keys(value).length !== 3 ||
    !Number.isSafeInteger(counts.observed) ||
    !Number.isSafeInteger(counts.retained) ||
    counts.observed < 0 ||
    counts.retained < 0 ||
    counts.retained > counts.observed
  )
    return undefined;
  if (!counts.kinds || typeof counts.kinds !== 'object' || Array.isArray(counts.kinds)) return undefined;
  if (Object.keys(counts.kinds).length !== KINDS.length) return undefined;
  let sum = 0;
  for (const kind of KINDS) {
    const count = counts.kinds[kind];
    if (!Number.isSafeInteger(count) || count < 0) return undefined;
    sum += count;
    if (sum > counts.retained) return undefined;
  }
  if (sum !== counts.retained) return undefined;
  return counts;
}

/** Already inert, byte-bounded evidence. Check native counts; never reconstruct read occurrences. */
export function storedReadSourceCounts(
  record: ReadSourceSnapshot,
  executionTree: unknown,
  committedOwners: ReadonlyMap<string, number>,
): ReadonlyMap<string, StoredSourceCounts> | undefined {
  const owners = new Map<string, StoredSourceCounts>();
  const pending = [executionTree];
  let visited = 0;
  while (pending.length) {
    if (++visited > 100_000) return undefined;
    const value = pending.pop();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const node = value as Record<string, unknown>;
    const id = node.runtimeStageId;
    if (Object.hasOwn(node, 'readSourceCounts')) {
      const counts = countsOf(node.readSourceCounts);
      if (!counts || (record.status === 'captured' && counts.observed !== counts.retained)) return undefined;
      if (typeof id !== 'string' || !id) {
        if (counts.observed || counts.retained) return undefined;
      } else {
        if (owners.has(id)) return undefined;
        const invocations = node.readSourceInvocations;
        if (
          Object.hasOwn(node, 'readSourceInvocations') &&
          (!Number.isSafeInteger(invocations) || (invocations as number) < 0)
        )
          return undefined;
        owners.set(id, { ...counts, ...(invocations !== undefined && { invocations: invocations as number }) });
      }
    } else if (typeof id === 'string' && committedOwners.has(id)) return undefined;
    if (Object.hasOwn(node, 'next')) pending.push(node.next);
    if (Object.hasOwn(node, 'children')) {
      if (!Array.isArray(node.children) || node.children.length > 100_000 - visited - pending.length) return undefined;
      for (const child of node.children) pending.push(child);
    }
  }
  const remaining = new Map([...owners].map(([id, counts]) => [id, { ...counts.kinds }]));
  for (const row of record.occurrences) {
    const counts = remaining.get(row.runtimeStageId);
    if (!counts || counts[row.source.kind] === 0) return undefined;
    counts[row.source.kind]--;
  }
  return [...remaining.values()].every((counts) => KINDS.every((kind) => counts[kind] === 0)) ? owners : undefined;
}
