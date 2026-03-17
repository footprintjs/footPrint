/**
 * Unit tests: ExecutionRuntime — runtime environment for flowchart execution.
 *
 * Covers:
 * - Constructor wiring (SharedMemory, StageContext, EventLog)
 * - getSnapshot() field names (sharedState, executionTree, commitLog)
 * - getFullNarrative() with walkContextTree
 * - getPipelines()
 * - setRootObject()
 */

import { ExecutionRuntime } from '../../../../src/lib/runner/ExecutionRuntime';

describe('ExecutionRuntime', () => {
  it('constructor creates all three primitives', () => {
    const runtime = new ExecutionRuntime('test', 'test');
    expect(runtime.globalStore).toBeDefined();
    expect(runtime.rootStageContext).toBeDefined();
    expect(runtime.executionHistory).toBeDefined();
  });

  it('constructor applies defaultValues', () => {
    const runtime = new ExecutionRuntime('test', 'test', { defaultKey: 'defaultVal' });
    const state = runtime.globalStore.getState();
    expect(state.defaultKey).toBe('defaultVal');
  });

  it('constructor applies initialState', () => {
    const runtime = new ExecutionRuntime('test', 'test', undefined, { initial: 'data' });
    const state = runtime.globalStore.getState();
    expect(state.initial).toBe('data');
  });

  describe('getSnapshot()', () => {
    it('returns sharedState, executionTree, commitLog', () => {
      const runtime = new ExecutionRuntime('root', 'root');
      const snapshot = runtime.getSnapshot();

      expect(snapshot).toHaveProperty('sharedState');
      expect(snapshot).toHaveProperty('executionTree');
      expect(snapshot).toHaveProperty('commitLog');
      expect(typeof snapshot.sharedState).toBe('object');
      expect(typeof snapshot.executionTree).toBe('object');
      expect(Array.isArray(snapshot.commitLog)).toBe(true);
    });

    it('sharedState reflects committed state', () => {
      const runtime = new ExecutionRuntime('root', 'root');
      runtime.rootStageContext.setGlobal('x', 42);
      runtime.rootStageContext.commit();

      const snapshot = runtime.getSnapshot();
      expect(snapshot.sharedState.x).toBe(42);
    });

    it('commitLog grows with each commit', () => {
      const runtime = new ExecutionRuntime('root', 'root');
      runtime.rootStageContext.setGlobal('a', 1);
      runtime.rootStageContext.commit();
      runtime.rootStageContext.setGlobal('b', 2);
      runtime.rootStageContext.commit();

      const snapshot = runtime.getSnapshot();
      expect(snapshot.commitLog.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('getPipelines()', () => {
    it('returns empty array when no pipelines key', () => {
      const runtime = new ExecutionRuntime('root', 'root');
      expect(runtime.getPipelines()).toEqual([]);
    });

    it('returns pipeline keys when pipelines state exists', () => {
      const runtime = new ExecutionRuntime('root', 'root');
      runtime.rootStageContext.setObject(['pipelines'], 'branch-a', {});
      runtime.rootStageContext.setObject(['pipelines'], 'branch-b', {});
      runtime.rootStageContext.commit();

      const pipelines = runtime.getPipelines();
      expect(pipelines).toContain('branch-a');
      expect(pipelines).toContain('branch-b');
    });
  });

  describe('setRootObject()', () => {
    it('sets nested objects on root context', () => {
      const runtime = new ExecutionRuntime('root', 'root');
      runtime.setRootObject(['config'], 'debug', true);
      runtime.rootStageContext.commit();

      const snapshot = runtime.getSnapshot();
      expect((snapshot.sharedState.config as any)?.debug).toBe(true);
    });
  });

  describe('getFullNarrative()', () => {
    it('returns empty narrative for fresh runtime', () => {
      const runtime = new ExecutionRuntime('root', 'root');
      const narrative = runtime.getFullNarrative();

      expect(narrative.length).toBe(1); // root context
      expect(narrative[0].stageName).toBe('root');
      expect(narrative[0].timeIndex).toBe(0);
    });

    it('walks next chain in context tree', () => {
      const runtime = new ExecutionRuntime('root', 'root');
      const root = runtime.rootStageContext;

      // Simulate execution: root → next1 → next2
      const next1 = root.createNext('', 'stage1', 'stage1');
      const next2 = next1.createNext('', 'stage2', 'stage2');

      const narrative = runtime.getFullNarrative();

      expect(narrative.length).toBe(3);
      expect(narrative[0].stageName).toBe('root');
      expect(narrative[1].stageName).toBe('stage1');
      expect(narrative[2].stageName).toBe('stage2');
    });

    it('walks children in context tree', () => {
      const runtime = new ExecutionRuntime('root', 'root');
      const root = runtime.rootStageContext;

      // Simulate fork: root → child-a, child-b
      root.createChild('', 'a', 'child-a', 'child-a');
      root.createChild('', 'b', 'child-b', 'child-b');

      const narrative = runtime.getFullNarrative();

      expect(narrative.length).toBe(3);
      const names = narrative.map((n) => n.stageName);
      expect(names).toContain('root');
      expect(names).toContain('child-a');
      expect(names).toContain('child-b');
    });

    it('walks mixed tree (children + next)', () => {
      const runtime = new ExecutionRuntime('root', 'root');
      const root = runtime.rootStageContext;

      // root has children and next
      root.createChild('', 'a', 'child-a', 'child-a');
      const next = root.createNext('', 'next-stage', 'next-stage');

      const narrative = runtime.getFullNarrative();
      const names = narrative.map((n) => n.stageName);

      expect(names).toContain('root');
      expect(names).toContain('child-a');
      expect(names).toContain('next-stage');
    });

    it('captures flow messages from context', () => {
      const runtime = new ExecutionRuntime('root', 'root');
      const root = runtime.rootStageContext;

      root.addFlowDebugMessage('next', 'Moving to Process stage', {
        targetStage: 'process',
      });

      const narrative = runtime.getFullNarrative();
      expect(narrative[0].flowMessage).toBeDefined();
      expect(narrative[0].flowMessage!.type).toBe('next');
    });
  });
});
