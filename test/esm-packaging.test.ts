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
    for (const entry of ['index.js', 'trace.js', 'recorders.js', 'detach.js', 'advanced.js', 'zod.js']) {
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
        contents: `import * as door from ${JSON.stringify(
          entry.startsWith('foottrace') ? entry : resolve(esmDir, entry),
        )};\nglobalThis.__keep = door;`,
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
    const modules = Object.keys(result.metafile!.inputs)
      .filter((file) => file !== '<stdin>')
      .map((file) => resolve(repoRoot, file));
    return { text: result.outputFiles[0]!.text, modules };
  };
  // esbuild may emit a class as `class X` or `var X = class`, and renames a clash `X2`: match either way.
  const declares = (out: string, name: string) => new RegExp(`\\b(?:class|var|let|const) ${name}\\d*\\b`).test(out);
  const ENGINE = ['StageContext', 'ScopeFacade', 'FlowchartTraverser', 'FlowChartExecutor', 'RedactionRule'];

  it('foottrace/write bundles the record layer and nothing of the engine', async () => {
    const write = (await bundleOf('foottrace/write')).text;
    for (const name of ['RecordFrame', 'SharedMemory', 'EventLog']) expect(declares(write, name), name).toBe(true);
    for (const name of ENGINE)
      expect(declares(write, name), `${name} must not ride in with foottrace/write`).toBe(false);

    // The control: the same match finds every one of them in the main door's bundle.
    const main = (await bundleOf('index.js')).text;
    for (const name of ENGINE) expect(declares(main, name), `${name} in footprintjs`).toBe(true);
  });

  /**
   * What `/trace` holds (C6) — an allow-list, so the decision is executable: the record's READERS (record files:
   * the fold, the cursor and its stops, the slices, the causal chain, the log queries, the id grammar, the honesty
   * codes, `CommitRangeIndex`) and the recorder-side tools it has always handed out, which stay on
   * `footprintjs/trace` after the extraction (plan section 7.5, last row). Not the WRITER, which is record files
   * too but has its own door (`/write`), and nothing of the engine (`/advanced`): until C6 it loaded both
   * through the `memory/index.js` barrel.
   */
  const TRACE_TOOLS = [
    'src/lib/recorder/BoundaryStateStore.ts',
    'src/lib/recorder/KeyedStore.ts',
    'src/lib/recorder/SequenceStore.ts',
    'src/lib/recorder/TopologyRecorder.ts',
    'src/lib/recorder/InOutRecorder.ts',
    'src/lib/recorder/ControlDepRecorder.ts',
    'src/lib/recorder/QualityRecorder.ts',
    'src/lib/recorder/qualityTrace.ts',
    'src/lib/engine/walkSubflowSpec.ts',
    'src/lib/ids/branchSegment.ts',
    'src/lib/devMode.ts', // BoundaryStateStore's dev-mode warning
  ];
  /** The writer: the record files behind `/write` (the heap, the log, the frame, staging and the commit). */
  const WRITER = [
    'SharedMemory',
    'EventLog',
    'RecordFrame',
    'TransactionBuffer',
    'recordCommit',
    'admission',
    'deltaEncoding',
    'scrub',
  ].map((name) => `src/lib/memory/${name}.ts`);
  /** A door's modules as the src files they were built from (`lib/memory/verbs.js` → `src/lib/memory/verbs.ts`). */
  const sourcesOf = async (entry: string) =>
    (await bundleOf(entry)).modules
      .filter((m) => m.startsWith(esmDir + '/lib/'))
      .map((m) => 'src/' + m.slice(esmDir.length + 1).replace(/\.js$/, '.ts'));
  const notTrace = (files: string[]) => files.filter((f) => !TRACE_TOOLS.includes(f));

  it('footprintjs/trace loads its recorder tools and foottrace readers, with no local record copy or writer', async () => {
    const trace = await sourcesOf('trace.js');
    expect(notTrace(trace), 'a module that is neither a record file nor a tool /trace hands out').toEqual([]);
    expect(
      trace.filter((f) => WRITER.includes(f)),
      'the writer has its own door, /write',
    ).toEqual([]);
    expect(
      TRACE_TOOLS.filter((f) => !trace.includes(f)),
      'every named tool is really loaded',
    ).toEqual([]);
    const modules = (await bundleOf('trace.js')).modules;
    const recordRoot = dirname(require.resolve('foottrace/package.json'));
    const recordModules = modules.filter((file) => file.startsWith(recordRoot + '/'));
    expect(recordModules.length).toBeGreaterThan(0);
    for (const reader of ['time-travel/stateAt', 'slice/sliceForKey'])
      expect(
        recordModules.some((file) => file.endsWith('/lib/' + reader + '.js')),
        reader,
      ).toBe(true);
    expect(modules.filter((file) => file.startsWith(esmDir + '/lib/time-travel/'))).toEqual([]);
    const text = (await bundleOf('trace.js')).text;
    for (const name of [...ENGINE, 'SharedMemory', 'EventLog', 'RecordFrame', 'TransactionBuffer'])
      expect(declares(text, name), `${name} must not ride in with footprintjs/trace`).toBe(false);

    // The controls: the same checks find the engine in /advanced's graph and the writer in /write's.
    expect(notTrace(await sourcesOf('advanced.js'))).toEqual(
      expect.arrayContaining(['src/lib/memory/StageContext.ts', 'src/lib/memory/redaction.ts']),
    );
    const writerModules = (await bundleOf('foottrace/write')).modules;
    expect(writerModules.every((file) => file.startsWith(recordRoot + '/'))).toBe(true);
    expect(writerModules.some((file) => file.endsWith('/lib/memory/RecordFrame.js'))).toBe(true);
  });
});
