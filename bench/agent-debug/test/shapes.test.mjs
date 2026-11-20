/**
 * The answer shapes and their one comparison rule (harness/shapes.mjs):
 * every shape, right answers, near misses, malformed answers. No partial
 * credit anywhere.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkShape, compareAnswer, malformed, schemaOf, toCent, wrongOf } from '../harness/shapes.mjs';

const right = (shape, expected, given) => compareAnswer(shape, expected, given).right;

test('number: equal after rounding both to the cent, and nothing else', () => {
  const n = { type: 'number' };
  assert.equal(right(n, 50, 50), true);
  assert.equal(right(n, 50, 50.0), true);
  assert.equal(right(n, 50, 49.999), true, '49.999 is 50.00 to the cent');
  assert.equal(right(n, 50, 50.004), true, '50.004 is 50.00 to the cent');
  assert.equal(right(n, 50, 49.994), false, '49.994 is 49.99');
  assert.equal(right(n, 50, 50.01), false);
  assert.equal(right(n, 437.02, -437.02), false, 'the sign counts');
  assert.equal(right(n, 1.01, 1.005), true, '1.005 × 100 is 100.49999… in floating point; read to 12 digits it is 100.5, which rounds to 101');
  assert.equal(right(n, 7.25, 7.249999999999999), true, '0.0725 × 100 in floating point');
  assert.deepEqual(compareAnswer(n, 50, '50'), { right: false, problem: 'not a finite JSON number' }, 'a string is malformed');
  for (const bad of [null, NaN, Infinity, [50], { value: 50 }, true]) assert.equal(right(n, 50, bad), false, JSON.stringify(bad));
  assert.deepEqual(compareAnswer(n, 50, undefined), { right: false, problem: 'no answer was given' });
});

test('enum: the same member exactly', () => {
  const e = { type: 'enum', options: ['approved', 'on-hold', 'rejected'] };
  assert.equal(right(e, 'rejected', 'rejected'), true);
  assert.equal(right(e, 'rejected', 'approved'), false);
  assert.equal(right(e, 'rejected', 'Rejected'), false, 'letter case counts');
  assert.equal(right(e, 'rejected', ' rejected'), false);
  assert.equal(compareAnswer(e, 'rejected', 'declined').problem, 'not one of the listed options');
  assert.equal(right(e, 'rejected', ['rejected']), false, 'a list of one is not a member');
});

test('set: the same members in any order; a superset, a subset or a repeat is wrong', () => {
  const s = { type: 'set', options: ['a', 'b', 'c', 'd'] };
  assert.equal(right(s, ['a', 'c'], ['a', 'c']), true);
  assert.equal(right(s, ['a', 'c'], ['c', 'a']), true, 'any order');
  assert.equal(right(s, ['a', 'c'], ['a', 'b', 'c']), false, 'a superset');
  assert.equal(right(s, ['a', 'c'], ['a']), false, 'a subset');
  assert.equal(right(s, ['a', 'c'], []), false);
  assert.equal(right(s, [], []), true, 'none is an answer');
  assert.equal(compareAnswer(s, ['a', 'c'], ['a', 'a', 'c']).problem, 'a member given twice');
  assert.equal(compareAnswer(s, ['a', 'c'], ['a', 'x']).problem, 'a member that is not one of the listed options');
  assert.equal(right(s, ['a'], 'a'), false, 'a bare member is not a set');
});

test('list: the same members in the same order', () => {
  const l = { type: 'list', options: ['approved', 'on-hold', 'rejected', 'review'] };
  const order = ['on-hold', 'rejected', 'review', 'approved'];
  assert.equal(right(l, order, [...order]), true);
  assert.equal(right(l, order, ['rejected', 'on-hold', 'review', 'approved']), false, 'the right members in the wrong order');
  assert.equal(right(l, order, order.slice(0, 3)), false, 'one missing');
  assert.equal(right(l, order, [...order].reverse()), false);
});

test('boolean: true or false, nothing else', () => {
  const b = { type: 'boolean' };
  assert.equal(right(b, false, false), true);
  assert.equal(right(b, false, true), false);
  for (const bad of ['no', 0, null, 'false']) assert.equal(right(b, false, bad), false, JSON.stringify(bad));
});

test('object: every field right by its own shape; a missing or extra field is wrong', () => {
  const o = { type: 'object', fields: { failed: { type: 'set', options: ['x', 'y', 'z'] }, by: { type: 'number' } } };
  const expected = { failed: ['x', 'y'], by: 437.02 };
  assert.equal(right(o, expected, { failed: ['y', 'x'], by: 437.02 }), true);
  assert.equal(right(o, expected, { by: 437.024, failed: ['x', 'y'] }), true, 'field order and the cent rule');
  assert.equal(right(o, expected, { failed: ['x'], by: 437.02 }), false, 'one field wrong is all wrong');
  assert.equal(right(o, expected, { failed: ['x', 'y'], by: 437.03 }), false);
  assert.match(compareAnswer(o, expected, { failed: ['x', 'y'] }).problem, /the field by is missing/);
  assert.match(compareAnswer(o, expected, { failed: ['x', 'y'], by: 1, why: 'x' }).problem, /not asked for: why/);
  assert.match(compareAnswer(o, expected, { failed: 'x', by: 1 }).problem, /failed: not a list/);
  assert.equal(right(o, expected, [expected]), false);
});

test('a malformed EXPECTED answer is a broken question, never a silent pass', () => {
  assert.throws(() => compareAnswer({ type: 'number' }, '6', 6), /question is broken/);
});

test('the schemas: every listed member, in the order given, and nothing that says which is right', () => {
  const e = { type: 'enum', options: ['a', 'b', 'c'] };
  assert.deepEqual(schemaOf(e), { type: 'string', enum: ['a', 'b', 'c'] });
  assert.deepEqual(schemaOf({ type: 'set', options: ['a', 'b'] }).items.enum, ['a', 'b']);
  assert.equal(schemaOf({ type: 'set', options: ['a', 'b'] }).uniqueItems, true);
  assert.deepEqual(schemaOf({ type: 'object', fields: { a: { type: 'number' }, b: e } }), {
    type: 'object', properties: { a: { type: 'number' }, b: { type: 'string', enum: ['a', 'b', 'c'] } }, required: ['a', 'b'], additionalProperties: false,
  });
  assert.throws(() => checkShape({ type: 'enum', options: ['b', 'a'] }), /sorted/);
  assert.throws(() => checkShape({ type: 'enum', options: ['a', 'a'] }), /distinct/);
  assert.throws(() => checkShape({ type: 'object', fields: { o: { type: 'object', fields: { n: { type: 'number' } } } } }), /inside an object/);
  assert.throws(() => checkShape({ type: 'text' }), /unknown/);
});

test('wrongOf gives a well-formed answer that is scored wrong, for every shape', () => {
  const cases = [
    [{ type: 'number' }, 6],
    [{ type: 'boolean' }, false],
    [{ type: 'enum', options: ['a', 'b'] }, 'a'],
    [{ type: 'set', options: ['a', 'b', 'c'] }, ['b']],
    [{ type: 'set', options: ['a', 'b', 'c'] }, ['a', 'b']],
    [{ type: 'list', options: ['a', 'b', 'c'] }, ['c', 'a', 'b']],
    [{ type: 'object', fields: { n: { type: 'number' }, e: { type: 'enum', options: ['a', 'b'] } } }, { n: 2, e: 'b' }],
  ];
  for (const [shape, expected] of cases) {
    const wrong = wrongOf(shape, expected);
    assert.equal(malformed(shape, wrong), null, JSON.stringify(shape));
    assert.equal(right(shape, expected, wrong), false, JSON.stringify(shape));
  }
  assert.equal(toCent(0.0725 * 100), 7.25);
});
