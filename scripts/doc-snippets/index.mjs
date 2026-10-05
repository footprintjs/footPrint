import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverDocuments, extractSnippets } from './discover.mjs';
import { checkSnippets } from './compile.mjs';

export { discoverDocuments, extractSnippets, checkSnippets };

export function analyze(root) {
  const discovered = discoverDocuments(root);
  const diagnostics = [...discovered.errors];
  const units = [];
  let total = 0;
  for (const file of discovered.files) {
    const extracted = extractSnippets(readFileSync(join(root, file), 'utf8'), file);
    units.push(...extracted.units);
    diagnostics.push(...extracted.errors);
    total += extracted.total;
  }
  if (!units.length)
    diagnostics.push({ file: '<documents>', code: 'DOC_EMPTY', message: 'No FootPrint-importing snippets found.' });
  else diagnostics.push(...checkSnippets(root, units));
  return {
    documents: discovered.files.length,
    files: new Set(units.map((unit) => unit.file)).size,
    checked: units.length,
    total,
    diagnostics,
  };
}

export function format(result) {
  const summary =
    `${result.checked} FootPrint-importing snippets in ${result.files} documents checked with strict TypeScript; ` +
    `${result.total - result.checked} other TypeScript fences are outside this import-based check.`;
  const errors = result.diagnostics.map((item) => {
    const position = item.line === undefined ? '' : `:${item.line}:${item.column ?? 1}`;
    const code = typeof item.code === 'number' ? `TS${item.code}` : item.code;
    return `${item.file}${position} ${code}: ${item.message}`;
  });
  return [
    `check-doc-snippets: ${errors.length ? `FAIL (${errors.length} diagnostics)` : 'PASS'} — ${summary}`,
    ...errors,
  ].join('\n');
}
