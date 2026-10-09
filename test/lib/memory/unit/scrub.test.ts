/**
 * scrub.ts — the commit log's scrub (C4, L2), on its own: no engine, no frame, no verdict. The cases
 * moved here from utils.test.ts (`redactPatch` lived in utils.ts until 9.33.0, then in redaction.ts),
 * one block per function, plus the leaf's own law (src/lib/memory/scrub.ts):
 *
 *   1  a path is scrubbed only where it holds a DEFINED value — scrubbing never invents a field
 *   2  paths are scrubbed in order against the tree as scrubbed so far — under a scrubbed one, left alone
 *   3  the input is never edited: `scrubPatch` copies only the spine (nothing when nothing is scrubbed),
 *      `redactPatch` hands back a fresh deep copy
 */
import { describe, expect, it } from 'vitest';

import { DELIM } from '../../../../src/lib/memory/paths';
import { LOG_PLACEHOLDER } from '../../../../src/lib/memory/placeholders';
import { redactPatch, scrubPatch } from '../../../../src/lib/memory/scrub';

describe('redactPatch — the public scrub (footprintjs/advanced)', () => {
  it('redacts an existing defined value', () => {
    const patch = { user: { name: 'Alice', ssn: '123-45-6789' }, score: 99 };
    const redacted = redactPatch(patch, new Set([`user${DELIM}ssn`]));
    expect(redacted.user.ssn).toBe('REDACTED');
    expect(redacted.user.name).toBe('Alice');
    expect(redacted.score).toBe(99);
  });

  it('skips redaction when path does not exist in patch', () => {
    const patch = { foo: 1 };
    const redacted = redactPatch(patch, new Set([`bar${DELIM}baz`]));
    expect(redacted).toEqual({ foo: 1 });
    expect(redacted).not.toHaveProperty('bar');
  });

  it('does not redact when value at path is undefined', () => {
    const patch = { chat: { token: undefined } };
    const redacted = redactPatch(patch, new Set([`chat${DELIM}token`]));
    expect(redacted.chat.token).toBeUndefined();
  });

  it('redacts nested paths correctly', () => {
    const patch = { a: { b: { c: 'secret' } } };
    const redacted = redactPatch(patch, new Set([`a${DELIM}b${DELIM}c`]));
    expect(redacted.a.b.c).toBe('REDACTED');
  });

  it('the PUBLIC redactPatch keeps its 4.x contract: a fresh deep copy, sharing nothing, input untouched', () => {
    const patch = { user: { ssn: 's', addr: { city: 'X' } }, other: { big: [1] } };
    for (const set of [new Set<string>(), new Set([`user${DELIM}ssn`])]) {
      const out = redactPatch(patch, set);
      expect(out).not.toBe(patch);
      expect(out.user).not.toBe(patch.user);
      expect(out.user.addr).not.toBe(patch.user.addr);
      expect(out.other).not.toBe(patch.other);
    }
    expect(patch.user.ssn).toBe('s');
  });
});

describe('scrubPatch — the engine’s clone-free scrub (9.33.0): the patch is the buffer’s commit-time copy already', () => {
  it('writes the log’s placeholder — the record’s string, not the scope channel’s', () => {
    expect(LOG_PLACEHOLDER).toBe('REDACTED');
    expect(scrubPatch({ k: 'v' }, ['k'])).toEqual({ k: LOG_PLACEHOLDER });
  });

  it('returns the patch ITSELF when there is nothing to scrub (no policy) — no copy at all', () => {
    const patch = { a: { b: 1 }, list: [1, 2] };
    expect(scrubPatch(patch, new Set())).toBe(patch);
    expect(scrubPatch(patch, new Set([`zz${DELIM}q`]))).toBe(patch);
  });

  it('copies only the spine of a scrubbed path; every other subtree is shared and the input is never edited', () => {
    const patch = { user: { name: 'Alice', ssn: 's', addr: { city: 'X' } }, other: { big: [1, 2, 3] } };
    const redacted = scrubPatch(patch, new Set([`user${DELIM}ssn`]));
    expect(redacted).not.toBe(patch);
    expect(redacted.user).not.toBe(patch.user);
    expect(redacted.user.addr).toBe(patch.user.addr);
    expect(redacted.other).toBe(patch.other);
    expect(patch.user.ssn).toBe('s');
    expect(redacted).toEqual({
      user: { name: 'Alice', ssn: 'REDACTED', addr: { city: 'X' } },
      other: { big: [1, 2, 3] },
    });
  });

  it('a path under one already scrubbed is left alone, in either order (the 4.x behaviour)', () => {
    const patch = { a: { b: 'secret' } };
    expect(scrubPatch(patch, new Set(['a', `a${DELIM}b`]))).toEqual({ a: 'REDACTED' });
    expect(scrubPatch(patch, new Set([`a${DELIM}b`, 'a']))).toEqual({ a: 'REDACTED' });
    expect(patch).toEqual({ a: { b: 'secret' } });
  });

  it('takes any iterable of paths — the buffer’s Set or a bundle’s array — and never invents a field', () => {
    const patch = { card: { number: '4242' }, list: [{ token: 't' }, {}] };
    const paths = [`card${DELIM}number`, `card${DELIM}cvc`, `list${DELIM}0${DELIM}token`, `list${DELIM}1${DELIM}token`];
    expect(scrubPatch(patch, paths)).toEqual({ card: { number: 'REDACTED' }, list: [{ token: 'REDACTED' }, {}] });
    expect(scrubPatch(patch, new Set(paths))).toEqual(scrubPatch(patch, paths));
  });
});
