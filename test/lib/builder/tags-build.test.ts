/**
 * Declared tags (9.21.0) — the BUILD-TIME half.
 *
 * A tag is a NAME an author puts on a stage while writing the chart. It lands
 * in ONE place (`applyTags`, the twin of `applyRetryPolicy`) from every
 * declaration site — the `.tag()` modifier and each method's `tags` option —
 * so the refusals and the spec's mirror can never drift between them.
 *
 * Test types: Unit (every declaration site lands on node + spec) · Boundary
 * (empty list, whitespace, duplicates, double-declare) · Security (a value
 * is refused: non-strings; the reserved `~` marker; the cursor-tail
 * mis-attribution guard) · Integration (the Map advertises the vocabulary —
 * a StructureRecorder sees `tags` on the spec node; the prefixer keeps it).
 */
import { describe, expect, it } from 'vitest';

import type { StructureRecorder, StructureStageAddedEvent, StructureStageTaggedEvent } from '../../../src/index.js';
import { flowChart, flowChartSelector } from '../../../src/index.js';

interface State {
  a?: number;
  [key: string]: unknown;
}

const noop = () => undefined;

describe('tags — declaration sites', () => {
  it('.tag() puts the names on the stage just added, and on its spec', () => {
    const chart = flowChart<State>('Seed', noop, 'seed')
      .addFunction('Work', noop, 'work')
      .tag('milestone:llm-turn', 'audit')
      .build();

    expect(chart.root.next?.tags).toEqual(['milestone:llm-turn', 'audit']);
    expect(chart.buildTimeStructure.next?.tags).toEqual(['milestone:llm-turn', 'audit']);
    // The node's copy is frozen (bundles share it); the spec's is its own array.
    expect(Object.isFrozen(chart.root.next?.tags)).toBe(true);
    expect(chart.buildTimeStructure.next?.tags).not.toBe(chart.root.next?.tags);
  });

  it('.tag() applies to the START stage when chained straight off flowChart()', () => {
    const chart = flowChart<State>('Seed', noop, 'seed').tag('first').build();
    expect(chart.root.tags).toEqual(['first']);
    expect(chart.buildTimeStructure.tags).toEqual(['first']);
  });

  it('flowChart({ tags }) declares the start stage without a chained call', () => {
    const chart = flowChart<State>('Seed', noop, 'seed', { tags: ['first'] }).build();
    expect(chart.root.tags).toEqual(['first']);
    expect(chart.buildTimeStructure.tags).toEqual(['first']);
  });

  it('flowChartSelector({ tags }) declares the root selector stage', () => {
    const chart = flowChartSelector<State>('Pick', () => ['x'], 'pick', { tags: ['root'] })
      .addFunctionBranch('x', 'X', noop)
      .end()
      .build();
    expect(chart.root.tags).toEqual(['root']);
    expect(chart.buildTimeStructure.tags).toEqual(['root']);
  });

  it('.tag() applies to streaming, pausable, subflow-mount and parallel-for-each stages', () => {
    const inner = flowChart<State>('Inner', noop, 'inner').build();
    const chart = flowChart<State>('Seed', noop, 'seed')
      .addStreamingFunction('Stream', noop, 'stream')
      .tag('streamed')
      .addPausableFunction('Gate', { execute: noop, resume: noop }, 'gate')
      .tag('gated')
      .addSubFlowChartNext('sf', inner, 'Sub')
      .tag('mounted')
      .addParallelForEach('Each', 'each', { items: () => [], branch: () => inner, maxBranches: 4, into: 'results' })
      .tag('fanned')
      .build();

    const ids = (node: { id: string; next?: unknown } | undefined) => node;
    const stream = ids(chart.root.next)!;
    expect(stream.id).toBe('stream');
    expect((stream as { tags?: readonly string[] }).tags).toEqual(['streamed']);
    const gate = (stream as { next?: { id: string; tags?: readonly string[] } }).next!;
    expect(gate.id).toBe('gate');
    expect(gate.tags).toEqual(['gated']);
    const mount = (gate as { next?: { id: string; tags?: readonly string[] } }).next!;
    expect(mount.id).toBe('sf');
    expect(mount.tags).toEqual(['mounted']);
    const each = (mount as { next?: { id: string; tags?: readonly string[] } }).next!;
    expect(each.id).toBe('each');
    expect(each.tags).toEqual(['fanned']);
  });

  it('options.tags lands on decider branches, selector branches, the decider/selector stage itself', () => {
    const chart = flowChart<State>('Seed', noop, 'seed')
      .addDeciderFunction('Route', () => 'left', 'route', undefined, { tags: ['decides'] })
      .addFunctionBranch('left', 'Left', noop, undefined, { tags: ['went-left'] })
      .addPausableFunctionBranch('right', 'Right', { execute: noop, resume: noop }, undefined, {
        tags: ['went-right'],
      })
      .end()
      .addFunction('Between', noop, 'between')
      .addSelectorFunction('Pick', () => ['x'], 'pick', undefined, { tags: ['selects'] })
      .addFunctionBranch('x', 'X', noop, undefined, { tags: ['picked-x'] })
      .addPausableFunctionBranch('y', 'Y', { execute: noop, resume: noop }, undefined, { tags: ['picked-y'] })
      .end()
      .build();

    const route = chart.root.next!;
    expect(route.tags).toEqual(['decides']);
    expect(route.children?.map((c) => c.tags)).toEqual([['went-left'], ['went-right']]);
    const pick = route.next!.next!;
    expect(pick.id).toBe('pick');
    expect(pick.tags).toEqual(['selects']);
    expect(pick.children?.map((c) => c.tags)).toEqual([['picked-x'], ['picked-y']]);

    const routeSpec = chart.buildTimeStructure.next!;
    expect(routeSpec.tags).toEqual(['decides']);
    expect(routeSpec.children?.map((c) => c.tags)).toEqual([['went-left'], ['went-right']]);
  });

  it('a fork child declares its own tags on the SimplifiedParallelSpec', () => {
    const chart = flowChart<State>('Seed', noop, 'seed')
      .addFunction('Fork', noop, 'fork')
      .addListOfFunction([
        { id: 'a', name: 'A', fn: noop, tags: ['child-a'] },
        { id: 'b', name: 'B', fn: noop },
      ])
      .build();
    const fork = chart.root.next!;
    expect(fork.children?.map((c) => c.tags)).toEqual([['child-a'], undefined]);
    expect(chart.buildTimeStructure.next?.children?.map((c) => c.tags)).toEqual([['child-a'], undefined]);
  });
});

