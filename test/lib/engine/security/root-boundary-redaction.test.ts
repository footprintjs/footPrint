import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { CommitValuesMode, FlowChartExecutorOptions, RedactionPolicy } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { inOutRecorder } from '../../../../src/trace.js';
import { defineScopeFromZod } from '../../../../src/zod.js';

type Delivery = 'inline' | 'deferred';
type ScopeKind = 'typed' | 'zod';
type Boundary = { phase: 'entry' | 'exit'; payload: unknown; runId?: string; runtimeStageId?: string };

function recordPayload(prefix: string) {
  return {
    secret: `${prefix}-secret`,
    apiToken: `${prefix}-token`,
    profile: {
      email: `${prefix}-email`,
      address: { zip: `${prefix}-zip`, city: 'visible-city' },
      name: 'visible-name',
    },
    visible: prefix,
  };
}

function retainedPayload(prefix: string) {
  return {
    secret: '[REDACTED]',
    apiToken: '[REDACTED]',
    profile: {
      email: '[REDACTED]',
      address: { zip: '[REDACTED]', city: 'visible-city' },
      name: 'visible-name',
    },
    visible: prefix,
  };
}

function policy(): RedactionPolicy {
  return {
    keys: ['secret', 'saved'],
    patterns: [/^apiToken$/gi],
    fields: { profile: ['email', 'address.zip'] },
  };
}

function options(kind: ScopeKind, commitValues: CommitValuesMode): FlowChartExecutorOptions {
  return {
    commitValues,
    ...(kind === 'zod'
      ? { scopeFactory: defineScopeFromZod(z.object({ saved: z.string() }), { strict: 'deny' }) }
      : {}),
  };
}

function observe(executor: FlowChartExecutor, delivery: Delivery) {
  const boundaries: Boundary[] = [];
  const order: string[] = [];
  executor.attachFlowRecorder(
    {
      id: 'boundary-events',
      onRunStart: (event) => {
        order.push('entry');
        boundaries.push({ phase: 'entry', payload: event.payload, ...event.traversalContext });
      },
      onRunEnd: (event) => {
        order.push('exit');
        boundaries.push({ phase: 'exit', payload: event.payload, ...event.traversalContext });
      },
      onRunFailed: () => order.push('failed'),
      onPause: () => order.push('pause'),
      onResume: () => order.push('resume'),
    },
    { delivery },
  );
  const inout = inOutRecorder({ id: 'boundary-inout' });
  executor.attachCombinedRecorder(inout, { delivery });
  return { boundaries, order, inout };
}

