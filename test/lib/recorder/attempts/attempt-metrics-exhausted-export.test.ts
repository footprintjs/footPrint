/** Public exporter regression: exhausted series count once and retain their own physical-attempt window. */
import { afterEach, expect, it, vi } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { attempts } from '../../../../src/recorders.js';

afterEach(() => vi.useRealTimers());

it('exports an exhausted call once, without borrowing timestamps or exemplars from later successful work', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const recorder = attempts({ exemplars: 1 });
  const original = new Error('SYNTHETIC_SERVICE_FAILURE');
  let sends = 0;
  const chart = flowChart(
    'Request',
    async (scope) => {
      try {
        await scope.$call(
          'service.read',
          () => {
            vi.setSystemTime(Date.now() + (++sends === 1 ? 7 : 11));
            throw original;
          },
          { attempts: 2, backoffMs: 0 },
        );
        expect.unreachable('The exhausted call must reject');
      } catch (error) {
        expect(error).toBe(original);
      }
      vi.setSystemTime(9_000);
      await scope.$call('service.other', () => {
        vi.setSystemTime(9_003);
        return 'ok';
      });
    },
    'request',
  ).build();
  const executor = new FlowChartExecutor(chart);
  executor.attachFlowRecorder(recorder);
  await executor.run();

  expect(sends).toBe(2);
  expect(recorder.byTarget().get('service.read')).toMatchObject({ count: 2, retries: 1, gaveUp: 1 });
  const exported = recorder.toOTel();
  const metrics = exported.resourceMetrics[0].scopeMetrics[0].metrics;
  const gaveUp = metrics.find((metric) => metric.name === 'footprint.attempt.gave_up')?.sum;
  expect(gaveUp).toMatchObject({ aggregationTemporality: 2, isMonotonic: true });
  expect(gaveUp?.dataPoints).toHaveLength(1);
  expect(gaveUp?.dataPoints[0]).toMatchObject({
    attributes: [{ key: 'footprint.target', value: { stringValue: 'service.read' } }],
    asDouble: 1,
    startTimeUnixNano: '1000000000',
    timeUnixNano: '1018000000',
    exemplars: [
      {
        asDouble: 1,
        timeUnixNano: '1007000000',
        filteredAttributes: expect.arrayContaining([
          { key: 'footprint.attempt.id', value: { stringValue: 'request#0@1.1@2' } },
          { key: 'footprint.runtime_stage_id', value: { stringValue: 'request#0' } },
          { key: 'footprint.run_id', value: { stringValue: executor.getSnapshot().runId } },
        ]),
      },
    ],
  });
  const counts = metrics.find((metric) => metric.name === 'footprint.attempt.count')?.sum?.dataPoints;
  expect(counts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        attributes: expect.arrayContaining([{ key: 'footprint.target', value: { stringValue: 'service.read' } }]),
        asDouble: 2,
      }),
    ]),
  );
  expect(JSON.stringify(exported)).not.toContain(original.message);
});
