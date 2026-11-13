/**
 * The cases the code review of part 2 found the tests did not notice
 * (decision-logic-6, rule-vs-code-3, tokens-and-retries-3 and -4), the
 * exact ties (decision-logic-1) and the new most-expensive-run row
 * (RULE-2.md, "The most-expensive-run row leaves out one run of B only"),
 * the second check's cases: a missing transcript (oracle-1: the first
 * reading counts the run at its cap), set-up P's dearest finished run that is
 * a RIGHT answer (words-1); and the fifth fairness reading's: a lost
 * transcript withholds the decision for set-up 3 only, and a withheld
 * decision prints what the rows give without the guard.
 * Each builds the smallest batch that tells the right code from a changed one.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SPEND_STOP_FILE, interruptedRow, readRuns, runBatch } from '../harness/batch.mjs';
import { loadFaults } from '../faults/apply.mjs';
import { CLAIMS, GROUPS, HEADLINE_PERCENT, MAX_UNFINISHED, ROW_PERCENT, cheaperBy, claim, fillMissing, noDecisionReason, withholding } from '../harness/compare2.mjs';
import { MAYBE_PAID_REASONS } from '../harness/model.mjs';
import { RUN_CAP_TOKENS, boundTokensOf, readSide } from '../harness/readings.mjs';
import { NOT_THE_PLAN_SENTENCE, ONE_MISSING_RUN_WORDS, ROW_LOST_WORDS, UNKNOWN_TASK_SENTENCE, WORST_CASE_WORDS, decision2, renderReport2, rowsDecision, spendStopLine, writeReport2 } from '../harness/report2.mjs';
import { loadQuestions } from '../questions/index.mjs';
import { retriedFrom } from '../harness/retries.mjs';
import { unfinishedRow } from '../harness/rows.mjs';

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
  assert.equal(decide(at(MAX_UNFINISHED + 1)), 'No decision: more than 20 of the 300 runs ended as error or interrupted (21), counted over all set-ups: set-up P 21, set-up 3 0.');
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

test('the most-expensive-run row: set-up P\'s dearest finished run is a RIGHT answer, and the row\'s verdict hangs on that one answer (words-1)', () => {
  // The second check's batch 3. Set-up 3: every run 1,000 tokens, each task's repeat 5 wrong (120 right).
  // Set-up P: 1,180 tokens a run, q7 repeat 1 at 100,000 and right, each task's repeat 5 wrong (120 right).
  // With that run free and its answer kept, set-up P is 175,820 / 120 per right answer, and set-up 3's 1,250 is not
  // 15% under it. Taking its answer away too (175,820 / 119) would make the row hold and the decision "Go on".
  const b = batch((setup, q, repeat) => ({ solved: repeat !== 5, inputTokens: setup === 3 ? 1000 : q === 7 && repeat === 1 ? 100000 : 1180 }));
  const c = claim(b.rows, CLAIMS[0], QUESTIONS, b.plan);
  const row = c.rows.at(-1);
  assert.equal(row.label, "set-up P's most expensive finished run counted as costing nothing");
  assert.equal(row.b.right, c.b.right, 'its answer still counts');
  assert.equal(row.b.right, 120);
  assert.equal(row.b.tokens, 149 * 1180);
  assert.equal(row.holds, false);
  assert.deepEqual(c.rows.filter((r) => !r.holds).map((r) => r.label), [row.label], 'every other row holds: the verdict is this row\'s');
  assert.match(decide(b), /^Stop and look: .*it hangs on one task or one run \(set-up P's most expensive finished run counted as costing nothing\)/);
});

const lose = (rows, setup, q, repeat) => rows.map((r) => (r.setup === setup && r.task === `q${q}` && r.repeat === repeat
  ? unfinishedRow({ setup, task: r.task, taskType: 'question', repeat, model: r.model, transcript: r.transcript }, { type: 'question', kind: r.kind }, null)
  : r));
/** A batch with set-ups 1 and 2 beside 3 and P: claim A reads neither. */
const withOthers = (b) => {
  const more = [1, 2].flatMap((setup) => b.rows.filter((r) => r.setup === 'P').map((r) => ({ ...r, setup, transcript: r.transcript.replace('t-P', `t-${setup}`) })));
  const rows = [...b.rows, ...more];
  return { rows, plan: rows.map(({ setup, task, repeat }) => ({ setup, task, repeat })) };
};

