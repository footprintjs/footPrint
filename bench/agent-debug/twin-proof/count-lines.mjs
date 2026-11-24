/**
 * The numbers the fairness reader compares (RULE-2.md: "commented about as
 * much as F: the count of comment lines per code line is reported for both"),
 * counted by ONE set of rules for both programs.
 *
 * The rules, per `.mjs` file under a program's `src/`:
 * - a line is BLANK when it holds only white space;
 * - a line is a COMMENT line when, trimmed, it is inside a block comment,
 *   opens one (`/*`), or starts with `//`; a line holding code and a comment
 *   after it is a CODE line;
 * - every other line is a CODE line (a shebang line counts as code).
 * It reads no string literal, so a `/*` inside a string would be miscounted;
 * neither program has one (the test beside this file checks the totals add up).
 * Also: each README's size (bytes, lines, words) and the number of
 * `test(` calls at the start of a line in each `test/visible.test.mjs`.
 * Run: `node twin-proof/count-lines.mjs` (prints a Markdown table).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ROOTS = Object.freeze({ F: join(BENCH, 'program'), P: join(BENCH, 'twin') });

/** Counts one file's lines. @param {string} text */
export function countText(text) {
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  let blank = 0;
  let comment = 0;
  let code = 0;
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (inBlock) {
      comment++;
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line === '') blank++;
    else if (line.startsWith('//')) comment++;
    else if (line.startsWith('/*')) {
      comment++;
      inBlock = !line.includes('*/', 2);
    } else code++;
  }
  return { lines: lines.length, blank, comment, code };
}

/** Every `.mjs` file under `dir`, sorted. */
function mjsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
    .map((e) => join(e.parentPath ?? e.path, e.name))
    .sort();
}

/** The counts of one program. @param {string} root */
export function countProgram(root) {
  const files = mjsFiles(join(root, 'src'));
  const total = { files: files.length, lines: 0, blank: 0, comment: 0, code: 0 };
  for (const file of files) {
    const c = countText(readFileSync(file, 'utf8'));
    total.lines += c.lines;
    total.blank += c.blank;
    total.comment += c.comment;
    total.code += c.code;
  }
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const visible = readFileSync(join(root, 'test', 'visible.test.mjs'), 'utf8');
  return {
    ...total,
    commentPerCode: Math.round((total.comment / total.code) * 100) / 100,
    readmeBytes: Buffer.byteLength(readme),
    readmeLines: countText(readme).lines,
    readmeWords: readme.split(/\s+/).filter(Boolean).length,
    visibleTests: [...visible.matchAll(/^test\(/gm)].length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const f = countProgram(ROOTS.F);
  const p = countProgram(ROOTS.P);
  const rows = [
    ['files under src/', 'files'], ['lines', 'lines'], ['blank lines', 'blank'], ['code lines', 'code'], ['comment lines', 'comment'],
    ['comment lines per code line', 'commentPerCode'], ['README bytes', 'readmeBytes'], ['README lines', 'readmeLines'], ['README words', 'readmeWords'],
    ['visible tests', 'visibleTests'],
  ];
  console.log('| | F (program/) | P (twin/) |\n|---|---|---|');
  for (const [label, key] of rows) console.log(`| ${label} | ${f[key]} | ${p[key]} |`);
}
