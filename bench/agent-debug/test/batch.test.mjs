/**
 * RULE.md 1.3, "The model and the budget": a run the harness could not
 * finish is kept, counted in the spend, never run again, and left out of
 * the report's numbers (report.test.mjs).
 * - B2: a batch killed in the middle of a run keeps the run's transcript
 *   untouched, and the next start records the run as `interrupted` with the
 *   tokens its transcript holds, without asking the model again.
 * - An API failure after the retries ends a run as `error`, kept with its tokens.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadFault } from '../faults/apply.mjs';
import { readRuns, runBatch } from '../harness/batch.mjs';
import { spendOf } from '../harness/budget.mjs';
import { ModelError } from '../harness/model.mjs';
import { BENCH_DIR } from '../harness/runtime.mjs';
import { SESSION_PREFIX } from '../harness/temp.mjs';

const HELPER = join(BENCH_DIR, 'test', 'helpers', 'stop-batch.mjs');
const env = { PATH: process.env.PATH ?? '', ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) };

test('a killed run keeps its transcript and becomes interrupted, never run again', () => {
  const out = mkdtempSync(join(tmpdir(), 'agent-debug-batch-'));
  try {
    const killed = spawnSync(process.execPath, [HELPER, 'kill', out], { env, encoding: 'utf8' });
    assert.equal(killed.signal, 'SIGKILL');
    const transcript = join(out, 'transcripts', 'setup1-wrong-key-read-r1.jsonl');
    const before = readFileSync(transcript, 'utf8');
    assert.equal(before.split('\n').filter((l) => l.includes('"type":"response"')).length, 1);
    assert.deepEqual(readRuns(join(out, 'runs.jsonl')), []);
    assert.equal(readRuns(join(out, 'started.jsonl')).length, 1);

    const resumed = spawnSync(process.execPath, [HELPER, 'resume', out], { env, encoding: 'utf8' });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /interrupted earlier, kept with \d+ tokens, not run again/);
    assert.equal(readFileSync(transcript, 'utf8'), before, 'the transcript is never truncated or rewritten');
    const runs = readRuns(join(out, 'runs.jsonl'));
    assert.equal(runs.length, 1);
    const [row] = runs;
    assert.equal(row.stopReason, 'interrupted');
    assert.equal(row.solved, false);
    assert.equal(row.requests, 1);
    const usage = JSON.parse(before.split('\n').find((l) => l.includes('"type":"response"'))).usage;
    assert.equal(row.inputTokens, usage.input_tokens);
    assert.equal(row.outputTokens, usage.output_tokens);
    assert.ok(spendOf(runs) > 0, 'its tokens count in the spend');
    // A third start changes nothing.
    spawnSync(process.execPath, [HELPER, 'resume', out], { env, encoding: 'utf8' });
    assert.equal(readRuns(join(out, 'runs.jsonl')).length, 1);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the killed run\'s folders are swept by the next start, and only those of dead processes', () => {
  const out = mkdtempSync(join(tmpdir(), 'agent-debug-batch-'));
  try {
    const killed = spawnSync(process.execPath, [HELPER, 'kill', out], { env, encoding: 'utf8' });
    assert.equal(killed.signal, 'SIGKILL');
    const left = spawnSync('ls', [tmpdir()], { encoding: 'utf8' }).stdout.split('\n').filter((n) => n.startsWith(`${SESSION_PREFIX}${killed.pid}-`));
    assert.equal(left.length, 1, 'a SIGKILL leaves the session folder behind');
    spawnSync(process.execPath, [HELPER, 'resume', out], { env, encoding: 'utf8' });
    const after = spawnSync('ls', [tmpdir()], { encoding: 'utf8' }).stdout.split('\n').filter((n) => n.startsWith(`${SESSION_PREFIX}${killed.pid}-`));
    assert.deepEqual(after, [], 'the next start removed it');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('an API failure after the retries is an error run, kept with its tokens', async () => {
  const out = mkdtempSync(join(tmpdir(), 'agent-debug-batch-'));
  try {
    let calls = 0;
    const model = {
      name: 'failing',
      countTokens: async () => 1,
      nextMessage: async () => {
        calls++;
        if (calls === 1) return { content: [{ type: 'tool_use', id: 'a', name: 'list_files', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 7 } };
        throw new ModelError('server error (529): overloaded, after 4 retries');
      },
    };
    await runBatch({ out, setups: [2], faults: [loadFault('wrong-rule')], repeats: 1, modelFor: async () => model });
    const [row] = readRuns(join(out, 'runs.jsonl'));
    assert.equal(row.stopReason, 'error');
    assert.equal(row.solved, false);
    assert.match(row.error, /529/);
    assert.equal(row.inputTokens, 100);
    assert.equal(row.outputTokens, 7);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the sweep never removes a live process\'s folder or one it cannot attribute', async () => {
  const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
  const { sweepStale } = await import('../harness/temp.mjs');
  const live = mkdtempSync(join(tmpdir(), `${SESSION_PREFIX}${process.ppid}-`));
  const anonymous = mkdtempSync(join(tmpdir(), `${SESSION_PREFIX}0-`));
  try {
    writeFileSync(join(live, 'owner.json'), JSON.stringify({ pid: process.ppid }));
    mkdirSync(join(anonymous, 'run-x'));
    sweepStale();
    assert.ok(existsSync(live), 'a live owner keeps its folder');
    assert.ok(existsSync(anonymous), 'no owner.json, no removal');
  } finally {
    rmSync(live, { recursive: true, force: true });
    rmSync(anonymous, { recursive: true, force: true });
  }
});
