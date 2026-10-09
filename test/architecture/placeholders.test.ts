/**
 * Placeholders — each string a redaction leaves where a value was has ONE owner (F4a; split by owner in C4).
 *
 * `'REDACTED'` is what the commit log and the redacted mirror carry (and so a fold, a slice and a
 * subflow's served state) — a RECORD byte, owned by `memory/placeholders.ts` (`LOG_PLACEHOLDER`, L0);
 * `'[REDACTED]'` is what the scope channel carries — the ENGINE's, owned by the verdict that writes it,
 * `memory/redaction.ts` (`SCOPE_PLACEHOLDER`, L4). Before F4a six files each spelled one of them as a
 * string literal, and a spelling kept in six places is a placeholder a reader can no longer match on.
 * This test reads every `src/**\/*.ts` with the TypeScript compiler API and fails on a string literal
 * that IS either of them anywhere but its owner.
 *
 *   unit      the scanner: every quote form, a type position and a template part are found; a comment,
 *             an identifier and a sentence that merely says the word are not
 *   scenario  THE REAL TREE: each owner spells its placeholder exactly once and no other file spells either
 *
 * The scan walks syntax nodes, not text, so a doc comment may say `'[REDACTED]'` as often as it
 * likes — only a literal the program can actually emit counts.
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import layering from '../../scripts/layering.config.cjs';

const REPO = resolve(__dirname, '../..');
/** Each placeholder → the one file that spells it: the record's string at L0, the verdict's at L4. */
const OWNERS: Record<string, string> = {
  REDACTED: 'src/lib/memory/placeholders.ts',
  '[REDACTED]': 'src/lib/memory/redaction.ts',
};
const PLACEHOLDERS = new Set(Object.keys(OWNERS));

interface Spelling {
  /** Which placeholder the literal is. */
  text: string;
  /** 1-based line of the literal. */
  line: number;
}

/** Every string literal in `source` that IS a placeholder. Comments are not nodes, so they never count. */
function spellings(source: string): Spelling[] {
  const file = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const found: Spelling[] = [];
  const visit = (node: ts.Node): void => {
    const isLiteral =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node);
    if (isLiteral && PLACEHOLDERS.has(node.text)) {
      found.push({ text: node.text, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

// ── unit: the scanner ────────────────────────────────────────────────────────

describe('the placeholder scanner', () => {
  const texts = (source: string) => spellings(source).map((s) => s.text);

  it('finds a placeholder in every quote form', () => {
    expect(texts("const a = 'REDACTED';")).toEqual(['REDACTED']);
    expect(texts('const a = "[REDACTED]";')).toEqual(['[REDACTED]']);
    expect(texts('const a = `REDACTED`;')).toEqual(['REDACTED']);
  });

  it('finds it wherever a literal can sit: a ternary arm, an argument, a property, a default, a type, a template part', () => {
    expect(texts("const v = cond ? '[REDACTED]' : other;")).toEqual(['[REDACTED]']);
    expect(texts("set(out, path, 'REDACTED');")).toEqual(['REDACTED']);
    expect(texts("const o = { payload: '[REDACTED]' };")).toEqual(['[REDACTED]']);
    expect(texts("function f(placeholder: string = 'REDACTED') {}")).toEqual(['REDACTED']);
    expect(texts("type Placeholder = '[REDACTED]';")).toEqual(['[REDACTED]']);
    // the strings below are SOURCE CODE handed to the scanner, so the `${` in them is deliberate
    // eslint-disable-next-line no-template-curly-in-string
    expect(texts('const t = `[REDACTED]${rest}`;')).toEqual(['[REDACTED]']);
    // eslint-disable-next-line no-template-curly-in-string
    expect(texts('const t = `${head}REDACTED${tail}`;')).toEqual(['REDACTED']);
  });

  it('does not mistake a comment, an identifier or a sentence for a spelling', () => {
    expect(
      texts(
        "// 'REDACTED' in a line comment\n/* '[REDACTED]' in a block */\n/** the `'[REDACTED]'` doc */\nconst a = 1;",
      ),
    ).toEqual([]);
    expect(texts('const REDACTED = 1;\nexport { REDACTED };')).toEqual([]);
    expect(texts("const m = 'the value is REDACTED here';")).toEqual([]);
    expect(texts("const m = 'redacted';")).toEqual([]);
  });

  it('reports the line, so a stray is easy to find', () => {
    expect(spellings("const a = 1;\n\nconst b = '[REDACTED]';\n")).toEqual([{ text: '[REDACTED]', line: 3 }]);
  });
});

// ── scenario: the real tree ──────────────────────────────────────────────────

describe('the footprintjs source tree', () => {
  // `listSourceFiles` is the fence's own list: every `.ts` under src/, repo-relative and sorted.
  const files: string[] = layering.listSourceFiles(REPO);
  const spelled = new Map(files.map((file) => [file, spellings(readFileSync(join(REPO, file), 'utf8'))]));

  it('the scan covers the tree — the files that used to spell a placeholder are in it', () => {
    expect(files.length).toBeGreaterThan(150);
    for (const former of [
      'src/lib/decide/evaluator.ts',
      'src/lib/decide/evidence.ts',
      'src/lib/memory/utils.ts',
      'src/lib/memory/redaction.ts',
      'src/lib/scope/ScopeFacade.ts',
      'src/lib/runner/ExecutionRuntime.ts',
    ]) {
      expect(spelled.has(former), former).toBe(true);
    }
  });

  it('each owner spells its own placeholder exactly once — the log one at L0, the scope one beside the verdict at L4', () => {
    expect(spelled.get(OWNERS.REDACTED)?.map((s) => s.text)).toEqual(['REDACTED']);
    expect(spelled.get(OWNERS['[REDACTED]'])?.map((s) => s.text)).toEqual(['[REDACTED]']);
    expect(layering.rankOf(OWNERS.REDACTED)).toBe(0);
    expect(layering.rankOf(OWNERS['[REDACTED]'])).toBe(4);
  });

  it('no other src file spells either as a string literal — they import LOG_PLACEHOLDER / SCOPE_PLACEHOLDER', () => {
    const strays = [...spelled]
      .map(([file, found]) => [file, found.filter((s) => OWNERS[s.text] !== file)] as const)
      .filter(([, found]) => found.length > 0)
      .map(
        ([file, found]) =>
          `${file}:${found.map((s) => s.line).join(',')}  ${[...new Set(found.map((s) => s.text))].join(' ')}`,
      );
    expect(
      strays,
      "A placeholder is spelled as a literal outside its owner. Import LOG_PLACEHOLDER ('REDACTED', the commit log and the " +
        'mirror — a record byte) from src/lib/memory/placeholders.ts (L0, any layer may read it), or SCOPE_PLACEHOLDER ' +
        "('[REDACTED]', the scope channel) from src/lib/memory/redaction.ts (L4, the verdict's side).",
    ).toEqual([]);
  });
});
