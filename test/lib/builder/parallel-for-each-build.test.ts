/**
 * Build-time refusals for `addParallelForEach` + the reserved marker.
 *
 * Design: docs/design/execution-control.md — Round B tests 2 and 4 (first half).
 *
 * Everything here fails BEFORE a run, with a sentence that says what is wrong
 * and why. Three refusals, three different silent-corruption classes they each
 * prevent:
 *
 *   1. `~` in a user-authored SUBFLOW id — could collide with a generated
 *      branch segment and silently mis-attribute a trace.
 *   2. `~` in the `addParallelForEach` id itself — the segment embeds that id,
 *      so a marker inside it would make the segment ambiguous to parse.
 *   3. missing `maxBranches` / missing `into` — an unbounded fan-out is a
 *      resource attack; a derived result key could overwrite live state.
 *
 * Test types: Unit (each refusal) · Functional (message content) ·
 * Back-compat (marker-free charts still build byte-identically) ·
 * Security (the refusal cannot be bypassed through any mount entry point).
 */
import { describe, expect, it } from 'vitest';

import { flowChart, flowChartSelector } from '../../../src/index.js';

const noop = () => undefined;
const tinyChart = () => flowChart('Branch', noop, 'branch-stage').build();

/** Every entry point that accepts a USER-AUTHORED subflow id. */
const subflowIdEntryPoints: Array<[string, (badId: string) => unknown]> = [
  ['addSubFlowChart', (id) => flowChart('Seed', noop, 'seed').addSubFlowChart(id, tinyChart())],
  ['addSubFlowChartNext', (id) => flowChart('Seed', noop, 'seed').addSubFlowChartNext(id, tinyChart())],
  ['addLazySubFlowChart', (id) => flowChart('Seed', noop, 'seed').addLazySubFlowChart(id, tinyChart)],
  ['addLazySubFlowChartNext', (id) => flowChart('Seed', noop, 'seed').addLazySubFlowChartNext(id, tinyChart)],
  [
    'DeciderList.addSubFlowChartBranch',
    (id) =>
      flowChart('Seed', noop, 'seed')
        .addDeciderFunction('Route', () => 'a', 'route')
        .addSubFlowChartBranch(id, tinyChart()),
  ],
  [
    'DeciderList.addLazySubFlowChartBranch',
    (id) =>
      flowChart('Seed', noop, 'seed')
        .addDeciderFunction('Route', () => 'a', 'route')
        .addLazySubFlowChartBranch(id, tinyChart),
  ],
  [
    'SelectorFnList.addSubFlowChartBranch',
    (id) => flowChartSelector('Pick', () => [id], 'pick').addSubFlowChartBranch(id, tinyChart()),
  ],
  [
    'SelectorFnList.addLazySubFlowChartBranch',
    (id) => flowChartSelector('Pick', () => [id], 'pick').addLazySubFlowChartBranch(id, tinyChart),
  ],
];

