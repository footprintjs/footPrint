import { attachBaseStateCompat } from '../../../../src/scope/providers/baseStateCompatible';
import type { StageContextLike } from '../../../../src/scope/providers/types';

describe('baseStateCompatible', () => {
  const makeCtx = () => {
    const ctx: any = {
      // core
      getValue: jest.fn().mockImplementation((_p: string[], _k?: string) => 7),
      setObject: jest.fn(), // compat calls with (path, key, value, shouldRedact?)
      updateObject: jest.fn(),

      // diagnostics (new method names)
      addLog: jest.fn(),
      addError: jest.fn(),

      // helpers
      getFromGlobalContext: jest.fn().mockReturnValue('rootVal'),
      setRoot: jest.fn(),

      // metadata
      pipelineId: 'pipe-42',
    } as StageContextLike;

    return ctx;
  };

  test('attaches BaseState-like methods and forwards calls', () => {
    const ctx = makeCtx();
    const target = {}; // any scope-like object (e.g., proxy)
    const scope = attachBaseStateCompat(target, ctx, 'StageZ', { ro: true });

    // ---- debug helpers
    scope.addDebugInfo('k', 123);
    expect(ctx.addLog).toHaveBeenCalledWith('k', 123);

    scope.addDebugMessage('hello');
    expect(ctx.addLog).toHaveBeenCalledWith('messages', ['hello']);

    scope.addErrorInfo('err', 'boom');
    expect(ctx.addError).toHaveBeenCalledWith('err', 'boom');

    scope.addMetric('t', 5);
    expect(ctx.addLog).toHaveBeenCalledWith('metric:t', 5);

    scope.addEval('score', 0.98);
    expect(ctx.addLog).toHaveBeenCalledWith('eval:score', 0.98);

    // ---- getters / setters
    const v = scope.getValue(['a'], 'b');
    expect(v).toBe(7);
    expect(ctx.getValue).toHaveBeenCalledWith(['a'], 'b');

    scope.setValue(['x'], 'y', 3, true);
    expect(ctx.setObject).toHaveBeenCalledWith(['x'], 'y', 3, true, undefined);

    scope.updateValue(['m'], 'n', { p: 1 });
    expect(ctx.updateObject).toHaveBeenCalledWith(['m'], 'n', { p: 1 }, undefined);

    scope.setObjectInRoot('rootKey', 'rootVal');
    expect(ctx.setRoot).toHaveBeenCalledWith('rootKey', 'rootVal');

    // ---- read-only + metadata
    expect(scope.getReadOnlyValues()).toEqual({ ro: true });
    expect(scope.getPipelineId()).toBe('pipe-42');

    // ---- initial value
    const init = scope.getInitialValueFor('someKey');
    expect(init).toBe('rootVal');
    expect(ctx.getFromGlobalContext).toHaveBeenCalledWith('someKey');
  });
});
