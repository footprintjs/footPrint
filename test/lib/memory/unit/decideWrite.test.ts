/**
 * The write decision (C4, `memory/redaction.ts`): one owner decides, the record writes the bytes. Its
 * three parts on their own — no engine, no record frame — and then the funnel that composes them
 * (`StageContext · stageWrite`), in the order the record needs:
 *
 *   1–2  decideWrite         the verdict: an explicit flag → whole; else the rule; no rule / an inert one
 *                            → clear; an object read under a selected name keeps that read's rule (identity)
 *   3    scrubOf             the verdict's bytes for `RecordFrame · write`: `{ whole }`, `{ fields }`, nothing
 *   4    markWritten         the run's marks, once the write is staged: a delete clears the key's mark, a
 *                            whole verdict marks its key — so a write that fails to stage marks nothing
 */
import { describe, expect, it } from 'vitest';

import { EventLog } from '../../../../src/lib/memory/EventLog';
import {
  type RedactionVerdict,
  CLEAR,
  decideWrite,
  RedactionRule,
  scrubOf,
} from '../../../../src/lib/memory/redaction';
import { SharedMemory } from '../../../../src/lib/memory/SharedMemory';
import { StageContext } from '../../../../src/lib/memory/StageContext';

/** The frame's selected reads: each object → the verdict of the name it was read under. */
const selectedAs = (value: object, verdict: RedactionVerdict) =>
  new WeakMap<object, RedactionVerdict>([[value, verdict]]);

describe('decideWrite — steps 1 and 2: the verdict', () => {
  it('no rule, or an inert one: clear', () => {
    expect(decideWrite(undefined, undefined, [], 'k', 'v', undefined)).toBe(CLEAR);
    const inert = new RedactionRule();
    expect(decideWrite(inert, undefined, [], 'k', 'v', false)).toBe(CLEAR);
    expect(inert.isInert()).toBe(true);
  });

  it('an explicit flag is whole under its user-level key — with no rule at all, too', () => {
    expect(decideWrite(undefined, undefined, [], 'pin', '0000', true)).toEqual({ kind: 'whole', key: 'pin' });
    expect(decideWrite(undefined, undefined, ['profile'], 'auth', {}, true)).toEqual({
      kind: 'whole',
      key: 'profile.auth',
    });
  });

  it('else the rule decides from the path: a key is whole, declared fields are fields, anything else clear', () => {
    const rule = new RedactionRule({ keys: ['ssn'], fields: { card: ['number', 'cvc'] } });
    expect(decideWrite(rule, undefined, [], 'ssn', '1', false)).toEqual({ kind: 'whole', key: 'ssn' });
    expect(decideWrite(rule, undefined, [], 'card', {}, false)).toEqual({
      kind: 'fields',
      key: 'card',
      paths: ['number', 'cvc'],
    });
    expect(decideWrite(rule, undefined, [], 'name', 'Ada', false)).toBe(CLEAR);
  });

  it('a verdict marks nothing — the marks are step 4, after the write is staged', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    decideWrite(rule, undefined, [], 'ssn', '1', false);
    const inert = new RedactionRule();
    decideWrite(inert, undefined, [], 'pin', '0000', true);
    expect(rule.report().redactedKeys).toEqual([]);
    expect(inert.isInert()).toBe(true);
  });

  it('an object read under a whole-selected name, written under another, is whole there too', () => {
    const rule = new RedactionRule({ keys: ['profile'] });
    const profile = { name: 'Ada' };
    const selected = selectedAs(profile, { kind: 'whole', key: 'profile' });
    expect(decideWrite(rule, selected, [], 'person', profile, false)).toEqual({ kind: 'whole', key: 'person' });
    expect(rule.isKeyRedacted('person')).toBe(true); // the inheritance is decided here: the verdict needs it
  });

  it('a fields-selected read hands its fields to the new key, re-based under the written path', () => {
    const rule = new RedactionRule({ fields: { card: ['number'] } });
    const card = { number: '4242', owner: 'Ada' };
    const selected = selectedAs(card, { kind: 'fields', key: 'card', paths: ['number'] });
    expect(decideWrite(rule, selected, ['wallet'], 'primary', card, false)).toEqual({
      kind: 'fields',
      key: 'wallet',
      paths: ['number'],
    });
    expect(rule.report().fieldRedactions.wallet).toEqual(['primary.number']);
  });

  it('a primitive, a new object, or a write already whole is selected by its own name only', () => {
    const rule = new RedactionRule({ keys: ['profile', 'pin'] });
    const profile = { name: 'Ada' };
    const selected = selectedAs(profile, { kind: 'whole', key: 'profile' });
    expect(decideWrite(rule, selected, [], 'copy', { ...profile }, false)).toBe(CLEAR);
    expect(decideWrite(rule, selected, [], 'copy', 'Ada', false)).toBe(CLEAR);
    expect(decideWrite(rule, selected, [], 'pin', profile, false)).toEqual({ kind: 'whole', key: 'pin' });
    expect(rule.report().redactedKeys).toEqual([]); // no inheritance: a whole write needs none
  });
});

