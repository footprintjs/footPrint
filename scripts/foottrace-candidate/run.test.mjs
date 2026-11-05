// Inert driver fixtures only: no npm, Git, registry, build or product suite runs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CANDIDATE, candidateManifest, requireMetadata } from './plan.mjs';
import { assertInstalledImage, inspectCandidate, sha256, verifyInstalled } from './identity.mjs';
import { runSweep } from './run.mjs';

const HEAD = 'e'.repeat(40);
function fixture(t, { fail, lock = true, cohort = 'agentfootprint' } = {}) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'ft-sweep-fixture-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const source = join(parent, 'source'),
    work = join(parent, 'evidence');
  mkdirSync(source);
  const original = Buffer.from(
    `${JSON.stringify({
      name: cohort,
      version: '13.0.0',
      dependencies: { foottrace: '^1.11.0', other: '1.0.0' },
      devDependencies: { vitest: '4.1.12' },
      peerDependencies: { foottrace: '^1.11.0' },
    })}\n`,
  );
  const manifest = join(source, 'package.json'),
    lockfile = join(source, 'package-lock.json');
  writeFileSync(manifest, original);
  chmodSync(manifest, 0o640);
  const oldLock = Buffer.from('{"lockfileVersion":3,"packages":{}}\n');
  if (lock) {
    writeFileSync(lockfile, oldLock);
    chmodSync(lockfile, 0o600);
  }
  const tar = join(parent, 'foottrace-1.11.1.tgz');
  writeFileSync(tar, 'inert archive identity fixture');
  const metadata = {
    schema: 1,
    label: 'offline; not published',
    head: CANDIDATE.commit,
    tree: CANDIDATE.tree,
    package: 'foottrace',
    version: '1.11.1',
    commands: [],
    node: 'fixture',
    npm: 'fixture',
    sha256: sha256(readFileSync(tar)),
    shasum: 'b'.repeat(40),
    integrity: `sha512-${createHash('sha512').update(readFileSync(tar)).digest('base64')}`,
    bytes: readFileSync(tar).length,
    files: [{ path: 'package/package.json', size: 1, sha256: 'c'.repeat(64) }],
  };
  const calls = [];
  function command(program, args, { cwd }) {
    const label = args[0] === 'run' ? args[1] : args[0];
    calls.push({ program, args, cwd, label });
    if (program === 'git') return `${HEAD}\n`;
    if (label === 'install') {
      const planned = JSON.parse(readFileSync(join(cwd, 'package.json')));
      assert.equal(planned.version, '13.0.0', 'source version never rewritten');
      assert.equal(planned.devDependencies.foottrace, `file:${tar}`);
      assert.deepEqual(planned.peerDependencies, { foottrace: '^1.11.0' });
      writeFileSync(join(cwd, 'package-lock.json'), '{"lockfileVersion":3,"candidate":true}\n');
      return '';
    }
    // Every install and proof command observes the temporary candidate metadata.
    assert.equal(JSON.parse(readFileSync(manifest)).devDependencies.foottrace, `file:${tar}`);
    assert.equal(JSON.parse(readFileSync(lockfile)).candidate, true);
    if (label === fail) throw Error(`controlled ${fail} failure`);
    if (label === 'ls' && args.includes('--json')) return '{"fake":"tree"}';
    if (label === 'test')
      writeFileSync(
        join(work, 'whole.json'),
        JSON.stringify({
          success: true,
          numTotalTests: 3,
          numPassedTests: 3,
          numFailedTests: 0,
          numPendingTests: 0,
        }),
      );
    return '';
  }
  return {
    source,
    work,
    original,
    oldLock,
    manifest,
    lockfile,
    calls,
    options: { cohort, source, work, tar, metadata, consumerCommit: HEAD },
    ports: {
      command,
      inspectCandidate: () => metadata,
      verifyInstalled: async ({ tree }) => {
        assert.deepEqual(tree, { fake: 'tree' });
        return { ok: true };
      },
    },
  };
}

