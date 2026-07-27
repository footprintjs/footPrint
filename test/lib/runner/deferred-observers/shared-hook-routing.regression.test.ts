/**
 * Regression guard for the shared-name hooks (`onError` / `onPause` /
 * `onResume`) that are declared on BOTH the scope and flow recorder
 * interfaces.
 *
 * A recorder implementing one of them is registered on BOTH channels on
 * purpose — each channel calls the hook with its own payload variant. That
 * used to duplicate the recorder's row in `snapshot.recorders`, and the
 * tempting "fix" is to drop the name from one of the routing arrays in
 * `CombinedRecorder.ts`. Those arrays also drive the DEFERRED tier's capture
 * taps (`buildScopeTap` / `buildFlowTap`), so dropping a name there silently
 * blinds every deferred observer to that event — no error, no warning.
 *
 * The duplicate is fixed where it belongs (snapshot serialization). These
 * tests pin the routing that must NOT change to get there.
 */

import { describe, expect, it } from 'vitest';

import type { PausableHandler } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { FLOW_RECORDER_EVENT_METHODS, RECORDER_EVENT_METHODS } from '../../../../src/lib/recorder/CombinedRecorder.js';

const SHARED_HOOKS = ['onError', 'onPause', 'onResume'] as const;

const approval: PausableHandler<any> = {
  execute: async (scope) => {
    scope.stage = 'awaiting';
    return { pause: true, data: { question: 'Approve?' } };
  },
  resume: async (scope, input: { approved: boolean }) => {
    scope.approved = input.approved;
  },
};

function buildPausingChart() {
  return flowChart<{ stage: string; approved?: boolean }>(
    'Seed',
    (scope) => {
      scope.stage = 'start';
    },
    'seed',
  )
    .addPausableFunction('Approve', approval, 'approve')
    .build();
}

describe('shared-name hooks — routing arrays', () => {
  it('every shared hook is listed on BOTH channels (the deferred taps read these arrays)', () => {
    for (const hook of SHARED_HOOKS) {
      expect(RECORDER_EVENT_METHODS).toContain(hook);
      expect(FLOW_RECORDER_EVENT_METHODS).toContain(hook);
    }
  });
});

describe('shared-name hooks — deferred delivery still sees both variants', () => {
  it('a deferred recorder whose ONLY hook is onPause receives the scope AND flow pause events', async () => {
    const seen: Array<'scope' | 'flow' | 'unstamped'> = [];
    const executor = new FlowChartExecutor(buildPausingChart());
    executor.attachCombinedRecorder(
      {
        id: 'pause-watch',
        onPause: (event) => {
          const channel = (event as { channel?: 'scope' | 'flow' }).channel;
          seen.push(channel ?? 'unstamped');
        },
      },
      { delivery: 'deferred' },
    );

    await executor.run();

    expect(executor.isPaused()).toBe(true);
    expect(seen).toContain('scope');
    expect(seen).toContain('flow');
  });

  it('inline delivery sees the same two variants — deferral changes timing, not reach', async () => {
    const seen: Array<'scope' | 'flow' | 'unstamped'> = [];
    const executor = new FlowChartExecutor(buildPausingChart());
    executor.attachCombinedRecorder({
      id: 'pause-watch',
      onPause: (event) => {
        const channel = (event as { channel?: 'scope' | 'flow' }).channel;
        seen.push(channel ?? 'unstamped');
      },
    });

    await executor.run();

    expect(seen).toContain('scope');
    expect(seen).toContain('flow');
  });
});
