/**
 * Function-less structural IDs (handoff J).
 *
 * The earlier mount/resume correction gave special parents a generated <id>-fork
 * continuation and reserved it in both declaration orders. Its collision tests used
 * children with functions; those passed through _addToMap while optional-function
 * children and branches did not. These tests close that registration gap without
 * turning every structural occurrence into a fresh-ID requirement: existing function
 * lookup/reuse, buildable placeholders, sibling checks and loop-target policy stay.
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';

const noop = () => undefined;
const leaf = flowChart('Leaf', noop, 'leaf').build();
const start = () => flowChart('Init', noop, 'init');
type Builder = ReturnType<typeof start>;
type Work = () => void;

const owners = [
  { name: 'mount', add: (b: Builder) => b.addSubFlowChartNext('owner', leaf, 'Owner') },
  {
    name: 'decider',
    add: (b: Builder) =>
      b
        .addDeciderFunction('Owner', () => 'route', 'owner')
        .addFunctionBranch('route', 'Route', noop)
        .end(),
  },
  {
    name: 'selector',
    add: (b: Builder) =>
      b
        .addSelectorFunction('Owner', () => ['route'], 'owner')
        .addFunctionBranch('route', 'Route', noop)
        .end(),
  },
  {
    name: 'parallelForEach',
    add: (b: Builder) =>
      b.addParallelForEach('Owner', 'owner', { items: () => [], branch: () => leaf, maxBranches: 1, into: 'r' }),
  },
];
const blank = { id: 'owner-fork', name: 'NoFn' };
const firstChild = { id: 'first', name: 'First', fn: noop };
const generated = (b: Builder) => owners[0].add(b).addListOfFunction([firstChild]);

const doors = [
  {
    name: 'fork child',
    add: (b: Builder, id: string, name: string, fn?: Work) => b.addListOfFunction([{ id, name, fn }]),
  },
  {
    name: 'decider branch',
    add: (b: Builder, id: string, name: string, fn?: Work) =>
      b
        .addDeciderFunction('Router', () => id, 'router')
        .addFunctionBranch(id, name, fn)
        .end(),
  },
  {
    name: 'selector branch',
    add: (b: Builder, id: string, name: string, fn?: Work) =>
      b
        .addSelectorFunction('Router', () => [id], 'router')
        .addFunctionBranch(id, name, fn)
        .end(),
  },
];

describe.each(owners)('function-less child versus $name continuation ID', ({ add }) => {
  it('refuses the generated parent ID as a child in the same addListOfFunction call', () => {
    expect(() => add(start()).addListOfFunction([blank])).toThrow(/owner-fork/);
  });

  it('refuses a later append under the current generated fork', () => {
    expect(() => add(start()).addListOfFunction([firstChild]).addListOfFunction([blank])).toThrow(/owner-fork/);
  });

  it('refuses a later child under a different fork', () => {
    const b = add(start()).addListOfFunction([firstChild]).addFunction('Later', noop, 'later');
    expect(() => b.addListOfFunction([blank])).toThrow(/owner-fork/);
  });

  it('refuses generating a fork when an earlier function-less child already has that ID', () => {
    const b = start().addListOfFunction([blank]).addFunction('Join', noop, 'join');
    expect(() => add(b).addListOfFunction([firstChild])).toThrow(/owner-fork/);
  });
});

describe.each(doors.slice(1))('$name versus generated fork ID', ({ add }) => {
  it('refuses an alias declared after the generated fork', () => {
    const b = generated(start()).addFunction('Later', noop, 'later');
    expect(() => add(b, 'owner-fork', 'init')).toThrow(/owner-fork/);
  });

  it('refuses generating the fork after a function-less branch already took its ID', () => {
    const b = add(start(), 'owner-fork', 'init').addFunction('Join', noop, 'join');
    expect(() => generated(b)).toThrow(/owner-fork/);
  });
});

const claims = [
  { name: 'lazy mount', add: (b: Builder) => b.addLazySubFlowChartNext('reserved', () => leaf, 'Lazy') },
  {
    name: 'parallelForEach',
    add: (b: Builder) =>
      b.addParallelForEach('Each', 'reserved', { items: () => [], branch: () => leaf, maxBranches: 1, into: 'r' }),
  },
];

describe.each(doors)('$name versus exclusive claims', ({ add }) => {
  it.each(claims)('refuses a function-less alias after a $name claimed the ID', (claim) => {
    const b = claim.add(start()).addFunction('Later', noop, 'later');
    expect(() => add(b, 'reserved', 'init')).toThrow(/reserved/);
  });

  it.each(claims)('refuses a later $name claim over a function-less ID', (claim) => {
    const b = add(start(), 'reserved', 'init').addFunction('Join', noop, 'join');
    expect(() => claim.add(b)).toThrow(/reserved/);
  });
});

describe.each(doors)('$name compatibility', ({ name, add }) => {
  it('preserves placeholder validation without synthesizing a no-op function', () => {
    if (name !== 'fork child') {
      expect(() => add(start(), 'blank', 'Blank')).toThrow(/has no function/);
      return;
    }
    const chart = add(start(), 'blank', 'Blank').build();
    expect(chart.stageMap.has('blank')).toBe(false);
    const children = name === 'fork child' ? chart.root.children : chart.root.next?.children;
    expect(children?.[0]).toMatchObject({ id: 'blank', name: 'Blank' });
    expect(children?.[0].fn).toBeUndefined();
  });

  it.each(['name lookup', 'ID lookup', 'same function'] as const)('preserves valid %s at runtime', async (mode) => {
    let calls = 0;
    const work = () => {
      calls += 1;
    };
    const b = start().addFunction('Original', work, 'work').addFunction('Hub', noop, 'hub');
    const id = mode === 'name lookup' ? 'alias' : 'work';
    const label = mode === 'name lookup' ? 'work' : 'Again';
    const chart = add(b, id, label, mode === 'same function' ? work : undefined).build();
    expect(chart.stageMap.get('work')).toBe(work);
    if (mode === 'name lookup') expect(chart.stageMap.has('alias')).toBe(false);
    await new FlowChartExecutor(chart).run();
    expect(calls).toBe(2);
  });

  it('does not make a function-less child or branch eligible as a linear loopTo target', () => {
    const b = add(start(), 'blank', 'init').addFunction('After', noop, 'after');
    expect(() => b.loopTo('blank')).toThrow(/target not found/);
  });

  it('does not make a function-less child or branch eligible as a decider loopTo target', () => {
    const b = add(start(), 'blank', 'init').addFunction('After', noop, 'after');
    expect(() =>
      b
        .addDeciderFunction('Loop', () => 'again', 'loop')
        .addFunctionBranch('again', 'Again', noop)
        .loopTo('blank'),
    ).toThrow(/target not found/);
  });
});

describe('existing local duplicate and loop rules', () => {
  it.each(['decider', 'selector'] as const)('%s addBranchList also refuses a generated fork ID', (kind) => {
    const b = generated(start()).addFunction('Later', noop, 'later');
    const branches =
      kind === 'decider'
        ? b.addDeciderFunction('Router', () => 'owner-fork', 'router')
        : b.addSelectorFunction('Router', () => ['owner-fork'], 'router');
    expect(() => branches.addBranchList([{ id: 'owner-fork', name: 'init' }]).end()).toThrow(/owner-fork/);
  });

  it('still refuses duplicate function-less fork siblings', () => {
    expect(() =>
      start().addListOfFunction([
        { id: 'dup', name: 'A' },
        { id: 'dup', name: 'B' },
      ]),
    ).toThrow(/duplicate child id/);
  });

  it.each(['decider', 'selector'] as const)('still refuses duplicate function-less %s siblings', (kind) => {
    const b = start();
    const branches =
      kind === 'decider'
        ? b.addDeciderFunction('Router', () => 'dup', 'router')
        : b.addSelectorFunction('Router', () => ['dup'], 'router');
    expect(() => branches.addFunctionBranch('dup', 'A').addFunctionBranch('dup', 'B')).toThrow(
      /duplicate .* branch id/,
    );
  });

  it('keeps a loop reference to a real earlier stage legal', () => {
    expect(() =>
      start()
        .addFunction('Head', noop, 'head')
        .addDeciderFunction('Router', () => 'done', 'router')
        .addFunctionBranch('again', 'Again', noop)
        .loopTo('head')
        .addFunctionBranch('done', 'Done', noop)
        .end()
        .build(),
    ).not.toThrow();
  });
});
