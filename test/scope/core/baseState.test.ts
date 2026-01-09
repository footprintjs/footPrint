import { BaseState } from '../../../src/scope/core/BaseState';

// We don't need the real StageContext; a plain object with the right methods works.
const makeCtx = () => {
  const calls: Record<string, any[]> = {};
  const record = (name: string, args: any[]) => (calls[name] = args);

  const ctx = {
    getValue: jest.fn().mockImplementation((path: string[], key?: string) => {
      record('getValue', [path, key]);
      return 42;
    }),
    setObject: jest.fn().mockImplementation((path: string[], key: string, value: unknown, shouldRedact?: boolean, description?: string) => {
      record('setObject', [path, key, value, shouldRedact, description]);
    }),
    updateObject: jest.fn().mockImplementation((path: string[], key: string, value: unknown, description?: string) => {
      record('updateObject', [path, key, value, description]);
    }),
    getFromGlobalContext: jest.fn().mockImplementation((key: string) => {
      record('getFromGlobalContext', [key]);
      return 'root-val';
    }),
    setRoot: jest.fn().mockImplementation((key: string, value: unknown) => {
      record('setRoot', [key, value]);
    }),
    pipelineId: 'pipe-777',
  } as any;

  return { ctx, calls };
};

describe('BaseState', () => {
  test('forwards core getters/setters to the underlying context', () => {
    const { ctx, calls } = makeCtx();
    const state = new BaseState(ctx, 'StageK', { ro: true });

    // getValue
    const v = state.getValue(['a', 'b'], 'c');
    expect(v).toBe(42);
    expect(ctx.getValue).toHaveBeenCalledWith(['a', 'b'], 'c');
    expect(calls.getValue).toEqual([['a', 'b'], 'c']);

    // setObject (with shouldRedact)
    state.setObject(['x'], 'y', 9, true);
    expect(ctx.setObject).toHaveBeenCalledWith(['x'], 'y', 9, true, undefined);
    expect(calls.setObject).toEqual([['x'], 'y', 9, true, undefined]);

    // updateObject
    state.updateObject(['m'], 'n', { p: 1 });
    expect(ctx.updateObject).toHaveBeenCalledWith(['m'], 'n', { p: 1 }, undefined);
    expect(calls.updateObject).toEqual([['m'], 'n', { p: 1 }, undefined]);

    // setObjectInRoot
    state.setObjectInRoot('rootKey', 'rootVal');
    expect(ctx.setRoot).toHaveBeenCalledWith('rootKey', 'rootVal');
    expect(calls.setRoot).toEqual(['rootKey', 'rootVal']);

    // getInitialValueFor
    const init = state.getInitialValueFor('first');
    expect(init).toBe('root-val');
    expect(ctx.getFromGlobalContext).toHaveBeenCalledWith('first');
    expect(calls.getFromGlobalContext).toEqual(['first']);

    // read-only + pipeline id
    expect(state.getReadOnlyValues()).toEqual({ ro: true });
    expect(state.getPipelineId()).toBe('pipe-777');
  });
});