describe.each(['typed', 'zod'] as const)('root boundary redaction: %s scope', (kind) => {
  describe.each(['inline', 'deferred'] as const)('%s delivery', (delivery) => {
    it.each(['full', 'delta'] as const)(
      'scrubs keys, patterns and nested fields at entry and exit with %s commits, without changing live values',
      async (commitValues) => {
        const input = recordPayload('input');
        const output = recordPayload('output');
        let liveArgs: unknown;
        let repeatedArgs: unknown;
        const chart = flowChart<any>(
          'Work',
          (scope) => {
            liveArgs = kind === 'zod' ? scope.getArgs() : scope.$getArgs();
            repeatedArgs = kind === 'zod' ? scope.getArgs() : scope.$getArgs();
            if (kind === 'zod') scope.saved.set(input.secret);
            else scope.saved = input.secret;
            return output;
          },
          'work',
        ).build();
        const executor = new FlowChartExecutor(chart, options(kind, commitValues));
        executor.setRedactionPolicy(policy());
        const { boundaries, order, inout } = observe(executor, delivery);

        const returned = await executor.run({ input });

        expect(returned).toBe(output);
        expect(output).toEqual(recordPayload('output'));
        expect(input).toEqual(recordPayload('input'));
        expect(Object.isFrozen(input)).toBe(false);
        expect(Object.isFrozen(input.profile)).toBe(false);
        expect(liveArgs).toEqual(input);
        expect(repeatedArgs).toBe(liveArgs);
        expect(liveArgs).not.toBe(input);
        expect(Object.isFrozen(liveArgs)).toBe(true);
        expect(executor.getSnapshot().sharedState.saved).toBe(input.secret);
        expect(executor.getSnapshot({ redact: true }).sharedState.saved).toBe('REDACTED');
        expect(order).toEqual(['entry', 'exit']);
        expect(boundaries).toHaveLength(2);
        expect(boundaries[0].runId).toBe(executor.getSnapshot().runId);
        expect(boundaries[1].runId).toBe(boundaries[0].runId);
        expect(boundaries.map((event) => event.runtimeStageId)).toEqual(['__root__#0', '__root__#0']);
        // Soft assertions independently witness both leaks on the unfixed baseline.
        expect.soft(boundaries[0].payload).toEqual(retainedPayload('input'));
        expect.soft(boundaries[1].payload).toEqual(retainedPayload('output'));
        expect.soft(inout.getRootBoundary().entry?.payload).toEqual(retainedPayload('input'));
        expect.soft(inout.getRootBoundary().exit?.payload).toEqual(retainedPayload('output'));
        const bundle = executor.getSnapshot({ redact: true }).recorders?.find((row) => row.id === inout.id);
        expect.soft(JSON.stringify(bundle)).not.toContain('input-secret');
        expect.soft(JSON.stringify(bundle)).not.toContain('output-secret');
      },
    );
  });
});

describe.each(['inline', 'deferred'] as const)('root boundary unchanged cases: %s delivery', (delivery) => {
  it.each(['absent', 'nonmatching'] as const)('preserves unprotected boundary values with %s policy', async (kind) => {
    const input = recordPayload('clear-input');
    const output = recordPayload('clear-output');
    const chart = flowChart<object>('Return', () => output, 'return').build();
    const executor = new FlowChartExecutor(chart);
    if (kind === 'nonmatching') executor.setRedactionPolicy({ keys: ['unrelated'] });
    const { boundaries } = observe(executor, delivery);

    expect(await executor.run({ input })).toBe(output);
    expect(boundaries.map((event) => event.payload)).toEqual([input, output]);
    // Inline events keep the established borrowed-reference fast path.
    // Deferred clone delivery deliberately owns a different object.
    if (delivery === 'inline') {
      expect(boundaries[0].payload).toBe(input);
      expect(boundaries[1].payload).toBe(output);
    }
  });
});

