import { vi } from 'vitest';
import { z } from 'zod';

import type { StageContextLike } from '../../../../src/lib/scope/providers/types';
// We need to import the resolver and the registration mechanism
// The ZodScopeResolver is exported from the resolver module
import { ZodScopeResolver } from '../../../../src/lib/scope/state/zod/resolver';
import { defineScopeSchema, isScopeSchema } from '../../../../src/lib/scope/state/zod/schema/builder';

function makeCtx(overrides: Partial<StageContextLike> = {}): StageContextLike {
  return {
    getValue: vi.fn().mockReturnValue(undefined),
    setObject: vi.fn(),
    updateObject: vi.fn(),
    addLog: vi.fn(),
    addError: vi.fn(),
    getFromGlobalContext: vi.fn(),
    setRoot: vi.fn(),
    pipelineId: 'pipe-1',
    runId: 'run-1',
    ...overrides,
  };
}

describe('ZodScopeResolver', () => {
  const schema = defineScopeSchema({
    name: z.string(),
    count: z.number(),
  });

  describe('canHandle', () => {
    it('returns true for branded scope schemas', () => {
      expect(ZodScopeResolver.canHandle(schema)).toBe(true);
    });

    it('returns false for plain zod schemas', () => {
      expect(ZodScopeResolver.canHandle(z.object({ x: z.string() }))).toBe(false);
    });

    it('returns false for non-schema values', () => {
      expect(ZodScopeResolver.canHandle(42)).toBe(false);
      expect(ZodScopeResolver.canHandle(null)).toBe(false);
      expect(ZodScopeResolver.canHandle('hello')).toBe(false);
    });
  });

  describe('makeProvider', () => {
    it('returns a provider with kind "zod"', () => {
      const provider = ZodScopeResolver.makeProvider(schema);
      expect(provider.kind).toBe('zod');
    });

    it('creates a scope proxy via provider.create', () => {
      const provider = ZodScopeResolver.makeProvider(schema);
      const ctx = makeCtx();
      const scope = provider.create(ctx, 'testStage');

      // The scope should have proxy fields from the schema
      expect(scope).toBeDefined();
      // It should also have compat methods from attachScopeMethods
      expect(typeof scope.addDebugInfo).toBe('function');
      expect(typeof scope.getPipelineId).toBe('function');
    });

    it('passes strict mode from options', () => {
      const provider = ZodScopeResolver.makeProvider(schema, { zod: { strict: 'deny' } });
      const ctx = makeCtx();
      const scope = provider.create(ctx, 'testStage');
      // Setting an invalid value should throw in deny mode
      expect(() => scope.name.set(123)).toThrow();
    });

    it('defaults strict mode to warn', () => {
      const provider = ZodScopeResolver.makeProvider(schema);
      const ctx = makeCtx();
      const scope = provider.create(ctx, 'testStage');
      // Setting an invalid value in warn mode should not throw
      scope.name.set(123);
      expect(ctx.addError).toHaveBeenCalled();
    });

    it('passes readOnly to compat layer', () => {
      const provider = ZodScopeResolver.makeProvider(schema);
      const ctx = makeCtx();
      const readOnly = { frozen: true };
      const scope = provider.create(ctx, 'testStage', readOnly);
      expect(scope.getArgs()).toEqual(readOnly);
    });
  });

  it('has name "zod"', () => {
    expect(ZodScopeResolver.name).toBe('zod');
  });
});
