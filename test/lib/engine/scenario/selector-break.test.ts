/** A selector-body break commits the stage, then stops before fan-out or continuation. */
import { describe, expect, it, vi } from 'vitest';

import type { FlowBreakEvent, TypedScope } from '../../../../src/index';
import { flowChart, FlowChartExecutor, interrupt } from '../../../../src/index';

interface State {
  before?: number;
  after?: number;
  invalid?: unknown;
}

function selector(stage: (scope: TypedScope<State>) => string[], child = vi.fn()) {
  return flowChart<State>('Seed', () => {}, 'seed')
    .addSelectorFunction('Select', stage, 'select')
    .addFunctionBranch('child', 'Child', child)
    .end();
}

describe('selector-body break', () => {
  it('commits the whole stage once, then skips branches and the complete next chain', async () => {
    const child = vi.fn();
    const after = vi.fn();
    const tail = vi.fn();
    const executor = new FlowChartExecutor(
      selector((scope) => {
        scope.before = 1;
        scope.$break('enough');
        scope.after = 2; // Cooperative break: the rest of the stage still runs.
        return ['unknown']; // Stopping precedes selection validation, as before.
      }, child)
        .addFunction('After', after, 'after')
        .addFunction('Tail', tail, 'tail')
        .build(),
    );
    const events: string[] = [];
    const breaks: FlowBreakEvent[] = [];
    executor.attachCombinedRecorder({
      id: 'scope-order',
      onStageStart: (e) => {
        if (e.stageId === 'select') events.push('start');
      },
      onWrite: (e) => {
        if (e.stageId === 'select') events.push(`write:${e.key}`);
      },
      onStageEnd: (e) => {
        if (e.stageId === 'select') events.push('end');
      },
      onCommit: (e) => {
        if (e.stageId === 'select') events.push('commit');
      },
    });
    executor.attachFlowRecorder({
      id: 'flow-order',
      onStageExecuted: (e) => {
        if (e.stageName === 'Select') events.push(`executed:${e.stageType}`);
      },
      onBreak: (e) => {
        breaks.push(e);
        events.push('break');
      },
      onSelected: () => events.push('selected'),
      onFork: () => events.push('fork'),
      onRunEnd: () => events.push('run-end'),
    });

    await executor.run();

    expect(child).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    expect(tail).not.toHaveBeenCalled();
    const snapshot = executor.getSnapshot();
    expect(snapshot.sharedState).toEqual({ before: 1, after: 2 });
    expect(snapshot.commitLog.map((bundle) => bundle.stageId)).toEqual(['seed', 'select']);
    expect(events).toEqual([
      'start',
      'write:before',
      'write:after',
      'end',
      'commit',
      'executed:selector',
      'break',
      'run-end',
    ]);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toMatchObject({
      stageName: 'Select',
      reason: 'enough',
      traversalContext: { stageId: 'select', runtimeStageId: snapshot.commitLog[1].runtimeStageId },
    });
    expect(executor.isPaused()).toBe(false);
    expect(executor.getCheckpoint()).toBeUndefined();
  });

  it('does not follow a selector loopTo or emit a loop event', async () => {
    const seed = vi.fn();
    const child = vi.fn();
    const loop = vi.fn();
    const executor = new FlowChartExecutor(
      flowChart<State>('Seed', seed, 'seed')
        .addSelectorFunction(
          'Select',
          (scope) => {
            scope.$break('stop-loop');
            return ['child'];
          },
          'select',
        )
        .addFunctionBranch('child', 'Child', child)
        .end()
        .loopTo('seed')
        .build(),
    );
    executor.attachFlowRecorder({ id: 'loops', onLoop: loop });

    await executor.run({ maxIterations: 1 });

    expect(seed).toHaveBeenCalledTimes(1);
    expect(child).not.toHaveBeenCalled();
    expect(loop).not.toHaveBeenCalled();
    expect(executor.getSnapshot().commitLog.map((bundle) => bundle.stageId)).toEqual(['seed', 'select']);
  });

  it.each([
    { reasons: [undefined], expected: undefined },
    { reasons: [''], expected: '' },
    { reasons: ['first', 'second'], expected: 'first' },
    { reasons: [undefined, 'first explicit', 'later'], expected: 'first explicit' },
  ])('preserves the first explicit reason: $reasons', async ({ reasons, expected }) => {
    const executor = new FlowChartExecutor(
      selector((scope) => {
        for (const reason of reasons) scope.$break(reason);
        return ['child'];
      }).build(),
    );
    const breaks: FlowBreakEvent[] = [];
    executor.attachFlowRecorder({ id: 'breaks', onBreak: (event) => breaks.push(event) });

    await executor.run();

    expect(breaks).toHaveLength(1);
    expect(breaks[0].stageName).toBe('Select');
    expect(breaks[0].reason).toBe(expected);
    if (expected === undefined) expect(breaks[0]).not.toHaveProperty('reason');
  });

  it('still fails if the breaking selector cannot commit its writes', async () => {
    const executor = new FlowChartExecutor(
      selector((scope) => {
        scope.$setValue('invalid', () => 1);
        scope.$break('not-success');
        return ['child'];
      }).build(),
    );
    const onBreak = vi.fn();
    const onError = vi.fn();
    const onStageExecuted = vi.fn();
    executor.attachFlowRecorder({ id: 'failure', onBreak, onError, onStageExecuted });

    await expect(executor.run()).rejects.toMatchObject({ name: 'DataCloneError' });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onBreak).not.toHaveBeenCalled();
    expect(onStageExecuted.mock.calls.map(([event]) => event.stageName)).toEqual(['Seed']);
    expect(executor.getSnapshot().commitLog.map((bundle) => bundle.stageId)).toEqual(['seed']);
  });

  it.each([false, true])('preserves committed subflow output with propagateBreak=%s', async (propagateBreak) => {
    for (const terminal of [false, true]) {
      const innerTail = vi.fn();
      const outerTail = vi.fn();
      const builder = selector((scope) => {
        scope.before = 9;
        scope.$break('partial-result');
        return ['child'];
      });
      const inner = (terminal ? builder : builder.addFunction('Inner tail', innerTail, 'inner-tail')).build();
      const outputMapper = vi.fn((output: State) => ({ before: output.before }));
      const executor = new FlowChartExecutor(
        flowChart<State>('Outer seed', () => {}, 'outer-seed')
          .addSubFlowChartNext('inner', inner, 'Inner', { outputMapper, propagateBreak })
          .addFunction('Outer tail', outerTail, 'outer-tail')
          .build(),
      );

      await executor.run();

      expect(outputMapper).toHaveBeenCalledTimes(1);
      expect(outputMapper.mock.calls[0][0]).toEqual({ before: 9 });
      expect(executor.getSnapshot().sharedState).toEqual({ before: 9 });
      expect(innerTail).not.toHaveBeenCalled();
      expect(outerTail).toHaveBeenCalledTimes(propagateBreak ? 0 : 1);
    }
  });

  it('returns no branch-result value when stopped, unlike a completed empty selection', async () => {
    const stopped = new FlowChartExecutor(
      selector((scope) => {
        scope.$break();
        return [];
      }).build(),
    );
    const emptySelection = new FlowChartExecutor(selector(() => []).build());

    await expect(stopped.run()).resolves.toBeUndefined();
    await expect(emptySelection.run()).resolves.toEqual({});
  });

  it('does not turn selected-child breaks into a parent break', async () => {
    const after = vi.fn();
    const children: string[] = [];
    const executor = new FlowChartExecutor(
      flowChart<State>('Seed', () => {}, 'seed')
        .addSelectorFunction('Select', () => ['a', 'b'], 'select')
        .addFunctionBranch('a', 'A', (scope) => {
          children.push('a');
          scope.$break('a-only');
        })
        .addFunctionBranch('b', 'B', (scope) => {
          children.push('b');
          scope.$break('b-only');
        })
        .end()
        .addFunction('After', after, 'after')
        .build(),
    );
    const breaks: FlowBreakEvent[] = [];
    executor.attachFlowRecorder({ id: 'child-breaks', onBreak: (event) => breaks.push(event) });

    await executor.run();

    expect(children.sort()).toEqual(['a', 'b']);
    expect(after).toHaveBeenCalledTimes(1);
    expect(breaks.map((event) => event.stageName).sort()).toEqual(['A', 'B']);
  });

  it('keeps interrupt as a pause, not a clean break', async () => {
    const after = vi.fn();
    const executor = new FlowChartExecutor(
      selector((scope) => {
        scope.before = 1;
        interrupt(scope, { reason: 'approval' });
        return ['child'];
      })
        .addFunction('After', after, 'after')
        .build(),
    );
    const onBreak = vi.fn();
    executor.attachFlowRecorder({ id: 'pause', onBreak });

    await executor.run();

    expect(executor.isPaused()).toBe(true);
    expect(executor.getCheckpoint()).toMatchObject({
      pausedStageId: 'select',
      pausedBy: 'interrupt',
      sharedState: { before: 1 },
    });
    expect(after).not.toHaveBeenCalled();
    expect(onBreak).not.toHaveBeenCalled();
  });

  it('isolates a throwing break observer and continues notifying other observers', async () => {
    const after = vi.fn();
    const executor = new FlowChartExecutor(
      selector((scope) => {
        scope.$break('finished');
        return ['child'];
      })
        .addFunction('After', after, 'after')
        .build(),
    );
    const observed = vi.fn();
    executor.attachFlowRecorder({
      id: 'throws',
      onBreak: () => {
        throw new Error('observer failed');
      },
    });
    executor.attachFlowRecorder({ id: 'survives', onBreak: observed });

    await executor.run();

    expect(after).not.toHaveBeenCalled();
    expect(observed).toHaveBeenCalledTimes(1);
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({ stageName: 'Select', reason: 'finished' }));
  });
});
