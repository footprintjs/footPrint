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
 * each moved up by 12,200, and `zod` by 600. That is what following a hidden object costs
 * (`memory/selectedObjects.ts`, `memory/hiddenObjectTrail.ts` and `memory/servedPlaces.ts`: a stage
 * remembers what it read under a hidden name, and every value it writes is searched for it, when it is
 * written and once more at commit; the second search has to tell what was put in after the write from
 * what was there, which is about 3,000 of the bytes; what a stage keeps of each write and what it takes
 * from its input are looked at too, about 2,700; and no step may cost the square of the hidden places
 * under a key, which is about 1,000: a list of paths is read once, and the walk that serves a record
 * asks a node's targets once, `memory/pathTargets.ts`, which `zod` carries too): measured at 12,065
 * more bytes on `index` and the minimal app, 12,072 on `advanced`, 12,215 on `detach`, 951 on `zod`
 * and 22 on `recorders` (which still fits). `advanced` has 283 bytes of room after it, `zod` 177.
 *
 * 12.2.0: the default-off subflow output-handoff capture adds the bounded mapper observer
 * (`engine/handlers/outputHandoff.ts`), the staged-write/commit-boundary tap (`memory/commitTap.ts`)
 * and its native-address/privacy wiring. These are reached through the engine classes even when a
 * minimal app leaves capture off. With the same locked esbuild 0.28.2 and Node 24.21.0, baseline
 * eec350f measured index 400,295, advanced 226,580, detach 309,818 and minimal app 377,032; the
 * candidate measures 404,933, 230,962, 314,537 and 381,670 respectively. Increase only these four
 * budgets by their measured additions, rounded up to 100 bytes: 4,700 / 4,400 / 4,800 / 4,700.
 * This preserves their prior remaining headroom with only 18–81 bytes extra from rounding; it does
 * not reset them to 3%. Recorders, trace, sinks and zod measured byte-identically and keep their budgets.
 *
 * Stage-error privacy: execution-scoped source validity, native pending-failure receipts and retained
 * error-envelope projections add code to doors carrying the redaction rule or engine. At c4fb5295,
 * unchanged checkout CI on Node 22 and 24 with locked esbuild 0.28.2 measured index 411,845,
 * advanced 237,859, detach 321,920, zod 74,962 and minimal app 388,582 bytes. The accepted allowance
 * is only the next 100-byte ceiling for those five measurements, leaving 55 / 41 / 80 / 38 / 18 bytes
 * of headroom. Recorders, trace and sinks remain within their existing budgets and keep them. The
 * bundling options, size assertions and source-file size ratchets are unchanged.
 *
 * Engine 13 nested read provenance: the opt-in member observer, native tracked-read ports and
 * immutable encoding policy add 1,295 bytes to index/advanced/minimal and 413 to detach. With locked
 * esbuild 0.28.2, Node 24.21.0 and identical external/bundling options, the pure heading d688a181
 * measures 411,845 / 237,859 / 321,920 / 388,582; candidate 7cf1ad9e measures
 * 413,140 / 239,154 / 322,333 / 389,877. Set only those four to the next 100-byte ceiling, leaving
 * 60 / 46 / 67 / 23 bytes of room. Recorders, trace, sinks and zod are byte-identical and keep their
 * budgets. Foottrace itself remains external; the added bytes are engine wiring reached by its classes.
 *
 * Native subflow provenance: the opt-in capture wiring is reachable through the engine classes.
 * Current built-package checks on both supported Node versions measure index 415,167, advanced
 * 240,601, detach 324,320, zod 75,235 and the minimal app 391,904 bytes with the same bundling recipe.
 * The approved budgets are only the next 100-byte ceilings for these measurements, leaving
 * 33 / 99 / 80 / 65 / 96 bytes of room. The optional capture door keeps its separate 12,000-byte
 * ceiling. Recorders, trace, sinks, the source-file ratchets and all size assertions are unchanged.
 *
 * 2026-11-17 combined native read authority and subflow provenance: both Node 22 and 24 checks at
 * dd621293 measure index 415,918, advanced 241,351, detach 325,323, zod 75,782 and the minimal app
 * 392,655 bytes with this unchanged bundling recipe. The approved combined budgets are only the
 * next 100-byte ceilings, leaving 82 / 49 / 77 / 18 / 45 bytes of room. The private original-owner
 * admission and capture association remain separate facts; their eager snapshots and existing
 * runtime behavior are preserved. Other package budgets and source-file size ratchets are unchanged.
 *
 * Expanded Mermaid subflows add a static-graph walker and label unresolved loop targets.
 * Against a6a1fdf3, locked esbuild 0.28.2 on Node 24.21.0 measures the main
 * door at 417,102 bytes (+1,184) and the minimal app at 393,839 bytes (+1,184). Only these two
 * ceilings move to the next 100 bytes. Every other door is byte-identical.
 */
const BUDGET_BYTES: Readonly<Record<string, number>> = {
  index: 417_200,
  advanced: 241_400,
  recorders: 55_000,
  trace: 46_500,
  detach: 325_400,
  sinks: 13_000,
  zod: 75_800,
};
const MINIMAL_APP_BUDGET_BYTES = 393_900;

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
  it('the explicit optional subflow-capture door stays under its own 12KB ceiling', async () => {
    const bytes = await bundledBytes({ entryPoints: ['dist/esm/subflow-capture.js'] });
    console.log(`subflow-capture: ${bytes} bytes`);
    expect(bytes, `subflow-capture: ${bytes} bytes`).toBeLessThanOrEqual(12_000);
  });
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