function restored(f, lock) {
  assert.deepEqual(readFileSync(f.manifest), f.original);
  assert.equal(lstatSync(f.manifest).mode & 0o777, 0o640);
  if (lock) {
    assert.deepEqual(readFileSync(f.lockfile), f.oldLock);
    assert.equal(lstatSync(f.lockfile).mode & 0o777, 0o600);
  } else assert.equal(existsSync(f.lockfile), false);
  assert.equal(JSON.parse(readFileSync(join(f.work, 'restoration.json'))).status, 'PASS');
}

test('concrete install requests move to dev only; peers and source identity stay unchanged', () => {
  const original = {
    name: 'footprintjs',
    version: '10.7.1',
    dependencies: { foottrace: '^1.11.0', x: '1' },
    optionalDependencies: { foottrace: '^1.11.0' },
    peerDependencies: { foottrace: '^1.11.0' },
  };
  const saved = structuredClone(original);
  const { manifest, replaced } = candidateManifest(original, '/tmp/foottrace-1.11.1.tgz', 'footprintjs');
  assert.deepEqual(original, saved);
  assert.equal(manifest.version, '10.7.1');
  assert.deepEqual(manifest.dependencies, { x: '1' });
  assert.deepEqual(manifest.peerDependencies, saved.peerDependencies);
  assert.deepEqual(replaced, { dependencies: '^1.11.0', optionalDependencies: '^1.11.0' });
  assert.equal(manifest.devDependencies.foottrace, 'file:/tmp/foottrace-1.11.1.tgz');
  assert.equal(Object.hasOwn(manifest, 'overrides'), false);
  assert.throws(() => candidateManifest(original, '/tmp/candidate.tgz', 'unknown'), /unknown cohort/u);
  assert.throws(() => candidateManifest(original, '/tmp/candidate.tgz', 'agentfootprint'), /wrong source package/u);
});

test('successful driver holds temporary metadata through build, contract, whole and final graph check', async (t) => {
  const f = fixture(t);
  await runSweep(f.options, f.ports);
  restored(f, true);
  assert.deepEqual(
    f.calls.map(({ label }) => label),
    ['rev-parse', 'install', 'ci', 'ls', 'ls', 'build', 'test:contract:foottrace', 'test', 'ls', 'ls', 'diff'],
  );
  assert.deepEqual(f.calls.find(({ label }) => label === 'install').args, [
    'install',
    '--strict-peer-deps',
    '--no-audit',
    '--no-fund',
  ]);
  assert.deepEqual(f.calls.find(({ label }) => label === 'ci').args, [
    'ci',
    '--strict-peer-deps',
    '--no-audit',
    '--no-fund',
  ]);
  assert.deepEqual(f.calls.find(({ label }) => label === 'test').args, [
    'test',
    '--',
    '--reporter=json',
    `--outputFile=${join(f.work, 'whole.json')}`,
  ]);
  assert.equal(JSON.parse(readFileSync(join(f.work, 'result.json'))).whole.total, 3);
});

for (const failure of ['ci', 'build', 'test:contract:foottrace', 'test', 'ls']) {
  test(`${failure} failure is fatal, stops later commands and restores both original files`, async (t) => {
    const f = fixture(t, { fail: failure });
    await assert.rejects(runSweep(f.options, f.ports), new RegExp(`controlled ${failure} failure`));
    restored(f, true);
    assert.equal(f.calls.at(-1).label, failure);
    assert.equal(JSON.parse(readFileSync(join(f.work, 'result.json'))).status, 'FAIL');
  });
}

test('absent original lock stays absent after a failed candidate install', async (t) => {
  const f = fixture(t, { fail: 'ci', lock: false });
  await assert.rejects(runSweep(f.options, f.ports), /controlled ci failure/u);
  restored(f, false);
});

test('restoration failure remains fatal and does not prevent restoring the other original', async (t) => {
  const f = fixture(t);
  const normal = f.ports.command;
  f.ports.command = (program, args, context) => {
    const output = normal(program, args, context);
    if (args[0] === 'ci') {
      rmSync(f.manifest);
      mkdirSync(f.manifest);
      throw Error('controlled install failure and obstructed manifest');
    }
    return output;
  };
  await assert.rejects(runSweep(f.options, f.ports), AggregateError);
  assert.deepEqual(readFileSync(f.lockfile), f.oldLock);
  assert.equal(JSON.parse(readFileSync(join(f.work, 'restoration.json'))).status, 'FAIL');
  assert.equal(JSON.parse(readFileSync(join(f.work, 'result.json'))).status, 'FAIL');
});

