/**
 * The agent's tools: the path jail, the edit rule, the child-process limits,
 * the bound on every answer, and errors that never throw.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { runNode } from '../harness/child.mjs';
import { createWorkdir, removeWorkdir } from '../harness/workdir.mjs';
import { SETUPS, callTool, toolsFor } from '../tools/index.mjs';
import { bounded } from '../tools/lib/answer.mjs';
import { resolveInside } from '../tools/lib/jail.mjs';

/** @type {{ dir: string }} */
let work;
/** A folder outside the working folder, holding a "secret". */
let outside;
before(async () => {
  work = await createWorkdir(null);
  outside = (await createWorkdir(null, { prefix: 'agent-debug-outside-' })).dir;
  writeFileSync(join(outside, 'secret.txt'), 'canary-7f3e answer\n');
  symlinkSync(outside, join(work.dir, 'src', 'link-out'));
  symlinkSync(join(outside, 'secret.txt'), join(work.dir, 'src', 'secret-link.mjs'));
  symlinkSync(join(work.dir, 'src', 'money.mjs'), join(work.dir, 'src', 'link-in.mjs'));
});
after(() => {
  removeWorkdir(work.dir);
  removeWorkdir(outside);
});

const all = SETUPS[3];
const here = () => ({ read: [work.dir], write: [] });
const call = (name, input) => callTool(all, name, input, { workdir: work.dir });

test('set-ups get exactly the tools RULE.md lists', () => {
  const names = (n) => toolsFor(n).map((t) => t.definition.name).sort();
  const base = ['done', 'edit_file', 'list_files', 'read_file', 'run_order', 'run_tests', 'search'];
  assert.deepEqual(names(1), [...base].sort());
  assert.deepEqual(names(2), [...base, 'map'].sort());
  assert.deepEqual(names(3), [...base, 'map', 'step', 'story', 'why'].sort());
  assert.throws(() => toolsFor(4));
});

test('every definition refuses unknown fields and states its bound', () => {
  for (const t of all) {
    assert.equal(t.definition.input_schema.additionalProperties, false, t.definition.name);
    assert.equal(t.definition.input_schema.type, 'object');
    assert.ok(t.definition.description.includes(`${t.LIMIT} characters`), `${t.definition.name} states ${t.LIMIT}`);
    assert.match(t.definition.name, /^[a-z_]+$/);
  }
});

test('the jail refuses every escape', () => {
  const escapes = [
    '', '   ', '../x', '../../etc/passwd', 'src/../../x', 'src/./../../x', '/etc/passwd', '~/x', 'src\\..\\x',
    'src/\0x', 'src/link-out/secret.txt', 'src/link-out', 'src/secret-link.mjs', 'src/link-in.mjs', '%2e%2e/x',
  ];
  for (const path of escapes) assert.throws(() => resolveInside(work.dir, path), undefined, JSON.stringify(path));
  assert.equal(resolveInside(work.dir, './src//chart.mjs').rel, 'src/chart.mjs');
});

test('file tools never read through a link or out of the folder', async () => {
  for (const path of ['../x', 'src/link-out/secret.txt', 'src/secret-link.mjs', '/etc/hosts', 'src']) {
    const r = await call('read_file', { path });
    assert.equal(r.is_error, true, path);
    assert.ok(!r.content.includes('canary-7f3e'), path);
  }
  const listed = await call('list_files', {});
  assert.ok(!listed.content.includes('link-out') && !listed.content.includes('secret'));
  const found = await call('search', { pattern: 'canary-7f3e' });
  assert.match(found.content, /no line matches/);
});

test('edit_file: only under src/, find exactly once, existing files only', async () => {
  const refused = [
    { path: 'fixtures/small-pickup.json', find: '"C-500"', replace: '"C-100"' },
    { path: 'test/visible.test.mjs', find: "test('a small order", replace: "test.skip('a small order" },
    { path: 'README.md', find: 'Order desk', replace: 'x' },
    { path: 'src/steps/grand-total/index.mjs', find: 'scope', replace: 'x' },
    { path: 'src/steps/grand-total/index.mjs', find: 'not in the file', replace: 'x' },
    { path: 'src/steps/grand-total/index.mjs', find: '', replace: 'x' },
    { path: 'src/new-file.mjs', find: 'a', replace: 'b' },
    { path: 'src/secret-link.mjs', find: 'canary-7f3e', replace: 'x' },
    { path: 'src/link-out/secret.txt', find: 'canary-7f3e', replace: 'x' },
    { path: 'src/steps', find: 'a', replace: 'b' },
  ];
  for (const input of refused) {
    const r = await call('edit_file', input);
    assert.equal(r.is_error, true, JSON.stringify(input));
  }
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'canary-7f3e answer\n');
  const ok = await call('edit_file', { path: 'src/steps/next-line/index.mjs', find: 'scope.lineIndex = scope.lineIndex + 1;', replace: 'scope.lineIndex = scope.lineIndex + 1; // $& kept' });
  assert.equal(ok.is_error, undefined, ok.content);
  assert.ok(readFileSync(join(work.dir, 'src/steps/next-line/index.mjs'), 'utf8').includes('// $& kept'));
});