describe('reserved marker — refused in user-authored subflow ids', () => {
  it.each(subflowIdEntryPoints)('%s refuses a subflow id containing the marker', (_name, build) => {
    expect(() => build('sf~bad')).toThrow(/reserved character/);
  });

  it('the refusal sentence names the character, the reservation, and the design doc', () => {
    let message = '';
    try {
      flowChart('Seed', noop, 'seed').addSubFlowChart('sf~bad', tinyChart());
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("subflow id 'sf~bad'");
    expect(message).toContain("reserved character '~'");
    expect(message).toContain('9.14.0');
    expect(message).toContain('addParallelForEach()');
    expect(message).toContain('silently mis-attribute');
    expect(message).toContain('docs/design/execution-control.md');
  });

  it.each(subflowIdEntryPoints)('%s still accepts every id shape that was legal before', (_name, build) => {
    expect(() => build('sf-payment.v2_final')).not.toThrow();
  });

  it('a chart with no marker anywhere builds exactly as before (back-compat)', () => {
    const chart = flowChart('Seed', noop, 'seed').addSubFlowChart('sf-inner', tinyChart()).build();
    expect(chart.subflows?.['sf-inner']).toBeDefined();
    expect(chart.root.children?.[0].subflowId).toBe('sf-inner');
  });
});

describe('addParallelForEach — build-time refusals', () => {
  const validConfig = {
    items: () => [1, 2, 3],
    branch: () => tinyChart(),
    maxBranches: 4,
    into: 'results',
  };

  it('refuses the marker in its OWN id — the generated segment embeds it', () => {
    expect(() => flowChart('Seed', noop, 'seed').addParallelForEach('Fan out', 'fan~out', validConfig)).toThrow(
      /reserved character/,
    );
  });

  it("names the position it refused ('parallelForEach stage id')", () => {
    let message = '';
    try {
      flowChart('Seed', noop, 'seed').addParallelForEach('Fan out', 'fan~out', validConfig);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("parallelForEach stage id 'fan~out'");
    expect(message).toContain('docs/design/execution-control.md');
  });

  it('refuses a MISSING maxBranches, naming the resource-attack reason and the doc', () => {
    let message = '';
    try {
      flowChart('Seed', noop, 'seed').addParallelForEach('Fan out', 'fan-out', {
        items: () => [1],
        branch: () => tinyChart(),
        into: 'results',
      } as never);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('requires maxBranches');
    expect(message).toContain('resource attack');
    expect(message).toContain('docs/design/execution-control.md');
  });

  it.each([0, -1, 2.5, Number.NaN, '8' as unknown as number])(
    'refuses a maxBranches that is not a positive integer (%s)',
    (maxBranches) => {
      expect(() =>
        flowChart('Seed', noop, 'seed').addParallelForEach('Fan out', 'fan-out', {
          ...validConfig,
          maxBranches: maxBranches as number,
        }),
      ).toThrow(/requires maxBranches/);
    },
  );

  it('refuses a MISSING into, naming the silent-overwrite reason and the doc', () => {
    let message = '';
    try {
      flowChart('Seed', noop, 'seed').addParallelForEach('Fan out', 'fan-out', {
        items: () => [1],
        branch: () => tinyChart(),
        maxBranches: 2,
      } as never);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('requires into');
    expect(message).toContain('silently overwrite');
    expect(message).toContain('docs/design/execution-control.md');
  });

  it('refuses a config missing items() or branch()', () => {
    expect(() =>
      flowChart('Seed', noop, 'seed').addParallelForEach('Fan out', 'fan-out', {
        branch: () => tinyChart(),
        maxBranches: 2,
        into: 'results',
      } as never),
    ).toThrow(/requires items\(scope\) and branch\(item, index\)/);
    expect(() =>
      flowChart('Seed', noop, 'seed').addParallelForEach('Fan out', 'fan-out', {
        items: () => [1],
        maxBranches: 2,
        into: 'results',
      } as never),
    ).toThrow(/requires items\(scope\) and branch\(item, index\)/);
  });

  it('accepts a complete config and puts the stage in the chain', () => {
    const chart = flowChart('Seed', noop, 'seed')
      .addParallelForEach('Fan out', 'fan-out', validConfig)
      .addFunction('Merge', noop, 'merge')
      .build();

    expect(chart.root.next?.id).toBe('fan-out');
    expect(chart.root.next?.isDynamicParallel).toBe(true);
    expect(chart.root.next?.next?.id).toBe('merge');
  });
});

describe('addParallelForEach — serialized structure', () => {
  it("serializes as type 'fork' with the isDynamicParallel flag — no new node type", () => {
    const chart = flowChart('Seed', noop, 'seed')
      .addParallelForEach('Fan out', 'fan-out', {
        items: () => [1],
        branch: () => tinyChart(),
        maxBranches: 2,
        into: 'results',
      })
      .build();

    const spec = chart.buildTimeStructure.next!;
    expect(spec.id).toBe('fan-out');
    // 'fork' is what it IS — a fan-out — so every existing `switch (type)`
    // consumer keeps working without learning a new word.
    expect(spec.type).toBe('fork');
    expect(spec.isDynamicParallel).toBe(true);
  });

  it('is reachable through toMermaid()/toOpenAPI() without throwing on the new flag', () => {
    const chart = flowChart('Seed', noop, 'seed')
      .addParallelForEach('Fan out', 'fan-out', {
        items: () => [1],
        branch: () => tinyChart(),
        maxBranches: 2,
        into: 'results',
      })
      .build();

    expect(() => chart.toOpenAPI()).not.toThrow();
    // Mermaid sanitizes ids to `[A-Za-z0-9_]`, so `fan-out` renders as `fan_out`.
    expect(chart.toMermaid()).toContain('fan_out["Fan out"]');
  });
});
