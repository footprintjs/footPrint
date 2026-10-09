/**
 * ESM packaging guards — protect consumer ergonomics:
 *   1. the ESM build is marked `type:module` (loads as true ESM, no warning),
 *   2. the main barrel + every subpath load as true ESM (no ERR_MODULE_NOT_FOUND
 *      from extensionless imports), and
 *   3. tree-shaking works: importing only `flowChart` must NOT drag in the
 *      recorder / detach / trace layers — consumer bundles grow only with what
 *      they actually import;
 *   4. each record door loads only its own: `/write` the record layer, `/trace`
 *      the readers and the recorder-side tools (C6) — neither loads the engine.
 *
 * Runs against the BUILT dist (dist/esm). Skips when dist isn't built so a bare
 * `vitest` (no prior build) doesn't false-fail; the release pipeline builds first.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const esmDir = resolve(repoRoot, 'dist/esm');
const built = existsSync(resolve(esmDir, 'index.js'));

describe.skipIf(!built)('ESM packaging', () => {
  it('dist/esm is marked type:module', () => {
    const pkg = JSON.parse(readFileSync(resolve(esmDir, 'package.json'), 'utf8'));
    expect(pkg.type).toBe('module');
  });

  it('main barrel + every subpath load as TRUE ESM', () => {
    for (const entry of ['index.js', 'trace.js', 'write.js', 'recorders.js', 'detach.js', 'advanced.js']) {
      const path = resolve(esmDir, entry);
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(path)})`], {
        encoding: 'utf8',
      });
      expect(r.status, `${entry} failed to load as ESM:\n${r.stderr}`).toBe(0);
    }
  });

  it('tree-shaking: a minimal flowChart import excludes recorders/detach/trace', async () => {
    const { build } = await import('esbuild');
    const result = await build({
      stdin: {
        contents: `import { flowChart } from ${JSON.stringify(
          resolve(esmDir, 'index.js'),
        )};\nglobalThis.__keep = flowChart;`,
        resolveDir: esmDir,
        loader: 'js',
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      treeShaking: true,
      // no minify: keep identifiers so the absence assertions are reliable
    });
    const out = result.outputFiles[0]!.text;
    // These layers must be pruned from a flowChart-only import.
    for (const decl of ['class TopologyRecorder', 'class InOutRecorder', 'class MilestoneNarrativeFlowRecorder']) {
      expect(out, `${decl} should be tree-shaken out of a flowChart-only import`).not.toContain(decl);
    }
  });

  /**
   * Everything one door hands out, bundled: the text, and the modules the bundler had to read — the door's
   * module graph, which is also what an unbundled import (Node, a CDN, an import map) loads.
   */
  const bundleOf = async (entry: string) => {
    const { build } = await import('esbuild');
    const result = await build({
      stdin: {
        contents: `import * as door from ${JSON.stringify(resolve(esmDir, entry))};\nglobalThis.__keep = door;`,
        resolveDir: esmDir,
        loader: 'js',
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      treeShaking: true,
      metafile: true,
    });
    const modules = Object.keys(result.metafile!.inputs).map((file) => file.replace(/^.*dist\/esm\//, ''));
    return { text: result.outputFiles[0]!.text, modules };
  };
  // esbuild may emit a class as `class X` or `var X = class`, and renames a clash `X2`: match either way.
  const declares = (out: string, name: string) => new RegExp(`\\b(?:class|var|let|const) ${name}\\d*\\b`).test(out);
  const ENGINE = ['StageContext', 'ScopeFacade', 'FlowchartTraverser', 'FlowChartExecutor', 'RedactionRule'];

  it('footprintjs/write bundles the record layer and nothing of the engine', async () => {
    const write = (await bundleOf('write.js')).text;
    for (const name of ['RecordFrame', 'SharedMemory', 'EventLog']) expect(declares(write, name), name).toBe(true);
    for (const name of ENGINE)
      expect(declares(write, name), `${name} must not ride in with footprintjs/write`).toBe(false);

    // The control: the same match finds every one of them in the main door's bundle.
    const main = (await bundleOf('index.js')).text;
    for (const name of ENGINE) expect(declares(main, name), `${name} in footprintjs`).toBe(true);
  });

  /**
   * What `/trace` holds (C6): the record's READERS — the fold, the cursor and its stops, the slices, the causal
   * chain, the log queries, the id grammar, the honesty codes — and the recorder-side tools it has always handed
   * out (the stores, `CommitRangeIndex`, the Topology / InOut / ControlDep / Quality recorders, `qualityTrace`,
   * `walkSubflowSpec`, the `~` segment grammar). It does not hold the WRITER (`/write`) or the engine's FRAME
   * (`/advanced`): until C6 it reached both through the `memory/index.js` barrel.
   */
  const WRITER = [
    'SharedMemory',
    'EventLog',
    'RecordFrame',
    'TransactionBuffer',
    'recordCommit',
    'admission',
    'deltaEncoding',
    'scrub',
  ];
  const FRAME = [
    'StageContext',
    'redaction',
    'runPolicy',
    'runAddress',
    'DiagnosticCollector',
    'borrowedMutation',
    'index',
  ];
  const memoryModules = (names: string[]) => names.map((name) => `lib/memory/${name}.js`);

  it('footprintjs/trace loads the readers and the recorder-side tools — not the writer, not the engine', async () => {
    const trace = await bundleOf('trace.js');
    expect(trace.modules.filter((m) => memoryModules([...WRITER, ...FRAME]).includes(m))).toEqual([]);
    expect(
      trace.modules.filter((m) => /^lib\/(scope|reactive|decide|runner|builder|contract|detach)\//.test(m)),
      'no scope, executor or builder module',
    ).toEqual([]);
    expect(trace.modules.filter((m) => m.startsWith('lib/engine/'))).toEqual(['lib/engine/walkSubflowSpec.js']);
    for (const name of [...ENGINE, 'SharedMemory', 'EventLog', 'RecordFrame', 'TransactionBuffer'])
      expect(declares(trace.text, name), `${name} must not ride in with footprintjs/trace`).toBe(false);
    // The readers are there: the fold, the cursor, a slice, the causal chain.
    for (const m of [
      'lib/time-travel/stateAt.js',
      'lib/time-travel/timeTravel.js',
      'lib/slice/sliceForKey.js',
      'lib/memory/backtrack.js',
    ])
      expect(trace.modules, m).toContain(m);

    // The control: the same check finds the writer in /write's graph and the frame in /advanced's.
    expect((await bundleOf('write.js')).modules).toEqual(expect.arrayContaining(memoryModules(WRITER)));
    expect((await bundleOf('advanced.js')).modules).toEqual(expect.arrayContaining(memoryModules(FRAME)));
  });
});
