/** Run after both same-run packs, using only a strict neutral tarball install. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, copyFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bytes,
  command,
  digest,
  source,
  installedPackage,
  strictLock,
  onePhysicalReader,
  engineReaderResolution,
  recordOutcome,
} from './identity.mjs';

import { verifyArtifactReceipt } from './candidate-artifact.mjs';

const require = createRequire(import.meta.url),
  ownRoot = fileURLToPath(new URL('../../', import.meta.url));
const { inspectArchive: inspectEngine } = require('../publish-release/archive/inspector.cjs');
const [readerSourceArg, engineArtifactArg, readerArtifactArg, neutralArg, expectedReader] = process.argv.slice(2);
const readerSource = resolve(readerSourceArg),
  engineArtifact = resolve(engineArtifactArg),
  readerArtifact = resolve(readerArtifactArg),
  neutral = resolve(neutralArg);
assert.match(expectedReader ?? '', /^[a-f0-9]{40}$/);
const readerWitness = source(readerSource, expectedReader);
const { inspectArchive: inspectReader } = require(join(readerSource, 'scripts/release-archive.cjs'));
const engineWitness = source(ownRoot);
const runId = process.env.GITHUB_RUN_ID,
  attempt = process.env.GITHUB_RUN_ATTEMPT;
assert.match(runId ?? '', /^\d+$/);
assert.match(attempt ?? '', /^\d+$/);
const artifacts = {
  engine: { id: process.env.ENGINE_ARTIFACT_ID, zipDigest: process.env.ENGINE_ARTIFACT_DIGEST },
  reader: { id: process.env.READER_ARTIFACT_ID, zipDigest: process.env.READER_ARTIFACT_DIGEST },
};
for (const artifact of Object.values(artifacts)) {
  assert.match(artifact.id ?? '', /^[1-9][0-9]*$/);
  assert.match(artifact.zipDigest ?? '', /^(sha256:)?[a-f0-9]{64}$/);
}
const packages = [
  {
    role: 'engine',
    name: 'footprintjs',
    directory: engineArtifact,
    filename: 'footprintjs-candidate.tgz',
    inspect: inspectEngine,
    witness: engineWitness,
  },
  {
    role: 'reader',
    name: 'foottrace',
    directory: readerArtifact,
    filename: 'foottrace-candidate.tgz',
    inspect: inspectReader,
    witness: readerWitness,
  },
].map(({ role, name, directory, filename, inspect, witness }) => {
  const record = JSON.parse(bytes(join(directory, role + '-receipt.json'), 2 * 1024 * 1024));
  const archive = join(directory, filename);
  const archiveBytes = bytes(archive, 16 * 1024 * 1024);
  verifyArtifactReceipt(role, record, witness, archiveBytes);
  const inspection = inspect(archiveBytes, {
    package: name,
    version: witness.manifest.version,
    sourceManifest: witness.manifest,
  });
  assert.deepEqual(inspection, record.archive, 'same-run archive must match its original inspected inventory');
  return { name, role, archive, inspection, record };
});
// A fresh, external directory is essential: package resolution must not reach either source tree.
for (const root of [ownRoot, readerSource]) assert.ok(!neutral.startsWith(realpathSync(root) + '/'));
mkdirSync(neutral, { recursive: false, mode: 0o700 });
const dependencies = Object.fromEntries(packages.map(({ name, archive }) => [name, 'file:' + realpathSync(archive)]));
writeFileSync(
  join(neutral, 'package.json'),
  JSON.stringify({ name: 'native-protocol-proof', version: '1.0.0', private: true, dependencies }, null, 2),
);
const outcomes = [];
const npmVersion = command('npm', ['--version'], neutral).trim();
assert.equal(process.version, 'v24.21.0');
assert.equal(npmVersion, '11.21.1');
function run(args) {
  command('npm', args, neutral, (outcome) => outcomes.push(outcome));
}
recordOutcome(
  () => {
    run([
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--strict-peer-deps',
      '--registry=https://registry.npmjs.org',
    ]);
    const lock = strictLock(neutral, packages);
    run(['ci', '--ignore-scripts', '--strict-peer-deps', '--registry=https://registry.npmjs.org']);
    const installed = Object.fromEntries(
      packages.map(({ name, inspection }) => [name, installedPackage(join(neutral, 'node_modules', name), inspection)]),
    );
    const physical = onePhysicalReader(neutral, join(neutral, 'node_modules/foottrace'));
    const resolution = engineReaderResolution(neutral, join(neutral, 'node_modules/foottrace'));
    const driver = join(readerSource, 'test/consumer/subflows/verify-native.mjs');
    const fixture = join(ownRoot, 'test/fixtures/subflow-provenance/produce.cjs');
    assert.equal(digest(bytes(driver, 1024 * 1024)), packages[1].record.driverSha256);
    copyFileSync(driver, join(neutral, 'verify-native.mjs'));
    copyFileSync(fixture, join(neutral, 'produce.cjs'));
    const stdout = command('node', ['verify-native.mjs'], neutral, (outcome) => outcomes.push(outcome));
    const protocol = JSON.parse(stdout);
    assert.equal(protocol.protocol, 'native-subflow-provenance-fixture-v1');
    const expected = [
      'disabled:',
      ...['all', 'input-only', 'output-only', 'fanout-only'].flatMap((mode) =>
        ['esm', 'cjs'].map((format) => mode + ':' + format),
      ),
    ].sort();
    assert.deepEqual(
      protocol.completed.map((entry) => entry.name + ':' + (entry.format ?? '')).sort(),
      expected,
      'all fixed public driver scenarios and reader formats must complete',
    );
    return {
      status: 'PASS',
      lock,
      installed,
      physical,
      resolution,
      protocol,
      driverSha256: digest(bytes(driver, 1024 * 1024)),
      fixtureSha256: digest(bytes(fixture, 1024 * 1024)),
    };
  },
  (result, primary) => {
    const observation = primary ? { status: 'FAIL', error: String(primary.error?.stack ?? primary.error) } : result;
    writeFileSync(
      join(neutral, 'protocol-proof.json'),
      JSON.stringify(
        {
          ...observation,
          artifacts,
          outcomes,
          runId,
          attempt,
          node: process.version,
          npm: npmVersion,
          packages: packages.map(({ name, record }) => ({ name, record })),
        },
        null,
        2,
      ) + '\n',
    );
  },
  (error) => process.stderr.write('Secondary proof receipt failure: ' + String(error) + '\n'),
);
