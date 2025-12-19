/**
 * Coverage tests for src/lib/memory/utils.ts — lines 121-125 (redactPatch)
 */

import { redactPatch, DELIM } from '../../../../src/lib/memory/utils';

describe('redactPatch (lib)', () => {
  it('redacts an existing defined value (lines 122-125)', () => {
    const patch = {
      user: { name: 'Alice', ssn: '123-45-6789' },
      score: 99,
    };
    const redacted = redactPatch(patch, new Set([`user${DELIM}ssn`]));
    expect(redacted.user.ssn).toBe('REDACTED');
    expect(redacted.user.name).toBe('Alice');
    expect(redacted.score).toBe(99);
  });

  it('skips redaction when path does not exist in patch (line 122 _has false)', () => {
    const patch = { foo: 1 };
    const redacted = redactPatch(patch, new Set([`bar${DELIM}baz`]));
    expect(redacted).toEqual({ foo: 1 });
    expect(redacted).not.toHaveProperty('bar');
  });

  it('does not redact when value at path is undefined (line 124 typeof check)', () => {
    const patch = { chat: { token: undefined } };
    const redacted = redactPatch(patch, new Set([`chat${DELIM}token`]));
    expect(redacted.chat.token).toBeUndefined();
  });

  it('redacts nested paths correctly', () => {
    const patch = {
      a: { b: { c: 'secret' } },
    };
    const redacted = redactPatch(patch, new Set([`a${DELIM}b${DELIM}c`]));
    expect(redacted.a.b.c).toBe('REDACTED');
  });
});
