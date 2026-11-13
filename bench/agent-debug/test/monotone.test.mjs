/**
 * A worse favoured set-up, or a better other set-up, never helps a claim
 * (RULE-2.md, "The most-expensive-run row leaves out one run of B only").
 *
 * The old row left out a run of EACH set-up and was not monotone: three
 * reviewers of the deciding code each built a batch where making set-up 3
 * worse (or set-up P better) turned "Stop and look" into "Go on". Those
 * batches are rebuilt here and must now give the same or a stricter result.
 * Then a property over generated batches (a seeded generator, so a failure
 * names its seed): for every claim, task group, reading, the headline and
 * every row, a change that makes A worse or B better never turns a failing
 * test into a holding one.
 * "Same or stricter" for a decision: "Go on" after the change only if "Go
 * on" before it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { seeded } from '../harness/batch.mjs';
import { CLAIMS, GROUPS, claim, noDecisionReason } from '../harness/compare2.mjs';
import { MAYBE_PAID_REASONS } from '../harness/model.mjs';
import { decision2 } from '../harness/report2.mjs';

const KINDS = ['program', 'run', 'why'];
const QUESTIONS = /** @type {any} */ (GROUPS.find((g) => g.id === 'questions'));
const decide = (rows, plan) => decision2(rows, noDecisionReason(rows, { plan }), plan);
const goOn = (d) => d.startsWith('Go on');

/** 30 questions × 5 for set-ups 3 and P, each row from `make`. */
function batch(make) {
  const rows = [];
  for (let q = 0; q < 30; q++) {
    for (let repeat = 1; repeat <= 5; repeat++) {
      for (const setup of [3, 'P']) {
        rows.push({ setup, task: `q${q}`, taskType: 'question', kind: KINDS[q % 3], repeat, solved: true, stopReason: 'answered', inputTokens: 1000, outputTokens: 0, newTokens: 0, resentTokens: 0, requests: 3, requestsWithoutUsage: 0, retried: [], model: 'm', transcript: `t-${setup}-q${q}-${repeat}`, ...make(setup, q, repeat) });
      }
    }
  }
  return { rows, plan: rows.map(({ setup, task, repeat }) => ({ setup, task, repeat })) };
}
const at = (rows, setup, q, repeat) => /** @type {any} */ (rows.find((r) => r.setup === setup && r.task === `q${q}` && r.repeat === repeat));
/** The reviewers' batches print their decisions (the report of this round quotes them). */
const show = (label, d) => console.log(`${label}: ${d.slice(0, 120)}`);

test('reviewer rule-vs-code\'s batch: 5,000 more tokens on a wrong set-up 3 run, and its mirror, no longer turn the result toward the claim', () => {
  const b = batch((setup, q, repeat) => ({ solved: repeat < 5, inputTokens: setup === 3 ? 1000 : 2000 }));
  at(b.rows, 3, 1, 1).inputTokens = 5000; // set-up 3's priciest run: a right one
  at(b.rows, 'P', 0, 5).inputTokens = 4000; // set-up P's priciest finished run: a wrong one
  const before = decide(b.rows, b.plan);
  at(b.rows, 3, 2, 5).inputTokens = 6000; // set-up 3 spends 5,000 MORE on a wrong run
  const after = decide(b.rows, b.plan);
  show('rule-vs-code before', before);
  show('rule-vs-code after', after);
  assert.ok(!goOn(after) || goOn(before));
  at(b.rows, 3, 2, 5).inputTokens = 1000;
  at(b.rows, 'P', 3, 1).inputTokens = 3000;
  const mirrorBefore = decide(b.rows, b.plan);
  at(b.rows, 'P', 0, 5).inputTokens = 2000; // set-up P's priciest (wrong) run costs 2,000 fewer: P better
  const mirrorAfter = decide(b.rows, b.plan);
  show('rule-vs-code mirror before', mirrorBefore);
  show('rule-vs-code mirror after', mirrorAfter);
  assert.ok(!goOn(mirrorAfter) || goOn(mirrorBefore));
});

test('reviewer decision-logic\'s batch: a wrong set-up 3 run costing 100,000 instead of 30,000 no longer helps', () => {
  const b = batch((setup, q, repeat) => ({ solved: repeat <= 4, inputTokens: setup === 3 ? 30000 : 60000 }));
  /** @type {any} */ (b.rows.find((r) => r.setup === 3 && r.solved)).inputTokens = 40000; // set-up 3's priciest: right
  /** @type {any} */ (b.rows.find((r) => r.setup === 'P' && !r.solved)).inputTokens = 61000;
  const before = decide(b.rows, b.plan);
  /** @type {any} */ (b.rows.find((r) => r.setup === 3 && !r.solved)).inputTokens = 100000;
  const after = decide(b.rows, b.plan);
  show('decision-logic before', before);
  show('decision-logic after', after);
  assert.ok(!goOn(after) || goOn(before));
});

