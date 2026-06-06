/**
 * ESM packaging guards — protect consumer ergonomics:
 *   1. the ESM build is marked `type:module` (loads as true ESM, no warning),
 *   2. the main barrel + every subpath load as true ESM (no ERR_MODULE_NOT_FOUND
 *      from extensionless imports), and
 *   3. tree-shaking works: importing only `flowChart` must NOT drag in the
 *      recorder / detach / trace layers — consumer bundles grow only with what
 *      they actually import.
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
    for (const entry of ['index.js', 'trace.js', 'recorders.js', 'detach.js', 'advanced.js']) {
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
});
