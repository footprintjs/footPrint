// Inert pure-data controls. No commands, filesystem, npm or consumer imports.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_HIDDEN_LOCK_LOCATIONS, assertHiddenLockConsistent, hiddenLockReport } from './hidden-lock.mjs';

const ENTRY = {
  version: '1.11.1',
  resolved: 'file:../foottrace-candidate/foottrace-1.11.1.tgz',
  integrity: 'sha512-controlled-fixture',
};
const lock = (entry = ENTRY, extra = {}) =>
  Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/foottrace': entry, ...extra } }));
const base = (overrides = {}) => ({
  rootLockBytes: lock(),
  hiddenLockBytes: lock(),
  hiddenMtimeMs: 1000,
  dirs: [
    { path: 'node_modules', mtimeMs: 900 },
    { path: 'node_modules/foottrace', mtimeMs: 900 },
  ],
  scanComplete: true,
  ...overrides,
});

test('after-ci snapshot retains digest and exact root/hidden FT entry without mutating inputs', () => {
  const input = base(),
    bytes = Buffer.from(input.hiddenLockBytes),
    dirs = structuredClone(input.dirs);
  const report = hiddenLockReport(input);
  assert.match(report.hidden.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(report.hidden.unchanged, null);
  assert.deepEqual(report.entry.root, ENTRY);
  assert.deepEqual(report.entry.hidden, ENTRY);
  assert.equal(report.entry.equal, true);
  assert.equal(report.limits.maxLocations, MAX_HIDDEN_LOCK_LOCATIONS);
  assertHiddenLockConsistent(report);
  assert.deepEqual(input.hiddenLockBytes, bytes);
  assert.deepEqual(input.dirs, dirs);
});

test('the same exported location bound limits observations and lock entries', () => {
  const tooMany = Array.from({ length: MAX_HIDDEN_LOCK_LOCATIONS + 1 }, (_, i) => ({
    path: `node_modules/pkg-${i}`,
    mtimeMs: 900,
  }));
  assert.throws(() => hiddenLockReport(base({ dirs: tooMany })), /observation bound/u);
  const extra = Object.fromEntries(tooMany.map(({ path }) => [path, { version: '1' }]));
  assert.throws(() => hiddenLockReport(base({ hiddenLockBytes: lock(ENTRY, extra) })), /lock location bound/u);
});

for (const field of ['version', 'resolved', 'integrity']) {
  for (const phase of ['after-ci', 'after']) {
    test(`${phase} refuses a hidden ${field} that differs from the generated root entry`, () => {
      const initial = hiddenLockReport(base());
      const hiddenLockBytes = lock({ ...ENTRY, [field]: `different-${field}` });
      const report = hiddenLockReport(
        base({ hiddenLockBytes, ...(phase === 'after' ? { baselineSha256: initial.hidden.sha256 } : {}) }),
      );
      assert.ok(report.entry.mismatches.includes(field));
      assert.throws(() => assertHiddenLockConsistent(report), /hidden lock consistency failed/u);
    });
  }
  test(`missing ${field} in BOTH entries is not evidence of equality`, () => {
    const entry = { ...ENTRY };
    delete entry[field];
    const report = hiddenLockReport(base({ rootLockBytes: lock(entry), hiddenLockBytes: lock(entry) }));
    assert.equal(report.entry.equal, false);
    assert.throws(() => assertHiddenLockConsistent(report));
  });
}

test('same semantic entries with changed hidden bytes still refuse the after hash', () => {
  const input = base(),
    before = hiddenLockReport(input);
  const report = hiddenLockReport({
    ...input,
    baselineSha256: before.hidden.sha256,
    hiddenLockBytes: Buffer.concat([input.hiddenLockBytes, Buffer.from('\n')]),
  });
  assert.equal(report.entry.equal, true);
  assert.equal(report.hidden.unchanged, false);
  assert.deepEqual(report.violations, ['HIDDEN_LOCK_CHANGED']);
  assert.throws(() => assertHiddenLockConsistent(report), /HIDDEN_LOCK_CHANGED/u);
});

test('root node_modules mtime bump from a skipped dot directory is disclosed, not refused', () => {
  const input = base(),
    before = hiddenLockReport(input);
  const report = hiddenLockReport({
    ...input,
    baselineSha256: before.hidden.sha256,
    dirs: [
      { path: 'node_modules', mtimeMs: 1011 },
      { path: 'node_modules/foottrace', mtimeMs: 900 },
      { path: 'node_modules/.vite', mtimeMs: 2000 },
    ],
  });
  assert.equal(report.hidden.unchanged, true);
  assert.deepEqual(
    report.drift.newer.rows.map(({ path }) => path),
    ['node_modules'],
  );
  assert.equal(report.drift.root.mtimeMs, 1011);
  assert.equal(report.drift.skippedDots, 1);
  assert.equal(report.drift.missingFromLock.total, 0);
  assertHiddenLockConsistent(report);
});

test('exact +10ms jitter is accepted; strictly more than +10ms is listed', () => {
  const report = hiddenLockReport(
    base({
      dirs: [
        { path: 'node_modules', mtimeMs: 1010 },
        { path: 'node_modules/foottrace', mtimeMs: 1010.001 },
      ],
    }),
  );
  assert.equal(report.drift.root.newer, false);
  assert.deepEqual(
    report.drift.newer.rows.map(({ path }) => path),
    ['node_modules/foottrace'],
  );
  assertHiddenLockConsistent(report);
});

test('missing package entries are reported, while scope and node_modules containers are exempt', () => {
  const report = hiddenLockReport(
    base({
      dirs: [
        { path: 'node_modules', mtimeMs: 900 },
        { path: 'node_modules/foottrace', mtimeMs: 900 },
        { path: 'node_modules/@example', mtimeMs: 1011 },
        { path: 'node_modules/@example/new', mtimeMs: 900 },
        { path: 'node_modules/foottrace/node_modules', mtimeMs: 900 },
        { path: 'node_modules/foottrace/node_modules/new', mtimeMs: 1012 },
        { path: 'node_modules/.store/hidden', mtimeMs: 9999 },
      ],
    }),
  );
  assert.deepEqual(
    report.drift.missingFromLock.rows.map(({ path }) => path),
    ['node_modules/@example/new', 'node_modules/foottrace/node_modules/new'],
  );
  assert.deepEqual(
    report.drift.newer.rows.map(({ path }) => path),
    ['node_modules/@example', 'node_modules/foottrace/node_modules/new'],
  );
  assertHiddenLockConsistent(report);
});

test('a truncated scan labels unseen locked locations as not observed, not proven absent', () => {
  const report = hiddenLockReport(
    base({ scanComplete: false, hiddenLockBytes: lock(ENTRY, { 'node_modules/not-yet-observed': { version: '1' } }) }),
  );
  assert.equal(report.drift.scanComplete, false);
  assert.deepEqual(report.drift.lockedNotObserved.rows, [{ path: 'node_modules/not-yet-observed' }]);
  assert.ok(report.limits.notModeled.includes('atomic filesystem snapshot'));
  assertHiddenLockConsistent(report);
});

test('row cap retains counts and omissions rather than presenting a complete-looking empty report', () => {
  const report = hiddenLockReport(
    base({
      dirs: [
        ...base().dirs,
        ...Array.from({ length: 129 }, (_, i) => ({ path: `node_modules/new-${i}`, mtimeMs: 1011 })),
      ],
    }),
  );
  assert.equal(report.drift.missingFromLock.total, 129);
  assert.equal(report.drift.missingFromLock.rows.length, 128);
  assert.equal(report.drift.missingFromLock.omitted, 1);
  assert.equal(report.drift.newer.total, 129);
  assertHiddenLockConsistent(report);
});

test('a report cannot silently omit the node_modules root mtime or accept ambiguous duplicate facts', () => {
  assert.throws(() => hiddenLockReport(base({ dirs: base().dirs.slice(1) })), /root mtime/u);
  assert.throws(() => hiddenLockReport(base({ dirs: [...base().dirs, base().dirs[0]] })), /duplicate/u);
  assert.throws(
    () => hiddenLockReport(base({ dirs: [...base().dirs, { path: '../elsewhere', mtimeMs: 900 }] })),
    /canonical directory/u,
  );
});
