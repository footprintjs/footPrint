/**
 * The loop, the budget, the working folder, the batch and the command line,
 * with the scripted model (nothing here calls a model).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadFault, loadFaults } from '../faults/apply.mjs';
import { runAgent } from '../harness/agent.mjs';
import { readRuns, runBatch, runOrder } from '../harness/batch.mjs';
import { costOf, LIMITS, PRICES, SPEND_STOP_DOLLARS, spendStopReached } from '../harness/budget.mjs';
import { ModelError, scriptedModel } from '../harness/model.mjs';
import { REMINDER, SYSTEM_PROMPT, taskText } from '../harness/prompt.mjs';
import { BENCH_DIR } from '../harness/runtime.mjs';
import { scoreRun } from '../harness/score.mjs';
import { idler, solver, talker, wrongFile } from '../harness/scripts.mjs';
import { createWorkdir, listFiles, PROGRAM_DIR, removeWorkdir } from '../harness/workdir.mjs';
import { SETUPS } from '../tools/index.mjs';

const fault = loadFault('wrong-default-branch');

async function withRun(model, setup, run, limits) {
  const work = await createWorkdir(fault);
  const events = [];
  try {
    const counts = await runAgent({ model, setup, fault, workdir: work.dir, log: (e) => events.push(e), ...(limits ? { limits } : {}) });
    return await run({ counts, events, work });
  } finally {
    removeWorkdir(work.dir);
  }
}

test('the RULE numbers live in budget.mjs', () => {
  assert.deepEqual({ ...LIMITS }, { maxRequests: 30, maxInputTokensPerRequest: 90_000, maxInputTokensPerRun: 400_000 });
  assert.deepEqual({ ...PRICES }, { inputDollarsPerMillion: 0.1, outputDollarsPerMillion: 0.5 });
  assert.equal(SPEND_STOP_DOLLARS, 15);
  assert.equal(costOf({ input_tokens: 1_000_000, output_tokens: 1_000_000 }), 0.6);
  assert.equal(spendStopReached(14.99), false);
  assert.equal(spendStopReached(15), true);
});

test('a script that reads the right file, reverses the edit and calls done is scored solved', async () => {
  for (const setup of [1, 2, 3]) {
    await withRun(scriptedModel(solver(fault, setup)), setup, async ({ counts, work, events }) => {
      assert.equal(counts.stopReason, 'done');
      const responses = events.filter((e) => e.type === 'response');
      const last = responses.at(-1);
      // The token counts are the sums of the API's own usage fields, input and output alike.
      assert.equal(counts.inputTokens, responses.reduce((sum, e) => sum + e.usage.input_tokens, 0));
      assert.equal(counts.outputTokens, responses.reduce((sum, e) => sum + e.usage.output_tokens, 0));
      assert.ok(counts.outputTokens > 0);
      assert.equal(counts.finalContextTokens, last.usage.input_tokens + last.usage.output_tokens);
      assert.equal(counts.edits, 1);
      assert.ok(counts.readFileChars > 0);
      const score = await scoreRun(work.dir, work.manifest, fault, counts.doneSummary);
      assert.equal(score.solved, true, JSON.stringify(score));
      assert.equal(score.namedFaultyStep, true);
      assert.equal(score.editedFaultyFile, true);
    });
  }
});

test('a script that edits the wrong file is scored unsolved', async () => {
  await withRun(scriptedModel(wrongFile(fault)), 1, async ({ counts, work }) => {
    assert.equal(counts.stopReason, 'done');
    const score = await scoreRun(work.dir, work.manifest, fault, counts.doneSummary);
    assert.equal(score.solved, false);
    assert.equal(score.editedFaultyFile, false);
    assert.deepEqual(score.editedFiles, ['src/steps/net-amount/index.mjs']);
  });
});

test('a script that never calls done runs out of requests', async () => {
  await withRun(scriptedModel(idler()), 1, async ({ counts, work }) => {
    assert.equal(counts.stopReason, 'max_requests');
    assert.equal(counts.requests, 30);
    assert.equal((await scoreRun(work.dir, work.manifest, fault)).solved, false);
  });
});

test('end_turn without done gets one reminder, then the run ends', async () => {
  await withRun(scriptedModel(talker()), 1, async ({ counts, events }) => {
    assert.equal(counts.stopReason, 'end_turn_without_done');
    assert.equal(counts.requests, 2);
    assert.equal(events.filter((e) => e.type === 'reminder').length, 1);
  });
});

test('every tool call of one message is answered in ONE user message', async () => {
  const seen = [];
  const model = {
    name: 'probe',
    countTokens: async () => 1,
    nextMessage: async ({ messages }) => {
      seen.push(structuredClone(messages));
      if (seen.length === 1) {
        return {
          content: [
            { type: 'tool_use', id: 'a', name: 'list_files', input: {} },
            { type: 'tool_use', id: 'b', name: 'read_file', input: { path: '../escape' } },
            { type: 'tool_use', id: 'c', name: 'map', input: {} },
          ],
          stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 },
        };
      }
      return { content: [{ type: 'tool_use', id: 'd', name: 'done', input: { summary: 'x' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } };
    },
  };
  await withRun(model, 1, async ({ counts }) => {
    const second = seen[1];
    const last = second[second.length - 1];
    assert.equal(last.role, 'user');
    assert.deepEqual(last.content.map((b) => b.tool_use_id), ['a', 'b', 'c']);
    assert.equal(last.content[1].is_error, true);
    assert.equal(last.content[2].is_error, true, 'map is not a set-up 1 tool');
    assert.equal(counts.toolErrors, 2);
    assert.equal(counts.stopReason, 'done');
  });
});

test('max_tokens, refusal, an unknown stop and a model error end the run with their reason', async () => {
  for (const stop of ['max_tokens', 'refusal', 'model_context_window_exceeded']) {
    const model = scriptedModel(() => ({ content: [{ type: 'tool_use', id: 'z', name: 'done', input: { summary: 'cut' } }], stop_reason: stop }));
    await withRun(model, 1, async ({ counts, events }) => {
      assert.equal(counts.stopReason, stop);
      assert.equal(events.filter((e) => e.type === 'tool').length, 0, 'a cut message runs no tool');
    });
  }
  const failing = { name: 'f', countTokens: async () => 1, nextMessage: async () => { throw new ModelError('server error (529): overloaded'); } };
  await withRun(failing, 1, async ({ counts }) => {
    assert.equal(counts.stopReason, 'error');
    assert.equal(counts.error, 'server error (529): overloaded');
  });
});

test('the per-request and per-run token limits stop a run', async () => {
  await withRun(scriptedModel(idler()), 1, async ({ counts }) => assert.equal(counts.stopReason, 'request_too_large'), { ...LIMITS, maxInputTokensPerRequest: 100 });
  await withRun(scriptedModel(idler()), 1, async ({ counts }) => {
    assert.equal(counts.stopReason, 'run_input_tokens');
    assert.ok(counts.inputTokens >= 5000);
  }, { ...LIMITS, maxInputTokensPerRun: 5000 });
});

test('the exact count decides once the estimate is large', async () => {
  let asked = 0;
  const big = 'x'.repeat(200_000);
  const model = {
    name: 'count',
    countTokens: async () => { asked++; return 95_000; },
    nextMessage: async () => ({ content: [{ type: 'text', text: big }], stop_reason: 'end_turn', usage: { input_tokens: 70_000, output_tokens: 10 } }),
  };
  await withRun(model, 1, async ({ counts }) => {
    assert.equal(counts.stopReason, 'request_too_large');
    assert.equal(asked, 1);
  });
});

test('the working folder holds the program with one fault, and nothing else', async () => {
  const work = await createWorkdir(fault);
  try {
    const files = listFiles(work.dir);
    assert.deepEqual(files, listFiles(PROGRAM_DIR));
    for (const name of files) {
      assert.ok(!/hidden|faults|RULE|harness|expected|orders\.json|node_modules|\.test\.mjs$(?<!visible\.test\.mjs)/.test(name), name);
    }
    assert.ok(!existsSync(join(work.dir, 'node_modules')));
    const text = files.map((f) => readFileSync(join(work.dir, f), 'utf8')).join('\n');
    for (const f of loadFaults()) assert.ok(!text.includes(f.id), `the fault id ${f.id} appears in the working folder`);
    assert.ok(text.includes(fault.replace) && !text.includes(fault.find));
  } finally {
    removeWorkdir(work.dir);
  }
});

test('the task names no step and no file, and the system prompt is one text that lists no tool', () => {
  for (const f of loadFaults()) {
    const task = taskText(f);
    assert.ok(!task.includes(f.stepAddress) && !task.includes(f.file), f.id);
    assert.match(task, /^Order fixture `[a-z-]+` gives `\w+ = .+`\. It should be `.+`\. Find the cause and fix it\. You may edit files under `src\/` only\. When you are done, call `done` with one sentence naming the step you changed\.$/);
  }
  assert.ok(!/first|start with|prefer|best|should use/i.test(SYSTEM_PROMPT));
  // RULE 1.2, change 5: the prompt never repeats a tool's name or description.
  for (const t of SETUPS[3]) {
    assert.ok(!SYSTEM_PROMPT.includes(t.definition.name), t.definition.name);
    assert.ok(!SYSTEM_PROMPT.includes(t.definition.description.slice(0, 30)), t.definition.name);
  }
  assert.ok(!REMINDER.includes('why') && !REMINDER.includes('map'));
});

test('the run order is fixed by its seed, shuffled, and complete', () => {
  const a = runOrder([1, 2, 3], ['x', 'y'], 3, 7);
  assert.deepEqual(a, runOrder([1, 2, 3], ['x', 'y'], 3, 7));
  assert.equal(a.length, 18);
  assert.notDeepEqual(a, runOrder([1, 2, 3], ['x', 'y'], 3, 8));
  assert.equal(new Set(a.map((p) => `${p.setup}${p.fault}${p.repeat}`)).size, 18);
});

test('a batch writes its order first, appends one line per run, resumes, and honours the spend stop', async () => {
  const out = mkdtempSync(join(tmpdir(), 'agent-debug-batch-'));
  try {
    const faults = [fault];
    const r1 = await runBatch({ out, setups: [1], faults, repeats: 2, modelFor: async () => scriptedModel(solver(fault, 1)) });
    assert.equal(r1.stoppedBySpend, false);
    assert.ok(existsSync(join(out, 'order.json')));
    const runs = readRuns(join(out, 'runs.jsonl'));
    assert.equal(runs.length, 2);
    assert.ok(runs.every((r) => r.solved && r.stopReason === 'done'));
    assert.ok(runs.every((r) => r.finalContextTokens > 0 && r.inDecision === fault.inDecision && r.inDecision === true));
    for (const r of runs) assert.ok(readFileSync(join(out, r.transcript), 'utf8').includes('"type":"score"'));
    // Resuming runs nothing twice.
    await runBatch({ out, setups: [1], faults, repeats: 2, modelFor: async () => { throw new Error('must not be called'); } });
    assert.equal(readRuns(join(out, 'runs.jsonl')).length, 2);
    // A spend over the stop prevents the next run.
    const out2 = mkdtempSync(join(tmpdir(), 'agent-debug-batch-'));
    writeFileSync(join(out2, 'runs.jsonl'), `${JSON.stringify({ setup: 9, fault: 'x', repeat: 1, inputTokens: 150_000_000, outputTokens: 0 })}\n`);
    const r2 = await runBatch({ out: out2, setups: [1], faults, repeats: 1, modelFor: async () => { throw new Error('must not be called'); } });
    assert.equal(r2.stoppedBySpend, true);
    rmSync(out2, { recursive: true, force: true });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the command line refuses a paid run without a key, in one sentence, exit 1', () => {
  const env = { PATH: process.env.PATH ?? '' };
  const r = spawnSync(process.execPath, ['--disable-sigusr1', join(BENCH_DIR, 'harness', 'run.mjs'), '--out', tmpdir()], { env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim().split('\n').length, 1);
  assert.match(r.stderr, /ANTHROPIC_API_KEY/);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.trim(), 'The paid batch needs ANTHROPIC_API_KEY in the environment of this one command, and only that variable; or pass --rehearse.');
  assert.ok(!/env-file/.test(r.stderr));
  // It never reads a file to find a key: model.mjs reads no file at all, and
  // the one file run.mjs reads is the batch's own order.json.
  const model = readFileSync(join(BENCH_DIR, 'harness', 'model.mjs'), 'utf8');
  assert.ok(!/readFile|createReadStream|apiKey|\.env\b/.test(model.replace(/process\.env/g, '')));
  const run = readFileSync(join(BENCH_DIR, 'harness', 'run.mjs'), 'utf8');
  const reads = run.match(/readFileSync\([^)]*\)/g) ?? [];
  assert.deepEqual(reads, ["readFileSync(join(out, 'order.json')"]);
  assert.ok(!/createReadStream|apiKey|env-file/.test(run));
});

test('--smoke refuses --faults, --repeats and --setups, and runs wrong-key-read once per set-up', () => {
  const env = { PATH: process.env.PATH ?? '', ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) };
  const cli = join(BENCH_DIR, 'harness', 'run.mjs');
  for (const extra of [['--faults', 'wrong-rule'], ['--repeats', '1'], ['--setups', '1']]) {
    const r = spawnSync(process.execPath, ['--disable-sigusr1', cli, '--smoke', '--rehearse', '--out', tmpdir(), ...extra], { env, encoding: 'utf8' });
    assert.equal(r.status, 2, extra.join(' '));
    assert.match(r.stderr, /--smoke runs the fault wrong-key-read once in each set-up/);
  }
  const out = mkdtempSync(join(tmpdir(), 'agent-debug-smoke-'));
  try {
    const r = spawnSync(process.execPath, ['--disable-sigusr1', cli, '--smoke', '--rehearse', '--out', out], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const runs = readRuns(join(out, 'runs.jsonl'));
    assert.deepEqual(runs.map((x) => `${x.setup}/${x.fault}/${x.repeat}`).sort(), ['1/wrong-key-read/1', '2/wrong-key-read/1', '3/wrong-key-read/1']);
    assert.match(readFileSync(join(out, 'report.md'), 'utf8'), /^# agent-debug smoke batch, rehearsed: three runs of wrong-key-read, NOT part of the result/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
