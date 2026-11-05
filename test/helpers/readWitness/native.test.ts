/** Actual native ports; the immutable historical program is never repaired by the observer. */
import { describe, expect, it } from 'vitest';

import { BASELINE, BUILD, bytes, witnessingSync } from '../../lib/memory/property/copy-on-write-fixture.js';
import { installReadLawObservation, requireDeletedReadInput, sameStageDeletedReadInputs } from './observation.js';

describe.each([BASELINE, BUILD])('native read observation on $label', (engine) => {
  function program() {
    const memory = new engine.SharedMemory(undefined, { cfg: { n: 1 }, other: 7 });
    const log = new engine.EventLog(memory.getState());
    const stage = new engine.StageContext('', 'Stage', 'stage', memory, '', log);
    stage.setObject([], 'cfg', undefined, false, undefined, 'delete');
    const value = stage.getValue([], 'cfg');
    const immediate = bytes(value);
    const retained = bytes(stage.getSnapshot().stageReads);
    stage.commit();
    return { immediate, retained, commits: bytes(log.list()), state: bytes(memory.getState()) };
  }

  it('keeps every program byte and every existing commit witness while observing the real native result', () => {
    const [plain, plainCommits] = witnessingSync(engine, program);
    const stageBefore = Object.getOwnPropertyDescriptors(engine.StageContext.prototype);
    const bufferBefore = Object.getOwnPropertyDescriptors(engine.TransactionBuffer.prototype);
    const observer = installReadLawObservation(engine, 'direct0');
    try {
      const [watched, watchedCommits] = witnessingSync(engine, program);
      observer.assertUsable();
      expect(watched).toEqual(plain);
      expect(watchedCommits).toEqual(plainCommits);
      const receipt = observer.receipt();
      const nativeRead = receipt.events.find((event) => event.method === 'getValue');
      expect(nativeRead).toBeDefined();
      const joined = requireDeletedReadInput(receipt, nativeRead!.id);
      expect(joined.get.address).toEqual(['cfg']);
      expect(joined.deletedBy.phase).toBe('write');
      expect(joined.get.base?.found).toBe(true);
      expect(joined.get.base?.value.kind).toBe('object');
      expect(joined.read.header?.stageId).toBe('stage');
      if (engine === BUILD) {
        expect(joined.read.result).toEqual({ kind: 'undefined' });
        expect(watched.retained).toBe(bytes({ cfg: undefined }));
      } else {
        expect(joined.read.result).toEqual(joined.get.base!.value);
        expect(watched.immediate).toBe(bytes({ n: 1 }));
      }
    } finally {
      observer.restore();
    }
    expect(Object.getOwnPropertyDescriptors(engine.StageContext.prototype)).toEqual(stageBefore);
    expect(Object.getOwnPropertyDescriptors(engine.TransactionBuffer.prototype)).toEqual(bufferBefore);
  });

  it('a normal read and a live namespace fallback without a same-frame tombstone supply no deleted-read input', () => {
    const memory = new engine.SharedMemory(undefined, { cfg: 7, runs: { branch: { cfg: undefined } } });
    const log = new engine.EventLog(memory.getState());
    const stage = new engine.StageContext('branch', 'Stage', 'stage', memory, '', log);
    const observer = installReadLawObservation(engine, 'namespace0');
    try {
      expect(stage.getValue([], 'cfg')).toBe(7);
      observer.assertUsable();
      expect(sameStageDeletedReadInputs(observer.receipt())).toEqual([]);
    } finally {
      observer.restore();
    }
  });
});
