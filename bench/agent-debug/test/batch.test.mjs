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

test('a SIGTERM removes the session folder on the way out, and the run is interrupted on the next start', () => {
  const out = mkdtempSync(join(tmpdir(), 'agent-debug-batch-'));
  try {
    const stopped = spawnSync(process.execPath, [HELPER, 'term', out], { env, encoding: 'utf8' });
    assert.equal(stopped.status, 143);
    const left = spawnSync('ls', [tmpdir()], { encoding: 'utf8' }).stdout.split('\n').filter((n) => n.startsWith(`${SESSION_PREFIX}${stopped.pid}-`));
    assert.deepEqual(left, [], 'nothing left behind');
    const resumed = spawnSync(process.execPath, [HELPER, 'resume', out], { env, encoding: 'utf8' });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(readRuns(join(out, 'runs.jsonl'))[0].stopReason, 'interrupted');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('a batch folder is locked: a second start refuses while the owner lives, a dead owner\'s lock is taken over and logged', async () => {
  const { lockBatch } = await import('../harness/batch.mjs');
  const { writeFileSync, existsSync } = await import('node:fs');
  const out = mkdtempSync(join(tmpdir(), 'agent-debug-batch-'));
  try {
    writeFileSync(join(out, 'lock.json'), JSON.stringify({ pid: process.ppid }));
    await assert.rejects(
      runBatch({ out, setups: [1], faults: [loadFault('wrong-rule')], repeats: 1, modelFor: async () => assert.fail('must not start') }),
      new RegExp(`locked by process ${process.ppid}, which is still running`),
    );
    const said = [];
    writeFileSync(join(out, 'lock.json'), JSON.stringify({ pid: 2 ** 22 + 12345 }));
    const release = lockBatch(out, (line) => said.push(line));
    assert.match(said[0], /took over the lock of process 4206649, which is no longer running/);
    assert.match(readFileSync(join(out, 'lock.jsonl'), 'utf8'), /took over a lock of a dead process/);
    assert.throws(() => lockBatch(out), /locked by process/);
    release();
    assert.equal(existsSync(join(out, 'lock.json')), false);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('two batches started on one folder at once: one runs, the other refuses; no row twice', async () => {
  const out = mkdtempSync(join(tmpdir(), 'agent-debug-batch-'));
  try {
    const cli = join(BENCH_DIR, 'harness', 'run.mjs');
    const args = ['--disable-sigusr1', cli, '--rehearse', '--faults', 'wrong-key-read,wrong-rule', '--setups', '1,3', '--repeats', '2', '--out', out];
    const { spawn } = await import('node:child_process');
    const start = () => new Promise((resolve) => {
      const c = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      c.stderr.on('data', (d) => (err += d));
      c.on('exit', (code) => resolve({ code, err }));
    });
    const [a, b] = await Promise.all([start(), start()]);
    const codes = [a.code, b.code].sort();
    assert.equal(codes[0], 0);
    assert.notEqual(codes[1], 0, 'the second start refused');
    assert.match(a.err + b.err, /locked by process \d+/);
    const runs = readRuns(join(out, 'runs.jsonl'));
    assert.equal(runs.length, 8);
    assert.equal(new Set(runs.map((r) => `${r.setup}/${r.fault}/${r.repeat}`)).size, 8);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
