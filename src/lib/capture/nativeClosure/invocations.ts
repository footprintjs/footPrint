import { buildAttemptId } from 'foottrace';

import type { AttemptContext } from '../../attempt/types.js';
import type { SelectedNativeFailure, TerminalFailureContext } from '../../errors/terminalFailure.js';
import { NATIVE_EXTENT_MAX_INVOCATIONS } from '../nativeExtent/format.js';

/** Bounded actual-entry count only; identities and live owners are never retained. */
export class NativeClosureInvocations {
  private entered = 0;

  get count(): number {
    return this.entered;
  }

  reset(): void {
    this.entered = 0;
  }

  begin(
    identity: NonNullable<TerminalFailureContext['stage']>,
    attempt: AttemptContext | undefined,
  ): Extract<SelectedNativeFailure, { kind: 'invocation' }> | 'counter-saturated' {
    if (this.entered >= NATIVE_EXTENT_MAX_INVOCATIONS) return 'counter-saturated';
    this.entered++;
    return Object.freeze({
      kind: 'invocation',
      runId: identity.runId,
      runtimeStageId: identity.runtimeStageId,
      attemptId: buildAttemptId(identity.runtimeStageId, attempt?.attempt ?? 1),
    });
  }
}
