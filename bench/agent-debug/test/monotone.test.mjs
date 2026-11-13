/**
 * With every transcript present, a worse favoured set-up, or a better other
 * set-up, never helps a claim (RULE-2.md, "The most-expensive-run row leaves
 * out one run of B only"); a missing transcript of set-up 3 gives "No
 * decision", and one of another set-up changes nothing claim A reads
 * (RULE-2.md, "What decides"; the second check, the fifth fairness reading).
 *
 * The old row left out a run of EACH set-up and was not monotone: three
 * reviewers of the deciding code each built a batch where making set-up 3
 * worse (or set-up P better) turned "Stop and look" into "Go on". Those
 * batches are rebuilt here and must now give the same or a stricter result.
 * Then three properties over generated batches (a seeded generator, so a
 * failure names its seed), as the rule stands after the second check:
 * (i) with every transcript present, a change that makes A worse or B better
 * never turns a failing claim into a holding one, in the headline and in
 * every row, in both readings, and never moves the decision toward "Go on";
 * (ii) losing a set-up 3 transcript always gives "No decision"; losing the
 * transcript of a run of set-up P, 1 or 2 never changes the decision, nor
 * claim A's reading (headline, every row, both readings). What (ii) compares:
 * the code finds a lost transcript only for a run that left no row, which it
 * rebuilds as interrupted; so the loss is compared with the same run
 * interrupted WITH its transcript. That the run is unfinished at all can
 * change a reading, as any unfinished run can (set-up P's share is over its
 * finished runs, and the run counts toward the 20); (ii) does not say it
 * cannot, only that the lost file adds nothing to it;
 * (iii) in the first reading, losing a transcript of A never turns a failing
 * claim into a holding one (readings.mjs · worstTokensOf). (iii) is not
 * asserted for the second reading: there a near-cap run with possibly-paid
 * retries is priced above the cap while its transcript exists, and the rule
 * answers that case with "No decision", not with a price.
 * "Same or stricter" for a decision: "Go on" after the change only if "Go
 * on" before it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { seeded } from '../harness/batch.mjs';
import { CLAIMS, FAVOURED, GROUPS, claim, noDecisionReason } from '../harness/compare2.mjs';
import { MAYBE_PAID_REASONS } from '../harness/model.mjs';
import { decision2 } from '../harness/report2.mjs';
import { unfinishedRow } from '../harness/rows.mjs';

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

/**
 * A run's row once its transcript is lost: exactly what batch.mjs · interruptedRow
 * writes for it, from the real row maker (rows.mjs · unfinishedRow(…, null):
 * interrupted, not solved, `tokensKnown: false`, tokens 0, no requests, no
 * retried attempts). The property must see the shape the harness writes; a
 * copy that kept the tokens hid the case the second check found (oracle-1).
 */
const lostRow = (r) => unfinishedRow({ setup: r.setup, task: r.task, taskType: r.taskType, repeat: r.repeat, model: r.model, transcript: r.transcript }, { type: 'question', kind: r.kind }, null);

/**
 * A generated batch: set-ups 3, P, 1 and 2 on 6 question tasks × 4 repeats, with every kind of row the harness writes.
 * `lost`: whether some unfinished runs have already lost their transcript (property (i) holds only without).
 * Set-up 2's rows are drawn from their own stream (`second`), so adding them left the other rows of every seed as they were.
 */
