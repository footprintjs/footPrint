// Inert ports witness metadata phases without npm, Git or product execution.
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
import { CANDIDATE, COHORTS } from './plan.mjs';
import { sha256 } from './identity.mjs';
import { runSweep } from './run.mjs';

const HEAD = 'e'.repeat(40);
function fixture(t, { cohort = 'agentfootprint', lock = true, fail } = {}) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'ft-metadata-phase-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const source = join(parent, 'source'),
    work = join(parent, 'evidence');
  mkdirSync(source);
  const manifest = join(source, 'package.json'),
    lockfile = join(source, 'package-lock.json');
  const original = Buffer.from(
    `${JSON.stringify(
      {
        name: COHORTS[cohort].name,
        version: '1.0.0-fixture',
        dependencies: { foottrace: '^1.11.0' },
        peerDependencies: { foottrace: '^1.11.0' },
      },
      null,
      4,
    )}\n`,
  );
  const originalLock = Buffer.from('{ "lockfileVersion": 3, "original": true }\n');
  const generated = Buffer.from('{"lockfileVersion":3,"candidate":true}\n');
  writeFileSync(manifest, original);
  chmodSync(manifest, 0o640);
  if (lock) {
    writeFileSync(lockfile, originalLock);
    chmodSync(lockfile, 0o600);
  }
  const tar = join(parent, 'foottrace-1.11.1.tgz');
  writeFileSync(tar, 'inert candidate');
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
  const image = join(source, 'node_modules', 'foottrace', 'inert-installed-image');
  const imageBytes = Buffer.from('one installed candidate image');
  let imageInode,
    installs = 0,
    graphChecks = 0;
  const seenSource = [],
    seenCandidate = [];
  function assertOriginal() {
    assert.deepEqual(readFileSync(manifest), original);
    assert.equal(lstatSync(manifest).mode & 0o777, 0o640);
    if (lock) {
      assert.deepEqual(readFileSync(lockfile), originalLock);
      assert.equal(lstatSync(lockfile).mode & 0o777, 0o600);
    } else assert.equal(existsSync(lockfile), false);
  }
  function assertCandidate() {
    const current = JSON.parse(readFileSync(manifest));
    assert.equal(current.version, '1.0.0-fixture');
    assert.equal(current.devDependencies.foottrace, `file:${tar}`);
    assert.equal(current.dependencies?.foottrace, undefined);
    assert.deepEqual(readFileSync(lockfile), generated);
  }
  function assertSameImage() {
    assert.deepEqual(readFileSync(image), imageBytes);
    assert.equal(lstatSync(image).ino, imageInode);
    assert.equal(lstatSync(image).mode & 0o777, 0o444);
  }
  const command = (program, args, { cwd }) => {
    const label = args[0] === 'run' ? args[1] : args[0];
    if (program === 'git') {
      if (label === 'diff') {
        assertOriginal();
        assertSameImage();
      }
      return `${HEAD}\n`;
    }
    if (label === 'install') {
      assert.equal(JSON.parse(readFileSync(join(cwd, 'package.json'))).devDependencies.foottrace, `file:${tar}`);
      writeFileSync(join(cwd, 'package-lock.json'), generated);
      return '';
    }
    if (label === 'ci' || label === 'ls') {
      assertCandidate();
      seenCandidate.push(label);
      if (label === 'ci') {
        installs++;
        mkdirSync(join(source, 'node_modules', 'foottrace'), { recursive: true });
        writeFileSync(image, imageBytes);
        chmodSync(image, 0o444);
        imageInode = lstatSync(image).ino;
      }
      assertSameImage();
    } else {
      assertOriginal();
      assertSameImage();
      seenSource.push([program, args[0] === 'test' ? ['test'] : args]);
    }
    if (label === fail) throw Error(`controlled ${fail} failure`);
    if (fail === 'source-mutates-manifest' && label === 'build') writeFileSync(manifest, '{}\n');
    if (label === 'ls' && args.includes('--json')) return '{"inert":true}';
    if (label === 'test')
      writeFileSync(
        join(work, 'evidence', 'whole.json'),
        JSON.stringify({
          success: true,
          numTotalTests: 1,
          numPassedTests: 1,
          numFailedTests: 0,
          numPendingTests: 0,
        }),
      );
    return '';
  };
  return {
    work,
    seenSource,
    seenCandidate,
    assertOriginal,
    assertSameImage,
    installs: () => installs,
    options: { cohort, source, work, tar, metadata, consumerCommit: HEAD },
    ports: {
      command,
      inspectCandidate: () => metadata,
      verifyInstalled: async () => {
        assertCandidate();
        assertSameImage();
        graphChecks++;
        if (fail === 'after-graph' && graphChecks === 2) throw Error('controlled after-graph failure');
        return { ok: true, inert: true };
      },
    },
  };
}

for (const cohort of Object.keys(COHORTS)) {
  for (const lock of [true, false]) {
    test(`${cohort}: original metadata during every source command; lock originally ${
      lock ? 'present' : 'absent'
    }`, async (t) => {
      const f = fixture(t, { cohort, lock });
      await runSweep(f.options, f.ports);
      assert.deepEqual(f.seenSource, COHORTS[cohort].commands);
      assert.deepEqual(f.seenCandidate, ['ci', 'ls', 'ls', 'ls', 'ls']);
      assert.equal(f.installs(), 1);
      f.assertOriginal();
      f.assertSameImage();
      assert.equal(JSON.parse(readFileSync(join(f.work, 'evidence', 'restoration.json'))).status, 'PASS');
    });
  }
}

for (const fail of ['ci', 'build', 'test:contract:foottrace', 'test', 'after-graph']) {
  for (const lock of [true, false]) {
    test(`${fail} failure restores exact original bytes/modes/${lock ? 'lock' : 'absence'}`, async (t) => {
      const f = fixture(t, { fail, lock });
      await assert.rejects(runSweep(f.options, f.ports), new RegExp(`controlled ${fail} failure`));
      f.assertOriginal();
      f.assertSameImage();
      assert.equal(f.installs(), 1);
      assert.equal(JSON.parse(readFileSync(join(f.work, 'evidence', 'result.json'))).status, 'FAIL');
      assert.equal(JSON.parse(readFileSync(join(f.work, 'evidence', 'restoration.json'))).status, 'PASS');
    });
  }
}

test('a source command changing metadata is a failure, not silently repaired before later tests', async (t) => {
  const f = fixture(t, { fail: 'source-mutates-manifest' });
  await assert.rejects(runSweep(f.options, f.ports), /metadata bytes changed/u);
  assert.deepEqual(f.seenSource, [['npm', ['run', 'build']]]);
  f.assertOriginal();
  f.assertSameImage();
});
