import { lstatSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import MarkdownIt from 'markdown-it';
import ts from 'typescript';

export const DOCUMENT_ROOTS = [
  'README.md',
  'CLAUDE.md',
  'AGENTS.md',
  'docs',
  'docs-site/src/content',
  'examples',
  'src',
  'ai-instructions',
];
// These directories describe historical/proposed APIs, not today's public contract.
const HISTORICAL = new Set(['proposals', 'design', 'internals']);
const GENERATED = new Set(['node_modules', 'dist', 'public']);
const LANGUAGES = new Set(['ts', 'typescript', 'tsx']);
const isFootprint = (name) => name === 'footprintjs' || name.startsWith('footprintjs/');
const markdown = new MarkdownIt('commonmark');
// MDX JSX containers (for example TabItem) must not swallow their Markdown
// children as raw HTML. This remains a fence checker, not an MDX/JSX validator:
// expressions, attributes and imported components are outside its scope.
const mdxMarkdown = new MarkdownIt('commonmark', { html: false });

export function discoverDocuments(root, roots = DOCUMENT_ROOTS) {
  const files = new Set();
  const errors = [];
  function visit(file) {
    const stat = lstatSync(join(root, file));
    if (stat.isSymbolicLink()) throw new Error(`Document path is a symbolic link: ${file}`);
    if (stat.isFile()) {
      if (/\.(md|mdx)$/.test(file) || (file.startsWith('ai-instructions/') && !extname(file))) files.add(file);
      return;
    }
    for (const name of readdirSync(join(root, file)).sort()) {
      if (name.startsWith('.') || HISTORICAL.has(name) || GENERATED.has(name)) continue;
      visit(join(file, name));
    }
  }
  for (const file of roots) {
    try {
      visit(file);
    } catch (error) {
      errors.push({ file, code: 'DOC_DISCOVERY', message: error.message });
    }
  }
  return { files: [...files].sort(), errors };
}

function inspectSource(source, language) {
  const imported = ts.preProcessFile(source, true, true).importedFiles.some((item) => isFootprint(item.fileName));
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
  const suppressions = [];
  let moduleLiteral = false;
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.StringLiteral && isFootprint(scanner.getTokenValue())) moduleLiteral = true;
    if (
      (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) &&
      /@ts-(?:ignore|expect-error|nocheck)\b/.test(scanner.getTokenText())
    )
      suppressions.push(scanner.getTokenPos());
  }
  // Malformed imports can vanish from preProcessFile. Keep syntax-invalid code
  // with an actual module string in scope, not comments or quoted sample text.
  const parsed = ts.createSourceFile(
    'snippet',
    source,
    ts.ScriptTarget.Latest,
    false,
    language === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  return { selected: imported || (moduleLiteral && parsed.parseDiagnostics.length > 0), suppressions, parsed };
}

// Markdown owns all fence/container recognition. Its code content only removes
// a line prefix (or partly expands a prefix tab); the remaining suffix is exact.
// Record UTF-16 columns, matching TypeScript, rather than visual tab widths.
function mapSourceLine(original, content, line) {
  const normalized = original.replace(/\0/g, '\uFFFD');
  let suffix = 0;
  while (
    suffix < normalized.length &&
    suffix < content.length &&
    normalized[normalized.length - suffix - 1] === content[content.length - suffix - 1]
  )
    suffix++;
  const removed = normalized.length - suffix;
  const padding = content.length - suffix;
  if (!padding) return { line, column: removed + 1 };
  if (!/^ +$/.test(content.slice(0, padding)) || normalized[removed - 1] !== '\t') {
    throw new Error(`Cannot map Markdown code content to original line ${line}.`);
  }
  return {
    line,
    column: removed,
    columns: Array.from({ length: content.length + 1 }, (_, index) =>
      index < padding ? removed : removed + 1 + index - padding,
    ),
  };
}

export function extractSnippets(text, file) {
  const lines = text.split(/\r\n?|\n/);
  const units = [];
  const errors = [];
  let total = 0;
  const parser = extname(file) === '.mdx' ? mdxMarkdown : markdown;
  for (const token of parser.parse(text, {})) {
    if (token.type !== 'fence') continue;
    const language = token.info.trim().split(/\s+/)[0].toLowerCase();
    if (!LANGUAGES.has(language)) continue;
    total++;
    const source = token.content.endsWith('\n') ? token.content.slice(0, -1) : token.content;
    const inspection = inspectSource(source, language);
    if (!inspection.selected) continue;
    const start = token.map[0];
    const line = start + 2;
    const contentLines = source.split('\n');
    const lineMap = contentLines.map((content, index) =>
      mapSourceLine(lines[start + 1 + index], content, line + index),
    );
    units.push({ file, index: total, line, language, source, lineMap });
    // A closed token spans its opener, content lines and closer. CommonMark
    // also auto-closes at EOF/container end; those lack the final source line.
    const contentCount = token.content ? contentLines.length : 0;
    if (token.map[1] - start !== contentCount + 2) {
      errors.push({
        file,
        line: start + 1,
        column: lines[start].indexOf(token.markup) + 1,
        code: 'DOC_FENCE',
        message: 'Unclosed TypeScript fence.',
      });
    }
    for (const position of inspection.suppressions) {
      const at = inspection.parsed.getLineAndCharacterOfPosition(position);
      const mapped = lineMap[at.line];
      errors.push({
        file,
        line: mapped.line,
        column: mapped.columns?.[at.character] ?? mapped.column + at.character,
        code: 'DOC_SUPPRESSION',
        message: 'TypeScript suppression directives are not allowed in checked examples.',
      });
    }
  }
  return { units, errors, total };
}
