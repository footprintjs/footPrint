import fc from 'fast-check';

import type { StageNode } from '../../../../src/lib/builder';
import { flowChart } from '../../../../src/lib/builder';

const noop = async () => {};

describe('Property: stage names unique', () => {
  it('duplicate name with different fn always throws', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 12 }).filter((s) => /^[a-zA-Z]/.test(s)),
        (name) => {
          const fn1 = async () => {};
          const fn2 = async () => {};

          expect(() => {
            flowChart(name, fn1).addFunction(name, fn2);
          }).toThrow('stageMap collision');
        },
      ),
      { numRuns: 30 },
    );
  });

  it('same name with same fn reference does not throw', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 12 }).filter((s) => /^[a-zA-Z]/.test(s)),
        (name) => {
          const fn = async () => {};

          expect(() => {
            flowChart(name, fn).addFunction(name, fn);
          }).not.toThrow();
        },
      ),
      { numRuns: 30 },
    );
  });

  it('all names in tree are reachable from root', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 15 }), (count) => {
        let builder = flowChart('s0', noop);
        const expectedNames = new Set(['s0']);
        for (let i = 1; i < count; i++) {
          builder = builder.addFunction(`s${i}`, noop);
          expectedNames.add(`s${i}`);
        }
        const chart = builder.build();

        const reachable = new Set<string>();
        const walk = (node: StageNode | undefined) => {
          if (!node) return;
          reachable.add(node.name);
          if (node.children) node.children.forEach(walk);
          walk(node.next);
        };
        walk(chart.root);

        expect(reachable).toEqual(expectedNames);
      }),
      { numRuns: 30 },
    );
  });
});
