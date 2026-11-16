'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entry, pack } = require('./fixture.cjs');
const { inspectArchive, inspectCohortArchive } = require('./inspector.cjs');
const source = {
  name: 'footprint-storydeck',
  version: '0.13.3',
  peerDependencies: { footprintjs: '^11 || ^12 || ^13.0.0-rc.0' },
};
const required = [
  entry('package/plugin/skills/storydeck/SKILL.md', ''),
  entry('package/site/public/deck-stage.js', ''),
  entry('package/CHANGELOG.md', ''),
];
const inspect = (bytes, manifest = source) =>
  inspectCohortArchive(bytes, { package: manifest.name, version: manifest.version, sourceManifest: manifest });
const bytes = (extras = [], members = required, manifest = source) => pack(manifest, [...members, ...extras]);
test('fixed Storydeck native roots, required empty members and optional root wildcards share the parser', () => {
  const candidate = bytes([entry('package/index.d.ts', 'declarations'), entry('package/deck.css', 'style')]);
  assert.equal(inspect(candidate).files.length, 7);
  assert.throws(() =>
    inspectArchive(candidate, { package: source.name, version: source.version, sourceManifest: source }),
  );
  const other = { ...source, name: 'footprintjs' };
  assert.throws(() => inspect(bytes([], required, other), other));
});
for (const missing of [0, 1, 2])
  test('requires native member ' + required[missing].subarray(0, 100).toString().split('\0')[0], () => {
    assert.throws(() =>
      inspect(
        bytes(
          [],
          required.filter((_, i) => i !== missing),
        ),
      ),
    );
  });
for (const path of [
  'package/.d.ts',
  'package/.css',
  'package/unknown/index.d.ts',
  'package/site/public/other.js',
  'package/AGENTS.md',
  'package/server.js',
  'package/npm-shrinkwrap.json',
  'package/binding.gyp',
  'package/plugin/.NPMRC',
  'package/plugin/NODE_MODULES/evil.js',
  'package/plugin/CON.txt',
  'package/plugin/x.',
  'package/plugin/dir /x',
  'package/plugin/file:stream',
  'package/plugin/PACKAG~1.JSO',
])
  test('closed Storydeck policy refuses ' + path, () => assert.throws(() => inspect(bytes([entry(path, 'inert')]))));
for (const paths of [
  ['package/plugin/a', 'package/plugin/A'],
  ['package/plugin/file', 'package/plugin/file/child'],
  ['package/plugin/file/child', 'package/plugin/file'],
])
  test('native collision refuses ' + paths.join(' + '), () =>
    assert.throws(() => inspect(bytes(paths.map((path) => entry(path, 'inert'))))),
  );
test('whole source manifest still refuses old public peer bytes and caller policy overrides', () => {
  const old = { ...source, peerDependencies: { footprintjs: '^11 || ^12' } };
  assert.throws(() => inspect(bytes([], required, old)));
  for (const key of ['archive', 'roots', 'profile', 'maxFiles', 'maxExpandedBytes'])
    assert.throws(() =>
      inspectCohortArchive(bytes(), {
        package: source.name,
        version: source.version,
        sourceManifest: source,
        [key]: [],
      }),
    );
});

test('Storydeck native port refuses a source/archive version projection', () => {
  const target = '0.13.4-rc.0';
  assert.throws(() =>
    inspectCohortArchive(bytes([], required, { ...source, version: target }), {
      package: source.name,
      version: target,
      sourceManifest: source,
    }),
  );
});
