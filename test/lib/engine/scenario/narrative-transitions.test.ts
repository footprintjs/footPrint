import {
  AdaptiveNarrativeFlowRecorder,
  flowChart,
  FlowChartExecutor,
  MilestoneNarrativeFlowRecorder,
  NarrativeFlowRecorder,
  ProgressiveNarrativeFlowRecorder,
  RLENarrativeFlowRecorder,
  SeparateNarrativeFlowRecorder,
  SilentNarrativeFlowRecorder,
  WindowedNarrativeFlowRecorder,
} from '../../../../src';

const strategies = [
  NarrativeFlowRecorder,
  AdaptiveNarrativeFlowRecorder,
  MilestoneNarrativeFlowRecorder,
  ProgressiveNarrativeFlowRecorder,
  RLENarrativeFlowRecorder,
  SeparateNarrativeFlowRecorder,
  SilentNarrativeFlowRecorder,
  WindowedNarrativeFlowRecorder,
];

describe('Narrative transition ownership', () => {
  describe.each(strategies.map((Strategy) => [Strategy.name, Strategy] as const))('%s', (_name, Strategy) => {
    it.each(['inline', 'deferred'] as const)('narrates completed steps once with %s delivery', async (delivery) => {
      const chart = flowChart('Start', () => {}, 'start')
        .addFunction('Middle', () => {}, 'middle', 'Shared description')
        .addFunction('End', () => {}, 'end', 'Shared description')
        .build();
      const recorder = new Strategy();
      const executor = new FlowChartExecutor(chart);
      const edges: string[] = [];
      executor.attachFlowRecorder(recorder, { delivery });
      executor.attachFlowRecorder({ id: 'edge-spy', onNext: (e) => edges.push(`${e.from}->${e.to}`) });

      await executor.run();
      await executor.drainObservers();

      expect(recorder.getSentences()).toEqual([
        'Next, it moved on to Start.',
        'Next step: Shared description.',
        'Next step: Shared description.',
      ]);
      expect(edges).toEqual(['Start->Middle', 'Middle->End']);
      recorder.clear();
      expect(recorder.getSentences()).toEqual([]);
      await executor.run();
      await executor.drainObservers();
      expect(recorder.getSentences()).toEqual([
        'Next, it moved on to Start.',
        'Next step: Shared description.',
        'Next step: Shared description.',
      ]);
    });
  });

  it('retains every real loop visit rather than deduplicating sentences', async () => {
    const chart = flowChart<{ count: number }>(
      'Start',
      (scope) => {
        scope.count = 0;
      },
      'start',
    )
      .addFunction(
        'Work',
        (scope) => {
          scope.count += 1;
          if (scope.count === 3) scope.$break('finished');
        },
        'work',
      )
      .loopTo('work')
      .build();
    const recorder = new NarrativeFlowRecorder();
    await chart.recorder(recorder).run();
    expect(recorder.getSentences()).toEqual([
      'Next, it moved on to Start.',
      'Next, it moved on to Work.',
      'On pass 1 through Work.',
      'Next, it moved on to Work.',
      'On pass 2 through Work.',
      'Next, it moved on to Work.',
      'Execution stopped at Work.',
    ]);
  });

  it('does not narrate a failed destination as completed', async () => {
    const chart = flowChart('Start', () => {}, 'start')
      .addFunction(
        'Fail',
        () => {
          throw new Error('refused');
        },
        'fail',
      )
      .addFunction('Unreached', () => {}, 'unreached')
      .build();
    const recorder = new NarrativeFlowRecorder();
    await expect(chart.recorder(recorder).run()).rejects.toThrow('refused');
    expect(recorder.getSentences()).toEqual([
      'Next, it moved on to Start.',
      'An error occurred at Fail: Error: refused.',
    ]);
  });

  it('narrates a paused destination only when it completes after resume', async () => {
    const chart = flowChart('Start', () => {}, 'start')
      .addPausableFunction('Approve', { execute: () => ({ question: 'Continue?' }), resume: () => {} }, 'approve')
      .addFunction('End', () => {}, 'end')
      .build();
    const recorder = new NarrativeFlowRecorder();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(recorder);
    await executor.run();
    expect(recorder.getSentences()).toEqual(['Next, it moved on to Start.', 'Execution paused at Approve.']);
    await executor.resume(executor.getCheckpoint()!, { approved: true });
    expect(recorder.getSentences()).toEqual([
      'Next, it moved on to Start.',
      'Execution paused at Approve.',
      'Execution resumed at Approve with input.',
      'Next, it moved on to Approve.',
      'Next, it moved on to End.',
    ]);
  });

  it('leaves decision and subflow sentences with their dedicated hooks', async () => {
    const inner = flowChart('InnerStart', () => {}, 'inner-start')
      .addFunction('InnerEnd', () => {}, 'inner-end')
      .build();
    const chart = flowChart('Start', () => {}, 'start')
      .addDeciderFunction('Choose', () => 'chosen', 'choose')
      .addFunctionBranch('chosen', 'Chosen', () => {})
      .end()
      .addSubFlowChartNext('nested', inner, 'Nested')
      .addFunction('End', () => {}, 'end')
      .build();
    const recorder = new NarrativeFlowRecorder();
    await chart.recorder(recorder).run();
    expect(recorder.getSentences()).toEqual([
      'Next, it moved on to Start.',
      'A decision was made, and the path taken was Chosen.',
      'Next, it moved on to Chosen.',
      'Entering the Nested subflow.',
      'Next, it moved on to nested/InnerStart.',
      'Next, it moved on to nested/InnerEnd.',
      'Exiting the Nested subflow.',
      'Next, it moved on to End.',
    ]);
  });
});
