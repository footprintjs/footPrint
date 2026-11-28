import { expect, it } from 'vitest';

import { type SnapshotOptions, createRunLifecycle, flowChart, FlowChartExecutor } from '../../../src/index.js';

const privateValue = 'historical-child-secret';
const wait = { execute: () => ({ question: 'Continue?' }), resume: () => undefined };

function chart() {
  const child = flowChart('Child', (scope) => scope.$setValue('privateField', privateValue), 'write').build();
  return flowChart('Root', () => undefined, 'root')
    .addSubFlowChartNext('member', child, 'Member')
    .addPausableFunction('First pause', wait, 'first')
    .addPausableFunction('Second pause', wait, 'second')
    .build();
}

it('retains the exact child result across repeated same-runtime resumes', async () => {
  const executor = new FlowChartExecutor(chart());
  await executor.run();
  const old = executor.getSubflowResults();
  const address = [...old.keys()].find((key) => key.includes('#'))!;
  expect(old.get(address)?.treeContext.history.length).toBeGreaterThan(0);

  for (let leg = 0; leg < 2; leg += 1) {
    await executor.resume(executor.getCheckpoint()!, true);
    const results = executor.getSubflowResults();
    expect(results.get(address)).toEqual(old.get(address));
    expect(results.get('member')).toBe(results.get(address));
    expect(executor.getSnapshot({ resumePrefix: true }).subflowResults?.[address]).toEqual(old.get(address));
    expect(executor.getSnapshot({ resumePrefix: true }).resumePrefixGap).toBeUndefined();
  }
});

it('withholds an earlier child when a policy is added and never revives it on relaxation', async () => {
  const executor = new FlowChartExecutor(chart());
  await executor.run();
  const old = executor.getSubflowResults().get('member');
  expect(JSON.stringify(old)).toContain(privateValue);
  executor.setRedactionPolicy({ keys: ['privateField'] });
  await executor.resume(executor.getCheckpoint()!, true);
  expect(executor.getSubflowResults().has('member')).toBe(false);
  const protectedSnapshot = executor.getSnapshot({ redact: true });
  expect(protectedSnapshot).toHaveProperty('subflowEvidenceGap', 'retained-child-evidence-withheld');
  expect(JSON.stringify(protectedSnapshot.subflowResults ?? {})).not.toContain(privateValue);
  executor.setRedactionPolicy({});
  await executor.resume(executor.getCheckpoint()!, true);
  expect(executor.getSubflowResults().has('member')).toBe(false);
  expect(executor.getSnapshot()).toHaveProperty('subflowEvidenceGap', 'retained-child-evidence-withheld');
});

it.each(['parallel', 'lazy', 'fanout'] as const)('retains exact %s child occurrences', async (shape) => {
  const child = flowChart('Child', (scope) => scope.$setValue('value', 'result'), 'write').build();
  const root = flowChart('Root', () => undefined, 'root');
  let lazyOpens = 0;
  switch (shape) {
    case 'parallel':
      root.addSubFlowChart('left', child, 'Left').addSubFlowChart('right', child, 'Right');
      break;
    case 'lazy':
      root.addLazySubFlowChartNext(
        'lazy',
        () => {
          lazyOpens += 1;
          return child;
        },
        'Lazy',
      );
      break;
    case 'fanout':
      root.addParallelForEach('Each', 'each', {
        items: () => ['one', 'two'],
        branch: () => child,
        maxBranches: 2,
        into: 'ordered',
      });
      break;
  }
  const executor = new FlowChartExecutor(root.addPausableFunction('Pause', wait, 'pause').build());
  await executor.run();
  const before = executor.getSubflowResults();
  const occurrences = [...before.keys()].filter((key) => key.includes('#'));
  expect(occurrences).toHaveLength(shape === 'lazy' ? 1 : 2);
  await executor.resume(executor.getCheckpoint()!, true);
  expect(executor.getSubflowResults()).toEqual(before);
  expect(executor.getSnapshot().subflowResults).toEqual(Object.fromEntries(before));
  expect(lazyOpens).toBe(shape === 'lazy' ? 1 : 0);
});

