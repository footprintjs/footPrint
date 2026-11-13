/**
 * Model-edited code runs confined, and the judge cannot be fooled.
 *
 * Every test here starts REAL child processes through the same doors the
 * agent's tools and the scorer use. A working copy is edited to try what an
 * agent's edit could try: read the benchmark folder (the hidden expected
 * results, a canary), read a canary elsewhere under the temp folder, write
 * outside its folder, start a process or a worker, and fake a passing score.
 */
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { loadFault } from '../faults/apply.mjs';
import { confinementArgs, permissionFlag, runNode } from '../harness/child.mjs';
import { BENCH_DIR, ensureRuntime } from '../harness/runtime.mjs';
import { judgeCopy, scoreRun } from '../harness/score.mjs';
import { createWorkdir, removeWorkdir } from '../harness/workdir.mjs';
import { SETUPS, callTool } from '../tools/index.mjs';

const BENCH_CANARY = join(BENCH_DIR, `.canary-${process.pid}`);
const EXPECTED = join(BENCH_DIR, 'hidden', 'expected.json');
let outside;
let outsideCanary;
before(async () => {
  writeFileSync(BENCH_CANARY, 'bench-canary-91c2\n');
  outside = (await createWorkdir(null, { prefix: 'agent-debug-outside-' })).dir;
  outsideCanary = join(outside, 'canary.txt');
  writeFileSync(outsideCanary, 'temp-canary-5d0a\n');
});
after(() => {
  rmSync(BENCH_CANARY, { force: true });
  removeWorkdir(outside);
});

/** Code that tries every escape and prints what it got. */
function attempts(writeTarget) {
  return `
import * as __fs from 'node:fs';
import * as __cp from 'node:child_process';
import * as __wt from 'node:worker_threads';
const __try = (name, fn) => { try { const v = fn(); console.log('ESCAPED ' + name + ' ' + String(v).slice(0, 40)); } catch (e) { console.log('denied ' + name + ' ' + (e.code ?? e.message)); } };
__try('bench-canary', () => __fs.readFileSync(${JSON.stringify(BENCH_CANARY)}, 'utf8'));
__try('expected', () => __fs.readFileSync(${JSON.stringify(EXPECTED)}, 'utf8'));
__try('temp-canary', () => __fs.readFileSync(${JSON.stringify(outsideCanary)}, 'utf8'));
__try('home', () => __fs.readdirSync(${JSON.stringify(process.env.HOME ?? '/Users')}).length);
__try('write-outside', () => { __fs.writeFileSync(${JSON.stringify(writeTarget)}, 'x'); return 'written'; });
__try('spawn', () => __cp.execFileSync('/bin/echo', ['hi']).toString());
__try('worker', () => new __wt.Worker('1', { eval: true }));
__try('signal', () => { process.kill(process.ppid, 0); return 'sent'; });
// macOS itself sets __CF_USER_TEXT_ENCODING in every process; it carries no secret.
__try('env', () => Object.keys(process.env).filter((k) => !k.startsWith('__CF_')).join(',') || (() => { throw Object.assign(new Error(), { code: 'EMPTY' }); })());
`;
}

/** Puts `code` at the top of a file of the working copy. */
function prepend(dir, rel, code) {
  const file = join(dir, rel);
  writeFileSync(file, `${code}\n${readFileSync(file, 'utf8')}`);
}

test('this Node has a permission model, and children are refused without one', () => {
  assert.ok(permissionFlag(), 'the benchmark needs Node with --permission (24) or --experimental-permission (22)');
  assert.throws(() => confinementArgs({ read: ['relative/path'], write: [] }), /absolute/);
  return assert.rejects(runNode(['-e', '1'], /** @type {any} */ ({ cwd: outside })), /declare/);
});

