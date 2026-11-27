import { couldHaveChanged } from 'foottrace/cause';
/**
 * Unit tests: ExecutionRuntime — runtime environment for flowchart execution.
 *
 * Covers:
 * - Constructor wiring (SharedMemory, StageContext, EventLog)
 * - getSnapshot() field names (sharedState, executionTree, commitLog)
 * - getPipelines()
 * - setRootObject()
 */
import { memorySink } from 'foottrace/write';

import { runPolicy } from '../../../../src/lib/memory/runPolicy';
import { installStoredControl } from '../../../../src/lib/memory/storedControlEvidence';
import { ExecutionRuntime } from '../../../../src/lib/runner/ExecutionRuntime';

describe('ExecutionRuntime', () => {
  it('constructor creates all three primitives', () => {
    const runtime = new ExecutionRuntime('test', 'test');
    expect(runtime.globalStore).toBeDefined();
    expect(runtime.rootStageContext).toBeDefined();
    expect(runtime.executionHistory).toBeDefined();
  });

  it.each([false, true])('opens the opted-in root control log with read sources %s', (readSources) => {
    const sink = memorySink();
    const address = { logRunId: 'control-root', drillPath: [] };
    const runtime = new ExecutionRuntime(
      'Root',
      'root',
      undefined,
      {},
      runPolicy({ readSources }),
      { address, sink, collects: { reads: 'off' } },
      { runId: address.logRunId },
    );

    expect(Boolean(runtime.readSources)).toBe(readSources);
    expect(runtime.executionHistory.keepsEvidence).toBe(true);
    expect(sink.entries).toMatchObject([
      { kind: 'opened', address, collects: { v: typeof couldHaveChanged === 'function' ? 2 : 1, reads: 'off' } },
    ]);
    installStoredControl(runtime.executionHistory);

    const root = runtime.rootStageContext;
    root.runtimeStageId = 'root#0';
    root.bindFailureIdentity(address.logRunId, root.runtimeStageId);
    root.commit();
    const next = root.createNext('', 'Next', 'next');
    next.runtimeStageId = 'next#1';
    next.bindFailureIdentity(address.logRunId, next.runtimeStageId);
    next.commit();
    next.commit('repeat');

    const foreignRuntime = new ExecutionRuntime('Foreign', 'foreign');
    const foreign = foreignRuntime.rootStageContext;
    foreign.runtimeStageId = 'foreign#0';
    const orphan = runtime.newRoot('Orphan', 'orphan');
    orphan.parent = foreign;
    orphan.runtimeStageId = 'orphan#2';
    orphan.bindFailureIdentity(address.logRunId, orphan.runtimeStageId);
    orphan.commit();

    const commits = sink.entries.filter((entry) => entry.kind === 'commit');
    expect(commits.map((entry) => entry.about)).toEqual([{}, { parent: 'root#0' }, undefined, {}]);
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
});
