import { describe, expect, it } from 'vitest';

import { flowChartSelector } from '../../../../src/lib/builder';
import { select } from '../../../../src/lib/decide';
import { FlowChartExecutor } from '../../../../src/lib/runner';

const noop = async () => {};

describe('flowChartSelector — root stage IS a selector', () => {
  it('unit: the ROOT node carries the selector (selectorFn flag + hasSelector spec)', () => {
    const chart = flowChartSelector('Context', async () => ['a', 'b'] as any, 'context')
      .addFunctionBranch('a', 'A', noop)
      .addFunctionBranch('b', 'B', noop)
      .end()
      .build();

    // The root itself is the selector — NOT a seed stage with a selector after it.
    expect(chart.root.id).toBe('context');
    expect(chart.root.selectorFn).toBe(true);
    expect(chart.root.children).toHaveLength(2);
    // No separate seed predecessor — root has no `next`-before-branches chain.
    expect(chart.root.name).toBe('Context');
  });

  it('unit: spec marks the root type=selector + branchIds', () => {
    const spec = flowChartSelector('Context', async () => 'a' as any, 'context')
      .addFunctionBranch('a', 'A', noop)
      .end()
      .toSpec();

    expect(spec.id).toBe('context');
    expect(spec.type).toBe('selector');
    expect(spec.hasSelector).toBe(true);
    expect(spec.branchIds).toContain('a');
  });

  it('functional: root selector runs first (inits state) then routes to chosen branch', async () => {
    const chart = flowChartSelector(
      'Context',
      (scope: any) => {
        scope.init = true; // seed-style init INSIDE the root selector (TypedScope)
        return select(scope, [{ when: () => true, then: 'a', label: 'pick a' }]);
      },
      'context',
    )
      .addFunctionBranch('a', 'A', (scope: any) => {
        scope.ran = 'a';
      })
      .addFunctionBranch('b', 'B', (scope: any) => {
        scope.ran = 'b';
      })
      .end()
      .build();

    const ex = new FlowChartExecutor(chart);
    await ex.run({ input: {} });
    // Root selector writes top-level (it ran first, inited state). Branch
    // writes are namespaced under `runs.<branchId>` — the engine isolates
    // each selected/parallel branch's scope so siblings don't clobber.
    const state = ex.getSnapshot()?.sharedState as {
      init?: boolean;
      runs?: Record<string, { ran?: string }>;
    };
    expect(state.init).toBe(true); // root selector ran + inited (top-level)
    expect(state.runs?.a?.ran).toBe('a'); // chosen branch 'a' ran
    expect(state.runs?.b).toBeUndefined(); // branch 'b' was NOT selected
  });

  it('functional: multi-select root runs ALL matching branches', async () => {
    const chart = flowChartSelector(
      'Context',
      (scope: any) =>
        select(scope, [
          { when: () => true, then: 'x', label: 'x' },
          { when: () => true, then: 'y', label: 'y' },
        ]),
      'context',
    )
      .addFunctionBranch('x', 'X', (scope: any) => {
        scope.hit = true;
      })
      .addFunctionBranch('y', 'Y', (scope: any) => {
        scope.hit = true;
      })
      .end()
      .build();

    const ex = new FlowChartExecutor(chart);
    await ex.run({ input: {} });
    // Both matching branches ran → both have their own namespaced scope.
    const state = ex.getSnapshot()?.sharedState as {
      runs?: Record<string, { hit?: boolean }>;
    };
    expect(state.runs?.x?.hit).toBe(true);
    expect(state.runs?.y?.hit).toBe(true);
  });

  it('integration: stages added AFTER end() run as the convergence/continuation', async () => {
    const chart = flowChartSelector(
      'Context',
      (scope: any) => select(scope, [{ when: () => true, then: 'a', label: 'a' }]),
      'context',
    )
      .addFunctionBranch('a', 'A', (scope: any) => {
        scope.ran = 'a';
      })
      .end()
      .addFunction(
        'After',
        (scope: any) => {
          scope.after = true;
        },
        'after',
      )
      .build();

    const ex = new FlowChartExecutor(chart);
    await ex.run({ input: {} });
    // The chosen branch ran (namespaced) AND the post-end() stage ran
    // (top-level convergence/continuation).
    const state = ex.getSnapshot()?.sharedState as {
      runs?: Record<string, { ran?: string }>;
      after?: boolean;
    };
    expect(state.runs?.a?.ran).toBe('a');
    expect(state.after).toBe(true);
  });

  it('unit: defining a second root throws (root already defined)', () => {
    // startSelector must respect the single-root invariant.
    const builder = flowChartSelector('Context', async () => 'a' as any, 'context')
      .addFunctionBranch('a', 'A', noop)
      .end();
    // The returned builder already has a root; starting again must fail.
    expect(() => builder.start('Again', noop, 'again')).toThrow(/root already defined/);
  });
});
