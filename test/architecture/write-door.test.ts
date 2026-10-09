/**
 * The write door is the record's own — `footprintjs/write` (C5) loads and names nothing of the engine.
 *
 * The extraction plan's "ready" check (docs/design/2026-10-trace-extraction.md, section 8: no record
 * file reaches the engine, R1/R2), applied to the one door that hands the record layer out. A writer
 * who imports `/write` gets the classes the engine itself writes with — and must get nothing else:
 * no frame, no scope, no executor, at run time or in a type.
 *
 *   contract  the door hands out exactly the plan's list (C5): `RecordFrame`, `SharedMemory`, `EventLog`
 *             and their option types — a new name on it is a decision, made here
 *   scenario  RUNTIME — every file `src/write.ts` loads, through value imports at any depth (the edges
 *             `scripts/check-layering.mjs · readEdges` keeps), is a record file (`layering.config.cjs ·
 *             RECORD_FILES`, all at L0–L3): importing `/write` loads nothing of the engine
 *   scenario  TYPES — every declaration the door's public types reach (class members, signatures,
 *             properties, aliases, type arguments, base types, type-parameter constraints and defaults,
 *             at any depth; private members are not part of the surface) is declared in a record file
 *             or in TypeScript's own lib. No name is listed: since C6 the engine types live outside the
 *             record (`memory/frameTypes.ts`, L4; the retention family in `capture/`), so the walk
 *             alone finds every one of them
 *   boundary  the walk is live: it reaches the record types the door's signatures name, skips the
 *             private buffer, catches each engine type C6 moved out of `memory/types.ts`, and the SAME
 *             walk over the engine's frame (`StageContext`) reaches outside the record
 *   boundary  a synthetic program: an engine type reached only through a heritage clause, a
 *             type-parameter default, an interface constraint or an alias constraint is caught; a
 *             type that names none passes
 */
import { join, relative, resolve, sep } from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { readEdges } from '../../scripts/check-layering.mjs';
import layering from '../../scripts/layering.config.cjs';

const { rankOf, isRecordFile, listSourceFiles } = layering;
const REPO = resolve(__dirname, '../..');
const WRITE = join(REPO, 'src/write.ts');
/** The engine's frame (L4) — the negative control: the same walk over it must reach outside the record. */
const FRAME = join(REPO, 'src/lib/memory/StageContext.ts');

/** C5's list (docs/design/2026-10-trace-extraction.md): the three classes and their option types. */
const PLAN = [
  'CommitStamp',
  'EventLog',
  'RecordEncoding',
  'RecordFrame',
  'SharedMemory',
  'WriteProvenanceMode',
  'WriteScrub',
  'WriteVerb',
];

/**
 * The engine types C6(a) moved out of the record's `memory/types.ts` — named here only to show the
 * walk catches each one by where it is declared (`ScopeFactory`'s copy there was dead and is gone).
 */
const MOVED_ENGINE_TYPES: Record<string, string[]> = {
  'src/lib/memory/frameTypes.ts': [
    'FlowControlType',
    'FlowMessage',
    'ReadTrackingMode',
    'StageSnapshot',
    'WriteTrackingMode',
  ],
  'src/lib/capture/policies.ts': ['RetentionPolicy'],
  'src/lib/capture/summarize.ts': ['ReadSummaryMarker', 'WriteSummaryMarker'],
};

const repoPath = (file: string) => relative(REPO, file).split(sep).join('/');

// ── the program ──────────────────────────────────────────────────────────────

const parsed = ts.parseJsonConfigFileContent(
  ts.readConfigFile(join(REPO, 'tsconfig.json'), ts.sys.readFile).config,
  ts.sys,
  REPO,
);
const OPTIONS: ts.CompilerOptions = { ...parsed.options, noEmit: true };
const program = ts.createProgram([WRITE, FRAME], OPTIONS);

