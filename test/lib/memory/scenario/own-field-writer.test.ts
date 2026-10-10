/** Public writer/replay witnesses for own-field defaults and atomic refusal. */
import { describe, expect, it } from 'vitest';

import { applySmartMerge, stateAt } from '../../../../src/trace.js';
import { EventLog, RecordFrame, SharedMemory } from '../../../../src/write.js';

describe('own fields through the public writer', () => {
  it.each(['toString', 'valueOf'])('retains the allowed default field %s at every depth', (key) => {
    const defaults = { [key]: { count: 1 }, nested: { [key]: { count: 2 } } };
    const state = new SharedMemory(defaults, { nested: {} });
    expect(state.getState()).toEqual(defaults);
    expect(state.getValue([], [], key)).toEqual({ count: 1 });
    expect(state.getValue([], ['nested'], key)).toEqual({ count: 2 });
    state.setValue([], [key], 'count', 3);
    expect(defaults[key]).toEqual({ count: 1 });
    expect(state.getValue([], [key], 'count')).toBe(3);
  });

  it.each(['full', 'delta'] as const)('keeps read-back, commit and replay aligned (%s)', (commitValues) => {
    const state = new SharedMemory({ toString: { count: 1 }, nested: { valueOf: { count: 2 } } });
    const before = state.getState();
    const log = new EventLog(before);
    const frame = new RecordFrame(state, log);
    frame.useEncoding({ commitValues, writeProvenance: 'off' });
    frame.write(['toString', 'count'], 3, 'set');
    frame.write(['nested', 'valueOf', 'extra'], true, 'set');
    expect(frame.read([], 'toString')).toEqual({ count: 3 });
    expect(frame.read(['nested'], 'valueOf')).toEqual({ count: 2, extra: true });
    frame.commit(() => ({ stage: 'write', stageId: 'write', runtimeStageId: 'write#0' }));
    const expected = { toString: { count: 3 }, nested: { valueOf: { count: 2, extra: true } } };
    expect(state.getState()).toEqual(expected);
    expect(stateAt({ initialState: log.getInitialState(), commitLog: log.list() }, 0).state).toEqual(expected);
    expect(before).toEqual({ toString: { count: 1 }, nested: { valueOf: { count: 2 } } });
  });

  it.each(['__proto__', 'constructor', 'prototype'])('a refused replay path through %s adds no prefix', (key) => {
    const base = { kept: { count: 1 } };
    const path = ['pending', 'nested', key, 'value'].join('\u001f');
    const result = applySmartMerge(base, {}, {}, [{ path, verb: 'set' }]);
    expect(result).toEqual(base);
    expect(Object.keys(result)).toEqual(['kept']);
  });
});
