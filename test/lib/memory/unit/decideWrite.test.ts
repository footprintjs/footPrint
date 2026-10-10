/**
 * The write decision (C4, `memory/redaction.ts`): the engine decides, the record writes the bytes. Its
 * functions on their own — no engine, no record frame — and then the funnel that composes them
 * (`StageContext · stageWrite`), in the order the record needs:
 *
 *   1  decideWrite        the verdict: an explicit flag → whole; else the ACTIVE rule; none → clear
 *   2  inheritByIdentity  an object read under a selected name, written under another, keeps that read's
 *                         rule — against the selected reads as they stand after step 1
 *   3  scrubOf            the verdict's bytes for `RecordFrame · write`: `{ whole }`, `{ fields }`, nothing
 *   4  markStagedWrite    the run's marks, once the write staged: a delete unmarks on the rule active as the
 *                         write began; a whole verdict marks its deciding key on the run's rule as it is now
 *
 * The funnel cases pin what user code running DURING a write sees — the same as before C4 (each step reads
 * the rule, and step 2 the selected reads, when it acts).
 */
import { EventLog } from 'foottrace/write';
import { SharedMemory } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import {
  type RedactionVerdict,
  CLEAR,
  decideWrite,
  inheritByIdentity,
  markStagedWrite,
  RedactionRule,
  scrubOf,
} from '../../../../src/lib/memory/redaction';
import { StageContext } from '../../../../src/lib/memory/StageContext';

/** The frame's selected reads: each object → the verdict of the name it was read under. */
const selectedAs = (value: object, verdict: RedactionVerdict) =>
  new WeakMap<object, RedactionVerdict>([[value, verdict]]);

describe('decideWrite — step 1: the verdict', () => {
  it('no active rule: clear; an explicit flag is whole under its user-level key, rule or none', () => {
    expect(decideWrite(undefined, [], 'k', undefined)).toBe(CLEAR);
    expect(decideWrite(undefined, [], 'pin', true)).toEqual({ kind: 'whole', key: 'pin' });
    expect(decideWrite(undefined, ['profile'], 'auth', true)).toEqual({ kind: 'whole', key: 'profile.auth' });
  });

  it('else the active rule decides from the path: a key is whole, declared fields are fields, anything else clear', () => {
    const rule = new RedactionRule({ keys: ['ssn'], fields: { card: ['number', 'cvc'] } });
    expect(decideWrite(rule, [], 'ssn', false)).toEqual({ kind: 'whole', key: 'ssn' });
    expect(decideWrite(rule, [], 'card', false)).toEqual({ kind: 'fields', key: 'card', paths: ['number', 'cvc'] });
    expect(decideWrite(rule, ['profile'], 'ssn', false)).toBe(CLEAR); // `profile.ssn` is not `ssn`
    expect(decideWrite(rule, [], 'name', false)).toBe(CLEAR);
  });

  it('marks nothing — the marks are step 4, after the write is staged', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    decideWrite(rule, [], 'ssn', false);
    decideWrite(rule, [], 'pin', true);
    expect(rule.report().redactedKeys).toEqual([]);
  });
});

