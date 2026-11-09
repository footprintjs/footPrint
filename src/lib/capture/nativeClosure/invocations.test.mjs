import { buildAttemptId } from 'foottrace';
import { SharedMemory } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import { StageContext } from '../../memory/StageContext.js';
import { NATIVE_EXTENT_MAX_INVOCATIONS } from '../nativeExtent/format.js';
import { NativeClosureInvocations } from './invocations.js';

const identity = Object.freeze({ runId: 'run', runtimeStageId: 'stage#0' });

describe('native closure invocation count', () => {
  it('copies immutable official invocation identity and resets without keeping an owner', () => {
    const counter = new NativeClosureInvocations();
    expect(counter.count).toBe(0);
    const owner = { ...identity };
    const first = counter.begin(owner, undefined);
    owner.runId = 'another-run';
    expect(first).toEqual({ kind: 'invocation', ...identity, attemptId: buildAttemptId(identity.runtimeStageId, 1) });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Reflect.set(first, 'attemptId', 'forged')).toBe(false);
    expect(counter.count).toBe(1);
    expect(Object.values(counter)).toEqual([1]);
    counter.reset();
    expect(counter.count).toBe(0);
    expect(counter.begin(identity, { attempt: 3 }).attemptId).toBe(buildAttemptId(identity.runtimeStageId, 3));
  });

  it('increments before reading the attempt, including when that getter throws', () => {
    const counter = new NativeClosureInvocations();
    const thrown = new Error('attempt read');
    let observed;
    const attempt = {
      get attempt() {
        observed = counter.count;
        throw thrown;
      },
    };
    let caught;
    try {
      counter.begin(identity, attempt);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(thrown);
    expect(observed).toBe(1);
    expect(counter.count).toBe(1);
  });

  it('saturates without reading the attempt, with an eager-read mutation control', () => {
    const counter = new NativeClosureInvocations();
    for (let i = 0; i < NATIVE_EXTENT_MAX_INVOCATIONS; i++) counter.begin(identity, undefined);
    const witness = (subject) => {
      let reads = 0;
      const attempt = {
        get attempt() {
          reads++;
          return 1;
        },
      };
      return { result: subject.begin(identity, attempt), reads };
    };
    expect(counter.count).toBe(NATIVE_EXTENT_MAX_INVOCATIONS);
    const refusesWithoutAttemptRead = (subject) =>
      expect(witness(subject)).toEqual({ result: 'counter-saturated', reads: 0 });
    refusesWithoutAttemptRead(counter);
    // The same behavioral witness rejects the deliberately broken eager-attempt variant.
    const eagerMutation = {
      begin(owner, attempt) {
        void attempt.attempt;
        return counter.begin(owner, attempt);
      },
    };
    expect(() => refusesWithoutAttemptRead(eagerMutation)).toThrow();
    expect(counter.count).toBe(NATIVE_EXTENT_MAX_INVOCATIONS);
  });

  it('keeps the frame default-off and reads extent only for actual saturation', () => {
    const frame = new StageContext('run', 'Stage', 'stage', new SharedMemory());
    let extentReads = 0;
    Object.defineProperty(frame, 'captureExtent', {
      get() {
        extentReads++;
        throw new Error('unexpected extent read');
      },
    });
    const attempt = {
      get attempt() {
        throw new Error('unexpected attempt read');
      },
    };
    frame.bindFailureIdentity(identity.runId, identity.runtimeStageId);
    expect(frame.beginClosureInvocation(attempt)).toBeUndefined();
    expect(Object.hasOwn(frame, 'closureInvocations')).toBe(false);
    frame.captureClosureTracking = true;
    expect(frame.getSnapshot().nativeInvocations).toBe(0);
    expect(frame.beginClosureInvocation(undefined)).toEqual({
      kind: 'invocation',
      ...identity,
      attemptId: buildAttemptId(identity.runtimeStageId, 1),
    });
    expect(frame.getSnapshot().nativeInvocations).toBe(1);
    frame.bindFailureIdentity(identity.runId, 'next#1');
    expect(frame.getSnapshot().nativeInvocations).toBe(0);
    expect(extentReads).toBe(0);
  });

  it('does not allocate or read an attempt without a bound native identity', () => {
    const frame = new StageContext('run', 'Stage', 'stage', new SharedMemory());
    frame.captureClosureTracking = true;
    expect(
      frame.beginClosureInvocation({
        get attempt() {
          throw new Error('unexpected attempt read');
        },
      }),
    ).toBeUndefined();
    expect(Object.hasOwn(frame, 'closureInvocations')).toBe(false);
    expect(frame.getSnapshot().nativeInvocations).toBe(0);
  });
});
