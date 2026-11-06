/**
 * Opt-in zod scope helpers. zod is an optional peer.
 *
 * The core (`footprintjs`, `footprintjs/advanced`) never imports zod, so a plain
 * install needs no zod and never crashes. The zod-based scope helpers live here.
 * Import them from `'footprintjs/zod'` and add `zod` to your own dependencies:
 *
 *   import { defineScopeFromZod, defineScopeSchema } from 'footprintjs/zod';
 *
 * (`ZodScopeResolver` is exported here too if you register it yourself via
 * `registerScopeResolver` from `footprintjs/advanced`.)
 *
 * @module footprintjs/zod
 */

export type { DefineScopeOptions } from './lib/scope/state/zod/defineScopeFromZod.js';
export { defineScopeFromZod } from './lib/scope/state/zod/defineScopeFromZod.js';
export { ZodScopeResolver } from './lib/scope/state/zod/resolver.js';
export { defineScopeSchema, isScopeSchema } from './lib/scope/state/zod/schema/builder.js';
export { createScopeProxyFromZod } from './lib/scope/state/zod/scopeFactory.js';