describe('inheritByIdentity — step 2: an object read under a selected name keeps that rule', () => {
  it('a whole-selected read makes the new key whole, and marks it (the verdict needs the mark)', () => {
    const rule = new RedactionRule({ keys: ['profile'] });
    const profile = { name: 'Ada' };
    const selected = selectedAs(profile, { kind: 'whole', key: 'profile' });
    expect(inheritByIdentity(rule, CLEAR, selected, [], 'person', profile)).toEqual({ kind: 'whole', key: 'person' });
    expect(rule.isKeyRedacted('person')).toBe(true);
  });

  it('a fields-selected read hands its fields to the new key, re-based under the written path', () => {
    const rule = new RedactionRule({ fields: { card: ['number'] } });
    const card = { number: '4242', owner: 'Ada' };
    const selected = selectedAs(card, { kind: 'fields', key: 'card', paths: ['number'] });
    expect(inheritByIdentity(rule, CLEAR, selected, ['wallet'], 'primary', card)).toEqual({
      kind: 'fields',
      key: 'wallet',
      paths: ['number'],
    });
    expect(rule.report().fieldRedactions.wallet).toEqual(['primary.number']);
  });

  it('a primitive, a new object, a write already whole, or no active rule: the verdict comes back as it is', () => {
    const rule = new RedactionRule({ keys: ['profile', 'pin'] });
    const profile = { name: 'Ada' };
    const selected = selectedAs(profile, { kind: 'whole', key: 'profile' });
    const whole: RedactionVerdict = { kind: 'whole', key: 'pin' };
    expect(inheritByIdentity(rule, CLEAR, selected, [], 'copy', { ...profile })).toBe(CLEAR);
    expect(inheritByIdentity(rule, CLEAR, selected, [], 'copy', 'Ada')).toBe(CLEAR);
    expect(inheritByIdentity(rule, whole, selected, [], 'pin', profile)).toBe(whole);
    expect(inheritByIdentity(undefined, CLEAR, selected, [], 'copy', profile)).toBe(CLEAR);
    expect(rule.report().redactedKeys).toEqual([]);
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

describe('markStagedWrite — step 4: the run’s marks, once the write staged', () => {
  it('a whole verdict marks the key that DECIDED it — an ancestor for a nested write; fields or clear mark nothing', () => {
    const rule = new RedactionRule({ fields: { card: ['number'] } });
    markStagedWrite(rule, rule, { kind: 'fields', key: 'card', paths: ['number'] }, [], 'card', 'set');
    markStagedWrite(rule, rule, CLEAR, [], 'name', 'merge');
    expect(rule.report().redactedKeys).toEqual([]);
    markStagedWrite(rule, rule, { kind: 'whole', key: 'profile' }, ['profile'], 'auth', 'set');
    expect(rule.report().redactedKeys).toEqual(['profile']); // not 'profile.auth'
  });

  it('marks on the run’s rule as it is now — an explicit mark is what makes an inert rule active', () => {
    const rule = new RedactionRule();
    markStagedWrite(undefined, rule, { kind: 'whole', key: 'pin' }, [], 'pin', 'set');
    expect(rule.isInert()).toBe(false);
    expect(rule.isKeyRedacted('pin')).toBe(true);
  });

  it('a delete clears its key’s mark on the rule active as the write began — none, when it was inert', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    rule.mark('pin');
    rule.mark('ssn');
    markStagedWrite(rule, rule, { kind: 'whole', key: 'pin' }, [], 'pin', 'delete');
    markStagedWrite(rule, rule, { kind: 'whole', key: 'ssn' }, [], 'ssn', 'delete');
    expect(rule.report().redactedKeys).toEqual([]);
    expect(rule.isKeyRedacted('ssn')).toBe(true); // the policy still names it
    const later = new RedactionRule();
    later.mark('box');
    markStagedWrite(undefined, later, CLEAR, [], 'box', 'delete');
    expect(later.isKeyRedacted('box')).toBe(true);
  });
});

describe('the funnel — StageContext · stageWrite decides, stages the bytes, then marks', () => {
  /** A bare frame over `state`, with `rule` installed when given; its commits land on the log. */
  function frame(rule?: RedactionRule, state?: Record<string, unknown>) {
    const heap = new SharedMemory(undefined, state);
    const log = new EventLog(heap.getState());
    const ctx = new StageContext('', 's', 's', heap, '', log);
    if (rule) ctx.useRedactionRule(rule);
    return { ctx, log, heap };
  }

  /** A value with one enumerable getter that runs `effect` the first time it is read. */
  function withGetter(effect: () => unknown): Record<string, unknown> {
    let fired = false;
    return Object.defineProperty({}, 'g', {
      enumerable: true,
      get: () => {
        if (!fired) {
          fired = true;
          effect();
        }
        return 1;
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

  it('a nested write under a whole-selected key marks that key, not the nested path', () => {
    const rule = new RedactionRule({ keys: ['profile'] });
    const { ctx } = frame(rule);
    expect(ctx.setObject(['profile'], 'auth', 'tok')).toEqual({ kind: 'whole', key: 'profile' });
    expect(rule.report().redactedKeys).toEqual(['profile']);
  });

  it('a write that fails to stage marks nothing — the merge of a value it cannot read', () => {
    const rule = new RedactionRule();
    const { ctx } = frame(rule);
    const unreadable = withGetter(() => {
      throw new Error('cannot read');
    });
    expect(() => ctx.merge([], 'pin', unreadable, true)).toThrow('cannot read');
    expect(rule.isInert()).toBe(true);
  });

  it('…and a nested write through a held value nothing can clone', () => {
    const rule = new RedactionRule();
    const { ctx } = frame(rule);
    ctx.setObject([], 'held', { fn: () => 1 });
    expect(() => ctx.setObject(['held'], 'x', 1, true)).toThrow();
    expect(rule.isInert()).toBe(true);
  });

  it('an identity inheritance is decided before the write, so it stays when the write fails to stage', () => {
    const rule = new RedactionRule({ keys: ['profile'] });
    const { ctx } = frame(rule, { profile: { name: 'Ada' } });
    const profile = ctx.getValue([], 'profile'); // a read under a selected name
    ctx.setObject([], 'held', { fn: () => 1 });
    expect(() => ctx.setObject(['held'], 'p', profile)).toThrow();
    expect(rule.isKeyRedacted('held.p')).toBe(true);
  });

  it('a delete that stages clears the key’s per-call mark', () => {
    const rule = new RedactionRule();
    const { ctx } = frame(rule);
    ctx.setObject([], 'pin', '0000', true);
    ctx.setObject([], 'pin', undefined, false, undefined, 'delete');
    expect(rule.isKeyRedacted('pin')).toBe(false);
    expect(ctx.setObject([], 'pin', '1111')).toBe(CLEAR);
  });

  // User code that runs DURING a write — a getter on the value, a pattern's `test` — sees what it saw before C4.

  it('a rule installed during a write takes that write’s whole mark (the mark reads the rule after staging)', () => {
    const { ctx } = frame();
    const late = new RedactionRule();
    ctx.updateObject(
      [],
      'k',
      withGetter(() => ctx.useRedactionRule(late)),
      undefined,
      true,
    );
    expect(late.isKeyRedacted('k')).toBe(true);
  });

  it('a delete that began under an inert rule unmarks nothing, even a mark made during it', () => {
    const rule = new RedactionRule();
    const { ctx } = frame(rule);
    // the nested delete clones the held `box`, which runs its getter: an explicit write of the same key
    ctx.setObject(
      [],
      'box',
      withGetter(() => ctx.setObject(['box'], 'x', 'secret-1', true)),
    );
    ctx.setObject(['box'], 'x', undefined, false, undefined, 'delete');
    expect(rule.isKeyRedacted('box.x')).toBe(true);
  });

  it('identity is asked against the selected reads as they stand after the verdict — a pattern can read', () => {
    const { ctx, log, heap } = frame(undefined, { secret: { pin: '1234' } });
    let inTest = false;
    const readsWhileTesting = {
      global: false,
      sticky: false,
      lastIndex: 0,
      source: 'reads',
      test: (name: string) => {
        if (!inTest && name === 'copy') {
          inTest = true;
          ctx.getValue([], 'secret'); // a tracked read of a selected key, during the verdict
          inTest = false;
        }
        return false;
      },
    } as unknown as RegExp;
    const rule = new RedactionRule({ keys: ['secret'], patterns: [readsWhileTesting] });
    ctx.useRedactionRule(rule);
    ctx.setObject([], 'copy', heap.getState().secret); // the very object that read selected
    ctx.commit();
    expect(log.list()[0].overwrite).toEqual({ copy: 'REDACTED' });
    expect(rule.report().redactedKeys).toEqual(['copy']);
  });
});
