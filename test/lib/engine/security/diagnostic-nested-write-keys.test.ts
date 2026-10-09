/**
 * Real TypedScope diagnostic calls reach the guarded nested writer. A denied
 * diagnostic NAME is ignored by its bag; identical keys inside a value are data.
 * Diagnostics may still emit events, but never become shared-state writes.
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';

const channels = [
  ['$debug', 'logs'],
  ['$error', 'errors'],
  ['$metric', 'metrics'],
  ['$eval', 'evals'],
] as const;
type DiagnosticMethod = (typeof channels)[number][0];
type Entry = readonly [string, unknown];

async function recordDiagnostics(method: DiagnosticMethod, entries: readonly Entry[]) {
  const chart = flowChart<{ kept: string }>(
    'Diagnostics',
    (scope) => {
      scope.kept = 'ordinary shared state';
      for (const [name, value] of entries) scope[method](name, value);
    },
    'diagnostics',
  ).build();
  const executor = new FlowChartExecutor(chart);
  await executor.run();
  return executor.getSnapshot();
}

describe.each(channels)('%s diagnostic names through the public runner', (method, channel) => {
  it.each(['__proto__', 'constructor', 'prototype'])(
    'ignores %s, retains ordinary entries and leaves the state record unchanged',
    async (name) => {
      const payload = {
        ['__proto__']: { payload: true },
        constructor: { prototype: { payload: true } },
        prototype: 'ordinary data',
      };
      const [snapshot, control] = await Promise.all([
        recordDiagnostics(method, [
          ['before', 'first'],
          [name, { attempted: true }],
          ['payload', payload],
          ['after', 'last'],
        ]),
        recordDiagnostics(method, []),
      ]);
      const bag = snapshot.executionTree[channel];

      expect(Object.keys(bag)).toEqual(['before', 'payload', 'after']);
      expect(Object.hasOwn(bag, name)).toBe(false);
      expect(Object.getPrototypeOf(bag)).toBe(Object.prototype);
      expect(bag.before).toBe('first');
      expect(bag.after).toBe('last');
      expect(bag.payload).toEqual(payload);
      expect(Object.getOwnPropertyDescriptor(bag.payload, '__proto__')?.value).toEqual({ payload: true });
      expect(Object.getPrototypeOf(bag.payload)).toBe(Object.prototype);
      for (const [, otherChannel] of channels) {
        if (otherChannel !== channel) expect(snapshot.executionTree[otherChannel]).toEqual({});
      }

      expect(snapshot.sharedState).toEqual({ kept: 'ordinary shared state' });
      expect(snapshot.sharedState).toEqual(control.sharedState);
      expect(snapshot.commitLog).toEqual(control.commitLog);
      expect(snapshot.commitLog).toHaveLength(1);
      expect(snapshot.commitLog[0].trace).toEqual([{ path: 'kept', verb: 'set' }]);
    },
  );
});
