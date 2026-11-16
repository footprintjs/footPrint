import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { version as esbuildVersion } from 'esbuild';

import { bundledBytes, MINIMAL_APP } from './index.mjs';

// Read an already-built package. This command never builds, installs or changes it.
const packageRoot = resolve(process.argv[2] ?? '.');
const buildConfig = resolve(process.argv[3] ?? packageRoot, 'tsconfig.json');
const buildConfigHash = createHash('sha256').update(readFileSync(buildConfig)).digest('hex');
const doors = ['index', 'advanced', 'recorders', 'trace', 'detach', 'sinks', 'zod'];
const bytes = {};
const entryHashes = {};
for (const door of doors) {
  const entry = resolve(packageRoot, `dist/esm/${door}.js`);
  entryHashes[door] = createHash('sha256').update(readFileSync(entry)).digest('hex');
  bytes[door] = await bundledBytes({ entryPoints: [entry], absWorkingDir: packageRoot, tsconfig: buildConfig });
}
bytes.minimal = await bundledBytes({
  stdin: { contents: MINIMAL_APP, resolveDir: packageRoot, loader: 'js' },
  absWorkingDir: packageRoot,
  tsconfig: buildConfig,
});
console.log(
  JSON.stringify(
    { packageRoot, node: process.version, esbuildVersion, buildConfig, buildConfigHash, entryHashes, bytes },
    null,
    2,
  ),
);
