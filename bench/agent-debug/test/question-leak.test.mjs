/**
 * Leak tests for part 2's new surface (RULE-2.md, "Void": a tool answer that
 * hands over an expected answer from the hidden data):
 * - nothing a tool or a child can reach holds the expected answers or the
 *   answer functions: the tools' import graph and the runtime folder never
 *   touch questions/ or hidden/answers.json, and confined code that tries to
 *   read them is denied, through run_order, run_tests and the record probe;
 * - every tool of every set-up, called as a model would call it on each
 *   question's fixture, answers nothing distinctive of an expected answer
 *   that the working folder itself does not hold, and never a question id;
 * - the `answer` tool's schema lists every member, in the printed order, and
 *   its reply says nothing about the answer.
 * Part 2, set-up P: in the twin's working copy, confined code cannot read
 * the hidden data, the expected answers, the questions, twin-proof/ (the
 * twin's own tests and expected results), twin/SPEC.md or twin/BRIEF.md,
 * through run_order or run_tests; and no tool of set-up P answers an
 * expected answer the twin's working folder does not hold.
 * The question texts not holding their answers is in questions.test.mjs.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

import { PROGRAMS } from '../harness/programs.mjs';
import { BENCH_DIR, ensureRuntime } from '../harness/runtime.mjs';
import { expectedAnswers } from '../harness/score-question.mjs';
import { schemaOf } from '../harness/shapes.mjs';
import { createWorkdir, listFiles, removeWorkdir } from '../harness/workdir.mjs';
import { loadQuestions } from '../questions/index.mjs';
import { SETUPS, callTool, toolsFor } from '../tools/index.mjs';

const QUESTIONS = loadQuestions();
const ANSWERS = expectedAnswers();
const ANSWERS_FILE = join(BENCH_DIR, 'hidden', 'answers.json');

/** Relative imports of a module, followed to the end. */
function importGraph(entry, seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const text = readFileSync(entry, 'utf8');
  for (const m of text.matchAll(/(?:import|export)[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
    importGraph(resolve(dirname(entry), m[1] ?? m[2]), seen);
  }
  return seen;
}

/** Every file under a folder. */
const filesUnder = (dir) => readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath ?? e.path, e.name));

