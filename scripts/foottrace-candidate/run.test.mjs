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
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { CANDIDATE, candidateManifest, requireMetadata } from './plan.mjs';
import { assertInstalledImage, inspectCandidate, sha256, verifyInstalled } from './identity.mjs';
import { command as actualSweepCommand, runSweep } from './run.mjs';

const HEAD = 'e'.repeat(40);

test('the uploaded proof directory is separate from resolver runtime trees', async (t) => {
  const f = fixture(t);
  await runSweep(f.options, f.ports);
  assert.equal(existsSync(join(f.work, 'evidence')), true, 'a dedicated proof directory is required');
});
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
      // Inert npm port: model the relative local leaf emitted by a resolver, not a production-lock edit.
      writeFileSync(
        join(cwd, 'package-lock.json'),
        `${JSON.stringify({
          lockfileVersion: 3,
          candidate: true,
          packages: {
            '': { devDependencies: { foottrace: planned.devDependencies.foottrace } },
            'node_modules/foottrace': {
              version: '1.11.1',
              resolved: `file:${relative(cwd, tar)}`,
              integrity: 'sha512-inert',
            },
          },
        })}\n`,
      );
      return '';
    }
    if (label === 'ci' || label === 'ls') {
      assert.equal(JSON.parse(readFileSync(manifest)).devDependencies.foottrace, `file:${tar}`);
      assert.equal(JSON.parse(readFileSync(lockfile)).candidate, true);
    } else {
      assert.deepEqual(readFileSync(manifest), original, 'source commands use the exact source manifest');
      assert.equal(lstatSync(manifest).mode & 0o777, 0o640);
      if (lock) {
        assert.deepEqual(readFileSync(lockfile), oldLock, 'source commands use the exact source lock');
        assert.equal(lstatSync(lockfile).mode & 0o777, 0o600);
      } else assert.equal(existsSync(lockfile), false, 'source lock absence is preserved');
    }
    if (label === 'ci') {
      mkdirSync(join(source, 'node_modules'), { recursive: true });
      writeFileSync(join(source, 'node_modules/.package-lock.json'), readFileSync(lockfile));
    }
    if (label === fail) throw Error(`controlled ${fail} failure`);
    if (label === 'ls' && args.includes('--json')) return '{"fake":"tree"}';
    if (label === 'test')
      writeFileSync(
        join(work, 'evidence', 'whole.json'),
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
  assert.equal(JSON.parse(readFileSync(join(f.work, 'evidence', 'restoration.json'))).status, 'PASS');
}

for (const alias of [false, true]) {
  test(`resolver sibling preserves local-lock meaning at source (source alias ${alias})`, async (t) => {
    const f = fixture(t);
    let suppliedSource = f.source;
    if (alias) {
      suppliedSource = join(dirname(f.source), 'source-alias');
      symlinkSync(f.source, suppliedSource, 'dir');
    }
    await runSweep({ ...f.options, source: suppliedSource }, f.ports);
    const resolver = f.calls.find(({ label }) => label === 'install').cwd;
    assert.equal(dirname(resolver), dirname(realpathSync(f.source)), 'resolver must be a canonical source sibling');
    assert.equal(basename(resolver), `${basename(realpathSync(f.source))}-foottrace-resolve`);
    const retained = readFileSync(join(f.work, 'evidence', 'candidate-lock.json'));
    assert.deepEqual(
      readFileSync(join(resolver, 'package-lock.json')),
      retained,
      'normal generated lock is retained verbatim',
    );
    const leaf = JSON.parse(retained).packages['node_modules/foottrace'].resolved;
    assert.ok(leaf.startsWith('file:'));
    for (const base of [resolver, realpathSync(f.source)]) {
      assert.equal(
        resolve(base, leaf.slice(5)),
        realpathSync(f.options.tar),
        'one local leaf must name the same archive',
      );
      assert.equal(realpathSync(resolve(base, leaf.slice(5))), realpathSync(f.options.tar));
    }
    restored(f, true);
  });
}

for (const collision of ['file', 'directory', 'dangling-symlink']) {
  test(`pre-existing sibling resolver ${collision} is refused without deleting history`, async (t) => {
    const f = fixture(t);
    const resolver = join(dirname(f.source), `${basename(f.source)}-foottrace-resolve`);
    if (collision === 'file') writeFileSync(resolver, 'preserved resolver file');
    else if (collision === 'directory') {
      mkdirSync(resolver);
      writeFileSync(join(resolver, 'old-evidence'), 'preserved resolver directory');
    } else symlinkSync(join(dirname(f.source), 'missing-target'), resolver);
    await assert.rejects(runSweep(f.options, f.ports), /fresh sibling resolver/u);
    assert.deepEqual(f.calls, []);
    assert.equal(existsSync(f.work), false, 'collision refuses before creating a new work tree');
    assert.equal(lstatSync(resolver).isSymbolicLink(), collision === 'dangling-symlink');
    if (collision === 'file') assert.equal(readFileSync(resolver, 'utf8'), 'preserved resolver file');
    if (collision === 'directory')
      assert.equal(readFileSync(join(resolver, 'old-evidence'), 'utf8'), 'preserved resolver directory');
    assert.deepEqual(readFileSync(f.manifest), f.original);
  });
}