test('work inside the checkout is refused before any command', async (t) => {
  const f = fixture(t);
  await assert.rejects(runSweep({ ...f.options, work: join(f.source, 'evidence') }, f.ports), /disjoint/u);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(readFileSync(f.manifest), f.original);
});

test('producer metadata cannot silently identify an RC or another proposal head', (t) => {
  const f = fixture(t);
  assert.equal(requireMetadata(f.options.metadata).version, '1.11.1');
  assert.throws(() => requireMetadata({ ...f.options.metadata, version: '1.11.1-rc.0' }));
  assert.throws(() => requireMetadata({ ...f.options.metadata, head: 'f'.repeat(40) }));
});

test('producer metadata refuses a different valid Git tree', (t) => {
  const f = fixture(t);
  assert.throws(() => requireMetadata({ ...f.options.metadata, tree: 'f'.repeat(40) }), /tree/u);
});

test('an override cannot silently replace normal candidate resolution', () => {
  const manifest = {
    name: 'footprintjs',
    version: '10.7.1',
    dependencies: { foottrace: '^1.11.0' },
    overrides: { foottrace: '^1.11.0' },
  };
  assert.throws(() => candidateManifest(manifest, '/tmp/candidate.tgz', 'footprintjs'), /override/u);
});

test('uploaded archive digest must still equal the producer report', (t) => {
  const f = fixture(t);
  assert.equal(inspectCandidate(f.options).sha256, f.options.metadata.sha256);
  writeFileSync(f.options.tar, 'mutated bytes');
  assert.throws(() => inspectCandidate(f.options));
});

for (const field of ['sha256', 'integrity', 'bytes']) {
  test(`actual archive bytes must agree with the producer ${field}`, (t) => {
    const f = fixture(t);
    const wrong = { sha256: 'f'.repeat(64), integrity: 'sha512-forged', bytes: f.options.metadata.bytes + 1 };
    assert.throws(() => inspectCandidate({ ...f.options, metadata: { ...f.options.metadata, [field]: wrong[field] } }));
  });
}

test('installed file mutation or extra file refuses candidate equality', (t) => {
  const f = fixture(t),
    image = join(f.source, 'image');
  mkdirSync(image);
  const bytes = Buffer.from('{"name":"foottrace","version":"1.11.1"}\n');
  writeFileSync(join(image, 'package.json'), bytes);
  const report = { files: [{ path: 'package/package.json', sha256: sha256(bytes) }] };
  assert.equal(assertInstalledImage(image, report).files, 1);
  writeFileSync(join(image, 'extra.js'), 'unreviewed');
  assert.throws(() => assertInstalledImage(image, report), /bytes differ/u);
  rmSync(join(image, 'extra.js'));
  writeFileSync(join(image, 'package.json'), '{}');
  assert.throws(() => assertInstalledImage(image, report), /bytes differ/u);
});

test('the real installed-tree law accepts one owner and refuses an identical nested copy', async (t) => {
  const f = fixture(t),
    installed = join(f.source, 'node_modules/foottrace');
  mkdirSync(installed, { recursive: true });
  const bytes = Buffer.from('{"name":"foottrace","version":"1.11.1"}\n');
  writeFileSync(join(installed, 'package.json'), bytes);
  const report = { files: [{ path: 'package/package.json', sha256: sha256(bytes) }] };
  const entry = (path) => ({ name: 'foottrace', version: '1.11.1', path });
  const tree = {
    name: 'consumer',
    path: f.source,
    _dependencies: { foottrace: '*' },
    dependencies: { foottrace: entry(installed) },
  };
  const result = await verifyInstalled({ source: f.source, tree, report });
  assert.equal(result.ok, true);
  assert.equal(result.path, realpathSync(installed));
  const nested = join(f.source, 'node_modules/engine/node_modules/foottrace');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, 'package.json'), bytes);
  tree.dependencies.engine = { dependencies: { foottrace: entry(nested) } };
  await assert.rejects(verifyInstalled({ source: f.source, tree, report }), /one physical instance/u);
});
