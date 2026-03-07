import { attachBaseStateCompat, attachScopeMethods } from '../../../../src/lib/scope/providers/baseStateCompatible';
import type { StageContextLike } from '../../../../src/lib/scope/providers/types';

function makeCtx(overrides: Partial<StageContextLike> = {}): StageContextLike {
  return {
    getValue: jest.fn().mockReturnValue('mock-value'),
    setObject: jest.fn(),
    updateObject: jest.fn(),
    addLog: jest.fn(),
    addError: jest.fn(),
    getFromGlobalContext: jest.fn().mockReturnValue('initial-val'),
    setRoot: jest.fn(),
    pipelineId: 'pipe-1',
    runId: 'run-1',
    ...overrides,
  };
}

describe('attachScopeMethods', () => {
  it('attaches all scope methods onto target', () => {
    const target = { existing: true };
    const ctx = makeCtx();
    const result = attachScopeMethods(target, ctx, 'stage1');

    expect(result.existing).toBe(true);
    expect(typeof result.addDebugInfo).toBe('function');
    expect(typeof result.addDebugMessage).toBe('function');
    expect(typeof result.addErrorInfo).toBe('function');
    expect(typeof result.addMetric).toBe('function');
    expect(typeof result.addEval).toBe('function');
    expect(typeof result.getInitialValueFor).toBe('function');
    expect(typeof result.getValue).toBe('function');
    expect(typeof result.setValue).toBe('function');
    expect(typeof result.updateValue).toBe('function');
    expect(typeof result.setObjectInRoot).toBe('function');
    expect(typeof result.getReadOnlyValues).toBe('function');
    expect(typeof result.getPipelineId).toBe('function');
  });

  it('addDebugInfo delegates to ctx.addLog', () => {
    const ctx = makeCtx();
    const result = attachScopeMethods({}, ctx, 'stage1');
    result.addDebugInfo('key1', 'val1');
    expect(ctx.addLog).toHaveBeenCalledWith('key1', 'val1');
  });

  it('addDebugMessage delegates to ctx.addLog with messages key', () => {
    const ctx = makeCtx();
    const result = attachScopeMethods({}, ctx, 'stage1');
    result.addDebugMessage('hello');
    expect(ctx.addLog).toHaveBeenCalledWith('messages', ['hello']);
  });

  it('addErrorInfo delegates to ctx.addError', () => {
    const ctx = makeCtx();
    const result = attachScopeMethods({}, ctx, 'stage1');
    result.addErrorInfo('err-key', 'err-val');
    expect(ctx.addError).toHaveBeenCalledWith('err-key', 'err-val');
  });

  it('addMetric delegates to ctx.addLog with metric prefix', () => {
    const ctx = makeCtx();
    const result = attachScopeMethods({}, ctx, 'stage1');
    result.addMetric('latency', 42);
    expect(ctx.addLog).toHaveBeenCalledWith('metric:latency', 42);
  });

  it('addEval delegates to ctx.addLog with eval prefix', () => {
    const ctx = makeCtx();
    const result = attachScopeMethods({}, ctx, 'stage1');
    result.addEval('accuracy', 0.95);
    expect(ctx.addLog).toHaveBeenCalledWith('eval:accuracy', 0.95);
  });

  it('getInitialValueFor delegates to ctx.getFromGlobalContext', () => {
    const ctx = makeCtx();
    const result = attachScopeMethods({}, ctx, 'stage1');
    expect(result.getInitialValueFor('someKey')).toBe('initial-val');
    expect(ctx.getFromGlobalContext).toHaveBeenCalledWith('someKey');
  });

  it('getValue delegates to ctx.getValue with empty path', () => {
    const ctx = makeCtx();
    const result = attachScopeMethods({}, ctx, 'stage1');
    expect(result.getValue('myKey')).toBe('mock-value');
    expect(ctx.getValue).toHaveBeenCalledWith([], 'myKey');
  });

  it('setValue delegates to ctx.setObject with empty path', () => {
    const ctx = makeCtx();
    const result = attachScopeMethods({}, ctx, 'stage1');
    result.setValue('key', 'value', true, 'desc');
    expect(ctx.setObject).toHaveBeenCalledWith([], 'key', 'value', true, 'desc');
  });

  it('setValue defaults shouldRedact to false', () => {
    const ctx = makeCtx();
    const result = attachScopeMethods({}, ctx, 'stage1');
    result.setValue('key', 'value');
    expect(ctx.setObject).toHaveBeenCalledWith([], 'key', 'value', false, undefined);
  });

  it('updateValue delegates to ctx.updateObject with empty path', () => {
    const ctx = makeCtx();
    const result = attachScopeMethods({}, ctx, 'stage1');
    result.updateValue('key', 'value', 'desc');
    expect(ctx.updateObject).toHaveBeenCalledWith([], 'key', 'value', 'desc');
  });

  it('setObjectInRoot delegates to ctx.setRoot', () => {
    const ctx = makeCtx();
    const result = attachScopeMethods({}, ctx, 'stage1');
    result.setObjectInRoot('rootKey', { data: 1 });
    expect(ctx.setRoot).toHaveBeenCalledWith('rootKey', { data: 1 });
  });

  it('getReadOnlyValues returns the readOnly argument', () => {
    const readOnly = { frozen: true };
    const result = attachScopeMethods({}, makeCtx(), 'stage1', readOnly);
    expect(result.getReadOnlyValues()).toBe(readOnly);
  });

  it('getReadOnlyValues returns undefined when no readOnly given', () => {
    const result = attachScopeMethods({}, makeCtx(), 'stage1');
    expect(result.getReadOnlyValues()).toBeUndefined();
  });

  it('getPipelineId returns pipelineId when available', () => {
    const ctx = makeCtx({ pipelineId: 'pipe-1', runId: 'run-1' });
    const result = attachScopeMethods({}, ctx, 'stage1');
    expect(result.getPipelineId()).toBe('pipe-1');
  });

  it('getPipelineId falls back to runId when pipelineId is undefined', () => {
    const ctx = makeCtx({ pipelineId: undefined, runId: 'run-fallback' });
    const result = attachScopeMethods({}, ctx, 'stage1');
    expect(result.getPipelineId()).toBe('run-fallback');
  });

  it('works when optional ctx methods are undefined', () => {
    const ctx: StageContextLike = {
      getValue: jest.fn(),
      setObject: jest.fn(),
      updateObject: jest.fn(),
      // no addLog, addError, getFromGlobalContext, setRoot
    };
    const result = attachScopeMethods({}, ctx, 'stage1');

    // These should not throw even when optional methods are missing
    result.addDebugInfo('k', 'v');
    result.addDebugMessage('msg');
    result.addErrorInfo('k', 'v');
    result.addMetric('m', 1);
    result.addEval('e', 1);
    expect(result.getInitialValueFor('k')).toBeUndefined();
    result.setObjectInRoot('k', 'v');
  });
});

describe('attachBaseStateCompat (deprecated alias)', () => {
  it('is the same function as attachScopeMethods', () => {
    expect(attachBaseStateCompat).toBe(attachScopeMethods);
  });
});
