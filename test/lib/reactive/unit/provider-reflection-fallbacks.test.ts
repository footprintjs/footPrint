/** Optional provider capabilities preserve reflection, with tracked reads only when silent inspection is absent. */
import { expect, it } from 'vitest';

import { createTypedScope } from '../../../../src/lib/reactive/createTypedScope.js';
import type { ReactiveTarget } from '../../../../src/lib/reactive/types.js';

function provider(state?: Record<string, unknown>) {
  const reads: Array<string | undefined> = [];
  const unexpected = () => {
    throw new Error('Reflection must not invoke an unrelated provider operation');
  };
  const target: ReactiveTarget = {
    getValue(key?: string) {
      reads.push(key);
      return key === undefined ? state : state?.[key];
    },
    setValue: unexpected,
    updateValue: unexpected,
    deleteValue: unexpected,
    getArgs: unexpected,
    getEnv: unexpected,
    getAttempt: unexpected,
    call: unexpected,
    attachScopeRecorder: unexpected,
    detachScopeRecorder: unexpected,
    getScopeRecorders: unexpected,
    addDebugInfo: unexpected,
    addDebugMessage: unexpected,
    addErrorInfo: unexpected,
    addMetric: unexpected,
    addEval: unexpected,
    emitEvent: unexpected,
    detachAndJoinLater: unexpected,
    detachAndForget: unexpected,
  };
  return { target, reads };
}

it('uses the optional key list for membership and descriptors without fetching values', () => {
  const { target, reads } = provider({ count: 0 });
  target.getStateKeys = () => ['count'];
  const scope = createTypedScope(target);

  expect(Reflect.has(scope, 'count')).toBe(true);
  expect(Reflect.has(scope, 'missing')).toBe(false);
  expect(Object.getOwnPropertyDescriptor(scope, 'count')).toMatchObject({ enumerable: true, writable: true });
  expect(Object.getOwnPropertyDescriptor(scope, 'missing')).toBeUndefined();
  expect(reads).toEqual([]);
});

it('falls back to tracked value reads for membership while preserving falsy values', () => {
  const { target, reads } = provider({ count: 0, enabled: false, name: '', missing: undefined });
  const scope = createTypedScope(target);

  expect(Reflect.has(scope, 'count')).toBe(true);
  expect(Reflect.has(scope, 'enabled')).toBe(true);
  expect(Reflect.has(scope, 'name')).toBe(true);
  // The minimal provider answers absence by undefined; no stronger own-key evidence is available.
  expect(Reflect.has(scope, 'missing')).toBe(false);
  expect(reads).toEqual(['count', 'enabled', 'name', 'missing']);
});

it('lists a minimal provider through one whole-state read, including an empty backend', () => {
  const populated = provider({ count: 0, enabled: false });
  expect(Reflect.ownKeys(createTypedScope(populated.target))).toEqual(['count', 'enabled']);
  expect(populated.reads).toEqual([undefined]);

  const empty = provider();
  expect(Reflect.ownKeys(createTypedScope(empty.target))).toEqual([]);
  expect(empty.reads).toEqual([undefined]);
});

it('does not turn unrelated symbol probes into reads of business state', () => {
  const { target, reads } = provider({ count: 1 });
  const scope = createTypedScope(target);
  const probe = Symbol('consumer inspection');

  expect(Reflect.get(scope, probe)).toBeUndefined();
  expect(Reflect.has(scope, probe)).toBe(false);
  expect(Object.getOwnPropertyDescriptor(scope, probe)).toBeUndefined();
  expect(reads).toEqual([]);
});
