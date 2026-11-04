import { expect, it } from 'vitest';

import { registerScopeRuntime, ScopeFacade } from '../../../src/advanced.js';
import { createRunLifecycle, flowChart } from '../../../src/index.js';

it('delivers component observations through the canonical binding of a protected facade scope', async () => {
  const writes: unknown[] = [];
  const emits: unknown[] = [];
  const chart = flowChart<void, ScopeFacade>(
    'body',
    (scope) => {
      scope.setValue('value', 7);
      scope.emitEvent('fixture', { value: 7 });
      expect(writes).toEqual([7]);
      expect(emits).toEqual([{ value: 7 }]);
    },
    'body',
  ).build();
  const owner = createRunLifecycle(chart, {
    runnerId: 'protected-facade',
    executorOptions: { scopeFactory: (context, name, input, env) => new ScopeFacade(context, name, input, env) },
    componentSetup: () => ({
      recorder: {
        id: 'protected-component',
        onWrite: (event) => {
          if (event.key === 'value') writes.push(event.value);
        },
        onEmit: (event) => emits.push(event.payload),
      },
    }),
  });
  owner.slot('component');
  await owner.withRun((run) => run.execute({ kind: 'run' }));
});

it('keeps its captured producer when runtime capabilities are explicitly replaced', async () => {
  const events: string[] = [];
  const chart = flowChart<void, ScopeFacade>(
    'body',
    (scope) => {
      scope.emitEvent('before', {});
      registerScopeRuntime(scope, { target: {}, handlesAssignments: false });
      scope.emitEvent('after', {});
      expect(events).toEqual(['before', 'after']);
    },
    'body',
  ).build();
  const owner = createRunLifecycle(chart, {
    runnerId: 'capture-once',
    executorOptions: { scopeFactory: (context, name, input, env) => new ScopeFacade(context, name, input, env) },
    componentSetup: () => ({ recorder: { id: 'capture-once', onEmit: (event) => events.push(event.name) } }),
  });
  owner.slot('component');
  await owner.withRun((run) => run.execute({ kind: 'run' }));
});