function exportsOf(from: ts.Program, file: string): ts.Symbol[] {
  const checker = from.getTypeChecker();
  const source = from.getSourceFile(file);
  if (!source) throw new Error(`${file} is not part of the program`);
  return checker
    .getExportsOfModule(checker.getSymbolAtLocation(source)!)
    .map((s) => (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s));
}

// ── the type walk ────────────────────────────────────────────────────────────

/** Where each declaration a walk reached lives: repo-relative file → the names declared there. */
type Reached = Map<string, Set<string>>;

const isLibFile = (file: string) => file.split(sep).join('/').includes('/node_modules/typescript/lib/');
const isPrivate = (symbol: ts.Symbol) =>
  (symbol.declarations ?? []).some(
    (d) => ts.getCombinedModifierFlags(d) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected),
  ) || symbol.getName().startsWith('#');

/**
 * Every declaration the public surface of `roots` reaches. A class is its static side (constructor
 * signatures, static members, `prototype`) and its instance; an interface or alias is its declared
 * type; a class or interface also reaches its base types. A TypeScript lib type (Array, Map,
 * ReadonlySet …) is noted and not walked into, but its type arguments are.
 *
 * Two passes over each declaration: its TYPE (what the checker resolved) and what it WRITES (the
 * names in its annotations, heritage clauses and type-parameter constraints and defaults). The second
 * catches what the checker no longer carries — `phase?: CommitPhase` resolves to `'exit' | 'repeat' |
 * undefined`, a new union with no alias on it — and what no member's type shows, such as an
 * `extends` whose members are all primitives or a default no member uses.
 */
function walk(checker: ts.TypeChecker, roots: ts.Symbol[]): Reached {
  const reached: Reached = new Map();
  const seen = new Set<ts.Type>();
  const note = (symbol: ts.Symbol | undefined) => {
    for (const d of symbol?.declarations ?? []) {
      const file = d.getSourceFile().fileName;
      const key = isLibFile(file) ? '<lib>' : repoPath(file);
      if (!reached.has(key)) reached.set(key, new Set());
      reached.get(key)!.add(symbol!.getName());
    }
  };
  const named = (node: ts.Node | undefined): void => {
    if (!node) return;
    const nameNode = ts.isTypeReferenceNode(node)
      ? node.typeName
      : ts.isExpressionWithTypeArguments(node)
      ? node.expression
      : undefined;
    if (nameNode) {
      let symbol = checker.getSymbolAtLocation(nameNode);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      if (symbol && !(symbol.flags & ts.SymbolFlags.TypeParameter)) {
        note(symbol);
        if (symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Class)) {
          visitType(checker.getDeclaredTypeOfSymbol(symbol));
        }
      }
    }
    ts.forEachChild(node, named);
  };
  /** What a declaration writes — its type, parameters, heritage, type parameters' constraints and defaults — never a body. */
  const annotations = (d: ts.Declaration) => {
    const written = d as {
      type?: ts.Node;
      parameters?: ts.NodeArray<ts.ParameterDeclaration>;
      typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration>;
      heritageClauses?: ts.NodeArray<ts.HeritageClause>;
    };
    written.parameters?.forEach((p) => named(p.type));
    written.typeParameters?.forEach((tp) => {
      named(tp.constraint);
      named(tp.default);
    });
    written.heritageClauses?.forEach((clause) => clause.types.forEach(named));
    named(written.type);
  };
  const visitSignature = (sig: ts.Signature) => {
    const declaration = sig.getDeclaration() as ts.Declaration | undefined;
    if (declaration) annotations(declaration);
    for (const p of sig.getParameters()) visitType(checker.getTypeOfSymbol(p));
    for (const tp of sig.getTypeParameters() ?? []) {
      const constraint = tp.getConstraint();
      if (constraint) visitType(constraint);
    }
    visitType(sig.getReturnType());
  };
  const visitType = (type: ts.Type): void => {
    if (seen.has(type)) return;
    seen.add(type);
    if (type.aliasSymbol) {
      note(type.aliasSymbol);
      type.aliasTypeArguments?.forEach(visitType);
    }
    if (type.isUnionOrIntersection()) {
      type.types.forEach(visitType);
      return;
    }
    if (!(type.flags & ts.TypeFlags.Object)) return;
    const symbol = type.getSymbol();
    note(symbol);
    const object = type as ts.ObjectType;
    if (object.objectFlags & ts.ObjectFlags.Reference)
      checker.getTypeArguments(type as ts.TypeReference).forEach(visitType);
    if ((symbol?.declarations ?? []).some((d) => isLibFile(d.getSourceFile().fileName))) return;
    if (object.objectFlags & ts.ObjectFlags.ClassOrInterface) {
      checker.getBaseTypes(type as ts.InterfaceType).forEach(visitType);
    }
    for (const member of checker.getPropertiesOfType(type)) {
      if (isPrivate(member)) continue;
      visitType(checker.getTypeOfSymbol(member));
      member.declarations?.forEach(annotations);
    }
    type.getCallSignatures().forEach(visitSignature);
    type.getConstructSignatures().forEach(visitSignature);
    for (const info of checker.getIndexInfosOfType(type)) {
      visitType(info.keyType);
      visitType(info.type);
    }
  };
  for (const root of roots) {
    note(root);
    root.declarations?.forEach(annotations);
    if (root.flags & ts.SymbolFlags.Class) visitType(checker.getTypeOfSymbol(root));
    if (root.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) {
      visitType(checker.getDeclaredTypeOfSymbol(root));
    }
  }
  return reached;
}

