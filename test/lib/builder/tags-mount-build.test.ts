/**
 * Declared tags on a subflow MOUNT (9.21.1) — the BUILD-TIME half.
 *
 * 9.21.0 gave every stage-shaped node a `tags` site but none to a mount:
 * `SubflowMountOptions` had no `tags`, and the mount methods never called
 * `applyTags`. A mount commits (its first bundle is a stop in `commitStops`),
 * so law 3 of docs/design/2026-09-declared-tags.md — the tag is the fact —
 * needs it taggable. Same ONE landing site, same refusals.
 *
 * Test types: Unit (every mount method lands `options.tags` on node + spec)
 * · Boundary (empty list is absent; duplicate; double-declare) · Security
 * (non-string, the reserved `~` marker, the cursor-tail guard still refuses
 * `.tag()` after a fork-child mount and names the right site) · Integration
 * (the Map advertises a mount's tags; a tagged mount survives being prefixed
 * when its chart is itself mounted).
 */
import { describe, expect, it } from 'vitest';

import type { StageNode } from '../../../src/advanced.js';
import type { StructureRecorder, StructureStageAddedEvent } from '../../../src/index.js';
import { flowChart } from '../../../src/index.js';

interface State {
  n?: number;
  [key: string]: unknown;
}

const noop = () => undefined;
const inner = () => flowChart<State>('Inner', noop, 'inner').build();
const seed = () => flowChart<State>('Seed', noop, 'seed');

const tagsOf = (node: { tags?: readonly string[] } | undefined) => node?.tags;

describe('tags on a mount — every mount method lands options.tags on node + spec', () => {
  it('addSubFlowChart (fork-child mount)', () => {
    const chart = seed()
      .addSubFlowChart('sf', inner(), 'Sub', { tags: ['probe', 'audit'] })
      .build();
    const mount = chart.root.children![0];
    expect(mount.id).toBe('sf');
    expect(mount.tags).toEqual(['probe', 'audit']);
    expect(Object.isFrozen(mount.tags)).toBe(true);
    const spec = chart.buildTimeStructure.children![0];
    expect(spec.tags).toEqual(['probe', 'audit']);
    expect(spec.tags).not.toBe(mount.tags);
  });

  it('addLazySubFlowChart (lazy fork-child mount)', () => {
    const chart = seed()
      .addLazySubFlowChart('lz', () => inner(), 'Lazy', { tags: ['probe'] })
      .build();
    expect(tagsOf(chart.root.children![0])).toEqual(['probe']);
    expect(tagsOf(chart.buildTimeStructure.children![0])).toEqual(['probe']);
  });

  it('addSubFlowChartNext (linear mount)', () => {
    const chart = seed()
      .addSubFlowChartNext('sf', inner(), 'Sub', { tags: ['probe'] })
      .build();
    expect(tagsOf(chart.root.next)).toEqual(['probe']);
    expect(tagsOf(chart.buildTimeStructure.next)).toEqual(['probe']);
  });

  it('addLazySubFlowChartNext (lazy linear mount)', () => {
    const chart = seed()
      .addLazySubFlowChartNext('lz', () => inner(), 'Lazy', { tags: ['probe'] })
      .build();
    expect(tagsOf(chart.root.next)).toEqual(['probe']);
    expect(tagsOf(chart.buildTimeStructure.next)).toEqual(['probe']);
  });

  it('DeciderList.addSubFlowChartBranch + addLazySubFlowChartBranch', () => {
    const chart = seed()
      .addDeciderFunction('Route', () => 'left', 'route')
      .addSubFlowChartBranch('left', inner(), 'Left', { tags: ['went-left'] })
      .addLazySubFlowChartBranch('right', () => inner(), 'Right', { tags: ['went-right'] })
      .end()
      .build();
    const route = chart.root.next!;
    expect(route.children!.map((c) => c.tags)).toEqual([['went-left'], ['went-right']]);
    expect(chart.buildTimeStructure.next!.children!.map((c) => c.tags)).toEqual([['went-left'], ['went-right']]);
  });

  it('SelectorFnList.addSubFlowChartBranch + addLazySubFlowChartBranch', () => {
    const chart = seed()
      .addSelectorFunction('Pick', () => ['x'], 'pick')
      .addSubFlowChartBranch('x', inner(), 'X', { tags: ['picked-x'] })
      .addLazySubFlowChartBranch('y', () => inner(), 'Y', { tags: ['picked-y'] })
      .end()
      .build();
    const pick = chart.root.next!;
    expect(pick.children!.map((c) => c.tags)).toEqual([['picked-x'], ['picked-y']]);
    expect(chart.buildTimeStructure.next!.children!.map((c) => c.tags)).toEqual([['picked-x'], ['picked-y']]);
  });

  it('the other mount options ride beside tags untouched', () => {
    const inputMapper = (p: State) => ({ n: p.n });
    const chart = seed()
      .addSubFlowChartNext('sf', inner(), 'Sub', { tags: ['probe'], inputMapper, convergeAt: 'later' })
      .build();
    const mount = chart.root.next!;
    expect(mount.subflowMountOptions?.inputMapper).toBe(inputMapper);
    expect(mount.subflowMountOptions?.tags).toEqual(['probe']);
    expect(mount.tags).toEqual(['probe']);
  });
});

