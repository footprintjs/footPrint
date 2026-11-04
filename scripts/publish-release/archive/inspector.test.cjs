'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { gzipSync, gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { inspectArchive, archiveRefusalCode } = require('./inspector.cjs');
const { source, checksum, entry, tar, pack, expected } = require('./fixture.cjs');

function refuses(bytes, options = expected(), code = /^(invalid-archive|archive-profile|manifest-)/) {
  assert.throws(
    () => inspectArchive(bytes, options),
    (error) => {
      assert.match(archiveRefusalCode(error), code);
      assert.match(error.message, /^[a-z-]+$/);
      return true;
    },
  );
}

test('accepts the full source manifest except version and the one FP root addition', () => {
  const bytes = pack(undefined, [entry('package/AGENTS.md', 'Package instructions\n')]);
  const result = inspectArchive(bytes, expected());
  assert.equal(result.package, 'footprintjs');
  assert.equal(result.version, '11.0.0-rc.1');
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.shasum, createHash('sha1').update(bytes).digest('hex'));
  assert.equal(result.integrity, 'sha512-' + createHash('sha512').update(bytes).digest('base64'));
  assert.equal(result.bytes, bytes.length);
  assert.deepEqual(
    result.files.map((file) => file.path),
    ['package/package.json', 'package/dist/index.js', 'package/AGENTS.md'],
  );
});

test('key order changes do not change typed whole-source equality', () => {
  const manifest = Object.fromEntries(Object.entries({ ...source, version: '11.0.0-rc.1' }).reverse());
  assert.equal(inspectArchive(pack(manifest), expected()).version, '11.0.0-rc.1');
});

test('refuses duplicate object keys rather than letting the last value win', () => {
  // Full source manifest, with only its planned version changed. The duplicate
  // name repeats the same value, so manifest equality alone cannot find it.
  const manifest = JSON.stringify({ ...source, version: '11.0.0-rc.1' });
  const duplicate = manifest.slice(0, -1) + ',"name":"footprintjs"}';
  assert.throws(() => inspectArchive(pack(duplicate), expected()));
});

test('packed nested duplicate keys refuse even when the last value equals source', () => {
  const manifest = JSON.stringify({ ...source, version: '11.0.0-rc.1' });
  assert.ok(manifest.includes('"node":">=22"'));
  const duplicate = manifest.replace('"node":">=22"', '"node":">=22","no\\u0064e":">=22"');
  refuses(pack(duplicate), expected(), /^manifest-json:key-[a-f0-9]{12}$/);
});

for (const [field, value] of [
  ['tag', 'latest'],
  ['publishConfig', { registry: 'https://invalid.example/' }],
  ['scripts', { install: 'refused fixture' }],
  ['dependencies', { altered: '1.0.0' }],
  ['bin', 'altered'],
  ['license', 1],
  ['files', 'dist/**/*'],
])
  test('refuses source mismatch at ' + field, () => {
    refuses(
      pack({ ...source, version: '11.0.0-rc.1', [field]: value }),
      expected(),
      new RegExp('^manifest-source:' + field + '$'),
    );
  });

for (const [field, value] of [
  ['tag', 'latest'],
  ['dependencies', []],
  ['scripts', 'not an object'],
  ['license', 1],
])
  test('typed source difference is not trusted at ' + field, () => {
    refuses(
      pack(),
      { ...expected(), sourceManifest: { ...source, [field]: value } },
      new RegExp('^manifest-source:' + field + '$'),
    );
  });

test('unrelated Error objects do not acquire an archive refusal verdict', () => {
  assert.equal(archiveRefusalCode(Error('not an archive error')), undefined);
});

for (const key of ['', '\0', '\n', '__proto__', 'constructor', 'e\u0301', 'unknown-key'])
  test('unknown or control source key has a bounded hashed diagnostic: ' + JSON.stringify(key), () => {
    const changed = JSON.parse(JSON.stringify(source));
    Object.defineProperty(changed, key, { value: 'untrusted', enumerable: true });
    const code = 'manifest-source:key-' + createHash('sha256').update(key).digest('hex').slice(0, 12);
    refuses(pack(), { ...expected(), sourceManifest: changed }, new RegExp('^' + code + '$'));
  });

for (const value of [null, [], 'object', 1, false, undefined])
  test('source root refuses ' + String(value), () =>
    refuses(pack(), { ...expected(), sourceManifest: value }, /^manifest-source:root$/),
  );

test('sourceManifest is required, including when the packed identity looks right', () => {
  refuses(pack(), { package: 'footprintjs', version: '11.0.0-rc.1' }, /^manifest-source:root$/);
});

test('source JSON data does not invoke getters or toJSON', () => {
  let reads = 0;
  const accessor = { ...source };
  Object.defineProperty(accessor, 'description', {
    enumerable: true,
    get() {
      reads++;
      throw Error('private fixture');
    },
  });
  refuses(pack(), { ...expected(), sourceManifest: accessor });
  refuses(pack(), {
    ...expected(),
    sourceManifest: {
      ...source,
      toJSON() {
        reads++;
      },
    },
  });
  assert.equal(reads, 0);
});

