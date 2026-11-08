import type { LogAddress } from 'foottrace';

import type { NativeCaptureNote } from '../nativeCoverage.js';
import { copyIdentity, ownData } from '../noteShape.js';

export const BASE_LIMITATIONS = Object.freeze([
  'closure-not-attested',
  'channels-not-fenced',
  'external-work-not-attested',
] as const);
/** This vocabulary describes bookkeeping gaps, never permission to admit a complete capture. */
const EXTENT_LIMITATIONS = Object.freeze([
  ...BASE_LIMITATIONS,
  'pending-native-invocations',
  'abandoned-native-invocations',
  'counter-saturated',
  'child-work-not-tracked',
  'fanout-work-not-attested',
  'detached-work-not-tracked',
  'custom-scope',
  'resumed-segment',
] as const);
export type NativeCaptureExtentLimitation = (typeof EXTENT_LIMITATIONS)[number];
export const RUNNING_STATUS = 'running';
export const TERMINAL_STATUS = 'unverified';
const EXTENT_STATUSES = Object.freeze([RUNNING_STATUS, TERMINAL_STATUS] as const);
/** @internal Fixed counter/active-token ceiling; overflow is disclosed rather than silently wrapping. */
export const NATIVE_EXTENT_MAX_INVOCATIONS = 1_000_000;

/**
 * Value-free native function bookkeeping for one root-log leg. An unverified terminal observation is immutable;
 * neither zero pending invocations nor storage acknowledgement establishes closed capture or remote cancellation.
 * Version 1 has no closed state; a future closure attestation requires a separately reviewed version.
 */
export interface NativeCaptureExtent {
  readonly version: 1;
  /** One extent per native leg; deliberately the same identifier as runId. */
  readonly extentId: string;
  readonly runId: string;
  readonly scope: 'root-log';
  readonly logAddress: LogAddress;
  /** Half-open root-log segment observed at this cut. */
  readonly commits: { readonly from: number; readonly to: number };
  readonly status: (typeof EXTENT_STATUSES)[number];
  readonly invocations: {
    readonly started: number;
    /** Synchronous return/throw, or Promise settlement observed by an existing native continuation. */
    readonly settled: number;
    /** No settlement observed at the sampled cut; not an inspection of a Promise's internal state. */
    readonly pending: number;
    /** Native waits aborted before settlement was observed; may overlap settled. */
    readonly abandoned: number;
  };
  readonly persistence: 'memory-only';
  readonly limitations: readonly NativeCaptureExtentLimitation[];
}

function exact(value: unknown, keys: readonly string[]): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'))
  );
}

function copyExtentIdentity(
  value: unknown,
  binding: Pick<NativeCaptureNote, 'runId' | 'logAddress' | 'commits'>,
): Pick<NativeCaptureNote, 'runId' | 'logAddress' | 'commits'> | undefined {
  const identity = copyIdentity(value, true);
  if (
    !identity ||
    ownData(value, 'extentId') !== identity.runId ||
    ownData(value, 'scope') !== 'root-log' ||
    ownData(value, 'persistence') !== 'memory-only' ||
    identity.runId !== binding.runId ||
    identity.logAddress.logRunId !== binding.logAddress.logRunId ||
    binding.logAddress.drillPath.length !== 0 ||
    identity.commits.from !== binding.commits.from ||
    identity.commits.to !== binding.commits.to ||
    !exact(ownData(value, 'logAddress'), ['logRunId', 'drillPath']) ||
    !exact(ownData(value, 'commits'), ['from', 'to'])
  )
    return;
  const drill = ownData(ownData(value, 'logAddress'), 'drillPath');
  if (
    !Array.isArray(drill) ||
    Reflect.ownKeys(drill).length !== 1 ||
    Object.is(identity.commits.from, -0) ||
    Object.is(identity.commits.to, -0)
  )
    return;
  return identity;
}

function copyInvocationCounts(value: unknown): NativeCaptureExtent['invocations'] | undefined {
  if (!exact(value, ['started', 'settled', 'pending', 'abandoned'])) return;
  const started = ownData(value, 'started');
  const settled = ownData(value, 'settled');
  const pending = ownData(value, 'pending');
  const abandoned = ownData(value, 'abandoned');
  const count = (n: unknown): n is number =>
    Number.isSafeInteger(n) &&
    !Object.is(n, -0) &&
    (n as number) >= 0 &&
    (n as number) <= NATIVE_EXTENT_MAX_INVOCATIONS;
  if (
    !count(started) ||
    !count(settled) ||
    !count(pending) ||
    !count(abandoned) ||
    settled + pending !== started ||
    abandoned > started
  )
    return;
  return Object.freeze({ started, settled, pending, abandoned });
}

function copyExtentLimitations(
  value: unknown,
  counts: NativeCaptureExtent['invocations'],
): readonly NativeCaptureExtentLimitation[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return;
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (
    !Number.isSafeInteger(length) ||
    length > EXTENT_LIMITATIONS.length ||
    Reflect.ownKeys(value).length !== length + 1
  )
    return;
  const limitations: NativeCaptureExtentLimitation[] = [];
  for (let i = 0; i < length; i++) {
    const entry = Object.getOwnPropertyDescriptor(value, String(i));
    if (
      !entry ||
      !Object.hasOwn(entry, 'value') ||
      !EXTENT_LIMITATIONS.includes(entry.value) ||
      limitations.includes(entry.value)
    )
      return;
    limitations.push(entry.value);
  }
  if (
    !BASE_LIMITATIONS.every((gap) => limitations.includes(gap)) ||
    limitations.includes('pending-native-invocations') !== counts.pending > 0 ||
    limitations.includes('abandoned-native-invocations') !== counts.abandoned > 0 ||
    (limitations.includes('counter-saturated') && counts.started !== NATIVE_EXTENT_MAX_INVOCATIONS)
  )
    return;
  return Object.freeze(limitations);
}

/**
 * The one producer-owned admission boundary, after the history copier's bounded inert-data projection. Refuses
 * unknown versions, accessors, extras and inconsistent counts. It is not a sandbox for executable live Proxies;
 * matching inert data is not producer authentication or closure proof.
 */
export function copyNativeCaptureExtent(
  value: unknown,
  binding: Pick<NativeCaptureNote, 'runId' | 'logAddress' | 'commits'>,
  terminalOnly = false,
): NativeCaptureExtent | undefined {
  try {
    if (
      !exact(value, [
        'version',
        'extentId',
        'runId',
        'scope',
        'logAddress',
        'commits',
        'status',
        'invocations',
        'persistence',
        'limitations',
      ])
    )
      return;
    const identity = copyExtentIdentity(value, binding);
    const status = ownData(value, 'status');
    if (!identity || (status !== TERMINAL_STATUS && (status !== RUNNING_STATUS || terminalOnly))) return;
    const invocations = copyInvocationCounts(ownData(value, 'invocations'));
    if (!invocations) return;
    const limitations = copyExtentLimitations(ownData(value, 'limitations'), invocations);
    if (!limitations) return;
    return Object.freeze({
      version: 1,
      extentId: identity.runId,
      ...identity,
      scope: 'root-log',
      status,
      invocations,
      persistence: 'memory-only',
      limitations,
    });
  } catch {
    return undefined;
  }
}
