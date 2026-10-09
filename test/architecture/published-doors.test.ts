/**
 * No published name is lost in a minor — every name the LAST PUBLISHED release hands out on a door,
 * this tree still hands out on the same door.
 *
 * Consumers hold caret ranges (`^9.44.1`), so a minor that drops an export is installed under them
 * automatically and breaks every fresh install of a published consumer. C5 found two before it
 * shipped: hcifootprint 2.6.1 and agentfootprint 9.141.0 import record names from `/advanced` that
 * C5 first moved away. So a move ADDS the new door and keeps the old one until the major
 * (exports.test.ts · `keptUntil`); this test is the check that nothing slips through anyway.
 *
 * The published release is `footprintjs-published` (package.json: `npm:footprintjs@^9.46.1`; the
 * repository commits no lockfile, so every install resolves the newest 9.x — after 9.47.0 ships, this
 * compares against 9.47.0). Its doors are read from its own `exports` map and `.d.ts` files with the
 * TypeScript checker; this tree's from `src/`. Names are compared per door: a type or a value, exported
 * under that name.
 *
 * A MAJOR may drop names: while this tree's major is above the published one, the comparison is
 * skipped, and the major's release re-points the alias at itself once it is on npm.
 *
 *   contract  every door of the published release is still a door here, with every name it exported
 *   boundary  the comparison bites: a door map missing one published name reports exactly that name
 */
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '../..');
const PUBLISHED = dirname(require.resolve('footprintjs-published/package.json'));

type Doors = Map<string, Set<string>>;

interface PackageJson {
  version: string;
  exports: Record<string, string | { require?: { types?: string }; import?: { types?: string } }>;
}

const readPackage = (dir: string) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson;

/** door → the declaration file its `require` types condition names, for every door that has one. */
function typesFiles(pkg: PackageJson, dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [door, target] of Object.entries(pkg.exports)) {
    if (typeof target === 'string') continue;
    const types = target.require?.types ?? target.import?.types;
    if (types) out.set(door, join(dir, types));
  }
  return out;
}

/** door → the names it exports (types and values), read by the TypeScript checker from `files`. */
function exportedNames(files: Map<string, string>, options: ts.CompilerOptions): Doors {
  const program = ts.createProgram([...files.values()], { ...options, noEmit: true });
  const checker = program.getTypeChecker();
  const doors: Doors = new Map();
  for (const [door, file] of files) {
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`${file} is not part of the program`);
    const moduleSymbol = checker.getSymbolAtLocation(source);
    doors.set(door, new Set(moduleSymbol ? checker.getExportsOfModule(moduleSymbol).map((s) => s.getName()) : []));
  }
  return doors;
}

/** Every published (door, name) this tree no longer hands out, as `door: name`. */
export function lostNames(published: Doors, current: Doors): string[] {
  const lost: string[] = [];
  for (const [door, names] of published) {
    const here = current.get(door);
    for (const name of names) if (!here?.has(name)) lost.push(`${door}: ${name}`);
  }
  return lost.sort();
}

const parsed = ts.parseJsonConfigFileContent(
  ts.readConfigFile(join(REPO, 'tsconfig.json'), ts.sys.readFile).config,
  ts.sys,
  REPO,
);
const publishedPkg = readPackage(PUBLISHED);
const currentPkg = readPackage(REPO);
const major = (version: string) => Number(version.split('.')[0]);
const aMajorAhead = major(currentPkg.version) > major(publishedPkg.version);

/** This tree's doors map to their `src` entry files, as exports.test.ts reads them. */
function sourceFiles(pkg: PackageJson): Map<string, string> {
  const out = new Map<string, string>();
  for (const [door, file] of typesFiles(pkg, REPO)) {
    const match = /\/dist\/(?:types|esm)\/(.+)\.d\.ts$/.exec(file);
    if (match) out.set(door, join(REPO, 'src', `${match[1]}.ts`));
  }
  return out;
}

describe(`no name footprintjs ${publishedPkg.version} hands out is lost`, () => {
  it.skipIf(aMajorAhead)(
    'every published door is still a door, with every name it exported',
    () => {
      const published = exportedNames(typesFiles(publishedPkg, PUBLISHED), parsed.options);
      const current = exportedNames(sourceFiles(currentPkg), parsed.options);
      expect(published.size, 'the published release has doors to compare').toBeGreaterThan(0);
      expect([...published.keys()].filter((door) => !current.has(door))).toEqual([]);
      expect(lostNames(published, current), 'a minor must not drop a published name: keep it until the major').toEqual(
        [],
      );
    },
    60_000,
  );

  it('the comparison bites: a door map missing one published name reports exactly that name', () => {
    const published: Doors = new Map([
      ['./advanced', new Set(['SharedMemory', 'StageContext'])],
      ['./trace', new Set(['stateAt'])],
    ]);
    const current: Doors = new Map([
      ['./advanced', new Set(['StageContext'])],
      ['./trace', new Set(['stateAt', 'CommitBundle'])],
      ['./write', new Set(['SharedMemory'])],
    ]);
    expect(lostNames(published, current)).toEqual(['./advanced: SharedMemory']);
    expect(lostNames(published, new Map())).toEqual([
      './advanced: SharedMemory',
      './advanced: StageContext',
      './trace: stateAt',
    ]);
  });
});
