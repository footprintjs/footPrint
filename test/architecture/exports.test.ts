/**
 * Export ownership — every public symbol has ONE canonical barrel.
 *
 * The package has seven doors (the keys of package.json `exports`): `.`, `./advanced`,
 * `./recorders`, `./trace`, `./write`, `./detach`, `./zod`. A symbol that two doors both hand out is two
 * things to document, to keep in step and to deprecate; a symbol one door renames is a
 * second door nobody can grep. This test finds every symbol reachable through more than one
 * door — resolving aliases to the declaration, so `export { A as B }` counts — and lets only
 * the ones named in SECOND_DOORS through, each with its canonical door and its reason.
 *
 * The list only ever shrinks: a symbol that stops being double-exported must leave it, and
 * a new double export fails here until someone decides which door owns it.
 *
 *   unit      every door in package.json has a src entry file and a `typesVersions` line
 *   scenario  the real package: undeclared second doors and stale list entries both fail
 *   boundary  an alias is a door (`StageFunction` is `StageHandler` on `.`)
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '../..');

// ── the allow-list ───────────────────────────────────────────────────────────

interface SecondDoors {
  /** The door that owns these symbols — where new work on them lands. */
  canonical: string;
  /** Every other door that also hands them out. */
  also: string[];
  /** Declared names. */
  symbols: string[];
  /** A door that exports one under another name: `{ declaredName: { door: exportName } }`. */
  renamed?: Record<string, Record<string, string>>;
  why: string;
}

const SECOND_DOORS: SecondDoors[] = [
  {
    canonical: '.',
    also: ['./advanced'],
    symbols: [
      'CombinedNarrativeEntry',
      'ReadSummaryMarker',
      'ReadTrackingMode',
      'RetentionPolicy',
      'RuntimeSnapshot',
      'ScopeFactory',
      'StageEvent',
      'StageFunction',
      'WriteSummaryMarker',
      'WriteTrackingMode',
    ],
    renamed: { StageFunction: { '.': 'StageHandler' } },
    why:
      'types an advanced consumer needs beside SharedMemory / StageContext: the executor options and the snapshot they describe ' +
      'live on `.`; `/advanced` repeats the type so one import line is enough.',
  },
  {
    canonical: './recorders',
    also: ['.'],
    symbols: [
      'CompositeRecorder',
      'CompositeSnapshot',
      'EmitEvent',
      'EmitRecorder',
      'NarrativeFormatter',
      'NarrativeRenderer',
      'narrative',
    ],
    why:
      'the main entry offers the everyday recorder names so `import { narrative } from "footprintjs"` keeps working; the ' +
      'recorder family is documented and versioned at `/recorders`.',
  },
  {
    canonical: './recorders',
    also: ['./advanced'],
    symbols: ['AggregatedMetrics', 'StageMetrics'],
    why: 'the result types of MetricRecorder, handed out beside the SharedMemory family for custom-engine users.',
  },
];

// ── reading the package ──────────────────────────────────────────────────────

const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));

/** door → src entry file, from package.json `exports` (`./dist/types/X.d.ts` → `src/X.ts`). */
function doorsOf(): Record<string, string> {
  const doors: Record<string, string> = {};
  for (const [door, target] of Object.entries<Record<string, Record<string, string>> | string>(pkg.exports)) {
    if (door === './package.json') continue;
    const types =
      (target as Record<string, Record<string, string>>).require?.types ??
      (target as Record<string, Record<string, string>>).import?.types;
    const match = /\.\/dist\/(?:types|esm)\/(.+)\.d\.ts$/.exec(types ?? '');
    if (!match) throw new Error(`package.json exports["${door}"] has no types entry this test can map to a src file`);
    doors[door] = join(REPO, 'src', `${match[1]}.ts`);
  }
  return doors;
}

interface Reached {
  declared: string;
  /** door → the name that door exports it under */
  via: Map<string, string>;
}

