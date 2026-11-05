// Filesystem metadata only; no packages are imported, installed or built.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { observeHiddenLock } from './hidden-lock-fs.mjs';
import { assertHiddenLockConsistent } from './hidden-lock.mjs';

function fixture(t) {
  const source = mkdtempSync(join(tmpdir(), 'hidden-lock-facts-'));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  const packages = {
    'node_modules/foottrace': { version: '1.11.1', resolved: 'file:../foottrace.tgz', integrity: 'sha512-inert' },
    'node_modules/absent': { version: '1.0.0' },
  };
  const rootLockBytes = Buffer.from(JSON.stringify({ lockfileVersion: 3, packages }));
  const hidden = join(source, 'node_modules/.package-lock.json');
  mkdirSync(join(source, 'node_modules/foottrace'), { recursive: true });
  writeFileSync(hidden, rootLockBytes);
  return { source, hidden, rootLockBytes };
}

test('ordinary drift records the modules root, newer and missing packages without weakening the gate', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.source, 'node_modules/.vite'));
  mkdirSync(join(f.source, 'node_modules/unlocked'));
  utimesSync(f.hidden, 100, 100);
  utimesSync(join(f.source, 'node_modules'), 101, 101);
  utimesSync(join(f.source, 'node_modules/unlocked'), 102, 102);
  const report = observeHiddenLock(f);
  assert.equal(report.drift.root.newer, true);
  assert.ok(report.drift.newer.rows.some(({ path }) => path === 'node_modules/unlocked'));
  assert.deepEqual(report.drift.missingFromLock.rows, [{ path: 'node_modules/unlocked' }]);
  assert.deepEqual(report.drift.lockedNotObserved.rows, [{ path: 'node_modules/absent' }]);
  assert.ok(!report.drift.newer.rows.some(({ path }) => path.includes('.vite')));
  assertHiddenLockConsistent(report); // Drift is disclosed; ordinary npm ls still decides validity.
  writeFileSync(f.hidden, `${f.rootLockBytes}\n`);
  const changed = observeHiddenLock({ ...f, baselineSha256: report.hidden.sha256 });
  assert.equal(changed.hidden.unchanged, false);
  assert.throws(() => assertHiddenLockConsistent(changed), /HIDDEN_LOCK_CHANGED/u);
});

test('scope and nested containers are observed; link targets stay outside this diagnostic profile', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.source, 'node_modules/@scope/package/node_modules/nested'), { recursive: true });
  const outside = join(f.source, 'external');
  mkdirSync(outside);
  mkdirSync(join(outside, 'node_modules/must-not-be-walked'), { recursive: true });
  symlinkSync(outside, join(f.source, 'node_modules/linked'), 'dir');
  const report = observeHiddenLock(f);
  assert.equal(report.drift.scanComplete, false);
  assert.ok(report.drift.missingFromLock.rows.some(({ path }) => path.endsWith('/nested')));
  assert.ok(!report.drift.missingFromLock.rows.some(({ path }) => /must-not|linked|@scope$/u.test(path)));
  assertHiddenLockConsistent(report);
});