test('a work path colliding with the sibling resolver is refused before any command', async (t) => {
  const f = fixture(t);
  const resolver = join(dirname(f.source), `${basename(f.source)}-foottrace-resolve`);
  await assert.rejects(runSweep({ ...f.options, work: resolver }, f.ports), /resolver and work must be disjoint/u);
  assert.deepEqual(f.calls, []);
  assert.equal(existsSync(resolver), false);
  assert.deepEqual(readFileSync(f.manifest), f.original);
});

test('a lock generated deeper than the consumer refuses before ci', async (t) => {
  const f = fixture(t);
  const command = f.ports.command;
  f.ports.command = (program, args, options) => {
    const result = command(program, args, options);
    if (args[0] === 'install') {
      const path = join(options.cwd, 'package-lock.json');
      const lock = JSON.parse(readFileSync(path));
      lock.packages['node_modules/foottrace'].resolved = `file:${relative(join(f.work, 'deeper'), f.options.tar)}`;
      writeFileSync(path, JSON.stringify(lock));
    }
    return result;
  };
  await assert.rejects(runSweep(f.options, f.ports), /generated lock must name the candidate at the consumer/u);
  assert.equal(
    f.calls.some(({ label }) => label === 'ci'),
    false,
  );
  assert.deepEqual(readFileSync(f.manifest), f.original);
});

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

test('successful driver uses original source metadata for source commands and candidate metadata for graph checks', async (t) => {
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
    `--outputFile=${join(f.work, 'evidence', 'whole.json')}`,
  ]);
  assert.equal(JSON.parse(readFileSync(join(f.work, 'evidence', 'result.json'))).whole.total, 3);
});

