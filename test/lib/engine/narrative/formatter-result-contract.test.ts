import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import { flowChart, FlowChartExecutor, narrative } from '../../../../src/index.js';
import { CombinedNarrativeRecorder } from '../../../../src/lib/engine/narrative/CombinedNarrativeRecorder.js';
import type { NarrativeFormatter, OpRenderContext } from '../../../../src/lib/engine/narrative/narrativeTypes.js';
import type { TraversalContext } from '../../../../src/lib/engine/narrative/types.js';

const traversalContext: TraversalContext = {
  runId: 'formatter-contract',
  stageId: 'outer/work',
  runtimeStageId: 'outer/work#7',
  stageName: 'Work',
  subflowId: 'outer',
  subflowPath: 'outer',
  depth: 1,
};
const scopeContext = { ...traversalContext, pipelineId: 'pipeline', timestamp: 123 };

type Route = 'read' | 'set' | 'update' | 'delete' | 'input' | 'emit';
const routes: Route[] = ['read', 'set', 'update', 'delete', 'input', 'emit'];

function capture(recorder: CombinedNarrativeRecorder, route: Route, key: string, value: unknown): void {
  if (route === 'input') {
    recorder.onSubflowEntry({ name: 'Child', subflowId: 'child', mappedInput: { [key]: value }, traversalContext });
  } else if (route === 'emit') {
    recorder.onEmit({ ...scopeContext, name: key, payload: value, subflowPath: ['outer'] });
  } else if (route === 'read') {
    recorder.onRead({ ...scopeContext, key, value });
  } else {
    recorder.onWrite({ ...scopeContext, key, value, operation: route });
  }
}

function flush(recorder: CombinedNarrativeRecorder): void {
  recorder.onStageExecuted({ stageName: 'Work', stageType: 'linear', traversalContext });
}

const results = [
  { label: 'absent hook', present: false, value: undefined },
  { label: 'undefined', present: true, value: undefined },
  { label: 'null', present: true, value: null },
  { label: 'custom string', present: true, value: 'Custom line' },
  { label: 'empty string', present: true, value: '' },
] as const;

describe.each(routes)('formatter result contract: %s', (route) => {
  describe.each([
    { includeValues: true, includeStepNumbers: true },
    { includeValues: false, includeStepNumbers: true },
    { includeValues: true, includeStepNumbers: false },
    { includeValues: false, includeStepNumbers: false },
  ])('values=$includeValues, step numbers=$includeStepNumbers', (options) => {
    it.each(results)('$label', ({ present, value }) => {
      const renderer: NarrativeFormatter = {};
      const render = vi.fn(function (this: NarrativeFormatter) {
        expect(this).toBe(renderer);
        return value;
      });
      if (present) {
        if (route === 'emit') renderer.renderEmit = render;
        else renderer.renderOp = render;
      }
      const formatValue = vi.fn(() => '<42>');
      const recorder = new CombinedNarrativeRecorder({ ...options, renderer, formatValue, maxValueLength: 19 });
      capture(recorder, route, 'answer', 42);
      if (route !== 'input') flush(recorder);

      expect(formatValue).toHaveBeenCalledExactlyOnceWith(42, 19);
      expect(render).toHaveBeenCalledTimes(present ? 1 : 0);
      const entries = recorder.getEntries().filter((entry) => entry.type === (route === 'emit' ? 'emit' : 'step'));
      if (value === null) {
        expect(entries).toEqual([]);
        return;
      }

      // Literal templates pin the public text contract, independent of the implementation.
      const defaults: Record<Route, string> = {
        read: options.includeValues ? 'Read answer = <42>' : 'Read answer',
        set: options.includeValues ? 'Write answer = <42>' : 'Write answer',
        update: options.includeValues ? 'Update answer = <42>' : 'Update answer',
        delete: 'Delete answer',
        input: options.includeValues ? 'Input: answer = <42>' : 'Input: answer',
        emit: '[emit] answer: <42>',
      };
      const prefix = route !== 'input' && route !== 'emit' && options.includeStepNumbers ? 'Step 1: ' : '';
      expect(entries).toHaveLength(1);
      expect(entries[0].text).toBe(value === undefined ? prefix + defaults[route] : value);
      expect(entries[0]).toMatchObject({
        depth: 1,
        stageName: route === 'input' ? 'Child' : 'Work',
        stageId: 'outer/work',
        runtimeStageId: 'outer/work#7',
        subflowId: 'outer',
      });
      if (route === 'input') expect(entries[0]).not.toHaveProperty('stepNumber');
      else expect(entries[0].stepNumber).toBe(1);
      if (route !== 'emit') expect(entries[0]).toMatchObject({ key: 'answer', rawValue: 42 });
    });
  });
});

