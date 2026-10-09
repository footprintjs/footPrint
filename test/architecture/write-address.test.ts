/**
 * The write address is the engine's — the record takes it as data (C2).
 *
 * A frame with a run id writes and reads under `runs/<id>/`. Before C2 the record layer spelled that
 * namespace itself (`utils · getRunAndGlobalPaths`, `SharedMemory · getRuns`). Now one L4 constant,
 * `StageContext.ts · RUN_NAMESPACE`, builds every frame's address, and `SharedMemory` and
 * `TransactionBuffer` take it as a path prefix. This test reads src with the TypeScript compiler API and
 * fails on a `'runs'` string literal in an L0–L3 file (the fence's own ranks), outside the exceptions
 * below. The list is live — an exception that no longer matches fails too — so it only shrinks.
 *
 *   unit      the scanner: a literal in any quote form is found, with the function it sits in
 *   scenario  THE REAL TREE: StageContext.ts spells it once; no record file spells it outside the list
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import {
  type Node,
  type SourceFile,
  createSourceFile,
  forEachChild,
  isFunctionLike,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
  ScriptTarget,
} from 'typescript';
import { describe, expect, it } from 'vitest';

import layering from '../../scripts/layering.config.cjs';

const REPO = resolve(__dirname, '../..');
const NAMESPACE = 'runs';
const OWNER = 'src/lib/memory/StageContext.ts';

/** Spellings below L4 that a later step removes. */
const EXCEPTIONS = [
  {
    file: 'src/lib/memory/redaction.ts',
    within: 'verdictOfRead',
    why: 'a mapper reading the namespace root reads every namespaced key; C4 lifts the verdict to L4',
  },
];

/** The name of the function or method around `node`, if it has one. */
function enclosingName(node: Node, file: SourceFile): string | undefined {
  for (let at = node.parent; at; at = at.parent) {
    if (isFunctionLike(at) && at.name) return at.name.getText(file);
  }
  return undefined;
}

/** Every `'runs'` string literal in `source`, with the name of the function or method around it. */
function spellings(source: string): Array<{ line: number; within?: string }> {
  const file = createSourceFile('probe.ts', source, ScriptTarget.Latest, /* setParentNodes */ true);
  const found: Array<{ line: number; within?: string }> = [];
  const visit = (node: Node): void => {
    if ((isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) && node.text === NAMESPACE) {
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
});

describe('the footprintjs source tree', () => {
  const files: string[] = layering.listSourceFiles(REPO);
  const spelled = new Map(files.map((file) => [file, spellings(readFileSync(join(REPO, file), 'utf8'))]));
  const recordFiles = files.filter((file) => layering.rankOf(file) <= 3);

  it('the engine names the namespace once: the L4 constant every frame builds its address from', () => {
    expect(layering.rankOf(OWNER)).toBe(4);
    expect(spelled.get(OWNER)).toHaveLength(1);
  });

  it('no record file (L0–L3) spells it outside the named exceptions — the record takes the address as data', () => {
    expect(recordFiles.length).toBeGreaterThan(60);
    const strays = recordFiles.flatMap((file) =>
      (spelled.get(file) ?? [])
        .filter((s) => !EXCEPTIONS.some((e) => e.file === file && e.within === s.within))
        .map((s) => `${file}:${s.line}${s.within ? ` (${s.within})` : ''}`),
    );
    expect(
      strays,
      'The run namespace is spelled below L4. The record layer takes the write address as data (C2): ' +
        `take it from the frame (StageContext · address) instead of spelling '${NAMESPACE}'.`,
    ).toEqual([]);
  });

  it('every exception still matches a spelling — the list only shrinks', () => {
    for (const e of EXCEPTIONS) {
      expect(
        spelled.get(e.file)?.some((s) => s.within === e.within),
        `${e.file} · ${e.within} no longer spells '${NAMESPACE}' — delete its exception`,
      ).toBe(true);
    }
  });
});
