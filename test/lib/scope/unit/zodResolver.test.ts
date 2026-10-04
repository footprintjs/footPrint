import { z } from 'zod';

import { SharedMemory } from '../../../../src/lib/memory/SharedMemory.js';
import { StageContext } from '../../../../src/lib/memory/StageContext.js';
import { ZodScopeResolver } from '../../../../src/lib/scope/state/zod/resolver.js';
import { defineScopeSchema } from '../../../../src/lib/scope/state/zod/schema/builder.js';

function makeCtx(): StageContext {
  return new StageContext('zod-resolver', 'testStage', 'test-stage', new SharedMemory());
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
      // Convenience methods share the facade used by schema-backed fields.
      expect(typeof scope.addDebugInfo).toBe('function');
      expect(typeof scope.getPipelineId).toBe('function');
      scope.count.set(3);
      expect(scope.count.get()).toBe(3);
      expect(ctx.getValue([], 'count')).toBe(3);
    });

    it('passes strict mode from options', () => {
      const provider = ZodScopeResolver.makeProvider(schema, { zod: { strict: 'deny' } });
      const ctx = makeCtx();
      const scope = provider.create(ctx, 'testStage');
      // Setting an invalid value should throw in deny mode
      scope.name.set('Alice');
      expect(() => scope.name.set(123)).toThrow(z.ZodError);
      expect(ctx.getValue([], 'name')).toBe('Alice');
    });

    it('defaults strict mode to warn', () => {
      const provider = ZodScopeResolver.makeProvider(schema);
      const ctx = makeCtx();
      const scope = provider.create(ctx, 'testStage');
      // Setting an invalid value in warn mode should not throw
      scope.name.set('Alice');
      scope.name.set(123);
      expect(ctx.debug.errorContext.schema).toBeDefined();
      expect(ctx.getValue([], 'name')).toBe('Alice');
    });

    it('passes readOnly through the facade', () => {
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
