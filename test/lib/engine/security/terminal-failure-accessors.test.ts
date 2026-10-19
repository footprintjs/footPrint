import { describe, expect, it, vi } from 'vitest';

import { type TerminalFailureContext, flowChart, FlowChartExecutor } from '../../../../src/index.js';

const silent = { info() {}, log() {}, debug() {}, warn() {}, error() {} };

describe('native terminal classification never executes raw status accessors', () => {
  for (const placement of ['own', 'inherited'] as const) {
    for (const policy of [false, true]) {
      it.each([false, true])(
        `${placement} status accessor remains unread (policy=${policy}, throws=%s)`,
        async (throws) => {
          const status = vi.fn(() => {
            if (throws) throw new Error('synthetic private accessor detail');
            return 401;
          });
          const original = new Error('synthetic private original failure');
          if (placement === 'own') Object.defineProperty(original, 'status', { get: status });
          else Object.setPrototypeOf(original, Object.create(Error.prototype, { status: { get: status } }));
          let builder = flowChart(
            'Read source',
            () => {
              throw original;
            },
            'source',
          );
          if (policy) builder = builder.retry({ attempts: 2 });
          const executor = new FlowChartExecutor(builder.setLogger(silent).build());
          executor.setRedactionPolicy({ diagnostics: { keys: ['errors.stageExecutionError'] } });
          let observed: TerminalFailureContext | undefined;
          executor.attachFlowRecorder({
            id: 'native-failure',
            onRunFailed(event) {
              observed = event.failure;
            },
          });
          await expect(executor.run()).rejects.toBe(original);
          expect(status).not.toHaveBeenCalled();
          expect(executor.getFailureContext()).toEqual({
            category: 'unknown',
            stage: {
              runId: executor.getSnapshot().runId,
              runtimeStageId: 'source#0',
            },
          });
          expect(observed).toBe(executor.getFailureContext());
          expect(JSON.stringify(observed)).not.toContain('private');
        },
      );
    }
  }
});