describe.each(['same', 'fresh'] as const)('root boundary redaction across %s-executor resume', (resumeKind) => {
  describe.each(['inline', 'deferred'] as const)('%s delivery', (delivery) => {
    it.each(['full', 'delta'] as const)(
      'keeps the pause unclosed and scrubs the resumed exit with %s commits, without redacting checkpoint data',
      async (commitValues) => {
        const input = recordPayload('before-pause');
        const output = recordPayload('after-resume');
        const pauseData = { question: 'approve?', secret: 'operational-pause-secret' };
        const resumeInput = { secret: 'operational-answer' };
        let receivedAnswer: unknown;
        let resumedState: unknown;
        const chart = flowChart<{ saved: string }>(
          'Seed',
          (scope) => {
            scope.saved = 'operational-state-secret';
          },
          'seed',
        )
          .addPausableFunction(
            'Approve',
            {
              execute: () => pauseData,
              resume: (scope, answer) => {
                receivedAnswer = answer;
                resumedState = scope.saved;
              },
            },
            'approve',
          )
          .addFunction('Return', () => output, 'return')
          .build();
        const first = new FlowChartExecutor(chart, { commitValues });
        first.setRedactionPolicy(policy());
        const original = observe(first, delivery);
        await first.run({ input });
        expect(first.isPaused()).toBe(true);
        const checkpoint = first.getCheckpoint();
        if (!checkpoint) throw new Error('Expected the approval stage to pause');
        expect(checkpoint.sharedState.saved).toBe('operational-state-secret');
        expect(checkpoint.pauseData).toEqual(pauseData);
        expect(original.order).toEqual(['entry', 'pause']);
        expect(original.boundaries).toHaveLength(1);
        expect(original.inout.getRootBoundary().exit).toBeUndefined();
        expect.soft(original.boundaries[0].payload).toEqual(retainedPayload('before-pause'));
        const firstRunId = original.boundaries[0].runId;

        const resumed = resumeKind === 'same' ? first : new FlowChartExecutor(chart, { commitValues });
        resumed.setRedactionPolicy(policy());
        const observation = resumeKind === 'same' ? original : observe(resumed, delivery);
        const restored = JSON.parse(JSON.stringify(checkpoint));
        const returned = await resumed.resume(restored, resumeInput);

        expect(returned).toBe(output);
        expect(receivedAnswer).toBe(resumeInput);
        expect(resumedState).toBe('operational-state-secret');
        expect(restored).toEqual(checkpoint);
        expect(resumed.isPaused()).toBe(false);
        expect(observation.order).toEqual(
          resumeKind === 'same' ? ['entry', 'pause', 'resume', 'entry', 'exit'] : ['resume', 'entry', 'exit'],
        );
        const resumedBoundaries = observation.boundaries.slice(-2);
        // Resume supplies no new run({input}); its answer is NOT root-entry data.
        expect(resumedBoundaries[0].payload).toBeUndefined();
        expect(resumedBoundaries[0].runId).not.toBe(firstRunId);
        expect(resumedBoundaries[1].runId).toBe(resumedBoundaries[0].runId);
        expect.soft(resumedBoundaries[1].payload).toEqual(retainedPayload('after-resume'));
        expect(resumed.getSnapshot().sharedState.saved).toBe('operational-state-secret');
        expect(resumed.getSnapshot({ redact: true }).sharedState.saved).toBe('REDACTED');
      },
    );
  });
});

describe('root boundary payload shape contract', () => {
  it.each([
    ['text', 'literal-secret'],
    ['number', 7],
    ['boolean', true],
    ['null', null],
    ['undefined', undefined],
    ['array', [{ secret: 'array-secret' }]],
  ] as const)('does not infer record fields for a %s payload', async (_name, payload) => {
    const executor = new FlowChartExecutor(flowChart<unknown, object>('Return', () => payload, 'return').build());
    executor.setRedactionPolicy({ keys: ['secret'], patterns: [/secret/] });
    const { boundaries } = observe(executor, 'inline');

    expect(await executor.run({ input: payload })).toBe(payload);
    expect(boundaries).toHaveLength(2);
    // Existing executor input resolution treats null like absent input.
    expect(boundaries[0].payload).toBe(payload ?? undefined);
    expect(boundaries[1].payload).toBe(payload);
  });

  describe.each(['inline', 'deferred'] as const)('%s delivery', (delivery) => {
    it.each(['whole-child', 'explicit-result-field'] as const)(
      'protects a fork result envelope using %s policy without changing child results',
      async (mode) => {
        const leftOutput = { secret: 'left-secret', visible: 'left-visible' };
        const rightOutput = { visible: 'right-visible' };
        const chart = flowChart<object>('Fork', () => {}, 'fork')
          .addListOfFunction([
            { id: 'left', name: 'Left', fn: () => leftOutput },
            { id: 'right', name: 'Right', fn: () => rightOutput },
          ])
          .build();
        const executor = new FlowChartExecutor(chart);
        executor.setRedactionPolicy(
          mode === 'whole-child' ? { keys: ['left'] } : { fields: { left: ['result.secret'] } },
        );
        const { boundaries, inout } = observe(executor, delivery);

        const result = (await executor.run()) as Record<string, { result: unknown }>;
        expect(result.left.result).toBe(leftOutput);
        expect(result.right.result).toBe(rightOutput);
        expect(leftOutput.secret).toBe('left-secret');
        const retained = {
          ...result,
          left:
            mode === 'whole-child'
              ? '[REDACTED]'
              : { ...result.left, result: { secret: '[REDACTED]', visible: 'left-visible' } },
        };
        expect(boundaries.map((event) => event.phase)).toEqual(['entry', 'exit']);
        expect.soft(boundaries[1].payload).toEqual(retained);
        expect.soft(inout.getRootBoundary().exit?.payload).toEqual(retained);
      },
    );
  });
});

