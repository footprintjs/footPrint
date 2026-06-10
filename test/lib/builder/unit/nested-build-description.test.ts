/**
 * Regression — nested-build description explosion.
 *
 * `_appendSubflowDescription` used to embed the FULL inner chart description
 * inline on the `[Sub-Execution: …]` line AND re-list its `Steps:` lines
 * indented — two copies of the inner text per wrap level. Each nested
 * `build()` therefore ~doubled the description: exponential growth that hit
 * `RangeError: Invalid string length` at ~22 nesting levels (224 MB of
 * description at N=20), at BUILD time, before anything ran.
 *
 * The fix inlines only the summary above `Steps:` (the `FlowChart: X` header)
 * on the mount line and keeps the single indented step re-list — growth per
 * wrap is now additive (one copy of the inner steps + per-line indent).
 */
import type { FlowChart } from '../../../../src/lib/builder';
import { flowChart } from '../../../../src/lib/builder';

const noop = async () => {};

function buildNested(depth: number) {
  let chart = flowChart('Leaf', noop, 'leaf', { description: 'innermost stage' }).build();
  for (let i = 1; i <= depth; i++) {
    chart = flowChart(`Seed${i}`, noop, `seed-${i}`, { description: `level ${i} seed` })
      .addSubFlowChartNext(`sf-${i}`, chart, `Inner${i}`)
      .build();
  }
  return chart;
}

describe('nested build() description composition', () => {
  it('builds 50 nesting levels in bounded time and description size (was RangeError at ~22)', () => {
    const t0 = performance.now();
    const chart = buildNested(50);
    const elapsed = performance.now() - t0;

    // Pre-fix: ~2x description growth per level → 224 MB at N=20, RangeError
    // at N=22. Post-fix N=50 is ~13 KB and sub-millisecond; generous bounds
    // keep this stable on slow CI.
    expect(elapsed).toBeLessThan(2000);
    expect(chart.description.length).toBeLessThan(100_000);
  });

  it('keeps spec ids correct at depth — full path-prefixed subflow and stage ids', () => {
    const chart = buildNested(50);

    // Subflow registry carries the exact composed path at every depth.
    const subflowIds = Object.keys(chart.subflows ?? {});
    expect(subflowIds).toHaveLength(50);
    expect(subflowIds).toContain('sf-50');
    expect(subflowIds).toContain('sf-50/sf-49');
    const fullPath = Array.from({ length: 50 }, (_, i) => `sf-${50 - i}`).join('/');
    expect(subflowIds).toContain(fullPath);

    // The innermost stage is reachable under its fully prefixed id.
    expect(chart.stageMap.has(`${fullPath}/leaf`)).toBe(true);
    // …and an intermediate seed stage too (each seed sits one mount-hop in).
    expect(chart.stageMap.has('sf-50/seed-49')).toBe(true);
  });

  it('composes the exact indented description tree (each inner step listed once)', () => {
    const chart = buildNested(2);

    expect(chart.description).toBe(
      [
        'FlowChart: Seed2',
        'Steps:',
        '1. Seed2 — level 2 seed',
        '2. [Sub-Execution: Inner2] — FlowChart: Seed1',
        '   1. Seed1 — level 1 seed',
        '   2. [Sub-Execution: Inner1] — FlowChart: Leaf',
        '      1. Leaf — innermost stage',
      ].join('\n'),
    );
  });

  it('description size grows ~linearly in lines with nesting depth (no doubling)', () => {
    const lines20 = buildNested(20).description.split('\n').length;
    const lines40 = buildNested(40).description.split('\n').length;
    // One mount line + one step line per level → doubling depth roughly
    // doubles the line count. Pre-fix this ratio exploded (2^20 ≈ 1M×).
    expect(lines40 / lines20).toBeLessThan(2.5);
  });

  it('still inlines free-form (non-builder) subflow descriptions whole', () => {
    const sub: FlowChart<any, any> = {
      ...flowChart('SubRoot', noop, 'sub-root').build(),
      description: 'a hand-written single-block description',
    };

    const chart = flowChart('main', noop, 'main').addSubFlowChartNext('sf', sub, 'MySub').build();

    expect(chart.description).toContain('[Sub-Execution: MySub] — a hand-written single-block description');
  });

  it('omits the dash suffix when the subflow description starts at Steps: (empty summary)', () => {
    const sub: FlowChart<any, any> = {
      ...flowChart('SubRoot', noop, 'sub-root').build(),
      description: 'Steps:\n1. Only — step',
    };

    const chart = flowChart('main', noop, 'main').addSubFlowChartNext('sf', sub, 'MySub').build();

    expect(chart.description).toContain('2. [Sub-Execution: MySub]\n   1. Only — step');
    expect(chart.description).not.toContain('[Sub-Execution: MySub] —');
  });
});