/** Every symbol every door hands out, aliases resolved to the declaration. */
function reachability(doors: Record<string, string>): Map<ts.Symbol, Reached> {
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(join(REPO, 'tsconfig.json'), ts.sys.readFile).config,
    ts.sys,
    REPO,
  );
  const program = ts.createProgram(Object.values(doors), { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();
  const reached = new Map<ts.Symbol, Reached>();
  for (const [door, file] of Object.entries(doors)) {
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`${file} is not part of the program`);
    for (const exported of checker.getExportsOfModule(checker.getSymbolAtLocation(source)!)) {
      const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      if (!reached.has(target)) reached.set(target, { declared: target.getName(), via: new Map() });
      reached.get(target)!.via.set(door, exported.getName());
    }
  }
  return reached;
}

const doors = doorsOf();
const reached = reachability(doors);
const doubled = [...reached.values()].filter((r) => r.via.size > 1);
const describeDoors = (r: Reached) =>
  [...r.via].map(([door, name]) => `${door}${name === r.declared ? '' : ` as ${name}`}`).join(', ');

// ── unit: the package's own map ──────────────────────────────────────────────

describe('package.json doors', () => {
  it('every door has a src entry file and a typesVersions line (a new door is wired in both)', () => {
    for (const door of Object.keys(doors)) {
      if (door === '.') continue;
      expect(pkg.typesVersions['*'][door.slice(2)], `typesVersions for ${door}`).toBeDefined();
    }
    expect(Object.keys(doors).sort()).toEqual([
      '.',
      './advanced',
      './detach',
      './recorders',
      './trace',
      './write',
      './zod',
    ]);
  });

  it('every door hands out something', () => {
    for (const door of Object.keys(doors)) {
      expect(
        [...reached.values()].some((r) => r.via.has(door)),
        door,
      ).toBe(true);
    }
  });
});

// ── scenario: ownership ──────────────────────────────────────────────────────

describe('export ownership', () => {
  const listed = new Map<string, SecondDoors>();
  for (const group of SECOND_DOORS) for (const symbol of group.symbols) listed.set(symbol, group);

  it('a symbol reachable through two doors is on the list, with its canonical door', () => {
    const undeclared = doubled
      .filter((r) => !listed.has(r.declared))
      .map((r) => `${r.declared}  [${describeDoors(r)}]`);
    expect(
      undeclared,
      'These symbols are exported from more than one door. Keep ONE canonical door and drop the others — or, if a second door ' +
        'is deliberate, add the symbol to SECOND_DOORS in this file with the reason.',
    ).toEqual([]);
  });

  it('every list entry is still double-exported, from exactly the doors it names, under the names it names', () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const r of doubled) {
      const group = listed.get(r.declared);
      if (!group) continue;
      if (seen.has(r.declared))
        problems.push(
          `${r.declared}: two different symbols share this declared name — the list cannot tell them apart`,
        );
      seen.add(r.declared);
      const want = new Map(
        [group.canonical, ...group.also].map((door) => [door, group.renamed?.[r.declared]?.[door] ?? r.declared]),
      );
      if (JSON.stringify([...want].sort()) !== JSON.stringify([...r.via].sort())) {
        problems.push(
          `${r.declared}: listed as [${[...want]
            .map(([d, n]) => `${d}:${n}`)
            .join(', ')}] but reachable as [${describeDoors(r)}]`,
        );
      }
    }
    for (const [symbol] of listed) {
      if (!seen.has(symbol))
        problems.push(`${symbol}: listed in SECOND_DOORS but no longer exported from more than one door — remove it`);
    }
    expect(problems).toEqual([]);
  });

  it('the canonical door of every listed group really exports it (the owner is not a ghost)', () => {
    for (const group of SECOND_DOORS) {
      for (const symbol of group.symbols) {
        const r = doubled.find((d) => d.declared === symbol);
        expect(r?.via.has(group.canonical), `${symbol} @ ${group.canonical}`).toBe(true);
      }
    }
  });

  it('the list is short, and says why for each group', () => {
    expect(SECOND_DOORS.every((g) => g.why.length > 40)).toBe(true);
    expect(SECOND_DOORS.flatMap((g) => g.symbols).length).toBeLessThanOrEqual(19);
  });

  it('no export NAME means two different things across doors', () => {
    const byName = new Map<string, Set<ts.Symbol>>();
    for (const [target, r] of reached) {
      for (const name of r.via.values()) byName.set(name, (byName.get(name) ?? new Set()).add(target));
    }
    const clashes = [...byName].filter(([, targets]) => targets.size > 1).map(([name]) => name);
    expect(clashes).toEqual([]);
  });
});