describe('tags — absent when empty', () => {
  it('an untagged stage has no `tags` key on node or spec', () => {
    const chart = flowChart<State>('Seed', noop, 'seed').addFunction('Work', noop, 'work').build();
    expect(chart.root).not.toHaveProperty('tags');
    expect(chart.buildTimeStructure).not.toHaveProperty('tags');
    expect(chart.root.next!).not.toHaveProperty('tags');
    expect(chart.buildTimeStructure.next!).not.toHaveProperty('tags');
  });

  it('options.tags: [] lands nothing — declared-but-empty is absent, not []', () => {
    const chart = flowChart<State>('Seed', noop, 'seed', { tags: [] }).build();
    expect(chart.root).not.toHaveProperty('tags');
    expect(chart.buildTimeStructure).not.toHaveProperty('tags');
  });
});

describe('tags — refusals at build time', () => {
  const seed = () => flowChart<State>('Seed', noop, 'seed').addFunction('Work', noop, 'work');

  it('refuses an empty or whitespace-only name', () => {
    expect(() => seed().tag('')).toThrow(/tag\(\) at 'Work': a tag cannot be an empty string/);
    expect(() => seed().tag('  ')).toThrow(/cannot be an empty string/);
  });

  it('refuses a non-string — a tag is a NAME, never a value', () => {
    expect(() => seed().tag(42 as unknown as string)).toThrow(/a tag must be a string name \(got number\)/);
    expect(() => seed().tag(null as unknown as string)).toThrow(/got null/);
    expect(() => flowChart<State>('Seed', noop, 'seed', { tags: 'x' as unknown as string[] })).toThrow(
      /tags must be an array of names/,
    );
  });

  it("refuses the reserved branch-segment marker '~' inside a name", () => {
    expect(() => seed().tag('llm~turn')).toThrow(/contains the reserved character '~'/);
    expect(() => flowChart<State>('Seed', noop, 'seed', { tags: ['a~b'] })).toThrow(/reserved character '~'/);
    expect(() =>
      flowChart<State>('Seed', noop, 'seed')
        .addFunction('Fork', noop, 'fork')
        .addListOfFunction([{ id: 'a', name: 'A', fn: noop, tags: ['x~1'] }]),
    ).toThrow(/addListOfFunction child 'a': tag 'x~1' contains the reserved character/);
  });

  it('refuses a name declared twice in one call, and a second declaration on the same stage', () => {
    expect(() => seed().tag('a', 'a')).toThrow(/tag 'a' is declared twice/);
    expect(() => seed().tag('a').tag('b')).toThrow(/tags already declared at 'Work' \(a\)/);
    expect(() => flowChart<State>('Seed', noop, 'seed', { tags: ['a'] }).tag('b')).toThrow(/already declared/);
  });

  it('refuses .tag() with no names', () => {
    expect(() => seed().tag()).toThrow(/at least one name is required/);
  });

  it('refuses .tag() after a mount or a fork that left the cursor behind (mis-attribution guard)', () => {
    const inner = flowChart<State>('Inner', noop, 'inner').build();
    expect(() => seed().addSubFlowChart('sf', inner, 'Sub').tag('x')).toThrow(
      /tag\(\) cannot follow the subflow mount 'Sub'/,
    );
    expect(() =>
      seed()
        .addListOfFunction([{ id: 'a', name: 'A', fn: noop }])
        .tag('x'),
    ).toThrow(/tag\(\) cannot follow the parallel children/);
  });
});

