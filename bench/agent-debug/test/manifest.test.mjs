/**
 * The program's committed file list (harness/manifest.mjs, the reader's N9):
 * it equals `git ls-files` for the program folder, every hash matches, and
 * the harness refuses to start on a stray or changed file.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { currentManifest, MANIFEST_NAME, PROGRAM_DIR, readManifest, verifyProgram } from '../harness/manifest.mjs';

test('the manifest lists exactly the files git tracks in program/, with their hashes', () => {
  const git = spawnSync('git', ['ls-files', '.'], { cwd: PROGRAM_DIR, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  const tracked = git.stdout.split('\n').filter(Boolean).filter((f) => f !== MANIFEST_NAME).sort();
  assert.deepEqual(Object.keys(readManifest()).sort(), tracked);
  assert.deepEqual(readManifest(), currentManifest());
  assert.equal(verifyProgram().length, tracked.length);
});

test('a stray file or a changed file in the program stops the harness', () => {
  // On a copy: the real program/ is shared with the test files running beside this one.
  const copy = mkdtempSync(join(tmpdir(), 'agent-debug-manifest-'));
  try {
    cpSync(PROGRAM_DIR, copy, { recursive: true });
    assert.doesNotThrow(() => verifyProgram(copy));
    writeFileSync(join(copy, 'src', '.DS_Store'), 'x');
    assert.throws(() => verifyProgram(copy), /not in the manifest: src\/\.DS_Store; the harness does not start|not in the manifest: src\/\.DS_Store/);
    rmSync(join(copy, 'src', '.DS_Store'));
    writeFileSync(join(copy, 'README.md'), 'edited\n');
    assert.throws(() => verifyProgram(copy), /changed: README\.md/);
    rmSync(join(copy, 'fixtures', 'small-pickup.json'));
    assert.throws(() => verifyProgram(copy), /missing: fixtures\/small-pickup\.json/);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test('createWorkdir and runBatch check the manifest first', () => {
  const workdir = readFileSync(join(PROGRAM_DIR, '..', 'harness', 'workdir.mjs'), 'utf8');
  const batch = readFileSync(join(PROGRAM_DIR, '..', 'harness', 'batch.mjs'), 'utf8');
  // Part 2: each program of the table (harness/programs.mjs) is checked against its own manifest.
  assert.match(workdir, /for \(const rel of verifyProgram\(program\.dir, program\.unlistedAllowed\)\)/);
  assert.match(batch, /verifyProgram\(program\.dir, program\.unlistedAllowed\);/);
});
