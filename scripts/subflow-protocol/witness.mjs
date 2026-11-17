/** Source-bound, nonpublishing pack receipts for the fixed producer/reader protocol. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytes, command, digest, source } from './identity.mjs';

const require = createRequire(import.meta.url);
const ownRoot = fileURLToPath(new URL('../../', import.meta.url));
const { inspectArchive: inspectEngine, parseManifest } = require('../publish-release/archive/inspector.cjs');
const context = () => {
  assert.match(process.env.GITHUB_RUN_ID ?? '', /^\d+$/);
  assert.match(process.env.GITHUB_RUN_ATTEMPT ?? '', /^\d+$/);
  assert.equal(process.version, 'v24.21.0');
  assert.equal(command('npm', ['--version'], ownRoot).trim(), '11.21.1');
  return {
    runId: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    node: process.version,
    npm: command('npm', ['--version'], ownRoot).trim(),
  };
};
function receipt(directory, role, witness, archive, inspect, extra = {}) {
  const original = parseManifest(Buffer.from(command('git', ['show', 'HEAD:package.json'], witness.root)));
  const inspected = inspect(bytes(archive, 16 * 1024 * 1024), {
    package: role === 'engine' ? 'footprintjs' : 'foottrace',
    version: original.version,
    sourceManifest: original,
  });
  assert.equal(inspected.package, original.name);
  const record = {
    schemaVersion: 1,
    role,
    source: { head: witness.head, tree: witness.tree, manifestSha256: witness.manifestSha256 },
    originalManifest: original,
    archive: inspected,
    workflow: context(),
    ...extra,
  };
  writeFileSync(join(directory, role + '-receipt.json'), JSON.stringify(record, null, 2) + '\n');
  return record;
}
const [role, first, second, expected] = process.argv.slice(2);
if (role === 'engine') {
  const directory = resolve(first),
    witness = source(ownRoot);
  const expectedHead = process.env.PROTOCOL_ENGINE_HEAD;
  assert.match(expectedHead ?? '', /^[a-f0-9]{40}$/);
  const headTree = command('git', ['rev-parse', expectedHead + '^{tree}'], ownRoot).trim();
  assert.equal(witness.tree, headTree, 'packed checkout tree must equal the reviewed head tree');
  receipt(
    directory,
    'engine',
    { ...witness, root: ownRoot },
    join(directory, 'footprintjs-candidate.tgz'),
    inspectEngine,
    { reviewedHead: expectedHead },
  );
} else if (role === 'reader') {
  const root = resolve(first),
    directory = resolve(second);
  assert.match(expected ?? '', /^[a-f0-9]{40}$/);
  const witness = source(root, expected);
  assert.equal(witness.manifest.name, 'foottrace');
  const packed = JSON.parse(
    command('npm', ['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', directory], root),
  );
  assert.equal(packed.length, 1);
  assert.match(packed[0].filename, /^foottrace-[0-9A-Za-z.+-]+\.tgz$/);
  const filename = join(directory, packed[0].filename);
  assert.equal(readdirSync(directory).length, 1);
  renameSync(filename, join(directory, 'foottrace-candidate.tgz'));
  const { inspectArchive } = require(join(root, 'scripts/release-archive.cjs'));
  receipt(directory, 'reader', { ...witness, root }, join(directory, 'foottrace-candidate.tgz'), inspectArchive, {
    driverSha256: digest(bytes(join(root, 'test/consumer/subflows/verify-native.mjs'), 1024 * 1024)),
  });
} else throw new Error('fixed engine or reader operation required');
