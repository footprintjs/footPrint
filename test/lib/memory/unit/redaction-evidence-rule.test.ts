/**
 * The law of what a stage's own code made: `RedactionRule · servesThreshold` (one function, every condition row) and
 * `retainStageText` (a rule's thrown text, a break reason, an idempotency key). Each clause on its own, so a test goes
 * red if any clause is lost.
 *
 * Test types: Unit (each clause) · Boundary (an inert rule reads nothing; a value whose keys cannot be read) · Security
 * (a threshold that holds a selected name at any depth).
 */
import { describe, expect, it } from 'vitest';

import { RedactionRule, SCOPE_PLACEHOLDER, useWalkLimit } from '../../../../src/lib/memory/redaction.js';

const NO_SOURCES = {};

describe('RedactionRule · holdsSelected', () => {
  it('a selected name at any depth, a mark, or a declared field that is present', () => {
    const rule = new RedactionRule({ keys: ['ssn'], fields: { patient: ['dob'] } });
    expect(rule.holdsSelected([], { ssn: 'x' })).toBe(true);
    expect(rule.holdsSelected([], { a: [{ ssn: 'x' }] })).toBe(true);
    expect(rule.holdsSelected([], { patient: { dob: 'x' } })).toBe(true);
    rule.mark('later');
    expect(rule.holdsSelected([], { later: 1 })).toBe(true);
  });

  it('nothing selected is present: a declared field that is absent, an absent key, a scalar', () => {
    const rule = new RedactionRule({ keys: ['ssn'], fields: { patient: ['dob'] } });
    expect(rule.holdsSelected([], { score: 700 })).toBe(false);
    expect(rule.holdsSelected([], { patient: { name: 'A' } })).toBe(false);
    expect(rule.holdsSelected([], {})).toBe(false);
    expect(rule.holdsSelected([], 700)).toBe(false);
    expect(rule.holdsSelected([], null)).toBe(false);
  });

  it('under a path: the path is selected, or a rule dotted under it reaches inside', () => {
    expect(new RedactionRule({ keys: ['a'] }).holdsSelected(['a'], 700)).toBe(true);
    expect(new RedactionRule({ keys: ['a.ssn'] }).holdsSelected(['a'], { ssn: 'x' })).toBe(true);
    expect(new RedactionRule({ keys: ['a.ssn'] }).holdsSelected(['b'], { ssn: 'x' })).toBe(false);
  });

  it('a value whose keys cannot be read is taken to hold one, never a throw', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(new RedactionRule({ keys: ['ssn'] }).holdsSelected([], proxy)).toBe(true);
  });
});

