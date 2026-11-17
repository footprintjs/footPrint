/** Optional native backend; imported only by the explicit public capture door. */
import { fanoutView, resetFanoutView } from '../../capture/fanoutCollections.js';
import { noteRootRead } from '../../capture/nativeRootReads.js';
import type { SubflowCapturePort } from '../../capture/subflowCapability.js';
import { privateCollections, privateInput } from '../../capture/subflowHandoff.js';
import type { StageContext } from '../../memory/StageContext.js';
import type { IExecutionRuntime, SubflowMountOptions } from '../types.js';
import { FanoutCapture } from './handoff/fanout.js';
import { generatedInput } from './handoff/generated.js';
import { InputCapture } from './handoff/input.js';

export function createSubflowCaptureBackend(selected: { input: boolean; fanout: boolean }): SubflowCapturePort {
  const modes = Object.freeze({ ...selected });
  return Object.freeze({
    ...modes,
    beginInput: (runtime: object, context: object, options: object | undefined) =>
      InputCapture.begin(
        runtime as IExecutionRuntime,
        context as StageContext,
        options as SubflowMountOptions | undefined,
        modes,
      ),
    beginFanout: (runtime: object, context: object) =>
      new FanoutCapture(runtime as IExecutionRuntime, context as StageContext),
    settled: (options, address, cutoff, failed, explicit) =>
      generatedInput(options)?.settled(address, cutoff, failed, explicit),
    view: fanoutView,
    reset: resetFanoutView,
    noteRootRead,
    privateInput,
    privateCollections,
  } satisfies SubflowCapturePort);
}
