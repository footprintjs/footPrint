/** Verify a same-run artifact before any consumer installs its candidate. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { bytes, command, digest, source } from './identity.mjs';
import { bindSource, ENGINE_RECEIPT_VERSION } from './bind-source.mjs';

const receiptLimit = 2 * 1024 * 1024;
const archiveLimit = 16 * 1024 * 1024;

export function verifyArtifactReceipt(role, record, witness, archiveBytes, env = process.env) {
  assert.equal(
    record.schemaVersion,
    role === 'engine' ? ENGINE_RECEIPT_VERSION : 1,
    'unexpected artifact receipt version',
  );
  assert.equal(record.role, role, 'receipt role differs from the expected role');
  assert.match(env.GITHUB_REPOSITORY ?? '', /^[^/]+\/[^/]+$/);
  assert.match(env.GITHUB_RUN_ID ?? '', /^[1-9][0-9]*$/);
  assert.match(env.GITHUB_RUN_ATTEMPT ?? '', /^[1-9][0-9]*$/);
  assert.equal(
    record.workflow.repository,
    env.GITHUB_REPOSITORY,
    'receipt repository differs from the current repository',
  );
  assert.equal(record.workflow.runId, env.GITHUB_RUN_ID, 'receipt run differs from the current run');
  // A selective rerun retains the successful producer's outputs from the same run.
  assert.match(record.workflow.attempt ?? '', /^[1-9][0-9]*$/, 'receipt attempt must be positive');
  const receiptAttempt = Number(record.workflow.attempt);
  assert.ok(
    Number.isSafeInteger(receiptAttempt) && receiptAttempt <= Number(env.GITHUB_RUN_ATTEMPT),
    'receipt attempt is later than the current attempt or invalid',
  );
  assert.equal(record.source.head, witness.head, 'receipt commit differs from the checkout');
  assert.equal(record.source.tree, witness.tree, 'receipt tree differs from the checkout');
  if (role === 'engine') {
    assert.ok(witness.binding, 'engine checkout is missing event binding');
    assert.deepEqual(record.source.binding, witness.binding, 'receipt event binding differs from the checkout');
  }
  assert.equal(record.source.manifestSha256, witness.manifestSha256, 'receipt manifest hash differs from the checkout');
  assert.deepEqual(record.originalManifest, witness.manifest, 'receipt manifest differs from the checkout');
  assert.equal(record.archive.sha256, digest(archiveBytes), 'tarball digest differs from the receipt');
}

export function unpackCandidateArtifact(role, rawDirectory, destination, witness, env = process.env) {
  assert.ok(role === 'engine' || role === 'reader', 'expected the engine or reader artifact');
  assert.match(env.ARTIFACT_ID ?? '', /^[1-9][0-9]*$/, 'producer artifact ID is missing or invalid');
  const expectedDigest = (env.ARTIFACT_DIGEST ?? '').replace(/^sha256:/, '');
  assert.match(expectedDigest, /^[a-f0-9]{64}$/, 'producer ZIP digest is missing or invalid');
  const entries = readdirSync(rawDirectory);
  assert.equal(entries.length, 1, 'expected one downloaded artifact ZIP');
  const archive = resolve(rawDirectory, entries[0]);
  assert.equal(
    digest(bytes(archive, archiveLimit + receiptLimit + 64 * 1024)),
    expectedDigest,
    'ZIP digest differs from the producer output',
  );

  const receiptName = role + '-receipt.json';
  const tarballName = (role === 'engine' ? 'footprintjs' : 'foottrace') + '-candidate.tgz';
  assert.deepEqual(
    command('unzip', ['-Z1', archive], rawDirectory).trimEnd().split('\n').sort(),
    [receiptName, tarballName].sort(),
    'artifact ZIP must contain exactly the receipt and candidate tarball',
  );
  // Read only the fixed members, with bounds, and never extract ZIP paths to disk.
  const readMember = (name, maxBuffer) =>
    execFileSync('unzip', ['-p', archive, name], { cwd: rawDirectory, maxBuffer, timeout: 30_000 });
  const receiptBytes = readMember(receiptName, receiptLimit);
  const tarballBytes = readMember(tarballName, archiveLimit);
  verifyArtifactReceipt(role, JSON.parse(receiptBytes), witness, tarballBytes, env);
  mkdirSync(destination, { mode: 0o700 });
  writeFileSync(join(destination, receiptName), receiptBytes);
  writeFileSync(join(destination, tarballName), tarballBytes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [role, rawDirectory, destination, readerRoot, readerHead] = process.argv.slice(2);
  const root = fileURLToPath(new URL('../../', import.meta.url));
  if (role === 'reader') assert.match(readerHead ?? '', /^[a-f0-9]{40}$/, 'expected an exact reader commit');
  const witness = role === 'reader' ? source(resolve(readerRoot), readerHead) : bindSource(root);
  unpackCandidateArtifact(role, rawDirectory, destination, witness);
}
