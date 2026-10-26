import type { CommitBundle } from 'foottrace';
import { nativeHas, normaliseStateKey } from 'foottrace/paths';
import type { ReadSourceSnapshot } from 'foottrace/write';
import { decodeReadSourceSnapshot } from 'foottrace/write';

import type { EngineReadSources, NativeReadCaptureNote, SourceLimitation } from './readSources.js';
import { readSourceStatus, SOURCE_LIMITATIONS } from './readSources.js';

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
  initialState?: Record<string, unknown>,
): boolean {
  const paths = new Map<number, Set<string>>();
  for (const row of record.occurrences) {
    const path = [...row.stateAddress, row.key];
    if (row.source.kind === 'base' && (!initialState || !nativeHas(initialState, path))) return false;
    if (row.source.kind !== 'committed') continue;
    const index = row.source.commitIdx;
    const bundle = commits[index];
    if (!bundle) return false;
    let written = paths.get(index);
    if (!written) {
      written = new Set(bundle.trace.map((entry) => entry.path));
      paths.set(index, written);
    }
    if (!written.has(normaliseStateKey(path))) return false;
  }
  return true;
}

/** After inert JSON admission: the record's codec owns descriptors; the engine binds its root observation. */
export function storedReadSources(
  value: unknown,
  capture: NativeReadCaptureNote,
  commitLog: readonly CommitBundle[],
  initialState?: Record<string, unknown>,
): EngineReadSources | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as EngineReadSources;
  if (
    source.version !== 1 ||
    source.runId !== capture.runId ||
    source.persistence !== 'memory-only' ||
    !sameData(source.commits, capture.commits) ||
    !Array.isArray(source.limitations) ||
    source.limitations.length > SOURCE_LIMITATIONS.length ||
    new Set(source.limitations).size !== source.limitations.length ||
    !source.limitations.every((gap) => SOURCE_LIMITATIONS.includes(gap as SourceLimitation)) ||
    Object.keys(source).some(
      (key) => !['version', 'runId', 'persistence', 'commits', 'status', 'limitations', 'record'].includes(key),
    )
  )
    return undefined;
  const record = source.record === undefined ? undefined : decodeReadSourceSnapshot(source.record);
  if (source.record !== undefined && (!record || !sameData(source.record, record))) return undefined;
  if (record && (!sameData(record.address, capture.logAddress) || !referencesMatch(record, commitLog, initialState)))
    return undefined;
  if (
    source.status !== readSourceStatus(record, source.limitations.length) ||
    capture.channels.readSources !== source.status
  )
    return undefined;
  return Object.freeze({
    version: 1,
    runId: source.runId,
    persistence: 'memory-only',
    commits: capture.commits,
    status: source.status,
    limitations: Object.freeze([...source.limitations]),
    ...(record && { record }),
  });
}
