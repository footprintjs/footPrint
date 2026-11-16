import { expect, it } from 'vitest';

import { PauseSignal } from '../../../pause/types.js';
import { walkThenRaise } from './index.js';

function waiting(id = 'sibling') {
  return {
    stageName: id,
    level: 0,
    pause: {
      pausedStageId: id,
      pauseData: { question: id },
      subflowPath: [],
      pausedExecution: { runId: 'earlier', runtimeStageId: `${id}#2` },
    },
  };
}
const context = { getRedactionRule: () => undefined };

it('notifies after the chain and preserves the waiting sibling original execution', async () => {
  const order = [];
  let event;
  const narrative = {
    onPause: (...args) => {
      order.push('pause');
      event = args;
    },
  };
  let signal;
  try {
    await walkThenRaise(
      async () => {
        order.push('walk');
      },
      context,
      [waiting()],
      narrative,
      'current',
    );
  } catch (error) {
    signal = error;
  }
  expect(order).toEqual(['walk', 'pause']);
  expect(signal.pausedExecution).toEqual({ runId: 'earlier', runtimeStageId: 'sibling#2' });
  expect(event[4].runId).toBe('current');
  expect(event[4].runtimeStageId).toBe('__root__#0');
});

it('keeps a new pause and queues waiting siblings without notifying them again', async () => {
  const signal = new PauseSignal({ question: 'again' }, 'current');
  const narrative = {
    onPause: () => {
      throw new Error('must not notify');
    },
  };
  await expect(
    walkThenRaise(
      async () => {
        throw signal;
      },
      context,
      [waiting()],
      narrative,
      'current',
    ),
  ).rejects.toBe(signal);
  expect(signal.pendingPauses).toHaveLength(1);
  expect(signal.pendingPauses[0].pausedStageId).toBe('sibling');
});

it('keeps a non-pause rejection identity and does not notify', async () => {
  const error = Object.freeze({ failed: true });
  await expect(
    walkThenRaise(
      async () => {
        throw error;
      },
      context,
      [waiting()],
      {},
      'current',
    ),
  ).rejects.toBe(error);
});
