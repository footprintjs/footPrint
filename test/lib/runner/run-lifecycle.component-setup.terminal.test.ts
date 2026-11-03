import { expect, it } from 'vitest';

import { createRunLifecycle, flowChart } from '../../../src/index.js';

it('keeps the native terminal kind immutable across cleanup callbacks', async () => {
  const observed: string[] = [];
  const owner = createRunLifecycle(flowChart('body', () => 'answer', 'body').build(), {
    runnerId: 'terminal-fact',
    componentSetup: (component) => {
      component.onFinalize((end) => {
        observed.push(end.kind);
      });
      component.onFinalize((end) => {
        Reflect.set(end, 'kind', 'failed');
      });
      return {};
    },
  });
  owner.slot('component');
  await owner.withRun((run) => run.execute({ kind: 'run' }));
  expect(observed).toEqual(['completed']);
});