describe.each(['inline', 'deferred'] as const)('root boundary manual-mark timing: %s delivery', (delivery) => {
  it('uses marks established during the run at exit and resets them before the next run', async () => {
    const output = { secret: 'returned-secret', visible: true };
    const chart = flowChart<{ secret: string }>(
      'Mark',
      (scope) => {
        if (scope.$getArgs<{ mark: boolean }>().mark) scope.$setValue('secret', 'stored-secret', true);
      },
      'mark',
    )
      .addFunction('Return', () => output, 'return')
      .build();
    const executor = new FlowChartExecutor(chart);
    const { boundaries } = observe(executor, delivery);

    expect(await executor.run({ input: { mark: true } })).toBe(output);
    expect(boundaries[0].payload).toEqual({ mark: true });
    expect(boundaries[1].payload).toEqual({ secret: '[REDACTED]', visible: true });
    expect(executor.getSnapshot().sharedState.secret).toBe('stored-secret');
    const firstRunId = boundaries[0].runId;

    expect(await executor.run({ input: { mark: false } })).toBe(output);
    expect(boundaries[2].payload).toEqual({ mark: false });
    expect(boundaries[3].payload).toEqual(output);
    expect(boundaries[2].runId).not.toBe(firstRunId);
    expect(output.secret).toBe('returned-secret');
  });
});

describe('root boundary scrub failure containment', () => {
  it.each(['entry', 'exit'] as const)(
    'rejects a failed %s scrub instead of dispatching the unprotected payload',
    async (phase) => {
      const failure = new Error('synthetic boundary getter failure');
      const payload = Object.defineProperty({}, 'secret', {
        enumerable: true,
        get() {
          throw failure;
        },
      });
      let stagesRun = 0;
      const chart = flowChart<object>(
        'Return',
        () => {
          stagesRun++;
          return phase === 'exit' ? payload : undefined;
        },
        'return',
      ).build();
      const executor = new FlowChartExecutor(chart);
      executor.setRedactionPolicy({ keys: ['secret'] });
      const { boundaries, order } = observe(executor, 'inline');
      const run = executor.run({ input: phase === 'entry' ? payload : undefined });

      const outcome = await run.then(
        () => ({ rejected: false, error: undefined }),
        (error: unknown) => ({ rejected: true, error }),
      );
      expect.soft(outcome.rejected).toBe(true);
      expect.soft(outcome.error).toBe(failure);
      expect.soft(boundaries.some((event) => event.phase === phase)).toBe(false);
      expect(order).toEqual(phase === 'entry' ? [] : ['entry', 'failed']);
      expect(stagesRun).toBe(phase === 'entry' ? 0 : 1);
    },
  );

  it.each(['absent', 'emit-only'] as const)(
    'does not evaluate a returned accessor with %s state-redaction policy',
    async (mode) => {
      let reads = 0;
      const output = Object.defineProperty({}, 'secret', {
        enumerable: true,
        get() {
          reads++;
          throw new Error('an inert rule must not read this field');
        },
      });
      const executor = new FlowChartExecutor(flowChart<object>('Return', () => output, 'return').build());
      if (mode === 'emit-only') executor.setRedactionPolicy({ emitPatterns: [/private-event/] });
      let observed: unknown;
      executor.attachFlowRecorder({ id: 'borrowed-output', onRunEnd: (event) => (observed = event.payload) });

      expect(await executor.run()).toBe(output);
      expect(observed).toBe(output);
      expect(reads).toBe(0);
    },
  );
});
