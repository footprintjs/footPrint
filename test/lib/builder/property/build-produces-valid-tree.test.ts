import fc from 'fast-check';
import { flowChart } from '../../../../src/lib/builder';
import type { StageNode } from '../../../../src/lib/builder';

const noop = async () => {};

describe('Property: build produces valid tree', () => {
  it('every node in the tree has a name', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ minLength: 1, maxLength: 12 }).filter((s) => /^[a-zA-Z]/.test(s)),
          { minLength: 1, maxLength: 20 },
        ),
        (names) => {
          // Deduplicate names for stageMap collision safety
          const unique = [...new Set(names)];
          if (unique.length === 0) return;

          let builder = flowChart(unique[0], noop);
          for (let i = 1; i < unique.length; i++) {
            builder = builder.addFunction(unique[i], noop);
          }
          const chart = builder.build();

          const walk = (node: StageNode | undefined) => {
            if (!node) return;
            expect(typeof node.name).toBe('string');
            expect(node.name.length).toBeGreaterThan(0);
            if (node.children) node.children.forEach(walk);
            walk(node.next);
          };
          walk(chart.root);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('stageMap size equals number of unique stage names', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ minLength: 1, maxLength: 12 }).filter((s) => /^[a-zA-Z]/.test(s)),
          { minLength: 1, maxLength: 15 },
        ),
        (names) => {
          const unique = [...new Set(names)];
          if (unique.length === 0) return;

          let builder = flowChart(unique[0], noop);
          for (let i = 1; i < unique.length; i++) {
            builder = builder.addFunction(unique[i], noop);
          }
          const chart = builder.build();

          expect(chart.stageMap.size).toBe(unique.length);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('spec chain length matches node chain length', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        (chainLen) => {
          let builder = flowChart('s0', noop);
          for (let i = 1; i < chainLen; i++) {
            builder = builder.addFunction(`s${i}`, noop);
          }

          const chart = builder.build();
          const spec = builder.toSpec();

          // Count node chain
          let nodeCount = 0;
          let node: StageNode | undefined = chart.root;
          while (node) { nodeCount++; node = node.next; }

          // Count spec chain
          let specCount = 0;
          let s = spec;
          while (s) { specCount++; s = s.next as any; }

          expect(nodeCount).toBe(chainLen);
          expect(specCount).toBe(chainLen);
        },
      ),
      { numRuns: 30 },
    );
  });
});
