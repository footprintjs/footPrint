import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { RunLifecycle, RunSlot } from '../../../src';
import { createRunLifecycle, flowChart } from '../../../src';

describe('run lifecycle concurrency properties', () => {
  it('independent objects with the same display label keep their own context and native event identity', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer(), { minLength: 2, maxLength: 8 }), async (values) => {
        const owners: RunLifecycle[] = [];
        const slots: RunSlot<{ value: number }>[] = [];
        const origins: string[] = [];
        const seen: Array<{ index: number; runId: string; value: number }> = [];
        const emitted = new Map<number, string[]>();
        const chart = flowChart<{ observed?: number }>(
          'observe',
          async (scope) => {
            const index = scope.$getArgs<{ index: number }>().index;
            const bound = owners[index].forScope(scope);
            const cell = bound.read(slots[index]);
            expect(cell.present).toBe(true);
            if (!cell.present) return;
            await Promise.resolve();
            scope.observed = cell.value.value;
            seen.push({ index, runId: bound.origin.runId, value: cell.value.value });
          },
          'observe',
        ).build();
        for (let index = 0; index < values.length; index += 1) {
          owners.push(createRunLifecycle(chart, { runnerId: 'same-display-label' }));
          slots.push(owners[index].slot('runtime'));
          emitted.set(index, []);
        }
        await Promise.all(
          owners.map((owner, index) =>
            owner.withRun((run) => {
              run.set(slots[index], { value: values[index] });
              return run.execute(
                { kind: 'run', options: { input: { index } } },
                {
                  onOrigin: (_cells, origin) => {
                    origins[index] = origin.runId;
                  },
                  attachments: [
                    {
                      recorder: {
                        id: 'identity',
                        onStageExecuted: (event) => {
                          const id = event.traversalContext?.runId;
                          if (id !== undefined) emitted.get(index)!.push(id);
                        },
                      },
                    },
                  ],
                },
              );
            }),
          ),
        );
        expect(seen).toHaveLength(values.length);
        expect(new Set(origins).size).toBe(values.length);
        for (const row of seen) {
          expect(row.value).toBe(values[row.index]);
          expect(row.runId).toBe(origins[row.index]);
          expect(emitted.get(row.index)).toEqual([origins[row.index]]);
          expect(owners[row.index].view()!.snapshot()!.sharedState.observed).toBe(values[row.index]);
        }
      }),
      { seed: 110214, numRuns: 40 },
    );
  });
});
