import type { CommitBundle } from 'foottrace';
import { commitValueAtWithBasis } from 'foottrace';
import { nativeGet, nativeHas, normaliseStateKey } from 'foottrace/paths';
import type { ReadSourceSnapshot } from 'foottrace/write';
import { decodeReadSourceSnapshot } from 'foottrace/write';

import type { EngineReadSources, NativeReadCaptureNote, SourceLimitation } from './readSources.js';
import { readSourceStatus, SOURCE_LIMITATIONS } from './readSources.js';
import { SourceReferenceBudget } from './sourceReferenceBudget.js';
import { storedReadSourceCounts } from './storedReadSourceCounts.js';
import { storedSourceOwnership } from './storedSourceOwnership.js';

function scalar(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number';
}

/** Refuse unrecognized stored fields rather than silently dropping them through a projecting codec. */
function sameData(input: unknown, decoded: unknown): boolean {
  if (Object.is(input, decoded)) return true;
  if (!input || !decoded || typeof input !== 'object' || typeof decoded !== 'object') return false;
  const keys = Object.keys(input);
  return (
    keys.length === Object.keys(decoded).length &&
    keys.every(
      (key) =>
        Object.hasOwn(decoded, key) &&
        sameData(
          Object.getOwnPropertyDescriptor(input, key)?.value,
          Object.getOwnPropertyDescriptor(decoded, key)?.value,
        ),
    )
  );
}

/** Bounded row references, not causal reconstruction or validation of application computation. */
function referencesMatch(
  record: ReadSourceSnapshot,
  commits: readonly CommitBundle[],
  firstCommits: ReadonlyMap<string, number>,
  initialState?: Record<string, unknown>,
): boolean {
  const paths = new Map<number, Set<string>>();
  const scalarSources = new Map<number, Map<string, boolean>>();
  const budget = new SourceReferenceBudget(commits, initialState);
  for (const row of record.occurrences) {
    const path = [...row.stateAddress, row.key];
    if (
      row.source.kind === 'base' &&
      (!initialState || !nativeHas(initialState, path) || !scalar(nativeGet(initialState, path)))
    )
      return false;
    if (row.source.kind !== 'committed') continue;
    const index = row.source.commitIdx;
    const bundle = commits[index];
    const readerCommit = firstCommits.get(row.runtimeStageId);
    // A later continuation must not loosen the boundary for earlier reads. Reused raw contexts stay unknown.
    if (!bundle || readerCommit === undefined || index >= readerCommit) return false;
    let written = paths.get(index);
    if (!written) {
      written = new Set(bundle.trace.map((entry) => entry.path));
      paths.set(index, written);
    }
    const key = normaliseStateKey(path);
    if (!written.has(key)) return false;
    let values = scalarSources.get(index);
    if (!values) scalarSources.set(index, (values = new Map()));
    let confirmed = values.get(key);
    if (confirmed === undefined) {
      budget.spend();
      // The public record reader owns set/merge/delta value semantics; no second replay/value rule here.
      const result = commitValueAtWithBasis(commits as CommitBundle[], index, key, { initialState });
      confirmed = scalar(result.value) && !result.basis.includes('redacted');
      values.set(key, confirmed);
    }
    if (!confirmed) return false;
  }
  return true;
}

/** After inert JSON admission: the record's codec owns descriptors; the engine binds its root observation. */
export function storedReadSources(
  value: unknown,
  capture: NativeReadCaptureNote,
  commitLog: readonly CommitBundle[],
  initialState?: Record<string, unknown>,
  executionTree?: unknown,
): EngineReadSources | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as EngineReadSources;
  if (
    (source.version !== 1 && source.version !== 2) ||
    source.runId !== capture.runId ||
    source.persistence !== 'memory-only' ||
    !sameData(source.commits, capture.commits) ||
    !Array.isArray(source.limitations) ||
    source.limitations.length > SOURCE_LIMITATIONS.length ||
    new Set(source.limitations).size !== source.limitations.length ||
    !source.limitations.every((gap) => SOURCE_LIMITATIONS.includes(gap as SourceLimitation)) ||
    Object.keys(source).some(
      (key) =>
        ![
          'version',
          'runId',
          'persistence',
          'commits',
          'status',
          'limitations',
          'record',
          ...(source.version === 2 ? ['ownership'] : []),
        ].includes(key),
    )
  )
    return undefined;
  const record = source.record === undefined ? undefined : decodeReadSourceSnapshot(source.record);
  if (source.record !== undefined && (!record || !sameData(source.record, record))) return undefined;
  const firstCommits = new Map<string, number>();
  commitLog.forEach((bundle, index) => {
    if (!firstCommits.has(bundle.runtimeStageId)) firstCommits.set(bundle.runtimeStageId, index);
  });
  const counts = record && storedReadSourceCounts(record, executionTree, firstCommits);
  if (
    record &&
    (!sameData(record.address, capture.logAddress) ||
      !counts ||
      !referencesMatch(record, commitLog, firstCommits, initialState))
  )
    return undefined;
  const ownership =
    source.version === 2 && record && counts
      ? storedSourceOwnership(source.ownership, record, source.runId, capture.commits, firstCommits, counts)
      : undefined;
  if (source.version === 2 && !ownership) return undefined;
  if (
    source.status !== readSourceStatus(record, source.limitations.length) ||
    capture.channels.readSources !== source.status
  )
    return undefined;
  return Object.freeze({
    ...(ownership ? { version: 2 as const, ownership } : { version: 1 as const }),
    runId: source.runId,
    persistence: 'memory-only',
    commits: capture.commits,
    status: source.status,
    limitations: Object.freeze([...source.limitations]),
    ...(record && { record }),
  });
}
