/**
 * A later batch's report names each earlier part 2 batch kept beside it,
 * with its decision line (RULE-2.md, "What decides"; the fifth fairness
 * reading, harness/siblings.mjs). Two batch folders side by side name each
 * other; a smoke batch, a rehearsal and a part 1 batch beside them are not
 * listed; a batch alone says so.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SCRIPTED_MODEL } from '../harness/model.mjs';
import { decisionOf, writeReport2 } from '../harness/report2.mjs';
import { otherBatches } from '../harness/siblings.mjs';
import { unfinishedRow } from '../harness/rows.mjs';

const KINDS = ['program', 'run', 'why'];

/**
 * Writes a batch folder as the harness leaves it: order.json, started.jsonl (with `at`), runs.jsonl.
 * @param {string} dir @param {{ tokens3: number, model?: string, label?: string, part1?: boolean, at: number, lose3?: boolean }} o
 */
function writeBatch(dir, { tokens3, model = 'm', label = 'batch', part1 = false, at, lose3 = false }) {
  mkdirSync(join(dir, 'transcripts'), { recursive: true });
  const rows = [];
  for (let q = 0; q < 30; q++) {
    for (let repeat = 1; repeat <= 2; repeat++) {
      for (const setup of [3, 'P']) {
        rows.push({ setup, task: `q${q}`, taskType: 'question', kind: KINDS[q % 3], repeat, solved: true, stopReason: 'answered', inputTokens: setup === 3 ? tokens3 : 1000, outputTokens: 0, newTokens: 0, resentTokens: 0, requests: 3, requestsWithoutUsage: 0, retried: [], model, transcript: `transcripts/setup${setup}-q${q}-r${repeat}.jsonl` });
      }
    }
  }
  if (lose3) rows[0] = unfinishedRow({ setup: 3, task: 'q0', taskType: 'question', repeat: 1, model, transcript: rows[0].transcript }, { type: 'question', kind: 'program' }, null);
  const plan = rows.map(({ setup, task, repeat }) => ({ setup, task, repeat }));
  const order = { label, seed: 1, setups: [3, 'P'], faults: [], ...(part1 ? {} : { questions: [...new Set(rows.map((r) => r.task))] }), repeats: 2, code: { commit: null, uncommittedChanges: null }, plan };
  writeFileSync(join(dir, 'order.json'), `${JSON.stringify(order)}\n`);
  writeFileSync(join(dir, 'started.jsonl'), rows.map((r, i) => JSON.stringify({ setup: r.setup, task: r.task, repeat: r.repeat, model, transcript: r.transcript, at: at + i })).join('\n') + '\n');
  writeFileSync(join(dir, 'runs.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

test('two batch folders side by side name each other with their start and decision line; smoke, rehearsal and part 1 folders are not listed', () => {
  const parent = mkdtempSync(join(tmpdir(), 'agent-debug-siblings-'));
  try {
    const one = join(parent, 'part2-batch-1');
    const two = join(parent, 'part2-batch-2');
    writeBatch(one, { tokens3: 1000, at: Date.UTC(2026, 10, 14, 9) }); // set-up 3 no cheaper: "Stop and look"
    writeBatch(two, { tokens3: 600, at: Date.UTC(2026, 10, 15, 9) }); // "Go on"
    writeBatch(join(parent, 'part2-smoke'), { tokens3: 600, label: 'smoke', at: Date.UTC(2026, 10, 13, 9) });
    writeBatch(join(parent, 'part2-rehearsal'), { tokens3: 600, model: SCRIPTED_MODEL, at: Date.UTC(2026, 10, 13, 10) });
    writeBatch(join(parent, 'part1-batch'), { tokens3: 600, part1: true, at: Date.UTC(2026, 10, 12, 9) });
    mkdirSync(join(parent, 'not-a-batch'));
    const reportOne = writeReport2(one);
    const reportTwo = writeReport2(two);
    assert.match(decisionOf(one).line, /^Stop and look/);
    assert.match(decisionOf(two).line, /^Go on/);
    assert.ok(reportTwo.includes(`- \`part2-batch-1\`, started 2026-11-14T09:00:00.000Z: ${decisionOf(one).line}\n`), 'the later report names the earlier batch');
    assert.ok(reportOne.includes(`- \`part2-batch-2\`, started 2026-11-15T09:00:00.000Z: ${decisionOf(two).line}\n`), 'and the earlier one, rewritten, names the later');
    assert.ok(reportTwo.includes("This batch's first run started 2026-11-15T09:00:00.000Z."));
    for (const report of [reportOne, reportTwo]) {
      assert.ok(report.includes('## Other batches of part 2 beside this one'));
      for (const name of ['part2-smoke', 'part2-rehearsal', 'part1-batch', 'not-a-batch']) assert.ok(!report.includes(`\`${name}\``), name);
      assert.ok(!report.includes('No earlier batch was found'));
    }
    assert.deepEqual(otherBatches(two, () => 'd').map((b) => b.name), ['part2-batch-1']);
    // A withheld earlier batch is listed with what its rows give without the guard.
    const three = join(parent, 'part2-batch-3');
    writeBatch(three, { tokens3: 1000, at: Date.UTC(2026, 10, 16, 9), lose3: true });
    const later = writeReport2(join(parent, 'part2-batch-2'));
    assert.match(later, /- `part2-batch-3`, started 2026-11-16T09:00:00\.000Z: No decision: the transcript of 1 run of set-up 3 is missing[^\n]*\(Without this guard the rows give: Stop and look: /);
    assert.ok(later.indexOf('`part2-batch-1`') < later.indexOf('`part2-batch-3`'), 'by start time');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('a batch alone says no earlier batch was found; a smoke batch\'s report has no such section', () => {
  const parent = mkdtempSync(join(tmpdir(), 'agent-debug-siblings-'));
  try {
    const alone = join(parent, 'alone');
    writeBatch(alone, { tokens3: 600, at: Date.UTC(2026, 10, 14, 9) });
    writeBatch(join(parent, 'smoke'), { tokens3: 600, label: 'smoke', at: Date.UTC(2026, 10, 13, 9) });
    const smoke = writeReport2(join(parent, 'smoke'));
    assert.match(smoke, /No decision: a smoke batch is not part of the result/);
    assert.ok(!smoke.includes('## Other batches of part 2') && !smoke.includes('`alone`'), 'a smoke batch names no other batch');
    assert.match(writeReport2(alone), /## Other batches of part 2 beside this one[^\n]*\n\n[^\n]*\n\nNo earlier batch was found beside this one\.\n/);
    mkdirSync(join(parent, 'broken'));
    writeFileSync(join(parent, 'broken', 'order.json'), '{ cut');
    assert.match(writeReport2(alone), /- `broken`, start not known \(no run started\): its order\.json cannot be read, so whether it is a part 2 batch is not known\./);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
