import type { Meta } from 'foottrace';

import type { SelectedNativeFailure } from '../../errors/terminalFailure.js';
import type { ExecutionRuntime, RuntimeSnapshot } from '../ExecutionRuntime.js';
import { type NativeClosedCaptureResult, closeNativeCapture } from './record.js';

/** Short-lived lazy ports: called synchronously and never retained by the cut state. */
export interface NativeCutPort {
  snapshot(): RuntimeSnapshot;
  initialState(value: Record<string, unknown>): Record<string, unknown>;
  selected(): SelectedNativeFailure | undefined;
  serve(value: Meta): Meta;
  maxBytes(): number;
}

/** Assemble only once through NativeClosureState; preserve the original getter order and catch boundary. */
export function cutNativeCapture(
  runtime: Pick<ExecutionRuntime, 'captureExtent'>,
  port: NativeCutPort,
): NativeClosedCaptureResult {
  const refusal = runtime.captureExtent?.closureRefusal;
  if (refusal) return Object.freeze({ status: 'unknown', reason: refusal });
  else {
    try {
      // The cut never serves live sharedState or subflow results; avoid preparing their public copies.
      const view = port.snapshot();
      return closeNativeCapture(
        { ...view, ...(view.initialState && { initialState: port.initialState(view.initialState) }) },
        port.selected(),
        port.serve,
        port.maxBytes(),
      );
    } catch {
      // A user recorder's snapshot must not replace the exact original native error or outcome.
      return Object.freeze({ status: 'unknown', reason: 'evidence-refused' });
    }
  }
}
