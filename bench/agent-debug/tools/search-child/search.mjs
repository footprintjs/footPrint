/**
 * The search itself, run in a confined child process (read access to the
 * working copy and this file only) so that a pattern that takes forever
 * (catastrophic backtracking) is stopped by the child's time limit instead
 * of hanging the harness. Self-contained: it imports nothing of the harness.
 * Usage: `node search.mjs <workdir> <pattern>`; prints JSON
 * `{ matches: [{ file, line, text }], total }` or `{ error }`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_MATCHES = 200;

/** Regular files under `dir` (links are skipped), sorted, relative. */
function filesUnder(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return filesUnder(join(dir, entry.name), rel);
      return entry.isFile() ? [rel] : [];
    });
}

const [workdir, pattern] = process.argv.slice(2);
let regex;
try {
  regex = new RegExp(pattern);
} catch (error) {
  console.log(JSON.stringify({ error: `not a valid regular expression: ${error instanceof Error ? error.message : error}` }));
  process.exit(0);
}
const matches = [];
let total = 0;
for (const file of filesUnder(workdir)) {
  readFileSync(join(workdir, file), 'utf8')
    .split('\n')
    .forEach((text, i) => {
      if (!regex.test(text)) return;
      total++;
      if (matches.length < MAX_MATCHES) matches.push({ file, line: i + 1, text: text.length > 200 ? `${text.slice(0, 199)}…` : text });
    });
}
console.log(JSON.stringify({ matches, total }));
