import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkRepository } from '../../scripts/doc-paths/check.mjs';
import { findProblems, formatProblem } from '../../scripts/doc-paths/paths.mjs';

const TREE = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'docs/guide.md',
  'docs/design/old.md',
  'src/lib/memory/README.md',
  'src/lib/memory/StageContext.ts',
  'docs-site/package.json',
  'docs-site/src/env.d.ts',
  'docs-site/checks/README.md',
  'ai-instructions/README.md',
];

/** The problems one doc's text yields in the small tree above. */
function problemsOf(file: string, text: string) {
  const tree = TREE.includes(file) ? TREE : [...TREE, file];
  return findProblems(tree, (doc: string) => (doc === file ? text : '')).map(formatProblem);
}

describe('doc paths', () => {
  it('accepts a tracked file', () => {
    expect(problemsOf('docs/guide.md', 'See `src/lib/memory/StageContext.ts`.')).toEqual([]);
  });

  it('reports a missing file with its doc, line and path', () => {
    expect(problemsOf('docs/guide.md', '# Guide\n\nSee `src/lib/memory/Gone.ts` for more.')).toEqual([
      'docs/guide.md:3: src/lib/memory/Gone.ts',
    ]);
  });

  it('drops a :line or :from-to suffix before checking', () => {
    expect(
      problemsOf('docs/guide.md', 'src/lib/memory/StageContext.ts:120 and src/lib/memory/StageContext.ts:1-9'),
    ).toEqual([]);
    expect(problemsOf('docs/guide.md', 'src/lib/memory/Gone.ts:12')).toEqual([
      'docs/guide.md:1: src/lib/memory/Gone.ts',
    ]);
  });

  it('does not check a glob or a placeholder', () => {
    expect(problemsOf('docs/guide.md', 'All of `src/nowhere/*.ts`, `src/{a,b}/x.ts`, `src/nowhere/...`.')).toEqual([]);
  });

  it('accepts a tracked folder, with or without a trailing slash, and a file without its extension', () => {
    expect(
      problemsOf('docs/guide.md', '`src/lib/memory/`, `src/lib/memory` and `src/lib/memory/StageContext`.'),
    ).toEqual([]);
    expect(problemsOf('docs/guide.md', '`src/lib/gone/`')).toEqual(['docs/guide.md:1: src/lib/gone']);
  });

  it("resolves a path from the doc's own package folder after the repo root", () => {
    expect(problemsOf('docs-site/checks/README.md', 'tsc src/env.d.ts')).toEqual([]);
    expect(problemsOf('docs/guide.md', 'tsc src/env.d.ts')).toEqual(['docs/guide.md:1: src/env.d.ts']);
  });

  it('does not read the changelog or the dated design notes', () => {
    expect(problemsOf('CHANGELOG.md', 'Moved `src/lib/gone.ts`.')).toEqual([]);
    expect(problemsOf('docs/design/old.md', 'Moved `src/lib/gone.ts`.')).toEqual([]);
  });

  it("allows an install destination in a user's project", () => {
    expect(problemsOf('ai-instructions/README.md', 'Copy it to `.claude/skills/footprint/SKILL.md`.')).toEqual([]);
  });

  it('does not check a path in a sentence about the foottrace package, and still checks the next sentence', () => {
    expect(
      problemsOf(
        'docs/guide.md',
        'Pinned in the `foottrace` package by\n`test/lib/fold.test.ts`. See `test/lib/gone.test.ts`.',
      ),
    ).toEqual(['docs/guide.md:2: test/lib/gone.test.ts']);
  });

  it('reads only Markdown and MDX docs', () => {
    expect(problemsOf('docs/notes.txt', 'src/lib/gone.ts')).toEqual([]);
    expect(problemsOf('docs/page.mdx', 'src/lib/gone.ts')).toEqual(['docs/page.mdx:1: src/lib/gone.ts']);
  });
});

describe('doc paths in this repository', () => {
  it('finds no missing path', () => {
    expect(checkRepository(resolve(__dirname, '../..')).map(formatProblem)).toEqual([]);
  });
});
