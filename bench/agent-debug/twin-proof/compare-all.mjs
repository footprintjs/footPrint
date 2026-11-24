// Does the ordinary twin print what the flowchart program prints, byte for byte, for every order?
// Why: the rule of part 2 needs "the same result for every fixture, visible and hidden". This runs
// both command lines on each of the 18 hidden-set orders (the 13 visible ones are among them) and on
// each visible fixture FILE, and compares standard output, standard error emptiness and exit code.
// Usage: node compare-all.mjs <flowchart program folder> <twin folder> <hidden orders.json>
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [flow, twin, hiddenFile] = process.argv.slice(2);
const run = (root, file) => {
  const r = spawnSync(process.execPath, [join(root, 'src/run-order.mjs'), file], { encoding: 'utf8', cwd: root });
  return { out: r.stdout, err: r.stderr, code: r.status };
};
const scratch = mkdtempSync(join(tmpdir(), 'compare-'));
const cases = [];
for (const name of readdirSync(join(flow, 'fixtures')).filter((n) => n.endsWith('.json')).sort()) {
  cases.push({ name: `file:${name}`, flowFile: join(flow, 'fixtures', name), twinFile: join(twin, 'fixtures', name) });
}
const hidden = JSON.parse(readFileSync(hiddenFile, 'utf8'));
for (const [name, order] of Object.entries(hidden)) {
  const file = join(scratch, `${name}.json`);
  writeFileSync(file, JSON.stringify({ order }));
  cases.push({ name: `hidden-set:${name}`, flowFile: file, twinFile: file });
}
let same = 0;
for (const c of cases) {
  const a = run(flow, c.flowFile);
  const b = run(twin, c.twinFile);
  const equal = a.out === b.out && a.code === b.code && (a.err === '') === (b.err === '');
  if (equal) same += 1;
  else console.log(`DIFFERENT ${c.name}\n  flowchart: code ${a.code} ${JSON.stringify(a.out).slice(0, 400)}\n  twin:      code ${b.code} ${JSON.stringify(b.out).slice(0, 400)}`);
}
console.log(`${same} of ${cases.length} orders print the same bytes with the same exit code (node ${process.version}).`);
process.exit(same === cases.length ? 0 : 1);
