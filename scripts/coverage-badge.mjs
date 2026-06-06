/**
 * Regenerate the README coverage badge from coverage/coverage-summary.json.
 *
 *   npm run coverage:badge   # after `npm run test:coverage`
 *
 * Reads the line-coverage %, picks a color, and rewrites the badge between the
 * `<!-- coverage-badge -->` / `<!-- /coverage-badge -->` markers in README.md.
 * Self-contained — no codecov account or CI upload required.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const summary = new URL('../coverage/coverage-summary.json', import.meta.url);
if (!existsSync(summary)) {
  console.error('coverage/coverage-summary.json not found — run `npm run test:coverage` first.');
  process.exit(1);
}
const pct = Math.round(JSON.parse(readFileSync(summary, 'utf8')).total.lines.pct);
const color =
  pct >= 90 ? 'brightgreen' : pct >= 80 ? 'green' : pct >= 70 ? 'yellowgreen'
  : pct >= 60 ? 'yellow' : pct >= 50 ? 'orange' : 'red';
const badge = `<img src="https://img.shields.io/badge/coverage-${pct}%25-${color}.svg" alt="coverage: ${pct}%">`;

const readme = new URL('../README.md', import.meta.url);
let text = readFileSync(readme, 'utf8');
const re = /<!-- coverage-badge -->[\s\S]*?<!-- \/coverage-badge -->/;
if (!re.test(text)) {
  console.error('README.md is missing the <!-- coverage-badge --><!-- /coverage-badge --> markers.');
  process.exit(1);
}
text = text.replace(re, `<!-- coverage-badge -->${badge}<!-- /coverage-badge -->`);
writeFileSync(readme, text);
console.log(`coverage badge updated: ${pct}% (${color})`);
