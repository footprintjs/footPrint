/** Run the unset-read repro in a neutral npm app installed from two local tarballs. */
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const expectedStages = ['write-x', 'read-x-y', 'write-y', 'read-y'];
const expectedReads = [[], ['x', 'y'], [], ['y']];

function chartFor(flowChart) {
  return flowChart(
    'Write x',
    (scope) => {
      scope.x = 7;
    },
    'write-x',
  )
    .addFunction(
      'Read x and y',
      (scope) => {
        assert.equal(scope.x, 7);
        assert.equal(scope.y, undefined);
      },
      'read-x-y',
    )
    .addFunction(
      'Write y',
      (scope) => {
        scope.y = 11;
      },
      'write-y',
    )
    .addFunction(
      'Read y',
      (scope) => {
        assert.equal(scope.y, 11);
      },
      'read-y',
    )
    .build();
}

function stagesOf(snapshot) {
  const stages = [];
  let stage = snapshot.executionTree;
  for (const name of expectedStages) {
    assert.equal(stage?.id, name);
    stages.push(stage);
    stage = stage.next;
  }
  assert.equal(stage, undefined);
  return stages;
}

async function proveFormat(engine, format) {
  const { flowChart, FlowChartExecutor, readKeysOf } = engine;
  const executor = new FlowChartExecutor(chartFor(flowChart));
  await executor.run();
  const live = executor.getSnapshot();
  assert.deepEqual(live.sharedState, { x: 7, y: 11 });
  const encoded = JSON.stringify(live);
  const file = join(dirname(self), `snapshot-${format}.json`);
  writeFileSync(file, encoded, { flag: 'wx' });
  const reopened = readJson(file);
  const liveStages = stagesOf(live);
  const savedStages = stagesOf(reopened);

  if (typeof readKeysOf !== 'function') {
    // The pre-change record supplies an independent witness of data lost at JSON save.
    const liveKeys = Object.keys(liveStages[1].stageReads).sort();
    const reopenedKeys = Object.keys(savedStages[1].stageReads).sort();
    assert.deepEqual(liveKeys, expectedReads[1]);
    process.stderr.write(JSON.stringify({ format, stage: expectedStages[1], liveKeys, reopenedKeys }) + '\n');
    assert.deepEqual(reopenedKeys, liveKeys, 'The saved stage lost an unset read');
    assert.fail('The installed engine has no public readKeysOf reader');
  }

  assert.deepEqual(liveStages[1].undefinedReadKeys, ['y']);
  assert.deepEqual(savedStages[1].undefinedReadKeys, ['y']);
  const keys = (stages) => stages.map((stage) => [...readKeysOf(stage)].sort());
  const result = { live: keys(liveStages), reopened: keys(savedStages), cloned: keys(stagesOf(structuredClone(live))) };
  for (const observed of Object.values(result)) assert.deepEqual(observed, expectedReads);
  return {
    format,
    snapshotBytes: Buffer.byteLength(encoded),
    snapshotSha256: hash(encoded),
    stages: expectedStages,
    ...result,
  };
}

async function installedProbe() {
  const require = createRequire(import.meta.url);
  const packageRoot = join(dirname(self), 'node_modules', 'footprintjs') + sep;
  assert.ok(require.resolve('footprintjs').startsWith(packageRoot));
  assert.ok(fileURLToPath(import.meta.resolve('footprintjs')).startsWith(packageRoot));
  return {
    cases: [await proveFormat(await import('footprintjs'), 'esm'), await proveFormat(require('footprintjs'), 'cjs')],
  };
}

async function neutralInstall(enginePack, readerPack) {
  const { command, engineReaderResolution, onePhysicalReader, strictLock } = await import(
    './subflow-protocol/identity.mjs'
  );
  const root = mkdtempSync(join(tmpdir(), 'footprint-unset-reader-'));
  try {
    const archives = { footprintjs: realpathSync(enginePack), foottrace: realpathSync(readerPack) };
    const dependencies = Object.fromEntries(Object.entries(archives).map(([name, path]) => [name, `file:${path}`]));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'packed-unset-read-proof', private: true, dependencies }),
    );
    const npm = (args) => command('npm', ['--cache', join(root, 'npm-cache'), ...args], root);
    const install = ['--ignore-scripts', '--strict-peer-deps', '--offline', '--no-audit', '--no-fund'];
    npm(['install', '--package-lock-only', ...install]);
    npm(['ci', ...install]);
    const packages = Object.entries(archives).map(([name, archive]) => {
      const body = readFileSync(archive);
      const installed = readJson(join(root, 'node_modules', name, 'package.json'));
      assert.equal(installed.name, name);
      return {
        name,
        archive,
        inspection: { version: installed.version, integrity: `sha512-${hash(body, 'sha512', 'base64')}` },
        sha256: hash(body),
      };
    });
    const lock = strictLock(root, packages);
    const reader = join(root, 'node_modules', 'foottrace');
    onePhysicalReader(root, reader);
    engineReaderResolution(root, reader);
    copyFileSync(self, join(root, 'probe.mjs'));
    const probe = JSON.parse(command(process.execPath, ['probe.mjs', '--installed'], root));
    const sources = Object.fromEntries(
      packages.map(({ name, archive, inspection, sha256 }) => [
        name,
        {
          archive: basename(archive),
          version: inspection.version,
          sha256,
          integrity: inspection.integrity,
        },
      ]),
    );
    return { packages: sources, lock, node: process.version, npm: npm(['--version']).trim(), ...probe };
  } finally {
    rmSync(root, { recursive: true });
  }
}

const [first, second, ...extra] = process.argv.slice(2);
assert.ok(
  !extra.length && (first === '--installed' ? !second : first && second),
  'Use: node scripts/prove-unset-read-consumer.mjs <engine.tgz> <foottrace.tgz>',
);
const result = first === '--installed' ? await installedProbe() : await neutralInstall(first, second);
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
