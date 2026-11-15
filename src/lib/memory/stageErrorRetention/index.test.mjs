import { SharedMemory } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import { captureStageFailure, recordStageError } from '../../engine/handlers/stageError.js';
import { retainChildResult } from '../../engine/handlers/stageError.js';
import { failureReceipt } from '../../errors/failureRetention/index.js';
import { ScopeFacade } from '../../scope/ScopeFacade.js';
import { RedactionRule } from '../redaction.js';
import { StageContext } from '../StageContext.js';
import { prepareErrorSources, readErrorSources, retainError } from './index.js';
import { ownedErrorSources } from './origins.js';
import { serveOwnedError } from './owned.js';

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
  it('keeps the existing public runtime arities', () => {
    expect(RedactionRule.prototype.retainStageError.length).toBe(3);
    expect(RedactionRule.prototype.servedError.length).toBe(1);
    expect(RedactionRule.prototype.loggableError.length).toBe(1);
  });

  it('no-policy native serving adds no toString call', () => {
    const rule = new RedactionRule();
    const error = new Error('public');
    let conversions = 0;
    error.toString = () => {
      conversions++;
      return 'public';
    };
    expect(serveOwnedError(rule, error, () => undefined).raw).toBe(error);
    expect(conversions).toBe(0);
  });

  it('generic wrappers cannot expose a native masked cause, while another native origin stays independent', () => {
    const rule = new RedactionRule({ keys: ['unrelated'] });
    const frame = { runtimeStageId: 'a#1', failureIdentity: {} };
    prepareErrorSources(frame, {}, () => 1)();
    const error = new Error('SYNTHETIC-NATIVE-CAUSE-SECRET');
    expect(serveOwnedError(rule, error, ownedErrorSources(frame)).raw).toBeUndefined();
    const wrapper = new Error('public wrapper', { cause: error });
    const served = rule.servedError(wrapper);
    expect(served.message).toBe('public wrapper');
    expect(served.raw).toBeUndefined();
    expect(rule.loggableError(wrapper)).not.toBe(wrapper);
    expect(rule.servedError(error)).toEqual({ message: '[REDACTED]', raw: undefined });
    const other = { runtimeStageId: 'b#2', failureIdentity: {} };
    prepareErrorSources(other, {}, () => 0)();
    expect(serveOwnedError(rule, error, ownedErrorSources(other)).raw).toBe(error);
    expect(wrapper.cause).toBe(error);
  });

  it('actual contained-result slots survive native completion, aliases and cycles without changing raw results', () => {
    const rule = new RedactionRule({ keys: ['secret'] });
    const error = new Error('public shared');
    const make = (name, reads) => {
      const frame = new StageContext('run', name, name, new SharedMemory());
      frame.runtimeStageId = name + '#1';
      frame.bindFailureIdentity('run', frame.runtimeStageId);
      frame.useRedactionRule(rule);
      prepareErrorSources(frame, {}, () => reads)();
      recordStageError(frame, error);
      const envelope = retainChildResult(frame, { id: name, result: error, isError: true });
      frame.failureState.complete();
      return envelope;
    };
    const a = make('a', 1);
    const b = make('b', 0);
    const root = { a, alias: a, b, generic: error };
    root.self = root;
    a.parent = root;
    a.self = a;
    const served = rule.retainBoundary(root);
    expect(served).not.toBe(root);
    expect(served.self).toBe(served);
    expect(served.a).toBe(served.alias);
    expect(served.a.self).toBe(served.a);
    expect(served.a.parent).toBe(served);
    expect(served.a.result).toEqual({ message: '[REDACTED]', raw: undefined });
    expect(served.generic).toEqual({ message: '[REDACTED]', raw: undefined });
    expect(served.b.result).toBe(error);
    expect(root.a.result).toBe(error);
    expect(root.b.result).toBe(error);
    expect(root.self).toBe(root);
    expect(a.parent).toBe(root);
  });

  it.each([null, undefined, false, true])('never changes the unsupported scalar result shape: %s', (error) => {
    const rule = new RedactionRule({ keys: ['secret'] });
    const frame = new StageContext('run', 'Stage', 'stage', new SharedMemory());
    frame.runtimeStageId = 'stage#1';
    frame.bindFailureIdentity('run', 'stage#1');
    frame.useRedactionRule(rule);
    prepareErrorSources(frame, {}, () => 1)();
    recordStageError(frame, error);
    const envelope = retainChildResult(frame, { id: 'stage', result: error, isError: true });
    frame.failureState.complete();
    expect(rule.retainBoundary({ envelope }).envelope.result).toBe(error);
  });

  it('repeated real producer reports cannot revive an invalidated scalar invocation', () => {
    const frame = new StageContext('run', 'Stage', 'stage', new SharedMemory());
    frame.runtimeStageId = 'stage#1';
    frame.bindFailureIdentity('run', 'stage#1');
    frame.useRedactionRule(new RedactionRule({ keys: ['unrelated'] }));
    prepareErrorSources(frame, {}, () => 0)();
    expect(recordStageError(frame, 'public').structuredError.message).toBe('public');
    captureStageFailure(frame, 'public', true);
    for (let i = 0; i < 2; i++) {
      expect(recordStageError(frame, 'public').structuredError).toEqual({ message: '[REDACTED]', raw: undefined });
      expect(failureReceipt(frame.failureState, 'public').kind).toBe('unknown');
    }
  });
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
    expect(serveOwnedError(rule, error, () => ({ selectedReads: 0 }))).toEqual({
      message: '[REDACTED]',
      raw: undefined,
    });
  });

  it('an old partial mask cannot override a stronger current source decision', () => {
    const rule = new RedactionRule({ keys: ['secret'] });
    const error = Object.assign(new Error('public'), { secret: 'selected', code: 'PUBLIC_CODE' });
    expect(serveOwnedError(rule, error, () => ({ selectedReads: 0 })).message).toBe('public');
    expect(serveOwnedError(rule, error, () => ({ selectedReads: 1 }))).toEqual({
      message: '[REDACTED]',
      raw: undefined,
    });
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
    expect(serveOwnedError(rule, error, () => ({ selectedReads: 0 }))).toEqual({
      message: '[REDACTED]',
      raw: undefined,
    });
  });
});
