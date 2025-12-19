import { makeFactoryProvider, makeClassProvider } from '../../../src/scope/core/providers';
import type { StageContextLike } from '../../../src/scope/core/types';

const ctx: StageContextLike = {
    getValue: () => undefined,
    setObject: () => {},
    updateObject: () => {},
    addDebugInfo: () => {},
    addErrorInfo: () => {},
    getFromGlobalContext: () => undefined,
    setRoot: () => {},
    pipelineId: 'pipe-123',
};

describe('providers', () => {
    test('makeFactoryProvider wraps a factory and creates a scope', () => {
        const factory = (c: StageContextLike, stage: string, ro?: unknown) => ({
            kind: 'factoryScope',
            stage,
            ro,
            ctxRefSame: c === ctx,
        });

        const p = makeFactoryProvider(factory);
        expect(p.kind).toBe('factory');

        const scope = p.create(ctx, 'StageA', { readonly: true }) as any;
        expect(scope.kind).toBe('factoryScope');
        expect(scope.stage).toBe('StageA');
        expect(scope.ro).toEqual({ readonly: true });
        expect(scope.ctxRefSame).toBe(true);
    });

    test('makeClassProvider wraps a class and instantiates it with args', () => {
        class MyScope {
            public gotCtx: boolean;
            public stage: string;
            public ro: unknown;
            constructor(c: StageContextLike, s: string, ro?: unknown) {
                this.gotCtx = c === ctx;
                this.stage = s;
                this.ro = ro;
            }
        }

        const p = makeClassProvider(MyScope);
        expect(p.kind).toBe('class');

        const scope = p.create(ctx, 'StageB', { x: 1 }) as any;
        expect(scope).toBeInstanceOf(MyScope);
        expect(scope.gotCtx).toBe(true);
        expect(scope.stage).toBe('StageB');
        expect(scope.ro).toEqual({ x: 1 });
    });
});
