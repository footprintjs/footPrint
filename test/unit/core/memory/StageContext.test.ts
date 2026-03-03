/**
 * Unit tests for StageContext - Per-stage execution context
 *
 * BEHAVIOR: StageContext provides the read/write interface for stages to interact
 * with the scope system. It manages:
 * - Reading values from GlobalStore (with uncommitted patch overlay)
 * - Writing values via WriteBuffer (buffered until commit)
 * - Creating child/next contexts for branching and sequencing
 * - Debug logging and metadata collection
 * - Redaction of sensitive values in history
 *
 * WHY: StageContext is the primary interface stages use to access scope.
 * Understanding its behavior is essential for debugging scope-related issues.
 */

import _set from 'lodash.set';

import { GlobalStore } from '../../../../src/core/memory/GlobalStore';
import { StageContext } from '../../../../src/core/memory/StageContext';
import { ExecutionHistory } from '../../../../src/internal/history/ExecutionHistory';
import { DELIM } from '../../../../src/internal/memory/WriteBuffer';
import { redactPatch } from '../../../../src/internal/memory/utils';

jest.mock('../../../../src/internal/memory/utils', () => ({
  // use real implementation except redactPatch (spy later)
  ...jest.requireActual('../../../../src/internal/memory/utils'),
  redactPatch: jest.fn(jest.requireActual('../../../../src/internal/memory/utils').redactPatch),
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

describe('StageContext uncovered methods', () => {
  let globalStore: GlobalStore;
  let ctx: StageContext;

  beforeEach(() => {
    globalStore = new GlobalStore();
    ctx = new StageContext('pipe', 'stage', globalStore);
  });

  test('set() delegates to patch()', () => {
    ctx.set(['a'], 'key', 42);
    ctx.commit();
    expect(ctx.getValue(['a'], 'key')).toBe(42);
  });

  test('getPipelineId() returns pipelineId', () => {
    expect(ctx.getPipelineId()).toBe('pipe');
  });

  test('get() is an alias for getValue()', () => {
    ctx.setObject(['x'], 'y', 'val');
    ctx.commit();
    expect(ctx.get(['x'], 'y')).toBe('val');
  });

  test('getRoot() reads from globalStore by pipelineId', () => {
    ctx.setRoot('rk', 'rv');
    ctx.commit();
    expect(ctx.getRoot('rk')).toBe('rv');
  });

  test('getGlobal() reads from globalStore root namespace', () => {
    ctx.updateGlobalContext('gk', 'gv');
    ctx.commit();
    expect(ctx.getGlobal('gk')).toBe('gv');
  });

  test('getScope() returns the entire global state', () => {
    ctx.setRoot('k', 'v');
    ctx.commit();
    const scope = ctx.getScope();
    expect(scope).toBeDefined();
    expect(typeof scope).toBe('object');
  });

  test('setGlobal() with description adds log message', () => {
    ctx.setGlobal('gKey', 'gVal', 'set global desc');
    ctx.commit();
    expect(ctx.getGlobal('gKey')).toBe('gVal');
    expect(ctx.debug.logContext.message).toContain('set global desc');
  });

  test('setGlobal() without description does not add log', () => {
    ctx.setGlobal('gKey2', 'gVal2');
    expect(ctx.debug.logContext.message).toBeUndefined();
  });

  test('updateObject() with description adds log message', () => {
    ctx.updateObject(['a'], 'k', 'v', 'updated object');
    expect(ctx.debug.logContext.message).toContain('updated object');
  });

  test('setObject() with description adds tagged log message', () => {
    ctx.setObject(['a'], 'k', 'v', false, 'wrote data');
    expect(ctx.debug.logContext.message).toContain('[WRITE] wrote data');
  });

  test('setObject() with description starting with [ keeps original', () => {
    ctx.setObject(['a'], 'k', 'v', false, '[CUSTOM] tag');
    expect(ctx.debug.logContext.message).toContain('[CUSTOM] tag');
  });

  test('setObject() with shouldRedact logs REDACTED', () => {
    ctx.setObject(['a'], 'k', 'secret', true);
    expect(ctx.getValue(['a'], 'k')).toBe('secret');
  });

  test('getValue() with description adds read log', () => {
    ctx.setObject(['a'], 'k', 'data');
    ctx.commit();
    ctx.getValue(['a'], 'k', 'reading data');
    expect(ctx.debug.logContext.message).toContain('[READ] reading data');
  });

  test('appendToArray() appends to existing array', () => {
    ctx.setObject(['a'], 'arr', [1, 2]);
    ctx.commit();
    ctx.appendToArray(['a'], 'arr', [3, 4]);
    ctx.commit();
    expect(ctx.getValue(['a'], 'arr')).toEqual([1, 2, 3, 4]);
  });

  test('appendToArray() creates new array when no existing value', () => {
    ctx.appendToArray(['a'], 'newArr', [10, 20]);
    ctx.commit();
    expect(ctx.getValue(['a'], 'newArr')).toEqual([10, 20]);
  });

  test('appendToArray() with description adds log', () => {
    ctx.appendToArray(['a'], 'arr', [1], 'appending items');
    expect(ctx.debug.logContext.message).toContain('[WRITE] appending items');
  });

  test('mergeObject() shallow merges into existing object', () => {
    ctx.setObject(['a'], 'obj', { x: 1, y: 2 });
    ctx.commit();
    ctx.mergeObject(['a'], 'obj', { y: 99, z: 3 });
    ctx.commit();
    expect(ctx.getValue(['a'], 'obj')).toEqual({ x: 1, y: 99, z: 3 });
  });

  test('mergeObject() creates new object when no existing value', () => {
    ctx.mergeObject(['a'], 'newObj', { k: 'v' });
    ctx.commit();
    expect(ctx.getValue(['a'], 'newObj')).toEqual({ k: 'v' });
  });

  test('mergeObject() creates new object when existing value is non-object', () => {
    ctx.setObject(['a'], 'prim', 'hello');
    ctx.commit();
    ctx.mergeObject(['a'], 'prim', { k: 'v' });
    ctx.commit();
    expect(ctx.getValue(['a'], 'prim')).toEqual({ k: 'v' });
  });

  test('mergeObject() with description adds log', () => {
    ctx.mergeObject(['a'], 'obj', { k: 'v' }, 'merging keys');
    expect(ctx.debug.logContext.message).toContain('[WRITE] merging keys');
  });

  test('setMetric() sets metric value', () => {
    ctx.setMetric('latency', 150);
    expect(ctx.debug.metricContext.latency).toBe(150);
  });

  test('setEval() sets eval value', () => {
    ctx.setEval('score', 0.95);
    expect(ctx.debug.evalContext.score).toBe(0.95);
  });

  test('setLog() sets log value', () => {
    ctx.setLog('info', 'something');
    expect(ctx.debug.logContext.info).toBe('something');
  });

  test('setAsDecider() sets isDecider and returns self', () => {
    const result = ctx.setAsDecider();
    expect(ctx.isDecider).toBe(true);
    expect(result).toBe(ctx);
  });

  test('setAsFork() sets isFork and returns self', () => {
    const result = ctx.setAsFork();
    expect(ctx.isFork).toBe(true);
    expect(result).toBe(ctx);
  });

  test('createDecider() creates next context with isDecider=true', () => {
    const decider = ctx.createDecider('p', 'deciderStage');
    expect(decider.isDecider).toBe(true);
  });

  test('addFlowDebugMessage() adds flow message to debug metadata', () => {
    ctx.addFlowDebugMessage('next', 'Moving forward', { targetStage: 'stage2' });
    expect(ctx.debug.flowMessages.length).toBe(1);
    expect(ctx.debug.flowMessages[0].type).toBe('next');
    expect(ctx.debug.flowMessages[0].description).toBe('Moving forward');
  });

  test('getStageId() with empty pipelineId returns stageName', () => {
    const rootCtx = new StageContext('', 'myStage', globalStore);
    expect(rootCtx.getStageId()).toBe('myStage');
  });

  test('getStageId() with pipelineId returns pipelineId.stageName', () => {
    expect(ctx.getStageId()).toBe('pipe.stage');
  });

  test('getSnapshot() includes flowMessages when present', () => {
    ctx.addFlowDebugMessage('fork', 'Forking');
    const snap = ctx.getSnapshot();
    expect(snap.flowMessages).toBeDefined();
    expect(snap.flowMessages!.length).toBe(1);
  });

  test('createNext() returns existing next on second call', () => {
    const first = ctx.createNext('p', 'next1');
    const second = ctx.createNext('p', 'next2');
    expect(first).toBe(second);
    expect(first.stageName).toBe('next1');
  });

  test('context without pipelineId uses flat path', () => {
    const rootCtx = new StageContext('', 'rootStage', globalStore);
    rootCtx.setObject(['a'], 'k', 'v');
    rootCtx.commit();
    expect(globalStore.getValue('', ['a'], 'k')).toBe('v');
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
