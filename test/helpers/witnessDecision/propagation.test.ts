import { describe, expect, it } from 'vitest';

import { decideWitness, formatWitnessDecision } from './index.js';

describe('same FIRST cause propagation metadata', () => {
  it('keeps earliest read and actual first write beside the one decision and unchanged formatter', () => {
    const propagation = [
      {
        operation: ['chart', 1],
        fromAddress: ['hist'],
        toAddress: ['hist'],
        baselineIdentity: 7,
        buildValue: { kind: 'undefined' },
        via: 'read-only-prelude' as const,
      },
    ];
    const proof = {
      kind: 'cause' as const,
      name: 'read-after-delete-124' as const,
      commit: 0,
      coordinate: ['chart', 3],
      readOperation: ['chart', 1],
      writeOperation: ['chart', 3],
      propagation,
    };
    const rows = (bytes: string) => [{ bytes, foldsBack: true }];
    const result = decideWitness(rows('old'), rows('new'), {
      differs: true,
      sameCommit: (a, b) => a === b,
      firstReadCause: () => proof,
    });
    expect(result).toMatchObject({
      kind: 'cause',
      shape: 'first-commit',
      coordinate: { kind: 'fixture-operation', at: ['chart', 3] },
      propagation,
      readOperation: ['chart', 1],
      writeOperation: ['chart', 3],
    });
    expect(formatWitnessDecision(result)).toBe('');
    expect(
      decideWitness(rows('old'), [{ bytes: 'new', foldsBack: false }], {
        differs: true,
        sameCommit: () => false,
        firstReadCause: () => proof,
      }),
    ).toMatchObject({ kind: 'broken', code: 'build-fold-back' });
  });
});
