/** Bounded source-graph diagnostics; actual emitted budgets remain a separate hosted gate. */
import { resolve } from 'node:path';

import { build, stop } from 'esbuild';
import { afterAll, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const EXTERNAL = ['foottrace', 'foottrace/*', 'zod', 'node:*', 'worker_threads', 'fs', 'path', 'crypto'];

afterAll(() => stop());

it.each(['src/recorders.ts', 'src/lib/filter/evaluator.ts', 'src/lib/decide/evidence.ts'])(
  '%s does not retain a Rule or private authority graph just to serve fixed values',
  async (entry) => {
    const result = await build({
      absWorkingDir: ROOT,
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      minify: true,
      write: false,
      treeShaking: true,
      metafile: true,
      external: EXTERNAL,
      logLevel: 'silent',
    });
    if (!result.metafile) throw new Error('source diagnostic did not produce its required dependency graph');
    const retained = Object.values(result.metafile.outputs)
      .flatMap((output) => Object.entries(output.inputs))
      .filter(
        ([name, input]) =>
          input.bytesInOutput > 0 &&
          (name === 'src/lib/memory/redaction.ts' || name.startsWith('src/lib/memory/readAuthority/')),
      )
      .map(([name, input]) => ({ name, bytes: input.bytesInOutput }));
    expect(retained, 'fixed-value consumers must not root the class/authority dependency graph').toEqual([]);
  },
);

it.each([
  "import {RedactionRule} from './src/lib/memory/redaction.ts'; export const make=()=>new RedactionRule();",
  "import {StageContext} from './src/lib/memory/StageContext.ts'; export const make=heap=>new StageContext('r','s','s',heap);",
])('constructor-only graph does not retain observation predicates: %s', async (contents) => {
  const result = await build({
    absWorkingDir: ROOT,
    stdin: { contents, resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    minify: true,
    write: false,
    treeShaking: true,
    metafile: true,
    external: EXTERNAL,
    logLevel: 'silent',
  });
  const observation = new Set([
    'src/lib/memory/readAuthority/rule.ts',
    'src/lib/memory/readAuthority/context.ts',
    'src/lib/memory/readAuthority/policyObservation.ts',
  ]);
  if (!result.metafile) throw new Error('source diagnostic did not produce its required dependency graph');
  const retained = Object.values(result.metafile.outputs)
    .flatMap((output) => Object.entries(output.inputs))
    .filter(([name, input]) => input.bytesInOutput > 0 && observation.has(name))
    .map(([name, input]) => ({ name, bytes: input.bytesInOutput }));
  expect(retained, 'registration data must not capture observation closures').toEqual([]);
});
