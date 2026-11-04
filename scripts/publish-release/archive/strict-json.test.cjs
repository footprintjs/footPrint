'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseManifest } = require('./strict-json.cjs');
const { archiveRefusalCode } = require('./refusal.cjs');
const { source } = require('./fixture.cjs');

function rejects(input, pattern = /^manifest-json/) {
  assert.throws(
    () => parseManifest(input),
    (error) => {
      assert.match(archiveRefusalCode(error), pattern);
      assert.equal(error.message, 'manifest-json');
      return true;
    },
  );
}

test('parses full source JSON, UTF-8 BOM, whitespace and ordinary duplicate-looking strings', () => {
  const bytes = Buffer.from(JSON.stringify(source));
  assert.deepEqual(parseManifest(bytes), source);
  assert.deepEqual(parseManifest(Buffer.concat([Buffer.from([239, 187, 191]), bytes])), source);
  assert.deepEqual(parseManifest(' \r\n' + bytes.toString() + '\t'), source);
  assert.deepEqual(parseManifest('{"text":"{\\"x\\":1,\\"x\\":2}","items":[{"x":1},{"x":2}]}'), {
    text: '{"x":1,"x":2}',
    items: [{ x: 1 }, { x: 2 }],
  });
});

for (const input of [
  '{"name":"a","name":"a"}',
  '{"x":{"tag":"a","ta\\u0067":"b"}}',
  '{"x":[{"key":1,"key":2}]}',
  '{"__proto__":1,"__proto__":2}',
  '{"":1,"":2}',
  '{"\\n":1,"\\u000a":2}',
  '{"\\u0000":1,"\\u0000":2}',
])
  test('rejects decoded duplicate keys: ' + input, () => rejects(input));

for (const input of [
  '',
  '{}{}',
  '{} trailing',
  '{"x":01}',
  '{"x":1e999}',
  '{"x":NaN}',
  '{"x":undefined}',
  '{"x":true,}',
  '{"x":[1,]}',
  '{"x":"\\q"}',
  '{"x":"\n"}',
  '[]',
  'null',
  '"text"',
  'false',
])
  test('rejects malformed or non-object JSON ' + JSON.stringify(input), () => rejects(input));

test('bounded input, depth and value count refuse structurally', () => {
  rejects(Buffer.alloc(1024 * 1024 + 1, 32));
  rejects('{"x":' + '['.repeat(66) + '0' + ']'.repeat(66) + '}');
  rejects('{"x":[' + Array(100001).fill('0').join(',') + ']}');
  rejects(Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]));
  rejects({ name: 'not encoded bytes' });
});

test('decoded prototype/control keys remain own data, never prototype writes', () => {
  const value = parseManifest('{"__proto__":{"polluted":true},"\\u0000":1}');
  assert.equal(Object.hasOwn(value, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(value['\0'], 1);
  assert.equal({}.polluted, undefined);
});
