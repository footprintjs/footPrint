import { SharedMemory } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import { ScopeFacade } from '../../scope/ScopeFacade.js';
import { RedactionRule } from '../redaction.js';
import { StageContext } from '../StageContext.js';
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
  it('a facade behind a Proxy keeps its methods and instance keys', () => {
    const frame = new StageContext('run', 'Stage', 'stage', new SharedMemory());
    frame.runtimeStageId = 'stage#1';
    frame.bindFailureIdentity('run', 'stage#1');
    frame.useRedactionRule(new RedactionRule({ keys: ['unrelated'] }));
    prepareErrorSources(frame, {}, () => 0)();
    const facade = new ScopeFacade(frame, 'Stage');
    const keys = Reflect.ownKeys(facade);
    const proxy = new Proxy(facade, {});
    expect(proxy.serveRetryLoopError(Object.assign(new Error('public'), { code: 'PUBLIC_CODE' }))).toEqual({
      message: 'public',
      name: 'Error',
      code: 'PUBLIC_CODE',
    });
    expect(Reflect.ownKeys(proxy)).toEqual(keys);
    expect(keys).not.toContain('_errorSources');
  });
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

  it.each(['message', 'name'])('an object in structured %s is an unavailable value under a policy', (field) => {
    const rule = new RedactionRule({ keys: ['secret'] });
    const error = new Error('public');
    Object.defineProperty(error, field, { get: () => ({ secret: 'SYNTHETIC-STRUCTURED-SECRET' }), enumerable: true });
    error.toString = () => 'public text';
    expect(rule.servedError(error, () => ({ selectedReads: 0 }))).toEqual({ message: '[REDACTED]', raw: undefined });
  });

  it('an old partial mask cannot override a stronger current source decision', () => {
    const rule = new RedactionRule({ keys: ['secret'] });
    const error = Object.assign(new Error('public'), { secret: 'selected', code: 'PUBLIC_CODE' });
    expect(rule.servedError(error, () => ({ selectedReads: 0 })).message).toBe('public');
    expect(rule.servedError(error, () => ({ selectedReads: 1 }))).toEqual({ message: '[REDACTED]', raw: undefined });
  });

  it('a failure during structured extraction is unavailable under an active policy', () => {
    let prototypes = 0;
    const error = new Proxy(new Error('public'), {
      getPrototypeOf(target) {
        if (++prototypes === 3) throw new Error('trap');
        return Reflect.getPrototypeOf(target);
      },
      get(target, key, receiver) {
        return key === 'toString' ? () => 'public' : Reflect.get(target, key, receiver);
      },
    });
    const rule = new RedactionRule({ keys: ['secret'] });
    expect(rule.servedError(error, () => ({ selectedReads: 0 }))).toEqual({ message: '[REDACTED]', raw: undefined });
  });
});
