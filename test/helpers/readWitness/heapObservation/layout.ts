import type { HeapPoint, HeapProfile, ValueFact } from '../observationTypes.js';

const own = (value: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('Unobserved owning heap layout.');
  return descriptor.value;
};
const object = (value: unknown): object => {
  if (value === null || typeof value !== 'object') throw new Error('Unobserved owning heap object.');
  return value;
};

/** Exactly two known own-data layouts. This is not a namespace resolver or content search. */
export function heapPoint(
  context: object,
  profile: HeapProfile,
  memoryPrototype: object,
  ports: { tick: () => number; objectId: (value: object) => number; snapshot: (value: unknown) => ValueFact },
): HeapPoint {
  const memory =
    profile === 'baseline-stage-shared-memory'
      ? object(own(context, 'sharedMemory'))
      : profile === 'build-record-state'
      ? object(own(object(own(context, 'record')), 'state'))
      : (() => {
          throw new Error('Unobserved owning heap profile.');
        })();
  if (Object.getPrototypeOf(memory) !== memoryPrototype) throw new Error('Unobserved owning heap class.');
  const generation = object(own(memory, 'context'));
  return Object.freeze({
    layout: profile,
    at: ports.tick(),
    memory: ports.objectId(memory),
    generation: ports.objectId(generation),
    facts: ports.snapshot(generation),
  });
}
