/**
 * RULE.md 1.4, rule 8, and the reader's R2-B1, with real processes.
 * - The agent's code cannot signal another process through
 *   `process._debugProcess` (the reader's attack4) or signal the harness
 *   (attack3): the guard refuses it before the copy's code runs.
 * - A harness started with `--disable-sigusr1` neither opens its debugger nor
 *   dies when it receives SIGUSR1; without the flag Node tries to open it.
 * - `run.mjs` refuses to start a batch without the flag.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { BENCH_DIR } from '../harness/runtime.mjs';
import { createWorkdir, removeWorkdir } from '../harness/workdir.mjs';
import { SETUPS, callTool } from '../tools/index.mjs';

/** Replaces the working copy's run-order.mjs with `code` and runs it through run_order. */
async function runAsAgent(code, extra = () => {}) {
  const work = await createWorkdir(null);
  try {
    writeFileSync(join(work.dir, 'src', 'run-order.mjs'), code);
    extra(work.dir);
    return (await callTool(SETUPS[1], 'run_order', { fixture: 'small-pickup' }, { workdir: work.dir })).content;
  } finally {
    removeWorkdir(work.dir);
  }
}

test('attack4: _debugProcess cannot end another program', async () => {
  const victim = spawn('/bin/sleep', ['30']);
  let ended = null;
  victim.on('exit', (code, signal) => {
    ended = signal ?? code;
  });
  try {
    const answer = await runAsAgent(
      "import { readFileSync } from 'node:fs';\nconst pid = Number(readFileSync('victim.pid', 'utf8'));\ntry { process._debugProcess(pid); console.log('SENT'); } catch (e) { console.log('refused ' + e.code); }\n",
      (dir) => writeFileSync(join(dir, 'victim.pid'), String(victim.pid)),
    );
    assert.match(answer, /refused ERR_ACCESS_DENIED/);
    assert.ok(!answer.includes('SENT'));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ended, null, 'the other program is still running');
  } finally {
    victim.kill();
  }
});

test('attack3: the agent\'s code cannot signal the harness by any locked door', async () => {
  const answer = await runAsAgent(`const out = {};
for (const [name, fn] of [
  ['kill', () => process.kill(process.ppid, 0)],
  ['_kill', () => process._kill(process.ppid, 0)],
  ['_debugProcess', () => process._debugProcess(process.ppid)],
  ['binding', () => process.binding('os')],
  ['_linkedBinding', () => process._linkedBinding('x')],
]) { try { fn(); out[name] = 'ALLOWED'; } catch (e) { out[name] = e.code; } }
console.log(JSON.stringify(out));
`);
  const out = JSON.parse(answer.split('\n').find((l) => l.startsWith('{"kill"')));
  assert.deepEqual(out, { kill: 'ERR_ACCESS_DENIED', _kill: 'ERR_ACCESS_DENIED', _debugProcess: 'ERR_ACCESS_DENIED', binding: 'ERR_ACCESS_DENIED', _linkedBinding: 'ERR_ACCESS_DENIED' });
  assert.ok(!answer.includes('Starting inspector'));
});

/** Starts the stand-in harness, sends it SIGUSR1 once it is ready, and collects what happens. */
function signalTarget(flags) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...flags, join(BENCH_DIR, 'test', 'helpers', 'sigusr1-target.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      if (stdout.startsWith('ready') && !child.signalled) {
        child.signalled = true;
        child.kill('SIGUSR1');
      }
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('with --disable-sigusr1 the harness neither opens a debugger nor dies on SIGUSR1', async () => {
  const guarded = await signalTarget(['--disable-sigusr1']);
  assert.equal(guarded.code, 0, guarded.stderr);
  assert.equal(guarded.signal, null);
  assert.equal(guarded.stdout, 'ready\nalive\n');
  assert.ok(!/inspector|Debugger/i.test(guarded.stderr), guarded.stderr);
  const open = await signalTarget([]);
  assert.match(open.stderr, /Starting inspector on 127\.0\.0\.1:9229|Debugger listening/, 'without the flag Node tries to open its debugger');
});

test('run.mjs refuses to start a batch without --disable-sigusr1', () => {
  const r = spawnSync(process.execPath, [join(BENCH_DIR, 'harness', 'run.mjs'), '--rehearse', '--out', BENCH_DIR], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Start the harness with node --disable-sigusr1 harness\/run\.mjs/);
  assert.equal(r.stdout, '');
  assert.ok(readFileSync(join(BENCH_DIR, 'harness', 'run.mjs'), 'utf8').includes('sigusr1Check()'));
});

test('R3-1: a start that switches the flag off again is refused, in each of the reader\'s three forms', () => {
  const cli = join(BENCH_DIR, 'harness', 'run.mjs');
  const base = { PATH: process.env.PATH ?? '' };
  const starts = [
    { args: ['--disable-sigusr1', '--no-disable-sigusr1', cli], env: base },
    { args: ['--no-disable-sigusr1', cli], env: { ...base, NODE_OPTIONS: '--disable-sigusr1' } },
    { args: [cli], env: { ...base, NODE_OPTIONS: '--disable-sigusr1 --no-disable-sigusr1' } },
  ];
  for (const { args, env } of starts) {
    const r = spawnSync(process.execPath, [...args, '--rehearse', '--smoke', '--out', BENCH_DIR], { encoding: 'utf8', env });
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.match(r.stderr, /another option names sigusr1 \(--no-disable-sigusr1\)/);
    assert.equal(r.stdout, '');
  }
});
