import { describe, expect, it } from 'vitest';

import { NativeFailureState } from '../terminalFailure.js';
import { failureReceipt, invalidateFailureReceipt, publishFailureReceipt } from './index.js';

const stage = { runId: 'run', runtimeStageId: 'stage#1' };
const projection = { message: 'Error: public', structuredError: { message: 'public', raw: undefined } };
describe('the actual native pending token owns retention', () => {
  it.each([new Error('public'), 'public'])(
    'adoption transfers the exact receipt and completion releases it: %s',
    (error) => {
      const child = new NativeFailureState(),
        parent = new NativeFailureState();
      expect(failureReceipt(child, error)).toBeUndefined();
      child.capture(error, 'unknown', stage);
      publishFailureReceipt(child, error, stage, projection, 'clear');
      const receipt = failureReceipt(child, error);
      expect(receipt?.kind).toBe('clear');
      parent.adopt(child, error);
      expect(failureReceipt(child, error)).toBeUndefined();
      expect(failureReceipt(parent, error)).toBe(receipt);
      parent.finish(error);
      expect(failureReceipt(parent, error)).toBeUndefined();
    },
  );
  it('rejects identity copies, fresh captures, unowned failures and stale invocations', () => {
    const state = new NativeFailureState();
    state.capture('same', 'unknown', stage);
    publishFailureReceipt(state, 'same', { ...stage, runtimeStageId: 'other#2' }, projection, 'clear');
    expect(failureReceipt(state, 'same')).toBeUndefined();
    publishFailureReceipt(state, 'same', stage, projection, 'clear');
    invalidateFailureReceipt(state);
    publishFailureReceipt(state, 'same', stage, projection, 'clear');
    expect(failureReceipt(state, 'same')).toEqual({ kind: 'unknown' });
    state.capture('same', 'unknown', stage);
    expect(failureReceipt(state, 'same')).toBeUndefined();
    state.complete();
    expect(failureReceipt(state, 'same')).toBeUndefined();
    expect(failureReceipt({}, 'same')).toBeUndefined();
  });
});
