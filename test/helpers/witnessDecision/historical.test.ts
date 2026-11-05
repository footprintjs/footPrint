import { describe, expect, it } from 'vitest';

import { decideWitness, hasAdmittedRecordEvidence } from './index.js';

const rows = (folds: readonly boolean[], prefix: string) =>
  folds.map((foldsBack, i) => ({ bytes: `${prefix}${i}`, foldsBack }));
const proof = {
  kind: 'cause' as const,
  name: 'read-after-delete-124' as const,
  commit: 0,
  coordinate: ['chart', 0, 'stages', 0, 'op', 1],
};
const ports = {
  differs: true,
  sameCommit: (a: string | undefined, b: string | undefined) => a === b,
  firstReadCause: () => proof,
};
describe('one FIRST cause plus independently retained old9.30 evidence', () => {
  it('names the real 124 FIRST and separately the first later baseline fold failure', () => {
    const decision = decideWitness(
      rows([true, true, false, false], 'old'),
      rows([true, true, true, true], 'new'),
      ports,
    );
    expect(decision).toMatchObject({
      kind: 'cause',
      name: 'read-after-delete-124',
      commit: 0,
      also: { cause: 'admitted-record-9.30', commit: 2 },
    });
    expect(
      hasAdmittedRecordEvidence(
        decision,
        rows([true, true, false, false], 'old'),
        rows([true, true, true, true], 'new'),
      ),
    ).toBe(true);
  });
  it.each(['absent-evidence', 'wrong-commit', 'missing-coordinate'])(
    'a historical listed entry refuses %s',
    (damage) => {
      const baseline = rows([true, false], 'old');
      const build = rows([true, true], 'new');
      const decision = decideWitness(baseline, build, ports);
      if (damage === 'absent-evidence') Object.assign(baseline[1], { foldsBack: true });
      if (damage === 'wrong-commit') Object.assign(decision, { also: { cause: 'admitted-record-9.30', commit: 0 } });
      if (damage === 'missing-coordinate')
        Object.assign(decision, { coordinate: { kind: 'fixture-operation', at: [] } });
      expect(hasAdmittedRecordEvidence(decision, baseline, build)).toBe(false);
    },
  );
  it('does not invent old evidence when every baseline commit folds', () => {
    expect(decideWitness(rows([true, true], 'old'), rows([true, true], 'new'), ports)).not.toHaveProperty('also');
  });
  it('later baseline evidence never clears an unproved earlier FIRST', () => {
    expect(
      decideWitness(rows([true, false], 'old'), rows([true, true], 'new'), {
        ...ports,
        firstReadCause: () => ({ kind: 'unproven', reason: 'missing coordinate' }),
      }),
    ).toMatchObject({ kind: 'broken', code: 'coherent-commit-difference', index: 0 });
  });
  it('every BUILD fold remains unconditional even after a good FIRST', () => {
    expect(decideWitness(rows([true, false], 'old'), rows([true, false], 'new'), ports)).toMatchObject({
      kind: 'broken',
      code: 'build-fold-back',
      index: 1,
    });
  });
});
