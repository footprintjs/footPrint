/** Inert path-port/metadata witnesses; no package runtime or install command executes. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PUBLISHED_REFERENCE_INSTALL_COMMAND, publishedReferenceRoot } from './published-reference.js';

function withFixture(body: (repo: string, installed: string) => void): void {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'fp-declaration-reference-')));
  const installed = join(repo, 'test/fixtures/published-reference/node_modules/footprintjs');
  try {
    body(repo, installed);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function declarationMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'footprintjs',
    version: '10.1.0',
    main: './index.js',
    exports: { '.': { require: { types: './index.d.ts', default: './index.js' } } },
    ...overrides,
  };
}

describe('the explicit published declaration reference port', () => {
  it('reads the fixed fixture as data and never executes its runtime entry', () =>
    withFixture((repo, installed) => {
      mkdirSync(installed, { recursive: true });
      const marker = join(repo, 'runtime-must-not-run');
      writeFileSync(join(installed, 'package.json'), JSON.stringify(declarationMetadata()));
      writeFileSync(join(installed, 'index.d.ts'), 'export declare const onlyADeclaration: number;\n');
      writeFileSync(
        join(installed, 'index.js'),
        `require('node:fs').writeFileSync(${JSON.stringify(
          marker,
        )}, 'executed'); throw Error('reference runtime executed');\n`,
      );
      expect(publishedReferenceRoot(repo)).toBe(installed);
      expect(existsSync(marker)).toBe(false);
    }));

  it('fails loudly with the exact fixed-prefix ci command if the fixture is not installed', () =>
    withFixture((repo) => {
      expect(() => publishedReferenceRoot(repo)).toThrow(
        `Published declaration reference is not installed. Run: ${PUBLISHED_REFERENCE_INSTALL_COMMAND}`,
      );
    }));

  it('never falls back to an installed root alias', () =>
    withFixture((repo) => {
      const ambient = join(repo, 'node_modules/footprintjs-published');
      mkdirSync(ambient, { recursive: true });
      writeFileSync(join(ambient, 'package.json'), JSON.stringify(declarationMetadata()));
      expect(() => publishedReferenceRoot(repo)).toThrow('is not installed. Run:');
    }));

  for (const wrong of [{ name: 'different-package' }, { version: '10.2.0' }, { exports: {} }]) {
    it(`refuses mismatched declaration metadata ${JSON.stringify(wrong)}`, () =>
      withFixture((repo, installed) => {
        mkdirSync(installed, { recursive: true });
        writeFileSync(join(installed, 'package.json'), JSON.stringify(declarationMetadata(wrong)));
        expect(() => publishedReferenceRoot(repo)).toThrow('Expected footprintjs10.1.0 declaration metadata');
      }));
  }

  it('refuses a link back into an ambient installation', () =>
    withFixture((repo, installed) => {
      const ambient = join(repo, 'node_modules/footprintjs');
      mkdirSync(ambient, { recursive: true });
      writeFileSync(join(ambient, 'package.json'), JSON.stringify(declarationMetadata()));
      mkdirSync(join(installed, '..'), { recursive: true });
      symlinkSync(ambient, installed, 'dir');
      expect(() => publishedReferenceRoot(repo)).toThrow('cannot be read. Run:');
    }));

  it('requires an explicit absolute repo root', () => {
    expect(() => publishedReferenceRoot('.')).toThrow('absolute repository root');
  });
});

describe('the declaration fixture is prepared for every npm test runner', () => {
  // These source-data assertions become active after root materializes the normal
  // registry locks. They do not execute npm or import any historical runtime.
  const repo = resolve(__dirname, '../..');
  const root = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const fixture = join(repo, 'test/fixtures/published-reference');

  it('keeps the unconditional strict ci hook, root guard shape and 9.28 alias', () => {
    expect(root.scripts.pretest).toBe(PUBLISHED_REFERENCE_INSTALL_COMMAND);
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'])
      expect(Object.hasOwn(root[section] ?? {}, 'footprintjs-published')).toBe(false);
    expect(root.devDependencies['footprintjs-baseline']).toBe('npm:footprintjs@9.28.0');
    expect(root.dependencies.foottrace).toBe('^1.11.1');
  });

  it('pins the private fixture exactly and uses a normally resolved registry lock', () => {
    const pkg = JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('footprintjs-published-reference');
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies).toEqual({ footprintjs: '10.1.0' });
    expect(pkg.scripts ?? {}).toEqual({});
    const lock = JSON.parse(readFileSync(join(fixture, 'package-lock.json'), 'utf8'));
    expect(lock.packages[''].dependencies).toEqual({ footprintjs: '10.1.0' });
    expect(lock.packages['node_modules/footprintjs'].version).toBe('10.1.0');
    for (const [path, entry] of Object.entries(lock.packages) as [
      string,
      { resolved?: string; integrity?: string },
    ][]) {
      if (!path) continue;
      expect(entry.resolved, `registry resolution for ${path}`).toMatch(/^https:\/\/registry\.npmjs\.org\//u);
      expect(entry.integrity, `registry integrity for ${path}`).toMatch(/^sha512-/u);
    }
  });
});
