'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { gzipSync, gunzipSync } = require('node:zlib');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { inspectArchive, inspectCohortArchive, archiveRefusalCode } = require('./inspector.cjs');
const { entry, tar, pack } = require('./fixture.cjs');

const source = { name: 'agentfootprint', version: '15.0.0-rc.0' };
const expected = (manifest = source) => ({
  package: manifest.name,
  version: manifest.version,
  sourceManifest: manifest,
});
const refuses = (bytes, options = expected()) =>
  assert.throws(
    () => inspectCohortArchive(bytes, options),
    (error) => /^(invalid-archive|archive-profile|manifest-)/.test(archiveRefusalCode(error)),
  );

test('AF native roots are admitted only by its closed source-audit profile, never the release entry', () => {
  const bytes = pack(source, [
    entry('package/ai-instructions/cursor/agentfootprint.md', 'instructions'),
    entry('package/bin/agentfootprint-index.mjs', 'inert data'),
    entry('package/CAPABILITIES.md', 'capabilities'),
    entry('package/canonical-notes.json', '{}'),
  ]);
  assert.equal(inspectCohortArchive(bytes, expected()).files.length, 6);
  assert.throws(() => inspectArchive(bytes, expected()));
  const footprint = { name: 'footprintjs', version: source.version };
  refuses(pack(footprint, [entry('package/bin/anything', 'inert')]), expected(footprint));
});

for (const name of ['package/.npmrc', 'package/server.js', 'package/binding.gyp', 'package/unknown/file'])
  test('AF source profile still refuses an unowned root: ' + name, () => refuses(pack(source, [entry(name, 'inert')])));

for (const field of ['maxFiles', 'maxArchiveBytes', 'maxExpandedBytes', 'profile', 'roots'])
  test('cohort caller cannot supply ' + field, () => refuses(pack(source), { ...expected(), [field]: 1e9 }));

for (const total of [10001, 20000, 20001])
  test('reuses the native AF member boundary at ' + total, () => {
    const members = Array.from({ length: total - 2 }, (_, i) => entry(`package/dist/f${i}`, ''));
    const bytes = pack(source, members);
    if (total > 20000) {
      refuses(bytes);
      refuses(bytes, { ...expected(), maxFiles: 1e9 });
    } else assert.equal(inspectCohortArchive(bytes, expected()).files.length, total);
    assert.throws(() => inspectArchive(bytes, expected()));
    if (total === 10001) {
      const footprint = { ...source, name: 'footprintjs' };
      refuses(pack(footprint, members), expected(footprint));
    }
  });

for (const bit of [1, 2, 4, 8, 16, 32, 64, 128])
  test('AF profile keeps canonical gzip flag refusal ' + bit, () => {
    const bytes = pack(source);
    bytes[3] = bit;
    refuses(bytes);
  });

test('AF profile keeps duplicate/path/link/PAX and whole-source identity refusals', () => {
  refuses(pack(source, [entry('package/dist/index.js', 'duplicate')]));
  refuses(pack(source, [entry('package/../escape', 'escape')]));
  refuses(
    pack(source, [
      entry('package/ai-instructions/link', 'link', (h) => {
        h[156] = 50;
      }),
    ]),
  );
  refuses(
    pack(source, [
      entry('package/ai-instructions/pax', 'pax', (h) => {
        h[156] = 120;
      }),
    ]),
  );
  refuses(pack({ ...source, dependencies: { changed: '1.0.0' } }));
});

// Test-data writer adapted from AF9288 scripts/publish-archive/compressed-fixture.mjs.
// No decoder/parser is copied. Valid stored DEFLATE blocks produce an exact compressed length.
function compressedAtSize(size) {
  let packed, decoded, count;
  for (let delta = 0; delta < 5; delta++) {
    packed = pack(source, [entry('package/dist/stored', Buffer.alloc(size - 8192 - delta * 512))]);
    decoded = gunzipSync(packed);
    count = (size - 18 - decoded.length) / 5;
    if (Number.isInteger(count)) break;
  }
  assert(Number.isSafeInteger(count) && count > 0 && Math.ceil(decoded.length / count) <= 65535);
  const chunks = [packed.subarray(0, 10)];
  for (let i = 0; i < count; i++) {
    const start = Math.floor((decoded.length * i) / count),
      end = Math.floor((decoded.length * (i + 1)) / count);
    const header = Buffer.alloc(5);
    header[0] = i === count - 1 ? 1 : 0;
    header.writeUInt16LE(end - start, 1);
    header.writeUInt16LE((end - start) ^ 65535, 3);
    chunks.push(header, decoded.subarray(start, end));
  }
  const bytes = Buffer.concat([...chunks, packed.subarray(-8)]);
  assert.equal(bytes.length, size);
  return bytes;
}

test('AF exact32MiB compressed boundary uses the admitted expected name before metadata reads', async () => {
  const bytes = compressedAtSize(32 * 1024 * 1024);
  assert.equal(inspectCohortArchive(bytes, expected()).bytes, bytes.length);
  assert.throws(() => inspectArchive(bytes, expected()));
  const { packedManifest } = await import('../../consumer-cohort/bytes/index.mjs');
  const temp = mkdtempSync(join(tmpdir(), 'cohort-meta-profile-'));
  try {
    const path = join(temp, 'candidate.tgz');
    writeFileSync(path, bytes);
    assert.throws(() => packedManifest(path));
    assert.deepEqual(packedManifest(path, 'agentfootprint'), source);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  refuses(compressedAtSize(32 * 1024 * 1024 + 1));
});

test('native20000 files verify on disk without confusing the dist directory with a file', async () => {
  const bytes = pack(
    source,
    Array.from({ length: 19998 }, (_, i) => entry(`package/dist/f${i}`, '')),
  );
  const report = inspectCohortArchive(bytes, expected());
  const temp = mkdtempSync(join(tmpdir(), 'cohort-file-entry-boundary-'));
  try {
    const path = join(temp, 'candidate.tgz');
    writeFileSync(path, bytes);
    execFileSync('tar', ['-xzf', path, '-C', temp], { timeout: 30_000 });
    const { verifyFiles } = await import('../../consumer-cohort/bytes/index.mjs');
    verifyFiles(join(temp, 'package'), report);
    writeFileSync(join(temp, 'package', 'extra.js'), 'unexpected');
    assert.throws(() => verifyFiles(join(temp, 'package'), report));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('AF native128MiB expansion boundary remains finite', () => {
  const overhead = tar([
    entry('package/package.json', JSON.stringify(source)),
    entry('package/dist/index.js', ''),
  ]).length;
  const bytes = gzipSync(
    tar([
      entry('package/package.json', JSON.stringify(source)),
      entry('package/dist/index.js', Buffer.alloc(128 * 1024 * 1024 - overhead)),
    ]),
  );
  assert.equal(gunzipSync(bytes).length, 128 * 1024 * 1024);
  assert.equal(inspectCohortArchive(bytes, expected()).files.length, 2);
  const tooLarge = pack(source, [entry('package/dist/large', Buffer.alloc(128 * 1024 * 1024))]);
  refuses(tooLarge);
});
