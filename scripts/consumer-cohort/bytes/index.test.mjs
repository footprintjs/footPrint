import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pack } from '../../publish-release/archive/fixture.cjs';
import { inspectPacked, verifyBundle, verifyFiles, requireSingleInstallRoot } from './index.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('bundle source and archive joins', () => {
  it('refuses source/plan/run/archive substitutions and changed/extra installed members', () => {
    const folder = mkdtempSync(join(tmpdir(), 'paired-bytes-'));
    roots.push(folder);
    const manifest = { name: 'footprintjs', version: '13.0.0-rc.0' };
    const path = join(folder, 'footprintjs.tgz');
    writeFileSync(path, pack(manifest));
    const row = { ...inspectPacked(path, manifest), filename: 'footprintjs.tgz', head: 'head', tree: 'tree' };
    const plan = { hash: 'plan', engineVersion: manifest.version, packages: [], registry: [] };
    const context = { head: 'head', base: 'base', checkout: 'merge', tree: 'tree', run: '1', attempt: '1' };
    const receipt = { schema: 1, planHash: plan.hash, context, packages: [row] };
    expect(verifyBundle(receipt, plan, context, folder).size).toBe(1);
    for (const change of [
      { planHash: 'wrong' },
      { context: { ...context, checkout: 'other' } },
      { context: { ...context, attempt: '2' } },
      { packages: [] },
      { packages: [row, row] },
      { packages: [{ ...row, integrity: 'wrong' }] },
      { packages: [{ ...row, filename: '../footprintjs.tgz' }] },
    ])
      expect(() => verifyBundle({ ...receipt, ...change }, plan, context, folder)).toThrow();
    const installed = join(folder, 'installed');
    mkdirSync(join(installed, 'dist'), { recursive: true });
    writeFileSync(join(installed, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(installed, 'dist/index.js'), 'fixture only\n');
    expect(() => verifyFiles(installed, row)).not.toThrow();
    writeFileSync(join(installed, 'extra.js'), 'unexpected');
    expect(() => verifyFiles(installed, row)).toThrow('file bytes differ');
    mkdirSync(join(folder, 'standalone/node_modules'), { recursive: true });
    expect(() => requireSingleInstallRoot(folder)).toThrow('unpaired independent install root');
    writeFileSync(path, Buffer.from('tampered archive'));
    expect(() => verifyBundle(receipt, plan, context, folder)).toThrow();
  });
});