test('a lost transcript of set-up 3 gives "No decision"; one of set-up P, 1 or 2 leaves the decision as it was, and the run is listed (fifth fairness reading)', () => {
  const goOn = withOthers(batch((setup) => ({ inputTokens: setup === 3 ? 600 : 1000 })));
  const stop = withOthers(batch(() => ({ inputTokens: 1000 })));
  const go = decide(goOn);
  const st = decide(stop);
  assert.match(go, /^Go on/);
  assert.match(st, /^Stop and look/);
  // Set-up P, 1 or 2: the batch is decided as usual, and the lost run is said in the list of unfinished runs.
  for (const setup of ['P', 1, 2]) {
    // The run first ends unfinished WITH its transcript, then loses it: only the loss is compared.
    const unfinish = (b) => b.rows.map((r) => (r.setup === setup && r.task === 'q4' && r.repeat === 2 ? { ...r, stopReason: 'interrupted', solved: false, tokensKnown: true } : r));
    for (const [b, before] of /** @type {const} */ ([[goOn, /^Go on/], [stop, /^Stop and look/]])) {
      const kept = unfinish(b);
      const lost = lose(kept, setup, 4, 2);
      assert.match(decide({ rows: kept, plan: b.plan }), before, `set-up ${setup}, transcript kept`);
      assert.equal(decide({ rows: lost, plan: b.plan }), decide({ rows: kept, plan: b.plan }), `set-up ${setup}: the loss changes nothing`);
      assert.equal(noDecisionReason(lost, { plan: b.plan }), undefined);
    }
    const report = renderReport2(lose(stop.rows, setup, 4, 2), { plan: stop.plan });
    const name = setup === 'P' ? 'set-up P' : `set-up ${setup}`;
    assert.ok(report.includes(`\`t-${setup}-q4-2\` (interrupted, 0 tokens recorded, tokens unknown: its transcript is lost, which does not withhold the decision: nothing claim A uses depends on a transcript of ${name})`), name);
    assert.ok(!report.includes('Without this guard'), 'nothing is withheld, so nothing is printed beside the decision');
  }
  // Set-up 3: "No decision", from "Go on" and from "Stop and look" alike.
  const one = 'No decision: the transcript of 1 run of set-up 3 is missing, so what it spent cannot be known, and claim A rests on set-up 3\'s spend (RULE-2.md).';
  assert.equal(decide({ rows: lose(goOn.rows, 3, 4, 2), plan: goOn.plan }), one, 'a holding claim');
  assert.equal(decide({ rows: lose(stop.rows, 3, 4, 2), plan: stop.plan }), one, 'a failing claim');
  const two = lose(lose(lose(goOn.rows, 3, 1, 1), 3, 2, 3), 'P', 2, 3);
  assert.equal(decide({ rows: two, plan: goOn.plan }), 'No decision: the transcripts of 2 runs of set-up 3 are missing, so what they spent cannot be known, and claim A rests on set-up 3\'s spend (RULE-2.md).', 'the set-up P run is not counted');
  // The rows must still be exactly the planned runs first: that reason comes before this one.
  assert.match(decide({ rows: two.slice(1), plan: goOn.plan }), /^No decision: the rows are not exactly the planned runs/);
  const report = renderReport2(two, { plan: goOn.plan });
  assert.ok(report.includes(`## The decision (RULE-2.md, "What decides")\n\nNo decision: the transcripts of 2 runs of set-up 3 are missing`));
  assert.ok(report.includes('(interrupted, 0 tokens recorded, tokens unknown: its transcript is lost, and a lost transcript of set-up 3 withholds the decision)'));
  assert.match(report, /Unfinished runs whose tokens cannot be known at all \(no transcript\): 3\./);
  assert.match(report, /a run with no transcript counts the most a run can spend, and when it is a run of set-up 3 its batch is not decided\)/);
  for (const c of CLAIMS) assert.ok(report.includes(`### ${c.label[0].toUpperCase()}${c.label.slice(1)}`), c.id);
  assert.match(report, /Rows, A on the 30 questions, second reading/);
});

