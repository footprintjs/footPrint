import _set from 'lodash.set';

import { GlobalStore } from '../../../src/core/context/GlobalStore';
import { StageContext } from '../../../src/core/context/StageContext';
import { ExecutionHistory } from '../../../src/core/stateManagement/ExecutionHistory';
import { DELIM } from '../../../src/core/stateManagement/WriteBuffer';
import { redactPatch } from '../../../src/core/stateManagement/utils';

jest.mock('../../../src/core/stateManagement/utils', () => ({
  // use real implementation except redactPatch (spy later)
  ...jest.requireActual('../../../src/core/stateManagement/utils'),
  redactPatch: jest.fn(jest.requireActual('../../../src/core/stateManagement/utils').redactPatch),
}));

const pipelineId = 'path';
describe('StageContext', () => {
  let globalStore: GlobalStore;
  let stageContext: StageContext;

  beforeEach(() => {
    globalStore = new GlobalStore();
    stageContext = new StageContext(pipelineId, 'name', globalStore);
  });

  test('should create next context', () => {
    const nextContext = stageContext.createNext('nextPath', 'nextName');
    expect(nextContext.parent).toBe(stageContext);
  });

  test('should create child context', () => {
    const childContext = stageContext.createChild('branchingId', 'childId', 'childName');
    expect(childContext.parent).toBe(stageContext);
  });

  test('should add debug info', () => {
    stageContext.addLog('key', 'value');
    expect(stageContext.debug.logContext.key).toBe('value');
  });

  test('should set primitive value in Pipeline', () => {
    stageContext.setRoot('key', 'value');
    stageContext.commit();
    expect(stageContext.getValue([], 'key')).toBe('value');
    expect(stageContext.getFromRoot('key')).toBe('value');
    expect(globalStore.getValue('path', [], 'key')).toBe('value');
  });

  test('should update object in Pipeline', () => {
    stageContext.updateObject(['a', 'b'], 'key', 'value');
    stageContext.commit();
    expect(stageContext.getValue(['a', 'b'], 'key')).toBe('value');
    expect(globalStore.getValue('path', ['a', 'b'], 'key')).toBe('value');
  });

  test('should set array', () => {
    stageContext.setObject(['a'], 'key', [1, 2, 3]);
    stageContext.commit();
    stageContext.setObject(['a'], 'key', [4, 5]);
    stageContext.commit();
    expect(stageContext.getValue(['a'], 'key')).toEqual([4, 5]);
    expect(globalStore.getValue('path', ['a'], 'key')).toEqual([4, 5]);
  });

  test('should set object with undefined', () => {
    stageContext.setObject(['a'], 'key', ['data']);
    stageContext.commit();
    stageContext.setObject(['a'], 'key', undefined);
    stageContext.commit();
    expect(stageContext.getValue(['a'], 'key')).toBeUndefined();
  });

  test('should update object in Pipeline', () => {
    stageContext.updateObject(['a', 'b'], 'key1', { x: 1 });
    stageContext.updateObject(['a', 'b'], 'key1', { y: 2 });
    stageContext.commit();
    expect(stageContext.getValue(['a', 'b'], 'key1')).toStrictEqual({ x: 1, y: 2 });
  });

  test('should get entire object in Pipeline if key is not provided', () => {
    stageContext.updateObject(['a', 'b'], 'one', 1);
    stageContext.updateObject(['a', 'b'], 'two', 2);
    stageContext.commit();
    expect(stageContext.getValue(['a', 'b'])).toStrictEqual({ one: 1, two: 2 });
  });

  test('should get from pipeline object if key is preset in both global and pipeline (protected)', () => {
    stageContext.updateGlobalContext('sameKey', 1);
    stageContext.setRoot('sameKey', 2);
    stageContext.commit();
    expect(stageContext.getFromRoot('sameKey')).toStrictEqual(2);
  });

  test('should get from Global object if key is not in pipeline (protected', () => {
    stageContext.updateGlobalContext('globalKey', 1);
    stageContext.commit();
    expect(stageContext.getFromRoot('globalKey')).toStrictEqual(1);
  });

  test('should update global context', () => {
    stageContext.updateGlobalContext('key', 'value');
    stageContext.commit();
    expect(globalStore.getValue('', [], 'key')).toBe('value');
  });

  test('should get from global context', () => {
    globalStore.updateValue('', [], 'key', 'value');
    expect(stageContext.getFromGlobalContext('key')).toBe('value');
  });

  test('should return JSON representation', () => {
    stageContext.setRoot('json', 'test');
    stageContext.createNext(pipelineId, 'stage1');
    stageContext.createChild(pipelineId, 'child1id', 'child1');
    const json = stageContext.getSnapshot();
    expect(json).toEqual({
      id: 'path',
      name: 'name',
      logs: { json: 'test' },
      isFork: false,
      isDecider: false,
      errors: {},
      metrics: {},
      evals: {},
      next: {
        errors: {},
        metrics: {},
        evals: {},
        id: 'path',
        isFork: false,
        isDecider: false,
        logs: {},
        name: 'stage1',
      },
      children: [
        {
          errors: {},
          metrics: {},
          evals: {},
          id: 'path',
          logs: {},
          isFork: false,
          isDecider: false,
          name: 'child1',
        },
      ],
    });
  });

  describe('StageContext memory patch read/write', () => {
    const pipelineId = 'testPipeline';
    const globalStore = new GlobalStore();
    const context = new StageContext(pipelineId, 'testStage', globalStore);
    it('should read uncommitted patch values inside same stage', () => {
      context.setObject(['runtime'], 'someKey', 'intermediate');
      const result = context.getValue(['runtime'], 'someKey');
      expect(result).toBe('intermediate');
    });
    it('should read committed values from global context', () => {
      context.setObject(['runtime'], 'someKey', 'committed');
      context.commit();
      const result = context.getValue(['runtime'], 'someKey');
      expect(result).toBe('committed');
    });
    it('should fallback to global context if patch is missing', () => {
      globalStore.setValue(pipelineId, ['runtime'], 'existing', 'preloaded');
      const result = context.getValue(['runtime'], 'existing');
      expect(result).toBe('preloaded');
    });
  });
});

