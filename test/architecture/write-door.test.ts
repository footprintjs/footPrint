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
 *             properties, aliases, type arguments, at any depth; private members are not part of the
 *             surface) is declared at L0–L3 or in TypeScript's own lib
 *   boundary  the walk is live: it reaches the record types the door's signatures name, skips the
 *             private buffer, and the SAME walk over `/advanced`'s `StageContext` does reach the engine
 */
import { join, relative, resolve, sep } from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { readEdges } from '../../scripts/check-layering.mjs';
import layering from '../../scripts/layering.config.cjs';

const { rankOf, listSourceFiles } = layering;
const REPO = resolve(__dirname, '../..');
const WRITE = join(REPO, 'src/write.ts');
const ADVANCED = join(REPO, 'src/advanced.ts');
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

const repoPath = (file: string) => relative(REPO, file).split(sep).join('/');

// ── the program ──────────────────────────────────────────────────────────────

const parsed = ts.parseJsonConfigFileContent(
  ts.readConfigFile(join(REPO, 'tsconfig.json'), ts.sys.readFile).config,
  ts.sys,
  REPO,
);
const program = ts.createProgram([WRITE, ADVANCED], { ...parsed.options, noEmit: true });
const checker = program.getTypeChecker();

function exportsOf(file: string): ts.Symbol[] {
  const source = program.getSourceFile(file);
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
 * type. A TypeScript lib type (Array, Map, ReadonlySet …) is noted and not walked into, but its type
 * arguments are.
 *
 * Two passes over each member: its TYPE (what the checker resolved) and its written ANNOTATION (the
 * names in it). The second is what catches an alias the checker no longer carries — `phase?:
 * CommitPhase` resolves to `'exit' | 'repeat' | undefined`, a new union with no alias on it.
 */
function walk(roots: ts.Symbol[]): Reached {
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
    if (ts.isTypeReferenceNode(node)) {
      let symbol = checker.getSymbolAtLocation(node.typeName);
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
  /** The annotations of a declaration — its type, its parameters', its type parameters' — never a body. */
  const annotations = (d: ts.Declaration) => {
    if (ts.isFunctionLike(d)) {
      d.parameters.forEach((p) => named(p.type));
      d.typeParameters?.forEach((tp) => named(tp.constraint));
    }
    named((d as { type?: ts.Node }).type);
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

/** The reached declarations that sit above the record (L4+), outside the repo's src, or nowhere at all. */
function aboveTheRecord(reached: Reached): string[] {
  const out: string[] = [];
  for (const [file, names] of reached) {
    if (file === '<lib>') continue;
    const rank = file.startsWith('src/') ? rankOf(file) : null;
    if (rank === null || rank > RECORD_RANK) out.push(`${file} (L${rank ?? '?'}): ${[...names].sort().join(', ')}`);
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

// ── tests ────────────────────────────────────────────────────────────────────

const doorExports = exportsOf(WRITE);

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
  const reached = walk(doorExports);

  it('every declaration its public types reach is declared at L0–L3 (or in TypeScript lib)', () => {
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

  it("the same walk over /advanced's StageContext reaches the engine — the check can fail", () => {
    const stageContext = exportsOf(ADVANCED).find((s) => s.getName() === 'StageContext')!;
    expect(aboveTheRecord(walk([stageContext]))).not.toEqual([]);
  });
});