for (const [door, run] of /** @type {const} */ ([
  ['run_order', (dir) => callTool(SETUPS[1], 'run_order', { fixture: 'small-pickup' }, { workdir: dir })],
  ['run_tests', (dir) => callTool(SETUPS[1], 'run_tests', {}, { workdir: dir })],
  ['why (record probe)', (dir) => callTool(SETUPS[3], 'why', { fixture: 'small-pickup', key: 'status' }, { workdir: dir })],
])) {
  test(`${door}: edited code cannot read the bench folder or the temp folder, write outside, or start a process`, async () => {
    const work = await createWorkdir(null);
    const target = join(outside, `written-by-${door.replace(/\W/g, '')}.txt`);
    try {
      // The step module is loaded by every door: the program, the tests and the probe.
      prepend(work.dir, 'src/steps/receive-order/index.mjs', attempts(target));
      const answer = await run(work.dir);
      // run_tests and why do not show stdout of the program; run the same code through run_order for the text.
      const shown = door === 'run_order' ? answer.content : (await callTool(SETUPS[1], 'run_order', { fixture: 'small-pickup' }, { workdir: work.dir })).content;
      assert.ok(!shown.includes('ESCAPED'), shown);
      for (const name of ['bench-canary', 'expected', 'temp-canary', 'home', 'write-outside', 'spawn', 'worker', 'signal', 'env']) {
        assert.match(shown, new RegExp(`denied ${name}`), name);
      }
      assert.ok(!shown.includes('bench-canary-91c2') && !shown.includes('temp-canary-5d0a'));
      assert.throws(() => readFileSync(target), /ENOENT/, 'nothing was written outside');
      if (door === 'why (record probe)') assert.match(answer.content, /status = "approved"/, 'the probe still works');
      if (door === 'run_tests') assert.match(answer.content, /8 passed, 0 failed/, 'the tests still run');
    } finally {
      removeWorkdir(work.dir);
    }
  });
}

test('the program still runs normally inside its confinement and may write in its own folder', async () => {
  const work = await createWorkdir(null);
  try {
    prepend(work.dir, 'src/run-order.mjs', "import { writeFileSync as __w } from 'node:fs';\n__w('note.txt', 'ok');");
    const r = await callTool(SETUPS[1], 'run_order', { fixture: 'small-pickup' }, { workdir: work.dir });
    assert.match(r.content, /exit code: 0/);
    assert.match(r.content, /"grandTotal": 6\.36/);
    assert.equal(readFileSync(join(work.dir, 'note.txt'), 'utf8'), 'ok');
  } finally {
    removeWorkdir(work.dir);
  }
});

test('the record probe may not write even in the working folder', async () => {
  const work = await createWorkdir(null);
  try {
    prepend(work.dir, 'src/steps/receive-order/index.mjs', "import { writeFileSync as __w } from 'node:fs';\ntry { __w(new URL('../../../probe-wrote.txt', import.meta.url), 'x'); } catch {}");
    await callTool(SETUPS[3], 'map', {}, { workdir: work.dir });
    assert.throws(() => readFileSync(join(work.dir, 'probe-wrote.txt')), /ENOENT/);
  } finally {
    removeWorkdir(work.dir);
  }
});

test('the runtime folder is private, fresh, and not writable by a child', async () => {
  const runtime = ensureRuntime();
  assert.match(runtime, /agent-debug-session-\d+-[A-Za-z0-9]{6}\/runtime-[A-Za-z0-9]{6}$/);
  const { statSync } = await import('node:fs');
  assert.equal(statSync(runtime).mode & 0o777, 0o700);
  const work = await createWorkdir(null);
  try {
    prepend(work.dir, 'src/run-order.mjs', `import { writeFileSync as __w } from 'node:fs';\ntry { __w(${JSON.stringify(join(runtime, 'deps', 'register.mjs'))}, '// replaced'); console.log('ESCAPED'); } catch (e) { console.log('denied runtime-write ' + e.code); }`);
    const r = await callTool(SETUPS[1], 'run_order', { fixture: 'small-pickup' }, { workdir: work.dir });
    assert.match(r.content, /denied runtime-write ERR_ACCESS_DENIED/);
    assert.ok(!readFileSync(join(runtime, 'deps', 'register.mjs'), 'utf8').includes('// replaced'));
  } finally {
    removeWorkdir(work.dir);
  }
});

const MARKER = '\\u0000agent-debug-scoring-results\\u0000';

