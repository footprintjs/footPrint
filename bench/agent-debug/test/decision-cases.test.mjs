/**
 * The cases the code review of part 2 found the tests did not notice
 * (decision-logic-6, rule-vs-code-3, tokens-and-retries-3 and -4), the
 * exact ties (decision-logic-1) and the new most-expensive-run row
 * (RULE-2.md, "The most-expensive-run row leaves out one run of B only").
 * Each builds the smallest batch that tells the right code from a changed one.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { interruptedRow } from '../harness/batch.mjs';
import { CLAIMS, GROUPS, HEADLINE_PERCENT, MAX_UNFINISHED, ROW_PERCENT, cheaperBy, claim, noDecisionReason } from '../harness/compare2.mjs';
import { MAYBE_PAID_REASONS } from '../harness/model.mjs';
import { RUN_CAP_TOKENS, boundTokensOf, readSide } from '../harness/readings.mjs';
import { decision2, renderReport2 } from '../harness/report2.mjs';
import { retriedFrom } from '../harness/retries.mjs';

const KINDS = ['program', 'run', 'why'];
const QUESTIONS = /** @type {any} */ (GROUPS.find((g) => g.id === 'questions'));
const [TIMEOUT] = MAYBE_PAID_REASONS;

/** 30 questions × `repeats` for set-ups 3 and P; `make(setup, q, repeat)` returns the row's fields. */
function batch(make, repeats = 5) {
  const rows = [];
  const plan = [];
  for (let q = 0; q < 30; q++) {
    for (let repeat = 1; repeat <= repeats; repeat++) {
      for (const setup of [3, 'P']) {
        plan.push({ setup, task: `q${q}`, repeat });
        rows.push({ setup, task: `q${q}`, taskType: 'question', kind: KINDS[q % 3], repeat, solved: true, stopReason: 'answered', inputTokens: 0, outputTokens: 0, newTokens: 0, resentTokens: 0, requests: 3, model: 'm', transcript: `t-${setup}-q${q}-${repeat}`, ...make(setup, q, repeat) });
      }
    }
  }
  return { rows, plan };
}
const decide = ({ rows, plan }) => decision2(rows, noDecisionReason(rows, { plan }), plan);

test('exact ties: "at least 25% fewer" and "at least 15% fewer" include equal, compared exactly', () => {
  // 36,333,598 / 147 is exactly 0.75 × 11,864,032 / 36, and 64,607,114 / 110 exactly 0.85 × 11,746,748 / 17;
  // in floating point both came out one unit too high (the code review's tie batch, decision-logic-1).
  assert.equal(36333598 / 147 <= (1 - 0.25) * (11864032 / 36), false, 'the float form gets the 25% tie wrong');
  assert.equal(64607114 / 110 <= (1 - 0.15) * (11746748 / 17), false, 'the float form gets the 15% tie wrong');
  assert.equal(cheaperBy({ tokens: 36333598, right: 147 }, { tokens: 11864032, right: 36 }, HEADLINE_PERCENT), true);
  assert.equal(cheaperBy({ tokens: 64607114, right: 110 }, { tokens: 11746748, right: 17 }, ROW_PERCENT), true);
  assert.equal(cheaperBy({ tokens: 36333599, right: 147 }, { tokens: 11864032, right: 36 }, HEADLINE_PERCENT), false, 'one token more is not');
  assert.equal(cheaperBy({ tokens: 10, right: 0 }, { tokens: 10, right: 1 }, ROW_PERCENT), false, 'no right answer is never cheaper');
  assert.equal(cheaperBy({ tokens: 10, right: 1 }, { tokens: 10, right: 0 }, ROW_PERCENT), true, 'against no right answer, some is');
  // The 25% tie in a whole batch: set-up 3's 150 runs carry 36,333,598 tokens, 147 right; set-up P's 11,864,032, 36 right.
  const spread = (total, i) => Math.floor(total / 150) + (i < total % 150 ? 1 : 0);
  let i3 = 0;
  let iP = 0;
  const tie = batch((setup, q, repeat) => {
    const i = setup === 3 ? i3++ : iP++;
    return setup === 3
      ? { inputTokens: spread(36333598, i), solved: i % 50 !== 0 }
      : { inputTokens: spread(11864032, i), solved: [...Array(36).keys()].some((k) => Math.floor((k * 150) / 36) === i) };
  });
  const head = claim(tie.rows, CLAIMS[0], QUESTIONS, tie.plan);
  assert.equal(head.a.tokens * 36 * 4, 3 * head.b.tokens * 147, 'an exact tie');
  assert.equal(head.head, true);
  assert.match(decide(tie), /^Go on/);
});