describe('StageContext.commit', () => {
  const realValue = 'SECRET';
  const patchPath = ['chat'];
  const patchKey = 'token';
  const flatPath = `chat${DELIM}token`;
  let stage: StageContext;
  let globalStore: GlobalStore;
  let execHistory: ExecutionHistory;
  // spies
  const applySpy = jest.fn();
  const recordSpy = jest.fn();
  beforeEach(() => {
    jest.clearAllMocks();
    globalStore = new GlobalStore();
    execHistory = new ExecutionHistory({});
    stage = new StageContext('', 'TestStage', globalStore);
    // inject mocks
    // 1) intercept GlobalStore.applyPatch
    (globalStore as any).applyPatch = applySpy;
    // 2) inject ExecutionHistory into StageContext
    (stage as any).executionHistory = { record: recordSpy };
    // 3) write value + mark it redacted
    const mem = stage.getWriteBuffer();
    mem.set([...patchPath, patchKey], realValue, true); // true -> redact
  });
  it('pushes real patch to GlobalStore and redacted copy to history', () => {
    stage.commit();
    // ------------- GlobalStore.applyPatch -----------------
    expect(applySpy).toHaveBeenCalledTimes(1);
    const [owReal, updReal] = applySpy.mock.calls[0];
    expect(_set({}, [...patchPath, patchKey], realValue)).toEqual(owReal);
    expect(updReal).toEqual({});
    // ------------- History bundle ---------------------------
    expect(recordSpy).toHaveBeenCalledTimes(1);
    const bundle = recordSpy.mock.calls[0][0];
    // stage name & redactedPaths array propagated
    expect(bundle.stage).toBe('TestStage');
    expect(bundle.redactedPaths).toEqual([flatPath]);
    // overwrite & updates hold REDACTED placeholder
    expect(bundle.overwrite.chat.token).toBe('REDACTED');
    // redactPatch helper was invoked twice (ow + updates) with correct set
    expect(redactPatch).toHaveBeenCalledTimes(2);
    const pathsPassed = (redactPatch as jest.Mock).mock.calls[0][1];
    expect(pathsPassed.has(flatPath)).toBe(true);
  });
});