for (const failure of ['ci', 'build', 'test:contract:foottrace', 'test', 'ls']) {
  test(`${failure} failure is fatal, stops later commands and restores both original files`, async (t) => {
    const f = fixture(t, { fail: failure });
    await assert.rejects(runSweep(f.options, f.ports), new RegExp(`controlled ${failure} failure`));
    restored(f, true);
    assert.equal(f.calls.at(-1).label, failure);
    assert.equal(JSON.parse(readFileSync(join(f.work, 'evidence', 'result.json'))).status, 'FAIL');
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
  assert.equal(JSON.parse(readFileSync(join(f.work, 'evidence', 'restoration.json'))).status, 'FAIL');
  assert.equal(JSON.parse(readFileSync(join(f.work, 'evidence', 'result.json'))).status, 'FAIL');
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

// Artifact fixtures use inert command ports and representative runtime data.

function artifactFiles(root) {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? artifactFiles(path).map((name) => `${entry.name}/${name}`) : [entry.name];
    })
    .sort();
}

for (const fail of [undefined, 'test']) {
  test(`artifact boundary retains all proof outputs after ${
    fail ? 'whole failure' : 'success'
  }, without runtime trees`, async (t) => {
    const f = fixture(t, { fail });
    const evidence = join(f.work, 'evidence');
    const normal = f.ports.command;
    const logPrefixes = [];
    let resolverDirectory;
    f.ports.command = (program, args, context) => {
      const label = args[0] === 'run' ? args[1] : args[0];
      let output = '',
        error;
      try {
        output = normal(program, args, context);
        if (program === 'npm' && args[0] === 'install') {
          resolverDirectory = context.cwd;
          const installed = join(resolverDirectory, 'node_modules/not-artifact-data');
          mkdirSync(installed, { recursive: true });
          writeFileSync(join(installed, 'package.json'), '{"name":"not-artifact-data"}');
          writeFileSync(join(context.env.npm_config_cache, 'resolver-cache'), 'not proof output');
          writeFileSync(join(context.env.HOME, 'runtime-file'), 'not proof output');
        }
        return output;
      } catch (caught) {
        error = caught;
        // An inert failed-report fixture, not a product count or execution claim.
        if (label === 'test')
          writeFileSync(
            join(evidence, 'whole.json'),
            JSON.stringify({
              success: false,
              numTotalTests: 3,
              numPassedTests: 2,
              numFailedTests: 1,
              numPendingTests: 0,
            }),
          );
        throw caught;
      } finally {
        // Match the actual command port's log-before-refusal contract.
        logPrefixes.push(context.log);
        writeFileSync(`${context.log}.stdout`, output);
        writeFileSync(`${context.log}.stderr`, error ? error.message : '');
        writeFileSync(
          `${context.log}.json`,
          JSON.stringify({
            program,
            args,
            cwd: context.cwd,
            status: error ? 1 : 0,
            signal: null,
          }),
        );
      }
    };
    if (fail) await assert.rejects(runSweep(f.options, f.ports), /controlled test failure/u);
    else await runSweep(f.options, f.ports);
    restored(f, true);
    assert.equal(JSON.parse(readFileSync(join(evidence, 'result.json'))).status, fail ? 'FAIL' : 'PASS');
    assert.equal(JSON.parse(readFileSync(join(evidence, 'whole.json'))).success, !fail);

    const expected = [
      'user.npmrc',
      'global.npmrc',
      'candidate.json',
      'replaced.json',
      'candidate-lock.json',
      'installed-hidden-lock.json',
      'before-hidden-lock.json',
      'before-installed.json',
      'whole.json',
      'result.json',
      'restoration.json',
      ...(!fail ? ['after-hidden-lock.json', 'after-installed.json'] : []),
    ];
    for (const prefix of logPrefixes) {
      const name = relative(evidence, prefix);
      assert.ok(name && !name.startsWith('..') && !name.includes('/'), 'every command log belongs to evidence');
      expected.push(...['stdout', 'stderr', 'json'].map((suffix) => `${name}.${suffix}`));
    }
    assert.deepEqual(
      artifactFiles(evidence),
      expected.sort(),
      'selected artifact retains the complete proof inventory',
    );
    assert.ok(
      existsSync(join(resolverDirectory, 'node_modules/not-artifact-data/package.json')),
      'resolver installation must remain intact',
    );
    assert.ok(existsSync(join(f.work, 'cache/resolver-cache')));
    assert.ok(existsSync(join(f.work, 'home/runtime-file')));
    assert.ok(
      !artifactFiles(evidence).some((name) => /(?:^|\/)(?:resolve|home|cache|node_modules)(?:\/|$)/u.test(name)),
    );
  });
}

test('the always-upload consumer step selects only the dedicated evidence directory', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/foottrace-candidate.yml', import.meta.url), 'utf8');
  const uploads = workflow
    .split('\n      - ')
    .filter(
      (block) =>
        block.startsWith('uses: actions/upload-artifact@') &&
        block.includes('name: foottrace-${{ matrix.consumer }}-${{ matrix.node }}'),
    );
  assert.equal(uploads.length, 1, 'one matrix evidence upload step required');
  assert.ok(uploads[0].includes('\n        if: always()\n'), 'failed-run evidence must still upload');
  const paths = uploads[0]
    .split('\n')
    .filter((line) => line.trimStart().startsWith('path:'))
    .map((line) => line.trim());
  assert.deepEqual(paths, ['path: ${{ runner.temp }}/foottrace-evidence/evidence']);
  assert.ok(uploads[0].includes('if-no-files-found: error'));
});

// One inert Node child checks the real command writer, without running a product.

test('failed actual command retains stdout, stderr and exact exit metadata together', (t) => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'ft-command-evidence-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const evidence = join(parent, 'evidence');
  mkdirSync(evidence);
  const log = join(evidence, 'failed-command');
  const args = [
    '-e',
    "process.stdout.write('controlled output'); process.stderr.write('controlled failure'); process.exitCode = 7;",
  ];
  assert.throws(
    () =>
      actualSweepCommand(process.execPath, args, {
        cwd: parent,
        log,
        env: { PATH: process.env.PATH },
        timeout: 5000,
      }),
    /failed; retained output/u,
  );
  for (const suffix of ['stdout', 'stderr', 'json'])
    assert.equal(existsSync(`${log}.${suffix}`), true, `failed command must retain ${suffix}`);
  assert.equal(readFileSync(`${log}.stdout`, 'utf8'), 'controlled output');
  assert.equal(readFileSync(`${log}.stderr`, 'utf8'), 'controlled failure');
  const record = JSON.parse(readFileSync(`${log}.json`, 'utf8'));
  assert.deepEqual(record, { program: process.execPath, args, cwd: parent, status: 7, signal: null, error: null });
  assert.deepEqual(artifactFiles(evidence), ['failed-command.json', 'failed-command.stderr', 'failed-command.stdout']);
});

test('the touched candidate and source workflows use the explicit hosted image', () => {
  for (const file of ['foottrace-candidate.yml', 'ci.yml']) {
    const workflow = readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8');
    const images = workflow.split('\n').filter((line) => line.trim().startsWith('runs-on:'));
    assert.equal(images.length, 2);
    assert.ok(images.every((line) => line.trim() === 'runs-on: ubuntu-24.04'));
  }
});