/** What a walk reached that is not the record's: a declaration in no record file (with its layer). */
function outsideTheRecord(reached: Reached): string[] {
  const out: string[] = [];
  for (const [file, names] of reached) {
    if (file === '<lib>' || isRecordFile(file)) continue;
    const rank = file.startsWith('src/') ? rankOf(file) : null;
    out.push(`${file} (L${rank ?? '?'}): ${[...names].sort().join(', ')}`);
  }
  return out.sort();
}

// ── the runtime closure ──────────────────────────────────────────────────────

/** Every src file `entry` loads at run time: value (and lazy) imports, followed to any depth. */
function loads(entry: string): string[] {
  const edges = readEdges(REPO, listSourceFiles(REPO)) as { from: string; to: string; kind: string }[];
  const next = new Map<string, string[]>();
  for (const e of edges.filter((x) => x.kind !== 'type')) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length > 0)
    for (const to of next.get(queue.shift()!) ?? []) if (!seen.has(to) && seen.add(to)) queue.push(to);
  return [...seen].sort();
}

// ── a synthetic program for the walk's own boundary ──────────────────────────

/** Virtual files: a record-side file (slice/, L3) whose types reach an engine-side one (engine/, L6) only indirectly. */
const SYNTHETIC: Record<string, string> = {
  [join(REPO, 'src/lib/engine/__walk_probe_engine.ts')]:
    'export interface EngineIface { k: number }\nexport interface EngineThing { k: string }\n',
  [join(REPO, 'src/lib/slice/__walk_probe_door.ts')]: [
    "import type { EngineIface, EngineThing } from '../engine/__walk_probe_engine';",
    'export interface Heritage extends EngineIface { n: number }',
    'export interface Defaulted<T = EngineThing> { n: number; t?: T extends string ? 1 : 0 }',
    'export interface Constrained<T extends EngineThing> { n: number; k?: keyof T }',
    'export type Aliased<T extends EngineThing = EngineThing> = { n: number; k?: keyof T };',
    'export interface Clean { n: number; s: string; when: Date }',
  ].join('\n'),
};

function syntheticProgram(): ts.Program {
  const host = ts.createCompilerHost(OPTIONS);
  const base = { getSourceFile: host.getSourceFile, fileExists: host.fileExists, readFile: host.readFile };
  host.getSourceFile = (file, version, onError, create) =>
    SYNTHETIC[file] !== undefined
      ? ts.createSourceFile(file, SYNTHETIC[file]!, version, true)
      : base.getSourceFile(file, version, onError, create);
  host.fileExists = (file) => SYNTHETIC[file] !== undefined || base.fileExists(file);
  host.readFile = (file) => SYNTHETIC[file] ?? base.readFile(file);
  return ts.createProgram(Object.keys(SYNTHETIC), OPTIONS, host);
}