describe('formatter result contract: mixed events', () => {
  it('retains order, sparse step numbers and raw references with selective formatting', () => {
    const raw = { answer: 42 };
    const contexts: OpRenderContext[] = [];
    const recorder = new CombinedNarrativeRecorder({
      renderer: {
        renderOp(ctx) {
          contexts.push(ctx);
          if (ctx.key === 'hidden') return null;
          if (ctx.operation === 'update') return '';
          return undefined;
        },
        renderEmit: () => 'Event line',
      },
    });
    capture(recorder, 'read', 'hidden', raw);
    capture(recorder, 'emit', 'event', raw);
    capture(recorder, 'set', 'visible', raw);
    capture(recorder, 'update', 'changed', raw);
    capture(recorder, 'delete', 'removed', raw);
    expect(recorder.getEntries()).toEqual([]);
    flush(recorder);

    expect(recorder.getEntries().map(({ type, text, stepNumber }) => ({ type, text, stepNumber }))).toEqual([
      { type: 'stage', text: 'Stage 1: The process began with Work.', stepNumber: undefined },
      { type: 'emit', text: 'Event line', stepNumber: 2 },
      { type: 'step', text: 'Step 3: Write visible = {answer}', stepNumber: 3 },
      { type: 'step', text: '', stepNumber: 4 },
      { type: 'step', text: 'Step 5: Delete removed', stepNumber: 5 },
    ]);
    expect(contexts.map(({ type, operation, stepNumber }) => ({ type, operation, stepNumber }))).toEqual([
      { type: 'read', operation: undefined, stepNumber: 1 },
      { type: 'write', operation: 'set', stepNumber: 3 },
      { type: 'write', operation: 'update', stepNumber: 4 },
      { type: 'write', operation: 'delete', stepNumber: 5 },
    ]);
    for (const ctx of contexts) expect(ctx.rawValue).toBe(raw);
    for (const entry of recorder.getEntries().filter((entry) => entry.type === 'step')) {
      expect(entry.rawValue).toBe(raw);
    }
    expect(recorder.getEntriesForStep('outer/work#7')).toEqual(recorder.getEntries());
    expect(recorder.getEntryRanges().get('outer/work#7')).toEqual({ firstIdx: 0, endIdx: 5 });
  });

  it('numbers mapped input callbacks before exclusions without adding step numbers to their entries', () => {
    const calls: OpRenderContext[] = [];
    const recorder = new CombinedNarrativeRecorder({
      renderer: {
        renderOp(ctx) {
          calls.push(ctx);
          return ctx.key === 'hidden' ? null : undefined;
        },
      },
    });
    recorder.onSubflowEntry({
      name: 'Child',
      subflowId: 'child',
      mappedInput: { hidden: 1, visible: 2, tail: 3 },
      traversalContext,
    });
    expect(calls.map((ctx) => [ctx.key, ctx.type, ctx.operation, ctx.stepNumber])).toEqual([
      ['hidden', 'write', 'set', 1],
      ['visible', 'write', 'set', 2],
      ['tail', 'write', 'set', 3],
    ]);
    const inputs = recorder.getEntries().filter((entry) => entry.type === 'step');
    expect(inputs.map((entry) => entry.text)).toEqual(['Input: visible = 2', 'Input: tail = 3']);
    for (const entry of inputs) expect(entry).not.toHaveProperty('stepNumber');
  });

  it.each(['read', 'set', 'update', 'delete'] as const)(
    'keeps the default %s template when the value formatter returns an empty summary',
    (route) => {
      const recorder = new CombinedNarrativeRecorder({
        formatValue: () => '',
        renderer: { renderOp: () => undefined },
      });
      capture(recorder, route, 'answer', 42);
      flush(recorder);
      const expected = {
        read: 'Step 1: Read answer',
        set: 'Step 1: Write answer = ',
        update: 'Step 1: Update answer = ',
        delete: 'Step 1: Delete answer',
      };
      expect(
        recorder
          .getEntries()
          .filter((entry) => entry.type === 'step')
          .map((entry) => entry.text),
      ).toEqual([expected[route]]);
    },
  );

  it('undefined callbacks preserve the complete default entries for generated operation sequences', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            route: fc.constantFrom<Route>('read', 'set', 'update', 'delete', 'emit'),
            key: fc.string({ minLength: 1, maxLength: 12 }),
            value: fc.oneof(fc.jsonValue(), fc.constant(undefined)),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        fc.boolean(),
        fc.boolean(),
        (operations, includeValues, includeStepNumbers) => {
          const options = { includeValues, includeStepNumbers, maxValueLength: 17 };
          const defaults = new CombinedNarrativeRecorder(options);
          const fallback = new CombinedNarrativeRecorder({
            ...options,
            renderer: { renderOp: () => undefined, renderEmit: () => undefined },
          });
          for (const recorder of [defaults, fallback]) {
            for (const op of operations) capture(recorder, op.route, op.key, op.value);
            flush(recorder);
            recorder.onSubflowEntry({
              name: 'Child',
              mappedInput: { input: operations[0].value },
              subflowId: 'child',
              traversalContext,
            });
          }
          expect(fallback.getEntries()).toEqual(defaults.getEntries());
        },
      ),
      { numRuns: 50, seed: 41927 },
    );
  });
});

