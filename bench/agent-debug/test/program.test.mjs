/**
 * The program's text (RULE.md 1.3, change 6, and the reader's F5): no
 * comment example in the program uses a number that is an expected result of
 * a fixture, so no comment hands over an answer by coincidence.
 *
 * What counts as a number here: a number written on its own (not part of a
 * name such as `NOTE-A5` or `BULK50`) that has a decimal point or is 10 or
 * more. Smaller whole numbers (0, 1, a count of lines, a rule's own constant
 * such as 5%) are the words of a rule, not results, and appear in every
 * explanation of it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { BENCH_DIR } from '../harness/runtime.mjs';
import { listFiles, PROGRAM_DIR } from '../harness/workdir.mjs';

/** Every number in the expected results of every hidden fixture. */
function expectedNumbers() {
  const values = new Set();
  const walk = (v) => {
    if (typeof v === 'number') values.add(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(JSON.parse(readFileSync(join(BENCH_DIR, 'hidden', 'expected.json'), 'utf8')));
  return values;
}

/** The comment lines of a source file. */
function commentLines(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('*') || l.startsWith('/*') || l.startsWith('//'));
}

test('no comment example in the program is an expected result of a fixture', () => {
  const expected = expectedNumbers();
  const hits = [];
  for (const rel of listFiles(PROGRAM_DIR).filter((f) => f.endsWith('.mjs'))) {
    for (const line of commentLines(readFileSync(join(PROGRAM_DIR, rel), 'utf8'))) {
      for (const match of line.matchAll(/(?<![\w.-])\d+(?:\.\d+)?(?![\w-])/g)) {
        const n = Number(match[0]);
        if ((match[0].includes('.') || n >= 10) && expected.has(n)) hits.push(`${rel}: ${n} in "${line}"`);
      }
    }
  }
  assert.deepEqual(hits, []);
});

test('the check sees a planted coincidence', () => {
  const expected = expectedNumbers();
  assert.ok(expected.has(37.96), 'cafe-notebooks\' line total is an expected value');
  const line = commentLines(' * Example: 12 × NOTE-A5 at 3.33 → `lineTotal = 37.96`.')[0];
  const found = [...line.matchAll(/(?<![\w.-])\d+(?:\.\d+)?(?![\w-])/g)].map((m) => Number(m[0])).filter((n) => expected.has(n));
  assert.deepEqual(found, [37.96]);
});
