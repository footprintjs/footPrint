/**
 * R5 (9.37.0) — every builder id door refuses the runtimeStageId grammar's
 * delimiters `#` and `/` (beside `~` where it was already refused), through
 * ONE helper (`ids/reservedIds.ts · refuseReservedId`).
 *
 * Why: the grammar is `[subflowPath/]stageId#executionIndex` and every reader
 * splits on the LAST delimiter. Before 9.37.0 a stage id `ns/a` was reported
 * INSIDE a subflow `ns` that does not exist, and a subflow id `sf#1` was
 * dropped from `listSubflowPaths` and from the pause checkpoint as if it were
 * a per-iteration key (probe3). Refusing the characters at the door makes
 * last-delimiter parsing sound by construction.
 *
 * One test per delimiter per door. The prefixer and the stores never refuse —
 * pinned at the bottom (they hold ids that carry the delimiters on purpose).
 */
import { describe, expect, it } from 'vitest';

import type { FlowChart } from '../../../src/index.js';
import { flowChart, FlowChartBuilder } from '../../../src/index.js';
import { BoundaryStateStore } from '../../../src/lib/recorder/BoundaryStateStore.js';

const noop = () => undefined;
const leaf = (): FlowChart => flowChart('Leaf', noop, 'leaf').build();
const pausable = { execute: noop, resume: noop };

/** Every door the builder admits a user-authored id through, as `(id) => build step`. */
const DOORS: Record<string, (id: string) => unknown> = {
  start: (id) => new FlowChartBuilder().start('S', noop, id),
  'flowChart()': (id) => flowChart('S', noop, id),
  startSelector: (id) => new FlowChartBuilder().startSelector('S', () => [], id),
  addFunction: (id) => flowChart('S', noop, 's').addFunction('F', noop, id),
  addStreamingFunction: (id) => flowChart('S', noop, 's').addStreamingFunction('F', noop, id),
  addPausableFunction: (id) => flowChart('S', noop, 's').addPausableFunction('P', pausable, id),
  addDeciderFunction: (id) => flowChart('S', noop, 's').addDeciderFunction('D', () => 'x', id),
  addSelectorFunction: (id) => flowChart('S', noop, 's').addSelectorFunction('Q', () => [], id),
  'addListOfFunction child': (id) => flowChart('S', noop, 's').addListOfFunction([{ id, name: 'C', fn: noop }]),
  addParallelForEach: (id) =>
    flowChart('S', noop, 's').addParallelForEach('Each', id, {
      items: () => [],
      branch: () => leaf(),
      maxBranches: 2,
      into: 'out',
    }),
  addSubFlowChart: (id) => flowChart('S', noop, 's').addSubFlowChart(id, leaf()),
  addSubFlowChartNext: (id) => flowChart('S', noop, 's').addSubFlowChartNext(id, leaf()),
  addLazySubFlowChart: (id) => flowChart('S', noop, 's').addLazySubFlowChart(id, () => leaf()),
  addLazySubFlowChartNext: (id) => flowChart('S', noop, 's').addLazySubFlowChartNext(id, () => leaf()),
  'decider addFunctionBranch': (id) =>
    flowChart('S', noop, 's')
      .addDeciderFunction('D', () => 'x', 'd')
      .addFunctionBranch(id, 'B', noop),
  'decider addPausableFunctionBranch': (id) =>
    flowChart('S', noop, 's')
      .addDeciderFunction('D', () => 'x', 'd')
      .addPausableFunctionBranch(id, 'B', pausable),
  'decider addSubFlowChartBranch': (id) =>
    flowChart('S', noop, 's')
      .addDeciderFunction('D', () => 'x', 'd')
      .addSubFlowChartBranch(id, leaf()),
  'decider addLazySubFlowChartBranch': (id) =>
    flowChart('S', noop, 's')
      .addDeciderFunction('D', () => 'x', 'd')
      .addLazySubFlowChartBranch(id, () => leaf()),
  'selector addFunctionBranch': (id) =>
    flowChart('S', noop, 's')
      .addSelectorFunction('Q', () => [], 'q')
      .addFunctionBranch(id, 'B', noop),
  'selector addPausableFunctionBranch': (id) =>
    flowChart('S', noop, 's')
      .addSelectorFunction('Q', () => [], 'q')
      .addPausableFunctionBranch(id, 'B', pausable),
  'selector addSubFlowChartBranch': (id) =>
    flowChart('S', noop, 's')
      .addSelectorFunction('Q', () => [], 'q')
      .addSubFlowChartBranch(id, leaf()),
  'selector addLazySubFlowChartBranch': (id) =>
    flowChart('S', noop, 's')
      .addSelectorFunction('Q', () => [], 'q')
      .addLazySubFlowChartBranch(id, () => leaf()),
};

describe('R5 — every id door refuses the grammar delimiters', () => {
  for (const [door, step] of Object.entries(DOORS)) {
    for (const delimiter of ['#', '/']) {
      it(`${door} refuses an id containing '${delimiter}'`, () => {
        expect(() => step(`ns${delimiter}a`)).toThrow(
          new RegExp(`^\\[FlowChartBuilder\\] .* 'ns${delimiter}a' contains the reserved character '${delimiter}'`),
        );
      });
    }
    it(`${door} still admits a plain id`, () => {
      expect(() => step('plain-id')).not.toThrow();
    });
  }
});

describe('R5 — what did NOT change', () => {
  it('a stage-position id may still contain `~` (only a subflow / parallelForEach id is a path segment)', () => {
    expect(() => flowChart('S', noop, 'a~b').addFunction('F', noop, 'c~1').build()).not.toThrow();
  });

  it('a subflow id with `~` is refused with the 9.14.0 sentence, byte for byte', () => {
    expect(() => flowChart('S', noop, 's').addSubFlowChartNext('sf~1', leaf())).toThrow(
      "[FlowChartBuilder] subflow id 'sf~1' contains the reserved character '~'. From 9.14.0 '~' is reserved",
    );
  });

  it('a mounted chart still carries `/` in its prefixed ids — the prefixer never refuses', () => {
    const inner = flowChart('In', noop, 'in').addFunction('Two', noop, 'two').build();
    const outer = flowChart('S', noop, 's').addSubFlowChartNext('sf', inner).build();
    expect([...outer.stageMap.keys()]).toContain('sf/two');
  });

  it('a store keyed by runtimeStageId takes `#` and `/` — stores never refuse', () => {
    const store = new BoundaryStateStore<number>();
    expect(() => store.start('sf/stage#0')).not.toThrow();
  });
});
