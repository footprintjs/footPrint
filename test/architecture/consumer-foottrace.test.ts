/** E4's installation invariant is distinct from E5 migration and from consumer test failures. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkFoottraceInstalls, judge } from '../../scripts/audit-consumers.mjs';
import { checkFoottraceTree, inspectFoottrace, inspectFoottraceWorkspace } from '../../scripts/foottrace-install.mjs';

const made: string[] = [];
afterEach(() => made.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function manifest(root: string, path: string, data: Record<string, unknown>) {
  const file = join(root, path, 'package.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
  return dirname(file);
}

function project(dependencies: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'consumer-foottrace-'));
  made.push(root);
  manifest(root, '', { name: 'consumer', version: '1.0.0', private: true, dependencies, ...extra });
  return root;
}

function install(root: string, path = 'node_modules/foottrace', version = '1.0.0') {
  return manifest(root, path, { name: 'foottrace', version });
}

function tree(root: string, dependencies: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return { name: 'consumer', path: root, _dependencies: {}, dependencies, ...extra };
}

const resolved = (path: string, version = '1.0.0') => ({ name: 'foottrace', version, path });

describe('Foottrace installed graph evidence', () => {
  it('reports an actual legacy graph as not migrated, never one copy', () => {
    const root = project();
    expect(inspectFoottrace(root)).toEqual({
      ok: true,
      status: 'NOT APPLICABLE',
      message: 'Foottrace: NOT APPLICABLE — not migrated / no Foottrace dependency',
    });
    expect(inspectFoottrace(root, { required: true })).toMatchObject({ ok: false, status: 'FAIL' });
  });

  it('requires installed Foottrace for direct, development and peer declarations', () => {
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const root = project({}, { [field]: { foottrace: '^1.0.0' } });
      expect(inspectFoottrace(root).ok, field).toBe(false);
    }
  });

  it('sees missing transitive and optional peer dependencies without a version heuristic', () => {
    for (const fields of [
      { dependencies: { foottrace: '^1.0.0' } },
      { peerDependencies: { foottrace: '^1.0.0' }, peerDependenciesMeta: { foottrace: { optional: true } } },
    ]) {
      const root = project({ engine: '1.0.0' });
      manifest(root, 'node_modules/engine', { name: 'engine', version: '1.0.0', ...fields });
      expect(inspectFoottrace(root).ok).toBe(false);
    }
  });

  it('does not require a dependency package’s development dependencies', () => {
    const root = project({ producer: '1.0.0' });
    manifest(root, 'node_modules/producer', {
      name: 'producer',
      version: '1.0.0',
      devDependencies: { foottrace: '^1.0.0' },
    });
    expect(inspectFoottrace(root).status).toBe('NOT APPLICABLE');
  });

  it('accepts a real deduplicated graph with repeated references to the same package', () => {
    const root = project({ foottrace: '1.0.0', producer: '1.0.0' });
    const path = install(root);
    manifest(root, 'node_modules/producer', {
      name: 'producer',
      version: '1.0.0',
      dependencies: { foottrace: '^1.0.0' },
    });
    expect(inspectFoottrace(root)).toMatchObject({
      ok: true,
      status: 'PASS',
      path: realpathSync(path),
      version: '1.0.0',
    });
  });

  it.each(['1.0.0', '1.1.0'])('rejects a nested physical copy at version %s', (version) => {
    const root = project({ foottrace: '1.0.0', producer: '1.0.0' });
    install(root);
    manifest(root, 'node_modules/producer', {
      name: 'producer',
      version: '1.0.0',
      dependencies: { foottrace: '^1.0.0' },
    });
    install(root, 'node_modules/producer/node_modules/foottrace', version);
    expect(inspectFoottrace(root)).toMatchObject({ ok: false, message: expect.stringContaining('2 paths') });
  });

  it('refuses malformed evidence, unresolved packages and disagreement with physical package metadata', () => {
    const root = project();
    const path = install(root);
    for (const value of [null, {}, [], tree(root, { foottrace: null }), tree(root, {}, { dependencies: [] })])
      expect(checkFoottraceTree(value).ok).toBe(false);
    for (const entry of [
      {},
      { version: '1.0.0' },
      { path },
      { ...resolved(path), invalid: '^2.0.0' },
      { ...resolved(path), missing: true },
      { ...resolved(path), problems: ['invalid'] },
      resolved(path, '2.0.0'),
      resolved(join(root, 'absent')),
    ])
      expect(checkFoottraceTree(tree(root, { foottrace: entry })).ok).toBe(false);
    manifest(root, 'node_modules/foottrace', { name: 'different-package', version: '1.0.0' });
    expect(checkFoottraceTree(tree(root, { foottrace: resolved(path) })).ok).toBe(false);
  });

  it('requires declared Foottrace even if npm omits its dependency entry', () => {
    const root = project();
    for (const declaration of [
      { _dependencies: { foottrace: '^1.0.0' } },
      { peerDependencies: { foottrace: '^1.0.0' } },
      { devDependencies: { foottrace: '^1.0.0' } },
    ])
      expect(checkFoottraceTree(tree(root, {}, declaration)).ok).toBe(false);
  });

  it('never treats command failure or invalid JSON as legacy absence', () => {
    const root = project();
    const stdout = JSON.stringify(tree(root));
    for (const result of [
      { status: 1, stdout },
      { status: null, stdout },
      { status: 0, stdout, error: new Error('spawn failed') },
      { status: 0, stdout: '{' },
    ])
      expect(inspectFoottrace(root, { run: () => result }).ok).toBe(false);
    expect(
      inspectFoottrace(root, {
        run: () => {
          throw new Error('inspection failed');
        },
      }).ok,
    ).toBe(false);
  });
});

describe('Foottrace consumer workspace and release gate', () => {
  it('rejects separate sibling copies and accepts links to a single canonical installation', () => {
    const consumer = project({ foottrace: '1.0.0' });
    const sibling = project({ foottrace: '1.0.0' });
    const canonical = install(consumer);
    const second = install(sibling);
    const roots = [consumer, sibling];
    expect(inspectFoottraceWorkspace(roots)).toMatchObject({
      ok: false,
      message: expect.stringContaining('different physical instances'),
    });
    rmSync(second, { recursive: true }); // only this test's generated package directory
    symlinkSync(canonical, second, 'dir');
    expect(inspectFoottraceWorkspace(roots).ok).toBe(true);
    expect(inspectFoottraceWorkspace([]).ok).toBe(false);
  });

  it('checks all installed siblings and reports each install even when one is broken', () => {
    const legacy = project();
    const missing = project({ foottrace: '1.0.0' });
    const notes = new Set<string>();
    expect(checkFoottraceInstalls([legacy, missing], notes)).toBe(false);
    expect([...notes].join('\n')).toContain('not migrated / no Foottrace dependency');
    expect([...notes].join('\n')).toContain('Foottrace: FAIL');
  });

  it('blocks failed installation evidence on one or both legs, preserving ordinary own failures', () => {
    const passed = [
      { key: 'install footprintjs', ok: true },
      { key: 'npm test', ok: true },
    ];
    const failedInstall = [
      { key: 'install footprintjs', ok: false },
      { key: 'npm test', ok: false, skipped: true },
    ];
    expect(judge(failedInstall, passed)).toBe('BLOCKING');
    expect(judge(failedInstall, failedInstall)).toBe('no verdict');
    expect(judge(failedInstall, null, false)).toBe('no verdict');
    const own = [
      { key: 'install footprintjs', ok: true },
      { key: 'npm test', ok: false },
    ];
    expect(judge(own, own)).toBe('own failure');
    expect(judge(passed, null)).toBe('pass');
  });

  it('registers Foottrace as published without treating it as a footprintjs consumer', () => {
    const { family } = JSON.parse(readFileSync(join(__dirname, '../../scripts/family.json'), 'utf8'));
    expect(family.find((entry: { package: string }) => entry.package === 'foottrace')).toEqual({
      package: 'foottrace',
      repo: 'footprintjs/foottrace',
      dir: 'foottrace',
      published: true,
    });
    expect(family.filter((entry: { checks?: string[] }) => entry.checks)).toHaveLength(7);
  });
});
