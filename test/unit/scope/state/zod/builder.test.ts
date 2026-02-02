import { z } from 'zod';

import { defineScopeSchema, isScopeSchema } from '../../../../../src/scope/state/zod/schema/builder';

describe('zod/builder', () => {
  test('defineScopeSchema returns a branded strict object; isScopeSchema detects it', () => {
    const Schema = defineScopeSchema({
      chat: z.object({ prompt: z.string().optional() }).default({}),
      metrics: z.object({ tokens: z.number().int().optional() }).default({}),
    });

    // guard works
    expect(isScopeSchema(Schema)).toBe(true);
    expect(isScopeSchema(z.object({}))).toBe(false);

    // strict( ) behavior: extra keys should fail validation
    const ok = Schema.safeParse({ chat: {}, metrics: {} });
    expect(ok.success).toBe(true);

    const bad = Schema.safeParse({ chat: {}, metrics: {}, extra: 1 });
    expect(bad.success).toBe(false);
  });
});
