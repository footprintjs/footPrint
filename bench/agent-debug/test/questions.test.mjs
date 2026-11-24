/**
 * The thirty questions (questions/, RULE-2.md "The tasks", the brief's
 * spread): their count and kinds, their wording, their shapes, their
 * coverage of the rules and outcomes, and the expected answers, which the
 * generator computes again here from F's runs and must equal the committed
 * hidden/answers.json.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { PROGRAMS } from '../harness/programs.mjs';
import { questionText } from '../harness/prompt.mjs';
import { expectedAnswers } from '../harness/score-question.mjs';
import { schemaOf } from '../harness/shapes.mjs';
import { listFiles } from '../harness/workdir.mjs';
import { computeAnswers } from '../questions/generate.mjs';
import { KINDS, loadQuestions } from '../questions/index.mjs';
import { makeContext } from '../questions/observe.mjs';
import { RULES } from '../questions/rules.mjs';

const QUESTIONS = loadQuestions();
const ANSWERS = expectedAnswers();
const LISTED = new Set(['enum', 'set', 'list']);

/** Every listed shape of a question: its own, or its object's fields'. */
const listedShapes = (shape) => (shape.type === 'object' ? Object.values(shape.fields) : [shape]).filter((s) => LISTED.has(s.type));

test('thirty questions, ten of each kind, each with an id, a text, a shape and a way to establish it with prints', () => {
  assert.equal(QUESTIONS.length, 30);
  for (const kind of KINDS) assert.equal(QUESTIONS.filter((q) => q.kind === kind).length, 10, kind);
  assert.equal(new Set(QUESTIONS.map((q) => q.id)).size, 30);
  for (const q of QUESTIONS) {
    assert.match(q.id, new RegExp(`^${q.kind}-[a-z-]+$`), q.id);
    assert.ok(q.text.length > 20 && typeof q.derive === 'function' && q.howWithPrints.length > 10, q.id);
    assert.equal(typeof q.intermediate === 'boolean' || q.kind === 'program', true, q.id);
  }
});

test('run and why questions name a fixture of the working folder, in the text; program questions name none', () => {
  for (const q of QUESTIONS) {
    if (q.kind === 'program') {
      assert.equal(q.fixture, undefined, q.id);
      assert.ok(!/fixture/.test(q.text), q.id);
      continue;
    }
    assert.ok(existsSync(join(PROGRAMS.F.dir, 'fixtures', `${q.fixture}.json`)), q.id);
    assert.ok(q.text.includes(`order fixture \`${q.fixture}\``) || q.text.includes(`Order fixture \`${q.fixture}\``), q.id);
  }
});

test('business words only: no step, stage, file, function or library word, and no key of the program', () => {
  const forbidden = /\b(step|stage|chart|flowchart|branch|loop|sub-?flow|scope|decide|decider|decision|record|mapper|node|footprint\w*|foottrace|fork|parallel|key|state|function|file|module|src)\b/i;
  const programKeys = ['orderId', 'customerId', 'shipRegion', 'billingRegion', 'shipMethod', 'couponCode', 'pricedLines', 'lineTotal', 'totalWeight', 'linesPriced', 'loyaltyDiscount', 'netAmount', 'taxRate', 'grandTotal', 'stockOk', 'shortSkus', 'creditOk', 'headroom', 'lineIndex', 'lineCount', 'linesLeft'];
  for (const q of QUESTIONS) {
    assert.ok(!forbidden.test(q.text), `${q.id}: ${q.text.match(forbidden)?.[0]}`);
    for (const key of programKeys) assert.ok(!q.text.includes(key), `${q.id} names ${key}`);
    assert.ok(!q.text.includes('CHAIR-ERGO') && !q.text.includes('DESK-LAMP'), `${q.id} names an item by code`);
  }
});

test('every listed shape prints all its options, sorted, each once, and the schema lists the same in the same order', () => {
  for (const q of QUESTIONS) {
    const schema = JSON.stringify(schemaOf(q.shape));
    for (const shape of listedShapes(q.shape)) {
      assert.deepEqual(shape.options, [...shape.options].sort(), `${q.id}: options sorted`);
      for (const o of shape.options) {
        assert.equal(q.text.split(`"${o}"`).length - 1, 1, `${q.id}: "${o}" printed once`);
        assert.ok(schema.includes(JSON.stringify(o)), `${q.id}: "${o}" in the schema`);
      }
    }
    if (q.shape.type === 'object') for (const name of Object.keys(q.shape.fields)) assert.ok(q.text.includes(name), `${q.id} names the field ${name}`);
  }
});

