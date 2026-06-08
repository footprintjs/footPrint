/**
 * Zod-subpath contract — zod is an OPTIONAL peer; the core must never import it.
 *
 * Background: the `footprintjs` and `footprintjs/advanced` barrels used to
 * re-export the zod-based scope helpers, which forced every consumer to load
 * zod eagerly (crashing with ERR_MODULE_NOT_FOUND if zod wasn't installed).
 * The helpers now live behind the opt-in `footprintjs/zod` entry.
 *
 * These tests lock that contract so zod can never sneak back onto the core
 * barrels. (A separate runtime check — loading the built core with zod absent —
 * is exercised during release; this is the source-level guard.)
 */
import { describe, expect, it } from 'vitest';

import * as advanced from '../../src/advanced.js';
import * as main from '../../src/index.js';
import * as zodEntry from '../../src/zod.js';

const ZOD_SYMBOLS = [
  'defineScopeFromZod',
  'createScopeProxyFromZod',
  'defineScopeSchema',
  'isScopeSchema',
  'ZodScopeResolver',
] as const;

describe('zod-subpath contract', () => {
  it('the core barrel does NOT export the zod helpers', () => {
    for (const sym of ZOD_SYMBOLS) {
      expect((main as Record<string, unknown>)[sym], `footprintjs must not export ${sym}`).toBeUndefined();
    }
  });

  it('the advanced barrel does NOT export the zod helpers', () => {
    for (const sym of ZOD_SYMBOLS) {
      expect((advanced as Record<string, unknown>)[sym], `footprintjs/advanced must not export ${sym}`).toBeUndefined();
    }
  });

  it('the footprintjs/zod entry exports all the zod helpers', () => {
    for (const sym of ZOD_SYMBOLS) {
      // ZodScopeResolver is an object; the rest are factory functions — assert
      // each is actually exported (defined) rather than over-specifying the kind.
      expect((zodEntry as Record<string, unknown>)[sym], `footprintjs/zod must export ${sym}`).toBeDefined();
    }
  });
});
