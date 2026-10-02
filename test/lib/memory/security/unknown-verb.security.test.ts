/**
 * Security tests — a log nobody vetted.
 *
 * `UnknownVerbError` exists because a foreign or corrupted log used to be
 * folded as a `merge`. The log is attacker-shaped input: its verbs and paths are
 * strings it chose. Pinned here: a verb that is a NAME ON `Object.prototype`
 * is not one of the four (the vocabulary is an own-property lookup, never a
 * prototype walk), the refusal text cannot be reshaped by what it quotes, a
 * path made of prototype-pollution segments stays inert through every verb, and
 * nothing a refused or inert row did reaches `Object.prototype`.
 */
import { commitValueAt } from '../../../../src/lib/memory/commitLogUtils';
import { DELIM } from '../../../../src/lib/memory/paths';
import type { CommitBundle, TraceEntry } from '../../../../src/lib/memory/types';
import { applySmartMerge, dryFold, nextGeneration } from '../../../../src/lib/memory/utils';
import { type Verb, isVerb, UnknownVerbError } from '../../../../src/lib/memory/verbs';
import { arrayProvenance } from '../../../../src/lib/slice/elementProvenance';

const NAMES_ON_OBJECT = [
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  '__defineGetter__',
];

const bundle = (trace: TraceEntry[], overwrite = {}, updates = {}): CommitBundle => ({
  idx: 0,
  stage: 'S',
  stageId: 's',
  runtimeStageId: 's#0',
  trace,
  redactedPaths: [],
  overwrite,
  updates,
});

const objectPrototypeIsClean = () => {
  expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(CLEAN_OBJECT_PROTOTYPE);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
};
const CLEAN_OBJECT_PROTOTYPE = Object.getOwnPropertyNames(Object.prototype).sort();

describe('the vocabulary is an own-property lookup', () => {
  it.each(NAMES_ON_OBJECT)('%s is not a verb — and is refused at every door', (name) => {
    expect(isVerb(name)).toBe(false);
    const trace = [{ path: 'k', verb: name as Verb }];
    const b = bundle(trace, { k: 1 }, { k: { a: 1 } });
    for (const door of [
      () => applySmartMerge({}, b.updates, b.overwrite, trace),
      () => nextGeneration({}, b.updates, b.overwrite, trace),
      () => dryFold({}, b.updates, b.overwrite, trace),
      () => commitValueAt([b], 0, 'k'),
      () => arrayProvenance([b], 'k'),
    ]) {
      expect(door).toThrow(UnknownVerbError);
    }
    objectPrototypeIsClean();
  });
});

describe('the refusal quotes what it was handed', () => {
  it('a hostile verb or path cannot add a line, a control character or a second message to the text', () => {
    const verb = 'upsert"\n[2026-01-01] FORGED: all clear\u0000';
    const path = ['items\nforged: yes', 'x\u0007'].join(DELIM);
    const error = new UnknownVerbError(verb, { path, row: 0, commit: 0 });
    expect([...error.message].every((ch) => ch.charCodeAt(0) >= 0x20)).toBe(true); // one line, no control character
    expect(error.message).toContain('unknown verb "upsert\\"\\n[2026-01-01] FORGED: all clear\\u0000"');
    expect(error.message).toContain('"items\\nforged: yes › x\\u0007"');
    // …and the fields keep the raw values for a caller who wants them.
    expect(error.verb).toBe(verb);
    expect(error.path).toBe(path);
  });

  it('a verb that is not a string is described by its type, never stringified', () => {
    const hostile = {
      toString: () => {
        throw new Error('must not be called');
      },
    };
    expect(() => new UnknownVerbError(hostile)).not.toThrow();
    expect(new UnknownVerbError(hostile).message).toContain('unknown verb of type object');
    expect(new UnknownVerbError(10n).message).toContain('unknown verb of type bigint');
  });
});

describe('prototype-pollution segments stay inert through every verb', () => {
  const FOUR: Verb[] = ['set', 'merge', 'append', 'delete'];
  const polluted = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}}');

  it.each(FOUR)('%s on __proto__ / constructor / prototype paths changes nothing and pollutes nothing', (verb) => {
    for (const path of [
      ['__proto__', 'polluted'].join(DELIM),
      ['constructor', 'prototype', 'polluted'].join(DELIM),
      ['a', '__proto__', 'polluted'].join(DELIM),
      '__proto__',
    ]) {
      const trace = [{ path, verb }];
      const out = applySmartMerge({ a: {} }, polluted, polluted, trace);
      expect(out).toEqual({ a: {} });
      expect(nextGeneration({ a: {} }, polluted, polluted, trace)).toEqual({ a: {} });
      expect(commitValueAt([bundle(trace, polluted, polluted)], 0, path)).toBeUndefined();
      objectPrototypeIsClean();
    }
  });
});