describe('RedactionRule · servesThreshold', () => {
  it('serves everything under an inert rule, and reads nothing', () => {
    const rule = new RedactionRule();
    const threshold = {
      get ssn() {
        throw new Error('an inert rule must not read this');
      },
    };
    expect(rule.servesThreshold('ssn', threshold, { selectedReads: 5, input: threshold })).toBe(true);
    expect(new RedactionRule({ keys: [] }).servesThreshold('ssn', 'x', NO_SOURCES)).toBe(true);
  });

  it('NAME: the key verdict decides, whole or fields', () => {
    expect(new RedactionRule({ keys: ['ssn'] }).servesThreshold('ssn', 'x', NO_SOURCES)).toBe(false);
    expect(new RedactionRule({ patterns: [/^ss/] }).servesThreshold('ssn', 'x', NO_SOURCES)).toBe(false);
    expect(new RedactionRule({ fields: { patient: ['ssn'] } }).servesThreshold('patient', 'x', NO_SOURCES)).toBe(false);
    const marked = new RedactionRule();
    marked.mark('ssn');
    expect(marked.servesThreshold('ssn', 'x', NO_SOURCES)).toBe(false);
  });

  it('NAME: a key the policy does not select is served', () => {
    const rule = new RedactionRule({ keys: ['ssn'], fields: { patient: ['ssn'] } });
    expect(rule.servesThreshold('amount', 100, NO_SOURCES)).toBe(true);
  });

  it('SOURCES: a selected read on the frame hides it', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    expect(rule.servesThreshold('amount', 100, { selectedReads: 0 })).toBe(true);
    expect(rule.servesThreshold('amount', 100, { selectedReads: 1 })).toBe(false);
  });

  it('SOURCES: args holding a selected key at any depth hide it; args that hold none do not', () => {
    const rule = new RedactionRule({ keys: ['ssn'], fields: { patient: ['dob'] } });
    expect(rule.servesThreshold('amount', 100, { input: { ssn: 'x' } })).toBe(false);
    expect(rule.servesThreshold('amount', 100, { input: { a: [{ b: { ssn: 'x' } }] } })).toBe(false);
    expect(rule.servesThreshold('amount', 100, { input: { patient: { dob: 'x' } } })).toBe(false);
    expect(rule.servesThreshold('amount', 100, { input: { region: 'west', patient: { name: 'A' } } })).toBe(true);
    expect(rule.servesThreshold('amount', 100, { input: 'a scalar has no names' })).toBe(true);
  });

  it('SHAPE: a threshold holding a selected name at any depth hides it', () => {
    const rule = new RedactionRule({ keys: ['ssn'], fields: { patient: ['dob'] } });
    expect(rule.servesThreshold('other', { ssn: 'x' }, NO_SOURCES)).toBe(false);
    expect(rule.servesThreshold('other', [{ deep: { ssn: 'x' } }], NO_SOURCES)).toBe(false);
    expect(rule.servesThreshold('other', { patient: { dob: 'x' } }, NO_SOURCES)).toBe(false);
    expect(rule.servesThreshold('other', { name: 'A' }, NO_SOURCES)).toBe(true);
    expect(rule.servesThreshold('other', ['x', 'y'], NO_SOURCES)).toBe(true);
  });

  it('SHAPE: a dotted rule reaches a threshold under its own key, and not under another', () => {
    const rule = new RedactionRule({ keys: ['patient.ssn'] });
    expect(rule.servesThreshold('patient', { ssn: 'x' }, NO_SOURCES)).toBe(false);
    expect(rule.servesThreshold('other', { ssn: 'x' }, NO_SOURCES)).toBe(true);
    const pathPattern = new RedactionRule({ patterns: [/^patient\.ssn$/] });
    expect(pathPattern.servesThreshold('patient', { ssn: 'x' }, NO_SOURCES)).toBe(false);
  });

  it('SHAPE: a value that keeps content no key shows is a hole, at any depth', () => {
    const rule = new RedactionRule({ keys: ['nothing-here'] });
    class Holder {}
    for (const value of [
      new Map(),
      new Set(),
      new WeakMap(),
      /x/,
      new Error('x'),
      new String('x'),
      new Holder(),
      Object.create({ ssn: 'x' }),
      new ArrayBuffer(1),
      new Uint8Array(1),
      new DataView(new ArrayBuffer(1)),
      () => 'x',
      Promise.resolve(),
      new Proxy(new Map(), {}),
      new (class Pile extends Array {})(),
      Object.create(Array.prototype),
    ]) {
      expect(rule.servesThreshold('other', value, NO_SOURCES)).toBe(false);
      expect(rule.servesThreshold('other', [value], NO_SOURCES)).toBe(false);
      expect(rule.servesThreshold('other', { deep: [{ deeper: value }] }, NO_SOURCES)).toBe(false);
    }
  });

  it('SHAPE: only a primitive, a plain object, a list and a Date are walked and served', () => {
    const rule = new RedactionRule({ keys: ['nothing-here'] });
    const loop: Record<string, unknown> = { name: 'A' };
    loop.self = loop;
    for (const value of [
      'x',
      1,
      10n,
      true,
      null,
      undefined,
      Symbol.for('x'),
      ['x'],
      { name: 'A' },
      Object.create(null),
      Object.freeze({ name: 'A' }),
      new Date(0),
      new Date(Number.NaN),
      [new Date(0)],
      { deep: [new Date(0)] },
      loop,
    ]) {
      expect(rule.servesThreshold('other', value, NO_SOURCES)).toBe(true);
    }
  });

  it('SHAPE: a Date is known by its slot, not its prototype or its tag', () => {
    const rule = new RedactionRule({ keys: ['nothing-here'] });
    class Later extends Date {}
    expect(rule.servesThreshold('other', Object.create(Date.prototype), NO_SOURCES)).toBe(false);
    expect(rule.servesThreshold('other', new Later(0), NO_SOURCES)).toBe(false);
    expect(rule.servesThreshold('other', { [Symbol.toStringTag]: 'Date' }, NO_SOURCES)).toBe(true);
    expect(rule.servesThreshold('other', new Proxy(new Date(0), {}), NO_SOURCES)).toBe(false);
    expect(rule.servesThreshold('other', Object.assign(new Date(0), { note: new Map() }), NO_SOURCES)).toBe(false);
  });

  it('SHAPE: an inert rule never asks, so a Map stays', () => {
    expect(new RedactionRule().servesThreshold('other', new Map(), NO_SOURCES)).toBe(true);
    expect(new RedactionRule({ emitPatterns: [/x/] }).servesThreshold('other', new Map(), NO_SOURCES)).toBe(true);
  });

  it('SHAPE: names are own enumerable keys, so a hidden or symbol key is not seen', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    const hidden = Object.defineProperty({}, 'ssn', { value: 'x', enumerable: false });
    expect(rule.servesThreshold('other', hidden, NO_SOURCES)).toBe(true);
    expect(rule.servesThreshold('other', { [Symbol.for('ssn')]: 'x' }, NO_SOURCES)).toBe(true);
  });

  it('SHAPE: a walk past its limit serves a hole, and a deep value never overflows', () => {
    const rule = new RedactionRule({ keys: ['nothing-here'] });
    const restore = useWalkLimit(3);
    try {
      expect(rule.servesThreshold('other', [[[[['x']]]]], NO_SOURCES)).toBe(false);
    } finally {
      restore();
    }
    let deep: unknown = 'x';
    for (let i = 0; i < 200_000; i++) deep = [deep];
    expect(rule.servesThreshold('other', deep, NO_SOURCES)).toBe(false);
  });

  it('a threshold whose keys cannot be read is served as a hole, never a throw', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('no');
        },
      },
    );
    expect(rule.servesThreshold('other', hostile, NO_SOURCES)).toBe(false);
  });

  it('a cyclic threshold ends', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    const cycle: Record<string, unknown> = { name: 'A' };
    cycle.self = cycle;
    expect(rule.servesThreshold('other', cycle, NO_SOURCES)).toBe(true);
  });
});

