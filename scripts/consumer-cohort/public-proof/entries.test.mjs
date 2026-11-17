import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { requireEntries } from './index.mjs';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'review-export-join-'));
  const installed = join(root, 'node_modules/agentfootprint');
  mkdirSync(join(installed, 'dist'), { recursive: true });
  const files = [];
  const manifest = { name: 'agentfootprint', version: '15.0.0-rc.0', exports: {} };
  for (const key of ['root', 'providers', 'observe']) {
    manifest.exports[key === 'root' ? '.' : './' + key] = {
      require: './dist/' + key + '.cjs',
      import: './dist/' + key + '.mjs',
    };
    for (const ext of ['cjs', 'mjs']) {
      const data = Buffer.from(key + ' ' + ext + ' fixture data');
      writeFileSync(join(installed, 'dist', key + '.' + ext), data);
      files.push({ path: 'package/dist/' + key + '.' + ext, sha256: createHash('sha256').update(data).digest('hex') });
    }
  }
  writeFileSync(join(installed, 'package.json'), JSON.stringify(manifest));
  return { root, installed, selected: { package: manifest.name, version: manifest.version, manifest, files } };
}
for (const format of ['cjs', 'esm'])
  it('accepts the exact ' + format + ' export targets', () => {
    const f = fixture();
    try {
      const entries = Object.fromEntries(
        ['root', 'providers', 'observe'].map((k) => {
          const p = join(f.installed, 'dist', k + (format === 'cjs' ? '.cjs' : '.mjs'));
          return [k, format === 'cjs' ? p : pathToFileURL(p).href];
        }),
      );
      expect(() => requireEntries(entries, format, f.root, f.selected)).not.toThrow();
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
it('refuses swapped CJS public members even though both have admitted hashes', () => {
  const f = fixture();
  try {
    const entries = {
      root: join(f.installed, 'dist/providers.cjs'),
      providers: join(f.installed, 'dist/root.cjs'),
      observe: join(f.installed, 'dist/observe.cjs'),
    };
    expect(() => requireEntries(entries, 'cjs', f.root, f.selected)).toThrow();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
it('refuses ESM preflight entries pointing to admitted CJS-only targets', () => {
  const f = fixture();
  try {
    const entries = Object.fromEntries(
      ['root', 'providers', 'observe'].map((k) => [k, pathToFileURL(join(f.installed, 'dist', k + '.cjs')).href]),
    );
    expect(() => requireEntries(entries, 'esm', f.root, f.selected)).toThrow();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
it('accepts native nested types/default branches without using declaration files as runtime targets', () => {
  const f = fixture();
  try {
    for (const value of Object.values(f.selected.manifest.exports)) {
      for (const mode of ['import', 'require'])
        value[mode] = { types: './dist/missing-types.d.ts', default: value[mode] };
    }
    for (const format of ['cjs', 'esm']) {
      const entries = Object.fromEntries(
        ['root', 'providers', 'observe'].map((k) => {
          const p = join(f.installed, 'dist', k + (format === 'cjs' ? '.cjs' : '.mjs'));
          return [k, format === 'cjs' ? pathToFileURL(p).pathname : pathToFileURL(p).href];
        }),
      );
      expect(() => requireEntries(entries, format, f.root, f.selected)).not.toThrow();
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
for (const fault of [
  'unknown-condition',
  'missing-branch',
  'undeclared-member',
  'declaration-only',
  'noncanonical-url',
])
  it('refuses ' + fault + ' instead of interpreting another export policy', () => {
    const f = fixture();
    try {
      const entries = Object.fromEntries(
        ['root', 'providers', 'observe'].map((k) => [k, pathToFileURL(join(f.installed, 'dist', k + '.mjs')).href]),
      );
      const map = f.selected.manifest.exports['.'];
      if (fault === 'unknown-condition') map.node = './dist/root.mjs';
      if (fault === 'missing-branch') delete map.import;
      if (fault === 'undeclared-member') map.import = './dist/not-present.mjs';
      if (fault === 'declaration-only') map.import = { types: './dist/root.mjs' };
      if (fault === 'noncanonical-url') entries.root += '?unowned=1';
      expect(() => requireEntries(entries, 'esm', f.root, f.selected)).toThrow();
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
