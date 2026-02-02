import { BaseState } from '../../../../src/scope/BaseState';
import { __clearScopeResolversForTests } from '../../../../src/scope/providers/registry';
import { registerScopeResolver, toScopeFactory } from '../../../../src/scope/providers/resolve';
import type { ScopeFactory, StageContextLike } from '../../../../src/scope/providers/types';

const ctx: StageContextLike = {
  getValue: () => undefined,
  setObject: () => {},
  updateObject: () => {},
  addLog: () => {},
  addError: () => {},
  getFromGlobalContext: () => undefined,
  setRoot: () => {},
  pipelineId: 'pipe-abc',
};

afterEach(() => {
  __clearScopeResolversForTests();
});

describe('toScopeFactory', () => {
  test('normalizes a factory function', () => {
    const factory: ScopeFactory<any> = (c, stage, ro) => ({
      k: 'factoryScope',
      stage,
      ro,
      sameCtx: c === ctx,
    });

    const normalized = toScopeFactory(factory);
    const scope = normalized(ctx, 'StageA', { readonly: true }) as any;

    expect(scope).toMatchObject({
      k: 'factoryScope',
      stage: 'StageA',
      ro: { readonly: true },
      sameCtx: true,
    });
  });

  test('normalizes a class that extends BaseState', () => {
    class MyScope extends BaseState {
      marker = 'ok';
      constructor(c: any, s: string, ro?: unknown) {
        super(c, s, ro);
      }
    }

    const normalized = toScopeFactory<MyScope>(MyScope);
    const scope = normalized(ctx as any, 'StageB', undefined);

    expect(scope).toBeInstanceOf(MyScope);
    expect((scope as any).marker).toBe('ok');
  });

  test('uses a custom resolver and passes options through', () => {
    const TOKEN = Symbol('custom-input');
    let receivedOptions: unknown | undefined;

    registerScopeResolver({
      name: 'custom',
      canHandle: (input) => input === TOKEN,
      makeProvider: (_input, options) => {
        receivedOptions = options;
        return {
          kind: 'custom',
          create: (_c, stage) => ({ from: 'custom', stage }),
        };
      },
    });

    const normalized = toScopeFactory<any>(TOKEN, { zod: { strict: 'deny' } });
    const scope = normalized(ctx, 'StageC', undefined) as any;

    expect(scope).toEqual({ from: 'custom', stage: 'StageC' });
    expect(receivedOptions).toEqual({ zod: { strict: 'deny' } });
  });
});
