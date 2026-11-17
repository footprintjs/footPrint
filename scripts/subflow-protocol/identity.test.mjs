import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
        assert.equal(onePhysicalReader(root, join(modules,'foottrace')).length,1);
        assert.ok(engineReaderResolution(root, join(modules, 'foottrace')).readerEntry.endsWith('foottrace/index.js'));
      }
    });
});
