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
