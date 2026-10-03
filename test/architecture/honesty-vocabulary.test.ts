/**
 * One vocabulary for what a reader cannot see (F4a) — asked of the type checker, over `footprintjs/trace`.
 *
 * `memory/honesty.ts · HONESTY_CODES` is the registry of every honesty code a trace reader speaks, and a
 * union declared through `RegisteredCode` cannot hold a code the registry does not. What that cannot stop
 * is a NEW union of codes that never goes through `RegisteredCode` — a second vocabulary, with its own
 * words, that a why-panel or an agent tool would have to explain from a table of its own. This test asks
 * the TypeScript checker for every type alias `src/trace.ts` exports (re-exports resolved to their
 * declarations) and, for each one that is a union of string literals, demands one of two things:
 *
 *   - every member is a registered code (`Object.keys(HONESTY_CODES)`), or
 *   - the alias is on `NOT_HONESTY` below, with the reason it is a different kind of word.
 *
 *   unit      the classifier: a union of string literals is found (through an alias of an alias too);
 *             an object, a lone literal, a union with a non-literal member and a generic are not
 *   scenario  THE REAL DOOR: the vocabularies the registry guards are seen; every other literal union is
 *             registered or named; every name on NOT_HONESTY is still exported and still a literal union
 *             (so the list cannot rot into a blanket pass)
 */
import { join, resolve } from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { HONESTY_CODES } from '../../src/lib/memory/honesty';

const REPO = resolve(__dirname, '../..');
const TRACE = join(REPO, 'src/trace.ts');

/**
 * Unions of string literals `footprintjs/trace` exports that are NOT honesty vocabularies — each with
 * the reason. A name here is a decision, not an escape hatch: it must still be exported and still be a
 * literal union, or the scenario below fails.
 */
const NOT_HONESTY: Record<string, string> = {
  AxisRefusal:
    'what splitAxis answers when a list of stops has no bookended axis — a verdict on the stops, not a gap in the recording',
  CommitPhase:
    'which continuation of a stage a bundle is (exit / repeat, F8) — structure of the record, not a gap in it',
  MoveRefusal: 'why a cursor move did not happen (clamped, miss, empty) — navigation, not a gap in the recording',
  StopKind: 'what a time-travel stop is (its place on the axis) — structure, not what a reader cannot see',
  InOutPhase: 'which side of a boundary an in/out entry records — structure',
  TopologyIncomingKind: 'how a topology node was entered — structure',
  UntrackedSource:
    "the VALUES `CausalNode.incompleteSources` carries (args, env, silent); the signal itself is registered as 'incomplete-sources'",
};

/** The vocabularies the registry exists to guard — the scan must SEE each of them, or it proves nothing. */
const GUARDED = [
  'HonestyCode',
  'HonestyNoteCode',
  'MissingSliceReason',
  'MissingProvenanceReason',
  'FedBasis',
  'AttributionBasis',
  'FoldBasis',
];

/** The members of `type` when it is a union of string literals, and nothing else; `undefined` otherwise. */
function literalUnionMembers(type: ts.Type): string[] | undefined {
  if (!type.isUnion()) return undefined;
  if (!type.types.every((member) => member.isStringLiteral())) return undefined;
  return type.types.map((member) => (member as ts.StringLiteralType).value).sort();
}

/** Every exported type alias of `file` that is a union of string literals: name → its members. */
function exportedLiteralUnions(program: ts.Program, file: string): Map<string, string[]> {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  if (!source) throw new Error(`${file} is not part of the program`);
  const found = new Map<string, string[]>();
  for (const exported of checker.getExportsOfModule(checker.getSymbolAtLocation(source)!)) {
    const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    if (!(target.flags & ts.SymbolFlags.TypeAlias)) continue;
    const members = literalUnionMembers(checker.getDeclaredTypeOfSymbol(target));
    if (members) found.set(exported.getName(), members);
  }
  return found;
}

/** A program over the repo's own tsconfig, optionally with one in-memory file. */
function programOver(root: string, virtual?: { file: string; source: string }): ts.Program {
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(join(REPO, 'tsconfig.json'), ts.sys.readFile).config,
    ts.sys,
    REPO,
  );
  const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, types: [] };
  const host = ts.createCompilerHost(options);
  if (virtual) {
    const getSourceFile = host.getSourceFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    const readFile = host.readFile.bind(host);
    host.getSourceFile = (file, languageVersion, ...rest) =>
      file === virtual.file
        ? ts.createSourceFile(file, virtual.source, languageVersion)
        : getSourceFile(file, languageVersion, ...rest);
    host.fileExists = (file) => file === virtual.file || fileExists(file);
    host.readFile = (file) => (file === virtual.file ? virtual.source : readFile(file));
  }
  return ts.createProgram([root], options, host);
}

// ── unit: the classifier ─────────────────────────────────────────────────────

describe('the literal-union classifier', () => {
  const PROBE = join(REPO, 'src/__honesty-vocabulary-probe__.ts');
  const source = [
    "type Inner = 'x' | 'y';",
    'export type Union = Inner;',
    "export type Widened = Inner | 'z';",
    "export type Lone = 'x';",
    "export type Mixed = 'x' | number;",
    "export type Shape = { kind: 'x' | 'y' };",
    'export type Generic<T extends string> = T;',
    "export const value: 'x' | 'y' = 'x';",
  ].join('\n');
  const found = exportedLiteralUnions(programOver(PROBE, { file: PROBE, source }), PROBE);

  it('finds a union of string literals, through an alias of an alias', () => {
    expect(found.get('Union')).toEqual(['x', 'y']);
    expect(found.get('Widened')).toEqual(['x', 'y', 'z']);
  });

  it('passes over a lone literal, a mixed union, an object, a generic and a value', () => {
    expect([...found.keys()].sort()).toEqual(['Union', 'Widened']);
  });
});

// ── scenario: the real door ──────────────────────────────────────────────────

describe('footprintjs/trace — every union of string literals it exports', () => {
  const unions = exportedLiteralUnions(programOver(TRACE), TRACE);
  const registered = new Set(Object.keys(HONESTY_CODES));

  it('the scan sees the vocabularies the registry guards — each one a literal union', () => {
    for (const name of GUARDED) expect(unions.has(name), name).toBe(true);
  });

  it('is inside the registry, or named on NOT_HONESTY with its reason', () => {
    const strays = [...unions]
      .filter(([name]) => !Object.keys(NOT_HONESTY).includes(name))
      .map(([name, members]) => [name, members.filter((member) => !registered.has(member))] as const)
      .filter(([, unregistered]) => unregistered.length > 0)
      .map(([name, unregistered]) => `${name}: ${unregistered.map((m) => `'${m}'`).join(' | ')}`);
    expect(
      strays,
      'A union of string literals on footprintjs/trace holds codes HONESTY_CODES does not. If it is an honesty ' +
        'vocabulary (it says what a reader cannot see), register each code in src/lib/memory/honesty.ts and declare ' +
        'the union through RegisteredCode; if it is a different kind of word, add it to NOT_HONESTY with the reason.',
    ).toEqual([]);
  });

  it('every name on NOT_HONESTY is still exported and still a literal union — the list cannot rot', () => {
    for (const name of Object.keys(NOT_HONESTY)) expect(unions.has(name), name).toBe(true);
  });

  it('no name on NOT_HONESTY is already inside the registry (it would be an honesty vocabulary after all)', () => {
    for (const name of Object.keys(NOT_HONESTY)) {
      expect(
        unions.get(name)!.every((member) => registered.has(member)),
        name,
      ).toBe(false);
    }
  });
});
