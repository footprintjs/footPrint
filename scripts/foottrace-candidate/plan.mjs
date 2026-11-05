// Proof-driver data. This does not change any consumer's public metadata.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const cohort = JSON.parse(readFileSync(new URL('./cohort.json', import.meta.url), 'utf8'));
export const CANDIDATE = Object.freeze({
  name: 'foottrace',
  version: cohort.candidate.version,
  commit: cohort.candidate.head,
  tree: cohort.candidate.tree,
});

export const COHORTS = Object.freeze({
  footprintjs: Object.freeze({
    name: 'footprintjs',
    commands: [
      ['npm', ['run', 'build']],
      ['npm', ['run', 'test:contract:foottrace']],
      ['npm', ['test']],
    ],
  }),
  agentfootprint: Object.freeze({
    name: 'agentfootprint',
    commands: [
      ['npm', ['run', 'build']],
      ['npm', ['run', 'test:contract:foottrace']],
      ['npm', ['test']],
    ],
  }),
  lens: Object.freeze({
    name: 'agentfootprint-lens',
    commands: [
      ['npm', ['run', 'typecheck']],
      ['npm', ['run', 'build']],
      ['npm', ['run', 'test:contract:foottrace']],
      ['npm', ['test']],
    ],
  }),
});

/** Only concrete Foottrace install requests change; peer declarations stay intact. */
export function candidateManifest(original, tar, cohort) {
  assert.ok(Object.hasOwn(COHORTS, cohort), 'unknown cohort');
  assert.equal(Object.hasOwn(original, 'overrides'), false, 'npm overrides are refused');
  assert.ok(isAbsolute(tar) && !/[\r\n\0]/u.test(tar), 'absolute candidate tar required');
  const manifest = JSON.parse(JSON.stringify(original));
  assert.equal(manifest.name, COHORTS[cohort].name, 'wrong source package');
  const replaced = {};
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    if (manifest[section] === undefined) continue;
    assert.ok(
      manifest[section] && typeof manifest[section] === 'object' && !Array.isArray(manifest[section]),
      `invalid ${section}`,
    );
    if (Object.hasOwn(manifest[section], 'foottrace')) {
      replaced[section] = manifest[section].foottrace;
      delete manifest[section].foottrace;
    }
  }
  manifest.devDependencies ??= {};
  manifest.devDependencies.foottrace = `file:${tar}`;
  return { manifest, replaced };
}

export function requireMetadata(metadata) {
  assert.deepEqual(
    Object.keys(metadata).sort(),
    [
      'schema',
      'label',
      'head',
      'tree',
      'commands',
      'node',
      'npm',
      'package',
      'version',
      'sha256',
      'shasum',
      'integrity',
      'bytes',
      'files',
    ].sort(),
    'closed candidate metadata required',
  );
  assert.equal(metadata.schema, 1);
  assert.equal(metadata.package, CANDIDATE.name);
  assert.equal(metadata.version, CANDIDATE.version);
  assert.equal(metadata.head, CANDIDATE.commit);
  assert.equal(metadata.tree, CANDIDATE.tree, 'candidate tree differs from the exact proposal');
  assert.match(metadata.sha256, /^[a-f0-9]{64}$/u);
  assert.ok(Number.isSafeInteger(metadata.bytes) && metadata.bytes > 0);
  assert.ok(Array.isArray(metadata.files) && metadata.files.length > 0);
  const paths = new Set();
  for (const file of metadata.files) {
    assert.deepEqual(Object.keys(file).sort(), ['path', 'size', 'sha256'].sort());
    assert.match(file.path, /^package\/[\x20-\x7e]+$/u);
    assert.ok(!file.path.includes('\\') && file.path.split('/').every((part) => part && part !== '..' && part !== '.'));
    assert.equal(paths.has(file.path), false, 'duplicate canonical file');
    paths.add(file.path);
    assert.match(file.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(Number.isSafeInteger(file.size) && file.size >= 0);
  }
  return metadata;
}
