import type { StageSources } from '../redaction.js';

interface Frame {
  readonly runtimeStageId: string;
}
interface Binding {
  readonly stamp: string;
  readonly input: unknown;
  readonly selectedReads: () => number;
  invoking: boolean;
}

const bindings = new WeakMap<object, Binding>();

/** Setup is unknown even with a current stamp: a factory may read state without tracking it. */
export function prepareErrorSources(frame: Frame, input: unknown, selectedReads: () => number): () => void {
  const binding: Binding = { stamp: frame.runtimeStageId, input, selectedReads, invoking: false };
  bindings.set(frame, binding);
  return () => {
    if (bindings.get(frame) === binding && frame.runtimeStageId === binding.stamp) binding.invoking = true;
  };
}

/** Only the actual invocation's live sources can authorize a clear stage-origin error. */
export function readErrorSources(frame: Frame): StageSources | undefined {
  const binding = bindings.get(frame);
  if (!binding?.invoking || binding.stamp !== frame.runtimeStageId) return undefined;
  try {
    return { input: binding.input, selectedReads: binding.selectedReads() };
  } catch {
    return undefined;
  }
}
