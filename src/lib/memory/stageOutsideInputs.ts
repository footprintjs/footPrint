import type { OutsideInputs } from 'foottrace';

import type { StageContext } from './StageContext.js';

interface StageOutsideInputs {
  declared?: readonly string[];
  calls?: { started: number; retained: number; targets: Set<string> };
}

/** Execution-local evidence. A frame with neither declared inputs nor calls owns no entry. */
const entries = new WeakMap<StageContext, StageOutsideInputs>();

function inputsFor(frame: StageContext): StageOutsideInputs {
  let inputs = entries.get(frame);
  if (!inputs) {
    inputs = {};
    entries.set(frame, inputs);
  }
  return inputs;
}

export function setDeclaredOutsideInputs(frame: StageContext, declared: readonly string[] | undefined): void {
  if (declared) inputsFor(frame).declared = declared;
  else {
    const inputs = entries.get(frame);
    if (inputs) inputs.declared = undefined;
  }
}

/** Called before each native attempt invokes host work. A stage retry does not erase the earlier starts. */
export function noteNativeCallStarted(frame: StageContext): void {
  const inputs = inputsFor(frame);
  const calls = (inputs.calls ??= { started: 0, retained: 0, targets: new Set() });
  calls.started += 1;
}

/** Only a native callback's own row in the existing attempt budget can supply a target. */
export function recordNativeCallTarget(frame: StageContext, target: string): void {
  const calls = entries.get(frame)?.calls;
  if (!calls) return;
  calls.retained += 1;
  calls.targets.add(target);
}

export function outsideInputStamp(frame: StageContext): OutsideInputs | undefined {
  const inputs = entries.get(frame);
  if (!inputs) return undefined;
  const { declared, calls } = inputs;
  if (!declared?.length && !calls) return undefined;
  return {
    ...(declared?.length && { declared }),
    ...(calls && {
      call: {
        targets: [...calls.targets],
        ...(calls.retained < calls.started && { incomplete: true }),
      },
    }),
  };
}

export function clearOutsideInputs(frame: StageContext): void {
  entries.delete(frame);
}
