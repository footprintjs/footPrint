import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { bindSource } from './bind-source.mjs';
import {
  digest,
  bytes,
  installedPackage,
  onePhysicalReader,
  strictLock,
  recordOutcome,
  source,
  command,
  engineReaderResolution,
} from './identity.mjs';
function scratch(run) {
  const root = mkdtempSync(join(tmpdir(), 'ho-protocol-identity-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true });
  }
}
function pkg(root, name) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
}
test('event source binding accepts the exact tree and refuses a different fetched tree', () =>
  scratch((root) => {
    command('git', ['init', '--quiet'], root);
    command('git', ['remote', 'add', 'origin', root], root);
    const commit = (contents) => {
      writeFileSync(join(root, 'source'), contents);
      command('git', ['add', 'source'], root);
      command('git', ['-c', 'user.name=Protocol fixture', '-c', 'user.email=fixture@example.invalid',
        '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture'], root);
      return command('git', ['rev-parse', 'HEAD'], root).trim();
    };
    const first = commit('first');
    bindSource(root, first);
    const second = commit('second');
    assert.throws(() => bindSource(root, first), /git failed/);
    bindSource(root, second);
    for (const invalid of [undefined, '', 'main', 'F'.repeat(40), 'a'.repeat(39), second + '\n'])
      assert.throws(() => bindSource(root, invalid), (error) =>
        error.code === 'ERR_ASSERTION' && !error.message.startsWith('git failed:'),
      );
    assert.equal(command('git', ['rev-parse', 'HEAD'], root).trim(), second);
  }));
test('bounded regular reads refuse links and excess before reading', () =>
  scratch((root) => {
    const file = join(root, 'bytes');
    writeFileSync(file, 'ok');
    assert.equal(bytes(file, 2).toString(), 'ok');
    assert.throws(() => bytes(file, 1));
    const link = join(root, 'link');
    symlinkSync(file, link);
    assert.throws(() => bytes(link, 2));
  }));
test('installed member inventory is exact and supports actual zero-byte members', () =>
  scratch((root) => {
    const directory = join(root, 'package');
    pkg(directory, 'foottrace');
    writeFileSync(join(directory, 'empty'), '');
    const files = ['package.json', 'empty'].map((name) => {
      const input = bytes(join(directory, name), 1000);
      return { path: 'package/' + name, size: input.length, sha256: digest(input) };
    });
    assert.equal(installedPackage(directory, { files }).files, 2);
    writeFileSync(join(directory, 'empty'), 'tampered');
    assert.throws(() => installedPackage(directory, { files }));
    writeFileSync(join(directory, 'empty'), '');
    writeFileSync(join(directory, 'extra'), 'x');
    assert.throws(() => installedPackage(directory, { files }));
  }));
test('the full physical inventory rejects a second nested reader and linked installs', () =>
  scratch((root) => {
    const modules = join(root, 'node_modules');
    pkg(join(modules, 'foottrace'), 'foottrace');
    pkg(join(modules, 'footprintjs'), 'footprintjs');
    assert.equal(onePhysicalReader(root, join(modules, 'foottrace')).length, 1);
    pkg(join(modules, 'footprintjs/node_modules/foottrace'), 'foottrace');
    assert.throws(() => onePhysicalReader(root, join(modules, 'foottrace')));
  }));
test('lock identity requires exact file-tarball source and integrity', () =>
  scratch((root) => {
    const archive = join(root, 'input.tgz');
    writeFileSync(archive, 'bytes');
    const inspection = { version: '1.0.0', integrity: 'sha512-exact' };
    const write = (entry) =>
      writeFileSync(
        join(root, 'package-lock.json'),
        JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/foottrace': entry } }),
      );
    const entry = { version: '1.0.0', resolved: 'file:' + archive, integrity: inspection.integrity };
    write(entry);
    const packages = [{ name: 'foottrace', archive, inspection }];
    assert.ok(strictLock(root, packages).sha256);
    write({ ...entry, integrity: 'sha512-other' });
    assert.throws(() => strictLock(root, packages));
    write({ ...entry, resolved: 'https://registry.npmjs.org/source.tgz' });
    assert.throws(() => strictLock(root, packages));
  }));

test('receipt failures preserve each exact primary failure rather than turning a failed command green', () => {
  for (const original of [new Error('primary'), null, undefined, 0, false]) {
    let caught = false,
      actual,
      secondary;
    try {
      recordOutcome(
        () => {
          throw original;
        },
        () => {
          throw new Error('receipt');
        },
        (error) => {
          secondary = error;
        },
      );
    } catch (error) {
      caught = true;
      actual = error;
    }
    assert.equal(caught, true);
    assert.equal(actual, original);
    assert.equal(secondary.message, 'receipt');
  }
  assert.throws(
    () =>
      recordOutcome(
        () => ({ status: 'PASS' }),
        () => {
          throw new Error('receipt');
        },
        () => {},
      ),
    /receipt/,
  );
});

