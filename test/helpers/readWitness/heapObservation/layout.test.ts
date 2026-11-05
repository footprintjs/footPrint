import { describe, expect, it } from 'vitest';

import type { HeapProfile, ValueFact } from '../observationTypes.js';
import { heapPoint } from './layout.js';

describe('explicit own-data heap layout profiles', () => {
  const setup = () => {
    let time = 0;
    const ids = new WeakMap<object, number>();
    let next = 0;
    const ports = {
      tick: () => ++time,
      objectId: (value: object) => {
        if (!ids.has(value)) ids.set(value, ++next);
        return ids.get(value)!;
      },
      snapshot: (value: unknown): ValueFact => ({ kind: 'object', value: JSON.stringify(value) }),
    };
    class Memory {
      context = { x: 7 };
      getState() {
        throw new Error('must never be called');
      }
    }
    return { ports, Memory, memory: new Memory() };
  };

  it.each(['baseline-stage-shared-memory', 'build-record-state'] as const)(
    'captures %s without invoking a memory method and detects both swap and in-place edits',
    (profile) => {
      const { ports, Memory, memory } = setup();
      const context =
        profile === 'baseline-stage-shared-memory' ? { sharedMemory: memory } : { record: { state: memory } };
      const a = heapPoint(context, profile, Memory.prototype, ports);
      const b = heapPoint(context, profile, Memory.prototype, ports);
      expect(b.memory).toBe(a.memory);
      expect(b.generation).toBe(a.generation);
      expect(b.facts).toEqual(a.facts);
      memory.context.x = 8;
      const inPlace = heapPoint(context, profile, Memory.prototype, ports);
      expect(inPlace.generation).toBe(a.generation);
      expect(inPlace.facts).not.toEqual(a.facts);
      memory.context = { x: 7 };
      const swapped = heapPoint(context, profile, Memory.prototype, ports);
      expect(swapped.generation).not.toBe(a.generation);
      expect(swapped.facts).toEqual(a.facts);
    },
  );

  it('never guesses an alternate, inherited, getter-backed or unknown native layout', () => {
    const { ports, Memory, memory } = setup();
    let invoked = 0;
    const contexts = [
      { record: { state: memory } },
      Object.create({ sharedMemory: memory }),
      {
        get sharedMemory() {
          invoked++;
          return memory;
        },
      },
      { sharedMemory: { context: { x: 7 } } },
      { sharedMemory: Object.create(Memory.prototype) },
    ];
    for (const context of contexts)
      expect(() => heapPoint(context, 'baseline-stage-shared-memory', Memory.prototype, ports)).toThrow();
    expect(invoked).toBe(0);
    expect(() => heapPoint({ sharedMemory: memory }, 'label' as HeapProfile, Memory.prototype, ports)).toThrow();
  });
});
