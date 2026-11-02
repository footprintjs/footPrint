import { type NativeLegOrigin, type RunBanks, RunFrame } from '../memory/RunFrame.js';

interface NativeRunBinding {
  readonly legBanks: RunBanks;
  readonly runtimeBanks: RunBanks;
  readonly onOrigin: (frame: RunFrame) => void;
}

const bindings = new WeakMap<object, NativeRunBinding>();
const frames = new WeakMap<object, RunFrame>();
const readyFrames = new WeakMap<object, RunFrame>();

/** Internal one-execution link to the sole native adapter, not an adapter registry. */
export function attachNativeRun(executor: object, binding: NativeRunBinding): () => void {
  if (bindings.has(executor)) throw new TypeError('Native executor already has an execution binding');
  bindings.set(executor, binding);
  return () => {
    if (bindings.get(executor) === binding) bindings.delete(executor);
  };
}

/** Called only at the native generated-origin boundary, before traversal callbacks. */
export function beginNativeRun(executor: object, origin: NativeLegOrigin): RunFrame {
  const binding = bindings.get(executor);
  const frame = RunFrame.open(origin, binding?.legBanks, binding?.runtimeBanks);
  frames.set(executor, frame);
  readyFrames.delete(executor);
  binding?.onOrigin(frame);
  return frame;
}

/** Explicit executor relation for captured-view checks, never a process-current run. */
export function nativeRunFrame(executor: object): RunFrame | undefined {
  return frames.get(executor);
}

/** The traverser and sink now belong to this leg; reads before this cannot use an old heap. */
export function readyNativeRun(executor: object): void {
  const frame = frames.get(executor);
  if (frame) readyFrames.set(executor, frame);
}

export function nativeRunReady(executor: object, frame: RunFrame): boolean {
  return readyFrames.get(executor) === frame;
}