describe('tags — the Map advertises the vocabulary', () => {
  it('a StructureRecorder sees `tags` on the spec node for every options.tags site', () => {
    const seen: StructureStageAddedEvent[] = [];
    const recorder: StructureRecorder = {
      id: 'tags-probe',
      onStageAdded: (e) => seen.push(e),
    };
    flowChart<State>('Seed', noop, 'seed', { structureRecorders: [recorder], tags: ['first'] })
      .addDeciderFunction('Route', () => 'left', 'route', undefined, { tags: ['decides'] })
      .addFunctionBranch('left', 'Left', noop, undefined, { tags: ['went-left'] })
      .end()
      .build();

    const byId = new Map(seen.map((e) => [e.stageId, e.spec.tags]));
    expect(byId.get('seed')).toEqual(['first']);
    expect(byId.get('route')).toEqual(['decides']);
    expect(byId.get('left')).toEqual(['went-left']);
  });

  it('.tag() is chained AFTER onStageAdded fires (the retryAttempts law) — read the BUILT spec', () => {
    const seen: StructureStageAddedEvent[] = [];
    const recorder: StructureRecorder = { id: 'tags-probe', onStageAdded: (e) => seen.push(e) };
    const chart = flowChart<State>('Seed', noop, 'seed', { structureRecorders: [recorder] })
      .addFunction('Work', noop, 'work')
      .tag('later')
      .build();
    // The live spec reference the event carried now shows it; the built spec is the source of truth.
    expect(seen.find((e) => e.stageId === 'work')?.spec.tags).toEqual(['later']);
    expect(chart.buildTimeStructure.next?.tags).toEqual(['later']);
  });

  describe('9.24.0 — a recorder that COPIES at event time still learns every name', () => {
    /** The shape the gap was about: fields copied at `onStageAdded`, `spec` not held. */
    function copyingRecorder() {
      const added: { stageId: string; tags?: readonly string[] }[] = [];
      const tagged: StructureStageTaggedEvent[] = [];
      const recorder: StructureRecorder = {
        id: 'copier',
        onStageAdded: (e) => added.push({ stageId: e.stageId, ...(e.tags !== undefined && { tags: e.tags }) }),
        onStageTagged: (e) => tagged.push(e),
      };
      return { recorder, added, tagged };
    }

    it('options.tags ride `onStageAdded.tags`; the `.tag()` door fires `onStageTagged` with the full list', () => {
      const { recorder, added, tagged } = copyingRecorder();
      flowChart<State>('Seed', noop, 'seed', { structureRecorders: [recorder], tags: ['first'] })
        .addDeciderFunction('Route', () => 'left', 'route', undefined, { tags: ['declared-with'] })
        .addFunctionBranch('left', 'Left', noop, undefined, { tags: ['went-left'] })
        .end()
        .addFunction('Late', noop, 'late') // a linear stage has no options: `.tag()` IS its door
        .tag('declared-after', 'twice')
        .addFunction('Plain', noop, 'plain')
        .build();

      expect(added).toEqual([
        { stageId: 'seed', tags: ['first'] },
        { stageId: 'route', tags: ['declared-with'] },
        { stageId: 'left', tags: ['went-left'] },
        { stageId: 'late' }, // nothing declared yet when it was added — absent, not []
        { stageId: 'plain' },
      ]);
      // ONE declaration, ONE event: the sites that landed before `onStageAdded` do not fire again.
      expect(tagged.map((e) => [e.stageId, e.name, e.tags])).toEqual([['late', 'Late', ['declared-after', 'twice']]]);
      expect(tagged[0].spec.tags).toEqual(['declared-after', 'twice']);
    });

    it('the event carries a COPY of the names — a recorder cannot edit the spec through it', () => {
      const { recorder, added, tagged } = copyingRecorder();
      const chart = flowChart<State>('Seed', noop, 'seed', { structureRecorders: [recorder], tags: ['first'] })
        .addFunction('Late', noop, 'late')
        .tag('after')
        .build();
      (added[0].tags as string[]).push('smuggled');
      (tagged[0].tags as string[]).push('smuggled');
      expect(chart.buildTimeStructure.tags).toEqual(['first']);
      expect(chart.buildTimeStructure.next?.tags).toEqual(['after']);
    });

    it('a recorder attached after flowChart() gets the seed replay WITH its tags', () => {
      const { recorder, added } = copyingRecorder();
      flowChart<State>('Seed', noop, 'seed', { tags: ['first'] })
        .attachStructureRecorder(recorder)
        .build();
      expect(added).toEqual([{ stageId: 'seed', tags: ['first'] }]);
    });

    it('a throwing onStageTagged is isolated like every other structure hook', () => {
      const recorder: StructureRecorder = {
        id: 'thrower',
        onStageTagged: () => {
          throw new Error('boom');
        },
      };
      const builder = flowChart<State>('Seed', noop, 'seed', { structureRecorders: [recorder] }).addFunction(
        'Late',
        noop,
        'late',
      );
      expect(() => builder.tag('after')).not.toThrow();
      const chart = builder.build();
      expect(chart.buildTimeStructure.next?.tags).toEqual(['after']);
      expect(builder.getStructureBuildErrors().map((e) => [e.recorderId, e.method])).toEqual([
        ['thrower', 'onStageTagged'],
      ]);
    });
  });

  it('a mounted subflow keeps its stages’ tags through prefixing (both twins spread the node)', () => {
    const inner = flowChart<State>('Inner', noop, 'inner')
      .tag('inner-seed')
      .addFunction('Deep', noop, 'deep')
      .tag('deep')
      .build();
    const chart = flowChart<State>('Seed', noop, 'seed').addSubFlowChartNext('sf', inner, 'Sub').build();
    const root = chart.subflows?.sf?.root;
    expect(root?.id).toBe('sf/inner');
    expect(root?.tags).toEqual(['inner-seed']);
    expect(root?.next?.id).toBe('sf/deep');
    expect(root?.next?.tags).toEqual(['deep']);
  });
});
