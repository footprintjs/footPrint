/**
 * The law of what a stage's own code made: `RedactionRule · serveThreshold` (one function, every condition row) and
 * `retainStageText` (a rule's thrown text, a break reason, an idempotency key). Each clause on its own, so a test goes
 * red if any clause is lost.
 *
 * Test types: Unit (each clause) · Boundary (an inert rule reads nothing; a value whose keys cannot be read) · Security
 * (a threshold that holds a selected name at any depth; one read, and nothing the copy cannot hold).
 */
import { describe, expect, it } from 'vitest';

import type { StageSources } from '../../../../src/lib/memory/redaction.js';
import {
  RedactionRule,
  SCOPE_PLACEHOLDER,
  THRESHOLD_HOLE,
  useWalkLimit,
} from '../../../../src/lib/memory/redaction.js';

const NO_SOURCES = {};

/** Is it a value, not a hole? */
function serves(rule: RedactionRule, key: string, threshold: unknown, sources: StageSources = NO_SOURCES): boolean {
  const served = rule.serveThreshold(key, threshold, sources);
  if (served.thresholdRedacted) expect(served).toBe(THRESHOLD_HOLE);
  return served.thresholdRedacted !== true;
}

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

describe('RedactionRule · serveThreshold', () => {
  it('a list is a hole unless its keys are exactly its dense indexes: a named key cannot stand in for a gap', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    const gapAndName = Object.assign(new Array(2), { note: 'benign' });
    gapAndName[0] = 'visible';
    expect(serves(rule, 'other', gapAndName)).toBe(false);
    expect(serves(rule, 'other', Object.assign(['a', 'b'], { note: 'benign' }))).toBe(false);
    expect(serves(rule, 'other', new Array(1))).toBe(false);
    expect(rule.serveThreshold('other', ['a', 'b'], NO_SOURCES).threshold).toEqual(['a', 'b']);
    expect(rule.serveThreshold('other', [], NO_SOURCES).threshold).toEqual([]);
  });

  it('keeps the value itself under an inert rule, and reads nothing', () => {
    const rule = new RedactionRule();
    const threshold = {
      get ssn() {
        throw new Error('an inert rule must not read this');
      },
    };
    expect(rule.serveThreshold('ssn', threshold, { selectedReads: 5, input: threshold }).threshold).toBe(threshold);
    expect(Object.isFrozen(threshold)).toBe(false);
    expect(serves(new RedactionRule({ keys: [] }), 'ssn', 'x', NO_SOURCES)).toBe(true);
  });

  it('NAME: the key verdict decides, whole or fields', () => {
    expect(serves(new RedactionRule({ keys: ['ssn'] }), 'ssn', 'x', NO_SOURCES)).toBe(false);
    expect(serves(new RedactionRule({ patterns: [/^ss/] }), 'ssn', 'x', NO_SOURCES)).toBe(false);
    expect(serves(new RedactionRule({ fields: { patient: ['ssn'] } }), 'patient', 'x', NO_SOURCES)).toBe(false);
    const marked = new RedactionRule();
    marked.mark('ssn');
    expect(serves(marked, 'ssn', 'x', NO_SOURCES)).toBe(false);
  });

  it('NAME: a key the policy does not select is served', () => {
    const rule = new RedactionRule({ keys: ['ssn'], fields: { patient: ['ssn'] } });
    expect(serves(rule, 'amount', 100, NO_SOURCES)).toBe(true);
  });

  it('SOURCES: a selected read on the frame hides it', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    expect(serves(rule, 'amount', 100, { selectedReads: 0 })).toBe(true);
    expect(serves(rule, 'amount', 100, { selectedReads: 1 })).toBe(false);
  });

  it('SOURCES: args holding a selected key at any depth hide it; args that hold none do not', () => {
    const rule = new RedactionRule({ keys: ['ssn'], fields: { patient: ['dob'] } });
    expect(serves(rule, 'amount', 100, { input: { ssn: 'x' } })).toBe(false);
    expect(serves(rule, 'amount', 100, { input: { a: [{ b: { ssn: 'x' } }] } })).toBe(false);
    expect(serves(rule, 'amount', 100, { input: { patient: { dob: 'x' } } })).toBe(false);
    expect(serves(rule, 'amount', 100, { input: { region: 'west', patient: { name: 'A' } } })).toBe(true);
    expect(serves(rule, 'amount', 100, { input: 'a scalar has no names' })).toBe(true);
  });

  it('SHAPE: a threshold holding a selected name at any depth hides it', () => {
    const rule = new RedactionRule({ keys: ['ssn'], fields: { patient: ['dob'] } });
    expect(serves(rule, 'other', { ssn: 'x' }, NO_SOURCES)).toBe(false);
    expect(serves(rule, 'other', [{ deep: { ssn: 'x' } }], NO_SOURCES)).toBe(false);
    expect(serves(rule, 'other', { patient: { dob: 'x' } }, NO_SOURCES)).toBe(false);
    expect(serves(rule, 'other', { name: 'A' }, NO_SOURCES)).toBe(true);
    expect(serves(rule, 'other', ['x', 'y'], NO_SOURCES)).toBe(true);
  });

  it('SHAPE: a dotted rule reaches a threshold under its own key, and not under another', () => {
    const rule = new RedactionRule({ keys: ['patient.ssn'] });
    expect(serves(rule, 'patient', { ssn: 'x' }, NO_SOURCES)).toBe(false);
    expect(serves(rule, 'other', { ssn: 'x' }, NO_SOURCES)).toBe(true);
    const pathPattern = new RedactionRule({ patterns: [/^patient\.ssn$/] });
    expect(serves(pathPattern, 'patient', { ssn: 'x' }, NO_SOURCES)).toBe(false);
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
      Object('x'),
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
      expect(serves(rule, 'other', value, NO_SOURCES)).toBe(false);
      expect(serves(rule, 'other', [value], NO_SOURCES)).toBe(false);
      expect(serves(rule, 'other', { deep: [{ deeper: value }] }, NO_SOURCES)).toBe(false);
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
      expect(serves(rule, 'other', value, NO_SOURCES)).toBe(true);
    }
  });

  it('SHAPE: a Date is known by its slot, not its prototype or its tag', () => {
    const rule = new RedactionRule({ keys: ['nothing-here'] });
    class Later extends Date {}
    expect(serves(rule, 'other', Object.create(Date.prototype), NO_SOURCES)).toBe(false);
    expect(serves(rule, 'other', new Later(0), NO_SOURCES)).toBe(false);
    expect(serves(rule, 'other', { [Symbol.toStringTag]: 'Date' }, NO_SOURCES)).toBe(false);
    expect(serves(rule, 'other', new Proxy(new Date(0), {}), NO_SOURCES)).toBe(false);
    expect(serves(rule, 'other', Object.assign(new Date(0), { note: new Map() }), NO_SOURCES)).toBe(false);
  });

  it('ONE READ: a getter is a hole and never runs', () => {
    let looks = 0;
    const getter = {
      get value() {
        looks += 1;
        return 1;
      },
    };
    expect(serves(new RedactionRule({ keys: ['nothing-here'] }), 'other', getter, NO_SOURCES)).toBe(false);
    expect(looks).toBe(0);
  });

  it('ONE READ: the row keeps a detached frozen copy, not the value', () => {
    const rule = new RedactionRule({ keys: ['nothing-here'] });
    const threshold = { name: 'A', deep: [{ row: 1 }], when: new Date(0) };
    const copy = rule.serveThreshold('other', threshold, NO_SOURCES).threshold as typeof threshold;
    expect(copy).toEqual(threshold);
    expect(copy).not.toBe(threshold);
    expect(copy.deep[0]).not.toBe(threshold.deep[0]);
    expect(copy.when).not.toBe(threshold.when);
    for (const part of [copy, copy.deep, copy.deep[0], copy.when]) expect(Object.isFrozen(part)).toBe(true);
    expect(Object.isFrozen(threshold)).toBe(false);
    (threshold.deep[0] as Record<string, unknown>).ssn = 'x';
    expect(copy.deep[0]).toEqual({ row: 1 });
  });

  it('ONE READ: the check looks at the copy, so what it saw is what is kept', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    const threshold = { deep: { ssn: 'x' } };
    expect(rule.serveThreshold('other', threshold, NO_SOURCES)).toBe(THRESHOLD_HOLE);
    // What was asked about differs from what was read: only the copy says what the row would keep.
    const handle = { name: 'A' };
    const state = { ssn: 'x' };
    expect(rule.serveThreshold('other', handle, NO_SOURCES, () => state)).toBe(THRESHOLD_HOLE);
  });

  it('ONE READ: a primitive is its own copy', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    for (const value of ['x', 1, 10n, true, null, undefined]) {
      expect(rule.serveThreshold('other', value, NO_SOURCES)).toEqual({ threshold: value });
    }
  });

  it('ONE READ: shared values and cycles keep their shape, and a DAG stays linear', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    const shared = { name: 'A' };
    const copy = rule.serveThreshold('other', [shared, shared], NO_SOURCES).threshold as unknown[];
    expect(copy[0]).toBe(copy[1]);
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    const held = rule.serveThreshold('other', loop, NO_SOURCES).threshold as Record<string, unknown>;
    expect(held.self).toBe(held);
    let dag: unknown = 'x';
    for (let i = 0; i < 64; i++) dag = [dag, dag];
    expect(serves(rule, 'other', dag)).toBe(true);
  });

  it('ONE READ: an own `__proto__` key stays a key', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    const copy = rule.serveThreshold('other', JSON.parse('{"__proto__":{"a":1}}'), NO_SOURCES).threshold as object;
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.hasOwn(copy, '__proto__')).toBe(true);
  });

  it('ONE READ: a name selected only behind an own `__proto__` key is still found', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    expect(serves(rule, 'other', JSON.parse('{"__proto__":{"ssn":"x"}}'))).toBe(false);
  });

  it('ONE READ: what the copy cannot hold faithfully is a hole', () => {
    const rule = new RedactionRule({ keys: ['nothing-here'] });
    const sparse: unknown[] = [];
    sparse[2] = 'x';
    for (const value of [
      Symbol.for('x'),
      { limit: Symbol.for('x') },
      sparse,
      new Array(2 ** 32 - 1),
      Object.assign(['a'], { named: 1 }),
      Object.defineProperty(['a'], 'hidden', { value: 1 }),
      Object.setPrototypeOf(['a'], Object.prototype),
      Object.setPrototypeOf({}, Array.prototype),
      // eslint-disable-next-line accessor-pairs -- the shape under test: a setter with no getter.
      Object.defineProperty({}, 'set', { set: () => undefined, enumerable: true }),
    ]) {
      expect(serves(rule, 'other', value)).toBe(false);
      expect(serves(rule, 'other', [value])).toBe(false);
      expect(serves(rule, 'other', { deep: value })).toBe(false);
    }
  });

  it('ONE READ: a Proxy is a hole, however good its answers', () => {
    const rule = new RedactionRule({ keys: ['nothing-here'] });
    const answers = {
      ownKeys: () => ['a'],
      getOwnPropertyDescriptor: () => ({ value: 1, enumerable: true, configurable: true }),
    };
    for (const value of [new Proxy({}, {}), new Proxy([], {}), new Proxy({}, answers), new Proxy({ a: 1 }, answers)]) {
      expect(serves(rule, 'other', value)).toBe(false);
      expect(serves(rule, 'other', { deep: [value] })).toBe(false);
    }
  });

  it('ONE READ: `behind` answers for the threshold itself, not for what it holds', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    const state = { name: 'A' };
    const handle = new Proxy(state, {});
    const behind = (value: unknown) => (value === handle ? state : value);
    const served = rule.serveThreshold('other', handle, NO_SOURCES, behind).threshold;
    expect(served).toEqual(state);
    expect(served).not.toBe(state);
    expect(rule.serveThreshold('other', { deep: handle }, NO_SOURCES, behind)).toBe(THRESHOLD_HOLE);
    expect(rule.serveThreshold('other', handle, NO_SOURCES)).toBe(THRESHOLD_HOLE);
    const throwing = () => {
      throw new Error('no');
    };
    expect(rule.serveThreshold('other', handle, NO_SOURCES, throwing)).toBe(THRESHOLD_HOLE);
  });

  it('ONE READ: a hole from the name or the sources reads nothing of the threshold', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    let traps = 0;
    const counted = new Proxy(
      {},
      {
        ownKeys: () => {
          traps += 1;
          return [];
        },
        getPrototypeOf: () => {
          traps += 1;
          return Object.prototype;
        },
      },
    );
    expect(rule.serveThreshold('ssn', counted, NO_SOURCES)).toBe(THRESHOLD_HOLE);
    expect(rule.serveThreshold('other', counted, { selectedReads: 1 })).toBe(THRESHOLD_HOLE);
    expect(traps).toBe(0);
  });

  it('a value this run served masked is a hole, though it holds no selected name', () => {
    const rule = new RedactionRule({ diagnostics: { keys: ['errors.stageExecutionError'] }, keys: ['ssn'] });
    const thrown = { code: 7 };
    rule.servedError(thrown);
    expect(serves(rule, 'other', thrown)).toBe(false);
    expect(serves(rule, 'other', [{ deep: thrown }])).toBe(false);
    expect(serves(rule, 'other', { code: 7 })).toBe(true);
  });

  it('SHAPE: an inert rule never asks, so a Map stays', () => {
    expect(serves(new RedactionRule(), 'other', new Map(), NO_SOURCES)).toBe(true);
    expect(serves(new RedactionRule({ emitPatterns: [/x/] }), 'other', new Map(), NO_SOURCES)).toBe(true);
  });

  it('ONE READ: a hidden or symbol key is a hole, whatever it is called', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    for (const name of ['ssn', 'other', 'toJSON', 'toString']) {
      expect(serves(rule, 'other', Object.defineProperty({}, name, { value: 'x', enumerable: false }))).toBe(false);
    }
    expect(serves(rule, 'other', { [Symbol.for('ssn')]: 'x' }, NO_SOURCES)).toBe(false);
    expect(serves(rule, 'other', { [Symbol('other')]: 'x' }, NO_SOURCES)).toBe(false);
  });

  it('SHAPE: a walk past its limit serves a hole, and a deep value never overflows', () => {
    const rule = new RedactionRule({ keys: ['nothing-here'] });
    const restore = useWalkLimit(3);
    try {
      expect(serves(rule, 'other', [[[[['x']]]]], NO_SOURCES)).toBe(false);
    } finally {
      restore();
    }
    let deep: unknown = 'x';
    for (let i = 0; i < 200_000; i++) deep = [deep];
    expect(serves(rule, 'other', deep, NO_SOURCES)).toBe(false);
  });

  it('ONE READ: the read has a budget of keys: a wide flat list passes the name walk, and is still a hole', () => {
    const rule = new RedactionRule({ keys: ['nothing-here'] });
    const restore = useWalkLimit(3);
    try {
      expect(serves(rule, 'other', [1, 2, 3, 4, 5])).toBe(false);
      expect(serves(rule, 'other', [1])).toBe(true);
    } finally {
      restore();
    }
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
    expect(serves(rule, 'other', hostile, NO_SOURCES)).toBe(false);
  });

  it('a cyclic threshold ends', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    const cycle: Record<string, unknown> = { name: 'A' };
    cycle.self = cycle;
    expect(serves(rule, 'other', cycle, NO_SOURCES)).toBe(true);
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

  it('an object a JavaScript caller passed is a hole: its toString would run after the sources were asked', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    let ran = 0;
    const hooked = {
      toString: () => {
        ran += 1;
        return 'text';
      },
    };
    for (const value of [Object.create(null), hooked, () => 'text', new Proxy({}, {})]) {
      expect(rule.retainStageText(address, value as unknown as string, NO_SOURCES)).toBe(SCOPE_PLACEHOLDER);
    }
    expect(ran).toBe(0);
  });

  it('a primitive a JavaScript caller passed is its text', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    expect(rule.retainStageText(address, 7 as unknown as string, NO_SOURCES)).toBe('7');
    expect(rule.retainStageText(address, false as unknown as string, NO_SOURCES)).toBe('false');
  });

  it('an inert rule returns even an object as it is, as main does', () => {
    const value = {} as unknown as string;
    expect(new RedactionRule().retainStageText(address, value, NO_SOURCES)).toBe(value);
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
    expect(answers.serveThreshold('amount', 1)).toEqual({ threshold: 1 });
    expect(answers.servedMatchError('text')).toBe('text');
    selectedReads = 1;
    expect(answers.serveThreshold('amount', 1)).toBe(THRESHOLD_HOLE);
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

  it('hands `behind` to the one law', () => {
    const state = { name: 'A' };
    const handle = new Proxy(state, {});
    const answers = new RedactionRule({ keys: ['ssn'] }).evidenceRule(
      () => NO_SOURCES,
      (value) => (value === handle ? state : value),
    );
    expect(answers.serveThreshold('other', handle).threshold).toEqual(state);
  });

  it('a mark made after the answers were handed out counts: they read the rule live', () => {
    const rule = new RedactionRule();
    const answers = rule.evidenceRule(() => NO_SOURCES);
    expect(answers.serveThreshold('ssn', 'x')).toEqual({ threshold: 'x' });
    rule.mark('ssn');
    expect(answers.serveThreshold('ssn', 'x')).toBe(THRESHOLD_HOLE);
    expect(answers.masksActual('ssn')).toBe(true);
  });
});
