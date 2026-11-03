import { describe, expect, it } from 'vitest';

import type { RunSlot, TypedScope } from '../../../src/index.js';
import { createRunLifecycle, flowChart, FlowChartExecutor } from '../../../src/index.js';

function decisionChart(inspect: () => void = () => undefined) {
  return flowChart('seed', () => undefined, 'seed')
    .addDeciderFunction('choose', () => 'yes', 'choose')
    .addFunctionBranch('yes', 'yes', () => {
      inspect();
      return 'answer';
    })
    .end()
    .build();
}

describe('component subscriber producer and privacy boundaries', () => {
  it('delivers a preceding canonical decision before the selected body, without a drain', async () => {
    const events: string[] = [];
    const chart = decisionChart(() => expect(events).toEqual(['yes']));
    const owner = createRunLifecycle(chart, {
      runnerId: 'inline',
      componentSetup: () => ({ recorder: { id: 'inline', onDecision: (event) => events.push(event.chosen) } }),
    });
    owner.slot('component');
    await owner.withRun((run) => run.execute({ kind: 'run' }));
    expect(events).toEqual(['yes']);
  });

  it('keeps live namespaces with equal recorder IDs and shares the one canonical served object', async () => {
    const first: object[] = [];
    const second: object[] = [];
    const external: object[] = [];
    const chart = decisionChart();
    const a = createRunLifecycle(chart, {
      runnerId: 'A',
      componentSetup: () => ({ recorder: { id: 'same', onDecision: (event) => first.push(event) } }),
    });
    const b = createRunLifecycle(chart, {
      runnerId: 'B',
      componentSetup: () => ({ recorder: { id: 'same', onDecision: (event) => second.push(event) } }),
    });
    a.slot('component');
    b.slot('component');
    await a.withRun((run) =>
      run.execute(
        { kind: 'run' },
        {
          attachments: [{ recorder: { id: 'same', onDecision: (event) => external.push(event) } }],
        },
      ),
    );
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(external).toHaveLength(1);
    expect(first[0]).toBe(second[0]);
    expect(first[0]).toBe(external[0]);
  });

  it('does not double-deliver one recorder object registered in scoped and global roles', async () => {
    let count = 0;
    const chart = decisionChart();
    // Use one actual object for both live scoped namespaces and global attachment.
    const shared = {
      id: 'shared',
      onDecision: () => {
        count += 1;
      },
    };
    const first = createRunLifecycle(chart, { runnerId: 'first', componentSetup: () => ({ recorder: shared }) });
    const second = createRunLifecycle(chart, { runnerId: 'second', componentSetup: () => ({ recorder: shared }) });
    first.slot('component');
    second.slot('component');
    await first.withRun((run) => run.execute({ kind: 'run' }, { attachments: [{ recorder: shared }] }));
    expect(count).toBe(1);
  });

  it('isolates simultaneous mounted decision and emit observations by actual component', async () => {
    const rows: Array<{ label: string; decisions: string[]; emitted: string[] }> = [];
    const child = flowChart<Record<string, unknown>>(
      'emit',
      (scope) => {
        scope.$emit('tool.finished', { label: scope.$getArgs<{ label: string }>().label });
      },
      'emit',
    )
      .addDeciderFunction('choose', () => 'yes', 'choose')
      .addFunctionBranch('yes', 'yes', () => 'answer')
      .end()
      .build();
    const owner = createRunLifecycle(child, {
      runnerId: 'shared-child',
      componentSetup: () => {
        const row = { label: '', decisions: [] as string[], emitted: [] as string[] };
        rows.push(row);
        return {
          bindScope: (scope) => {
            row.label = (scope as TypedScope<Record<string, unknown>>).$getArgs<{ label: string }>().label;
          },
          recorder: {
            id: 'same-child-id',
            onDecision: (event) => row.decisions.push(event.chosen),
            onEmit: (event) => {
              if (event.name === 'tool.finished') row.emitted.push((event.payload as { label: string }).label);
            },
          },
        };
      },
    });
    owner.slot('component');
    const parent = flowChart('parent', () => undefined, 'parent')
      .addSubFlowChart('left', child, 'left', { inputMapper: () => ({ label: 'left' }) })
      .addSubFlowChart('right', child, 'right', { inputMapper: () => ({ label: 'right' }) })
      .build();
    await new FlowChartExecutor(parent).run();
    expect(rows).toHaveLength(2);
    expect(rows.sort((a, b) => a.label.localeCompare(b.label))).toEqual([
      { label: 'left', decisions: ['left/yes'], emitted: ['left'] },
      { label: 'right', decisions: ['right/yes'], emitted: ['right'] },
    ]);
  });

  it('routes a scoped recorder failure only to that producer and ordinary external observers', async () => {
    const rows: Array<{ label: string; errors: number }> = [];
    const external: object[] = [];
    const child = flowChart<Record<string, unknown>>(
      'emit',
      (scope) => {
        scope.$emit('fixture', { label: scope.$getArgs<{ label: string }>().label });
        return 'business-answer';
      },
      'emit',
    ).build();
    const owner = createRunLifecycle(child, {
      runnerId: 'error-isolation',
      componentSetup: () => {
        const row = { label: '', errors: 0 };
        rows.push(row);
        return {
          bindScope: (scope) => {
            row.label = (scope as TypedScope<Record<string, unknown>>).$getArgs<{ label: string }>().label;
          },
          recorder: {
            id: 'same',
            onEmit: () => {
              if (row.label === 'left') throw new Error('observer-failed');
            },
            onError: () => {
              row.errors += 1;
            },
          },
        };
      },
    });
    owner.slot('component');
    const parent = flowChart('parent', () => undefined, 'parent')
      .addSubFlowChart('left', child, 'left', { inputMapper: () => ({ label: 'left' }) })
      .addSubFlowChart('right', child, 'right', { inputMapper: () => ({ label: 'right' }) })
      .build();
    const parentOwner = createRunLifecycle(parent, { runnerId: 'parent' });
    await parentOwner.withRun((run) =>
      run.execute(
        { kind: 'run' },
        {
          attachments: [{ recorder: { id: 'external', onError: (event) => external.push(event) } }],
        },
      ),
    );
    expect(rows.sort((a, b) => a.label.localeCompare(b.label))).toEqual([
      { label: 'left', errors: 1 },
      { label: 'right', errors: 0 },
    ]);
    expect(external).toHaveLength(1);
  });

  it('serves redacted write/commit/emit values while private cells remain outside snapshots', async () => {
    const writes: unknown[] = [];
    const commits: unknown[] = [];
    const emits: unknown[] = [];

    const chart = flowChart<Record<string, unknown>>(
      'body',
      (scope) => {
        scope.secret = 'RAW-PRIVATE-TRACKED';
        scope.$emit('private.value', { secret: 'RAW-PRIVATE-TRACKED' });
        expect(writes).toHaveLength(1);
        expect(emits).toHaveLength(1);
        return 'answer';
      },
      'body',
    ).build();
    const owner = createRunLifecycle(chart, {
      runnerId: 'redaction',
      componentSetup: (component) => {
        component.set(slot, 'PRIVATE-CELL-CANARY');
        return {
          recorder: {
            id: 'PRIVATE-CELL-CANARY',
            onWrite: (event) => {
              if (event.key === 'secret') writes.push(event.value);
            },
            onCommit: (event) => commits.push(event),
            onEmit: (event) => emits.push(event.payload),
          },
        };
      },
    });
    const slot: RunSlot<string> = owner.slot('component');
    await owner.withRun((run) =>
      run.execute(
        { kind: 'run' },
        {
          redaction: { keys: ['secret'], emitPatterns: [/^private\./] },
        },
      ),
    );
    expect(writes).toEqual(['[REDACTED]']);
    expect(emits).toEqual(['[REDACTED]']);
    expect(commits).toHaveLength(1);
    expect(JSON.stringify(commits)).not.toContain('RAW-PRIVATE-TRACKED');
    expect(JSON.stringify(owner.view()?.snapshot())).not.toContain('PRIVATE-CELL-CANARY');
  });

  it('binds the separate ParallelForEach scope before items and emits', async () => {
    const bound = new Set<unknown>();
    const events: string[] = [];
    const child = flowChart('child', () => 'item', 'child').build();
    const chart = flowChart<Record<string, unknown>>('seed', () => undefined, 'seed')
      .addParallelForEach('each', 'each', {
        items: (scope) => {
          expect(bound.has(scope)).toBe(true);
          scope.$emit('items-observed', {});
          return [1, 2];
        },
        branch: () => child,
        into: 'results',
        maxBranches: 2,
      })
      .build();
    const owner = createRunLifecycle(chart, {
      runnerId: 'foreach',
      componentSetup: () => ({
        bindScope: (scope) => {
          bound.add(scope);
        },
        recorder: { id: 'foreach', onEmit: (event) => events.push(event.name) },
      }),
    });
    owner.slot('component');
    await owner.withRun((run) => run.execute({ kind: 'run' }));
    expect(events).toEqual(['items-observed']);
    expect(bound.size).toBeGreaterThanOrEqual(2);
  });

  it('keeps a declared no-port child as an observation inheritance barrier', async () => {
    const seen: string[] = [];
    const child = flowChart<Record<string, unknown>>(
      'child',
      (scope) => {
        scope.$emit('child', {});
      },
      'child',
    ).build();
    const childOwner = createRunLifecycle(child, { runnerId: 'unobserved-child' });
    childOwner.slot('component');
    const parent = flowChart<Record<string, unknown>>(
      'parent',
      (scope) => {
        scope.$emit('parent', {});
      },
      'parent',
    )
      .addSubFlowChartNext('child', child, 'child')
      .build();
    const owner = createRunLifecycle(parent, {
      runnerId: 'parent-observer',
      componentSetup: () => ({ recorder: { id: 'parent', onEmit: (event) => seen.push(event.name) } }),
    });
    owner.slot('component');
    await owner.withRun((run) => run.execute({ kind: 'run' }));
    expect(seen).toEqual(['parent']);
  });
});
