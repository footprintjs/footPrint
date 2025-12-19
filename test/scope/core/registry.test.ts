import { resolveScopeProvider, registerScopeResolver, __clearScopeResolversForTests } from '../../../src/scope/core/registry';
import type { StageContextLike, ScopeFactory } from '../../../src/scope/core/types';
import { BaseState } from '../../../src/scope/core/BaseState';

const ctx: StageContextLike = {
    getValue: () => undefined,
    setObject: () => {},
    updateObject: () => {},
    addDebugInfo: () => {},
    addErrorInfo: () => {},
    getFromGlobalContext: () => undefined,
    setRoot: () => {},
    pipelineId: 'pipe-xyz',
};

afterEach(() => {
    __clearScopeResolversForTests();
});

describe('registry', () => {
    test('fallback resolves a simple factory function', () => {
        const factory: ScopeFactory<any> = (c, stage, ro) => ({
            kind: 'factoryScope',
            stage,
            ro,
            sameCtx: c === ctx,
        });

        const provider = resolveScopeProvider(factory);
        expect(provider.kind).toBe('factory');

        const scope = provider.create(ctx, 'StageA', { ro: true }) as any;
        expect(scope).toMatchObject({ kind: 'factoryScope', stage: 'StageA', ro: { ro: true }, sameCtx: true });
    });

    test('fallback resolves a class that extends BaseState', () => {
        class MyScope extends BaseState {
            marker = 'ok';
            constructor(c: any, s: string, ro?: unknown) { super(c, s, ro); }
        }

        const provider = resolveScopeProvider(MyScope);
        expect(provider.kind).toBe('class');

        const scope = provider.create(ctx as any, 'StageB', undefined) as any;
        expect(scope).toBeInstanceOf(MyScope);
        expect(scope.marker).toBe('ok');
    });

    test('fallback rejects a class that does NOT extend BaseState', () => {
        class NotASubclass { constructor(_: any, __: string, ___?: unknown) {} }

        expect(() => resolveScopeProvider(NotASubclass)).toThrow(
            /Unsupported scope input|class extending BaseState/i
        );
    });

    test('custom resolver takes precedence over fallbacks', () => {
        const TOKEN = Symbol('custom-input');

        registerScopeResolver({
            name: 'custom',
            canHandle: input => input === TOKEN,
            makeProvider: () => ({
                kind: 'custom',
                create: (_c, stage) => ({ from: 'custom', stage }),
            }),
        });

        const provider = resolveScopeProvider(TOKEN);
        expect(provider.kind).toBe('custom');

        const scope = provider.create(ctx, 'StageC', undefined) as any;
        expect(scope).toEqual({ from: 'custom', stage: 'StageC' });
    });
});