describe('tags on a mount — absent when empty', () => {
  it('a mount with options but no tags, and a mount with tags: [], have no `tags` key', () => {
    const chart = seed()
      .addSubFlowChart('a', inner(), 'A', { inputMapper: (p: State) => ({ n: p.n }) })
      .addSubFlowChart('b', inner(), 'B', { tags: [] })
      .addSubFlowChart('c', inner(), 'C')
      .build();
    for (const child of chart.root.children!) expect(child).not.toHaveProperty('tags');
    for (const child of chart.buildTimeStructure.children!) expect(child).not.toHaveProperty('tags');
  });
});

describe('tags on a mount — the same refusals as everywhere else', () => {
  it('refuses a non-string, an empty name, a duplicate, and a non-array', () => {
    expect(() => seed().addSubFlowChart('sf', inner(), 'Sub', { tags: [42 as unknown as string] })).toThrow(
      /addSubFlowChart\('sf'\): a tag must be a string name \(got number\)/,
    );
    expect(() => seed().addSubFlowChartNext('sf', inner(), 'Sub', { tags: [' '] })).toThrow(
      /addSubFlowChartNext\('sf'\): a tag cannot be an empty string/,
    );
    expect(() =>
      seed()
        .addSelectorFunction('Pick', () => ['x'], 'pick')
        .addSubFlowChartBranch('x', inner(), 'X', { tags: ['a', 'a'] }),
    ).toThrow(/addSubFlowChartBranch\('x'\): tag 'a' is declared twice/);
    expect(() => seed().addSubFlowChart('sf', inner(), 'Sub', { tags: 'x' as unknown as string[] })).toThrow(
      /tags must be an array of names/,
    );
  });

  it("refuses the reserved branch-segment marker '~' inside a mount's tag", () => {
    expect(() =>
      seed()
        .addDeciderFunction('Route', () => 'left', 'route')
        .addSubFlowChartBranch('left', inner(), 'Left', { tags: ['a~b'] }),
    ).toThrow(/addSubFlowChartBranch\('left'\): tag 'a~b' contains the reserved character '~'/);
    expect(() => seed().addLazySubFlowChartNext('lz', () => inner(), 'Lazy', { tags: ['x~1'] })).toThrow(
      /addLazySubFlowChartNext\('lz'\): tag 'x~1' contains the reserved character/,
    );
  });

  it('refuses a second declaration: .tag() after a linear mount that already declared options.tags', () => {
    expect(() =>
      seed()
        .addSubFlowChartNext('sf', inner(), 'Sub', { tags: ['a'] })
        .tag('b'),
    ).toThrow(/tag\(\) at 'Sub': tags already declared at 'Sub' \(a\)/);
  });

  it('.tag() after a fork-child mount is STILL refused — the cursor stayed on the parent — and names the site', () => {
    // A fork-child mount is one of N siblings pushed under the cursor; the
    // cursor never moves, so "the stage you just added" is ambiguous. The
    // unambiguous site is the mount's own options — exactly like a fork
    // child's `tags` entry, and the same law `.retry()` keeps.
    expect(() => seed().addSubFlowChart('sf', inner(), 'Sub').tag('x')).toThrow(
      /tag\(\) cannot follow the subflow mount 'Sub'[\s\S]*`tags` field in the mount's own options/,
    );
    expect(() =>
      seed()
        .addLazySubFlowChart('lz', () => inner(), 'Lazy')
        .tag('x'),
    ).toThrow(/tag\(\) cannot follow the lazy subflow mount 'Lazy'/);
    // …and the site it names works, on the same chart shape.
    const chart = seed()
      .addSubFlowChart('sf', inner(), 'Sub', { tags: ['x'] })
      .build();
    expect(chart.root.children![0].tags).toEqual(['x']);
  });
});

describe('tags on a mount — the Map advertises them; prefixing keeps them', () => {
  it('a StructureRecorder sees `tags` on the mount spec at fire time (options are applied before the event)', () => {
    const seen: StructureStageAddedEvent[] = [];
    const recorder: StructureRecorder = { id: 'tags-probe', onStageAdded: (e) => seen.push(e) };
    flowChart<State>('Seed', noop, 'seed', { structureRecorders: [recorder] })
      .addSubFlowChart('sf', inner(), 'Sub', { tags: ['probe'] })
      .addSelectorFunction('Pick', () => ['x'], 'pick')
      .addSubFlowChartBranch('x', inner(), 'X', { tags: ['picked-x'] })
      .end()
      .build();
    const byId = new Map(seen.map((e) => [e.stageId, e.spec.tags]));
    expect(byId.get('sf')).toEqual(['probe']);
    expect(byId.get('x')).toEqual(['picked-x']);
  });

  it('a tagged mount inside a chart that is itself mounted keeps its tags through the prefixer', () => {
    const middle = seed()
      .addSubFlowChartNext('sf', inner(), 'Sub', { tags: ['probe'] })
      .build();
    const outer = seed().addSubFlowChartNext('mid', middle, 'Middle').build();
    const midRoot = outer.subflows?.mid?.root as StageNode | undefined;
    expect(midRoot?.id).toBe('mid/seed');
    const prefixedMount = midRoot?.next;
    expect(prefixedMount?.id).toBe('mid/sf');
    expect(prefixedMount?.isSubflowRoot).toBe(true);
    expect(prefixedMount?.tags).toEqual(['probe']);
    // The outer mount itself declared nothing — the inner tag did not leak up.
    expect(outer.root.next).not.toHaveProperty('tags');
  });
});
