/**
 * The report, from a fixed `runs.jsonl` (test/fixtures/runs.jsonl), and the
 * RULE's decision in each of its three outcomes.
 *
 * The fixture: set-up 1 solves 2 of 3 data-flow runs with 300,000 tokens in
 * all (150,000 per solved task); set-up 3 solves 3 of 3 with 120,000
 * (40,000 per solved task); on the controls both solve 1 of 2.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { readRuns } from '../harness/batch.mjs';
import { decision, renderReport, summarize } from '../harness/report.mjs';
import { BENCH_DIR } from '../harness/runtime.mjs';

const runs = readRuns(join(BENCH_DIR, 'test', 'fixtures', 'runs.jsonl'));

test('tokens per solved task counts every run and divides by the solved ones', () => {
  const one = summarize(runs.filter((r) => r.setup === 1 && r.faultClass === 'data-flow'));
  assert.deepEqual([one.runs, one.solved, one.tokens, one.tokensPerSolved], [3, 2, 300_000, 150_000]);
  const three = summarize(runs.filter((r) => r.setup === 3 && r.faultClass === 'data-flow'));
  assert.equal(three.tokensPerSolved, 40_000);
  assert.equal(summarize([]).tokensPerSolved, null);
});

test('the report holds the table, the distance bands and the decision', () => {
  const md = renderReport(runs, { title: 'fixed' });
  assert.match(md, /^# fixed/);
  assert.match(md, /\| 1 \| 7 data-flow \| 3 \| 2 \| 300,000 \| 150,000 \|/);
  assert.match(md, /\| 3 \| 7 data-flow \| 3 \| 3 \| 120,000 \| 40,000 \|/);
  assert.match(md, /\| 1 \| 5 or more \| 1 \| 0 \| none solved \|/);
  assert.match(md, /Go on to the full study: .* set-up 3 solved 3 runs against set-up 1's 2 \(73% fewer tokens per solved task\)/);
});

const sum = (solved, tokensPerSolved) => ({ solved, tokensPerSolved });

test('the decision: go on, stop and look, void', () => {
  assert.match(decision({ 1: { dataFlow: sum(5, 100), controls: sum(3, 1) }, 3: { dataFlow: sum(5, 75), controls: sum(4, 1) } }), /^Go on/);
  assert.match(decision({ 1: { dataFlow: sum(5, 100), controls: sum(3, 1) }, 3: { dataFlow: sum(5, 76), controls: sum(3, 1) } }), /^Stop and look: .*not at least 25% cheaper/);
  assert.match(decision({ 1: { dataFlow: sum(6, 100), controls: sum(3, 1) }, 3: { dataFlow: sum(5, 10), controls: sum(3, 1) } }), /^Stop and look: .*it solved fewer/);
  assert.match(decision({ 1: { dataFlow: sum(5, 100), controls: sum(1, 1) }, 3: { dataFlow: sum(7, 10), controls: sum(3, 1) } }), /^Void/);
  assert.match(decision({ 1: { dataFlow: sum(0, null), controls: sum(0, null) }, 3: { dataFlow: sum(1, 50), controls: sum(0, null) } }), /^Go on/);
  assert.match(decision({ 1: { dataFlow: sum(0, null), controls: sum(0, null) } }), /^No decision/);
});
