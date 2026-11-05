// Inspect the route-built archive with the candidate's own canonical reader.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const [sourceArgument, evidenceArgument] = process.argv.slice(2);
assert.ok(sourceArgument && evidenceArgument, 'usage: pack.mjs <candidate source> <evidence>');
const source = resolve(sourceArgument);
const evidence = resolve(evidenceArgument);
const cohort = JSON.parse(readFileSync(new URL('./cohort.json', import.meta.url), 'utf8'));
const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
assert.equal(git('rev-parse', 'HEAD'), cohort.candidate.head, 'candidate checkout must be the exact proposal head');
assert.equal(git('rev-parse', 'HEAD^{tree}'), cohort.candidate.tree, 'candidate tree must match the exact proposal');
const manifest = JSON.parse(git('show', 'HEAD:package.json'));
assert.equal(manifest.name, 'foottrace');
assert.equal(manifest.version, cohort.candidate.version);
assert.deepEqual(JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')), manifest);
const packed = JSON.parse(readFileSync(join(evidence, 'pack.json'), 'utf8'));
assert.equal(packed.length, 1);
assert.equal(packed[0].filename, `foottrace-${manifest.version}.tgz`);
const archive = join(source, packed[0].filename);
const { inspectArchive } = createRequire(import.meta.url)(join(source, 'scripts/release-archive.cjs'));
const inspected = inspectArchive(readFileSync(archive), {
  package: manifest.name,
  version: manifest.version,
  sourceManifest: manifest,
});
git('diff', '--exit-code', 'HEAD');
copyFileSync(archive, join(evidence, packed[0].filename));
writeFileSync(
  join(evidence, 'candidate.json'),
  JSON.stringify(
    {
      schema: 1,
      label: `Offline foottrace-${manifest.version}.tgz from release/next ${cohort.candidate.head}; not published`,
      head: cohort.candidate.head,
      tree: git('rev-parse', 'HEAD^{tree}'),
      commands: ['npm ci', 'npm run build', 'npm run check:package', 'npm pack --ignore-scripts --json'],
      node: process.version,
      npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
      ...inspected,
    },
    null,
    2,
  ) + '\n',
);
console.log(`Canonical candidate: ${inspected.package}@${inspected.version}, sha256 ${inspected.sha256}`);
