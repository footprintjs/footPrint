import { describe, expect, it, vi } from 'vitest';

import { flowChart } from '../../../../src/index';

const noop = () => {};
const expand = { expandSubflows: true };

function declaration(lines: string[], label: string, kind = ''): { id: string; index: number } {
  const index = lines.findIndex((line) => line.startsWith(kind) && line.endsWith(`["${label}"]`));
  const line = lines[index];
  if (!line) throw new Error(`Missing Mermaid declaration for ${label}`);
  return { id: line.slice(kind.length, line.indexOf('[')).trim(), index };
}

describe('chart.toMermaid({ expandSubflows: true })', () => {
  it('nests static mounts, keeps repeated stage IDs separate, and connects the mount boundaries', () => {
    const leaf = flowChart('Leaf Start', noop, 'start').addFunction('Leaf End', noop, 'leaf-end').build();
    const child = flowChart('Child Start', noop, 'start')
      .addSubFlowChartNext('nested', leaf, 'Nested Work')
      .addFunction('Child End', noop, 'child-end')
      .build();
    const chart = flowChart('Parent Start', noop, 'start')
      .addSubFlowChartNext('outer', child, 'Outer Work')
      .addFunction('Parent End', noop, 'parent-end')
      .build();
    const lines = chart
      .toMermaid(expand)
      .split('\n')
      .map((line) => line.trim());

    const parentStart = declaration(lines, 'Parent Start');
    const outer = declaration(lines, 'Outer Work', 'subgraph ');
    const childStart = declaration(lines, 'Child Start');
    const inner = declaration(lines, 'Nested Work', 'subgraph ');
    const leafStart = declaration(lines, 'Leaf Start');
    const leafEnd = declaration(lines, 'Leaf End');
    const childEnd = declaration(lines, 'Child End');
    const parentEnd = declaration(lines, 'Parent End');
    expect(lines.filter((line) => line === 'end')).toHaveLength(2);
    const innerEnd = lines.indexOf('end');
    const outerEnd = lines.lastIndexOf('end');
    expect(outer.index).toBeLessThan(childStart.index);
    expect(childStart.index).toBeLessThan(inner.index);
    expect(inner.index).toBeLessThan(leafStart.index);
    expect(leafStart.index).toBeLessThan(leafEnd.index);
    expect(leafEnd.index).toBeLessThan(innerEnd);
    expect(childEnd.index).toBeGreaterThan(innerEnd);
    expect(childEnd.index).toBeLessThan(outerEnd);
    expect(parentEnd.index).toBeGreaterThan(outerEnd);
    expect(new Set([parentStart.id, childStart.id, leafStart.id]).size).toBe(3);
    expect(lines).toEqual(
      expect.arrayContaining([
        `${parentStart.id} --> ${outer.id}`,
        `${childStart.id} --> ${inner.id}`,
        `${leafStart.id} --> ${leafEnd.id}`,
        `${inner.id} --> ${childEnd.id}`,
        `${outer.id} --> ${parentEnd.id}`,
      ]),
    );
  });

  it('connects a decider to the subflow box and keeps its other branch', () => {
    const review = flowChart('Check Order', noop, 'check').build();
    const chart = flowChart('Receive Order', noop, 'receive')
      .addDeciderFunction('Route Order', () => 'audit', 'route')
      .addSubFlowChartBranch('audit', review, 'Audit Order')
      .addFunctionBranch('skip', 'Skip Audit', noop)
      .end()
      .addFunction('Archive Order', noop, 'archive')
      .build();
    const lines = chart
      .toMermaid(expand)
      .split('\n')
      .map((line) => line.trim());

    const route = declaration(lines, 'Route Order');
    const audit = declaration(lines, 'Audit Order', 'subgraph ');
    const check = declaration(lines, 'Check Order');
    const skip = declaration(lines, 'Skip Audit');
    const archive = declaration(lines, 'Archive Order');
    expect(check.index).toBeGreaterThan(audit.index);
    expect(check.index).toBeLessThan(lines.indexOf('end', audit.index));
    expect(lines).toEqual(
      expect.arrayContaining([
        `${route.id} --> ${audit.id}`,
        `${route.id} --> ${skip.id}`,
        `${route.id} --> ${archive.id}`,
      ]),
    );
  });

  it('known limit: draws a default alias of a static mount as a second box', () => {
    const review = flowChart('Check Order', noop, 'check').build();
    const chart = flowChart('Start', noop, 'start')
      .addDeciderFunction('Route Order', () => 'default', 'route')
      .addSubFlowChartBranch('default', review, 'Audit Order')
      .setDefault('default')
      .end()
      .build();
    const lines = chart
      .toMermaid(expand)
      .split('\n')
      .map((line) => line.trim());

    expect(lines.filter((line) => line.startsWith('subgraph '))).toEqual([
      'subgraph fp_default["Audit Order"]',
      'subgraph fp_default_2["Audit Order"]',
    ]);
    expect(lines).toEqual(expect.arrayContaining(['fp_route --> fp_default', 'fp_route --> fp_default_2']));
  });

  it('labels a lazy mount with its run-time status without trying to resolve it', () => {
    const resolver = vi.fn(() => flowChart('Lazy Step', noop, 'lazy-step').build());
    const chart = flowChart('Start', noop, 'start')
      .addLazySubFlowChartNext('lazy', resolver, 'Load Workflow')
      .addFunction('Finish', noop, 'finish')
      .build();
    const lines = chart
      .toMermaid(expand)
      .split('\n')
      .map((line) => line.trim());

    const { id } = declaration(lines, 'Load Workflow (lazy subflow at run time)');
    expect(lines).toContain(`${declaration(lines, 'Start').id} --> ${id}`);
    expect(lines).toContain(`${id} --> ${declaration(lines, 'Finish').id}`);
    expect(lines.join('\n')).not.toMatch(/subgraph|Lazy Step/);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('labels a parallelForEach stage without looking for items or building a branch', () => {
    const items = vi.fn(() => [1]);
    const branch = vi.fn(() => flowChart('Item Step', noop, 'item-step').build());
    const chart = flowChart('Start', noop, 'start')
      .addParallelForEach('Process Items', 'each', { items, branch, into: 'results', maxBranches: 1 })
      .addFunction('Finish', noop, 'finish')
      .build();
    const lines = chart
      .toMermaid(expand)
      .split('\n')
      .map((line) => line.trim());

    const { id } = declaration(lines, 'Process Items (parallelForEach branches at run time)');
    expect(lines).toContain(`${declaration(lines, 'Start').id} --> ${id}`);
    expect(lines).toContain(`${id} --> ${declaration(lines, 'Finish').id}`);
    expect(lines.join('\n')).not.toMatch(/subgraph|Item Step/);
    expect(items).not.toHaveBeenCalled();
    expect(branch).not.toHaveBeenCalled();
  });

  it('separates repeated mount placements and scopes each back-edge to its own box', () => {
    const child = flowChart('Child Start', noop, 'start')
      .addFunction('Child End', noop, 'finish')
      .loopTo('start')
      .build();
    const chart = flowChart('Start', noop, 'start')
      .addSubFlowChartNext('repeat', child, 'First Copy')
      .addFunction('Between Mounts', noop, 'between')
      .addSubFlowChartNext('repeat', child, 'Second Copy')
      .addFunction('Finish', noop, 'finish')
      .build();
    const lines = chart
      .toMermaid(expand)
      .split('\n')
      .map((line) => line.trim());

    const first = declaration(lines, 'First Copy', 'subgraph ');
    const second = declaration(lines, 'Second Copy', 'subgraph ');
    const between = declaration(lines, 'Between Mounts');
    const firstBox = lines.slice(first.index + 1, lines.indexOf('end', first.index));
    const secondBox = lines.slice(second.index + 1, lines.indexOf('end', second.index));
    const firstStart = declaration(firstBox, 'Child Start');
    const firstEnd = declaration(firstBox, 'Child End');
    const secondStart = declaration(secondBox, 'Child Start');
    const secondEnd = declaration(secondBox, 'Child End');
    expect(new Set([first.id, second.id, firstStart.id, secondStart.id, firstEnd.id, secondEnd.id]).size).toBe(6);
    expect(lines).toEqual(
      expect.arrayContaining([
        `${declaration(lines, 'Start').id} --> ${first.id}`,
        `${first.id} --> ${between.id}`,
        `${between.id} --> ${second.id}`,
        `${second.id} --> ${declaration(lines, 'Finish').id}`,
        `${firstEnd.id} --> ${firstStart.id}`,
        `${secondEnd.id} --> ${secondStart.id}`,
      ]),
    );
  });

  it('keeps unresolved loop edges and labels their shared target inside its mount', () => {
    const child = flowChart('Child Start', noop, 'start')
      .addDeciderFunction('Route', () => 'retry', 'route')
      .addFunctionBranch('retry', 'Retry', noop, undefined, { loopTo: 'start' })
      .addFunctionBranch('recover', 'Recover', noop, undefined, { loopTo: 'start' })
      .end()
      .build();
    const chart = flowChart('Start', noop, 'start').addSubFlowChartNext('mount', child, 'Mount').build();
    const branches = chart.subflows?.mount?.root.next?.children ?? [];
    expect(branches).toHaveLength(2);
    // The builder validates loop targets, so simulate graph data with a missing target after compilation.
    for (const branch of branches) {
      const loop = branch.next;
      if (!loop?.isLoopRef) throw new Error('Expected the compiled branch to have a loop reference');
      loop.id = 'missing/"entry"';
    }

    const lines = chart
      .toMermaid(expand)
      .split('\n')
      .map((line) => line.trim());
    const mount = declaration(lines, 'Mount', 'subgraph ');
    const label = 'Undrawn target missing/#quot;entry#quot;';
    const target = declaration(lines, label);
    expect(lines.filter((line) => line.endsWith(`["${label}"]`))).toHaveLength(1);
    expect(target.index).toBeGreaterThan(mount.index);
    expect(target.index).toBeLessThan(lines.indexOf('end', mount.index));
    expect(lines.filter((line) => line.endsWith(` --> ${target.id}`))).toEqual([
      `${declaration(lines, 'Retry').id} --> ${target.id}`,
      `${declaration(lines, 'Recover').id} --> ${target.id}`,
    ]);
  });

  it('preserves the default output for the builder and the built chart', () => {
    const child = flowChart('Child', noop, 'child').build();
    const builder = flowChart('Start', noop, 'start').addSubFlowChartNext('mount', child, 'Mount');
    const chart = builder.build();
    const legacy = 'flowchart TD\nstart["Start"]\nstart --> mount\nmount["Mount"]';

    expect(chart.toMermaid(expand)).toContain('subgraph ');
    expect(builder.toMermaid()).toBe(legacy);
    expect(chart.toMermaid({ expandSubflows: false })).toBe(legacy);
    expect(chart.toMermaid()).toBe(legacy);
  });
});
