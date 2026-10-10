/** A frozen expected snapshot is evidence, not another owner of the record inventory. */
import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  checkRecordFreeze,
  compareRecordSnapshots,
  formatRecordFreeze,
  readRecordBaseline,
  snapshotRecord,
} from '../../scripts/check-record-freeze.mjs';
import layering from '../../scripts/layering.config.cjs';

const REPO = resolve(__dirname, '../..');
const made: string[] = [];
afterAll(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const inventory = ['src/record/**'];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'record-freeze-'));
  made.push(root);
  const put = (path: string, value: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  put('src/record/a.ts', 'export const a = 1;\n');
  put('src/engine.ts', 'export const engine = 1;\n');
  const baseline = {
    schemaVersion: 1,
    footprintCommit: 'a'.repeat(40),
    foottraceCommit: 'b'.repeat(40),
    ...snapshotRecord(root, inventory),
  };
  const baselineFile = join(root, 'freeze.json');
  const save = (value: unknown) => writeFileSync(baselineFile, JSON.stringify(value));
  save(baseline);
  const check = (recordFiles = inventory) => checkRecordFreeze({ root, baselineFile, recordFiles });
  return { root, put, baseline, baselineFile, save, check };
}

describe('record freeze — one inventory, expected source bytes', () => {
  it('accepts unchanged sources, including after an engine-only edit', () => {
    const f = fixture();
    expect(f.check().ok).toBe(true);
    f.put('src/engine.ts', 'export const engine = 2;\n');
    expect(f.check().ok).toBe(true);
  });

  it('detects even a whitespace-only change in a record source', () => {
    const f = fixture();
    f.put('src/record/a.ts', 'export const a = 1;\n\n');
    expect(f.check()).toMatchObject({ ok: false, modified: ['src/record/a.ts'], added: [], removed: [] });
  });

  it('detects a new file matched by an existing glob', () => {
    const f = fixture();
    f.put('src/record/new.ts', 'export const next = 1;\n');
    expect(f.check()).toMatchObject({ ok: false, added: ['src/record/new.ts'] });
  });

  it('detects a deleted source', () => {
    const f = fixture();
    rmSync(join(f.root, 'src/record/a.ts'));
    expect(f.check()).toMatchObject({ ok: false, removed: ['src/record/a.ts'] });
  });

  it('reports a rename as addition and deletion, even when bytes are unchanged', () => {
    const f = fixture();
    f.put('src/record/b.ts', readFileSync(join(f.root, 'src/record/a.ts'), 'utf8'));
    rmSync(join(f.root, 'src/record/a.ts'));
    expect(f.check()).toMatchObject({ ok: false, added: ['src/record/b.ts'], removed: ['src/record/a.ts'] });
  });

  it('refuses inventory narrowing that would hide a changed record file', () => {
    const f = fixture();
    f.put('src/record/a.ts', 'changed');
    expect(f.check(['src/elsewhere/**'])).toMatchObject({
      ok: false,
      inventoryChanged: true,
      removed: ['src/record/a.ts'],
    });
  });

  it('detects a changed inventory even when its current matched files are identical', () => {
    const f = fixture();
    expect(f.check(['src/record/a.ts'])).toMatchObject({
      ok: false,
      inventoryChanged: true,
      added: [],
      removed: [],
      modified: [],
    });
  });

  it('keeps the architecture fence source scope (not declarations, docs, or build outputs)', () => {
    const f = fixture();
    f.put('src/record/README.md', 'notes');
    f.put('src/record/generated.d.ts', 'declare const a: number;');
    f.put('dist/record/a.js', 'built output');
    expect(f.check().ok).toBe(true);
  });

  it('refuses a symlink in place of a record source even if its bytes are identical', () => {
    const f = fixture();
    f.put('target.ts', readFileSync(join(f.root, 'src/record/a.ts'), 'utf8'));
    rmSync(join(f.root, 'src/record/a.ts'));
    symlinkSync(join(f.root, 'target.ts'), join(f.root, 'src/record/a.ts'));
    expect(() => f.check()).toThrow(/symbolic link|regular file/);
  });

  it.each(['src', 'src/record'])('refuses linked directory %s before following it', (path) => {
    const f = fixture();
    const target = join(f.root, 'outside-source');
    renameSync(join(f.root, path), target);
    symlinkSync(target, join(f.root, path));
    // The existing walker's default is deliberately unchanged for its other users.
    expect(layering.listSourceFiles(f.root)).toContain('src/record/a.ts');
    expect(() => f.check()).toThrow(/symbolic link/);
  });

  it('compares snapshots without mutating their evidence', () => {
    const files = Object.freeze({ 'src/a.ts': 'a', 'src/b.ts': 'b' });
    const before = Object.freeze({ inventorySha256: 'inventory', files });
    const after = Object.freeze({
      inventorySha256: 'inventory',
      files: Object.freeze({ 'src/b.ts': 'changed', 'src/c.ts': 'c' }),
    });
    expect(compareRecordSnapshots(before, after)).toEqual({
      ok: false,
      inventoryChanged: false,
      added: ['src/c.ts'],
      removed: ['src/a.ts'],
      modified: ['src/b.ts'],
    });
  });
});