test('a withheld decision prints what the rows give without the guard; the decision line itself stays "No decision"', () => {
  const section = (report) => report.slice(report.indexOf('## The decision'), report.indexOf('Runs the harness could not finish'));
  const stop = batch(() => ({ inputTokens: 1000 }));
  const rowsGive = decide(stop);
  assert.match(rowsGive, /^Stop and look: claim A does not hold on the questions: .*not at least 25% cheaper/);
  // 21 unfinished runs of set-up P (the rows still give "Stop and look": set-up 3 is no cheaper).
  const broken = stop.rows.map((r) => (r.setup === 'P' && r.repeat === 1 && Number(r.task.slice(1)) <= MAX_UNFINISHED ? { ...r, stopReason: 'error', solved: false } : r));
  const w = withholding(broken, { plan: stop.plan });
  assert.deepEqual([w?.guard, w?.reasons.length], [true, 1]);
  const brokenReport = renderReport2(broken, { plan: stop.plan });
  assert.equal(section(brokenReport), `## The decision (RULE-2.md, "What decides")\n\nNo decision: ${w?.reason}\n\nWithout this guard the rows give: ${rowsDecision(broken, stop.plan)}\n\n`);
  assert.match(rowsDecision(broken, stop.plan), /^Stop and look/);
  assert.equal(decision2(broken, w?.reason, stop.plan), `No decision: ${w?.reason}`, 'what reads the decision as data sees "No decision" only');
  // A lost set-up 3 transcript, likewise.
  const lost = lose(stop.rows, 3, 4, 2);
  const lostReport = renderReport2(lost, { plan: stop.plan });
  assert.match(section(lostReport), /^## The decision \(RULE-2\.md, "What decides"\)\n\nNo decision: the transcript of 1 run of set-up 3 is missing[^\n]*\n\nWithout this guard the rows give: Stop and look: claim A does not hold on the questions/);
  // Both guards: the second is named, and the rows are given without either.
  const both = lose(broken, 3, 4, 2);
  const bothW = withholding(both, { plan: stop.plan });
  assert.equal(bothW?.reasons.length, 2);
  assert.ok(renderReport2(both, { plan: stop.plan }).includes(`\n\nThe other guard trips too: ${bothW?.reasons[1]} Without both guards the rows give: Stop and look`));
  // The line is the rows' own decision, whatever it is: here the rows give the second reading's "No decision"
  // (set-up 3 is 29% cheaper over set-up P's finished runs, 18% once its 21 unfinished runs count right at no cost).
  const close = batch((setup) => ({ inputTokens: setup === 3 ? 600 : 850 }));
  const closeBroken = close.rows.map((r) => (r.setup === 'P' && r.repeat === 1 && Number(r.task.slice(1)) <= MAX_UNFINISHED ? { ...r, stopReason: 'error', solved: false } : r));
  assert.match(rowsDecision(closeBroken, close.plan), /^No decision: claim A on the questions holds in the first reading and fails in the second/);
  assert.ok(renderReport2(closeBroken, { plan: close.plan }).includes(`\n\nWithout this guard the rows give: ${rowsDecision(closeBroken, close.plan)}\n\n`));
  // Nothing extra for a smoke batch or a batch without a plan.
  for (const options of [{ plan: stop.plan, smoke: true }, {}]) {
    const report = renderReport2(broken, options);
    assert.match(section(report), /\n\nNo decision: (a smoke batch|there is no plan)/);
    assert.ok(!report.includes('the rows give:') && !report.includes(NOT_THE_PLAN_SENTENCE), JSON.stringify(Object.keys(options)));
  }
});

test('planned runs that have no row: "No decision", and beside it what the rows give with each missing run counted as a lost unfinished run (sixth fairness reading)', () => {
  const section = (report) => report.slice(report.indexOf('## The decision'), report.indexOf('Runs the harness could not finish'));
  const stop = batch(() => ({ inputTokens: 1000 }));
  // A batch stopped after its first third: in run order, repeat 1 of every task and part of repeat 2.
  const order = [...stop.rows].sort((x, y) => x.repeat - y.repeat || Number(x.task.slice(1)) - Number(y.task.slice(1)));
  const third = order.slice(0, 100);
  const w = withholding(third, { plan: stop.plan });
  assert.deepEqual([w?.kind, w?.missing.length, w?.reasons.length], ['guard', 200, 1]);
  const line = decision2(third, w?.reason, stop.plan);
  assert.equal(line, 'No decision: the rows are not exactly the planned runs: 200 of the 300 planned runs are missing.', 'what reads the decision as data sees "No decision" only');
  const filled = fillMissing(third, /** @type {any} */ (w).missing);
  assert.equal(filled.length, 300);
  assert.ok(filled.slice(100).every((r) => r.stopReason === 'interrupted' && !r.solved && r.tokensKnown === false && r.kind), 'the real row maker, with the task read from a row of it');
  const gives = rowsDecision(filled, stop.plan);
  assert.match(gives, /^Stop and look: claim A does not hold on the questions: on the 30 questions set-up 3 was right in 50 of 150 planned \(50 finished\)/);
  assert.equal(section(renderReport2(third, { plan: stop.plan })), `## The decision (RULE-2.md, "What decides")\n\n${line}\n\n${WORST_CASE_WORDS} ${ONE_MISSING_RUN_WORDS} Without this guard, with each of the 200 planned runs that have no row (100 of them runs of set-up 3) counted as an unfinished run whose transcript is lost, the rows give: ${gives}\n\n`);
  assert.equal(WORST_CASE_WORDS, 'This line is the worst case for the claim, not a result.');
  assert.equal(ONE_MISSING_RUN_WORDS, 'One missing question run of set-up 3, counted at the most a run can spend, is enough to make it read "Stop and look", whatever set-up 3 did on the runs that were made.');
  // Missing runs of set-up P only: a worst case still, but the set-up 3 reason is not claimed.
  const goOnP = batch((setup) => ({ inputTokens: setup === 3 ? 600 : 1000 }));
  const noP = goOnP.rows.filter((r) => !(r.setup === 'P' && r.repeat === 5));
  const wP = withholding(noP, { plan: goOnP.plan });
  const pSection = section(renderReport2(noP, { plan: goOnP.plan }));
  assert.ok(pSection.includes(`\n\n${WORST_CASE_WORDS} Without this guard, with each of the 30 planned runs that have no row (none of them a run of set-up 3) counted as an unfinished run whose transcript is lost, the rows give: ${rowsDecision(fillMissing(noP, /** @type {any} */ (wP).missing), goOnP.plan)}\n\n`), pSection);
  assert.ok(!pSection.includes(ONE_MISSING_RUN_WORDS));
  // One missing set-up 3 run of a batch that goes on: counted at the cap and not right, it is the rows' own reading.
  const goOn = batch((setup) => ({ inputTokens: setup === 3 ? 600 : 1000 }));
  const one = goOn.rows.filter((r) => !(r.setup === 3 && r.task === 'q4' && r.repeat === 2));
  const w1 = withholding(one, { plan: goOn.plan });
  const oneGives = rowsDecision(fillMissing(one, /** @type {any} */ (w1).missing), goOn.plan);
  assert.match(oneGives, /^Stop and look/, 'one missing set-up 3 run at the cap is enough by itself');
  assert.ok(renderReport2(one, { plan: goOn.plan }).includes(`\n\n${WORST_CASE_WORDS} ${ONE_MISSING_RUN_WORDS} Without this guard, with the 1 planned run that has no row (a run of set-up 3) counted as an unfinished run whose transcript is lost, the rows give: ${oneGives}\n\n`));
  // A guard the PRESENT rows trip is named; the runs never made trip none.
  const both = lose(third, 3, 0, 1);
  const wb = withholding(both, { plan: stop.plan });
  assert.deepEqual(wb?.reasons.map((r) => r.slice(0, 40)), ['the rows are not exactly the planned run', 'the transcript of 1 run of set-up 3 is m']);
  assert.ok(renderReport2(both, { plan: stop.plan }).includes(`\n\n${WORST_CASE_WORDS} ${ONE_MISSING_RUN_WORDS} The other guard trips too: ${wb?.reasons[1]} Without both guards, with each of the 200 planned runs that have no row (100 of them runs of set-up 3) counted as an unfinished run whose transcript is lost, the rows give: Stop and look`));
  // A planned run twice, or a row not in the plan: the fixed sentence and no line.
  const twice = [...stop.rows, { ...stop.rows[0] }];
  const unplanned = [...stop.rows, { ...stop.rows[0], task: 'q99' }];
  for (const rows of [twice, unplanned, [...third, { ...third[0] }]]) {
    const report = renderReport2(rows, { plan: stop.plan });
    assert.match(section(report), new RegExp(`\\n\\nNo decision: the rows are not exactly the planned runs: [^\\n]*\\n\\n${NOT_THE_PLAN_SENTENCE.replace(/[().]/g, '\\$&')}\\n\\n$`));
    assert.ok(!report.includes('the rows give:'));
  }
  assert.match(NOT_THE_PLAN_SENTENCE, /A batch folder is written by one process at a time \(harness\/batch\.mjs · lockBatch\), so this means its files were changed by hand or the harness failed/);
  // A smoke batch with runs missing: nothing extra.
  assert.ok(!renderReport2(third, { plan: stop.plan, smoke: true }).includes('the rows give:'));
});

test('a plan naming a task the harness does not know is not the plan: its own reason, no line, and fillMissing refuses it (seventh fairness reading)', () => {
  const stop = batch(() => ({ inputTokens: 1000 }));
  const rows = stop.rows.filter((r) => r.task !== 'q7'); // no row of q7 is left, and no question or fault is called q7
  const w = withholding(rows, { plan: stop.plan, tasks: new Map() });
  assert.deepEqual([w?.kind, w?.guard, w?.unknownTasks], ['not the plan', false, ['q7']]);
  assert.equal(decision2(rows, w?.reason, stop.plan), 'No decision: the plan names a task the harness does not know (no row of it, and no question or fault of that id): q7.');
  const report = renderReport2(rows, { plan: stop.plan });
  assert.ok(report.includes(`No decision: the plan names a task the harness does not know (no row of it, and no question or fault of that id): q7.\n\n${UNKNOWN_TASK_SENTENCE}\n\n`));
  assert.ok(!report.includes('the rows give:'));
  assert.throws(() => fillMissing(rows, stop.plan.filter((p) => p.task === 'q7')), /fillMissing: the plan names task q7, which no row and no loaded question or fault names/);
  // Known from a loaded question: filled, as before.
  const known = new Map([['q7', { type: 'question', kind: 'run' }]]);
  assert.equal(withholding(rows, { plan: stop.plan, tasks: known })?.kind, 'guard');
});

test('the spend stop: written into the folder when it ends a batch, said beside the decision while it is true', async () => {
  const stop = batch(() => ({ inputTokens: 1000 }));
  // Stopped in run order: repeats 1 to 3 of every task have rows, 4 and 5 none.
  const byRepeat = [...stop.rows].sort((x, y) => x.repeat - y.repeat);
  const third = byRepeat.slice(0, 180);
  const w = withholding(third, { plan: stop.plan });
  const at = { spend: 15.0412, rows: third.length };
  const words = 'The spend stop ended this batch: before its next run the estimate had reached 15.04 dollars (harness/budget.mjs), so the planned runs after it have no row.';
  assert.equal(spendStopLine(third, w, at), words);
  assert.ok(renderReport2(third, { plan: stop.plan, spendStop: at }).includes(`planned runs are missing.\n\n${words}\n\n`));
  // Resumed afterwards (a row was added after the stop), or finished: not said.
  const more = byRepeat.slice(0, 181);
  assert.equal(spendStopLine(more, withholding(more, { plan: stop.plan }), at), undefined);
  assert.equal(spendStopLine(stop.rows, withholding(stop.rows, { plan: stop.plan }), { ...at, rows: 300 }), undefined);
  assert.ok(!renderReport2(stop.rows, { plan: stop.plan, spendStop: { ...at, rows: 300 } }).includes('The spend stop ended'));
  // Written by runBatch: a folder whose first row already spent past the stop.
  const out = mkdtempSync(join(tmpdir(), 'agent-debug-spend-'));
  try {
    const question = loadQuestions()[0];
    const { runOrder } = await import('../harness/batch.mjs');
    const first = runOrder([3], [question.id], 2, 1, 'task')[0];
    writeFileSync(join(out, 'runs.jsonl'), `${JSON.stringify({ setup: first.setup, task: question.id, taskType: 'question', kind: question.kind, repeat: first.repeat, solved: true, stopReason: 'answered', inputTokens: 200_000_000, outputTokens: 0, model: 'm', transcript: 'x' })}\n`);
    const result = await runBatch({ out, setups: [3], questions: [question], repeats: 2, seed: 1, modelFor: async () => assert.fail('no run starts after the spend stop') });
    assert.equal(result.stoppedBySpend, true);
    const lines = readRuns(join(out, SPEND_STOP_FILE));
    assert.deepEqual([lines.length, lines[0].spend, lines[0].rows], [1, 20, 1]);
    assert.ok(writeReport2(out).includes('The spend stop ended this batch: before its next run the estimate had reached 20.00 dollars'));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('fillMissing: a missing run whose task no row names takes its task from the loaded questions and faults', () => {
  const question = loadQuestions()[0];
  const fault = loadFaults()[0];
  const tasks = new Map([[question.id, question], [fault.id, fault]]);
  const [q, f] = fillMissing([], [{ setup: 3, task: question.id, repeat: 1 }, { setup: 'P', task: fault.id, repeat: 2 }], tasks);
  assert.deepEqual([q.taskType, q.kind, q.tokensKnown, q.stopReason], ['question', question.kind, false, 'interrupted']);
  assert.deepEqual([f.taskType, f.faultClass, f.tokensKnown], ['fault', fault.class, false]);
});

test('the first reading counts a run with no transcript at the most a run can spend: losing it never makes set-up 3 cheaper (oracle-1)', () => {
  // Set-up 3's q4 repeat 2 was interrupted after recording 50,000 tokens. Rebuilt without its transcript it records
  // 0; the first reading counts it at RUN_CAP_TOKENS, so set-up 3's side gains exactly RUN_CAP_TOKENS - 50,000.
  const b = batch((setup, q, repeat) => (setup === 3 && q === 4 && repeat === 2 ? { stopReason: 'interrupted', solved: false, inputTokens: 50000, tokensKnown: true } : { inputTokens: setup === 3 ? 600 : 1000 }));
  const before = claim(b.rows, CLAIMS[0], QUESTIONS, b.plan);
  const rows = b.rows.map((r) => (r.stopReason === 'interrupted' ? unfinishedRow({ setup: 3, task: r.task, taskType: 'question', repeat: 2, model: 'm', transcript: r.transcript }, { type: 'question', kind: r.kind }, null) : r));
  assert.equal(rows.find((r) => r.tokensKnown === false)?.inputTokens, 0, 'the real row maker records nothing');
  const after = claim(rows, CLAIMS[0], QUESTIONS, b.plan);
  assert.equal(after.a.tokens - (before.a.tokens - 50000), RUN_CAP_TOKENS, 'the lost run adds exactly the most a run can spend');
  assert.equal(after.a.right, before.a.right);
  assert.ok(after.a.perRight > before.a.perRight);
  for (const [i, r] of after.rows.entries()) assert.ok(r.a.tokens >= before.rows[i].a.tokens, r.label);
  // The same in the second reading, which always priced it so.
  assert.equal(claim(rows, CLAIMS[0], QUESTIONS, b.plan, { bound: true }).a.tokens, after.a.tokens);
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
    assert.equal(cut.finishedInTranscript, undefined, 'no end line: not marked');
    // A transcript that holds the run's own end line: the run finished and its row was lost. Marked, still unfinished.
    writeFileSync(join(out, 'transcripts', 'ended.jsonl'), `${lines}\n{"type":"response","usage":{"input_tokens":900,"output_tokens":5}}\n{"type":"end","stopReason":"answered"}\n`);
    const ended = interruptedRow(out, { ...started, setup: 'P', transcript: 'transcripts/ended.jsonl' }, undefined);
    assert.deepEqual([ended.finishedInTranscript, ended.stopReason, ended.solved], [true, 'interrupted', false]);
    const report = renderReport2([ended], {});
    assert.ok(report.includes(`\`transcripts/ended.jsonl\` (interrupted, 1,610 tokens recorded, ${ROW_LOST_WORDS})`), report.slice(report.indexOf('Runs the harness'), report.indexOf('Runs the harness') + 300));
    assert.equal(ROW_LOST_WORDS, 'its transcript shows the run finished (it holds the run\'s end line) and its row was lost; it still counts as unfinished');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('a run that ended in an error is never solved, whatever its scoring found', async () => {
  const { faultRow, questionRow } = await import('../harness/rows.mjs');
  const counts = { stopReason: 'error', error: 'API error', answered: false, toolCalls: {}, retried: [], requestsWithoutUsage: 1 };
  const common = { item: { setup: 3, repeat: 1, task: 'x' }, program: { id: 'F' }, model: { name: 'm' }, counts, transcript: 't' };
  assert.equal(questionRow({ ...common, task: { id: 'q', kind: 'run' }, score: { solved: true, expected: 1, answerProblem: null }, editedFiles: [] }).solved, false);
  assert.equal(faultRow({ ...common, task: { id: 'f', class: 'data-flow' }, score: { solved: true, editedFaultyFile: true, editedFiles: [], changedOutsideSrc: [], wrongFixtures: [], scoringProblem: null } }).solved, false);
});
