import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  breakSentence,
  decisionSentence,
  errorSentence,
  forkSentence,
  loopSentence,
  nextStageSentence,
  pauseSentence,
  resumeSentence,
  validationDetails,
  validationSentence,
} from '../../../../../src/lib/engine/narrative/formatting/sentences.js';

describe('shared narrative sentence bodies', () => {
  it.each([undefined, ''])('uses the unnamed templates for description %j', (description) => {
    expect(nextStageSentence({ stageName: 'Work', description })).toBe('Next, it moved on to Work.');
    expect(loopSentence({ target: 'Work', iteration: 2, description })).toBe('On pass 2 through Work.');
  });

  it.each(['calculate NAV', ' ', 'évaluer 東京\nnext'])('keeps descriptions verbatim: %j', (description) => {
    expect(nextStageSentence({ stageName: 'Work', description })).toBe(`Next step: ${description}.`);
    expect(loopSentence({ target: 'Work', iteration: 2, description })).toBe(`On pass 2: ${description} again.`);
  });

  it.each([
    [undefined, undefined, 'A decision was made, and the path taken was Accept.'],
    ['', '', 'A decision was made, and the path taken was Accept.'],
    ['checked', undefined, 'It checked and chose Accept.'],
    [undefined, 'valid', 'A decision was made: valid, so the path taken was Accept.'],
    ['checked', 'valid', 'It checked: valid, so it chose Accept.'],
  ])('preserves decision fallbacks for %j and %j', (description, rationale, expected) => {
    expect(decisionSentence({ chosen: 'Accept', description, rationale })).toBe(expected);
  });

  it.each([
    [[], 'Forking into 0 parallel paths: .'],
    [['A'], 'Forking into 1 parallel paths: A.'],
    [['A', 'é', 'A'], 'Forking into 3 parallel paths: A, é, A.'],
  ] as const)('preserves fork order and multiplicity for %j', (children, expected) => {
    expect(forkSentence({ children: [...children] })).toBe(expected);
  });

  it.each([0, 1, 9, -1])('prints a supplied loop iteration without changing it: %i', (iteration) => {
    expect(loopSentence({ target: 'Work', iteration })).toBe(`On pass ${iteration} through Work.`);
  });

  it('preserves lifecycle punctuation', () => {
    expect(breakSentence({ stageName: 'Work' })).toBe('Execution stopped at Work.');
    expect(pauseSentence({ stageName: 'Work' })).toBe('Execution paused at Work.');
    expect(resumeSentence({ stageName: 'Work', hasInput: false })).toBe('Execution resumed at Work.');
    expect(resumeSentence({ stageName: 'Work', hasInput: true })).toBe('Execution resumed at Work with input.');
  });

  it('formats validation paths in their existing order without changing caller data', () => {
    const issues = Object.freeze([
      Object.freeze({ path: [], message: 'required' }),
      Object.freeze({ path: ['items', 0, 'price'], message: 'invalid' }),
    ]);
    const text = validationDetails(issues);
    expect(text).toBe('(root): required; items.0.price: invalid');
    expect(errorSentence({ stageName: 'Validate', message: 'bad input' }) + validationSentence(text)).toBe(
      'An error occurred at Validate: bad input. Validation issues: (root): required; items.0.price: invalid.',
    );
    expect(issues[1].path).toEqual(['items', 0, 'price']);
    expect(validationDetails([])).toBe('');
  });

  it('leaves empty-detail inclusion to the recorder boundary', () => {
    expect(errorSentence({ stageName: 'Validate', message: 'bad input' })).toBe(
      'An error occurred at Validate: bad input.',
    );
    expect(validationSentence('')).toBe(' Validation issues: .');
  });

  it('has no retained state across generated, frozen contexts', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.integer(), (target, description, iteration) => {
        const ctx = Object.freeze({ target, description, iteration });
        const expected = description
          ? `On pass ${iteration}: ${description} again.`
          : `On pass ${iteration} through ${target}.`;
        expect(loopSentence(ctx)).toBe(expected);
        loopSentence({ target: 'unrelated', iteration: 1 });
        expect(loopSentence(ctx)).toBe(expected);
      }),
      { seed: 20261005, numRuns: 100 },
    );
  });
});
