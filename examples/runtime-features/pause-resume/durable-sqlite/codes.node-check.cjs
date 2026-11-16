'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { isSafeCode, safeFailure } = require('./codes.cjs');
const { refusal } = require('./identity.cjs');

test('only fixed value-free codes are publishable', () => {
  assert.equal(isSafeCode('INPUT_JSON'), true);
  assert.equal(safeFailure(refusal('INPUT_JSON')), 'INPUT_JSON');
  assert.equal(isSafeCode('PRIVATE_UPPERCASE_VALUE'), false);
  assert.equal(safeFailure({ safeCode: 'PRIVATE_UPPERCASE_VALUE' }), 'EXAMPLE_OPERATION_FAILED');
  assert.equal(refusal('PRIVATE_UPPERCASE_VALUE').message, 'EXAMPLE_OPERATION_FAILED');
});

test('error getters and inherited safe-code claims are never served', () => {
  let calls = 0;
  const error = Object.defineProperty({}, 'safeCode', { get() { calls++; return 'INPUT_JSON'; } });
  assert.equal(safeFailure(error), 'EXAMPLE_OPERATION_FAILED');
  assert.equal(calls, 0);
  assert.equal(safeFailure(Object.create({ safeCode: 'INPUT_JSON' })), 'EXAMPLE_OPERATION_FAILED');
  assert.equal(safeFailure(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private'); } })),
    'EXAMPLE_OPERATION_FAILED');
});