describe('formatter result contract: executor integration', () => {
  it.each(['inline', 'deferred'] as const)('reads the explicitly attached %s narrative view', async (delivery) => {
    const inner = flowChart<object>(
      'Inner',
      (scope) => {
        scope.$emit('inner.event', scope.$getArgs<{ provided: string }>().provided);
      },
      'inner',
    ).build();
    const chart = flowChart<{
      visible: number;
      hidden: string;
      custom: string;
      items: number[];
      removed?: boolean;
      observed?: number;
    }>(
      'Seed',
      (scope) => {
        scope.visible = 7;
        scope.hidden = 'private';
        scope.custom = 'ready';
        scope.items = [1, 2];
        scope.removed = true;
      },
      'seed',
    )
      .addFunction(
        'Edit',
        (scope) => {
          scope.observed = scope.visible;
          scope.$update('items', [3]);
          scope.$delete('removed');
          scope.$emit('edit.event', 'done');
        },
        'edit',
      )
      .addSubFlowChartNext('child', inner, 'Child', { inputMapper: () => ({ provided: 'payload' }) })
      .build();
    const trace = narrative({
      renderer: {
        renderOp(ctx) {
          if (ctx.key === 'hidden') return null;
          return ctx.key === 'custom' ? 'Domain says ready' : undefined;
        },
        renderEmit: () => undefined,
      },
    });
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(trace, { delivery });
    await executor.run();

    const entries = trace.getEntries();
    expect(
      entries.filter((entry) => entry.stageId === 'seed' && entry.type === 'step').map((entry) => entry.text),
    ).toEqual([
      'Step 1: Write visible = 7',
      'Domain says ready',
      'Step 4: Write items = (2 items)',
      'Step 5: Write removed = true',
    ]);
    expect(
      entries.filter((entry) => entry.stageId === 'edit' && entry.type !== 'stage').map((entry) => entry.text),
    ).toEqual([
      'Step 1: Read visible = 7',
      'Step 2: Write observed = 7',
      'Step 3: Update items = (1 item)',
      'Step 4: Delete removed',
      '[emit] edit.event: "done"',
    ]);
    expect(entries.find((entry) => entry.key === 'provided')?.text).toBe('Input: provided = "payload"');
    expect(entries.filter((entry) => entry.type === 'emit').map((entry) => entry.text)).toEqual([
      '[emit] edit.event: "done"',
      '[emit] inner.event: "payload"',
    ]);
    expect(entries.some((entry) => entry.key === 'hidden')).toBe(false);
    expect(executor.getSnapshot().sharedState).toMatchObject({ visible: 7, observed: 7, items: [1, 2, 3] });
    // Default full commits represent deletion as an own key holding undefined.
    expect(executor.getSnapshot().sharedState.removed).toBeUndefined();
    const snapshot = executor.getSnapshot().recorders?.find((entry) => entry.id === trace.id);
    expect(snapshot?.data).toEqual(entries.map(({ rawValue: _rawValue, ...entry }) => entry));
  });

  it.each(['renderOp', 'renderEmit'] as const)(
    'isolates a thrown %s callback from state and other recorders',
    async (hook) => {
      const failed = vi.fn(() => {
        throw new Error('formatter failed');
      });
      const broken = narrative({ renderer: { [hook]: failed } });
      const healthy = narrative();
      const chart = flowChart<{ count: number }>(
        'First',
        (scope) => {
          scope.count = 1;
          scope.$emit('first', 1);
        },
        'first',
      )
        .addFunction(
          'Second',
          (scope) => {
            scope.count = scope.count + 1;
          },
          'second',
        )
        .build();
      const executor = new FlowChartExecutor(chart);
      executor.attachCombinedRecorder(broken);
      executor.attachCombinedRecorder(healthy);
      await expect(executor.run()).resolves.not.toThrow();
      expect(failed).toHaveBeenCalled();
      expect(executor.getSnapshot().sharedState.count).toBe(2);
      expect(healthy.getEntries().map((entry) => entry.type)).toEqual([
        'stage',
        'step',
        'emit',
        'stage',
        'step',
        'step',
      ]);
      expect(healthy.getEntries().at(-1)?.text).toBe('Step 2: Write count = 2');
    },
  );
});