it('preserves exact fanout occurrences while a resumed second pass reads its own fallback state', async () => {
  const child = flowChart(
    'Child',
    (scope) => {
      scope.$setValue('observed', scope.$getValue('item'));
    },
    'write',
  ).build();
  const repeat = {
    ...wait,
    resume: (scope: { $setValue(key: string, value: unknown): void }) => {
      scope.$setValue('pass', 2);
    },
  };
  let checkResumedExecution = false;
  const root = flowChart('Root', (scope) => scope.$setValue('pass', 1), 'root')
    .addParallelForEach('Each', 'each', {
      items: (scope) => {
        if (checkResumedExecution) {
          // The fallback's map starts empty even while the inspection door has the older alias.
          // eslint-disable-next-line dot-notation -- inspect the private execution map in this test.
          expect(executor['traverser'].getSubflowResults().has('each~0')).toBe(false);
          expect(executor.getSubflowResults().has('each~0')).toBe(true);
        }
        return [scope.$getValue('pass')];
      },
      branch: () => child,
      maxBranches: 1,
      into: 'ordered',
    })
    .addDeciderFunction('Route', (scope) => (scope.$getValue('pass') === 1 ? 'again' : 'done'), 'route')
    .addPausableFunctionBranch('again', 'Again', repeat, 'Wait', { loopTo: 'each' })
    .addFunctionBranch('done', 'Done', () => undefined)
    .end()
    .build();
  const executor = new FlowChartExecutor(root);
  await executor.run();
  const before = executor.getSubflowResults();
  const [older] = [...before.keys()].filter((key) => key.includes('#'));
  const restored = new FlowChartExecutor(root);
  await restored.resume(JSON.parse(JSON.stringify(executor.getCheckpoint())), true);
  checkResumedExecution = true;
  await executor.resume(executor.getCheckpoint()!, true);
  const results = executor.getSubflowResults();
  const occurrences = [...results.entries()].filter(([key]) => key.includes('#'));
  expect(occurrences).toHaveLength(2);
  expect(results.get(older)).toEqual(before.get(older));
  expect(results.get('each~0')?.treeContext.globalContext).toMatchObject({ observed: 2 });
  expect(executor.getSnapshot().sharedState).toEqual(restored.getSnapshot().sharedState);
  expect(executor.getSnapshot().sharedState).toMatchObject({ ordered: [{ observed: 2 }] });
});

it.each(['unchanged', 'tightened', 'relaxed'] as const)(
  'serves historical native snapshots under %s disclosure',
  async (mode) => {
    const root = chart();
    const owner = createRunLifecycle(root, { runnerId: 'child-evidence' });
    await owner.withRun((run) => run.execute({ kind: 'run' }, { redaction: { keys: ['privateField'] } }));
    const options: SnapshotOptions = { redact: true, resumePrefix: true };
    const before = owner.view()!.snapshot(options);
    expect(before?.subflowResults).toHaveProperty('member');
    const token = owner.continuation()!;
    await owner.withRun(async (run) => {
      await run.execute(
        { kind: 'resume', mode: 'same', continuation: token, input: true },
        {
          redaction: {
            keys: mode === 'relaxed' ? [] : mode === 'tightened' ? ['privateField', 'other'] : ['privateField'],
          },
        },
      );
      const snapshot = run.snapshot(options);
      expect(snapshot?.subflowResults?.member !== undefined).toBe(mode === 'unchanged');
      expect(JSON.stringify(snapshot)).not.toContain(privateValue);
    });
    const snapshot = owner.view()!.snapshot(options)!;
    const restored = JSON.parse(JSON.stringify(snapshot));
    if (mode === 'unchanged') {
      expect(restored.subflowResults).toHaveProperty('member');
      expect(restored.subflowEvidenceGap).toBeUndefined();
    } else {
      expect(restored.subflowResults?.member).toBeUndefined();
      expect(restored.subflowEvidenceGap).toBe('retained-child-evidence-withheld');
    }
    expect(JSON.stringify(restored)).not.toContain(privateValue);
  },
);

it('withholds the earlier child when a resumed stage dynamically marks its key', async () => {
  const child = flowChart('Child', (scope) => scope.$setValue('privateField', privateValue), 'write').build();
  const root = flowChart('Root', () => undefined, 'root')
    .addSubFlowChartNext('member', child, 'Member')
    .addPausableFunction(
      'Wait',
      {
        ...wait,
        resume: (scope) => scope.$setValue('privateField', 'new-secret', true),
      },
      'wait',
    )
    .build();
  const executor = new FlowChartExecutor(root);
  await executor.run();
  await executor.resume(executor.getCheckpoint()!, true);
  expect(executor.getSubflowResults().has('member')).toBe(false);
  expect(executor.getSnapshot({ redact: true }).subflowEvidenceGap).toBe('retained-child-evidence-withheld');
});
