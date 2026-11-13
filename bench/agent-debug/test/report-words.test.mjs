/**
 * The report's own words about its numbers (the code review of part 2,
 * decision-logic-2, rule-vs-code-1/5/6/8/9, tokens-and-retries-7): the
 * first lines, the list of unfinished runs, the notes and the margins say
 * what readings.mjs and compare2.mjs do, per side, with numbers from the
 * constants and the plan. A batch with unfinished runs on BOTH sides shows
 * each sentence against the cells it describes.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { HEADLINE_PERCENT, ROW_PERCENT } from '../harness/compare2.mjs';
import { MAYBE_PAID_REASONS } from '../harness/model.mjs';
import { UNFINISHED_PER_SIDE, renderReport2, unknownTokensLine } from '../harness/report2.mjs';
import { BENCH_DIR } from '../harness/runtime.mjs';

const KINDS = ['program', 'run', 'why'];

function batch() {
  const rows = [];
  for (let q = 0; q < 30; q++) {
    for (let repeat = 1; repeat <= 2; repeat++) {
      for (const setup of [3, 'P']) {
        rows.push({ setup, task: `q${q}`, taskType: 'question', kind: KINDS[q % 3], repeat, solved: true, stopReason: 'answered', inputTokens: setup === 3 ? 600 : 1000, outputTokens: 0, newTokens: 0, resentTokens: 0, requests: 3, requestsWithoutUsage: 0, retried: [], model: 'm', transcript: `t-${setup}-q${q}-${repeat}` });
      }
    }
  }
  const at = (setup, q, repeat) => /** @type {any} */ (rows.find((r) => r.setup === setup && r.task === `q${q}` && r.repeat === repeat));
  Object.assign(at(3, 0, 1), { stopReason: 'interrupted', solved: false, inputTokens: 0, tokensKnown: false });
  Object.assign(at(3, 1, 1), { stopReason: 'error', solved: false, inputTokens: 300, requestsWithoutUsage: 1 });
  Object.assign(at(3, 2, 1), { stopReason: 'interrupted', solved: false, inputTokens: 400, retried: [{ reason: MAYBE_PAID_REASONS[0], call: 'message', request: 1, mayHaveBeenPaid: true, answeredInput: 400 }] });
  Object.assign(at('P', 3, 1), { stopReason: 'error', solved: false, inputTokens: 8000 });
  return { rows, plan: rows.map(({ setup, task, repeat }) => ({ setup, task, repeat })) };
}

test('the first line and the list of unfinished runs say how an unfinished run counts, per side', () => {
  const { rows, plan } = batch();
  const report = renderReport2(rows, { plan });
  const [, , first] = report.split('\n');
  assert.ok(first.includes(`4 unfinished: ${UNFINISHED_PER_SIDE}`), first);
  assert.match(UNFINISHED_PER_SIDE, /on the side a claim favours never right, its recorded tokens counted; on the other side left out of its share and its tokens in the first reading, counted as a right answer that cost nothing in the second/);
  assert.ok(report.includes(`Runs the harness could not finish (${UNFINISHED_PER_SIDE}): `));
  assert.ok(!/never right, their recorded tokens counted\)/.test(report), 'the old one-sided wording is gone');
  // The cells say the same: set-up P's error run is left out of its first reading and counted right in its second.
  assert.match(report, /\| the 30 questions \| 57 of 60 planned \(57 finished\) \| [\d,]+ \(3 unfinished: 700 tokens, 1 unknown, 1 a lower bound\) \| [\d,]+ \/ 0 \| 59 of 59 finished \(60 planned\) \| 1,000 \(finished only: 1 unfinished left out\) \|/);
  assert.match(report, /\| the 30 questions, second reading .*\| 60 of 60 planned \(59 finished; 1 unfinished counted right\) \|/);
});

test('the unknown-tokens line gives three counts and the section by its real name, and says how each side counts', () => {
  const { rows } = batch();
  const unfinished = rows.filter((r) => r.stopReason !== 'answered');
  const line = unknownTokensLine(unfinished);
  assert.match(line, /cannot be known at all \(no transcript\): 1\. .*a lower bound .*: 1\. Unfinished runs with a retried attempt that may have been paid: 1\./);
  assert.match(line, /\(RULE-2\.md, "Changed after the fairness readings"\)\.$/);
  assert.match(line, /on the other side, an unfinished run is left out of the first reading and counted as a right answer that cost nothing in the second/);
  assert.ok(!line.includes('Every other token of an unfinished run is counted'));
  const rule = readFileSync(join(BENCH_DIR, 'RULE-2.md'), 'utf8');
  assert.ok(rule.includes('## Changed after the fairness readings'), 'the section the report cites exists by that name');
});

test('the header says which block is copied, not computed; the notes say what the spend leaves out and where the other counts are', () => {
  const { rows, plan } = batch();
  const report = renderReport2(rows, { plan });
  assert.match(report, /No number here is typed by hand, except the block "Known before the run", which is copied from the fairness readings \(twin-proof\/known-before\.json\)\./);
  assert.match(report, /Seven of the twenty questions about a run and why it ended/);
  assert.match(report, /- The spend is a lower bound: it adds up the usage of answered requests only\. A request never answered \(the last request of a run that ended in an error, a request in flight when the harness stopped\), a retried attempt that may have been paid, and a run with no transcript add nothing to it\./);
  assert.match(report, /- Requests, input and output tokens apart, tool calls by name and the context at the end are kept in every row of runs\.jsonl/);
  assert.ok(!report.includes('Changed after the fairness reading"'), 'no stale section name');
});

test('margins and group sizes come from the constants and the plan', () => {
  const { rows, plan } = batch();
  const report = renderReport2(rows, { plan });
  assert.ok(report.includes(`at least ${HEADLINE_PERCENT}% fewer tokens per correct answer in the headline, at least ${ROW_PERCENT}% in every row, equal included`));
  assert.ok(report.includes(`asks only whether set-up 3 is still at least ${ROW_PERCENT}% cheaper`));
  // Ten questions only: the labels say ten, not thirty.
  const ten = rows.filter((r) => Number(r.task.slice(1)) < 10);
  const small = renderReport2(ten, { plan: ten.map(({ setup, task, repeat }) => ({ setup, task, repeat })) });
  assert.match(small, /\| the 10 questions \|/);
  assert.ok(!small.includes('the 30 questions'));
  assert.match(report, new RegExp(`may have been paid \\(${MAYBE_PAID_REASONS.map((r) => r.replace(/[()]/g, '\\$&')).join(', ')}, on a model request\\)`));
  assert.match(report, /a refused attempt \(429, 529, or a 5xx other than 504\) is taken as not billed/);
});
