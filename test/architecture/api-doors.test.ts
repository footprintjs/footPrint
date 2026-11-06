/**
 * The generated API reference lists exactly the package's doors, and `check:api-doors` goes red when it stops.
 *
 *   red      every problem code fires, on a small package whose reference real TypeDoc built
 *   wiring   the check runs advisory where the docs checks run, and the sidebar marks the internals door
 *
 * None of this reads the repository's own doors, so a real drift warns in `docs-check.yml`, as advisory
 * checks do, and does not fail `npm test`. `published-doors.test.ts` pins the door reader.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '../..');
const CLI = join(REPO, 'scripts/api-doors/check.mjs');
const TYPEDOC = join(REPO, 'node_modules/typedoc/bin/typedoc');
const IMPORT_MAP = 'ai-instructions/source/import-map.json';

interface Problem {
  code: string;
  file: string;
  message: string;
}
interface Row {
  door: string;
  job: string;
  names: string[];
}

let check: { findProblems(root: string): Problem[] };
let site: {
  doorPage(door: string): string;
  referenceSidebar(rows: Row[]): { label: string; link: string; badge?: { text: string } }[];
};

const MAIN_JOB = 'The main door of this small package.';
const EXTRA_JOB = 'Engine internals. Use them to extend the engine.';

const door = (name: string, job: string, body: string) => `/**\n * ${job}\n *\n * @module ${name}\n */\n${body}\n`;
const exportsOf = (...names: string[]) =>
  Object.fromEntries(
    names.map((name) => [
      name === 'index' ? '.' : `./${name}`,
      {
        import: { types: `./dist/esm/${name}.d.ts`, default: `./dist/esm/${name}.js` },
        require: { types: `./dist/types/${name}.d.ts`, default: `./dist/${name}.js` },
      },
    ]),
  );

/** A package with two doors, the same TypeDoc options the repository uses, and an import map. */
function writePackage(root: string): void {
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'ai-instructions/source'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'footprintjs', exports: exportsOf('index', 'extra') }),
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, target: 'es2022', module: 'commonjs', types: [] } }),
  );
  writeFileSync(
    join(root, 'typedoc.json'),
    JSON.stringify({
      entryPoints: ['src/index.ts', 'src/extra.ts'],
      entryPointStrategy: 'resolve',
      out: 'api-docs',
      json: 'api-docs.json',
      name: 'footprintjs',
      readme: 'none',
      excludeInternal: true,
    }),
  );
  writeFileSync(join(root, 'src/index.ts'), door('footprintjs', MAIN_JOB, 'export const start = 1;'));
  writeFileSync(join(root, 'src/extra.ts'), door('footprintjs/extra', EXTRA_JOB, 'export const more = 2;'));
  writeFileSync(
    join(root, IMPORT_MAP),
    JSON.stringify([
      { door: 'footprintjs', job: MAIN_JOB, names: ['start'] },
      { door: 'footprintjs/extra', job: EXTRA_JOB, names: ['more'] },
    ]),
  );
}

const buildReference = (root: string) => {
  const result = spawnSync(process.execPath, [TYPEDOC, '--options', 'typedoc.json'], { cwd: root, encoding: 'utf8' });
  expect(result.status, result.stdout + result.stderr).toBe(0);
};

let built: string;
const copies: string[] = [];

beforeAll(async () => {
  check = await import(CLI);
  site = await import(join(REPO, 'scripts/api-doors/site.mjs'));
  built = mkdtempSync(join(tmpdir(), 'api-doors-'));
  writePackage(built);
  buildReference(built);
}, 60_000);
afterAll(() => rmSync(built, { recursive: true, force: true }));
afterEach(() => {
  while (copies.length) rmSync(copies.pop() as string, { recursive: true, force: true });
});

/** A private copy of the built package, for one thing to break. */
function copyOfBuilt(): string {
  const root = mkdtempSync(join(tmpdir(), 'api-doors-'));
  copies.push(root);
  cpSync(built, root, { recursive: true });
  return root;
}
const editJson = <T>(root: string, file: string, edit: (value: T) => void) => {
  const path = join(root, file);
  const value = JSON.parse(readFileSync(path, 'utf8')) as T;
  edit(value);
  writeFileSync(path, JSON.stringify(value));
};
const codesAt = (root: string) => [...new Set(check.findProblems(root).map((p) => p.code))].sort();
const runCheck = (root: string) => spawnSync(process.execPath, [CLI, '--root', root], { encoding: 'utf8' });

describe('check:api-doors', () => {
  it('passes a package whose reference lists every door, and exits 0', () => {
    expect(check.findProblems(built)).toEqual([]);
    const result = runCheck(built);
    expect(result.stdout).toContain('check:api-doors: OK');
    expect(result.status).toBe(0);
  });

  it('goes red and exits 1 when a door is added and the reference is not', () => {
    const root = copyOfBuilt();
    writeFileSync(join(root, 'src/late.ts'), door('footprintjs/late', 'Added later.', 'export const late = 3;'));
    editJson<{ exports: unknown }>(root, 'package.json', (pkg) => {
      pkg.exports = exportsOf('index', 'extra', 'late');
    });
    expect(codesAt(root)).toEqual(['door-missing', 'door-undocumented', 'door-unlisted']);
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('typedoc.json door-undocumented: footprintjs/late is a door. Add src/late.ts');
    expect(result.stdout).toContain('check:api-doors: FAIL (3 problems)');
  });

  it('goes red when the reference drops a door the package still has', () => {
    const root = copyOfBuilt();
    editJson<{ entryPoints: string[] }>(root, 'typedoc.json', (config) => {
      config.entryPoints = ['src/index.ts'];
    });
    // TypeDoc merges a lone entry point into the project, so it lists no module at all.
    buildReference(root);
    expect(codesAt(root)).toEqual(['door-undocumented', 'door-unlisted']);
  });

  it('goes red when the reference lists a module that is no door', () => {
    const root = copyOfBuilt();
    writeFileSync(join(root, 'src/private.ts'), door('footprintjs/private', 'Not a door.', 'export const hidden = 4;'));
    editJson<{ entryPoints: string[] }>(root, 'typedoc.json', (config) => {
      config.entryPoints.push('src/private.ts');
    });
    buildReference(root);
    expect(codesAt(root)).toEqual(['entry-not-a-door', 'module-unknown']);
  });

  it('goes red when a door is listed under the wrong name', () => {
    const root = copyOfBuilt();
    writeFileSync(join(root, 'src/extra.ts'), door('extra', EXTRA_JOB, 'export const more = 2;'));
    buildReference(root);
    expect(codesAt(root)).toEqual(['door-unlisted', 'module-unknown']);
  });

  it('goes red when the door has no page', () => {
    const root = copyOfBuilt();
    rmSync(join(root, 'api-docs', site.doorPage('footprintjs/extra')));
    expect(check.findProblems(root)).toEqual([
      expect.objectContaining({ code: 'page-missing', file: 'api-docs/modules/footprintjs_extra.html' }),
    ]);
  });

  it('goes red when the reference has not been built', () => {
    const root = copyOfBuilt();
    rmSync(join(root, 'api-docs.json'));
    expect(codesAt(root)).toEqual(['output-missing']);
    expect(runCheck(root).status).toBe(1);
  });

  it('goes red when a door hides an export from the reference', () => {
    const root = copyOfBuilt();
    writeFileSync(
      join(root, 'src/extra.ts'),
      door('footprintjs/extra', EXTRA_JOB, 'export const more = 2;\n/** @internal */\nexport const hidden = 3;'),
    );
    buildReference(root);
    expect(check.findProblems(root)).toEqual([
      expect.objectContaining({ code: 'name-unlisted', message: expect.stringContaining('exports hidden') }),
    ]);
  });

  it('goes red when a door stops saying what the import map says', () => {
    const root = copyOfBuilt();
    writeFileSync(join(root, 'src/extra.ts'), door('footprintjs/extra', 'Handy helpers.', 'export const more = 2;'));
    buildReference(root);
    expect(check.findProblems(root)).toEqual([
      expect.objectContaining({ code: 'job-missing', message: expect.stringContaining('Engine internals') }),
    ]);
  });

  it('goes red when the import map and the doors disagree', () => {
    const root = copyOfBuilt();
    editJson<Row[]>(root, IMPORT_MAP, (rows) => {
      rows.push({ door: 'footprintjs/gone', job: 'Gone.', names: [] });
      rows[0].names.push('nothing');
    });
    expect(codesAt(root)).toEqual(['door-unknown', 'name-missing']);
  });
});

describe('wiring', () => {
  it('runs advisory in the docs checks, after the reference is built, and on the files a door lives in', () => {
    const workflow = readFileSync(join(REPO, '.github/workflows/docs-check.yml'), 'utf8');
    expect(workflow).toMatch(
      /npm run docs -- --gitRevision main\n[\s\S]*?continue-on-error: true\n\s+run: npm run check:api-doors/,
    );
    for (const path of ['src/*.ts', 'package.json', 'typedoc.json', 'scripts/api-doors/**', IMPORT_MAP])
      expect(workflow).toContain(`- '${path}'`);
  });

  it('keeps the advanced door in the sidebar, marked, and sends foottrace to its own docs', () => {
    const rows: Row[] = JSON.parse(readFileSync(join(REPO, IMPORT_MAP), 'utf8'));
    const items = site.referenceSidebar(rows);
    const labelled = (label: string) => items.find((item) => item.label === label);
    expect(labelled('footprintjs/advanced')?.badge?.text).toBe('Engine internals');
    expect(labelled('footprintjs/recorders')?.badge).toBeUndefined();
    expect(labelled('footprintjs/recorders')?.link).toMatch(/\/api\/modules\/footprintjs_recorders\.html$/);
    expect(labelled('foottrace')?.link).toContain('github.com/footprintjs/foottrace');
    expect(items.filter((item) => item.label.startsWith('foottrace/'))).toEqual([]);
  });
});
