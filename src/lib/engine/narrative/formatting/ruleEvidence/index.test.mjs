import { describe, expect, it } from 'vitest';

import { defaultRenderDecision, defaultRenderSelected } from './index.js';

describe('declared-rule narrative formatting', () => {
  it('keeps the existing wording when selection evidence is absent', () => {
    expect(defaultRenderSelected({ selected: ['large'], total: 2 })).toBe(
      '[Selected]: 1 of 2 paths selected for execution: large.',
    );
  });

  it('keeps matched selection wording unchanged', () => {
    expect(
      defaultRenderSelected({
        selected: ['large'],
        total: 2,
        evidence: {
          rules: [
            {
              type: 'filter',
              branch: 'large',
              matched: true,
              conditions: [{ key: 'amount', actualSummary: '12', op: 'gt', threshold: 10, result: true }],
            },
          ],
        },
      }),
    ).toBe('[Selected]: 1 of 2 paths selected: large (amount 12 gt 10 ✓).');
  });

  it('does not execute an object threshold serializer when explaining an empty selection', () => {
    let calls = 0;
    const threshold = Object.defineProperty({}, 'toJSON', {
      get() {
        calls++;
        throw new Error('must not execute');
      },
    });
    expect(
      defaultRenderSelected({
        selected: [],
        total: 1,
        evidence: {
          rules: [
            {
              type: 'filter',
              branch: 'large',
              matched: false,
              conditions: [{ key: 'amount', actualSummary: '4', op: 'gt', threshold, result: false }],
            },
          ],
        },
      }),
    ).toBe('[Selected]: 0 of 1 paths selected; no rules matched: large (amount 4 gt [recorded threshold] ✗).');
    expect(calls).toBe(0);
  });

  it('keeps a redacted threshold as a hole instead of quoting it as a value', () => {
    expect(
      defaultRenderSelected({
        selected: [],
        total: 1,
        evidence: {
          rules: [
            {
              type: 'filter',
              branch: 'large',
              matched: false,
              conditions: [
                {
                  key: 'amount',
                  actualSummary: '[REDACTED]',
                  op: 'gt',
                  threshold: '[REDACTED]',
                  thresholdRedacted: true,
                  result: false,
                },
              ],
            },
          ],
        },
      }),
    ).toBe('[Selected]: 0 of 1 paths selected; no rules matched: large (amount [REDACTED] gt [REDACTED] ✗).');
  });

  it('keeps a labelled decision default when no rule matched', () => {
    expect(
      defaultRenderDecision({
        chosen: 'ordinary',
        evidence: { rules: [], defaultLabel: 'No threshold reached' },
      }),
    ).toBe('[Condition]: No rules matched, fell back to default "No threshold reached": ordinary.');
  });

  it('a matched rule threshold JSON cannot serialize prints the inert preview, and the line survives', () => {
    const throwing = Object.defineProperty({}, 'toJSON', {
      get() {
        throw new Error('getter');
      },
    });
    const cyclic = {};
    cyclic.self = cyclic;
    const decision = (threshold) =>
      defaultRenderDecision({
        chosen: 'a',
        evidence: {
          rules: [
            {
              type: 'filter',
              ruleIndex: 0,
              matched: true,
              conditions: [{ key: 'n', actualSummary: '5', op: 'eq', threshold, result: true }],
            },
          ],
        },
      });
    expect(decision(5n)).toBe('[Condition]: It evaluated Rule 0: n 5 eq [recorded threshold] ✓, and chose a.');
    expect(decision(cyclic)).toBe('[Condition]: It evaluated Rule 0: n 5 eq [recorded threshold] ✓, and chose a.');
    expect(decision(throwing)).toBe('[Condition]: It evaluated Rule 0: n 5 eq [recorded threshold] ✓, and chose a.');
  });

  it('a matched rule threshold that serializes keeps its JSON text', () => {
    const decision = (key, actualSummary, op, threshold) =>
      defaultRenderDecision({
        chosen: 'a',
        evidence: {
          rules: [
            {
              type: 'filter',
              ruleIndex: 0,
              matched: true,
              conditions: [{ key, actualSummary, op, threshold, result: true }],
            },
          ],
        },
      });
    expect(decision('tier', '"gold"', 'in', ['gold', 'platinum'])).toBe(
      '[Condition]: It evaluated Rule 0: tier "gold" in ["gold","platinum"] ✓, and chose a.',
    );
    expect(decision('name', '"a"', 'eq', 'say "hi"')).toBe(
      '[Condition]: It evaluated Rule 0: name "a" eq "say \\"hi\\"" ✓, and chose a.',
    );
  });

  it('a matched selection threshold JSON cannot serialize prints the inert preview', () => {
    expect(
      defaultRenderSelected({
        selected: ['large'],
        total: 1,
        evidence: {
          rules: [
            {
              type: 'filter',
              branch: 'large',
              matched: true,
              conditions: [{ key: 'amount', actualSummary: '12', op: 'gt', threshold: 10n, result: true }],
            },
          ],
        },
      }),
    ).toBe('[Selected]: 1 of 1 paths selected: large (amount 12 gt [recorded threshold] ✓).');
  });
});
