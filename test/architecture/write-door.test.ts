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
 *             `scripts/check-layering.mjs · readEdges` keeps), sits at L0–L3 (`layering.config.cjs ·
 *             rankOf`): importing `/write` loads no L4+ file
 *   scenario  TYPES — every declaration the door's public types reach (class members, signatures,
 *             properties, aliases, type arguments, base types, type-parameter constraints and defaults,
 *             at any depth; private members are not part of the surface) is declared at L0–L3 or in
 *             TypeScript's own lib, and none is an engine type still declared in a record file (C6(a)
 *             moves those out of `memory/types.ts`; until then they are named here)
 *   boundary  the walk is live: it reaches the record types the door's signatures name, skips the
 *             private buffer, and the SAME walk over the engine's frame (`StageContext`) reaches L4+
 *   boundary  a synthetic program: an engine type reached only through a heritage clause, a
 *             type-parameter default, an interface constraint or an alias constraint is caught; a
 *             type that names none passes
 */
import { join, relative, resolve, sep } from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { readEdges } from '../../scripts/check-layering.mjs';
import layering from '../../scripts/layering.config.cjs';

const { rankOf, listSourceFiles } = layering;
const REPO = resolve(__dirname, '../..');
const WRITE = join(REPO, 'src/write.ts');
/** The engine's frame (L4) — the negative control: the same walk over it must reach above the record. */
const FRAME = join(REPO, 'src/lib/memory/StageContext.ts');
const RECORD_RANK = 3;

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
 * Engine types still DECLARED in a record file (`memory/types.ts`, L0) — the rank check cannot see
 * them until C6(a) moves them to an engine-side file, so the walk refuses them by name until then.
 */
const ENGINE_TYPES_IN_RECORD_FILES = [
  'FlowControlType',
  'FlowMessage',
  'ReadSummaryMarker',
  'ReadTrackingMode',
  'RetentionPolicy',
  'ScopeFactory',
  'StageSnapshot',
  'WriteSummaryMarker',
  'WriteTrackingMode',
];

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

/**
 * What a walk reached that is not the record's: a declaration above L3, outside the repo's `src`, or
 * in no layer; and, by name, an engine type still declared in a record file.
 */
function aboveTheRecord(reached: Reached): string[] {
  const out: string[] = [];
  for (const [file, names] of reached) {
    if (file === '<lib>') continue;
    const rank = file.startsWith('src/') ? rankOf(file) : null;
    if (rank === null || rank > RECORD_RANK) out.push(`${file} (L${rank ?? '?'}): ${[...names].sort().join(', ')}`);
    const engine = [...names].filter((n) => ENGINE_TYPES_IN_RECORD_FILES.includes(n));
    if (engine.length > 0) out.push(`${file}: engine types until C6 — ${engine.sort().join(', ')}`);
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

  it('every file it loads sits at L0–L3', () => {
    const above = files.filter((f) => f !== 'src/write.ts').filter((f) => (rankOf(f) ?? Infinity) > RECORD_RANK);
    expect(above, 'importing footprintjs/write must load no frame, scope or engine file').toEqual([]);
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

  it('every declaration its public types reach is the record’s (L0–L3, no engine type by name) or TypeScript lib', () => {
    expect(aboveTheRecord(reached), 'a /write signature names a type declared above the record').toEqual([]);
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

  it("the same walk over the engine's frame (StageContext) reaches above the record — the check can fail", () => {
    const stageContext = exportsOf(program, FRAME).find((s) => s.getName() === 'StageContext')!;
    expect(aboveTheRecord(walk(checker, [stageContext]))).not.toEqual([]);
  });
});

describe('the type walk — what it must not miss (a synthetic program)', () => {
  const probe = syntheticProgram();
  const probeChecker = probe.getTypeChecker();
  const door = exportsOf(probe, join(REPO, 'src/lib/slice/__walk_probe_door.ts'));
  const leaks = (name: string) =>
    aboveTheRecord(
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
