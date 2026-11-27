import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { unpackCandidateArtifact, verifyArtifactReceipt } from './candidate-artifact.mjs';
import { command, digest } from './identity.mjs';

const context = { GITHUB_REPOSITORY: 'footprintjs/footPrint', GITHUB_RUN_ID: '1234', GITHUB_RUN_ATTEMPT: '2' };
const witness = {
  head: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  manifestSha256: 'c'.repeat(64),
  manifest: { name: 'footprintjs', version: '1.0.0' },
};
const tarball = Buffer.from('test candidate bytes only');
const receipt = {
  schemaVersion: 1,
  role: 'engine',
  workflow: { repository: context.GITHUB_REPOSITORY, runId: '1234', attempt: '2' },
  source: { head: witness.head, tree: witness.tree, manifestSha256: witness.manifestSha256 },
  originalManifest: witness.manifest,
  archive: { sha256: digest(tarball) },
};

const changeLastHex = (value) => value.slice(0, -1) + (value.endsWith('0') ? '1' : '0');

test('accepts an earlier producer attempt when the receipt belongs to this run', () => {
  const earlier = { ...receipt, workflow: { ...receipt.workflow, attempt: '1' } };
  verifyArtifactReceipt('engine', earlier, witness, tarball, context);
});

for (const [field, modify] of [
  [
    'receipt version',
    (value) => {
      value.schemaVersion = 2;
    },
  ],
  [
    'role',
    (value) => {
      value.role = 'reader';
    },
  ],
  [
    'repository',
    (value) => {
      value.workflow.repository = 'other/project';
    },
  ],
  [
    'run',
    (value) => {
      value.workflow.runId = '1233';
      value.workflow.attempt = '1';
    },
  ],
  [
    'attempt',
    (value) => {
      value.workflow.attempt = '3';
    },
  ],
  [
    'attempt',
    (value) => {
      value.workflow.attempt = '0';
    },
  ],
  [
    'commit',
    (value) => {
      value.source.head = 'd'.repeat(40);
    },
  ],
  [
    'tree',
    (value) => {
      value.source.tree = 'd'.repeat(40);
    },
  ],
  [
    'manifest hash',
    (value) => {
      value.source.manifestSha256 = 'd'.repeat(64);
    },
  ],
  [
    'manifest',
    (value) => {
      value.originalManifest.version = '2.0.0';
    },
  ],
  [
    'tarball digest',
    (value) => {
      value.archive.sha256 = changeLastHex(value.archive.sha256);
    },
  ],
]) {
  test('receipt rejects an incorrect ' + field, () => {
    const changed = structuredClone(receipt);
    modify(changed);
    assert.throws(() => verifyArtifactReceipt('engine', changed, witness, tarball, context), new RegExp(field));
  });
}

for (const [role, filename] of [
  ['engine', 'footprintjs-candidate.tgz'],
  ['reader', 'foottrace-candidate.tgz'],
]) {
  test(role + ' requires producer ZIP and receipt before exposing candidate bytes', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'consumer-archive-'));
    t.after(() => rmSync(root, { force: true, recursive: true }));
    const raw = join(root, 'download');
    const destination = join(root, 'verified');
    const zip = join(raw, 'artifact-download');
    const receiptName = role + '-receipt.json';
    mkdirSync(raw);
    const priorReceipt = { ...receipt, role, workflow: { ...receipt.workflow, attempt: '1' } };
    writeFileSync(join(root, receiptName), JSON.stringify(priorReceipt));
    writeFileSync(join(root, filename), tarball);
    const repack = (...members) => {
      rmSync(zip, { force: true });
      command('zip', ['-q', zip + '.zip', ...members], root);
      renameSync(zip + '.zip', zip);
      return { ...context, ARTIFACT_ID: '425', ARTIFACT_DIGEST: 'sha256:' + digest(readFileSync(zip)) };
    };
    const contextForZip = repack(receiptName, filename);
    assert.throws(
      () =>
        unpackCandidateArtifact(role, raw, destination, witness, {
          ...contextForZip,
          ARTIFACT_ID: '',
        }),
      /artifact ID/,
    );
    assert.throws(
      () =>
        unpackCandidateArtifact(role, raw, destination, witness, {
          ...contextForZip,
          ARTIFACT_DIGEST: changeLastHex(contextForZip.ARTIFACT_DIGEST),
        }),
      /ZIP digest/,
    );
    const otherZip = join(raw, 'zzz-second-artifact');
    writeFileSync(otherZip, readFileSync(zip));
    assert.throws(
      () => unpackCandidateArtifact(role, raw, destination, witness, contextForZip),
      /one downloaded artifact ZIP/,
    );
    rmSync(otherZip);

    const missing = repack(filename);
    assert.throws(() => unpackCandidateArtifact(role, raw, destination, witness, missing), /exactly the receipt/);
    assert.ok(!existsSync(destination));
    const valid = repack(receiptName, filename);
    unpackCandidateArtifact(role, raw, destination, witness, valid);
    assert.deepEqual(readFileSync(join(destination, filename)), tarball);
  });
}
