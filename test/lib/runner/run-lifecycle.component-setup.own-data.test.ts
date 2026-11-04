import { expect, it, vi } from 'vitest';

import { createRunLifecycle, flowChart } from '../../../src/index.js';

it('never adopts inherited configuration callbacks while admitting an own-data component setup', async () => {
  const get = vi.fn(() => () => undefined);
  const body = vi.fn();
  const chart = flowChart('body', body, 'body').build();
  const owner = createRunLifecycle(chart, { runnerId: 'own-setup', componentSetup: () => ({}) });
  owner.slot('component');
  const before = Object.getOwnPropertyDescriptor(Object.prototype, 'bindScope');
  try {
    // eslint-disable-next-line no-extend-native -- controlled pollution fixture, restored in finally
    Object.defineProperty(Object.prototype, 'bindScope', { configurable: true, get });
    await owner.withRun((run) => run.execute({ kind: 'run' }));
  } finally {
    // eslint-disable-next-line no-extend-native -- restore the exact pre-fixture descriptor
    if (before) Object.defineProperty(Object.prototype, 'bindScope', before);
    else Reflect.deleteProperty(Object.prototype, 'bindScope');
  }
  expect(body).toHaveBeenCalledTimes(1);
  expect(get).not.toHaveBeenCalled();
});
