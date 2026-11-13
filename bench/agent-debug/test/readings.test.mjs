/**
 * Unfinished runs are counted against the claim on BOTH sides, and the
 * second reading prices what is not known at its cap (RULE-2.md, "Changed
 * after the fairness readings"; harness/readings.mjs, compare2.mjs,
 * report2.mjs). The two cases of the second fairness reading
 * (twin-proof's reader, decision-case-2.mjs and decision-case-3.mjs), the
 * bound that withholds the decision, and retried attempts by reason.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runAgent } from '../harness/agent.mjs';
import { LIMITS, MAX_OUTPUT_TOKENS } from '../harness/budget.mjs';
import { CLAIMS, GROUPS, claim } from '../harness/compare2.mjs';
import { MAYBE_PAID_REASONS } from '../harness/model.mjs';
import { SYSTEM_PROMPT_2 } from '../harness/prompt.mjs';
import { boundTokensOf, readSide } from '../harness/readings.mjs';
import { decision2, renderReport2 } from '../harness/report2.mjs';
import { retriedFrom } from '../harness/retries.mjs';
import { createWorkdir, removeWorkdir } from '../harness/workdir.mjs';
import { loadQuestions } from '../questions/index.mjs';

const KINDS = ['program', 'run', 'why'];
const QUESTIONS_GROUP = /** @type {any} */ (GROUPS.find((g) => g.id === 'questions'));

/**
 * 30 questions × 5 repeats for set-ups 3 and P (the reader's construction):
 * each side's runs are right by a fixed spread until `right` of them are.
 */
function batch({ tokens3, tokensP, right3, rightP }) {
  const rows = [];
  const plan = [];
  for (const [setup, tokens, right] of [[3, tokens3, right3], ['P', tokensP, rightP]]) {
    const mine = [];
    for (let q = 0; q < 30; q++) {
      for (let repeat = 1; repeat <= 5; repeat++) {
        plan.push({ setup, task: `q${q}`, repeat });
        mine.push({ setup, task: `q${q}`, taskType: 'question', kind: KINDS[q % 3], repeat, solved: false, stopReason: 'answered', inputTokens: tokens, outputTokens: 0, newTokens: tokens, resentTokens: 0, requests: 3, model: 'm', transcript: `t-${setup}-q${q}-${repeat}` });
      }
    }
    mine.forEach((r, j) => { r.solved = (j * 7919) % mine.length < right; });
    rows.push(...mine);
  }
  return { rows, plan };
}

/** Turns `n` of a set-up's WRONG runs into unfinished ones with `fields`. */
function unfinish(rows, setup, n, fields) {
  let left = n;
  for (const r of rows) if (r.setup === setup && !r.solved && left > 0) { Object.assign(r, { solved: false, ...fields }); left--; }
}

