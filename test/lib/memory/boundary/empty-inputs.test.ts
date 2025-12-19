import { SharedMemory } from '../../../../src/lib/memory/SharedMemory';
import { TransactionBuffer } from '../../../../src/lib/memory/TransactionBuffer';
import { EventLog } from '../../../../src/lib/memory/EventLog';
import { StageContext } from '../../../../src/lib/memory/StageContext';
import { DiagnosticCollector } from '../../../../src/lib/memory/DiagnosticCollector';

describe('Boundary: empty inputs', () => {
  describe('SharedMemory', () => {
    it('works with no constructor args', () => {
      const mem = new SharedMemory();
      expect(mem.getState()).toEqual({});
      expect(mem.getDefaultValues()).toBeUndefined();
    });

    it('getValue on empty store returns undefined', () => {
      const mem = new SharedMemory();
      expect(mem.getValue('p1', [], 'nonexistent')).toBeUndefined();
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

  describe('StageContext', () => {
    it('commit with no writes does not crash', () => {
      const mem = new SharedMemory();
      const log = new EventLog(mem.getState());
      const ctx = new StageContext('p1', 's1', mem, '', log);
      ctx.commit(); // should not throw
      expect(log.list()).toHaveLength(1);
    });

    it('getValue on empty state returns undefined', () => {
      const mem = new SharedMemory();
      const ctx = new StageContext('p1', 's1', mem);
      expect(ctx.getValue([], 'missing')).toBeUndefined();
    });

    it('empty runId works (root-level writes)', () => {
      const mem = new SharedMemory();
      const ctx = new StageContext('', 'root', mem);
      ctx.setObject([], 'key', 'val');
      ctx.commit();
      expect(mem.getValue('', [], 'key')).toBe('val');
    });
  });

  describe('DiagnosticCollector', () => {
    it('starts with empty contexts', () => {
      const dc = new DiagnosticCollector();
      expect(dc.logContext).toEqual({});
      expect(dc.errorContext).toEqual({});
      expect(dc.metricContext).toEqual({});
      expect(dc.evalContext).toEqual({});
      expect(dc.flowMessages).toEqual([]);
    });
  });
});