test('source identity binds the exact commit and original tracked manifest', () =>
  scratch((root) => {
    command('git', ['init', '--quiet'], root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'foottrace', version: '1.0.0' }));
    command('git', ['add', 'package.json'], root);
    command(
      'git',
      [
        '-c',
        'user.name=Protocol fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '-m',
        'fixture',
      ],
      root,
    );
    const head = command('git', ['rev-parse', 'HEAD'], root).trim();
    assert.equal(source(root, head).head, head);
    assert.throws(() => source(root, 'f'.repeat(40)));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'foottrace', version: '9.0.0' }));
    assert.throws(() => source(root, head));
  }));

test('a reader shadowed under the actual engine dist entry is a second physical copy', () =>
  scratch((root) => {
    const modules = join(root, 'node_modules');
    pkg(join(modules, 'foottrace'), 'foottrace');
    pkg(join(modules, 'footprintjs'), 'footprintjs');
    pkg(join(modules, 'footprintjs/dist/node_modules/foottrace'), 'foottrace');
    assert.throws(() => onePhysicalReader(root, join(modules, 'foottrace')));
  }));

test('reader resolution is checked from a fresh actual installed engine entry', () => {
  for (const shadow of [false, true])
    scratch((root) => {
      const modules = join(root, 'node_modules');
      pkg(join(modules, 'foottrace'), 'foottrace');
      writeFileSync(join(modules, 'foottrace/index.js'), 'module.exports={};');
      pkg(join(modules, 'footprintjs'), 'footprintjs');
      mkdirSync(join(modules, 'footprintjs/dist'));
      writeFileSync(
        join(modules, 'footprintjs/package.json'),
        JSON.stringify({ name: 'footprintjs', version: '1.0.0', main: 'dist/index.js' }),
      );
      writeFileSync(join(modules, 'footprintjs/dist/index.js'), 'module.exports={};');
      if (shadow) {
        pkg(join(modules, 'footprintjs/dist/node_modules/foottrace'), 'foottrace');
        writeFileSync(join(modules, 'footprintjs/dist/node_modules/foottrace/index.js'), 'module.exports={};');
        assert.throws(() => engineReaderResolution(root, join(modules, 'foottrace')));
      } else {
        assert.equal(onePhysicalReader(root, join(modules, 'foottrace')).length, 1);
        assert.ok(engineReaderResolution(root, join(modules, 'foottrace')).readerEntry.endsWith('foottrace/index.js'));
      }
    });
});

test('physical foottrace resolution roots cannot hide behind a different manifest name', () => {
  for (const shadow of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'ho-renamed-reader-'));
    try {
      const reader = join(root, 'node_modules/foottrace'),
        engine = join(root, 'node_modules/footprintjs');
      function put(dir, manifest, code) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
        writeFileSync(join(dir, 'index.cjs'), code);
      }
      put(reader, { name: 'foottrace', main: 'index.cjs' }, "module.exports='admitted';");
      put(engine, { name: 'footprintjs', main: 'dist/index.cjs' }, '');
      mkdirSync(join(engine, 'dist/lib'), { recursive: true });
      writeFileSync(join(engine, 'dist/index.cjs'), "module.exports=require('./lib/read.cjs');");
      writeFileSync(join(engine, 'dist/lib/read.cjs'), "module.exports=require('foottrace');");
      if (shadow)
        put(
          join(engine, 'dist/lib/node_modules/foottrace'),
          { name: 'different-name', main: 'index.cjs' },
          "module.exports='shadow';",
        );
      const files = [];
      function inventory(dir) {
        for (const name of readdirSync(dir)) {
          const file = join(dir, name);
          if (statSync(file).isDirectory()) inventory(file);
          else {
            const b = readFileSync(file);
            files.push({ path: 'package/' + relative(engine, file), size: b.length, sha256: digest(b) });
          }
        }
      }
      inventory(engine);
      assert.equal(installedPackage(engine, { files }).files, files.length);
      assert.ok(engineReaderResolution(root, reader).readerEntry.endsWith('foottrace/index.cjs'));
      assert.equal(createRequire(join(root, 'verify.cjs'))('footprintjs'), shadow ? 'shadow' : 'admitted');
      if (shadow) assert.throws(() => onePhysicalReader(root, reader));
      else assert.equal(onePhysicalReader(root, reader).length, 1);
    } finally {
      rmSync(root, { recursive: true });
    }
  }
});

test('physical reader census also rejects actual CJS file fallback shadows', () => {
  for (const extension of ['js', 'json'])
    scratch((root) => {
      const modules = join(root, 'node_modules');
      pkg(join(modules, 'foottrace'), 'foottrace');
      writeFileSync(join(modules, 'foottrace/index.js'), "module.exports='admitted';");
      const importer = join(modules, 'footprintjs/dist/lib');
      mkdirSync(join(importer, 'node_modules'), { recursive: true });
      writeFileSync(
        join(importer, 'node_modules/foottrace.' + extension),
        extension === 'json' ? '"shadow"' : "module.exports='shadow';",
      );
      assert.equal(createRequire(join(importer, 'read.cjs'))('foottrace'), 'shadow');
      assert.throws(() => onePhysicalReader(root, join(modules, 'foottrace')));
    });
});
