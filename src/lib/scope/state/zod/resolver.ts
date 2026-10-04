/**
 * ZodScopeResolver — ProviderResolver for Zod-branded scope schemas
 */

import type { ProviderResolver, ScopeProvider } from '../../providers/types.js';
import { type DefineScopeOptions, defineScopeFromZod } from './defineScopeFromZod.js';
import { isScopeSchema } from './schema/builder.js';
import type { ZodSchema } from './utils/validateHelper.js';

export const ZodScopeResolver: ProviderResolver = {
  name: 'zod',
  canHandle(input: unknown): boolean {
    return isScopeSchema(input);
  },
  makeProvider(input: unknown, options?: { zod?: DefineScopeOptions }): ScopeProvider<any> {
    return { kind: 'zod', create: defineScopeFromZod(input as ZodSchema, options?.zod) };
  },
};