test('the text does not contain its answer: no expected number in it, and no ordered list printed in its answer order', () => {
  for (const q of QUESTIONS) {
    const answer = ANSWERS[q.id];
    const numbers = q.shape.type === 'number' ? [answer] : q.shape.type === 'object' ? Object.entries(q.shape.fields).filter(([, s]) => s.type === 'number').map(([k]) => answer[k]) : [];
    const written = [...q.text.matchAll(/(?<![\w.-])\d+(?:\.\d+)?(?![\w-])/g)].map((m) => Number(m[0]));
    for (const n of numbers) assert.ok(!written.includes(n), `${q.id}: the text holds its answer ${n}`);
    if (q.shape.type === 'list') assert.notDeepEqual(q.shape.options, answer, `${q.id}: the options are printed in the answer's order`);
  }
});

test('the right member is not first in the printed list more often than chance would put it', () => {
  // Sorted options cannot know the answer; this guards against a list typed answer-first and then "sorted" by hand.
  const enums = QUESTIONS.flatMap((q) => listedShapes(q.shape).filter((s) => s.type === 'enum').map((s) => ({ q, s, a: q.shape.type === 'object' ? Object.values(ANSWERS[q.id]).find((v) => s.options.includes(v)) : ANSWERS[q.id] })));
  const first = enums.filter((e) => e.s.options[0] === e.a).length;
  assert.ok(first <= Math.ceil(enums.length / 2), `${first} of ${enums.length} enum answers are listed first`);
});

test('every business rule is asked about at least once', () => {
  const asked = new Set(QUESTIONS.flatMap((q) => q.rules));
  for (const rule of Object.keys(RULES)) assert.ok(asked.has(rule), `no question asks about ${rule}`);
  for (const q of QUESTIONS) for (const rule of q.rules) assert.ok(rule in RULES, `${q.id} names an unknown rule ${rule}`);
});

test('the why questions cover each outcome and both shipping cases', () => {
  const why = QUESTIONS.filter((q) => q.kind === 'why');
  for (const outcome of ['approved', 'review', 'rejected', 'on-hold']) assert.ok(why.some((q) => q.outcome === outcome), outcome);
  for (const shipping of ['free', 'charged']) assert.ok(why.some((q) => q.shipping === shipping), shipping);
  const freeBy = why.filter((q) => q.shipping === 'free' && q.shape.type === 'enum').map((q) => ANSWERS[q.id]);
  assert.equal(new Set(freeBy).size, 2, 'both reasons for free shipping are asked');
});

test('at least six questions need a value the printed result does not show, and their numbers are not in it', async () => {
  const marked = QUESTIONS.filter((q) => q.intermediate);
  assert.ok(marked.length >= 6, `${marked.length} questions marked`);
  const ctx = await makeContext();
  for (const q of marked.filter((x) => x.shape.type === 'number')) {
    const printed = Object.values((await ctx.run(ctx.fixture(q.fixture))).result).filter((v) => typeof v === 'number');
    assert.ok(!printed.includes(ANSWERS[q.id]), `${q.id}: ${ANSWERS[q.id]} is printed in the result of ${q.fixture}`);
  }
});

test('no file of a working folder but the visible tests holds a run or why answer (no comment, README or table hands it over)', () => {
  // RULE-2.md: "Nothing in either folder states an expected result beyond those eight tests."
  const numbers = QUESTIONS.filter((q) => q.kind !== 'program').flatMap((q) => {
    const a = ANSWERS[q.id];
    return q.shape.type === 'number' ? [[q.id, a]] : q.shape.type === 'object' ? Object.values(a).filter((v) => typeof v === 'number').map((v) => [q.id, v]) : [];
  }).filter(([, n]) => String(n).includes('.') || n >= 10);
  for (const program of [PROGRAMS.F, PROGRAMS.P]) {
    assert.ok(existsSync(join(program.dir, 'MANIFEST.json')), `${program.id} has its manifest`);
    const files = Object.keys(JSON.parse(readFileSync(join(program.dir, 'MANIFEST.json'), 'utf8'))).filter((f) => f !== program.testFile && !f.startsWith('fixtures/'));
    for (const rel of files) {
      const written = new Set([...readFileSync(join(program.dir, rel), 'utf8').matchAll(/(?<![\w.-])\d+(?:\.\d+)?(?![\w-])/g)].map((m) => Number(m[0])));
      for (const [id, n] of numbers) assert.ok(!written.has(n), `${program.id} ${rel} holds ${n}, the answer of ${id}`);
    }
  }
  assert.ok(listFiles(PROGRAMS.F.dir).length > 0);
});

test('the task text of a question is the question and one closing sentence', () => {
  for (const q of QUESTIONS) {
    assert.equal(questionText(q), `${q.text} When you have the answer, call \`answer\` with it; you can answer only once.`);
    assert.ok(!questionText(q).includes(q.id), 'the id is never sent');
  }
});

test('the expected answers are computed from F\'s runs and equal the committed hidden/answers.json', async () => {
  const computed = await computeAnswers();
  assert.deepEqual(computed, ANSWERS);
  assert.deepEqual(Object.keys(ANSWERS).sort(), QUESTIONS.map((q) => q.id).sort());
});
