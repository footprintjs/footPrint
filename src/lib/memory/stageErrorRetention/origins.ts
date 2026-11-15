import type { StructuredErrorInfo } from '../../errors/errorInfo.js';
import type { StageSources } from '../redaction.js';
import { MaskedErrors } from './maskedErrors.js';
import { readErrorSources } from './sources.js';

interface Frame {
  readonly runtimeStageId: string;
  readonly failureIdentity?: object;
}
const memos = new WeakMap<object, MaskedErrors>();
const owners = new WeakMap<() => StageSources | undefined, MaskedErrors>();
const facades = new WeakMap<object, () => StageSources | undefined>();
const nativeMasks = new WeakMap<
  object,
  WeakMap<object, { readonly info: StructuredErrorInfo; readonly strength: number }>
>();

/** Generic privacy snapshot only: never a native origin attestation or scalar history. */
export function rememberNativeMask(rule: object, error: object, info: StructuredErrorInfo, strength: number): void {
  let known = nativeMasks.get(rule);
  if (!known) {
    known = new WeakMap();
    nativeMasks.set(rule, known);
  }
  if (!known.has(error) || known.get(error)!.strength < strength)
    known.set(error, { info: Object.freeze({ ...info }), strength });
}
export function knownNativeMask(rule: object, error: unknown): boolean {
  return (
    error !== null &&
    (typeof error === 'object' || typeof error === 'function') &&
    nativeMasks.get(rule)?.has(error) === true
  );
}
export function hasNativeMasks(rule: object): boolean {
  return nativeMasks.has(rule);
}
export function nativeMaskProjection(rule: object, value: unknown): StructuredErrorInfo | undefined {
  const known =
    value !== null && (typeof value === 'object' || typeof value === 'function')
      ? nativeMasks.get(rule)?.get(value)
      : undefined;
  return known && { ...known.info };
}

/** Capture the actual execution; an old facade never follows a reused frame. */
export function ownedErrorSources(
  frame: Frame,
  read?: (live: StageSources) => StageSources | undefined,
): () => StageSources | undefined {
  const identity = frame.failureIdentity;
  const stamp = frame.runtimeStageId;
  const reference = new WeakRef(frame);
  let memo = identity && memos.get(identity);
  if (!memo) {
    memo = new MaskedErrors();
    if (identity) memos.set(identity, memo);
  }
  const sample = () => {
    const current = reference.deref();
    const live =
      current?.failureIdentity === identity && current?.runtimeStageId === stamp
        ? readErrorSources(current)
        : undefined;
    return live === undefined ? undefined : read ? read(live) : live;
  };
  owners.set(sample, memo);
  return sample;
}

/** Reuse the facade's unique frozen-args carrier without adding an instance key or Proxy brand. */
export function bindFacadeSources(carrier: object, frame: Frame, input: unknown): void {
  facades.set(
    carrier,
    ownedErrorSources(frame, (live) => ({ input, selectedReads: live.selectedReads })),
  );
}
export function boundSources(carrier: object): () => StageSources | undefined {
  return facades.get(carrier) ?? unknownErrorSources();
}

export function errorOriginMemo(sample: (() => StageSources | undefined) | undefined): MaskedErrors | undefined {
  return sample && owners.get(sample);
}

/** A consumer has no stage origin; this callback attests unknown, never clear. */
export function unknownErrorSources(): () => undefined {
  const sample = () => undefined;
  owners.set(sample, new MaskedErrors());
  return sample;
}

/** Unavailable stage sources are a full mask only when a state selector is active. */
export function selectedErrorSources(
  sample: (() => StageSources | undefined) | undefined,
  inert: boolean,
  selected: (sources: StageSources) => boolean,
): boolean | 'unknown' {
  if (!sample || inert) return false;
  try {
    const live = sample();
    return live === undefined ? 'unknown' : selected(live);
  } catch {
    return 'unknown';
  }
}
