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

/** Minified bytes, measured 2026-11-10 at v11.2.0 plus the audit fixes, with about 3% headroom. */
const BUDGET_BYTES: Readonly<Record<string, number>> = {
  index: 385_000,
  advanced: 209_000,
  recorders: 55_000,
  trace: 46_500,
  detach: 295_500,
  sinks: 13_000,
  zod: 69_800,
};
const MINIMAL_APP_BUDGET_BYTES = 362_000;

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
