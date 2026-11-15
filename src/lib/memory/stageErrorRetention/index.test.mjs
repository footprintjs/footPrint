import { describe, expect, it } from 'vitest';
import { prepareErrorSources, readErrorSources, retainError } from './index.js';

describe('execution source validity', () => {
  it('setup is unknown, invocation is live, a later attempt resets pending, and old activation cannot win', () => {
    const frame = { runtimeStageId: 'stage#1' };
    let reads = 0;
    const activate = prepareErrorSources(frame, { visible: 1 }, () => reads);
    expect(readErrorSources(frame)).toBeUndefined();
    activate();
    expect(readErrorSources(frame)).toEqual({ input: { visible: 1 }, selectedReads: 0 });
    reads = 2;
    expect(readErrorSources(frame).selectedReads).toBe(2);
    const next = prepareErrorSources(frame, {}, () => reads);
    activate();
    expect(readErrorSources(frame)).toBeUndefined();
    next();
    expect(readErrorSources(frame).selectedReads).toBe(2);
    frame.runtimeStageId = 'stage#2';
    expect(readErrorSources(frame)).toBeUndefined();
  });

  it('a failed source sample is unknown and another frame is independent', () => {
    const frame = { runtimeStageId: 'stage#1' };
    prepareErrorSources(frame, {}, () => {
      throw new Error('unavailable');
    })();
    expect(readErrorSources(frame)).toBeUndefined();
    expect(readErrorSources({ runtimeStageId: 'stage#1' })).toBeUndefined();
  });
});

describe('late safe error projection', () => {
  it('samples after structured getters and suppresses all derived fields', () => {
    let selected = false;
    let remembered;
    const error = new Error('safe');
    Object.defineProperty(error, 'code', {
      get: () => {
        selected = true;
        return 'private-code';
      },
    });
    const result = retainError(error, 'safe', 'safe', {
      selectedError: () => false,
      selectedSources: () => selected,
      remember: (value) => {
        remembered = value;
      },
      placeholder: '[REDACTED]',
    });
    expect(result).toEqual({ message: '[REDACTED]', structuredError: { message: '[REDACTED]', raw: undefined } });
    expect(remembered).toBe(result.structuredError);
    expect(error.message).toBe('safe');
  });
});