test('the reader\'s first case (set-up 3 loses four runs) prints "Stop and look"', () => {
  const { rows, plan } = batch({ tokens3: 6000, tokensP: 10000, right3: 116, rightP: 117 });
  unfinish(rows, 3, 4, { stopReason: 'error', inputTokens: 8000, requestsWithoutUsage: 1 });
  const sentence = decision2(rows, undefined, plan);
  assert.match(sentence, /^Stop and look: claim A does not hold on the questions: on the 30 questions set-up 3 was right in 116 of 150 planned \(146 finished\) against set-up P's 117 of 150 finished \(150 planned\)/, sentence);
});

test('the reader\'s mirror case (set-up P loses four runs to API errors) prints "Stop and look"', () => {
  // Set-up 3: 116 right of 150, all finished. Set-up P: 116 right of 146 finished, and 4 error runs. On the
  // runs that finished P was right more often (79.5% against 77.3%); planned runs on both sides said "Go on".
  const { rows, plan } = batch({ tokens3: 6000, tokensP: 10000, right3: 116, rightP: 116 });
  unfinish(rows, 'P', 4, { stopReason: 'error', inputTokens: 8000, requestsWithoutUsage: 1 });
  const sentence = decision2(rows, undefined, plan);
  assert.match(sentence, /^Stop and look: claim A does not hold on the questions: on the 30 questions set-up 3 was right in 116 of 150 planned \(150 finished\) against set-up P's 116 of 146 finished \(150 planned\).*set-up 3 was right less often/, sentence);
  const report = renderReport2(rows, { plan });
  assert.match(report, /Readings \(RULE-2\.md, "Changed after the fairness readings"\): set-up 3, the side the claim favours, is read at its worst .* set-up P is read over its finished runs only/);
  assert.match(report, /\| the 30 questions \| 116 of 150 planned \(150 finished\) \| [\d,]+ \(0 unfinished\) \| [\d,]+ \/ 0 \| 116 of 146 finished \(150 planned\) \| [\d,]+ \(finished only: 4 unfinished left out\) \|/);
});

test('a side with no finished run in a group cannot be compared: the claim does not hold there', () => {
  const { rows, plan } = batch({ tokens3: 10, tokensP: 10000, right3: 150, rightP: 0 });
  for (const r of rows) if (r.setup === 'P' && r.kind === 'why') Object.assign(r, { stopReason: 'error', solved: false });
  const why = claim(rows, CLAIMS[0], /** @type {any} */ (GROUPS.find((g) => g.id === 'why')), plan);
  assert.equal(why.b.comparable, false);
  assert.equal(why.holds, false);
  assert.ok(why.rows.every((r) => !r.holds));
});

test('what is not known, priced at its cap: every number from the limits of budget.mjs', () => {
  const cap = LIMITS.maxInputTokensPerRequest + MAX_OUTPUT_TOKENS;
  const base = { inputTokens: 1000, outputTokens: 100 };
  assert.equal(boundTokensOf({ ...base, tokensKnown: false }), LIMITS.maxInputTokensPerRun, 'no transcript: the per-run limit');
  assert.equal(boundTokensOf({ ...base, requestsWithoutUsage: 2 }), 1100 + 2 * cap, 'each request never answered');
  const [timeout] = MAYBE_PAID_REASONS;
  assert.equal(boundTokensOf({ ...base, retried: [{ reason: timeout, call: 'message', mayHaveBeenPaid: true, answeredInput: 1200 }] }), 1100 + 1200 + MAX_OUTPUT_TOKENS, 'a possibly-paid retry: the answered attempt\'s input plus the output limit');
  assert.equal(boundTokensOf({ ...base, retried: [{ reason: timeout, call: 'message', mayHaveBeenPaid: true, answeredInput: null }] }), 1100 + cap, 'never answered: the per-request limit');
  assert.equal(boundTokensOf({ ...base, retried: [{ reason: 'rate limited (429)', call: 'message', mayHaveBeenPaid: false, answeredInput: 1200 }] }), 1100, 'a refused attempt: not billed');
  const side = readSide([{ ...base, stopReason: 'answered', solved: true, retried: [{ reason: timeout, call: 'message', mayHaveBeenPaid: true, answeredInput: 1200 }] }], 'bound');
  assert.equal(side.capped, 1, 'a FINISHED run with a possibly-paid retry is part of the bound');
});

test('claim A holds in the first reading and fails in the second: "No decision", and both readings are printed', () => {
  // Set-up 3: 146 right and finished at 600 tokens, and 4 interrupted runs with no transcript. Set-up P: 140 right of 150 at 1,000.
  const { rows, plan } = batch({ tokens3: 600, tokensP: 1000, right3: 146, rightP: 140 });
  unfinish(rows, 3, 4, { stopReason: 'interrupted', inputTokens: 0, outputTokens: 0, tokensKnown: false });
  const first = claim(rows, CLAIMS[0], QUESTIONS_GROUP, plan);
  const second = claim(rows, CLAIMS[0], QUESTIONS_GROUP, plan, { bound: true });
  assert.equal(first.holds, true);
  assert.equal(second.holds, false);
  const sentence = decision2(rows, undefined, plan);
  assert.match(sentence, /^No decision: claim A on the questions holds in the first reading and fails in the second.*First reading: on the 30 questions set-up 3 was right in 146 of 150 planned \(146 finished\).*Second reading: on the 30 questions/, sentence);
  const report = renderReport2(rows, { plan });
  assert.match(report, /\| the 30 questions, second reading \(a bound; withholds the decision if it fails where the first holds\) \|.*; 4 runs priced at their caps\) \|/);
  assert.match(report, /Left out, A on the 30 questions, second reading/);
  assert.match(report, /Unfinished runs whose tokens cannot be known at all \(no transcript\): 4\./);
  // Without the unknown runs the bound changes nothing and the decision is "Go on".
  const known = rows.map((r) => (r.tokensKnown === false ? { ...r, tokensKnown: true } : r));
  assert.match(decision2(known, undefined, plan), /^Go on/);
});

test('retried attempts are recorded by reason, with whether they may have been paid, and printed per set-up', async () => {
  const [timeout] = MAYBE_PAID_REASONS;
  const events = [
    { type: 'retry', call: 'count', reason: 'rate limited (429)' },
    { type: 'request', n: 1 }, { type: 'retry', call: 'message', reason: timeout }, { type: 'response', usage: { input_tokens: 1200, output_tokens: 5 } },
    { type: 'request', n: 2 }, { type: 'retry', call: 'message', reason: 'server error (529)' },
  ];
  assert.deepEqual(retriedFrom(events), [
    { reason: 'rate limited (429)', call: 'count', request: 1, mayHaveBeenPaid: false, answeredInput: null },
    { reason: timeout, call: 'message', request: 1, mayHaveBeenPaid: true, answeredInput: 1200 },
    { reason: 'server error (529)', call: 'message', request: 2, mayHaveBeenPaid: false, answeredInput: null },
  ]);
  // Through the agent: a model port that retries once on a client timeout, then answers.
  const question = /** @type {any} */ (loadQuestions().find((x) => x.id === 'run-weight'));
  const model = {
    name: 'retrying', countTokens: async () => 1,
    nextMessage: async (_request, hooks) => {
      hooks?.onRetry?.({ attempt: 1, of: 4, reason: timeout, waitMs: 0, message: 'timed out' });
      return { content: [{ type: 'tool_use', id: 'a', name: 'answer', input: { answer: 70.8 } }], stop_reason: 'tool_use', usage: { input_tokens: 1500, output_tokens: 9 } };
    },
  };
  const work = await createWorkdir(null);
  try {
    const counts = await runAgent({ model, setup: 3, task: question, workdir: work.dir, system: SYSTEM_PROMPT_2 });
    assert.deepEqual(counts.retried, [{ reason: timeout, call: 'message', request: 1, mayHaveBeenPaid: true, answeredInput: 1500 }]);
    assert.equal(counts.retries, 1);
  } finally {
    removeWorkdir(work.dir);
  }
  const { rows, plan } = batch({ tokens3: 600, tokensP: 1000, right3: 150, rightP: 140 });
  rows[0].retried = [{ reason: timeout, call: 'message', request: 1, mayHaveBeenPaid: true, answeredInput: 600 }];
  const report = renderReport2(rows, { plan });
  assert.match(report, /## Retried attempts, by reason/);
  assert.match(report, new RegExp(`\\| set-up 3 \\| ${timeout} \\| a model request \\| 1 \\| yes \\|`));
});