test('scoring: a copy that prints a fake all-pass document and exits 0 is unsolved', async () => {
  const fault = loadFault('wrong-key-read');
  const work = await createWorkdir(fault);
  try {
    const names = Object.keys(JSON.parse(readFileSync(join(BENCH_DIR, 'hidden', 'orders.json'), 'utf8')));
    const fake = JSON.stringify({ results: Object.fromEntries(names.map((n) => [n, { pass: true }])) });
    prepend(work.dir, 'src/order-desk.mjs', `process.stdout.write('\\n${MARKER}\\n' + ${JSON.stringify(fake)} + '\\n'); process.exit(0);`);
    const score = await scoreRun(work.dir, work.manifest, fault);
    assert.equal(score.solved, false);
    assert.ok(score.wrongFixtures.length > 0);
  } finally {
    removeWorkdir(work.dir);
  }
});

test('scoring: a copy that patches console, stdout and process.exit is unsolved', async () => {
  const fault = loadFault('wrong-key-read');
  const work = await createWorkdir(fault);
  try {
    prepend(
      work.dir,
      'src/order-desk.mjs',
      `process.exit = () => {}; console.log = () => {}; const __write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => __write(String(chunk).replace(/"grandTotal":[0-9.]+/g, '"grandTotal":0'), ...rest);
process.on('exit', () => { process.exitCode = 0; });`,
    );
    const score = await scoreRun(work.dir, work.manifest, fault);
    assert.equal(score.solved, false);
  } finally {
    removeWorkdir(work.dir);
  }
});

test('scoring: a copy that tries to read the expected results is denied and unsolved', async () => {
  const fault = loadFault('wrong-key-read');
  const work = await createWorkdir(fault);
  try {
    prepend(work.dir, 'src/order-desk.mjs', `import { readFileSync as __r } from 'node:fs';\nlet __expected; try { __expected = JSON.parse(__r(${JSON.stringify(EXPECTED)}, 'utf8')); } catch {}\nif (__expected) { process.stdout.write('\\n${MARKER}\\n' + JSON.stringify({ results: __expected }) + '\\n'); process.exit(0); }`);
    const judged = await judgeCopy(work.dir);
    assert.equal(judged.passed, false);
    const score = await scoreRun(work.dir, work.manifest, fault);
    assert.equal(score.solved, false);
  } finally {
    removeWorkdir(work.dir);
  }
});

test('scoring: the reverse edit is solved, and a change outside src/ is not', async () => {
  const fault = loadFault('wrong-key-read');
  const work = await createWorkdir(fault);
  try {
    const file = join(work.dir, fault.file);
    writeFileSync(file, readFileSync(file, 'utf8').replace(fault.replace, fault.find));
    const score = await scoreRun(work.dir, work.manifest, fault);
    assert.equal(score.solved, true, JSON.stringify(score));
    assert.equal(score.editedFaultyFile, true);
    assert.ok(!('namedFaultyStep' in score), 'the column is gone (harness/score.mjs)');
    writeFileSync(join(work.dir, 'fixtures', 'extra.json'), '{}');
    const again = await scoreRun(work.dir, work.manifest, fault);
    assert.equal(again.solved, false);
    assert.deepEqual(again.changedOutsideSrc, ['fixtures/extra.json']);
  } finally {
    removeWorkdir(work.dir);
  }
});

test('scoring: an edit that special-cases the symptom fixture by name is unsolved', async () => {
  const fault = loadFault('wrong-key-read');
  const work = await createWorkdir(fault);
  try {
    // The fault stays; the named fixture's order gets its expected value by name.
    const file = join(work.dir, fault.file);
    const order = JSON.parse(readFileSync(join(work.dir, 'fixtures', `${fault.symptom.fixture}.json`), 'utf8')).order;
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        fault.replace,
        `${fault.replace}\n  if (scope.orderId === ${JSON.stringify(order.orderId)}) scope.grandTotal = ${JSON.stringify(fault.symptom.expected)};`,
      ),
    );
    const visible = await callTool(SETUPS[1], 'run_order', { fixture: fault.symptom.fixture }, { workdir: work.dir });
    assert.match(visible.content, new RegExp(`"grandTotal": ${fault.symptom.expected}`), 'the patch fixes the named fixture');
    const score = await scoreRun(work.dir, work.manifest, fault);
    assert.equal(score.solved, false);
    assert.ok(score.wrongFixtures.some((name) => name.startsWith('hidden-')), score.wrongFixtures.join(', '));
  } finally {
    removeWorkdir(work.dir);
  }
});