// ── tests ────────────────────────────────────────────────────────────────────

const doorExports = exportsOf(program, WRITE);

describe('footprintjs/write — the door', () => {
  it("hands out exactly C5's list: the three classes and their option types", () => {
    expect(doorExports.map((s) => s.getName()).sort()).toEqual(PLAN);
  });
});

describe('footprintjs/write — engine-free at run time', () => {
  const files = loads('src/write.ts');

  it('every file it loads is a record file (RECORD_FILES, all at L0–L3)', () => {
    const outside = files.filter((f) => f !== 'src/write.ts').filter((f) => !isRecordFile(f));
    expect(outside, 'importing footprintjs/write must load no frame, scope or engine file').toEqual([]);
  });

  it('the closure is live: it loads the three classes and the commit they share', () => {
    for (const f of [
      'src/lib/memory/RecordFrame.ts',
      'src/lib/memory/SharedMemory.ts',
      'src/lib/memory/EventLog.ts',
      'src/lib/memory/recordCommit.ts',
    ]) {
      expect(files).toContain(f);
    }
  });
});

describe('footprintjs/write — engine-free in every type it names', () => {
  const checker = program.getTypeChecker();
  const reached = walk(checker, doorExports);

  it('every declaration its public types reach is the record’s (a RECORD_FILES file) or TypeScript lib', () => {
    expect(outsideTheRecord(reached), 'a /write signature names a type declared outside the record').toEqual([]);
  });

  it('the walk is live: it reaches the record types the signatures name, and not the private buffer', () => {
    const names = new Set([...reached.values()].flatMap((s) => [...s]));
    for (const name of [
      'CommitBundle',
      'TraceEntry',
      'MemoryPatch',
      'UntrackedSource',
      'CommitPhase',
      'EmitSourcePosition',
    ]) {
      expect(names, name).toContain(name);
    }
    expect(names).not.toContain('TransactionBuffer');
  });

  it('the walk alone catches every engine type C6 moved out of memory/types.ts — no list of names', () => {
    for (const [file, names] of Object.entries(MOVED_ENGINE_TYPES)) {
      const moved = exportsOf(program, join(REPO, file)).filter((s) => names.includes(s.getName()));
      expect(moved.map((s) => s.getName()).sort(), file).toEqual([...names].sort());
      for (const symbol of moved) {
        expect(outsideTheRecord(walk(checker, [symbol])).join('\n'), symbol.getName()).toContain(`${file} (L`);
      }
    }
  });

  it("the same walk over the engine's frame (StageContext) reaches outside the record — the check can fail", () => {
    const stageContext = exportsOf(program, FRAME).find((s) => s.getName() === 'StageContext')!;
    expect(outsideTheRecord(walk(checker, [stageContext]))).not.toEqual([]);
  });
});

describe('the type walk — what it must not miss (a synthetic program)', () => {
  const probe = syntheticProgram();
  const probeChecker = probe.getTypeChecker();
  const door = exportsOf(probe, join(REPO, 'src/lib/slice/__walk_probe_door.ts'));
  const leaks = (name: string) =>
    outsideTheRecord(
      walk(
        probeChecker,
        door.filter((s) => s.getName() === name),
      ),
    );

  it.each(['Heritage', 'Defaulted', 'Constrained', 'Aliased'])(
    '%s reaches the engine file only indirectly — and is caught',
    (name) => {
      expect(leaks(name).join('\n')).toMatch(/src\/lib\/engine\/__walk_probe_engine\.ts \(L6\)/);
    },
  );

  it('a type that names nothing of the engine passes', () => {
    expect(leaks('Clean')).toEqual([]);
  });
});
