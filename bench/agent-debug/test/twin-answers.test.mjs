/**
 * The thirty expected answers, proved against the twin (RULE-2.md: the
 * script that computes them from F "proves each of them against P by running
 * P with prints"). The same answer functions run on the twin's view
 * (questions/observe-twin.mjs): its figures, and a few prints added to a
 * temporary COPY of its src/. All thirty must equal hidden/answers.json,
 * which was computed from F. The prints must change nothing the twin prints.
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { PROGRAMS } from '../harness/programs.mjs';
import { hiddenOrders } from '../harness/score.mjs';
import { expectedAnswers } from '../harness/score-question.mjs';
import { RESULT_OF, printed } from '../harness/scoring-child/result-of.mjs';
import { computeAnswers } from '../questions/generate.mjs';
import { loadQuestions } from '../questions/index.mjs';
import { makeTwinContext, printingCopy, PRINTS } from '../questions/observe-twin.mjs';

test('all thirty answers, derived from the twin, equal the answers computed from the flowchart program', async () => {
  const ctx = await makeTwinContext();
  try {
    const fromTwin = await computeAnswers(ctx);
    const expected = expectedAnswers();
    assert.equal(Object.keys(expected).length, 30);
    for (const id of Object.keys(expected)) assert.deepEqual(fromTwin[id], expected[id], id);
    assert.deepEqual(Object.keys(fromTwin).sort(), Object.keys(expected).sort());
  } finally {
    ctx.close();
  }
});

test('the prints added to the copy change nothing it prints, on every hidden order', async () => {
  const copy = printingCopy();
  const log = console.log;
  console.log = () => {};
  try {
    const printing = await import(pathToFileURL(join(copy, 'src', 'order-desk.mjs')).href);
    const plain = await import(pathToFileURL(join(PROGRAMS.P.dir, 'src', 'order-desk.mjs')).href);
    for (const [name, order] of Object.entries(hiddenOrders())) {
      assert.equal(printed(await RESULT_OF.P(printing, structuredClone(order))), printed(await RESULT_OF.P(plain, structuredClone(order))), name);
    }
  } finally {
    console.log = log;
    rmSync(copy, { recursive: true, force: true });
  }
  assert.equal(PRINTS.length, 4);
  for (const p of PRINTS) assert.equal(p.replace.match(/console\.log\(/g)?.length, 1, `${p.file}: one print, and nothing else`);
});

test('where the way to establish an answer with prints differs in the twin, the twin\'s way is written down', () => {
  for (const q of loadQuestions()) {
    // In F the order is read in src/run-order.mjs; in the twin src/run-order.mjs hands the file to src/cli.mjs, which reads it.
    if (/run script/.test(q.howWithPrints)) {
      assert.ok(typeof q.howWithPrintsTwin === 'string' && q.howWithPrintsTwin.includes('src/cli.mjs'), q.id);
      assert.ok(!/run script/.test(q.howWithPrintsTwin), q.id);
    } else {
      assert.equal(q.howWithPrintsTwin, undefined, `${q.id}: the same way in both programs`);
    }
  }
});