test('20 unfinished runs decide; 21 give "No decision"', () => {
  const at = (n) => batch((setup, q, repeat) => ({ inputTokens: setup === 3 ? 600 : 1000, ...(setup === 'P' && repeat === 1 && q < n ? { stopReason: 'error', solved: false } : {}) }));
  assert.equal(noDecisionReason(at(MAX_UNFINISHED).rows, { plan: at(MAX_UNFINISHED).plan }), undefined);
  assert.match(decide(at(MAX_UNFINISHED)), /^Go on/);
  assert.match(decide(at(MAX_UNFINISHED + 1)), /^No decision: more than 20 of the 300 runs ended as error or interrupted \(21\)/);
});

test('a duplicated planned row, and a batch without a plan, give "No decision"', () => {
  const b = batch((setup) => ({ inputTokens: setup === 3 ? 600 : 1000 }));
  assert.match(decide(b), /^Go on/);
  const twice = { rows: [...b.rows, { ...b.rows[0] }], plan: b.plan };
  assert.match(decide(twice), /^No decision: the rows are not exactly the planned runs: 1 planned runs appear more than once/);
  assert.match(renderReport2(b.rows, {}), /No decision: there is no plan \(order\.json\) to check the batch against\./);
});

test('a row with one task left out: 20% cheaper holds, 12% cheaper does not', () => {
  // Set-up 3 is cheap mostly on q0 (100 tokens against set-up P's 10,000). Without q0 it is 20% or 12% cheaper.
  const at = (others) => batch((setup, q) => ({ inputTokens: setup === 3 ? (q === 0 ? 100 : others) : q === 0 ? 10000 : 1000 }), 1);
  const twenty = at(800);
  const row = claim(twenty.rows, CLAIMS[0], QUESTIONS, twenty.plan).rows.find((r) => r.label === 'q0 left out');
  assert.equal(row?.holds, true);
  assert.match(decide(twenty), /^Go on/);
  const twelve = at(880);
  assert.equal(claim(twelve.rows, CLAIMS[0], QUESTIONS, twelve.plan).rows.find((r) => r.label === 'q0 left out')?.holds, false);
  assert.match(decide(twelve), /^Stop and look: .*it hangs on one task or one run \(.*q0 left out/);
});

test('the most-expensive-run row: set-up P\'s dearest FINISHED run costs nothing, its answer counts; set-up 3 is read as in the headline', () => {
  const b = batch((setup, q, repeat) => {
    if (setup === 3) return { inputTokens: q === 5 && repeat === 1 ? 9000 : 600, ...(q === 6 && repeat === 1 ? { stopReason: 'interrupted', solved: false, inputTokens: 50000 } : {}) };
    if (q === 0 && repeat === 1) return { inputTokens: 7000, solved: false }; // set-up P's dearest finished run, wrong
    if (q === 1 && repeat === 1) return { inputTokens: 90000, stopReason: 'error', solved: false }; // dearer, but unfinished
    return { inputTokens: 1000 };
  });
  const c = claim(b.rows, CLAIMS[0], QUESTIONS, b.plan);
  const row = c.rows.at(-1);
  assert.equal(row.label, "set-up P's most expensive finished run counted as costing nothing");
  assert.deepEqual([row.a.tokens, row.a.right, row.a.planned], [c.a.tokens, c.a.right, c.a.planned], 'no run of set-up 3 is left out, its dearest (unfinished) one included');
  assert.equal(row.b.tokens, c.b.tokens - 7000, 'the dearest finished run, not the dearer unfinished one');
  assert.equal(row.b.right, c.b.right, 'its answer still counts');
  assert.equal(row.b.perRight, (148 * 1000) / 148, "148 finished runs at 1,000 over 148 right answers");
  // In the second reading set-up P is at its best case AND its dearest finished run costs nothing.
  const s = claim(b.rows, CLAIMS[0], QUESTIONS, b.plan, { bound: true }).rows.at(-1);
  assert.deepEqual([s.b.right, s.b.tokens], [149, 148 * 1000]);
  // The row asks only the 15%: set-up 3 right less often in it does not fail it.
  const less = batch((setup, q, repeat) => ({ inputTokens: setup === 3 ? 600 : 1000, solved: !(setup === 3 && repeat === 1 && q === 0) }));
  const lessRow = claim(less.rows, CLAIMS[0], QUESTIONS, less.plan).rows.at(-1);
  assert.equal(lessRow.holds, true);
});

test('the second reading fails only in its most-expensive-run row: "No decision"', () => {
  // Set-up 3: 150 right at 600. Set-up P: q0 has its dearest finished run (30,000, right) and four error runs;
  // fourteen more error runs (repeat 2 of q1 to q14); every other run finished and right at 795.
  // First reading: holds everywhere. Second (P's 18 unfinished counted right at no cost): the headline and every
  // task row hold, the most-expensive-run row is 590 against 600 per correct answer: it fails.
  const b = batch((setup, q, repeat) => {
    if (setup === 3) return { inputTokens: 600 };
    if (q === 0) return repeat === 1 ? { inputTokens: 30000 } : { stopReason: 'error', solved: false, inputTokens: 5000 };
    if (repeat === 2 && q <= 14) return { stopReason: 'error', solved: false, inputTokens: 5000 };
    return { inputTokens: 795 };
  });
  const first = claim(b.rows, CLAIMS[0], QUESTIONS, b.plan);
  const second = claim(b.rows, CLAIMS[0], QUESTIONS, b.plan, { bound: true });
  assert.equal(first.holds, true, JSON.stringify(first.rows.filter((r) => !r.holds).map((r) => r.label)));
  assert.equal(second.head, true);
  assert.deepEqual(second.rows.filter((r) => !r.holds).map((r) => r.label), ["set-up P's most expensive finished run counted as costing nothing"]);
  const sentence = decide(b);
  assert.match(sentence, /^No decision: claim A on the questions holds in the first reading and fails in the second.*a row fails \(set-up P's most expensive finished run counted as costing nothing\)/, sentence);
});

test('readSide: an unfinished run marked solved is never right; B\'s best-case share is over its planned runs', () => {
  const rows = [
    { stopReason: 'error', solved: true, inputTokens: 10, outputTokens: 0 },
    { stopReason: 'answered', solved: true, inputTokens: 10, outputTokens: 0 },
    { stopReason: 'answered', solved: false, inputTokens: 10, outputTokens: 0 },
  ];
  assert.deepEqual([readSide(rows, 'worst').right, readSide(rows, 'worst').rateDen], [1, 3]);
  assert.deepEqual([readSide(rows, 'finished').right, readSide(rows, 'finished').rateDen], [1, 2]);
  const best = readSide(rows, 'best', 4);
  assert.deepEqual([best.right, best.rateNum, best.rateDen, best.tokens], [2, 2, 4, 20]);
});

test('retried attempts: each answered input from its own request; a retried token count is never paid', () => {
  assert.deepEqual(retriedFrom([
    { type: 'request', n: 1 }, { type: 'retry', call: 'message', reason: TIMEOUT }, { type: 'response', usage: { input_tokens: 1000, output_tokens: 1 } },
    { type: 'request', n: 2 }, { type: 'retry', call: 'message', reason: TIMEOUT }, { type: 'response', usage: { input_tokens: 1400, output_tokens: 1 } },
  ]).map((r) => [r.request, r.answeredInput]), [[1, 1000], [2, 1400]]);
  for (const reason of MAYBE_PAID_REASONS) {
    assert.equal(retriedFrom([{ type: 'retry', call: 'count', reason }])[0].mayHaveBeenPaid, false, reason);
  }
});

test('interruptedRow: no transcript is the most a run can spend; a possibly-paid retry beside a cut last line is kept', () => {
  const out = mkdtempSync(join(tmpdir(), 'agent-debug-cases-'));
  try {
    mkdirSync(join(out, 'transcripts'));
    const started = { setup: 3, task: 'run-weight', taskType: 'question', repeat: 1, model: 'm', transcript: 'transcripts/none.jsonl' };
    const lost = interruptedRow(out, started, undefined);
    assert.equal(lost.tokensKnown, false);
    assert.equal(boundTokensOf(lost), RUN_CAP_TOKENS);
    const lines = [
      { type: 'request', n: 1 }, { type: 'retry', call: 'message', reason: TIMEOUT }, { type: 'response', usage: { input_tokens: 700, output_tokens: 5 } },
      { type: 'request', n: 2 },
    ].map((e) => JSON.stringify(e)).join('\n');
    writeFileSync(join(out, 'transcripts', 'cut.jsonl'), `${lines}\n{"type":"respo`);
    const cut = interruptedRow(out, { ...started, transcript: 'transcripts/cut.jsonl' }, undefined);
    assert.deepEqual([cut.retried.length, cut.retried[0].answeredInput, cut.requestsWithoutUsage, cut.inputTokens, cut.tokensKnown], [1, 700, 1, 700, true]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
