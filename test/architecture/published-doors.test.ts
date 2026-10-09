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
 * The published release is `footprintjs-published` (package.json: `npm:footprintjs@^9.46.1`). The
 * repository commits no lockfile, so CI's fresh install resolves the newest 9.x — after 9.47.0 ships,
 * this compares against 9.47.0; a local checkout compares against what its `node_modules` holds
 * (`npm install footprintjs-published@npm:footprintjs@^9.46.1` refreshes it). Its doors are read from
 * its own `exports` map and `.d.ts` files with the TypeScript checker; this tree's from `src/`. Names
 * are compared per door, and so is their kind: a published VALUE must stay a value (an `export type`
 * of it would compile for a consumer's types and fail at run time).
 *
 * A MAJOR may drop names: the major's own PR skips this for its removals (the release gate runs before
 * `npm version`, still at 9.x), the version-based skip below covers a tree already a major ahead, and
 * once the major is on npm the alias is re-pointed at it.
 *
 *   contract  every door of the published release is still a door here, with every name it exported,
 *             and every published value is still a value
 *   boundary  the comparison bites: a door map missing one published name, or turning a value into a
 *             type, reports exactly that
 */
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '../..');
const PUBLISHED = dirname(require.resolve('footprintjs-published/package.json'));

/** door → name → whether a consumer can use it as a value or only as a type. */
type Doors = Map<string, Map<string, 'value' | 'type'>>;

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

/** door → every name it exports and its kind, read by the TypeScript checker from `files`. */
function exportedNames(files: Map<string, string>, options: ts.CompilerOptions): Doors {
  const program = ts.createProgram([...files.values()], { ...options, noEmit: true });
  const checker = program.getTypeChecker();
  /** A re-export marked `export type` hands out only the type, whatever it names. */
  const typeOnly = (s: ts.Symbol) =>
    (s.declarations ?? []).some((d) => ts.isExportSpecifier(d) && (d.isTypeOnly || d.parent.parent.isTypeOnly));
  const kind = (s: ts.Symbol): 'value' | 'type' => {
    if (s.flags & ts.SymbolFlags.Alias) {
      if (typeOnly(s)) return 'type';
      return checker.getAliasedSymbol(s).flags & ts.SymbolFlags.Value ? 'value' : 'type';
    }
    return s.flags & ts.SymbolFlags.Value ? 'value' : 'type';
  };
  const doors: Doors = new Map();
  for (const [door, file] of files) {
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`${file} is not part of the program`);
    const moduleSymbol = checker.getSymbolAtLocation(source);
    const names = new Map<string, 'value' | 'type'>();
    for (const s of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) names.set(s.getName(), kind(s));
    doors.set(door, names);
  }
  return doors;
}

/** Every published (door, name) this tree no longer hands out — or hands out only as a type — as `door: name`. */
export function lostNames(published: Doors, current: Doors): string[] {
  const lost: string[] = [];
  for (const [door, names] of published) {
    const here = current.get(door);
    for (const [name, was] of names) {
      const now = here?.get(name);
      if (now === undefined) lost.push(`${door}: ${name}`);
      else if (was === 'value' && now === 'type') lost.push(`${door}: ${name} (now type-only)`);
    }
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

  it('the comparison bites: a missing published name, or a value turned type-only, is reported exactly', () => {
    const doors = (entries: [string, [string, 'value' | 'type'][]][]): Doors =>
      new Map(entries.map(([door, names]) => [door, new Map(names)]));
    const published = doors([
      [
        './advanced',
        [
          ['SharedMemory', 'value'],
          ['StageContext', 'value'],
          ['StageSnapshot', 'type'],
        ],
      ],
      ['./trace', [['stateAt', 'value']]],
    ]);
    const current = doors([
      [
        './advanced',
        [
          ['StageContext', 'value'],
          ['StageSnapshot', 'type'],
        ],
      ],
      [
        './trace',
        [
          ['stateAt', 'type'],
          ['CommitBundle', 'type'],
        ],
      ],
      ['./write', [['SharedMemory', 'value']]],
    ]);
    expect(lostNames(published, current)).toEqual(['./advanced: SharedMemory', './trace: stateAt (now type-only)']);
    expect(lostNames(published, new Map())).toEqual([
      './advanced: SharedMemory',
      './advanced: StageContext',
      './advanced: StageSnapshot',
      './trace: stateAt',
    ]);
  });
});
