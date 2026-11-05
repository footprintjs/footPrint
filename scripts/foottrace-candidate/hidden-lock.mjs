// Pure disclosure of supplied lock bytes and ordinary directory observations.
// No filesystem operations, commands, npm imports, lock writes or repairs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const FIELDS = ['version', 'resolved', 'integrity'];
export const MAX_HIDDEN_LOCK_LOCATIONS = 50_000;
const MAX_ROWS = 128;
const MAX_LOCK_BYTES = 64 * 1024 * 1024;
const JITTER_MS = 10; // npm11.19 / arborist9.9.1 hidden-lock mtime tolerance.
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function packages(bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length <= MAX_LOCK_BYTES, 'bounded lock bytes required');
  const lock = JSON.parse(bytes.toString('utf8'));
  assert.ok(object(lock) && object(lock.packages), 'lock packages required');
  assert.ok(Object.keys(lock.packages).length <= MAX_HIDDEN_LOCK_LOCATIONS, 'lock location bound exceeded');
  return lock.packages;
}

function selectedEntry(entries) {
  const entry = entries['node_modules/foottrace'];
  return Object.fromEntries(
    FIELDS.map((field) => {
      const value = object(entry) ? entry[field] : undefined;
      return [field, typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : null];
    }),
  );
}

/** Normal non-link npm tree locations only; no installed package contents. */
function kind(location) {
  assert.ok(
    typeof location === 'string' && location.length <= 4096 && !location.includes('\\'),
    'canonical directory location required',
  );
  const parts = location.split('/');
  assert.ok(
    parts.every((part) => part && part !== '..' && part !== '.'),
    'canonical directory location required',
  );
  if (parts[0] !== 'node_modules') return 'outside';
  if (parts.some((part) => part.startsWith('.'))) return 'dot';
  let at = 1;
  while (at < parts.length) {
    if (parts[at].startsWith('@')) {
      at += 1;
      if (at === parts.length) return 'scope';
    }
    at += 1;
    if (at === parts.length) return 'package';
    if (parts[at] !== 'node_modules') return 'contents';
    at += 1;
  }
  return 'modules';
}

const boundedRows = (rows) => ({
  total: rows.length,
  rows: rows.slice(0, MAX_ROWS),
  omitted: Math.max(0, rows.length - MAX_ROWS),
});

/**
 * dirs contains lstat-derived NORMAL directory facts relative to the consumer,
 * including node_modules itself, scopes and nested node_modules containers.
 * The root collects them read-only, skips ordinary dot directories/links and
 * declares whether that bounded scan completed. This is not Arborist's validator.
 */
export function hiddenLockReport({
  rootLockBytes,
  hiddenLockBytes,
  hiddenMtimeMs,
  dirs,
  scanComplete,
  baselineSha256,
}) {
  assert.ok(Number.isFinite(hiddenMtimeMs) && hiddenMtimeMs >= 0, 'hidden lock mtime required');
  assert.ok(Array.isArray(dirs) && dirs.length <= MAX_HIDDEN_LOCK_LOCATIONS, 'directory observation bound exceeded');
  assert.equal(typeof scanComplete, 'boolean', 'scan completeness must be explicit');
  if (baselineSha256 !== undefined) assert.match(baselineSha256, /^[a-f0-9]{64}$/u);
  const rootPackages = packages(rootLockBytes),
    hiddenPackages = packages(hiddenLockBytes);
  const rootEntry = selectedEntry(rootPackages),
    hiddenEntry = selectedEntry(hiddenPackages);
  const mismatches = FIELDS.filter(
    (field) => rootEntry[field] === null || hiddenEntry[field] === null || rootEntry[field] !== hiddenEntry[field],
  );
  const sha256 = createHash('sha256').update(hiddenLockBytes).digest('hex');
  const hiddenChanged = baselineSha256 !== undefined && sha256 !== baselineSha256;
  const seen = new Set(),
    newer = [],
    missingFromLock = [];
  let skippedDots = 0,
    root;
  for (const fact of [...dirs].sort((a, b) => a.path.localeCompare(b.path))) {
    assert.ok(object(fact), 'directory fact required');
    assert.ok(Number.isFinite(fact.mtimeMs) && fact.mtimeMs >= 0, 'directory mtime required');
    assert.equal(seen.has(fact.path), false, 'duplicate directory observation');
    seen.add(fact.path);
    const type = kind(fact.path);
    if (type === 'dot') {
      skippedDots += 1;
      continue;
    }
    assert.ok(['modules', 'scope', 'package'].includes(type), 'observation is not an ordinary package-tree directory');
    const row = { path: fact.path, kind: type, mtimeMs: fact.mtimeMs, newer: fact.mtimeMs > hiddenMtimeMs + JITTER_MS };
    if (fact.path === 'node_modules') root = row;
    if (row.newer) newer.push(row);
    if (type === 'package' && !Object.hasOwn(hiddenPackages, fact.path)) missingFromLock.push({ path: fact.path });
  }
  assert.ok(root, 'node_modules root mtime observation required');
  const lockedNotObserved = Object.keys(hiddenPackages)
    .sort()
    .filter((location) => location.startsWith('node_modules/') && kind(location) === 'package' && !seen.has(location))
    .map((path) => ({ path }));
  return {
    schema: 1,
    hidden: {
      sha256,
      mtimeMs: hiddenMtimeMs,
      baselineSha256: baselineSha256 ?? null,
      unchanged: baselineSha256 === undefined ? null : !hiddenChanged,
    },
    entry: { root: rootEntry, hidden: hiddenEntry, mismatches, equal: mismatches.length === 0 },
    violations: [
      ...mismatches.map((field) => `FOOTTRACE_ENTRY_${field.toUpperCase()}`),
      ...(hiddenChanged ? ['HIDDEN_LOCK_CHANGED'] : []),
    ],
    drift: {
      root,
      jitterMs: JITTER_MS,
      scanComplete,
      observedDirectories: dirs.length,
      skippedDots,
      newer: boundedRows(newer),
      missingFromLock: boundedRows(missingFromLock),
      lockedNotObserved: boundedRows(lockedNotObserved),
    },
    limits: {
      maxLocations: MAX_HIDDEN_LOCK_LOCATIONS,
      maxRowsPerKind: MAX_ROWS,
      profile: 'ordinary non-link package/scoped/nested node_modules directories',
      notModeled: [
        'symlink targets',
        'linked-strategy .store',
        'workspace/fsChild roots',
        'atomic filesystem snapshot',
      ],
      meaning: 'diagnosis only; actual npm ls remains the installed-graph gate',
    },
  };
}

/** Drift alone is ordinary and never a refusal; entry/hash violations are fatal. */
export function assertHiddenLockConsistent(report) {
  assert.deepEqual(report.violations, [], `hidden lock consistency failed: ${report.violations.join(', ')}`);
}
