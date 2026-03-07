import { EventLog } from '../../../../src/lib/memory/EventLog';
import { SharedMemory } from '../../../../src/lib/memory/SharedMemory';
import { StageContext } from '../../../../src/lib/memory/StageContext';

function createCtx(runId = 'p1', stageName = 'stage1') {
  const mem = new SharedMemory();
  const log = new EventLog({});
  const ctx = new StageContext(runId, stageName, mem, '', log);
  return { ctx, mem, log };
}

describe('StageContext', () => {
  describe('write and read', () => {
    it('setObject and getValue within namespace', () => {
      const { ctx } = createCtx();
      ctx.setObject([], 'name', 'Alice');
      expect(ctx.getValue([], 'name')).toBe('Alice');
    });

    it('updateObject merges values within a buffer session', () => {
      const { ctx } = createCtx();
      ctx.setObject([], 'tags', ['a']);
      ctx.updateObject([], 'tags', ['b']);
      expect(ctx.getValue([], 'tags')).toEqual(['a', 'b']);
    });

    it('setRoot writes at run root', () => {
      const { ctx, mem } = createCtx();
      ctx.setRoot('status', 'running');
      ctx.commit();
      expect(mem.getValue('p1', [], 'status')).toBe('running');
    });

    it('setGlobal writes to global scope', () => {
      const { ctx, mem } = createCtx();
      ctx.setGlobal('globalKey', 'globalVal');
      ctx.commit();
      expect(mem.getValue('', [], 'globalKey')).toBe('globalVal');
    });

    it('appendToArray appends items', () => {
      const { ctx } = createCtx();
      ctx.setObject([], 'items', [1, 2]);
      ctx.commit();
      ctx.appendToArray([], 'items', [3, 4]);
      expect(ctx.getValue([], 'items')).toEqual([1, 2, 3, 4]);
    });

    it('appendToArray creates array when none exists', () => {
      const { ctx } = createCtx();
      ctx.appendToArray([], 'items', [1, 2]);
      expect(ctx.getValue([], 'items')).toEqual([1, 2]);
    });

    it('mergeObject shallow-merges into existing object', () => {
      const { ctx } = createCtx();
      ctx.setObject([], 'config', { a: 1 });
      ctx.commit();
      ctx.mergeObject([], 'config', { b: 2 });
      expect(ctx.getValue([], 'config')).toEqual({ a: 1, b: 2 });
    });
  });

  describe('commit', () => {
    it('atomically applies to SharedMemory', () => {
      const { ctx, mem } = createCtx();
      ctx.setObject([], 'x', 1);
      ctx.setObject([], 'y', 2);
      ctx.commit();

      expect(mem.getValue('p1', [], 'x')).toBe(1);
      expect(mem.getValue('p1', [], 'y')).toBe(2);
    });

    it('records commit to EventLog', () => {
      const { ctx, log } = createCtx();
      ctx.setObject([], 'x', 1);
      ctx.commit();
      expect(log.list()).toHaveLength(1);
      expect(log.list()[0].stage).toBe('stage1');
    });

    it('logs writeTrace to diagnostics', () => {
      const { ctx } = createCtx();
      ctx.setObject([], 'x', 1);
      ctx.commit();
      expect(ctx.debug.logContext.writeTrace).toBeDefined();
    });
  });

  describe('tree navigation', () => {
    it('createNext creates a linked successor', () => {
      const { ctx } = createCtx();
      const next = ctx.createNext('p1', 'stage2');
      expect(ctx.next).toBe(next);
      expect(next.parent).toBe(ctx);
      expect(next.stageName).toBe('stage2');
    });

    it('createNext returns existing next if called twice', () => {
      const { ctx } = createCtx();
      const n1 = ctx.createNext('p1', 'stage2');
      const n2 = ctx.createNext('p1', 'stage2');
      expect(n1).toBe(n2);
    });

    it('createChild creates branch contexts', () => {
      const { ctx } = createCtx();
      const c1 = ctx.createChild('p1', 'b1', 'branch1');
      const c2 = ctx.createChild('p1', 'b2', 'branch2');

      expect(ctx.children).toHaveLength(2);
      expect(c1.parent).toBe(ctx);
      expect(c2.parent).toBe(ctx);
      expect(c1.branchId).toBe('b1');
    });

    it('createDecider creates a decider next', () => {
      const { ctx } = createCtx();
      const dec = ctx.createDecider('p1', 'decide');
      expect(dec.isDecider).toBe(true);
    });

    it('setAsDecider and setAsFork', () => {
      const { ctx } = createCtx();
      expect(ctx.isDecider).toBe(false);
      ctx.setAsDecider();
      expect(ctx.isDecider).toBe(true);
      ctx.setAsFork();
      expect(ctx.isFork).toBe(true);
    });
  });

  describe('diagnostics delegation', () => {
    it('delegates addLog/addMetric/addError/addEval', () => {
      const { ctx } = createCtx();
      ctx.addLog('msg', 'hello');
      ctx.addMetric('time', 100);
      ctx.addError('err', 'oops');
      ctx.addEval('score', 0.9);

      expect(ctx.debug.logContext.msg).toBeDefined();
      expect(ctx.debug.metricContext.time).toBeDefined();
      expect(ctx.debug.errorContext.err).toBeDefined();
      expect(ctx.debug.evalContext.score).toBeDefined();
    });

    it('addFlowDebugMessage adds to flowMessages', () => {
      const { ctx } = createCtx();
      ctx.addFlowDebugMessage('branch', 'took left path', { targetStage: 'left' });
      expect(ctx.debug.flowMessages).toHaveLength(1);
      expect(ctx.debug.flowMessages[0].type).toBe('branch');
    });
  });

  describe('snapshot', () => {
    it('getSnapshot returns serialisable tree', () => {
      const { ctx } = createCtx();
      ctx.addLog('msg', 'test');
      const next = ctx.createNext('p1', 'stage2');
      next.addLog('msg', 'test2');
      ctx.createChild('p1', 'b1', 'branch1');

      const snap = ctx.getSnapshot();
      expect(snap.id).toBe('p1');
      expect(snap.name).toBe('stage1');
      expect(snap.next?.name).toBe('stage2');
      expect(snap.children).toHaveLength(1);
    });

    it('getStageId combines runId and stageName', () => {
      const { ctx } = createCtx('p1', 'validate');
      expect(ctx.getStageId()).toBe('p1.validate');
    });

    it('getStageId returns stageName when no runId', () => {
      const mem = new SharedMemory();
      const ctx = new StageContext('', 'root', mem);
      expect(ctx.getStageId()).toBe('root');
    });
  });

  describe('global reads', () => {
    it('getGlobal reads from global scope', () => {
      const mem = new SharedMemory({ globalVal: 42 });
      const ctx = new StageContext('p1', 's1', mem);
      expect(ctx.getGlobal('globalVal')).toBe(42);
    });

    it('getFromGlobalContext reads from global scope', () => {
      const mem = new SharedMemory({ globalVal: 42 });
      const ctx = new StageContext('p1', 's1', mem);
      expect(ctx.getFromGlobalContext('globalVal')).toBe(42);
    });

    it('getScope returns full state', () => {
      const mem = new SharedMemory({ x: 1 });
      const ctx = new StageContext('p1', 's1', mem);
      expect(ctx.getScope()).toHaveProperty('x', 1);
    });
  });

  // ── Additional coverage tests ─────────────────────────────────────────

  describe('getSharedMemory', () => {
    it('returns the SharedMemory instance', () => {
      const mem = new SharedMemory();
      const ctx = new StageContext('p1', 's1', mem);
      expect(ctx.getSharedMemory()).toBe(mem);
    });
  });

  describe('set (alias for patch)', () => {
    it('writes a value via set', () => {
      const { ctx } = createCtx();
      ctx.set([], 'key', 'val');
      expect(ctx.getValue([], 'key')).toBe('val');
    });
  });

  describe('get (alias for getValue)', () => {
    it('reads a value via get', () => {
      const { ctx } = createCtx();
      ctx.setObject([], 'key', 'val');
      expect(ctx.get([], 'key')).toBe('val');
    });
  });

  describe('updateObject with description', () => {
    it('logs description when provided', () => {
      const { ctx } = createCtx();
      ctx.updateObject([], 'data', { a: 1 }, 'merging data');
      expect(ctx.debug.logContext.message).toContain('merging data');
    });
  });

  describe('setGlobal with description', () => {
    it('logs description when provided', () => {
      const { ctx } = createCtx();
      ctx.setGlobal('gk', 'gv', 'setting global');
      expect(ctx.debug.logContext.message).toContain('setting global');
    });
  });

  describe('updateGlobalContext', () => {
    it('writes to global scope without namespace', () => {
      const { ctx, mem } = createCtx();
      ctx.updateGlobalContext('globalKey', 'globalVal');
      ctx.commit();
      expect(mem.getValue('', [], 'globalKey')).toBe('globalVal');
    });
  });

  describe('getValue with description', () => {
    it('logs READ description when provided', () => {
      const { ctx } = createCtx();
      ctx.setObject([], 'key', 'val');
      ctx.getValue([], 'key', 'reading key');
      expect(ctx.debug.logContext.message).toContain('[READ] reading key');
    });
  });

  describe('getRoot', () => {
    it('reads from run root in shared memory', () => {
      const { ctx, mem } = createCtx();
      ctx.setRoot('status', 'done');
      ctx.commit();
      expect(ctx.getRoot('status')).toBe('done');
    });
  });

  describe('getFromRoot', () => {
    it('reads from run root (alias)', () => {
      const { ctx } = createCtx();
      ctx.setRoot('status', 'ok');
      ctx.commit();
      expect(ctx.getFromRoot('status')).toBe('ok');
    });
  });

  describe('getRunId', () => {
    it('returns the runId', () => {
      const { ctx } = createCtx('myRun', 'myStage');
      expect(ctx.getRunId()).toBe('myRun');
    });
  });

  describe('appendToArray edge cases', () => {
    it('appends with description', () => {
      const { ctx } = createCtx();
      ctx.appendToArray([], 'list', [1], 'appending items');
      expect(ctx.debug.logContext.message).toContain('[WRITE] appending items');
    });
  });

  describe('mergeObject edge cases', () => {
    it('creates new object when existing is non-object', () => {
      const { ctx } = createCtx();
      ctx.setObject([], 'data', 'not-an-object');
      ctx.commit();
      ctx.mergeObject([], 'data', { b: 2 });
      expect(ctx.getValue([], 'data')).toEqual({ b: 2 });
    });

    it('creates new object when existing is an array', () => {
      const { ctx } = createCtx();
      ctx.setObject([], 'data', [1, 2]);
      ctx.commit();
      ctx.mergeObject([], 'data', { b: 2 });
      expect(ctx.getValue([], 'data')).toEqual({ b: 2 });
    });

    it('merges with description', () => {
      const { ctx } = createCtx();
      ctx.mergeObject([], 'data', { a: 1 }, 'merging config');
      expect(ctx.debug.logContext.message).toContain('[WRITE] merging config');
    });
  });

  describe('diagnostics delegation — set variants', () => {
    it('delegates setLog', () => {
      const { ctx } = createCtx();
      ctx.setLog('key', 'value');
      expect(ctx.debug.logContext.key).toBe('value');
    });

    it('delegates setMetric', () => {
      const { ctx } = createCtx();
      ctx.setMetric('latency', 50);
      expect(ctx.debug.metricContext.latency).toBe(50);
    });

    it('delegates setEval', () => {
      const { ctx } = createCtx();
      ctx.setEval('accuracy', 0.95);
      expect(ctx.debug.evalContext.accuracy).toBe(0.95);
    });
  });

  describe('createChild with isDecider', () => {
    it('creates a child context marked as decider', () => {
      const { ctx } = createCtx();
      const child = ctx.createChild('p1', 'b1', 'branch1', true);
      expect(child.isDecider).toBe(true);
      expect(child.branchId).toBe('b1');
    });
  });

  describe('namespace with empty runId', () => {
    it('skips runs prefix when runId is empty', () => {
      const mem = new SharedMemory();
      const ctx = new StageContext('', 'root', mem);
      ctx.setObject([], 'key', 'val');
      ctx.commit();
      // With empty runId, path should be just [key] not ['runs', '', key]
      expect(mem.getState().key).toBe('val');
    });
  });

  describe('snapshot with flowMessages', () => {
    it('includes flowMessages in snapshot when present', () => {
      const { ctx } = createCtx();
      ctx.addFlowDebugMessage('branch', 'took left path');
      const snap = ctx.getSnapshot();
      expect(snap.flowMessages).toHaveLength(1);
      expect(snap.flowMessages![0].description).toBe('took left path');
    });

    it('omits flowMessages from snapshot when empty', () => {
      const { ctx } = createCtx();
      const snap = ctx.getSnapshot();
      expect(snap.flowMessages).toBeUndefined();
    });
  });
});
