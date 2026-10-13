/**
 * Property: any chain of deciders and selectors builds and runs in order.
 *
 * A dispatcher's `.end()` leaves the cursor on it, and the next dispatcher is
 * a new node at its `next` (see scenario/dispatcher-after-dispatcher.test.ts —
 * until 10.0.1 three of the four adjacent pairs were refused at build). For
 * a random chain of 1–6 dispatchers, each with 1–4 branches and a random
 * non-empty pick: every node carries its own kind (node flag, spec type,
 * `computeNodeType`), and the run visits each dispatcher, then exactly its
 * picked branches, then the next dispatcher, then the trailing stage.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { StageNode } from '../../../../src/lib/builder';
import { flowChart } from '../../../../src/lib/builder';
import { computeNodeType } from '../../../../src/lib/engine/handlers/RuntimeStructureManager';
import { FlowChartExecutor } from '../../../../src/lib/runner';

type Kind = 'decider' | 'selector';

interface Step {
  readonly kind: Kind;
  readonly branches: number;
  /** Indices of the branches the dispatcher picks (exactly one for a decider). */
  readonly picks: readonly number[];
}

const stepArb: fc.Arbitrary<Step> = fc
  .record({ kind: fc.constantFrom<Kind>('decider', 'selector'), branches: fc.integer({ min: 1, max: 4 }) })
  .chain(({ kind, branches }) =>
    (kind === 'decider'
      ? fc.integer({ min: 0, max: branches - 1 }).map((i) => [i])
      : fc.uniqueArray(fc.integer({ min: 0, max: branches - 1 }), { minLength: 1, maxLength: branches })
    ).map((picks) => ({ kind, branches, picks })),
  );

const branchId = (d: number, b: number) => `d${d}-b${b}`;

function build(steps: readonly Step[], order: string[]) {
  const push = (label: string) => () => {
    order.push(label);
  };
  let builder = flowChart('Seed', push('seed'), 'seed');
  steps.forEach((step, d) => {
    const ids = step.picks.map((b) => branchId(d, b));
    const fn = () => {
      order.push(`d${d}`);
      return step.kind === 'decider' ? ids[0] : ids;
    };
    if (step.kind === 'decider') {
      let list = builder.addDeciderFunction(`D${d}`, fn, `d${d}`);
      for (let b = 0; b < step.branches; b++)
        list = list.addFunctionBranch(branchId(d, b), branchId(d, b), push(branchId(d, b)));
      builder = list.end();
    } else {
      let list = builder.addSelectorFunction(`S${d}`, fn, `d${d}`);
      for (let b = 0; b < step.branches; b++)
        list = list.addFunctionBranch(branchId(d, b), branchId(d, b), push(branchId(d, b)));
      builder = list.end();
    }
  });
  return builder.addFunction('Tail', push('tail'), 'tail').build();
}

describe('Property: a chain of dispatchers', () => {
  it('builds every order, each node with its own kind, and runs each dispatcher’s picks in sequence', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 6 }), async (steps) => {
        const order: string[] = [];
        const chart = build(steps, order);

        let node: StageNode | undefined = chart.root.next;
        let spec = chart.buildTimeStructure.next;
        steps.forEach((step, d) => {
          expect(node?.id).toBe(`d${d}`);
          expect(computeNodeType(node!)).toBe(step.kind);
          expect(spec?.type).toBe(step.kind);
          expect(Boolean(node!.deciderFn)).toBe(step.kind === 'decider');
          expect(Boolean(node!.selectorFn)).toBe(step.kind === 'selector');
          expect(spec?.branchIds).toEqual(Array.from({ length: step.branches }, (_, b) => branchId(d, b)));
          node = node!.next;
          spec = spec!.next;
        });
        expect(node?.id).toBe('tail');

        await new FlowChartExecutor(chart).run();

        // A selector's picks run in parallel, so only their SET is pinned.
        let at = 0;
        expect(order[at++]).toBe('seed');
        steps.forEach((step, d) => {
          expect(order[at++]).toBe(`d${d}`);
          const ran = order.slice(at, (at += step.picks.length));
          expect(new Set(ran)).toEqual(new Set(step.picks.map((b) => branchId(d, b))));
        });
        expect(order.slice(at)).toEqual(['tail']);
      }),
      { numRuns: 60 },
    );
  });
});
