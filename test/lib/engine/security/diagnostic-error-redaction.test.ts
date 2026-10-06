/**
 * A diagnostic key policy on the stage error text (`diagnostics.keys:
 * ['errors.stageExecutionError']`) is applied ONCE, at the stage's error
 * site, before `onError` / `onRunFailed` dispatch — so the narrative, the
 * flow events (inline and deferred) and the redacted snapshot's recorder rows
 * never see the thrown text. The live rejection stays the real error.
 */
import { describe, expect, it } from 'vitest';

import type { FlowChartExecutorOptions } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor, NarrativeFlowRecorder } from '../../../../src/index.js';
import { narrative } from '../../../../src/recorders.js';
import { inOutRecorder } from '../../../../src/trace.js';

const SECRET = 'card-4111-1111';

/** Every string reachable from `value`, including an Error's own non-enumerable message/stack. */
function servedStrings(value: unknown, seen = new WeakSet<object>(), out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  if (value === null || typeof value !== 'object') return out;
  if (seen.has(value)) return out;
  seen.add(value);
  for (const name of Object.getOwnPropertyNames(value)) {
    let child: unknown;
    try {
      child = (value as Record<string, unknown>)[name];
    } catch {
      continue;
    }
    servedStrings(child, seen, out);
  }
  return out;
}

type Placement = 'linear' | 'decider' | 'selector' | 'subflow';

function chartFor(placement: Placement) {
  const boom = () => {
    throw new Error(`charge failed for ${SECRET}`);
  };
  if (placement === 'linear') return flowChart<object>('Charge', boom, 'charge').build();
  if (placement === 'decider') {
    return flowChart<object>('Start', () => {}, 'start')
      .addDeciderFunction('Route', boom as never, 'route')
      .addFunctionBranch('a', 'A', () => {})
      .end()
      .build();
  }
  if (placement === 'selector') {
    return flowChart<object>('Start', () => {}, 'start')
      .addSelectorFunction('Pick', boom as never, 'pick')
      .addFunctionBranch('a', 'A', () => {})
      .end()
      .build();
  }
  const inner = flowChart<object>('Charge', boom, 'charge').build();
  return flowChart<object>('Start', () => {}, 'start')
    .addSubFlowChartNext('pay', inner, 'Pay')
    .build();
}

describe.each(['inline', 'deferred'] as const)(
  'stage error text under a diagnostic key policy: %s delivery',
  (delivery) => {
    it.each(['linear', 'decider', 'selector', 'subflow'] as const)(
      'a %s stage error reaches no served output raw',
      async (placement) => {
        const options: FlowChartExecutorOptions = { enableNarrative: true };
        const executor = new FlowChartExecutor(chartFor(placement), options);
        // A subflow mount also records the inner text under its own key: select both.
        const keys = ['errors.stageExecutionError', ...(placement === 'subflow' ? ['errors.subflowError'] : [])];
        executor.setRedactionPolicy({ diagnostics: { keys } });
        const events: unknown[] = [];
        executor.attachFlowRecorder(
          {
            id: 'failures',
            onError: (event) => events.push(event),
            onRunFailed: (event) => events.push(event),
          },
          { delivery },
        );
        const story = narrative();
        executor.attachCombinedRecorder(story, { delivery });
        executor.attachCombinedRecorder(inOutRecorder({ id: 'io' }), { delivery });

        // The live rejection is the real error.
        await expect(executor.run()).rejects.toThrow(SECRET);

        expect(events.length).toBeGreaterThanOrEqual(2);
        const served = servedStrings([
          events,
          story.getEntries(),
          executor.getNarrativeEntries(),
          executor.getSnapshot({ redact: true }),
        ]);
        expect(served.filter((text) => text.includes(SECRET))).toEqual([]);
        expect(served.some((text) => text.includes('[REDACTED]'))).toBe(true);
      },
    );

    it('gives onError and onRunFailed their own masked structuredError objects', async () => {
      const executor = new FlowChartExecutor(chartFor('linear'));
      executor.setRedactionPolicy({ diagnostics: { keys: ['errors.stageExecutionError'] } });
      const errors: Array<{ structuredError: object }> = [];
      executor.attachFlowRecorder(
        { id: 'failures', onError: (event) => errors.push(event), onRunFailed: (event) => errors.push(event) },
        { delivery },
      );
      await expect(executor.run()).rejects.toThrow(SECRET);
      expect(errors).toHaveLength(2);
      expect(errors[0].structuredError).toEqual(errors[1].structuredError);
      expect(errors[0].structuredError).not.toBe(errors[1].structuredError);
    });

    it('leaves the error text intact without a diagnostic policy', async () => {
      const executor = new FlowChartExecutor(chartFor('linear'), { enableNarrative: true });
      const events: Array<{ structuredError: { message: string; raw: unknown } }> = [];
      executor.attachFlowRecorder(
        { id: 'failures', onError: (event) => events.push(event), onRunFailed: (event) => events.push(event) },
        { delivery },
      );
      await expect(executor.run()).rejects.toThrow(SECRET);
      expect(events.map((event) => event.structuredError.message)).toEqual([
        `charge failed for ${SECRET}`,
        `charge failed for ${SECRET}`,
      ]);
      expect(events.every((event) => event.structuredError.raw instanceof Error)).toBe(true);
    });
  },
);

