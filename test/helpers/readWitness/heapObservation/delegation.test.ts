import { describe, expect, it } from 'vitest';

import type { Method, NativeFact, NativeReadScope, ValueFact } from '../observationTypes.js';
import { createHeapObservation } from './index.js';

describe('original heap-call delegation', () => {
  function fixture() {
    let clock = 0;
    let next = 0;
    const ids = new WeakMap<object, number>();
    const events: NativeFact[] = [];
    const issues: unknown[] = [];
    const objectId = (value: unknown) => {
      if (value === null || typeof value !== 'object') return undefined;
      if (!ids.has(value)) ids.set(value, ++next);
      return ids.get(value)!;
    };
    const snapshot = (value: unknown): ValueFact => ({
      kind: value === undefined ? 'undefined' : typeof value,
      ...(value !== undefined && { value: JSON.stringify(value) }),
    });
    class Memory {
      context = { x: 7 };
    }
    const memory = new Memory();
    const read: NativeReadScope = {
      id: 1,
      context: { sharedMemory: memory },
      frame: 4,
      header: { stageId: 'S', runId: 'r1' },
      operation: ['read', 0],
      gets: [],
      memoryGets: [],
    };
    let active: NativeReadScope | undefined = read;
    const observer = createHeapObservation('baseline-stage-shared-memory', Memory.prototype, 'L', {
      tick: () => ++clock,
      objectId,
      snapshot,
      capture: (work) => {
        try {
          return work();
        } catch (error) {
          issues.push(error);
          return undefined;
        }
      },
      publish: (event) => {
        events.push(event);
        return event;
      },
      currentRead: () => active,
    });
    return {
      observer,
      memory,
      read,
      events,
      issues,
      objectId,
      deactivate: () => {
        active = undefined;
      },
    };
  }

  it('calls once with the exact receiver and arguments and preserves the returned raw object identity', () => {
    const f = fixture();
    const path = ['branch'];
    const result = { answer: 7 };
    let count = 0;
    const native: Method = function (...args) {
      count++;
      expect(this).toBe(f.memory);
      expect(args).toEqual(['r1', path, 'x']);
      expect(args[1]).toBe(path);
      return result;
    };
    expect(f.observer.wrap(native).call(f.memory, 'r1', path, 'x')).toBe(result);
    expect(count).toBe(1);
    expect(f.issues).toEqual([]);
    const event = f.events[0];
    expect(event.parentRead).toBe(f.read.id);
    expect(event.receiverObject).toBe(f.objectId(f.memory));
    expect(event.call!.objects[1]).toBe(f.objectId(path));
    expect(event.resultObject).toBe(f.objectId(result));
    expect(f.read.memoryGets).toEqual([event.id]);
  });

  it('preserves an escaping non-Error identity while still recording the original throw', () => {
    const f = fixture();
    const thrown = { refused: true };
    let seen: unknown;
    try {
      f.observer
        .wrap(function () {
          throw thrown;
        })
        .call(f.memory);
    } catch (error) {
      seen = error;
    }
    expect(seen).toBe(thrown);
    expect(f.events[0].outcome).toBe('threw');
    expect(f.events[0].result).toBeUndefined();
  });

  it('does not claim a direct unrelated memory call outside a StageContext read', () => {
    const f = fixture();
    f.deactivate();
    const raw = {};
    expect(
      f.observer
        .wrap(function () {
          return raw;
        })
        .call(f.memory),
    ).toBe(raw);
    expect(f.events).toEqual([]);
    expect(f.read.memoryGets).toEqual([]);
  });

  it('poisons unsupported capture but does not replace a successful native result', () => {
    const f = fixture();
    Object.defineProperty(f.memory, 'context', {
      get() {
        throw new Error('must not invoke');
      },
    });
    expect(
      f.observer
        .wrap(function () {
          return 7;
        })
        .call(f.memory),
    ).toBe(7);
    expect(f.issues.length).toBeGreaterThan(0);
    expect(f.events[0].heapBefore).toBeUndefined();
  });
});
