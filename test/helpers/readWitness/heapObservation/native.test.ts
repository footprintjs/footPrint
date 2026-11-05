/** ROOT executes against the installed native images; no result is implied by this draft. */
import { describe, expect, it } from 'vitest';
import { BASELINE, BUILD, bytes, witnessingSync } from '../../../lib/memory/property/copy-on-write-fixture.js';
import type { Engine } from '../../../lib/memory/property/copy-on-write-fixture.js';
import { installReadLawObservation, requireDeletedReadInput } from '../observation.js';
import type { HeapProfile } from '../observationTypes.js';
import { checkedPair } from '../../readLawWitness/readPair.js';

const cases = [
  { name: 'run namespace has no base value but global x0 exists', path: [] as string[], initial: { x0: 7 } },
  {
    name: 'namespaced nested container is absent but global container exists',
    path: ['box'],
    initial: { box: { x0: 7 } },
  },
];
const coordinate = ['heap-native', 'read'] as const;

function exercise(
  engine: Engine,
  test: (typeof cases)[number],
  observer?: ReturnType<typeof installReadLawObservation>,
) {
  const memory = new engine.SharedMemory(undefined, test.initial);
  const log = new engine.EventLog(memory.getState()); // existing program observation, never an adapter call
  const stage = new engine.StageContext('r1', 'HeapRead', 'heap-stage', memory, '', log);
  stage.setObject(test.path, 'x0', undefined, false, undefined, 'delete');
  const read = () => stage.getValue(test.path, 'x0');
  const value = observer
    ? observer.operations.within({ coordinate, programPath: ['ops', 1], path: test.path }, read)
    : read();
  const immediate = bytes(value);
  const retained = bytes(stage.getSnapshot().stageReads);
  stage.commit();
  return { immediate, retained, commits: bytes(log.list()), state: bytes(memory.getState()) };
}

describe.each(cases)('native owning-heap fallback: $name', (test) => {
  it('preserves uninstrumented execution/records and joins the exact native memory fallback', () => {
    const collect = (engine: Engine, profile: HeapProfile) => {
      const [plain, plainCommits] = witnessingSync(engine, () => exercise(engine, test));
      const stageBefore = Object.getOwnPropertyDescriptors(engine.StageContext.prototype);
      const bufferBefore = Object.getOwnPropertyDescriptors(engine.TransactionBuffer.prototype);
      const memoryBefore = Object.getOwnPropertyDescriptors(engine.SharedMemory.prototype);
      const observer = installReadLawObservation(engine, 'same-leg', undefined, profile);
      try {
        const [watched, watchedCommits] = witnessingSync(engine, () => exercise(engine, test, observer));
        observer.assertUsable();
        expect(watched).toEqual(plain);
        expect(watchedCommits).toEqual(plainCommits);
        const receipt = observer.receipt();
        const read = receipt.events.find((event) => event.tier === 'stage-call' && event.method === 'getValue')!;
        const input = requireDeletedReadInput(receipt, read.id);
        expect(input.get.base?.found).toBe(false);
        expect(input.get.result).toEqual({ kind: 'undefined' });
        const span = observer.operations.receipt().spans[0];
        const bound = {
          coordinate,
          start: span.start,
          end: span.end,
          frame: read.frame!,
          nativeId: read.id,
          occurrence: 0,
        };
        if (engine === BASELINE) {
          expect(read.result).toEqual({ kind: 'number', value: '7' });
          expect(read.memoryGets).toHaveLength(1);
          const memory = receipt.events.find((event) => event.id === read.memoryGets![0])!;
          expect(memory.call!.args).toEqual([{ kind: 'string', value: 'r1' }, read.call!.args[0], read.call!.args[1]]);
          expect(memory.parentRead).toBe(read.id);
          expect(memory.receiverObject).toBe(read.heapBefore!.memory);
        } else {
          expect(read.result).toEqual({ kind: 'undefined' });
          expect(read.memoryGets).toEqual([]);
        }
        return { receipt, bound };
      } finally {
        observer.restore();
        expect(Object.getOwnPropertyDescriptors(engine.StageContext.prototype)).toEqual(stageBefore);
        expect(Object.getOwnPropertyDescriptors(engine.TransactionBuffer.prototype)).toEqual(bufferBefore);
        expect(Object.getOwnPropertyDescriptors(engine.SharedMemory.prototype)).toEqual(memoryBefore);
      }
    };
    const old = collect(BASELINE, 'baseline-stage-shared-memory');
    const next = collect(BUILD, 'build-record-state');
    expect(() =>
      checkedPair(old.receipt, next.receipt, { baseline: old.bound, build: next.bound, sites: [] }),
    ).not.toThrow();
  });
});