test('no module a tool or a child loads touches the questions or the expected answers', () => {
  const roots = [join(BENCH_DIR, 'tools', 'index.mjs'), ...['harness/deps', 'harness/scoring-child', 'tools/record', 'tools/search-child'].flatMap((d) => filesUnder(join(BENCH_DIR, d)))];
  const graph = new Set(roots.flatMap((r) => [...importGraph(r)]));
  for (const file of graph) {
    const rel = relative(BENCH_DIR, file);
    assert.ok(!rel.startsWith('questions/') && !rel.startsWith('hidden/'), `${rel} is reachable from a tool or a child`);
    assert.ok(!readFileSync(file, 'utf8').includes('answers.json'), `${rel} names answers.json`);
  }
  for (const file of filesUnder(ensureRuntime())) {
    const rel = relative(ensureRuntime(), file);
    assert.ok(!/answers\.json|(^|\/)questions\/|(^|\/)hidden\//.test(rel), `the runtime folder holds ${rel}`);
  }
});

test('confined code cannot read the expected answers or the answer functions, through any door', async () => {
  const targets = [ANSWERS_FILE, join(BENCH_DIR, 'questions', 'run.mjs'), join(BENCH_DIR, 'questions', 'generate.mjs')];
  const work = await createWorkdir(null);
  try {
    const file = join(work.dir, 'src', 'steps', 'receive-order', 'index.mjs');
    const attempt = `import * as __fs from 'node:fs';\nfor (const __t of ${JSON.stringify(targets)}) { try { __fs.readFileSync(__t, 'utf8'); console.log('ESCAPED ' + __t); } catch (e) { console.log('denied ' + (e.code ?? e.message)); } }\n`;
    writeFileSync(file, attempt + readFileSync(file, 'utf8'));
    const shown = (await callTool(SETUPS[1], 'run_order', { fixture: 'small-pickup' }, { workdir: work.dir })).content;
    assert.ok(!shown.includes('ESCAPED'), shown);
    assert.equal(shown.match(/denied ERR_ACCESS_DENIED/g)?.length, 3, shown);
    const tests = await callTool(SETUPS[1], 'run_tests', {}, { workdir: work.dir });
    assert.match(tests.content, /8 passed, 0 failed/, 'the tests still run');
    const why = await callTool(SETUPS[3], 'why', { fixture: 'cafe-chairs', key: 'status' }, { workdir: work.dir });
    assert.ok(!why.content.includes('ESCAPED') && !why.content.includes('"run-tax-rate"'), why.content);
  } finally {
    removeWorkdir(work.dir);
  }
});

test('set-up P: confined code in the twin\'s working copy cannot read the hidden data, the answers, the questions, twin-proof/, SPEC.md or BRIEF.md', async () => {
  const targets = [
    ANSWERS_FILE, join(BENCH_DIR, 'hidden', 'expected.json'), join(BENCH_DIR, 'hidden', 'orders.json'), join(BENCH_DIR, 'questions', 'run.mjs'),
    join(BENCH_DIR, 'twin-proof', 'compare-all.mjs'), join(BENCH_DIR, 'twin-proof', 'expected', 'small-pickup.json'), join(BENCH_DIR, 'twin-proof', 'test', 'rules.test.mjs'),
    join(PROGRAMS.P.dir, 'SPEC.md'), join(PROGRAMS.P.dir, 'BRIEF.md'), join(PROGRAMS.P.dir, 'MANIFEST.json'),
  ];
  const work = await createWorkdir(null, { program: PROGRAMS.P });
  try {
    for (const never of ['SPEC.md', 'BRIEF.md', 'MANIFEST.json']) assert.ok(!listFiles(work.dir).includes(never), never);
    const file = join(work.dir, 'src', 'order-desk.mjs');
    const attempt = `import * as __fs from 'node:fs';\nfor (const __t of ${JSON.stringify(targets)}) { try { __fs.readFileSync(__t, 'utf8'); console.log('ESCAPED ' + __t); } catch (e) { console.log('denied ' + (e.code ?? e.message)); } }\n`;
    writeFileSync(file, attempt + readFileSync(file, 'utf8'));
    const context = { workdir: work.dir, program: PROGRAMS.P };
    const shown = (await callTool(SETUPS.P, 'run_order', { fixture: 'small-pickup' }, context)).content;
    assert.ok(!shown.includes('ESCAPED'), shown);
    assert.equal(shown.match(/denied ERR_ACCESS_DENIED/g)?.length, targets.length, shown);
    const tests = (await callTool(SETUPS.P, 'run_tests', {}, context)).content;
    assert.match(tests, /^8 passed, 0 failed/, 'the tests still run');
    assert.ok(!tests.includes('ESCAPED'), tests);
  } finally {
    removeWorkdir(work.dir);
  }
});

test('set-up P: no tool answer holds an expected answer the twin\'s working folder does not hold, or a question id', async () => {
  const work = await createWorkdir(null, { program: PROGRAMS.P });
  try {
    const folderText = listFiles(work.dir).map((f) => readFileSync(join(work.dir, f), 'utf8')).join('\n');
    const secrets = QUESTIONS.flatMap((q) => distinctive(ANSWERS[q.id]).map((s) => [q.id, s]));
    const fixtures = [...new Set(QUESTIONS.map((q) => q.fixture).filter(Boolean))];
    const calls = [
      ['list_files', {}], ['run_tests', {}], ['read_file', { path: 'README.md' }], ['search', { pattern: 'free' }],
      ...fixtures.map((fixture) => ['run_order', { fixture }]),
    ];
    for (const [name, input] of calls) {
      const answer = await callTool(SETUPS.P, name, input, { workdir: work.dir, program: PROGRAMS.P });
      assert.notEqual(answer.is_error, true, `${name}: ${answer.content}`);
      for (const q of QUESTIONS) assert.ok(!answer.content.includes(q.id), `${name} ${JSON.stringify(input)} names the question id ${q.id}`);
      for (const [id, s] of secrets) {
        if (answer.content.includes(s)) assert.ok(folderText.includes(s), `${name} ${JSON.stringify(input)} holds ${JSON.stringify(s)} (the answer of ${id}), which the working folder does not`);
      }
    }
  } finally {
    removeWorkdir(work.dir);
  }
});

/** What would be telling of an expected answer: its strings, and its JSON when it is a list or an object. */
function distinctive(answer) {
  if (typeof answer === 'number' || typeof answer === 'boolean') return [];
  if (typeof answer === 'string') return [answer];
  const strings = [];
  const walk = (v) => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(answer);
  return [...strings, JSON.stringify(answer)];
}

test('no tool answer, in any set-up, holds an expected answer the working folder does not hold, or a question id', async () => {
  const work = await createWorkdir(null);
  try {
    const folderText = listFiles(work.dir).map((f) => readFileSync(join(work.dir, f), 'utf8')).join('\n');
    const secrets = QUESTIONS.flatMap((q) => distinctive(ANSWERS[q.id]).map((s) => [q.id, s]));
    const fixtures = [...new Set(QUESTIONS.map((q) => q.fixture).filter(Boolean))];
    const calls = [
      ['list_files', {}], ['run_tests', {}], ['map', {}], ['map', { address: 'tax' }], ['map', { address: 'approval' }],
      ['read_file', { path: 'README.md' }], ['search', { pattern: 'free' }],
      ...fixtures.flatMap((fixture) => [
        ['run_order', { fixture }], ['story', { fixture }], ['why', { fixture, key: 'status' }], ['why', { fixture, key: 'shipping' }],
        ['step', { address: 'shipping-rule', fixture }], ['step', { address: 'approval', fixture }], ['step', { address: 'check-credit', fixture }],
      ]),
    ];
    let asked = 0;
    for (const [name, input] of calls) {
      const answer = await callTool(SETUPS[3], name, input, { workdir: work.dir });
      asked++;
      for (const q of QUESTIONS) assert.ok(!answer.content.includes(q.id), `${name} ${JSON.stringify(input)} names the question id ${q.id}`);
      for (const [id, s] of secrets) {
        if (answer.content.includes(s)) assert.ok(folderText.includes(s), `${name} ${JSON.stringify(input)} holds ${JSON.stringify(s)} (the answer of ${id}), which the working folder does not`);
      }
    }
    assert.ok(asked > 50);
  } finally {
    removeWorkdir(work.dir);
  }
});

test('the answer tool lists every member in the printed order and its reply says nothing about the answer', async () => {
  for (const q of QUESTIONS) {
    const tool = toolsFor(1, schemaOf(q.shape)).find((t) => t.definition.name === 'answer');
    const schema = tool?.definition.input_schema.properties.answer;
    assert.deepEqual(schema, schemaOf(q.shape), q.id);
    const options = q.shape.type === 'object' ? Object.values(q.shape.fields).flatMap((f) => f.options ?? []) : q.shape.options ?? [];
    const listed = JSON.stringify(schema).match(/"enum":\[[^\]]*\]/g)?.flatMap((e) => JSON.parse(e.slice(7))) ?? [];
    assert.deepEqual(listed, options, `${q.id}: every member, in the printed order`);
    for (const given of [ANSWERS[q.id], 'nonsense']) {
      const reply = await callTool([/** @type {any} */ (tool)], 'answer', { answer: given }, { workdir: BENCH_DIR });
      assert.equal(reply.content, 'Recorded. The run ends here.', 'the same reply, right or wrong');
    }
  }
});