test('reviewer tokens-and-retries\'s two batches: more recorded spend by set-up 3 no longer helps, in either reading', () => {
  const witness = (fill, x) => {
    const b = batch((setup) => ({ inputTokens: setup === 3 ? 700 : 1000 }));
    fill(b.rows, x);
    return decide(b.rows, b.plan);
  };
  const one = (rows, x) => {
    Object.assign(at(rows, 'P', 0, 1), { solved: false, inputTokens: 5000 });
    Object.assign(at(rows, 3, 0, 1), { stopReason: 'interrupted', solved: false, inputTokens: x, tokensKnown: true });
    at(rows, 3, 1, 1).inputTokens = 800;
  };
  const two = (rows, x) => {
    at(rows, 'P', 0, 1).inputTokens = 200000;
    Object.assign(at(rows, 3, 0, 1), { inputTokens: x, retried: [{ reason: MAYBE_PAID_REASONS[0], call: 'message', request: 1, mayHaveBeenPaid: true, answeredInput: null }] });
    at(rows, 3, 1, 1).inputTokens = 710;
  };
  for (const [label, fill, lo, hi] of /** @type {const} */ ([['tokens-and-retries witness 1', one, 500, 900], ['tokens-and-retries witness 2', two, 600, 800]])) {
    const before = witness(fill, lo);
    const after = witness(fill, hi);
    show(`${label} before`, before);
    show(`${label} after`, after);
    assert.ok(!goOn(after) || goOn(before), label);
  }
});

/** A generated batch: set-ups 3, P and 1 on 6 question tasks × 4 repeats, with every kind of row the harness writes. */
function generated(random) {
  const pick = (xs) => xs[Math.floor(random() * xs.length)];
  const rows = [];
  for (let q = 0; q < 6; q++) {
    for (let repeat = 1; repeat <= 4; repeat++) {
      for (const setup of [3, 'P', 1]) {
        const base = setup === 3 ? 400 + Math.floor(random() * 800) : 600 + Math.floor(random() * 1200);
        const unfinished = random() < 0.12;
        const retried = random() < 0.15 ? [{ reason: pick([...MAYBE_PAID_REASONS, 'rate limited (429)']), call: random() < 0.2 ? 'count' : 'message', request: 1, mayHaveBeenPaid: false, answeredInput: random() < 0.5 ? Math.floor(random() * 3000) : null }] : [];
        for (const t of retried) t.mayHaveBeenPaid = t.call === 'message' && MAYBE_PAID_REASONS.includes(t.reason);
        rows.push({
          setup, task: `q${q}`, taskType: 'question', kind: KINDS[q % 3], repeat,
          solved: !unfinished && random() < 0.85, stopReason: unfinished ? pick(['error', 'interrupted']) : 'answered',
          inputTokens: random() < 0.05 ? base * 20 : base, outputTokens: 0, newTokens: 0, resentTokens: 0, requests: 3,
          requestsWithoutUsage: unfinished && random() < 0.5 ? 1 : 0, tokensKnown: !(unfinished && random() < 0.1), retried, model: 'm', transcript: 't',
        });
      }
    }
  }
  return { rows, plan: rows.map(({ setup, task, repeat }) => ({ setup, task, repeat })) };
}

/** One change that makes the favoured side `a` worse or the other side `b` better. */
function worsen(rows, c, random) {
  const copy = rows.map((r) => ({ ...r }));
  const of = (setup, ok) => copy.filter((r) => r.setup === setup && ok(r));
  const choice = Math.floor(random() * 6);
  const one = (xs) => xs[Math.floor(random() * xs.length)];
  if (choice === 0) { const r = one(of(c.a, () => true)); if (r) r.inputTokens += 1 + Math.floor(random() * 5000); }
  if (choice === 1) { const r = one(of(c.a, (x) => x.solved)); if (r) r.solved = false; }
  if (choice === 2) { const r = one(of(c.a, (x) => x.stopReason === 'answered')); if (r) Object.assign(r, { stopReason: 'error', solved: false }); }
  if (choice === 3) { const r = one(of(c.b, (x) => x.inputTokens > 0)); if (r) r.inputTokens -= 1 + Math.floor(random() * r.inputTokens); }
  if (choice === 4) { const r = one(of(c.b, (x) => !x.solved && x.stopReason === 'answered')); if (r) r.solved = true; }
  if (choice === 5) { const r = one(of(c.a, (x) => x.tokensKnown !== false && x.stopReason !== 'answered')); if (r) r.tokensKnown = false; }
  return copy;
}

test('property: making the favoured set-up worse or the other better never turns a failing claim into a holding one (headline and every row, both readings)', () => {
  const random = seeded(20261113);
  let compared = 0;
  for (let n = 0; n < 300; n++) {
    const seed = Math.floor(random() * 2 ** 31);
    const gen = seeded(seed);
    const { rows, plan } = generated(gen);
    for (const c of CLAIMS) {
      const after = worsen(rows, c, gen);
      for (const bound of [false, true]) {
        const x = claim(rows, c, QUESTIONS, plan, { bound });
        const y = claim(after, c, QUESTIONS, plan, { bound });
        assert.ok(!y.head || x.head, `seed ${seed}, ${c.id}, bound ${bound}: the headline went from failing to holding`);
        y.rows.forEach((row, i) => assert.ok(!row.holds || x.rows[i].holds, `seed ${seed}, ${c.id}, bound ${bound}: row "${row.label}" went from failing to holding`));
        assert.ok(!y.holds || x.holds, `seed ${seed}, ${c.id}, bound ${bound}`);
        compared++;
      }
      if (c.decides) assert.ok(!goOn(decide(after, plan)) || goOn(decide(rows, plan)), `seed ${seed}: the decision moved toward the claim`);
    }
  }
  assert.ok(compared >= 1800);
});