describe.each(['inline', 'deferred'] as const)(
  'every other served path of a masked stage error: %s delivery',
  (delivery) => {
    function capture(executor: FlowChartExecutor) {
      const events: unknown[] = [];
      executor.attachFlowRecorder(
        {
          id: 'all-failures',
          onStageRetry: (event) => events.push(event),
          onThrottled: (event) => events.push(event),
          onError: (event) => events.push(event),
          onRunFailed: (event) => events.push(event),
          onRunEnd: (event) => events.push(event),
        },
        { delivery },
      );
      executor.attachCombinedRecorder(narrative(), { delivery });
      executor.attachCombinedRecorder(inOutRecorder({ id: 'io' }), { delivery });
      const flowOnly = new NarrativeFlowRecorder('flow-only');
      executor.attachFlowRecorder(flowOnly, { delivery });
      return { events, flowOnly };
    }

    function loggerSink() {
      const lines: unknown[] = [];
      const log = (...args: unknown[]) => lines.push(args);
      return { lines, logger: { info: log, log, debug: log, error: log, warn: log } };
    }

    function leaks(executor: FlowChartExecutor, ...more: unknown[]): string[] {
      const served = servedStrings([...more, executor.getNarrativeEntries(), executor.getSnapshot({ redact: true })]);
      return served.filter((text) => text.includes(SECRET));
    }

    type Thrown = 'Error' | 'string';
    const thrown = (kind: Thrown): unknown =>
      kind === 'Error' ? new Error(`charge failed for ${SECRET}`) : `charge failed for ${SECRET}`;
    const failing = (kind: Thrown) => () => {
      throw thrown(kind);
    };
    const forkOf = (kind: Thrown) =>
      flowChart<object>('Fork', () => {}, 'fork').addListOfFunction([
        { id: 'left', name: 'Left', fn: failing(kind) },
        { id: 'right', name: 'Right', fn: () => ({ ok: true }) },
      ]);

    /** Every scenario that reports a stage failure somewhere other than the stage's own onError. */
    const scenarios = {
      retry: {
        chart: (kind: Thrown) =>
          flowChart<object>('Charge', failing(kind), 'charge').retry({ attempts: 2, backoffMs: 0 }),
        options: {},
        rejects: true,
        reported: (event: Record<string, unknown>) => event.attempt === 1,
      },
      'retryOn rethrow': {
        chart: (kind: Thrown) =>
          flowChart<object>('Charge', failing(kind), 'charge').retry({
            attempts: 2,
            backoffMs: 0,
            retryOn: (error) => {
              throw error;
            },
          }),
        options: {},
        rejects: true,
        reported: (event: Record<string, unknown>) => event.structuredError !== undefined,
      },
      subflow: {
        chart: (kind: Thrown) =>
          flowChart<object>('Start', () => {}, 'start').addSubFlowChartNext(
            'pay',
            flowChart<object>('Charge', failing(kind), 'charge').build(),
            'Pay',
          ),
        options: {},
        rejects: true,
        reported: (event: Record<string, unknown>) => event.structuredError !== undefined,
      },
      'fork as the last stage': {
        chart: forkOf,
        options: {},
        rejects: false,
        reported: (event: Record<string, unknown>) => event.payload !== undefined,
      },
      'throttled fork child': {
        chart: forkOf,
        options: { throttlingErrorChecker: () => true },
        rejects: false,
        reported: (event: Record<string, unknown>) => event.stageId === 'left',
      },
    };

    describe.each(['Error', 'string'] as const)('thrown %s', (kind) => {
      it.each(Object.keys(scenarios) as (keyof typeof scenarios)[])(
        '%s: events, narratives, InOut, redacted snapshot and logger never see the text',
        async (name) => {
          const scenario = scenarios[name];
          const { lines, logger } = loggerSink();
          const executor = new FlowChartExecutor(scenario.chart(kind).setLogger(logger).build(), {
            enableNarrative: true,
            ...scenario.options,
          });
          // A subflow mount records the inner text under its own key: select both.
          executor.setRedactionPolicy({
            diagnostics: { keys: ['errors.stageExecutionError', 'errors.subflowError'] },
          });
          const { events, flowOnly } = capture(executor);

          const outcome = await executor.run().then(
            (result) => ({ result }),
            (reason: unknown) => ({ reason }),
          );

          // Live surfaces stay real: the rejection, or the fork's own result.
          if (scenario.rejects) {
            const reason = (outcome as { reason: unknown }).reason;
            expect(reason instanceof Error ? reason.message : reason).toContain(SECRET);
          } else {
            const result = (outcome as { result: Record<string, { result: unknown }> }).result;
            expect(
              result.left.result instanceof Error ? (result.left.result as Error).message : result.left.result,
            ).toContain(SECRET);
          }
          expect(events.some((event) => scenario.reported(event as Record<string, unknown>))).toBe(true);
          expect(lines.length).toBeGreaterThan(0);
          expect(leaks(executor, events, lines, flowOnly.getSentences())).toEqual([]);
        },
      );
    });
  },
);
