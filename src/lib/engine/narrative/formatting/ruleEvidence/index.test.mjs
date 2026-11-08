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
});
