import type { LogAddress } from 'foottrace';
import { buildAttemptId, parseAttemptId } from 'foottrace';

import type { SelectedNativeFailure } from '../../errors/terminalFailure.js';
import { type NativeCaptureExtent, BASE_LIMITATIONS, copyNativeCaptureExtent } from '../nativeExtent/format.js';
import { captureIdentifier, copyIdentity, ownData } from '../noteShape.js';
import type { NativeCaptureObservation } from '../readSources.js';
import { isNativeSourceExecution } from '../sourceOwnershipFormat.js';

/** Fixed policy limits, retained even when the copied native prefix has no recording gaps. */
export const CAPTURE_CLOSURE_LIMITATIONS = Object.freeze([
  'unobserved-work-not-attested',
  'external-work-not-attested',
  'storage-not-attested',
  'producer-not-authenticated',
] as const);

/**
 * A descriptor for a separately copied immutable native prefix, not a closure claim about a live snapshot.
 * Outcome and closure are independent: a failed execution remains failed. This grants no semantic cause,
 * remote cancellation or authenticity authority; required channel coverage is assessed separately.
 */
export interface NativeCaptureClosure {
  readonly version: 1;
  readonly policy: 'native-root-prefix-v1';
  readonly scope: 'root-log';
  readonly runId: string;
  readonly logAddress: LogAddress;
  readonly commits: { readonly from: number; readonly to: number };
  readonly status: 'closed';
  readonly boundary: 'completed' | 'failed';
  /** Captured at the actual invocation; never inferred from the last error or a sole attempt. */
  readonly selectedFailure?: Extract<SelectedNativeFailure, { readonly kind: 'invocation' }>;
  readonly limitations: readonly (typeof CAPTURE_CLOSURE_LIMITATIONS)[number][];
}

function exact(value: unknown, fields: readonly string[]): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === fields.length &&
    fields.every((key) => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'))
  );
}

function copyLimitations(value: unknown): NativeCaptureClosure['limitations'] | undefined {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertyDescriptor(value, 'length')?.value !== CAPTURE_CLOSURE_LIMITATIONS.length ||
    Reflect.ownKeys(value).length !== CAPTURE_CLOSURE_LIMITATIONS.length + 1
  )
    return;
  const seen = new Set<unknown>();
  for (let index = 0; index < CAPTURE_CLOSURE_LIMITATIONS.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    if (!entry || !Object.hasOwn(entry, 'value') || !CAPTURE_CLOSURE_LIMITATIONS.includes(entry.value)) return;
    seen.add(entry.value);
  }
  return seen.size === CAPTURE_CLOSURE_LIMITATIONS.length ? CAPTURE_CLOSURE_LIMITATIONS : undefined;
}

function copyFailure(
  value: unknown,
  binding: NativeCaptureObservation,
  invocations: number,
): NativeCaptureClosure['selectedFailure'] {
  if (!exact(value, ['kind', 'runId', 'runtimeStageId', 'attemptId']) || ownData(value, 'kind') !== 'invocation')
    return;
  const runId = ownData(value, 'runId');
  const runtimeStageId = ownData(value, 'runtimeStageId');
  const attemptId = ownData(value, 'attemptId');
  const failure = ownData(ownData(binding, 'boundary'), 'failure');
  const stage = ownData(failure, 'stage');
  if (
    !captureIdentifier(runId) ||
    runId !== ownData(binding, 'runId') ||
    !captureIdentifier(runtimeStageId) ||
    runtimeStageId.length > 1024 ||
    !isNativeSourceExecution(runtimeStageId) ||
    !captureIdentifier(attemptId) ||
    !exact(stage, ['runId', 'runtimeStageId']) ||
    ownData(stage, 'runId') !== runId ||
    ownData(stage, 'runtimeStageId') !== runtimeStageId
  )
    return;
  const parsed = parseAttemptId(attemptId);
  if (
    !parsed ||
    parsed.call !== undefined ||
    parsed.runtimeStageId !== runtimeStageId ||
    !Number.isSafeInteger(parsed.attempt) ||
    parsed.attempt < 1 ||
    parsed.attempt > invocations ||
    buildAttemptId(runtimeStageId, parsed.attempt) !== attemptId
  )
    return;
  return Object.freeze({ kind: 'invocation', runId, runtimeStageId, attemptId });
}

/**
 * Copy only an exact inert descriptor bound to an already admitted note and native work book. The caller
 * separately supplies the fixed copied evidence and refuses unsupported work. These consistency checks are
 * not a signature or a sandbox for executable Proxies; a coherent stored rewrite remains unauthenticated.
 */
export function copyCaptureClosure(
  value: unknown,
  binding: NativeCaptureObservation,
  extent: NativeCaptureExtent,
): NativeCaptureClosure | undefined {
  try {
    const boundary = ownData(value, 'boundary');
    if (
      !exact(value, [
        'version',
        'policy',
        'scope',
        'runId',
        'logAddress',
        'commits',
        'status',
        'boundary',
        ...(boundary === 'failed' ? ['selectedFailure'] : []),
        'limitations',
      ]) ||
      ownData(value, 'policy') !== 'native-root-prefix-v1' ||
      ownData(value, 'scope') !== 'root-log' ||
      ownData(value, 'status') !== 'closed' ||
      (boundary !== 'completed' && boundary !== 'failed') ||
      ownData(binding, 'scope') !== 'root-log' ||
      ownData(binding, 'persistence') !== 'memory-only' ||
      (boundary === 'completed' && ownData(ownData(binding, 'boundary'), 'failure') !== undefined) ||
      ownData(ownData(binding, 'boundary'), 'status') !== boundary
    )
      return;
    const version = ownData(binding, 'version');
    if (version !== 1 && version !== 2) return;
    const identity = copyIdentity(value, true);
    const bound = copyIdentity(binding, false, version);
    if (
      !identity ||
      !bound ||
      !exact(ownData(value, 'logAddress'), ['logRunId', 'drillPath']) ||
      !exact(ownData(value, 'commits'), ['from', 'to']) ||
      Reflect.ownKeys(ownData(ownData(value, 'logAddress'), 'drillPath') as object).length !== 1 ||
      identity.commits.from !== 0 ||
      Object.is(identity.commits.from, -0) ||
      Object.is(identity.commits.to, -0) ||
      identity.runId !== identity.logAddress.logRunId ||
      identity.runId !== bound.runId ||
      identity.logAddress.logRunId !== bound.logAddress.logRunId ||
      identity.commits.from !== bound.commits.from ||
      identity.commits.to !== bound.commits.to
    )
      return;
    const book = copyNativeCaptureExtent(extent, bound, true);
    if (
      !book ||
      book.invocations.pending !== 0 ||
      book.invocations.abandoned !== 0 ||
      book.limitations.length !== BASE_LIMITATIONS.length ||
      !BASE_LIMITATIONS.every((gap) => book.limitations.includes(gap))
    )
      return;
    const limitations = copyLimitations(ownData(value, 'limitations'));
    if (!limitations) return;
    const selectedFailure =
      boundary === 'failed'
        ? copyFailure(ownData(value, 'selectedFailure'), binding, book.invocations.started)
        : undefined;
    if (boundary === 'failed' && !selectedFailure) return;
    return Object.freeze({
      version: 1,
      policy: 'native-root-prefix-v1',
      scope: 'root-log',
      ...identity,
      status: 'closed',
      boundary,
      ...(selectedFailure && { selectedFailure }),
      limitations,
    });
  } catch {
    return undefined;
  }
}
