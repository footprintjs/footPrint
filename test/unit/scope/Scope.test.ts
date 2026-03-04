/**
 * Unit tests for Scope class - Core read/write operations
 *
 * Tests the basic functionality of the Scope class:
 *   - getValue: Reading values from scope
 *   - setValue: Overwriting values at a key
 *   - updateValue: Deep-merging values at a key
 *   - commit: Persisting staged writes to GlobalStore
 *   - Read-after-write consistency
 *   - Namespace isolation via pipelineId
 */

import { GlobalStore } from '../../../src/core/memory/GlobalStore';
import { Scope } from '../../../src/scope/Scope';

describe('Scope', () => {
  let globalStore: GlobalStore;
  let scope: Scope;

  beforeEach(() => {
    globalStore = new GlobalStore();
    scope = new Scope({
      pipelineId: 'test-pipeline',
      stageName: 'test-stage',
      globalStore,
    });
  });

  // ==========================================================================
  // Constructor Tests
  // ==========================================================================

  describe('constructor', () => {
    test('should create scope with required options', () => {
      const scope = new Scope({
        pipelineId: 'my-pipeline',
        stageName: 'my-stage',
        globalStore,
      });

      expect(scope.getPipelineId()).toBe('my-pipeline');
      expect(scope.getStageName()).toBe('my-stage');
      expect(scope.getGlobalStore()).toBe(globalStore);
    });

    test('should accept optional recorders', () => {
      const recorder = { id: 'test-recorder' };
      const scope = new Scope({
        pipelineId: 'my-pipeline',
        stageName: 'my-stage',
        globalStore,
        recorders: [recorder],
      });

      expect(scope.getPipelineId()).toBe('my-pipeline');
    });
  });

  // ==========================================================================
  // getValue Tests
  // ==========================================================================

  describe('getValue', () => {
    test('should return undefined for non-existent keys', () => {
      const value = scope.getValue('nonexistent');
      expect(value).toBeUndefined();
    });

    test('should return empty object when no key provided and nothing written', () => {
      const value = scope.getValue();
      expect(value).toEqual({});
    });

    test('should read values from GlobalStore after commit', () => {
      scope.setValue('timeout', 5000);
      scope.commit();

      // Create a new scope to ensure we're reading from GlobalStore
      const newScope = new Scope({
        pipelineId: 'test-pipeline',
        stageName: 'test-stage',
        globalStore,
      });

      const value = newScope.getValue('timeout');
      expect(value).toBe(5000);
    });

    test('should read value by key', () => {
      scope.setValue('timeout', 5000);
      scope.setValue('retries', 3);
      scope.commit();

      const newScope = new Scope({
        pipelineId: 'test-pipeline',
        stageName: 'test-stage',
        globalStore,
      });

      const timeout = newScope.getValue('timeout');
      expect(timeout).toBe(5000);
      const retries = newScope.getValue('retries');
      expect(retries).toBe(3);
    });
  });

  // ==========================================================================
  // setValue Tests
  // ==========================================================================

  describe('setValue', () => {
    test('should set primitive values', () => {
      scope.setValue('timeout', 5000);
      scope.commit();

      const value = globalStore.getValue('test-pipeline', [], 'timeout');
      expect(value).toBe(5000);
    });

    test('should set string values', () => {
      scope.setValue('name', 'test-name');
      scope.commit();

      const value = globalStore.getValue('test-pipeline', [], 'name');
      expect(value).toBe('test-name');
    });

    test('should set object values', () => {
      scope.setValue('admin', { name: 'Admin', role: 'admin' });
      scope.commit();

      const value = globalStore.getValue('test-pipeline', [], 'admin');
      expect(value).toEqual({ name: 'Admin', role: 'admin' });
    });

    test('should set array values', () => {
      scope.setValue('tags', ['a', 'b', 'c']);
      scope.commit();

      const value = globalStore.getValue('test-pipeline', [], 'tags');
      expect(value).toEqual(['a', 'b', 'c']);
    });

    test('should set null values', () => {
      scope.setValue('nullable', null);
      scope.commit();

      const value = globalStore.getValue('test-pipeline', [], 'nullable');
      expect(value).toBeNull();
    });

    test('should overwrite existing values', () => {
      scope.setValue('timeout', 5000);
      scope.commit();

      scope.setValue('timeout', 10000);
      scope.commit();

      const value = globalStore.getValue('test-pipeline', [], 'timeout');
      expect(value).toBe(10000);
    });

    test('should throw TypeError for non-string key', () => {
      expect(() => {
        (scope as any).setValue(123, 'value');
      }).toThrow(TypeError);
    });
  });

  // ==========================================================================
  // updateValue Tests
  // ==========================================================================

  describe('updateValue', () => {
    test('should deep merge object values', () => {
      scope.setValue('settings', { timeout: 5000 });
      scope.commit();

      scope.updateValue('settings', { retries: 3 });
      scope.commit();

      const value = globalStore.getValue('test-pipeline', [], 'settings');
      expect(value).toEqual({ timeout: 5000, retries: 3 });
    });

    test('should deep merge nested objects', () => {
      scope.setValue('settings', {
        http: { timeout: 5000 },
        logging: { level: 'info' },
      });
      scope.commit();

      scope.updateValue('settings', {
        http: { retries: 3 },
        cache: { enabled: true },
      });
      scope.commit();

      const value = globalStore.getValue('test-pipeline', [], 'settings');
      expect(value).toEqual({
        http: { timeout: 5000, retries: 3 },
        logging: { level: 'info' },
        cache: { enabled: true },
      });
    });

    test('should union arrays without duplicates', () => {
      scope.setValue('tags', ['a', 'b']);
      scope.commit();

      scope.updateValue('tags', ['b', 'c', 'd']);
      scope.commit();

      const value = globalStore.getValue('test-pipeline', [], 'tags');
      expect(value).toEqual(['a', 'b', 'c', 'd']);
    });

    test('should overwrite primitives', () => {
      scope.setValue('timeout', 5000);
      scope.commit();

      scope.updateValue('timeout', 10000);
      scope.commit();

      const value = globalStore.getValue('test-pipeline', [], 'timeout');
      expect(value).toBe(10000);
    });

    test('should create value if it does not exist', () => {
      scope.updateValue('newKey', { value: 42 });
      scope.commit();

      const value = globalStore.getValue('test-pipeline', [], 'newKey');
      expect(value).toEqual({ value: 42 });
    });

    test('should throw TypeError for non-string key', () => {
      expect(() => {
        (scope as any).updateValue(123, 'value');
      }).toThrow(TypeError);
    });
  });

  // ==========================================================================
  // Read-After-Write Consistency Tests
  // ==========================================================================

  describe('read-after-write consistency', () => {
    test('should read setValue values immediately before commit', () => {
      scope.setValue('timeout', 5000);

      // Read before commit
      const value = scope.getValue('timeout');
      expect(value).toBe(5000);
    });

    test('should read updateValue values immediately before commit', () => {
      scope.setValue('settings', { timeout: 5000 });
      scope.commit();

      scope.updateValue('settings', { retries: 3 });

      // Read before commit
      const value = scope.getValue('settings');
      expect(value).toEqual({ timeout: 5000, retries: 3 });
    });

    test('should reflect multiple writes before commit', () => {
      scope.setValue('a', 1);
      scope.setValue('b', 2);
      scope.setValue('c', 3);

      expect(scope.getValue('a')).toBe(1);
      expect(scope.getValue('b')).toBe(2);
      expect(scope.getValue('c')).toBe(3);
    });

    test('should reflect overwrites before commit', () => {
      scope.setValue('timeout', 5000);
      scope.setValue('timeout', 10000);

      const value = scope.getValue('timeout');
      expect(value).toBe(10000);
    });
  });

  // ==========================================================================
  // commit Tests
  // ==========================================================================

  describe('commit', () => {
    test('should persist all staged writes to GlobalStore', () => {
      scope.setValue('a', 1);
      scope.setValue('b', 2);
      scope.updateValue('c', { nested: true });

      scope.commit();

      expect(globalStore.getValue('test-pipeline', [], 'a')).toBe(1);
      expect(globalStore.getValue('test-pipeline', [], 'b')).toBe(2);
      expect(globalStore.getValue('test-pipeline', [], 'c')).toEqual({ nested: true });
    });

    test('should clear local cache after commit', () => {
      scope.setValue('timeout', 5000);
      scope.commit();

      // Modify GlobalStore directly
      globalStore.setValue('test-pipeline', [], 'timeout', 9999);

      // Should read from GlobalStore, not cache
      const value = scope.getValue('timeout');
      expect(value).toBe(9999);
    });

    test('should handle multiple commits', () => {
      scope.setValue('a', 1);
      scope.commit();

      scope.setValue('b', 2);
      scope.commit();

      scope.setValue('c', 3);
      scope.commit();

      expect(globalStore.getValue('test-pipeline', [], 'a')).toBe(1);
      expect(globalStore.getValue('test-pipeline', [], 'b')).toBe(2);
      expect(globalStore.getValue('test-pipeline', [], 'c')).toBe(3);
    });

    test('should handle empty commit', () => {
      // Should not throw
      expect(() => scope.commit()).not.toThrow();
    });
  });

  // ==========================================================================
  // Namespace Isolation Tests
  // ==========================================================================

  describe('namespace isolation', () => {
    test('should isolate values by pipelineId', () => {
      const scope1 = new Scope({
        pipelineId: 'pipeline-1',
        stageName: 'stage',
        globalStore,
      });

      const scope2 = new Scope({
        pipelineId: 'pipeline-2',
        stageName: 'stage',
        globalStore,
      });

      scope1.setValue('value', 'from-pipeline-1');
      scope1.commit();

      scope2.setValue('value', 'from-pipeline-2');
      scope2.commit();

      // Each scope should see its own value
      expect(scope1.getValue('value')).toBe('from-pipeline-1');
      expect(scope2.getValue('value')).toBe('from-pipeline-2');
    });

    test('should not affect other pipelines when writing', () => {
      const scope1 = new Scope({
        pipelineId: 'pipeline-1',
        stageName: 'stage',
        globalStore,
      });

      const scope2 = new Scope({
        pipelineId: 'pipeline-2',
        stageName: 'stage',
        globalStore,
      });

      scope1.setValue('value', 'from-pipeline-1');
      scope1.commit();

      // scope2 should not see scope1's value
      expect(scope2.getValue('value')).toBeUndefined();
    });
  });

  // ==========================================================================
  // Time-Travel Tests
  // ==========================================================================

  describe('time-travel support', () => {
    describe('getSnapshots', () => {
      test('should return empty array when no commits have been made', () => {
        const snapshots = scope.getSnapshots();
        expect(snapshots).toEqual([]);
      });

      test('should create a snapshot on each commit', () => {
        scope.setValue('value', 'first');
        scope.commit();

        scope.setValue('value', 'second');
        scope.commit();

        const snapshots = scope.getSnapshots();
        expect(snapshots).toHaveLength(2);
      });

      test('should include correct metadata in snapshots', () => {
        scope.setValue('value', 'test');
        scope.commit();

        const snapshots = scope.getSnapshots();
        expect(snapshots[0]).toMatchObject({
          index: 0,
          stageName: 'test-stage',
          pipelineId: 'test-pipeline',
        });
        expect(snapshots[0].timestamp).toBeGreaterThan(0);
      });

      test('should return a copy of the snapshots array', () => {
        scope.setValue('value', 'test');
        scope.commit();

        const snapshots1 = scope.getSnapshots();
        const snapshots2 = scope.getSnapshots();

        // Should be different array instances
        expect(snapshots1).not.toBe(snapshots2);
        // But with same content
        expect(snapshots1).toEqual(snapshots2);
      });

      test('should capture state at time of commit', () => {
        scope.setValue('value', 'first');
        scope.commit();

        scope.setValue('value', 'second');
        scope.commit();

        const snapshots = scope.getSnapshots();
        expect(snapshots[0].state).toEqual({ value: 'first' });
        expect(snapshots[1].state).toEqual({ value: 'second' });
      });
    });

    describe('getStateAt', () => {
      test('should return undefined for negative index', () => {
        scope.setValue('value', 'test');
        scope.commit();

        const state = scope.getStateAt(-1);
        expect(state).toBeUndefined();
      });

      test('should return undefined for index out of bounds', () => {
        scope.setValue('value', 'test');
        scope.commit();

        const state = scope.getStateAt(5);
        expect(state).toBeUndefined();
      });

      test('should return undefined when no snapshots exist', () => {
        const state = scope.getStateAt(0);
        expect(state).toBeUndefined();
      });

      test('should return state at specific snapshot index', () => {
        scope.setValue('value', 'first');
        scope.commit();

        scope.setValue('value', 'second');
        scope.commit();

        scope.setValue('value', 'third');
        scope.commit();

        expect(scope.getStateAt(0)).toEqual({ value: 'first' });
        expect(scope.getStateAt(1)).toEqual({ value: 'second' });
        expect(scope.getStateAt(2)).toEqual({ value: 'third' });
      });

      test('should return a deep copy of the state', () => {
        scope.setValue('nested', { a: { b: 1 } });
        scope.commit();

        const state1 = scope.getStateAt(0);
        const state2 = scope.getStateAt(0);

        // Should be different object instances
        expect(state1).not.toBe(state2);
        // Nested objects should also be different instances
        expect((state1 as any).nested).not.toBe((state2 as any).nested);
      });

      test('should NOT modify current execution state (read-only)', () => {
        scope.setValue('value', 'first');
        scope.commit();

        scope.setValue('value', 'second');
        scope.commit();

        // Get historical state
        const historicalState = scope.getStateAt(0);

        // Modify the returned state
        (historicalState as any).value = 'modified';

        // Current state should be unchanged
        expect(scope.getValue('value')).toBe('second');

        // Original snapshot should be unchanged
        const snapshots = scope.getSnapshots();
        expect(snapshots[0].state).toEqual({ value: 'first' });
      });
    });

    describe('getCurrentSnapshotIndex', () => {
      test('should return -1 when no snapshots exist', () => {
        expect(scope.getCurrentSnapshotIndex()).toBe(-1);
      });

      test('should return 0 after first commit', () => {
        scope.setValue('value', 'test');
        scope.commit();

        expect(scope.getCurrentSnapshotIndex()).toBe(0);
      });

      test('should increment with each commit', () => {
        scope.setValue('value', 'first');
        scope.commit();
        expect(scope.getCurrentSnapshotIndex()).toBe(0);

        scope.setValue('value', 'second');
        scope.commit();
        expect(scope.getCurrentSnapshotIndex()).toBe(1);

        scope.setValue('value', 'third');
        scope.commit();
        expect(scope.getCurrentSnapshotIndex()).toBe(2);
      });
    });

    describe('snapshot immutability', () => {
      test('should create deep copies of state in snapshots', () => {
        const originalObject = { nested: { value: 1 } };
        scope.setValue('data', originalObject);
        scope.commit();

        // Modify the original object
        originalObject.nested.value = 999;

        // Snapshot should have the original value
        const snapshots = scope.getSnapshots();
        expect(snapshots[0].state).toEqual({ data: { nested: { value: 1 } } });
      });

      test('should not affect snapshots when GlobalStore is modified', () => {
        scope.setValue('value', 'original');
        scope.commit();

        // Modify GlobalStore directly
        globalStore.setValue('test-pipeline', [], 'value', 'modified');

        // Snapshot should still have original value
        const state = scope.getStateAt(0);
        expect(state).toEqual({ value: 'original' });
      });
    });
  });

  // ==========================================================================
  // Recorder Management Coverage
  // ==========================================================================

  describe('recorder management', () => {
    test('attachStageRecorder adds to existing stage array', () => {
      const recorder1 = { id: 'r1' };
      const recorder2 = { id: 'r2' };

      scope.attachStageRecorder('myStage', recorder1);
      scope.attachStageRecorder('myStage', recorder2);

      const recorders = scope.getRecorders();
      expect(recorders).toContainEqual(recorder1);
      expect(recorders).toContainEqual(recorder2);
    });

    test('getRecorders returns global and stage-level recorders', () => {
      const globalRec = { id: 'global' };
      const stageRec = { id: 'stage' };

      scope.attachRecorder(globalRec);
      scope.attachStageRecorder('myStage', stageRec);

      const all = scope.getRecorders();
      expect(all.length).toBe(2);
      expect(all[0].id).toBe('global');
      expect(all[1].id).toBe('stage');
    });

    test('getRecorders deduplicates same recorder attached globally and to stage', () => {
      const rec = { id: 'shared' };

      scope.attachRecorder(rec);
      scope.attachStageRecorder('myStage', rec);

      const all = scope.getRecorders();
      expect(all.length).toBe(1);
    });

    test('detachRecorder removes from stage recorders (partial removal)', () => {
      const rec1 = { id: 'r1' };
      const rec2 = { id: 'r2' };

      scope.attachStageRecorder('myStage', rec1);
      scope.attachStageRecorder('myStage', rec2);

      scope.detachRecorder('r1');

      const recorders = scope.getRecorders();
      expect(recorders.length).toBe(1);
      expect(recorders[0].id).toBe('r2');
    });

    test('detachRecorder deletes stage entry when last recorder removed', () => {
      const rec = { id: 'only' };
      scope.attachStageRecorder('myStage', rec);

      scope.detachRecorder('only');

      const recorders = scope.getRecorders();
      expect(recorders.length).toBe(0);
    });
  });

  // ==========================================================================
  // endStage with resetStageName
  // ==========================================================================

  describe('endStage resetStageName', () => {
    test('endStage(true) resets stage name to empty string', () => {
      scope.startStage('processing');
      expect(scope.getStageName()).toBe('processing');

      scope.endStage(true);
      expect(scope.getStageName()).toBe('');
    });

    test('endStage(false) preserves stage name', () => {
      scope.startStage('processing');
      scope.endStage(false);
      expect(scope.getStageName()).toBe('processing');
    });
  });

  // ==========================================================================
  // Recorder error handling in hooks
  // ==========================================================================

  describe('recorder error handling', () => {
    test('recorder throwing in hook does not break execution', () => {
      const failingRecorder = {
        id: 'failing',
        onWrite: () => { throw new Error('recorder boom'); },
      };

      scope.attachRecorder(failingRecorder);

      // Should not throw despite the recorder error
      expect(() => {
        scope.setValue('key', 'value');
      }).not.toThrow();
    });

    test('recorder error handler receives error event', () => {
      const errors: any[] = [];
      const failingRecorder = {
        id: 'failing',
        onWrite: () => { throw new Error('hook error'); },
        onError: (event: any) => { errors.push(event); },
      };

      scope.attachRecorder(failingRecorder);
      scope.setValue('key', 'value');

      expect(errors.length).toBe(1);
      expect(errors[0].error).toBeInstanceOf(Error);
      expect(errors[0].operation).toBe('write');
    });

    test('recorder error in onRead triggers error event with read operation', () => {
      const errors: any[] = [];
      const failingRecorder = {
        id: 'failing',
        onRead: () => { throw new Error('read hook error'); },
        onError: (event: any) => { errors.push(event); },
      };

      scope.attachRecorder(failingRecorder);
      scope.getValue('key');

      expect(errors.length).toBe(1);
      expect(errors[0].operation).toBe('read');
    });

    test('recorder error in onCommit triggers error event with commit operation', () => {
      const errors: any[] = [];
      const failingRecorder = {
        id: 'failing',
        onCommit: () => { throw new Error('commit hook error'); },
        onError: (event: any) => { errors.push(event); },
      };

      scope.attachRecorder(failingRecorder);
      scope.setValue('key', 'value');
      scope.commit();

      expect(errors.length).toBe(1);
      expect(errors[0].operation).toBe('commit');
    });

    test('recorder error in development mode logs warning', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const failingRecorder = {
        id: 'dev-failing',
        onWrite: () => { throw new Error('dev error'); },
      };

      scope.attachRecorder(failingRecorder);
      scope.setValue('key', 'value');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('dev-failing'),
        expect.any(Error),
      );

      warnSpy.mockRestore();
      process.env.NODE_ENV = originalEnv;
    });
  });
});