function generated(main, { lost = false, second = main } = {}) {
  const rows = [];
  for (let q = 0; q < 6; q++) {
    for (let repeat = 1; repeat <= 4; repeat++) {
      for (const setup of [3, 'P', 1, 2]) {
        const random = setup === 2 ? second : main;
        const pick = (xs) => xs[Math.floor(random() * xs.length)];
        const base = setup === 3 ? 400 + Math.floor(random() * 800) : 600 + Math.floor(random() * 1200);
        const unfinished = random() < 0.12;
        const retried = random() < 0.15 ? [{ reason: pick([...MAYBE_PAID_REASONS, 'rate limited (429)']), call: random() < 0.2 ? 'count' : 'message', request: 1, mayHaveBeenPaid: false, answeredInput: random() < 0.5 ? Math.floor(random() * 3000) : null }] : [];
        for (const t of retried) t.mayHaveBeenPaid = t.call === 'message' && MAYBE_PAID_REASONS.includes(t.reason);
        const row = {
          setup, task: `q${q}`, taskType: 'question', kind: KINDS[q % 3], repeat,
          solved: !unfinished && random() < 0.85, stopReason: unfinished ? pick(['error', 'interrupted']) : 'answered',
          inputTokens: random() < 0.05 ? base * 20 : base, outputTokens: 0, newTokens: 0, resentTokens: 0, requests: 3,
          requestsWithoutUsage: unfinished && random() < 0.5 ? 1 : 0, tokensKnown: true, retried, model: 'm', transcript: `t-${setup}-q${q}-${repeat}`,
        };
        rows.push(lost && unfinished && random() < 0.1 ? lostRow(row) : row);
      }
    }
  }
  return { rows, plan: rows.map(({ setup, task, repeat }) => ({ setup, task, repeat })) };
}

/** One change that makes the favoured side `a` worse or the other side `b` better, every transcript kept. */
function worsen(rows, c, random) {
  const copy = rows.map((r) => ({ ...r }));
  const of = (setup, ok) => copy.filter((r) => r.setup === setup && ok(r));
  const choice = Math.floor(random() * 5);
  const one = (xs) => xs[Math.floor(random() * xs.length)];
  if (choice === 0) { const r = one(of(c.a, () => true)); if (r) r.inputTokens += 1 + Math.floor(random() * 5000); }
  if (choice === 1) { const r = one(of(c.a, (x) => x.solved)); if (r) r.solved = false; }
  if (choice === 2) { const r = one(of(c.a, (x) => x.stopReason === 'answered')); if (r) Object.assign(r, { stopReason: 'error', solved: false }); }
  if (choice === 3) { const r = one(of(c.b, (x) => x.inputTokens > 0)); if (r) r.inputTokens -= 1 + Math.floor(random() * r.inputTokens); }
  if (choice === 4) { const r = one(of(c.b, (x) => !x.solved && x.stopReason === 'answered')); if (r) r.solved = true; }
  return copy;
}

/** The same rows with the transcript of the run at `i` lost (its row rebuilt as the harness rebuilds it). */
const losing = (rows, i) => rows.map((r, j) => (j === i ? lostRow(r) : { ...r }));

// A failing property names its seed; MONOTONE_SEED and MONOTONE_N re-run it on other batches.
const SEED = Number(process.env.MONOTONE_SEED ?? 20261113);
const N = Number(process.env.MONOTONE_N ?? 300);
const batches = (lost) => {
  const random = seeded(SEED);
  return Array.from({ length: N }, () => {
    const seed = Math.floor(random() * 2 ** 31);
    const gen = seeded(seed);
    return { seed, gen, ...generated(gen, { lost, second: seeded(seed ^ 0x5e72) }) };
  });
};
/** Asserts that `y` holds nowhere `x` failed: the headline, every row (by place), the whole claim. */
function noneTurnsToHolding(x, y, where) {
  assert.ok(!y.head || x.head, `${where}: the headline went from failing to holding`);
  y.rows.forEach((row, i) => assert.ok(!row.holds || x.rows[i].holds, `${where}: row "${row.label}" went from failing to holding`));
  assert.ok(!y.holds || x.holds, where);
}

test('property (i): with every transcript present, a worse favoured set-up or a better other one never turns a failing claim into a holding one (headline and every row, both readings), nor moves the decision toward "Go on"', () => {
  let compared = 0;
  for (const { seed, gen, rows, plan } of batches(false)) {
    for (const c of CLAIMS) {
      const after = worsen(rows, c, gen);
      for (const bound of [false, true]) {
        noneTurnsToHolding(claim(rows, c, QUESTIONS, plan, { bound }), claim(after, c, QUESTIONS, plan, { bound }), `seed ${seed}, ${c.id}, bound ${bound}`);
        compared++;
      }
      if (c.decides) assert.ok(!goOn(decide(after, plan)) || goOn(decide(rows, plan)), `seed ${seed}: the decision moved toward the claim`);
    }
  }
  assert.ok(compared >= 6 * N);
});

