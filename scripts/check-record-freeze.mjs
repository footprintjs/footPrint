/** E4–E6: keep the maintained record copy frozen until the engine-only release. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import layering from './layering.config.cjs';

const { RECORD_FILES, isRecordFile, listSourceFiles } = layering;
const SCRIPT = realpathSync(fileURLToPath(import.meta.url));
const ROOT = resolve(dirname(SCRIPT), '..');
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The baseline is expected output, not a second ownership table. Missing evidence is an error. */
export function readRecordBaseline(file) {
  const baseline = JSON.parse(readFileSync(file, 'utf8'));
  if (
    !object(baseline) ||
    baseline.schemaVersion !== 1 ||
    typeof baseline.footprintCommit !== 'string' ||
    !COMMIT.test(baseline.footprintCommit) ||
    typeof baseline.foottraceCommit !== 'string' ||
    !COMMIT.test(baseline.foottraceCommit) ||
    typeof baseline.inventorySha256 !== 'string' ||
    !SHA256.test(baseline.inventorySha256) ||
    !object(baseline.files) ||
    Object.keys(baseline.files).length === 0 ||
    Object.entries(baseline.files).some(
      ([path, digest]) =>
        !path.startsWith('src/') ||
        !path.endsWith('.ts') ||
        path.endsWith('.d.ts') ||
        path.includes('\\') ||
        path.split('/').some((part) => !part || part === '.' || part === '..') ||
        typeof digest !== 'string' ||
        !SHA256.test(digest),
    )
  ) {
    throw new Error(`Invalid record freeze baseline: ${file}`);
  }
  return baseline;
}

/** Read current source through the same inventory and matcher as the architecture fence. */
export function snapshotRecord(root, recordFiles = RECORD_FILES) {
  const files = {};
  for (const path of listSourceFiles(root, 'src', { rejectSymlinks: true }).filter((path) =>
    isRecordFile(path, recordFiles),
  )) {
    const absolute = join(root, path);
    if (!lstatSync(absolute).isFile()) throw new Error(`Record source must be a regular file: ${path}`);
    files[path] = hash(readFileSync(absolute));
  }
  return { inventorySha256: hash(JSON.stringify(recordFiles)), files };
}

/** Pure comparison: report every kind of drift, including narrowing the ownership inventory. */
export function compareRecordSnapshots(expected, actual) {
  const before = Object.keys(expected.files).sort();
  const after = Object.keys(actual.files).sort();
  const has = (files, path) => Object.hasOwn(files, path);
  const added = after.filter((path) => !has(expected.files, path));
  const removed = before.filter((path) => !has(actual.files, path));
  const modified = before.filter((path) => has(actual.files, path) && expected.files[path] !== actual.files[path]);
  const inventoryChanged = expected.inventorySha256 !== actual.inventorySha256;
  return {
    ok: !inventoryChanged && !added.length && !removed.length && !modified.length,
    inventoryChanged,
    added,
    removed,
    modified,
  };
}

export function checkRecordFreeze({
  root = ROOT,
  baselineFile = join(ROOT, 'scripts/record-freeze.json'),
  recordFiles = RECORD_FILES,
} = {}) {
  const baseline = readRecordBaseline(baselineFile);
  const report = compareRecordSnapshots(baseline, snapshotRecord(root, recordFiles));
  return {
    ...report,
    fileCount: Object.keys(baseline.files).length,
    footprintCommit: baseline.footprintCommit,
    foottraceCommit: baseline.foottraceCommit,
  };
}

export function formatRecordFreeze(report) {
  if (report.ok) return `Record freeze: PASS (${report.fileCount} source files unchanged).`;
  return [
    'Record freeze: FAIL — a coordinated change to both record copies needs review.',
    ...(report.inventoryChanged ? ['  RECORD_FILES changed (including its order/patterns).'] : []),
    ...['added', 'removed', 'modified'].flatMap((kind) => report[kind].map((path) => `  ${kind}: ${path}`)),
    'Do not regenerate the baseline to make CI green. See scripts/README.md: Record freeze.',
  ].join('\n');
}

if (process.argv[1] && realpathSync(process.argv[1]) === SCRIPT) {
  try {
    if (process.argv.length !== 2)
      throw new Error('Usage: node scripts/check-record-freeze.mjs (read-only; no update mode)');
    const report = checkRecordFreeze();
    console.log(formatRecordFreeze(report));
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    console.error(`Record freeze: ERROR — ${error.message}`);
    process.exitCode = 1;
  }
}
