import { memorySink } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import type { FlowSelectedEvent, SelectionResult } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor, select } from '../../../../src/index.js';
import type { TypedScope } from '../../../../src/lib/reactive/types.js';
import { controlDepRecorder, readStoredCapture } from '../../../../src/trace.js';
import { evidenceSurfaces, surfacesHolding } from '../helpers/evidenceSurfaces.js';

interface State {
  amount: number;
  continued?: boolean;
}

function chartFor(selection: (scope: TypedScope<State>) => SelectionResult | string[], branch: () => void = () => {}) {
  return flowChart<State>(
    'Seed',
    (scope) => {
      scope.amount = 4;
    },
    'seed',
  )
    .addSelectorFunction('Choose', selection, 'choose')
    .addFunctionBranch('large', 'Large', branch)
    .end()
    .addFunction(
      'Continue',
      (scope) => {
        scope.continued = true;
      },
      'continue',
    )
    .build();
}

const noMatch = (scope: TypedScope<State>) =>
  select(scope, [{ when: { amount: { gt: 10 } }, then: 'large', label: 'Large amount' }]);

describe('a selector that selected no branches', () => {
  it('retains evaluated conditions and the empty selection without governing the next stage', async () => {
    let branches = 0;
    const executor = new FlowChartExecutor(chartFor(noMatch, () => branches++));
    const control = controlDepRecorder();
    const events: FlowSelectedEvent[] = [];
    executor.enableNarrative();
    executor.attachFlowRecorder(control);
    executor.attachFlowRecorder({ id: 'selection-event', onSelected: (event) => events.push(event) });

    await executor.run();

    expect(branches).toBe(0);
    expect(executor.getSnapshot().sharedState.continued).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].selected).toEqual([]);
    expect(events[0].evidence).toEqual({
      selected: [],
      rules: [
        {
          type: 'filter',
          ruleIndex: 0,
          branch: 'large',
          matched: false,
          label: 'Large amount',
          conditions: [{ key: 'amount', op: 'gt', threshold: 10, actualSummary: '4', result: false, redacted: false }],
        },
      ],
    });
    expect(control.getDecisions()).toEqual([
      { deciderRuntimeStageId: 'choose#1', chosen: [], evidence: events[0].evidence },
    ]);
    expect(control.toSnapshot().data.controlDeps).toEqual({});
    expect(control.lookup('continue#2')).toBeUndefined();
    expect(executor.getNarrativeEntries().find((entry) => entry.type === 'selector')?.text).toBe(
      '[Selected]: 0 of 1 paths selected; no rules matched: large "Large amount" (amount 4 gt 10 ✗).',
    );
  });

  it('does not repeat a function predicate or its scope reads to explain a non-match', async () => {
    let predicates = 0;
    const reads: string[] = [];
    const executor = new FlowChartExecutor(
      chartFor((scope) =>
        select(scope, [
          {
            when: (state) => {
              predicates++;
              return state.amount > 10;
            },
            then: 'large',
          },
        ]),
      ),
    );
    const events: FlowSelectedEvent[] = [];
    executor.enableNarrative();
    executor.attachScopeRecorder({
      id: 'count-reads',
      onRead: (event) => {
        if (event.key) reads.push(event.key);
      },
    });
    executor.attachFlowRecorder({ id: 'selection-event', onSelected: (event) => events.push(event) });

    await executor.run();

    expect(predicates).toBe(1);
    expect(reads).toEqual(['amount']);
    expect(events[0].evidence?.rules).toEqual([
      {
        type: 'function',
        ruleIndex: 0,
        branch: 'large',
        matched: false,
        label: undefined,
        inputs: [{ key: 'amount', valueSummary: '4', redacted: false }],
      },
    ]);
    expect(executor.getNarrativeEntries().find((entry) => entry.type === 'selector')?.text).toBe(
      '[Selected]: 0 of 1 paths selected; no rules matched: large (amount=4).',
    );
  });

  it('preserves the empty decision through acknowledged history and JSON reopening', async () => {
    const sink = memorySink();
    const executor = new FlowChartExecutor(chartFor(noMatch), {
      captureCoverage: true,
      sink: {
        adapter: sink,
        // Synthetic host assertion; a memory sink does not claim durability itself.
        capture: { acknowledge: async (target) => ({ ...target, durability: 'durable' }) },
      },
    });
    const control = controlDepRecorder({ captureCoverage: true });
    executor.attachFlowRecorder(control);
    await executor.run();

    const reopened = await readStoredCapture(JSON.parse(JSON.stringify(sink.entries)), {
      runId: executor.getSnapshot().runId,
    });

    expect(reopened.status).toBe('acknowledged');
    if (reopened.status !== 'acknowledged') throw new Error('history was not acknowledged');
    const saved = reopened.history.recorders?.find((row) => row.id === control.id);
    expect(saved?.data).toEqual(JSON.parse(JSON.stringify(control.toSnapshot().data)));
    expect(saved?.data).toMatchObject({
      decisions: [{ deciderRuntimeStageId: 'choose#1', chosen: [], evidence: { selected: [] } }],
      controlDeps: {},
    });
  });

  it('keeps failed filter evidence redacted on live, deferred, narrative and real-file surfaces', async () => {
    const secret = 987654321;
    const chart = flowChart<{ secret: number }>(
      'Seed',
      (scope) => {
        scope.secret = secret;
      },
      'seed',
    )
      .addSelectorFunction(
        'Choose',
        (scope) => select(scope, [{ when: { secret: { gt: secret + 1 } }, then: 'large' }]),
        'choose',
      )
      .addFunctionBranch('large', 'Large', () => {})
      .end()
      .build();

    const surfaces = await evidenceSurfaces(chart, { keys: ['secret'] });

    expect(surfaces.storedStatus).toBe('acknowledged');
    expect(surfaces.evidence).toHaveLength(1);
    expect(surfaces.deferred).toEqual(surfaces.evidence);
    expect(surfaces.evidence[0].rules[0].conditions[0]).toMatchObject({
      actualSummary: '[REDACTED]',
      threshold: '[REDACTED]',
      thresholdRedacted: true,
      result: false,
      redacted: true,
    });
    expect(surfaces.recorders).toContain('"chosen":[]');
    expect(surfaces.capture).toContain('"chosen":[]');
    expect(surfaces.narrative).toContain('no rules matched');
    expect(surfacesHolding(surfaces, String(secret))).toEqual([]);
    expect(surfacesHolding(surfaces, String(secret + 1))).toEqual([]);
  });

  it('records an ordinary empty array without inventing rules or changing its narrative', async () => {
    const executor = new FlowChartExecutor(chartFor(() => []));
    const control = controlDepRecorder();
    executor.attachFlowRecorder(control);
    executor.enableNarrative();

    await executor.run();

    expect(control.getDecisions()).toEqual([{ deciderRuntimeStageId: 'choose#1', chosen: [] }]);
    expect(control.toSnapshot().data.controlDeps).toEqual({});
    expect(executor.getNarrativeEntries().find((entry) => entry.type === 'selector')?.text).toBe(
      '[Selected]: 0 of 1 paths selected for execution: .',
    );
  });

  it('distinguishes an evaluated empty rule list from missing structured evidence', async () => {
    const executor = new FlowChartExecutor(chartFor((scope) => select(scope, [])));
    const control = controlDepRecorder();
    executor.attachFlowRecorder(control);
    executor.enableNarrative();

    await executor.run();

    expect(control.getDecisions()).toEqual([
      { deciderRuntimeStageId: 'choose#1', chosen: [], evidence: { rules: [], selected: [] } },
    ]);
    expect(control.toSnapshot().data.controlDeps).toEqual({});
    expect(executor.getNarrativeEntries().find((entry) => entry.type === 'selector')?.text).toBe(
      '[Selected]: 0 of 1 paths selected; no rules matched.',
    );
  });

  it('does not execute object-threshold code while narrating the failed comparisons', async () => {
    let comparisons = 0;
    let serializations = 0;
    let getters = 0;
    const withJSON = {
      valueOf() {
        comparisons++;
        return 10;
      },
      toJSON() {
        serializations++;
        return 10;
      },
    };
    const withGetter = {
      valueOf() {
        comparisons++;
        return 10;
      },
      get detail() {
        getters++;
        return 'not needed for comparison';
      },
    };
    const chart = flowChart<Record<string, unknown>>(
      'Seed',
      (scope) => {
        scope.amount = 4;
      },
      'seed',
    )
      .addSelectorFunction(
        'Choose',
        (scope) =>
          select(scope, [
            { when: { amount: { gt: withJSON } }, then: 'large' },
            { when: { amount: { gt: withGetter } }, then: 'large' },
          ]),
        'choose',
      )
      .addFunctionBranch('large', 'Large', () => {})
      .end()
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();

    await executor.run();

    // An object is in no order with a number, so the comparison itself runs none of the object's code either.
    expect(comparisons).toBe(0);
    expect(serializations).toBe(0);
    expect(getters).toBe(0);
    expect(executor.getNarrativeEntries().find((entry) => entry.type === 'selector')?.text).toBe(
      '[Selected]: 0 of 1 paths selected; no rules matched: large (amount 4 gt [recorded threshold] ✗); large (amount 4 gt [recorded threshold] ✗).',
    );
  });

  it('bounds string-threshold previews in the newly retained empty-selection narrative', async () => {
    const threshold = 'z'.repeat(1_000);
    const chart = flowChart<{ amount: string }>(
      'Seed',
      (scope) => {
        scope.amount = 'a';
      },
      'seed',
    )
      .addSelectorFunction(
        'Choose',
        (scope) => select(scope, [{ when: { amount: { gt: threshold } }, then: 'large' }]),
        'choose',
      )
      .addFunctionBranch('large', 'Large', () => {})
      .end()
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();

    await executor.run();

    const text = executor.getNarrativeEntries().find((entry) => entry.type === 'selector')?.text;
    expect(text).toContain(`"${'z'.repeat(77)}..."`);
    expect(text).not.toContain('z'.repeat(81));
  });

  it('does not leave an empty pending decision to capture a later run or convergence step', async () => {
    let selected = true;
    let branches = 0;
    const executor = new FlowChartExecutor(
      chartFor(
        () => (selected ? ['large'] : []),
        () => branches++,
      ),
    );
    const control = controlDepRecorder();
    executor.attachFlowRecorder(control);

    await executor.run();
    expect(control.lookup('large#2')).toEqual({ deciderId: 'choose#1' });
    selected = false;
    await executor.run();
    expect(control.getDecisions()).toEqual([{ deciderRuntimeStageId: 'choose#1', chosen: [] }]);
    expect(control.toSnapshot().data.controlDeps).toEqual({});
    expect(control.lookup('continue#2')).toBeUndefined();
    selected = true;
    await executor.run();
    expect(control.getDecisions()).toEqual([{ deciderRuntimeStageId: 'choose#1', chosen: ['Large'] }]);
    expect(control.lookup('large#2')).toEqual({ deciderId: 'choose#1' });
    expect(control.lookup('continue#3')).toBeUndefined();
    expect(branches).toBe(2);
  });
});
