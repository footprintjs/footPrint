/**
 * Copying payload keys must create data, never call an inherited setter.
 * These arrays and built-ins carry rich-JavaScript expandos, not JSON input.
 * Selector refusal is separate: none of these writes addresses a denied key.
 */
import { describe, expect, it } from 'vitest';

import { shallowCopy } from '../../../../src/lib/memory/pathOps.js';
import { stateAt } from '../../../../src/trace.js';
import { EventLog, RecordFrame, SharedMemory } from '../../../../src/write.js';

const names = ['__proto__', 'constructor', 'prototype'] as const;

function data(target: object, key: string, value: unknown, writable = true): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable, configurable: writable });
}

function payloadKeys(target: object): void {
  for (const name of names) data(target, name, { marker: name });
}

function expectPayloadKeys(target: object, prototype: object): void {
  expect(Object.getPrototypeOf(target)).toBe(prototype);
  for (const name of names) {
    expect(Object.prototype.hasOwnProperty.call(target, name)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(target, name)?.value).toEqual({ marker: name });
  }
  expect((target as Record<string, unknown>).marker).toBeUndefined();
}

function arrayPayload(): Array<{ count: number }> {
  const array = [{ count: 0 }];
  payloadKeys(array);
  return array;
}

describe('shallowCopy — payload names are own data', () => {
  it.each(names)('keeps a sparse array’s %s data, holes, length and shallow references', (name) => {
    const source = new Array<unknown>(4);
    source[1] = { kept: true };
    const payload = { marker: name };
    data(source, name, payload, false);
    data(source, 'note', { kept: 'named' });
    Object.defineProperty(source, 'hidden', { value: 1 });
    const descriptors = Object.getOwnPropertyDescriptors(source);

    const copy = shallowCopy(source);

    expect(copy).not.toBe(source);
    expect(Object.getPrototypeOf(copy)).toBe(Array.prototype);
    expect(copy.length).toBe(4);
    expect(Object.keys(copy)).toEqual(['1', name, 'note']);
    expect(Object.prototype.hasOwnProperty.call(copy, 0)).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(copy, 2)).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(copy, 3)).toBe(false);
    expect(copy[1]).toBe(source[1]);
    expect(Object.getOwnPropertyDescriptor(copy, 'note')?.value).toBe(descriptors.note.value);
    expect(Object.getOwnPropertyDescriptor(copy, name)).toEqual({
      value: payload,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect((copy as unknown as Record<string, unknown>).marker).toBeUndefined();
    expect(Object.getOwnPropertyDescriptors(source)).toEqual(descriptors);
    expect(Object.getPrototypeOf(source)).toBe(Array.prototype);
  });

  const builtins: Array<[string, () => object]> = [
    ['Date', () => new Date(5)],
    ['Map', () => new Map([['kept', { value: 1 }]])],
    ['Set', () => new Set([1])],
    ['RegExp', () => /kept/g],
    ['Uint8Array', () => new Uint8Array([1, 2])],
    ['DataView', () => new DataView(new Uint8Array([1, 2]).buffer)],
    ['ArrayBuffer', () => new Uint8Array([1, 2]).buffer],
  ];
  for (const [kind, make] of builtins) {
    it.each(names)(`${kind} restores %s as data without changing intrinsic fields or the source`, (name) => {
      const source = make();
      const intrinsic = structuredClone(source);
      const payload = { marker: name };
      data(source, name, payload, false);
      const descriptors = Object.getOwnPropertyDescriptors(source);

      const copy = shallowCopy(source);

      expect(copy).not.toBe(source);
      expect(Object.getPrototypeOf(copy)).toBe(Object.getPrototypeOf(intrinsic));
      expect(structuredClone(copy)).toEqual(intrinsic);
      expect(Object.getOwnPropertyDescriptor(copy, name)).toEqual({
        value: payload,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      expect((copy as Record<string, unknown>).marker).toBeUndefined();
      expect(Object.getOwnPropertyDescriptors(source)).toEqual(descriptors);
      expect(Object.getPrototypeOf(source)).toBe(Object.getPrototypeOf(intrinsic));
    });
  }

  it('does not invoke a benign inherited setter or change an existing own slot’s descriptor', () => {
    let setterCalls = 0;
    let getterCalls = 0;
    class Copy extends Array<unknown> {
      constructor(length: number) {
        super(length);
        Object.defineProperty(this, 'existing', { value: 0, writable: true });
      }
    }
    Object.defineProperty(Copy.prototype, 'note', {
      get: () => {
        getterCalls++;
        return 'inherited';
      },
      set: () => {
        setterCalls++;
      },
      configurable: true,
    });
    const source: unknown[] = [1];
    Object.defineProperty(source, 'constructor', { value: { [Symbol.species]: Copy } });
    data(source, 'note', 'own');
    data(source, 'existing', 2);

    const copy = shallowCopy(source);

    expect(setterCalls).toBe(0);
    expect(getterCalls).toBe(0);
    expect(Object.getPrototypeOf(copy)).toBe(Copy.prototype);
    expect(Object.getOwnPropertyDescriptor(copy, 'note')).toEqual({
      value: 'own',
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(Object.getOwnPropertyDescriptor(copy, 'existing')).toEqual({
      value: 2,
      enumerable: false,
      writable: true,
      configurable: false,
    });
  });
});

describe('public writers — copied payloads do not become prototypes', () => {
  it.each(['setValue', 'updateValue'] as const)(
    'SharedMemory.%s keeps array payload keys and the prior generation',
    (method) => {
      const source = arrayPayload();
      const state = new SharedMemory(undefined, { array: source });
      const before = state.getState().array as Array<{ count: number }>;

      state[method]([], ['array'], 'note', { written: true });

      const after = state.getState().array as object;
      expect(after).not.toBe(before);
      for (const array of [source, before, after]) expectPayloadKeys(array, Array.prototype);
      expect(Object.prototype.hasOwnProperty.call(before, 'note')).toBe(false);
      expect(Object.getOwnPropertyDescriptor(after, 'note')?.value).toEqual({ written: true });
    },
  );

  it.each(['full', 'delta'] as const)(
    'a read after an unrelated write keeps the array prototype (%s)',
    (commitValues) => {
      const state = new SharedMemory(undefined, { array: arrayPayload() });
      const before = state.getState();
      const log = new EventLog(before);
      const frame = new RecordFrame(state, log);
      frame.useEncoding({ commitValues, writeProvenance: 'off' });
      frame.write(['unrelated'], true, 'set');

      expect(frame.read(['array'], '0')).toEqual({ count: 0 });
      expectPayloadKeys(frame.read([], 'array') as object, Array.prototype);
      frame.commit(() => ({ stage: 'read', stageId: 'read', runtimeStageId: 'read#0' }));

      expect(log.list()[0].trace).toEqual([{ path: 'unrelated', verb: 'set' }]);
      for (const view of [
        before,
        state.getState(),
        stateAt({ initialState: log.getInitialState(), commitLog: log.list() }, 0).state,
      ]) {
        expectPayloadKeys((view as Record<string, object>).array, Array.prototype);
      }
    },
  );

  it.each(['full', 'delta'] as const)(
    'a nested array write commits and replays without inheriting payload data (%s)',
    (commitValues) => {
      const state = new SharedMemory(undefined, { array: arrayPayload() });
      const before = state.getState();
      const log = new EventLog(before);
      const frame = new RecordFrame(state, log);
      frame.useEncoding({ commitValues, writeProvenance: 'off' });
      frame.write(['array', 0, 'count'], 1, 'set');
      expectPayloadKeys(frame.read([], 'array') as object, Array.prototype);
      frame.commit(() => ({ stage: 'write', stageId: 'write', runtimeStageId: 'write#0' }));

      const replay = stateAt({ initialState: log.getInitialState(), commitLog: log.list() }, 0).state;
      for (const view of [state.getState(), replay]) {
        const array = (view as { array: Array<{ count: number }> }).array;
        expectPayloadKeys(array, Array.prototype);
        expect(array[0].count).toBe(1);
      }
      expect((before.array as Array<{ count: number }>)[0].count).toBe(0);
      expectPayloadKeys(before.array as object, Array.prototype);
    },
  );

  it.each(['full', 'delta'] as const)(
    'a staged Date’s nested write preserves its prototype before commit (%s)',
    (commitValues) => {
      const date = new Date(5);
      payloadKeys(date);
      const state = new SharedMemory();
      const log = new EventLog(state.getState());
      const frame = new RecordFrame(state, log);
      frame.useEncoding({ commitValues, writeProvenance: 'off' });
      frame.write(['date'], date, 'set');
      frame.write(['date', 'note'], 'written', 'set');
      const read = frame.read([], 'date') as Date;
      expectPayloadKeys(read, Date.prototype);
      expect(read.getTime()).toBe(5);
      expectPayloadKeys(date, Date.prototype);
      expect(Object.prototype.hasOwnProperty.call(date, 'note')).toBe(false);
      frame.commit(() => ({ stage: 'date', stageId: 'date', runtimeStageId: 'date#0' }));

      // structuredClone still drops Date expandos at the record boundary. This
      // fix preserves copy safety, not a new serialization law for built-ins.
      const replay = stateAt({ initialState: log.getInitialState(), commitLog: log.list() }, 0).state;
      for (const view of [state.getState(), replay]) {
        const recorded = (view as { date: Date }).date;
        expect(Object.getPrototypeOf(recorded)).toBe(Date.prototype);
        expect(recorded.getTime()).toBe(5);
        expect((recorded as unknown as Record<string, unknown>).marker).toBeUndefined();
      }
    },
  );
});
