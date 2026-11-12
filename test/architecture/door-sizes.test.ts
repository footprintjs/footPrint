/**
 * How much code each public door pulls in, measured on the BUILT package.
 *
 * WHY: "small core, lazy loading" is only real if a bundler can leave code out. This test bundles each
 * door of `dist/esm` with esbuild (foottrace, zod and Node built-ins external, minified) and holds every
 * size under a budget, so the numbers are repeatable and nothing grows back unnoticed. It also bundles a
 * minimal app (build one chart, run it): today that keeps almost all of the main door, because the
 * builder and the executor are classes whose methods reach every feature. A budget is today's measured
 * size plus about 3%. Lower a budget whenever a change makes a door smaller; never raise one without
 * saying why in the commit.
 *
 * Runs only from `npm run test:examples` (vitest.built-package-tests.ts), which builds first.
 */
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const EXTERNAL = ['foottrace', 'foottrace/*', 'zod', 'node:*', 'worker_threads', 'fs', 'path', 'crypto'];

/**
 * Minified bytes, measured 2026-11-10 at v11.2.0 plus the audit fixes, with about 3% headroom then.
 *
 * 2026-11-11: the three doors that carry the engine (index, advanced, detach) and the minimal app each
 * moved up by 4,000. That is what recording a subflow mount's reads costs: the view a mapper is handed
 * (`engine/handlers/mapperScope.ts`, 2,293 bytes) and the mount's read doors on `StageContext`, measured
 * at 3,907 to 3,995 more bytes per door. In bytes the headroom is what main had left that day, which
 * was no longer 3%: between 1.3 and 2.2% on these four. The other doors did not move.
 *
 * 2026-11-12: `advanced` moved up by 1,500 and `zod` by 600. That is what a redaction leak fix costs
 * (a mark ends only where its value lives, and only when the delete has landed: `memory/markPlaces.ts`,
 * `RedactionRule` · `landed` / `unmark`, `StageContext` · `endMarksOfLandedDeletes`, the fan-out's
 * hold): measured at 1,418 more bytes on `index`, `advanced` and the minimal app, 1,465 on `detach` and
 * 575 on `zod`. `advanced` had 73 bytes of room left on main and `zod` 503, less than the fix needs, so
 * those two budgets follow; the others still fit. That leaves `advanced` 155 bytes of room: the next change to
 * that door has to make room or raise it again, with its reason.
 *
 * 2026-11-12, later: the three doors that carry the engine (index, advanced, detach) and the minimal app
 * each moved up by 9,300. That is what following a hidden object costs (`memory/selectedObjects.ts` and
 * `memory/hiddenObjectTrail.ts`: a stage remembers what it read under a hidden name, and every value it
 * writes is searched for it, when it is written and once more at commit; the second search has to tell
 * what was put in after the write from what was there, which is about 3,000 of the bytes; what a stage
 * keeps of each write and what it takes from its input are looked at too, about 1,300): measured at
 * 9,168 more bytes on `index` and the minimal app, 9,175 on `advanced`, 9,234 on `detach`, 128 on `zod`
 * and 22 on `recorders` (which both still fit). `advanced` has 280 bytes of room after it.
 */
const BUDGET_BYTES: Readonly<Record<string, number>> = {
  index: 398_300,
  advanced: 223_800,
  recorders: 55_000,
  trace: 46_500,
  detach: 308_800,
  sinks: 13_000,
  zod: 70_400,
};
const MINIMAL_APP_BUDGET_BYTES = 375_300;

const MINIMAL_APP = `
import { flowChart, FlowChartExecutor } from './dist/esm/index.js';
const chart = flowChart('A', (scope) => { scope.x = 1; }, 'a').build();
new FlowChartExecutor(chart).run();
`;

async function bundledBytes(options: Parameters<typeof build>[0]): Promise<number> {
  const result = await build({
    bundle: true,
    format: 'esm',
    minify: true,
    write: false,
    treeShaking: true,
    platform: 'neutral',
    external: EXTERNAL,
    logLevel: 'silent',
    ...options,
  });
  return result.outputFiles![0].contents.length;
}

describe('door sizes (built package)', () => {
  it.each(Object.keys(BUDGET_BYTES))('the %s door stays under its budget', async (door) => {
    const bytes = await bundledBytes({ entryPoints: [`dist/esm/${door}.js`] });
    expect(bytes, `${door}: ${bytes} bytes`).toBeLessThanOrEqual(BUDGET_BYTES[door]);
    // A door that shrank by a fifth deserves a lower budget: fail loudly so the budget follows the code down.
    expect(bytes, `${door}: ${bytes} bytes is far below its budget; lower the budget`).toBeGreaterThan(
      BUDGET_BYTES[door] * 0.8,
    );
  });

  it('a minimal app (one chart, one run) stays under its budget', async () => {
    const bytes = await bundledBytes({ stdin: { contents: MINIMAL_APP, resolveDir: process.cwd(), loader: 'js' } });
    expect(bytes, `minimal app: ${bytes} bytes`).toBeLessThanOrEqual(MINIMAL_APP_BUDGET_BYTES);
    expect(bytes, `minimal app: ${bytes} bytes is far below its budget; lower the budget`).toBeGreaterThan(
      MINIMAL_APP_BUDGET_BYTES * 0.8,
    );
  });
});