describe('RedactionRule · retainStageText', () => {
  const address = ['logs', 'breakReason'];

  it('returns the text under an inert rule', () => {
    expect(new RedactionRule().retainStageText(address, 'text', { selectedReads: 3 })).toBe('text');
  });

  it('the placeholder when a source is selected', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    expect(rule.retainStageText(address, 'text', { selectedReads: 1 })).toBe(SCOPE_PLACEHOLDER);
    expect(rule.retainStageText(address, 'text', { input: { ssn: 'x' } })).toBe(SCOPE_PLACEHOLDER);
    expect(rule.retainStageText(address, 'text', { input: { region: 'west' } })).toBe('text');
  });

  it('the placeholder when its own name is selected, by a state rule or a diagnostic selector', () => {
    expect(new RedactionRule({ keys: ['breakReason'] }).retainStageText(address, 'text', NO_SOURCES)).toBe(
      SCOPE_PLACEHOLDER,
    );
    expect(
      new RedactionRule({ diagnostics: { keys: ['logs.breakReason'] } }).retainStageText(address, 'text', NO_SOURCES),
    ).toBe(SCOPE_PLACEHOLDER);
  });

  it('a diagnostic-only policy has no state sources to taint', () => {
    const rule = new RedactionRule({ diagnostics: { keys: ['logs.absent'] } });
    expect(rule.retainStageText(address, 'text', { selectedReads: 2, input: { ssn: 'x' } })).toBe('text');
  });

  it('a non-string a JavaScript caller passed is described without throwing', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    const nullProto = Object.create(null) as object;
    expect(typeof rule.retainStageText(address, nullProto as unknown as string, NO_SOURCES)).toBe('string');
  });

  it('retainIdempotencyKey is this law at its own name', () => {
    const rule = new RedactionRule({ keys: ['idempotencyKey'] });
    expect(rule.retainIdempotencyKey('order-1', NO_SOURCES)).toBe(SCOPE_PLACEHOLDER);
    const other = new RedactionRule({ keys: ['ssn'] });
    expect(other.retainIdempotencyKey('order-1', NO_SOURCES)).toBe('order-1');
    expect(other.retainIdempotencyKey('order-1', { selectedReads: 1 })).toBe(SCOPE_PLACEHOLDER);
  });
});

describe('RedactionRule · evidenceRule', () => {
  it('asks the sources at each question, so a read between two questions counts', () => {
    let selectedReads = 0;
    const answers = new RedactionRule({ keys: ['ssn'] }).evidenceRule(() => ({ selectedReads }));
    expect(answers.servesThreshold('amount', 1)).toBe(true);
    expect(answers.servedMatchError('text')).toBe('text');
    selectedReads = 1;
    expect(answers.servesThreshold('amount', 1)).toBe(false);
    expect(answers.servedMatchError('text')).toBe(SCOPE_PLACEHOLDER);
  });

  it('masksActual speaks for the verdict: whole or fields', () => {
    const answers = new RedactionRule({ keys: ['ssn'], fields: { patient: ['dob'] } }).evidenceRule(() => NO_SOURCES);
    expect(answers.masksActual('ssn')).toBe(true);
    expect(answers.masksActual('patient')).toBe(true);
    expect(answers.masksActual('amount')).toBe(false);
  });

  it('matchError has its own name: errors.matchError', () => {
    const answers = new RedactionRule({ diagnostics: { keys: ['errors.matchError'] } }).evidenceRule(() => NO_SOURCES);
    expect(answers.servedMatchError('text')).toBe(SCOPE_PLACEHOLDER);
  });

  it('a mark made after the answers were handed out counts: they read the rule live', () => {
    const rule = new RedactionRule();
    const answers = rule.evidenceRule(() => NO_SOURCES);
    expect(answers.servesThreshold('ssn', 'x')).toBe(true);
    rule.mark('ssn');
    expect(answers.servesThreshold('ssn', 'x')).toBe(false);
    expect(answers.masksActual('ssn')).toBe(true);
  });
});