describe('scrubOf — step 3: the verdict’s bytes for the record', () => {
  it('nothing when clear, the whole value, or the fields inside it', () => {
    expect(scrubOf(CLEAR)).toBeUndefined();
    expect(scrubOf({ kind: 'whole', key: 'k' })).toEqual({ whole: true });
    expect(scrubOf({ kind: 'fields', key: 'card', paths: ['number'] })).toEqual({ fields: ['number'] });
  });

  it('every whole verdict is the same frozen scrub — no allocation per write', () => {
    const first = scrubOf({ kind: 'whole', key: 'a' });
    expect(scrubOf({ kind: 'whole', key: 'b' })).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
  });
});

describe('RedactionRule · markWritten — step 4: the run’s marks', () => {
  it('a whole verdict marks its key; a fields or clear one marks nothing', () => {
    const rule = new RedactionRule({ fields: { card: ['number'] } });
    rule.markWritten({ kind: 'fields', key: 'card', paths: ['number'] }, [], 'card', 'set');
    rule.markWritten(CLEAR, [], 'name', 'merge');
    expect(rule.report().redactedKeys).toEqual([]);
    rule.markWritten({ kind: 'whole', key: 'profile.auth' }, ['profile'], 'auth', 'set');
    expect(rule.report().redactedKeys).toEqual(['profile.auth']);
  });

  it('an explicit mark is what makes an inert rule active — the declare-once contract', () => {
    const rule = new RedactionRule();
    rule.markWritten({ kind: 'whole', key: 'pin' }, [], 'pin', 'set');
    expect(rule.isInert()).toBe(false);
    expect(decideWrite(rule, undefined, [], 'pin', '1111', false)).toEqual({ kind: 'whole', key: 'pin' });
  });

  it('a delete clears its key’s mark, whatever its verdict — a policy verdict survives it', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    rule.mark('pin');
    rule.mark('ssn');
    rule.markWritten({ kind: 'whole', key: 'pin' }, [], 'pin', 'delete');
    rule.markWritten({ kind: 'whole', key: 'ssn' }, [], 'ssn', 'delete');
    expect(rule.report().redactedKeys).toEqual([]);
    expect(rule.isKeyRedacted('ssn')).toBe(true); // the policy still names it
    expect(rule.isKeyRedacted('pin')).toBe(false);
  });
});

describe('the funnel — StageContext · stageWrite decides, stages the bytes, then marks', () => {
  /** A bare frame over `state` with `rule` installed; its commit lands on the log. */
  function frame(rule: RedactionRule, state?: Record<string, unknown>) {
    const heap = new SharedMemory(undefined, state);
    const log = new EventLog(heap.getState());
    const ctx = new StageContext('', 's', 's', heap, '', log);
    ctx.useRedactionRule(rule);
    return { ctx, log };
  }

  /** A value a merge cannot read: one of its getters throws. */
  function hostile(): object {
    return Object.defineProperty({ ok: 1 }, 'boom', {
      enumerable: true,
      get: () => {
        throw new Error('cannot read');
      },
    });
  }

  it('a staged explicit write is scrubbed in the log AND marked for the run', () => {
    const rule = new RedactionRule();
    const { ctx, log } = frame(rule);
    expect(ctx.setObject([], 'pin', '0000', true)).toEqual({ kind: 'whole', key: 'pin' });
    ctx.commit();
    expect(log.list()[0].overwrite).toEqual({ pin: 'REDACTED' });
    expect(rule.report().redactedKeys).toEqual(['pin']);
  });

  it('a write that fails to stage marks nothing — the merge of a value it cannot read', () => {
    const rule = new RedactionRule();
    const { ctx } = frame(rule);
    expect(() => ctx.merge([], 'pin', hostile(), true)).toThrow('cannot read');
    expect(rule.isInert()).toBe(true);
    expect(rule.report().redactedKeys).toEqual([]);
  });

  it('…and a nested write through a held value nothing can clone', () => {
    const rule = new RedactionRule();
    const { ctx } = frame(rule);
    ctx.setObject([], 'held', { fn: () => 1 });
    expect(() => ctx.setObject(['held'], 'x', 1, true)).toThrow();
    expect(rule.isKeyRedacted('held.x')).toBe(false);
    expect(rule.isInert()).toBe(true);
  });

  it('an identity inheritance is decided before the write, so it stays when the write fails to stage', () => {
    const rule = new RedactionRule({ keys: ['profile'] });
    const { ctx } = frame(rule, { profile: { name: 'Ada' } });
    const profile = ctx.getValue([], 'profile'); // a read under a selected name
    ctx.setObject([], 'held', { fn: () => 1 });
    expect(() => ctx.setObject(['held'], 'p', profile)).toThrow();
    expect(rule.isKeyRedacted('held.p')).toBe(true); // the verdict needed it; the write's own mark never came
  });

  it('a delete that stages clears the key’s per-call mark', () => {
    const rule = new RedactionRule();
    const { ctx } = frame(rule);
    ctx.setObject([], 'pin', '0000', true);
    ctx.setObject([], 'pin', undefined, false, undefined, 'delete');
    expect(rule.isKeyRedacted('pin')).toBe(false);
    expect(ctx.setObject([], 'pin', '1111')).toBe(CLEAR); // clear again after the delete
  });
});