describe('record freeze — missing evidence never passes', () => {
  it('fails when the baseline is absent', () => {
    const f = fixture();
    rmSync(f.baselineFile);
    expect(() => f.check()).toThrow(/ENOENT/);
  });

  it('fails when the baseline is not JSON', () => {
    const f = fixture();
    writeFileSync(f.baselineFile, '{');
    expect(() => f.check()).toThrow();
  });

  it.each([
    { schemaVersion: 2 },
    { footprintCommit: 'main' },
    { foottraceCommit: '' },
    { inventorySha256: 'unknown' },
    { files: {} },
    { files: { 'src/a.ts': 'invalid digest' } },
    { files: { 'src/../outside.ts': 'a'.repeat(64) } },
    { files: { 'src/a.d.ts': 'a'.repeat(64) } },
    { files: { '/src/a.ts': 'a'.repeat(64) } },
  ])('refuses incomplete or malformed baseline %j', (change) => {
    const f = fixture();
    f.save({ ...f.baseline, ...change });
    expect(() => f.check()).toThrow(/Invalid record freeze baseline/);
  });

  it.each([null, [], 'not a baseline'])('refuses non-object baseline %j', (value) => {
    const f = fixture();
    f.save(value);
    expect(() => f.check()).toThrow(/Invalid record freeze baseline/);
  });
});

describe('record freeze — maintained tree and public command', () => {
  it('checks the real record sources against the reviewed baseline', () => {
    const baseline = readRecordBaseline(join(REPO, 'scripts/record-freeze.json'));
    const report = checkRecordFreeze();
    expect(report.ok).toBe(true);
    expect(report.fileCount).toBe(Object.keys(baseline.files).length);
    expect(formatRecordFreeze(report)).toContain('PASS');
  });

  it('runs read-only from any working directory', () => {
    const f = fixture();
    const output = execFileSync(process.execPath, [join(REPO, 'scripts/check-record-freeze.mjs')], {
      cwd: f.root,
      encoding: 'utf8',
    });
    expect(output).toContain('Record freeze: PASS');
  });

  it('rejects update/skip flags instead of rewriting the expected evidence', () => {
    const result = spawnSync(process.execPath, [join(REPO, 'scripts/check-record-freeze.mjs'), '--update'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('read-only; no update mode');
  });

  it.each([false, true])(
    'exits nonzero on source drift or missing baseline (preserve main symlink: %s)',
    (preserveSymlinks) => {
      const f = fixture();
      f.put('src/lib/memory/types.ts', 'export type Value = number;\n');
      f.put('scripts/check-record-freeze.mjs', readFileSync(join(REPO, 'scripts/check-record-freeze.mjs'), 'utf8'));
      f.put('scripts/layering.config.cjs', readFileSync(join(REPO, 'scripts/layering.config.cjs'), 'utf8'));
      f.put('scripts/record-freeze.json', JSON.stringify({ ...f.baseline, ...snapshotRecord(f.root) }));
      // An aliased entry path must execute the check, not silently skip the command body.
      symlinkSync(join(f.root, 'scripts/check-record-freeze.mjs'), join(f.root, 'scripts/freeze-alias.mjs'));
      const run = () =>
        spawnSync(
          process.execPath,
          [...(preserveSymlinks ? ['--preserve-symlinks-main'] : []), join(f.root, 'scripts/freeze-alias.mjs')],
          { encoding: 'utf8' },
        );
      expect(run().status).toBe(0);
      f.put('src/lib/memory/types.ts', 'export type Value = string;\n');
      const drift = run();
      expect(drift.status).toBe(1);
      expect(drift.stdout).toContain('modified: src/lib/memory/types.ts');
      rmSync(join(f.root, 'scripts/record-freeze.json'));
      const absent = run();
      expect(absent.status).toBe(1);
      expect(absent.stderr).toContain('Record freeze: ERROR');
    },
  );

  it('names each drift and the coordinated-review requirement', () => {
    const f = fixture();
    f.put('src/record/a.ts', 'changed');
    const report = f.check();
    expect(formatRecordFreeze(report)).toContain('modified: src/record/a.ts');
    expect(formatRecordFreeze(report)).toContain('Do not regenerate the baseline');
  });
});
