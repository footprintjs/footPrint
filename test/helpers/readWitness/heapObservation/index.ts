import { identityGraph } from '../identityGraph.js';
import type { HeapPoint, HeapProfile, Method, NativeFact, NativeReadScope, ValueFact } from '../observationTypes.js';
import { heapPoint } from './layout.js';

/** All identity, time, ownership and evidence storage come from the ONE existing observer. */
export interface HeapObservationPorts {
  readonly tick: () => number;
  readonly objectId: (value: unknown) => number | undefined;
  readonly snapshot: (value: unknown) => ValueFact;
  readonly capture: <T>(work: () => T) => T | undefined;
  readonly publish: (fact: NativeFact) => NativeFact | undefined;
  readonly currentRead: () => NativeReadScope | undefined;
}

export function createHeapObservation(
  profile: HeapProfile,
  memoryPrototype: object,
  leg: string,
  ports: HeapObservationPorts,
) {
  const point = (context: object): HeapPoint =>
    heapPoint(context, profile, memoryPrototype, {
      tick: ports.tick,
      objectId: (value) => ports.objectId(value)!,
      snapshot: ports.snapshot,
    });
  return {
    point,
    wrap: (native: Method): Method =>
      function (...args) {
        const read = ports.currentRead();
        // This port claims only calls made inside one actual observed StageContext read.
        if (!read) return Reflect.apply(native, this, args);
        const start = ports.tick();
        const before = ports.capture(() => point(read.context));
        const receiverObject = ports.objectId(this);
        const call = ports.capture(() =>
          Object.freeze({
            args: Object.freeze(args.map(ports.snapshot)),
            objects: Object.freeze(args.map(ports.objectId)),
            identities: Object.freeze(args.map((value) => identityGraph(value, (item) => ports.objectId(item)!))),
          }),
        );
        let result: unknown;
        let outcome: 'returned' | 'threw' = 'returned';
        try {
          result = Reflect.apply(native, this, args);
          return result;
        } catch (error) {
          outcome = 'threw';
          throw error;
        } finally {
          // Capture the raw return before control returns to the stage or fixture interpreter.
          const returned =
            outcome === 'returned'
              ? ports.capture(() => ({
                  result: ports.snapshot(result),
                  resultObject: ports.objectId(result),
                  resultIdentities: identityGraph(result, (item) => ports.objectId(item)!),
                }))
              : undefined;
          const after = ports.capture(() => point(read.context));
          const event = ports.publish({
            id: start,
            start,
            end: ports.tick(),
            leg,
            tier: 'memory-get',
            method: 'getValue',
            phase: 'read',
            outcome,
            frame: read.frame,
            header: read.header,
            operation: read.operation,
            parentRead: read.id,
            receiverObject,
            call,
            heapBefore: before,
            heapAfter: after,
            ...returned,
          });
          if (event) read.memoryGets.push(event.id);
        }
      },
  };
}
