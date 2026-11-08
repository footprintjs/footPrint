import { type NativeClosedCaptureResult, NO_CLOSED_CAPTURE } from './record.js';

/** One executor's once-only immutable cut; no frame, callback or live runtime is retained here. */
export class NativeClosureState {
  sealed = false;
  result: NativeClosedCaptureResult = NO_CLOSED_CAPTURE;

  reset(): void {
    this.result = NO_CLOSED_CAPTURE;
    this.sealed = false;
  }

  closeOnce(cut: () => NativeClosedCaptureResult): void {
    if (this.sealed) return;
    // The recorded failure re-enters finishCapture through the outer catch. Even a refused cut is final.
    this.sealed = true;
    this.result = cut();
  }
}
