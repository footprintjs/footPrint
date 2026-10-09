/**
 * Boundary: empty inputs — the record's classes with nothing in them: a heap with no seed, a buffer with no
 * writes, a log with no bundles, and a stage frame (`RecordFrame`, footprintjs/write) that stages nothing.
 *
 * The frame's diagnostics are the engine's, not the record's: their empty case lives in
 * unit/DiagnosticCollector.test.ts.
 */
import { TransactionBuffer } from '../../../../src/lib/memory/TransactionBuffer';
import { EventLog, RecordFrame, SharedMemory } from '../../../../src/write';

describe('Boundary: empty inputs', () => {
  describe('SharedMemory', () => {
    it('works with no constructor args', () => {
      const mem = new SharedMemory();
      expect(mem.getState()).toEqual({});
      expect(mem.getDefaultValues()).toBeUndefined();
    });

    it('getValue on empty store returns undefined', () => {
      const mem = new SharedMemory();
      expect(mem.getValue(['runs', 'p1'], [], 'nonexistent')).toBeUndefined();
    });

    it('getValue with no args returns the full state', () => {
      const mem = new SharedMemory({ x: 1 });
      expect(mem.getValue()).toEqual({ x: 1 });
    });
  });

  describe('TransactionBuffer', () => {
    it('commit with no writes returns empty patches', () => {
      const buf = new TransactionBuffer({});
      const result = buf.commit();
      expect(result.overwrite).toEqual({});
      expect(result.updates).toEqual({});
      expect(result.trace).toEqual([]);
      expect(result.redactedPaths.size).toBe(0);
    });

    it('works with empty base state', () => {
      const buf = new TransactionBuffer({});
      buf.set(['key'], 'val');
      expect(buf.get(['key'])).toBe('val');
    });
  });

  describe('EventLog', () => {
    it('materialise on empty log returns initial state', () => {
      const log = new EventLog({ init: true });
      expect(log.materialise()).toEqual({ init: true });
    });

    it('materialise(0) on empty log returns initial state', () => {
      const log = new EventLog({});
      expect(log.materialise(0)).toEqual({});
    });

    it('list on empty log returns empty array', () => {
      const log = new EventLog({});
      expect(log.list()).toEqual([]);
    });
  });

  describe('RecordFrame', () => {
    it('commit with no writes does not crash', () => {
      const mem = new SharedMemory();
      const log = new EventLog(mem.getState());
      const frame = new RecordFrame(mem, log, ['runs', 'p1']);
      frame.commit(() => ({ stage: 's1', stageId: 's1', runtimeStageId: 's1#0' })); // should not throw
      expect(log.list()).toHaveLength(1);
    });

    it('a read on empty state returns undefined', () => {
      const mem = new SharedMemory();
      const frame = new RecordFrame(mem, undefined, ['runs', 'p1']);
      expect(frame.read([], 'missing')).toBeUndefined();
    });

    it('the root address (an empty run id) writes root-level keys', () => {
      const mem = new SharedMemory();
      const frame = new RecordFrame(mem);
      frame.write(frame.at([], 'key'), 'val', 'set');
      frame.commit(() => ({ stage: 'root', stageId: 'root', runtimeStageId: 'root#0' }));
      expect(mem.getValue([], [], 'key')).toBe('val');
    });
  });
});
