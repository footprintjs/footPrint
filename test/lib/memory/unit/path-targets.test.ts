/**
 * The targets of a served record's node (`memory/pathTargets.ts`), unit.
 *
 * What is pinned here: what a node's targets say about each of its keys, that a long list (grouped by
 * first key) answers exactly as a short one (scanned), and that asking N keys of N targets costs
 * N, not N × N. The walk that uses it is `redaction.ts`; its own tests are the redaction suites.
 */
import { describe, expect, it } from 'vitest';

import {
  type Step,
  type Target,
  MANY_TARGETS,
  signatureOf,
  stepsOf,
  targetsOf,
} from '../../../../src/lib/memory/pathTargets';

/** The answer by the plainest reading: every target, for the one key. */
function plainly(targets: readonly Target[], key: string): Step {
  const below = targets.filter((target) => target[0] === key && target.length > 1).map((target) => target.slice(1));
  return { masked: targets.some((target) => target[0] === key && target.length === 1), below };
}

/** `count` targets that start at nothing a test asks for, to make a list long. */
const padding = (count: number): Target[] => Array.from({ length: count }, (_, i) => [`pad${i}`, 'x']);

describe('stepsOf — what the targets of a node say about one of its keys', () => {
  it('a target that ends at the key masks it; one that goes on is handed below without the key', () => {
    const steps = stepsOf([['card', 'number'], ['pin'], ['card', 'owner', 'name']]);
    expect(steps('card')).toEqual({ masked: false, below: [['number'], ['owner', 'name']] });
    expect(steps('pin')).toEqual({ masked: true, below: [] });
    expect(steps('name')).toEqual({ masked: false, below: [] });
  });

  it('a key that one target ends at and another goes below is masked, and keeps what goes below', () => {
    const targets: Target[] = [['card'], ['card', 'number']];
    expect(stepsOf(targets)('card')).toEqual({ masked: true, below: [['number']] });
    expect(stepsOf([...targets, ...padding(MANY_TARGETS)])('card')).toEqual({ masked: true, below: [['number']] });
  });

  it('no targets: every key is clear, and the shared answer cannot be added to', () => {
    const step = stepsOf([])('anything');
    expect(step).toEqual({ masked: false, below: [] });
    expect(Object.isFrozen(step)).toBe(true);
    expect(Object.isFrozen(step.below)).toBe(true);
  });

  it('a long list answers as a short one does, for every key and on both sides of the line', () => {
    // Keys with a name an object would trip over are keys like any other here.
    const keys = ['a', 'b', 'c', '__proto__', 'constructor', '', '0', 'a.b'];
    const all: Target[] = [];
    for (const key of keys) {
      all.push([key, 'x'], [key, 'y', 'z']);
      if (key !== 'b') all.push([key]);
    }
    for (const size of [1, MANY_TARGETS - 1, MANY_TARGETS, MANY_TARGETS + 1, all.length]) {
      const targets = all.slice(0, size);
      const steps = stepsOf(targets);
      for (const key of [...keys, 'absent'])
        expect(steps(key), `${size} targets, key "${key}"`).toEqual(plainly(targets, key));
    }
  });

  it('a key no target starts at gets the shared clear answer from a long list too', () => {
    const step = stepsOf(padding(MANY_TARGETS + 4))('absent');
    expect(step).toEqual({ masked: false, below: [] });
    expect(Object.isFrozen(step.below)).toBe(true);
  });

  it('N keys asked of N targets read each target a fixed number of times, not once for each key', () => {
    // Found by a cost sweep: a record with 8,000 hidden fields took 348 ms to copy under its policy,
    // every key scanning every target. Counted, not timed: a count does not flake.
    const N = 2_000;
    let reads = 0;
    const targets: Target[] = Array.from(
      { length: N },
      (_, i) =>
        new Proxy([`k${i}`], {
          get(target, key, receiver) {
            if (key === '0') reads += 1;
            return Reflect.get(target, key, receiver);
          },
        }),
    );
    const steps = stepsOf(targets);
    let masked = 0;
    for (let i = 0; i < N; i++) if (steps(`k${i}`).masked) masked += 1;
    expect(masked).toBe(N);
    expect(reads).toBeLessThan(4 * N); // N × N before
  });
});

describe('targetsOf and signatureOf', () => {
  it('a dotted path is a key of that spelling AND the path its dots spell', () => {
    expect(targetsOf(['pin', 'card.number'])).toEqual([['pin'], ['card.number'], ['card', 'number']]);
    expect(targetsOf(undefined)).toEqual([]);
  });

  it('the signature of a list of targets does not depend on their order', () => {
    const one = signatureOf([['a', 'b'], ['c']]);
    expect(signatureOf([['c'], ['a', 'b']])).toBe(one);
    expect(signatureOf([['a'], ['b', 'c']])).not.toBe(one);
    expect(signatureOf([])).toBe('');
  });
});