test('property (ii): losing a set-up 3 transcript always gives "No decision"; losing one of set-up P, 1 or 2 never changes the decision nor claim A\'s reading', () => {
  const before = new Map();
  const unchanged = new Map();
  for (const { seed, gen, rows, plan } of batches(true)) {
    const d0 = decide(rows, plan).split(':')[0];
    before.set(d0, (before.get(d0) ?? 0) + 1);
    // A run of set-up 3: always "No decision", with the set-up 3 reason.
    const of3 = rows.map((r, i) => [r, i]).filter(([r]) => r.setup === FAVOURED);
    const [, i3] = of3[Math.floor(gen() * of3.length)];
    const d = decide(losing(rows, i3), plan);
    assert.match(d, /^No decision: the transcripts? of \d+ runs? of set-up 3 (is|are) missing, so what (it|they) spent cannot be known/, `seed ${seed}, row ${i3}: ${d.slice(0, 120)}`);
    // A run of another set-up: the same run interrupted with its transcript, against it interrupted without.
    const others = rows.map((r, i) => [r, i]).filter(([r]) => r.setup !== FAVOURED);
    const [, i] = others[Math.floor(gen() * others.length)];
    const kept = rows.map((r, j) => (j === i ? { ...r, stopReason: 'interrupted', solved: false } : { ...r }));
    const lost = losing(kept, i);
    const dKept = decide(kept, plan);
    assert.equal(decide(lost, plan), dKept, `seed ${seed}, row ${i} (set-up ${rows[i].setup})`);
    for (const bound of [false, true]) {
      const x = claim(kept, CLAIMS[0], QUESTIONS, plan, { bound });
      const y = claim(lost, CLAIMS[0], QUESTIONS, plan, { bound });
      assert.deepEqual([y.head, y.holds, y.rows.map((r) => r.holds)], [x.head, x.holds, x.rows.map((r) => r.holds)], `seed ${seed}, row ${i}, bound ${bound}`);
    }
    const k = `${rows[i].setup === 'P' ? 'P' : 'other'} ${dKept.split(':')[0]}`;
    unchanged.set(k, (unchanged.get(k) ?? 0) + 1);
  }
  // The batches start from every decision, so "whatever the decision was before" is tried, not assumed.
  assert.ok(['Go on (a larger program of our own, then a program we did not write, ported to the pattern)', 'Stop and look', 'No decision'].every((k) => before.get(k) > 0), JSON.stringify([...before]));
  // A lost set-up P transcript is tried on batches that go on and that stop.
  assert.ok(['P Go on (a larger program of our own, then a program we did not write, ported to the pattern)', 'P Stop and look'].every((k) => unchanged.get(k) > 0), JSON.stringify([...unchanged]));
});

test('property (iii): in the FIRST reading, losing a transcript of the favoured set-up never turns a failing claim into a holding one (headline and every row)', () => {
  // Not asserted for the second reading: a near-cap run with possibly-paid retries is priced above the cap while its
  // transcript exists (the second check's oracle-2), and RULE-2.md answers a lost transcript with "No decision", not a price.
  let compared = 0;
  for (const { seed, gen, rows, plan } of batches(true)) {
    for (const c of CLAIMS) {
      const mine = rows.map((r, i) => [r, i]).filter(([r]) => r.setup === c.a && r.tokensKnown !== false);
      if (!mine.length) continue;
      const [, i] = mine[Math.floor(gen() * mine.length)];
      noneTurnsToHolding(claim(rows, c, QUESTIONS, plan), claim(losing(rows, i), c, QUESTIONS, plan), `seed ${seed}, ${c.id}, row ${i}`);
      compared++;
    }
  }
  assert.ok(compared >= 3 * N - 3);
});
