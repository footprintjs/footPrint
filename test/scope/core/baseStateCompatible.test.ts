import { attachBaseStateCompat } from '../../../src/scope/core/baseStateCompatible';
import type { StageContextLike } from '../../../src/scope/core/types';

describe('baseStateCompatible', () => {
  const makeCtx = () => {
    const ctx: any = {
      // core
      getValue: jest.fn().mockImplementation((_p: string[], _k?: string) => 7),
      setObject: jest.fn(), // compat calls with (path, key, value, shouldRedact?)
      updateObject: jest.fn(),

      // diagnostics
      addDebugInfo: jest.fn(),
      addErrorInfo: jest.fn(),

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
    expect(ctx.addDebugInfo).toHaveBeenCalledWith('k', 123);

    scope.addDebugMessage('hello');
    expect(ctx.addDebugInfo).toHaveBeenCalledWith('messages', ['hello']);

    scope.addErrorInfo('err', 'boom');
    expect(ctx.addErrorInfo).toHaveBeenCalledWith('err', 'boom');

    scope.addMetric('t', 5);
    expect(ctx.addDebugInfo).toHaveBeenCalledWith('metric:t', 5);

    scope.addEval('score', 0.98);
    expect(ctx.addDebugInfo).toHaveBeenCalledWith('eval:score', 0.98);

    // ---- getters / setters
    const v = scope.getValue(['a'], 'b');
    expect(v).toBe(7);
    expect(ctx.getValue).toHaveBeenCalledWith(['a'], 'b');

    scope.setObject(['x'], 'y', 3, true);
    expect(ctx.setObject).toHaveBeenCalledWith(['x'], 'y', 3, true);

    scope.updateObject(['m'], 'n', { p: 1 });
    expect(ctx.updateObject).toHaveBeenCalledWith(['m'], 'n', { p: 1 });

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
