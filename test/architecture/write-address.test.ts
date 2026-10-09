/**
 * The write address is the engine's — the record takes it as data (C2).
 *
 * A frame with a run id writes and reads under `runs/<id>/`. Before C2 the record layer spelled that
 * namespace itself (`utils · getRunAndGlobalPaths`, `SharedMemory · getRuns`). Now one L4 constant,
 * `StageContext.ts · RUN_NAMESPACE`, builds every frame's address (`runAddress`), and the record layer
 * takes it as a path prefix: `RecordFrame` holds it (C3), `SharedMemory` and `TransactionBuffer` are
 * handed it. This test reads src with the TypeScript compiler API and
 * fails when an L0–L3 file (the fence's own ranks) names the namespace — a `'runs'` string literal, or
 * `runs` as a property (`state.runs`, `{ runs: … }`) — outside the exceptions below. The list is live —
 * an exception that no longer matches fails too — so it only shrinks.
 *
 *   unit      the scanner: a literal in any quote form, a property name in any position, with the
 *             function it sits in; never a comment, a longer string or a local variable
 *   scenario  THE REAL TREE: StageContext.ts spells it once; no record file names it outside the list
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import {
  type Identifier,
  type Node,
  type SourceFile,
  createSourceFile,
  forEachChild,
  isBindingElement,
  isFunctionLike,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isPropertySignature,
  isShorthandPropertyAssignment,
  isStringLiteral,
  ScriptTarget,
} from 'typescript';
import { describe, expect, it } from 'vitest';

import layering from '../../scripts/layering.config.cjs';

const REPO = resolve(__dirname, '../..');
const NAMESPACE = 'runs';
const OWNER = 'src/lib/memory/StageContext.ts';

/** Names below L4 that a later step removes: `redaction.ts` moves to L4 in C4. */
const EXCEPTIONS = [
  {
    file: 'src/lib/memory/redaction.ts',
    within: 'verdictOfRead',
    why: 'a mapper reading the namespace root reads every namespaced key',
  },
  {
    file: 'src/lib/memory/redaction.ts',
    within: 'retainState',
    why: "the mirror's seed scrubs every run namespace under the root",
  },
];

/** The name of the function or method around `node`, if it has one. */
function enclosingName(node: Node, file: SourceFile): string | undefined {
  for (let at = node.parent; at; at = at.parent) {
    if (isFunctionLike(at) && at.name) return at.name.getText(file);
  }
  return undefined;
}

/** Is `node` a property's name — read, written, declared or destructured? A local variable is not. */
function namesAProperty(node: Identifier): boolean {
  const at = node.parent;
  if (isPropertyAccessExpression(at)) return at.name === node;
  if (isPropertyAssignment(at) || isPropertySignature(at) || isPropertyDeclaration(at)) return at.name === node;
  if (isBindingElement(at)) return (at.propertyName ?? at.name) === node;
  return isShorthandPropertyAssignment(at);
}

/** Every place `source` names the namespace, with the name of the function or method around it. */
function spellings(source: string): Array<{ line: number; within?: string }> {
  const file = createSourceFile('probe.ts', source, ScriptTarget.Latest, /* setParentNodes */ true);
  const found: Array<{ line: number; within?: string }> = [];
  const visit = (node: Node): void => {
    const literal = (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) && node.text === NAMESPACE;
    if (literal || (isIdentifier(node) && node.text === NAMESPACE && namesAProperty(node))) {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      found.push({ line, within: enclosingName(node, file) });
    }
    forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe('the namespace scanner', () => {
  it('finds the literal in every quote form, with the function it sits in; never a comment or a longer string', () => {
    expect(spellings("const N = 'runs';")).toEqual([{ line: 1, within: undefined }]);
    expect(spellings('class A {\n  m(k: string) {\n    return k === "runs";\n  }\n}')).toEqual([
      { line: 3, within: 'm' },
    ]);
    expect(spellings('function f() { return [`runs`, id]; }')).toEqual([{ line: 1, within: 'f' }]);
    expect(spellings("// 'runs'\n/** `['runs', id]` */\nconst a = 'runs/x';")).toEqual([]);
  });

  it('finds the namespace as a property in every position; never a local variable', () => {
    const lines = (source: string) => spellings(source).map((s) => s.line);
    expect(lines('function f(s) {\n  return s.runs;\n}')).toEqual([2]);
    expect(lines('const o = { runs: 1 };\nconst p = { runs };\ntype T = { runs?: unknown };')).toEqual([1, 2, 3]);
    expect(lines('class C {\n  runs = 1;\n}\nconst { runs: r } = o;\nconst { runs } = o;')).toEqual([2, 4, 5]);
    expect(lines('const runs = 1;\nfunction g(runs: number) {\n  return runs + 1;\n}')).toEqual([]);
  });
});

describe('the footprintjs source tree', () => {
  const files: string[] = layering.listSourceFiles(REPO);
  const spelled = new Map(files.map((file) => [file, spellings(readFileSync(join(REPO, file), 'utf8'))]));
  const recordFiles = files.filter((file) => layering.rankOf(file) <= 3);

  it('the engine names the namespace once: the L4 constant every frame builds its address from', () => {
    expect(layering.rankOf(OWNER)).toBe(4);
    expect(spelled.get(OWNER)).toHaveLength(1);
  });

  it('no record file (L0–L3) names it outside the exceptions — the record takes the address as data', () => {
    expect(recordFiles.length).toBeGreaterThan(60);
    const strays = recordFiles.flatMap((file) =>
      (spelled.get(file) ?? [])
        .filter((s) => !EXCEPTIONS.some((e) => e.file === file && e.within === s.within))
        .map((s) => `${file}:${s.line}${s.within ? ` (${s.within})` : ''}`),
    );
    expect(
      strays,
      'The run namespace is named below L4. The record layer takes the write address as data (C2): ' +
        `take it from the frame (RecordFrame · address, built by StageContext.ts · runAddress) instead of naming '${NAMESPACE}'.`,
    ).toEqual([]);
  });

  it('every exception still names it — the list only shrinks', () => {
    for (const e of EXCEPTIONS) {
      expect(
        spelled.get(e.file)?.some((s) => s.within === e.within),
        `${e.file} · ${e.within} no longer names '${NAMESPACE}' — delete its exception`,
      ).toBe(true);
    }
  });
});