test('source rejects cyclic, non-finite, sparse, inherited and symbolic data', () => {
  const cycle = { ...source };
  cycle.extra = cycle;
  const inherited = Object.assign(Object.create({ extra: true }), source);
  const symbol = { ...source, [Symbol('private')]: true };
  for (const value of [
    cycle,
    inherited,
    symbol,
    { ...source, extra: Infinity },
    { ...source, extra: [, 1] },
    { ...source, extra: new Date() },
  ])
    refuses(pack(), { ...expected(), sourceManifest: value }, /^manifest-source:root$/);
});

for (const value of [undefined, 1, false, null])
  test('source version remains a required string: ' + String(value), () => {
    refuses(
      pack(),
      { ...expected(), sourceManifest: { ...source, version: value } },
      /^manifest-source:(version|root)$/,
    );
  });

for (const manifest of ['[]', 'null', '"object"', '1', 'true'])
  test('packed manifest has an object root: ' + manifest, () =>
    refuses(pack(manifest), expected(), /^manifest-json:root$/),
  );

for (const name of ['package/.npmrc', 'package/binding.gyp', 'package/server.js'])
  test('profile refuses sibling ' + name + ' before reading malformed JSON', () => {
    refuses(pack('not JSON', [entry(name, 'fixture only')]), expected(), /^invalid-archive$/);
  });

for (const name of [
  'x/package.json',
  'Package/package.json',
  './package/package.json',
  'package//x',
  'package/./x',
  'package/../x',
  'package\\x',
  '/package/x',
])
  test('refuses archive path ' + JSON.stringify(name), () => refuses(pack(undefined, [entry(name, '{}')])));

for (const type of [0, 49, 50, 51, 53, 120, 103, 76, 75])
  test('refuses non-canonical tar type ' + type, () => {
    refuses(
      pack(undefined, [
        entry('package/dist/hostile', '', (header) => {
          header[156] = type;
        }),
      ]),
    );
  });

for (const [name, change] of [
  [
    'prefix',
    (header) => {
      header.write('prefix', 345);
    },
  ],
  [
    'link target',
    (header) => {
      header.write('target', 157);
    },
  ],
  [
    'owner',
    (header) => {
      header.write('owner', 265);
    },
  ],
  [
    'old GNU magic',
    (header) => {
      header.write('ustar  ', 257);
    },
  ],
  [
    'base256 mode',
    (header) => {
      header[100] = 128;
    },
  ],
  [
    'base256 uid',
    (header) => {
      header[108] = 128;
    },
  ],
  [
    'base256 mtime',
    (header) => {
      header[136] = 128;
    },
  ],
  [
    'embedded name NUL',
    (header) => {
      header.write('x\0hidden', 0, 'latin1');
    },
  ],
])
  test('refuses header ' + name, () => {
    refuses(pack(undefined, [entry('package/dist/header', '', change)]));
  });

test('refuses duplicate manifests and duplicate regular files', () => {
  for (const name of ['package/package.json', 'package/dist/index.js'])
    refuses(pack(undefined, [entry(name, '{}')]), expected(), /^invalid-archive$/);
});

test('refuses missing manifest or dist, bad checksum, padding and tar ending', () => {
  const manifest = entry('package/package.json', JSON.stringify({ ...source, version: '11.0.0-rc.1' }));
  const file = entry('package/dist/index.js', 'fixture');
  refuses(gzipSync(tar([manifest])));
  refuses(gzipSync(tar([file])));
  const checksumFault = gunzipSync(pack());
  checksumFault[148] = 57;
  refuses(gzipSync(checksumFault));
  const paddingFault = Buffer.from(file);
  paddingFault[512 + Buffer.byteLength('fixture')] = 1;
  refuses(gzipSync(tar([manifest, paddingFault])));
  refuses(gzipSync(Buffer.concat([manifest, file])));
  refuses(gzipSync(Buffer.concat([manifest, file, Buffer.alloc(512)])));
  refuses(gzipSync(Buffer.concat([tar([manifest, file]), Buffer.from([1])])));
});

test('refuses gzip flags, checksum, length, extra member and trailing bytes', () => {
  const original = pack();
  const flags = Buffer.from(original);
  flags[3] = 8;
  const crc = Buffer.from(original);
  crc[crc.length - 8] ^= 1;
  const size = Buffer.from(original);
  size[size.length - 4] ^= 1;
  for (const bytes of [
    flags,
    crc,
    size,
    Buffer.concat([original, original]),
    Buffer.concat([original, Buffer.alloc(1)]),
    original.subarray(0, -1),
    Buffer.alloc(0),
  ])
    refuses(bytes);
});

test('retains finite compressed, expanded and file-count bounds', () => {
  const bytes = pack();
  for (const bounds of [
    { maxArchiveBytes: bytes.length - 1 },
    { maxExpandedBytes: 512 },
    { maxFiles: 1 },
    { maxFiles: 0 },
    { maxArchiveBytes: Infinity },
    { maxExpandedBytes: NaN },
  ])
    refuses(bytes, { ...expected(), ...bounds });
  assert.equal(inspectArchive(bytes, { ...expected(), maxArchiveBytes: bytes.length }).bytes, bytes.length);
});
