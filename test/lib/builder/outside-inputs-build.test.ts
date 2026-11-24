import { describe, expect, it } from 'vitest';

import { flowChart, flowChartSelector } from '../../../src/index.js';
import { RuntimeStructureManager } from '../../../src/lib/engine/handlers/RuntimeStructureManager.js';

const noop = () => undefined;
const seed = () => flowChart('Seed', noop, 'seed');

describe('build-time outside inputs', () => {
  it('puts separate copies on the current stage and its serialized spec', () => {
    const chart = seed().addFunction('Look up', noop, 'lookup').tag('audit').outside('clock', 'rates.read').build();
    const node = chart.root.next;
    const spec = chart.buildTimeStructure.next;
    expect(node?.outsideInputs).toEqual(['clock', 'rates.read']);
    expect(spec?.outsideInputs).toEqual(node?.outsideInputs);
    expect(spec?.outsideInputs).not.toBe(node?.outsideInputs);
    expect(Object.isFrozen(node?.outsideInputs)).toBe(true);
    expect(JSON.parse(JSON.stringify(spec))).toMatchObject({ outsideInputs: ['clock', 'rates.read'], tags: ['audit'] });
    expect(chart.root).not.toHaveProperty('outsideInputs');
    expect(chart.buildTimeStructure).not.toHaveProperty('outsideInputs');
  });

  it('detaches option names on the first stage, selector and pausable branch', () => {
    const declared = ['clock'];
    const root = flowChart('Seed', noop, 'seed', { outsideInputs: declared }).build();
    declared[0] = 'other';
    expect(root.root.outsideInputs).toEqual(['clock']);
    expect(root.buildTimeStructure.outsideInputs).toEqual(['clock']);

    const selector = flowChartSelector('Pick', () => ['gate'], 'pick', { outsideInputs: ['random'] })
      .addPausableFunctionBranch('gate', 'Gate', { execute: noop, resume: noop }, undefined, {
        outsideInputs: ['process'],
      })
      .end()
      .build();
    expect(selector.root.outsideInputs).toEqual(['random']);
    expect(selector.buildTimeStructure.outsideInputs).toEqual(['random']);
    expect(selector.root.children?.[0].outsideInputs).toEqual(['process']);
    expect(selector.buildTimeStructure.children?.[0].outsideInputs).toEqual(['process']);
  });

  it('keeps fork children and mounts separate from their parent and nested stages', () => {
    const inner = flowChart('Inside', noop, 'inside').outside('clock').build();
    const chart = seed()
      .addListOfFunction([{ id: 'reader', name: 'Reader', fn: noop, outsideInputs: ['file'] }])
      .addLazySubFlowChartNext('lazy', () => inner, 'Lazy', { outsideInputs: ['network'] })
      .build();
    expect(chart.root).not.toHaveProperty('outsideInputs');
    expect(chart.root.children?.[0].outsideInputs).toEqual(['file']);
    expect(chart.buildTimeStructure.children?.[0].outsideInputs).toEqual(['file']);
    expect(chart.root.next?.outsideInputs).toEqual(['network']);
    expect(chart.buildTimeStructure.next?.outsideInputs).toEqual(['network']);
    expect(inner.root.outsideInputs).toEqual(['clock']);
    expect(new RuntimeStructureManager().stageNodeToStructure(inner.root).outsideInputs).toEqual(['clock']);
  });

  it('keeps the decider and its branch declarations on their own nodes and specs', () => {
    const inner = flowChart('Inside', noop, 'inside').outside('clock').build();
    const chart = seed()
      .addDeciderFunction('Route', () => 'local', 'route', undefined, { outsideInputs: ['zone'] })
      .addFunctionBranch('local', 'Local', noop, undefined, { outsideInputs: ['file'] })
      .addSubFlowChartBranch('remote', inner, 'Remote', { outsideInputs: ['network'] })
      .end()
      .build();
    for (const route of [chart.root.next, chart.buildTimeStructure.next]) {
      expect(route?.outsideInputs).toEqual(['zone']);
      expect(route?.children?.map((branch) => branch.outsideInputs)).toEqual([['file'], ['network']]);
    }
    expect(chart.subflows?.remote?.root).toMatchObject({ id: 'remote/inside', outsideInputs: ['clock'] });
    expect(chart.buildTimeStructure.next?.children?.[1].subflowStructure?.outsideInputs).toEqual(['clock']);
  });

  it('keeps the declaration on the executable stage when the path loops', () => {
    const chart = seed().loopTo('seed').outside('clock').build();
    expect(chart.root.outsideInputs).toEqual(['clock']);
    expect(chart.buildTimeStructure.outsideInputs).toEqual(['clock']);
    expect(chart.root.next).not.toHaveProperty('outsideInputs');
    expect(chart.buildTimeStructure.next).not.toHaveProperty('outsideInputs');
  });

  it('refuses an ambiguous cursor or second declaration and keeps empty options absent', () => {
    const fork = seed().addListOfFunction([{ id: 'child', name: 'Child' }]);
    expect(() => fork.outside('clock')).toThrow(/cursor still points at 'Seed'.+outsideInputs option/);
    const mounted = seed().addSubFlowChartNext('mount', seed().build(), 'Mount', { outsideInputs: ['file'] });
    expect(() => mounted.outside('clock')).toThrow(/already declared/);
    expect(() => seed().outside()).toThrow(/at least one name/);
    const empty = flowChart('Seed', noop, 'seed', { outsideInputs: [] }).build();
    expect(empty.root).not.toHaveProperty('outsideInputs');
    expect(empty.buildTimeStructure).not.toHaveProperty('outsideInputs');
  });

  it('admits the canonical length and count and refuses duplicates or excess', () => {
    const names = ['x'.repeat(128), ...Array.from({ length: 127 }, (_, index) => `input.${index}`)];
    expect(
      seed()
        .outside(...names)
        .build().root.outsideInputs,
    ).toEqual(names);
    expect(() => seed().outside(...names, 'extra')).toThrow(/at most 128 outside inputs/);
    expect(() => seed().outside('file', 'file')).toThrow(/name 2 is declared twice/);
  });

  it('refuses an accessor in a branch option without invoking it', () => {
    let reads = 0;
    const names = Object.defineProperty(['clock'], '0', { get: () => ++reads });
    expect(() => seed().addListOfFunction([{ id: 'child', name: 'Child', outsideInputs: names }])).toThrow(
      /outside input name 1 must be a string/,
    );
    expect(reads).toBe(0);
  });

  it.each(['secret\nlabel', 'private'.repeat(20), '   ', 42])(
    'refuses malformed names without echoing them',
    (name) => {
      expect.assertions(2);
      try {
        seed().outside(name as string);
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toMatch(/outside input name 1/);
        expect(message).not.toContain(String(name));
      }
    },
  );
});
