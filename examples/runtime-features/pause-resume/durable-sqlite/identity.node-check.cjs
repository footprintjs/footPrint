'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const identity = require('./identity.cjs');

function checkpoint(fields = {}) {
  const wire = JSON.stringify({ checkpointVersion: 2, pausedStageId: 'wait', subflowPath: [],
    pausedExecution: { runId: 'synthetic-paused-run', runtimeStageId: 'wait#1' }, ...fields });
  return { wire, binding: { checkpointDigest: identity.sha(wire),
    pausedRunId: 'synthetic-paused-run', pausedStageId: 'wait' } };
}

test('the supported native pausable shape has no pausedBy marker', () => {
  const value = checkpoint();
  assert.equal(identity.nativeCheckpoint(value.wire, value.binding).pausedStageId, 'wait');
  for (const pausedBy of ['pausable', 'interrupt']) {
    const wrong = checkpoint({ pausedBy });
    assert.throws(() => identity.nativeCheckpoint(wrong.wire, wrong.binding), { safeCode: 'CHECKPOINT_BINDING' });
  }
});

test('the former fabricated marker requirement fails the supported-shape regression', () => {
  const source = fs.readFileSync(path.join(__dirname, 'identity.cjs'), 'utf8');
  const target = "Object.hasOwn(checkpoint, 'pausedBy')";
  assert.equal(source.split(target).length - 1, 1);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'footprint-native-identity-'));
  const mutant = path.join(directory, 'identity-mutant.cjs');
  try {
    fs.copyFileSync(path.join(__dirname, 'codes.cjs'), path.join(directory, 'codes.cjs'));
    fs.chmodSync(path.join(directory, 'codes.cjs'), 0o600);
    fs.writeFileSync(mutant, source.replace(target, "checkpoint.pausedBy !== 'pausable'"), { mode: 0o600 });
    const broken = require(mutant);
    const value = checkpoint();
    assert.throws(() => broken.nativeCheckpoint(value.wire, value.binding), { safeCode: 'CHECKPOINT_BINDING' });
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test('version, byte digest and paused execution must each match', () => {
  for (const extra of [{ checkpointVersion: 999 }, { pausedExecution: { runId: 'different-run' } },
    { pausedExecution: { runId: 'synthetic-paused-run' } },
    { pausedExecution: { runId: 'synthetic-paused-run', runtimeStageId: '../wrong' } },
    { pausedExecution: { runId: 'synthetic-paused-run', runtimeStageId: null } },
    { subflowPath: ['nested'] }, { pendingPauses: [{}] }]) {
    const value = checkpoint(extra);
    assert.throws(() => identity.nativeCheckpoint(value.wire, value.binding), { safeCode: 'CHECKPOINT_BINDING' });
  }
  const value = checkpoint();
  assert.throws(() => identity.nativeCheckpoint(value.wire + ' ', value.binding), { safeCode: 'CHECKPOINT_DIGEST' });
});

test('wire byte and nesting bounds refuse before native decoding', () => {
  assert.throws(() => identity.boundedJson('"' + 'é'.repeat(identity.MAX_WIRE) + '"'), { safeCode: 'CHECKPOINT_BOUNDS' });
  assert.throws(() => identity.boundedJson('['.repeat(66) + '0' + ']'.repeat(66)), { safeCode: 'CHECKPOINT_BOUNDS' });
  assert.throws(() => identity.boundedJson('{'), { safeCode: 'CHECKPOINT_JSON' });
  assert.throws(() => identity.trustedIdentity('remote', 'terminal'), { safeCode: 'UNSUPPORTED_EXAMPLE_MODE' });
});

test('private scratch accepts only its fixed owned file and refuses aliases', () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'footprint-native-host-')));
  const db = path.join(directory, 'host.sqlite');
  try {
    fs.chmodSync(directory, 0o700);
    fs.writeFileSync(db, '', { mode: 0o600 });
    assert.equal(identity.privatePaths(db).directory, directory);
    assert.throws(() => identity.privatePaths(path.join(directory, 'other.sqlite')), { safeCode: 'INVALID_PRIVATE_PATH' });
    fs.linkSync(db, path.join(directory, 'alias'));
    assert.throws(() => identity.privatePaths(db), { safeCode: 'INVALID_PRIVATE_PATH' });
    fs.unlinkSync(path.join(directory, 'alias'));
    fs.chmodSync(db, 0o644);
    assert.throws(() => identity.privatePaths(db), { safeCode: 'INVALID_PRIVATE_PATH' });
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test('program identity excludes adjacent Node checks but includes changed program bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'footprint-native-identity-scope-'));
  const helpers = path.join(root, 'examples/runtime-features/pause-resume/durable-sqlite');
  const dependency = path.join(root, 'node_modules/foottrace');
  const write = (name, value) => fs.writeFileSync(name, value, { mode: 0o600 });
  try {
    for (const directory of [helpers, path.join(root, 'src'), path.join(dependency, 'dist')]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    write(path.join(root, 'package.json'), JSON.stringify({ version: 'identity-fixture' }));
    write(path.join(root, 'package-lock.json'), JSON.stringify({
      packages: { 'node_modules/foottrace': { version: 'identity-fixture' } },
    }));
    write(path.join(dependency, 'package.json'), JSON.stringify({ name: 'foottrace', version: 'identity-fixture' }));
    write(path.join(dependency, 'dist/index.js'), '// inert identity bytes; never executed\n');
    write(path.join(root, 'src/index.ts'), '// inert identity bytes; never executed\n');
    for (const name of ['identity.cjs', 'codes.cjs']) {
      write(path.join(helpers, name), fs.readFileSync(path.join(__dirname, name)));
    }
    const fixture = require(path.join(helpers, 'identity.cjs'));
    const original = fixture.trustedIdentity('source', 'terminal').programDigest;
    write(path.join(helpers, 'adjacent.node-check.cjs'), '// Node check bytes; never executed\n');
    assert.equal(fixture.trustedIdentity('source', 'terminal').programDigest, original);
    fs.appendFileSync(path.join(helpers, 'codes.cjs'), '\n// changed program bytes\n');
    assert.notEqual(fixture.trustedIdentity('source', 'terminal').programDigest, original);
  } finally { fs.rmSync(root, { recursive: true }); }
});