test('bad inputs are error answers, never throws', async () => {
  const cases = [
    ['read_file', {}], ['read_file', { path: 3 }], ['read_file', { path: 'src/chart.mjs', extra: 1 }],
    ['read_file', { path: 'src/chart.mjs', start_line: 1.5 }], ['read_file', { path: 'src/chart.mjs', start_line: 50, end_line: 2 }],
    ['search', { pattern: '(' }], ['search', { pattern: '' }], ['run_order', { fixture: '../hidden' }],
    ['run_order', { fixture: 'nope' }], ['why', { fixture: 'small-pickup', key: 'noSuchKey' }],
    ['step', { address: 'no-such-step' }], ['map', { address: 'nowhere' }], ['story', { fixture: 'small-pickup', address: 'x' }],
    ['no_such_tool', {}], ['list_files', null], ['done', {}],
  ];
  for (const [name, input] of cases) {
    const r = await call(name, input);
    assert.equal(r.is_error, true, `${name} ${JSON.stringify(input)} → ${r.content}`);
    assert.match(r.content, /^error: /);
  }
});

test('every answer stays within its bound and says when it was cut', async () => {
  mkdirSync(join(work.dir, 'src', 'big'), { recursive: true });
  writeFileSync(join(work.dir, 'src', 'big', 'long.mjs'), `${'// a long line of text in a big file\n'.repeat(3000)}`);
  // A long order (many lines) makes a story longer than its bound.
  const many = Array.from({ length: 20 }, () => ({ sku: 'PEN-BLUE', qty: 1 }));
  writeFileSync(join(work.dir, 'fixtures', 'many-lines.json'), JSON.stringify({ order: { orderId: 'T-1', customerId: 'C-200', shipRegion: 'north', billingRegion: 'north', shipMethod: 'standard', lines: many } }));
  const noisy = 'src/steps/receive-order/index.mjs';
  const text = readFileSync(join(work.dir, noisy), 'utf8');
  writeFileSync(join(work.dir, noisy), text.replace('export function run(scope) {', "export function run(scope) {\n  for (let i = 0; i < 5000; i++) console.log('noise', i);"));
  const calls = [
    ['read_file', { path: 'src/big/long.mjs' }], ['search', { pattern: 'long line' }], ['list_files', {}],
    ['run_order', { fixture: 'harbour-three-items' }], ['run_tests', {}], ['map', {}],
    ['step', { address: 'price-line', fixture: 'harbour-three-items' }], ['why', { fixture: 'harbour-three-items', key: 'status' }],
    ['story', { fixture: 'many-lines' }], ['done', { summary: 'x'.repeat(5000) }],
  ];
  for (const [name, input] of calls) {
    const t = all.find((x) => x.definition.name === name);
    const r = await call(name, input);
    const cutLine = r.content.length > t.LIMIT ? r.content.slice(t.LIMIT) : '';
    assert.ok(r.content.length <= t.LIMIT + 100, `${name}: ${r.content.length} > ${t.LIMIT}`);
    if (cutLine) assert.match(cutLine, /^\n\[cut: the answer was \d+ characters; only the first \d+ are shown\]$/, name);
  }
  const read = await call('read_file', { path: 'src/big/long.mjs' });
  assert.match(read.content, /\[cut: /);
  const story = await call('story', { fixture: 'many-lines' });
  assert.match(story.content, /\[cut: /);
});

test('bounded() keeps short text and marks cut text', () => {
  assert.equal(bounded('abc', 5), 'abc');
  assert.equal(bounded('abcdef', 3), 'abc\n[cut: the answer was 6 characters; only the first 3 are shown]');
});

test('a child gets an empty environment', async () => {
  process.env.AGENT_DEBUG_CANARY = 'must-not-leak';
  try {
    const r = await runNode(['-e', 'console.log(JSON.stringify(process.env))'], { cwd: work.dir, confine: here() });
    assert.equal(r.code, 0);
    assert.ok(!r.stdout.includes('must-not-leak'));
    assert.ok(!r.stdout.includes('ANTHROPIC'));
  } finally {
    delete process.env.AGENT_DEBUG_CANARY;
  }
});

test('a child is killed at its time limit and its output is capped', async () => {
  const started = Date.now();
  const slow = await runNode(['-e', 'while (true) {}'], { cwd: work.dir, confine: here(), timeoutMs: 500 });
  assert.equal(slow.timedOut, true);
  assert.ok(Date.now() - started < 5000);
  const loud = await runNode(['-e', "for (let i = 0; i < 1e5; i++) console.log('x'.repeat(100))"], { cwd: work.dir, confine: here(), maxOutputBytes: 10_000 });
  assert.equal(loud.cut, true);
  assert.ok(loud.stdout.length <= 10_000);
  const huge = await runNode(['-e', '1'], { cwd: work.dir, confine: here(), timeoutMs: 10_000_000, maxOutputBytes: 1e12 });
  assert.equal(huge.code, 0);
});

test('a run_order that never ends is stopped', async () => {
  const other = await createWorkdir(null);
  try {
    const file = join(other.dir, 'src/steps/next-line/index.mjs');
    writeFileSync(file, readFileSync(file, 'utf8').replace('scope.lineIndex = scope.lineIndex + 1;', 'while (true) {}'));
    const r = await callTool(all, 'run_order', { fixture: 'harbour-three-items' }, { workdir: other.dir });
    assert.match(r.content, /stopped after 20 s/);
  } finally {
    removeWorkdir(other.dir);
  }
});

test('the program a tool runs cannot see the benchmark folder on its command line', async () => {
  const other = await createWorkdir(null);
  try {
    const file = join(other.dir, 'src/run-order.mjs');
    writeFileSync(file, `console.log(JSON.stringify([process.execArgv, process.argv]));\n${readFileSync(file, 'utf8')}`);
    const r = await callTool(all, 'run_order', { fixture: 'small-pickup' }, { workdir: other.dir });
    assert.ok(!r.content.includes('agent-debug/'), r.content.slice(0, 400));
    assert.ok(!r.content.includes('/bench/'));
  } finally {
    removeWorkdir(other.dir);
  }
});
