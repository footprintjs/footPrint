/**
 * RULE.md 1.5: the smoke batch's pass, answered from the batch folder's own
 * files (harness/smoke-check.mjs), and order.json's installed versions.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import Anthropic from '@anthropic-ai/sdk';

import { loadFault } from '../faults/apply.mjs';
import { readRuns, runBatch } from '../harness/batch.mjs';
import { anthropicModel, scriptedModel } from '../harness/model.mjs';
import { renderReport } from '../harness/report.mjs';
import { solver } from '../harness/scripts.mjs';
import { smokeChecklist } from '../harness/smoke-check.mjs';

const fault = loadFault('wrong-key-read');

/** A stand-in SDK client: a 529 once, then a `done` answer carrying full usage, thinking included. */
function fakeClient() {
  let calls = 0;
  return {
    messages: {
      countTokens: async () => ({ input_tokens: 1 }),
      create: async () => {
        calls++;
        if (calls === 1) throw Anthropic.APIError.generate(529, { type: 'error', error: { type: 'overloaded_error' } }, 'overloaded', new Headers());
        return {
          content: [{ type: 'tool_use', id: `d${calls}`, name: 'done', input: { summary: 'grand-total' } }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 1200, output_tokens: 300, output_tokens_details: { thinking_tokens: 250 } },
        };
      },
    },
  };
}

test('a smoke batch whose responses carry full usage passes every line but the clean tree, which it reports as found', async () => {
  const out = mkdtempSync(join(tmpdir(), 'agent-debug-smoke-'));
  try {
    await runBatch({
      out, setups: [1, 2, 3], faults: [fault], repeats: 1, label: 'smoke',
      modelFor: () => anthropicModel({ client: fakeClient(), sleep: async () => {} }),
    });
    const order = JSON.parse(readFileSync(join(out, 'order.json'), 'utf8'));
    assert.deepEqual(order.versions, { footprintjs: '12.1.0', foottrace: '1.14.0' });
    const lines = smokeChecklist(out);
    assert.equal(lines.length, 5);
    assert.match(lines[0], /^- every response carried the usage numbers, thinking included: yes \(3 of 3 responses carried input and output tokens; 3 of 3 carried thinking tokens\)$/);
    assert.match(lines[1], /^- no run ended at the output limit: yes \(0 of 3 runs ended at max_tokens\)$/);
    assert.match(lines[2], /^- every retry is in its transcript: yes \(3 retries counted by the runs, 3 retry lines in the transcripts\)$/);
    assert.match(lines[3], new RegExp(`^- the commit, a clean tree and the footprintjs version are recorded: ${order.code.uncommittedChanges ? 'no' : 'yes'} \\(commit [0-9a-f]{40}, uncommitted changes ${order.code.uncommittedChanges}, footprintjs 12\\.1\\.0, foottrace 1\\.14\\.0\\)$`));
    assert.match(lines[4], /^- the spend equals the sum of the usage in the transcripts: yes \(runs\.jsonl 3600 in \+ 900 out = 0\.000810 dollars; transcripts 3600 in \+ 900 out = 0\.000810 dollars\)$/);
    const md = renderReport(readRuns(join(out, 'runs.jsonl')), { plan: order.plan, smoke: true, checklist: lines });
    assert.match(md, /## The smoke batch's pass \(RULE\.md 1\.5\)\n\n.*\n\n- every response carried/);
    // A row whose tokens disagree with its transcript, and a retry line nobody counted, turn their lines to "no".
    const rows = readRuns(join(out, 'runs.jsonl'));
    rows[0].outputTokens += 1;
    writeFileSync(join(out, 'runs.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    writeFileSync(join(out, rows[1].transcript), `${readFileSync(join(out, rows[1].transcript), 'utf8')}${JSON.stringify({ type: 'retry' })}\n`);
    const after = smokeChecklist(out);
    assert.match(after[2], /: no \(3 retries counted by the runs, 4 retry lines/);
    assert.match(after[4], /: no \(runs\.jsonl 3600 in \+ 901 out/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the scripted rehearsal reports what it lacks: no thinking tokens', async () => {
  const out = mkdtempSync(join(tmpdir(), 'agent-debug-smoke-'));
  try {
    await runBatch({ out, setups: [1], faults: [fault], repeats: 1, label: 'smoke', modelFor: async () => scriptedModel(solver(fault, 1)) });
    const [usage, limit] = smokeChecklist(out);
    assert.match(usage, /: no \(\d+ of (\d+) responses carried input and output tokens; 0 of \1 carried thinking tokens\)/);
    assert.match(limit, /: yes/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
