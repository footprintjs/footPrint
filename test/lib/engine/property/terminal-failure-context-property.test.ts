import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { FlowErrorEvent, FlowRunFailedEvent } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import type { ILogger } from '../../../../src/lib/engine/types.js';

const silent: ILogger = { info() {}, log() {}, debug() {}, error() {}, warn() {} };

describe('terminal failure native-ownership properties', () => {
  it('retains exact nested and loop execution identity across arbitrary recovered retry counts', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 0, max: 3 }),
        async (passes, depth, recoveredFailures) => {
          let retries = 0;
          const original = Object.assign(new Error('synthetic final'), { status: 503 });
          let chart = flowChart<{ pass: number }>(
            'Seed inner',
            (scope) => {
              scope.pass = 0;
            },
            'seed-inner',
          )
            .addFunction(
              'Recover',
              () => {
                if (retries++ < recoveredFailures)
                  throw Object.assign(new Error('synthetic recovered'), { status: 401 });
              },
              'recover',
            )
            .retry({ attempts: recoveredFailures + 1 })
            .addFunction(
              'Tick',
              (scope) => {
                scope.pass++;
              },
              'tick',
            )
            .addDeciderFunction('Route', (scope) => (scope.pass < passes ? 'again' : 'fail'), 'route')
            .addFunctionBranch('again', 'Again', () => {})
            .loopTo('tick')
            .addFunctionBranch('fail', 'Terminal', () => {
              throw original;
            })
            .end()
            .setLogger(silent)
            .build();
          for (let level = 0; level < depth; level++) {
            chart = flowChart<{ pass: number }>('Outer seed', () => {}, 'outer-seed')
              .addSubFlowChartNext('mount-' + level, chart, 'Nested')
              .setLogger(silent)
              .build();
          }
          const executor = new FlowChartExecutor(chart);
          const errors: FlowErrorEvent[] = [];
          const failed: FlowRunFailedEvent[] = [];
          executor.attachFlowRecorder({
            id: 'nested-native-context',
            onError: (event) => errors.push(event),
            onRunFailed: (event) => failed.push(event),
          });
          await expect(executor.run()).rejects.toBe(original);
          const terminal = errors.find((event) => event.stageName.endsWith('Terminal'))!.traversalContext!;
          expect(terminal.runtimeStageId.split('/')).toHaveLength(depth + 1);
          expect(executor.getFailureContext()).toEqual({
            category: 'server',
            stage: { runId: terminal.runId, runtimeStageId: terminal.runtimeStageId },
          });
          expect(failed).toHaveLength(1);
          expect(failed[0].failure).toEqual(executor.getFailureContext());
          expect(failed[0].traversalContext!.runtimeStageId).toBe('__root__#0');
        },
      ),
      { numRuns: 24, seed: 1092026 },
    );
  });

  it('identical primitive values from contained and terminal stages never collide', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.integer(), fc.string({ maxLength: 24 }), fc.constant(null), fc.constant(undefined), fc.boolean()),
        async (thrown) => {
          const executor = new FlowChartExecutor(
            flowChart('Seed', () => {}, 'seed')
              .addListOfFunction([
                {
                  id: 'contained',
                  name: 'Contained',
                  fn: () => {
                    throw thrown;
                  },
                },
              ])
              .addFunction(
                'Terminal',
                () => {
                  throw thrown;
                },
                'terminal',
              )
              .setLogger(silent)
              .build(),
          );
          const errors: FlowErrorEvent[] = [];
          executor.attachFlowRecorder({ id: 'primitive-native-context', onError: (event) => errors.push(event) });
          let rejection: { value: unknown } | undefined;
          try {
            await executor.run();
          } catch (value) {
            rejection = { value };
          }
          expect(rejection).toBeDefined();
          expect(Object.is(rejection!.value, thrown)).toBe(true);
          const terminal = errors.find((event) => event.stageName === 'Terminal')!.traversalContext!;
          expect(executor.getFailureContext()).toEqual({
            category: 'unknown',
            stage: { runId: terminal.runId, runtimeStageId: terminal.runtimeStageId },
          });
        },
      ),
      { numRuns: 32, seed: 109109 },
    );
  });

  it('a recovered attempt category cannot replace any later terminal category', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.constantFrom([429, 'rate-limited'], [503, 'server'], [401, 'auth'], [400, 'permanent']),
        async (recoveries, [status, category]) => {
          let attempts = 0;
          const original = Object.assign(new Error('synthetic final category'), { status });
          const executor = new FlowChartExecutor(
            flowChart(
              'Recover',
              () => {
                if (attempts++ < recoveries)
                  throw Object.assign(new Error('synthetic recovered category'), { code: 'ECONNRESET' });
              },
              'recover',
            )
              .retry({ attempts: recoveries + 1 })
              .addFunction(
                'Terminal',
                () => {
                  throw original;
                },
                'terminal',
              )
              .setLogger(silent)
              .build(),
          );
          await expect(executor.run()).rejects.toBe(original);
          expect(executor.getFailureContext()!.category).toBe(category);
          expect(executor.getFailureContext()!.stage!.runtimeStageId).toBe('terminal#1');
        },
      ),
      { numRuns: 24, seed: 109503 },
    );
  });
});
