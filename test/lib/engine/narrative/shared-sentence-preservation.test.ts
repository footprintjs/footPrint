import { describe, expect, it, vi } from 'vitest';

import { CombinedNarrativeRecorder } from '../../../../src/lib/engine/narrative/CombinedNarrativeRecorder.js';
import { NarrativeFlowRecorder } from '../../../../src/lib/engine/narrative/NarrativeFlowRecorder.js';
import type { NarrativeFormatter, StageRenderContext } from '../../../../src/lib/engine/narrative/narrativeTypes.js';
import { RLENarrativeFlowRecorder } from '../../../../src/lib/engine/narrative/recorders/RLENarrativeFlowRecorder.js';
import { SeparateNarrativeFlowRecorder } from '../../../../src/lib/engine/narrative/recorders/SeparateNarrativeFlowRecorder.js';
import { WindowedNarrativeFlowRecorder } from '../../../../src/lib/engine/narrative/recorders/WindowedNarrativeFlowRecorder.js';
import type {
  FlowErrorEvent,
  FlowLoopEvent,
  FlowStageEvent,
  TraversalContext,
} from '../../../../src/lib/engine/narrative/types.js';

function context(index: number, stageId = 'work', subflowId?: string): TraversalContext {
  return {
    runId: 'preservation',
    stageId,
    runtimeStageId: `${stageId}#${index}`,
    stageName: 'Work',
    depth: subflowId ? 1 : 0,
    subflowId,
  };
}

function stage(traversalContext: TraversalContext, description?: string): FlowStageEvent {
  return { stageName: 'Work', stageType: 'linear', traversalContext, description };
}

describe('shared sentence preservation: Windowed keeps its deferred policy', () => {
  it('reads the retained loop event on each export, after ordinary sentences', () => {
    const recorder = new WindowedNarrativeFlowRecorder(1, 1);
    const event: FlowLoopEvent = { target: 'Before', iteration: 1, description: 'original description' };
    recorder.onLoop(event);
    recorder.onStageExecuted(stage(context(0)));

    event.description = 'changed after capture';
    event.iteration = 7;
    expect(recorder.getSentences()).toEqual(['Next, it moved on to Work.', 'On pass 7: changed after capture again.']);

    event.description = '';
    event.target = 'After';
    expect(recorder.getSentences()).toEqual(['Next, it moved on to Work.', 'On pass 7 through After.']);
    recorder.getSentences().push('outside mutation');
    expect(recorder.getSentences()).toEqual(['Next, it moved on to Work.', 'On pass 7 through After.']);
  });

  it('groups loops by first-seen target and appends each window after all ordinary sentences', () => {
    const recorder = new WindowedNarrativeFlowRecorder(1, 1);
    recorder.onLoop({ target: 'B', iteration: 1 });
    recorder.onStageExecuted(stage(context(0), 'does work'));
    recorder.onLoop({ target: 'A', iteration: 1, description: 'tries A' });
    recorder.onLoop({ target: 'B', iteration: 2 });
    recorder.onBreak({ stageName: 'End' });
    recorder.onLoop({ target: 'B', iteration: 3 });
    expect(recorder.getSentences()).toEqual([
      'Next step: does work.',
      'Execution stopped at End.',
      'On pass 1 through B.',
      '... (1 iterations omitted)',
      'On pass 3 through B.',
      'On pass 1: tries A again.',
    ]);
    expect(recorder.getSuppressedCount()).toBe(1);
  });

  it.each([
    { head: 0, tail: 0, count: 1, expected: ['... (1 iterations omitted)'], suppressed: 1 },
    { head: 0, tail: 1, count: 2, expected: ['... (1 iterations omitted)', 'On pass 2 through A.'], suppressed: 1 },
    { head: 1, tail: 0, count: 2, expected: ['On pass 1 through A.', '... (1 iterations omitted)'], suppressed: 1 },
    { head: 1, tail: 1, count: 2, expected: ['On pass 1 through A.', 'On pass 2 through A.'], suppressed: 0 },
  ])('preserves a $head/$tail window over $count events', ({ head, tail, count, expected, suppressed }) => {
    const recorder = new WindowedNarrativeFlowRecorder(head, tail);
    for (let iteration = 1; iteration <= count; iteration++) recorder.onLoop({ target: 'A', iteration });
    expect(recorder.getSentences()).toEqual(expected);
    expect(recorder.getSuppressedCount()).toBe(suppressed);
    recorder.clear();
    expect(recorder.getSentences()).toEqual([]);
    expect(recorder.getSuppressedCount()).toBe(0);
  });
});

describe('shared sentence preservation: RLE keeps its grouping policy', () => {
  it.each([
    { start: 1, end: 4, expected: 'Looped through A 4 times (passes 1–4).' },
    { start: 3, end: 3, expected: 'On pass 3: first description again.' },
    { start: 5, end: 3, expected: 'Looped through A -1 times (passes 5–3).' },
  ])('uses iteration endpoints $start–$end, not the number of events', ({ start, end, expected }) => {
    const recorder = new RLENarrativeFlowRecorder();
    recorder.onLoop({ target: 'A', iteration: start, description: 'first description' });
    recorder.onLoop({ target: 'A', iteration: end, description: 'later description' });
    expect(recorder.getSentences()).toEqual([expected]);
  });

  it('captures the first description and keeps a run open across non-loop events and reads', () => {
    const recorder = new RLENarrativeFlowRecorder();
    const event = { target: 'A', iteration: 2, description: 'captured description' };
    recorder.onLoop(event);
    event.description = 'mutated description';
    event.iteration = 99;
    expect(recorder.getSentences()).toEqual(['On pass 2: captured description again.']);
    recorder.onStageExecuted(stage(context(0)));
    recorder.onLoop({ target: 'A', iteration: 4, description: 'new description' });
    expect(recorder.getSentences()).toEqual(['Next, it moved on to Work.', 'Looped through A 3 times (passes 2–4).']);
  });

  it('starts a new group only when the target changes, then clears completed and pending groups', () => {
    const recorder = new RLENarrativeFlowRecorder();
    recorder.onLoop({ target: 'A', iteration: 1 });
    recorder.onLoop({ target: 'B', iteration: 7, description: 'tries B' });
    recorder.onLoop({ target: 'A', iteration: 4 });
    expect(recorder.getSentences()).toEqual([
      'On pass 1 through A.',
      'On pass 7: tries B again.',
      'On pass 4 through A.',
    ]);
    recorder.clear();
    expect(recorder.getSentences()).toEqual([]);
    recorder.onLoop({ target: 'A', iteration: 1 });
    expect(recorder.getSentences()).toEqual(['On pass 1 through A.']);
  });

  it('keeps Separate eager, with its own loop channel and defensive count map', () => {
    const recorder = new SeparateNarrativeFlowRecorder();
    const event = { target: 'A', iteration: 1, description: 'original' };
    recorder.onLoop(event);
    event.description = 'changed';
    recorder.onStageExecuted(stage(context(0)));
    expect(recorder.getSentences()).toEqual(['Next, it moved on to Work.']);
    expect(recorder.getLoopSentences()).toEqual(['On pass 1: original again.']);
    recorder.getLoopCounts().set('A', 99);
    expect([...recorder.getLoopCounts()]).toEqual([['A', 1]]);
    recorder.clear();
    expect(recorder.getSentences()).toEqual([]);
    expect(recorder.getLoopSentences()).toEqual([]);
    expect([...recorder.getLoopCounts()]).toEqual([]);
  });
});

describe('shared sentence preservation: recorder state and metadata stay local', () => {
  it.each(['decider', 'fork', 'selector', 'subflow-mount'] as const)(
    'does not turn a %s completion into a linear stage sentence',
    (stageType) => {
      const combined = new CombinedNarrativeRecorder();
      const flow = new NarrativeFlowRecorder();
      const event = { ...stage(context(0), 'must stay silent'), stageType };
      combined.onStageExecuted(event);
      flow.onStageExecuted(event);
      combined.onNext();
      flow.onNext({ from: 'Work', to: 'Unexecuted', description: 'also silent' });
      expect(combined.getEntries()).toEqual([]);
      expect(flow.getSentences()).toEqual([]);
    },
  );

  it('keeps first, next, and revisit wording under independent subflow counters', () => {
    const recorder = new CombinedNarrativeRecorder();
    recorder.onStageExecuted(stage(context(0), 'initializes'));
    recorder.onStageExecuted(stage(context(1, 'other'), 'processes'));
    recorder.onStageExecuted(stage(context(2), 'initializes'));
    recorder.onStageExecuted(stage(context(3, 'sf/work', 'sf'), 'subflow work'));
    recorder.onStageExecuted(stage(context(4, 'sf/work', 'sf'), 'subflow work'));
    expect(recorder.getEntries().map((entry) => entry.text)).toEqual([
      'Stage 1: The process began: initializes.',
      'Stage 2: Next step: processes.',
      'Stage 3: Looped back: initializes (pass 1).',
      'Stage 1: The process began: subflow work.',
      'Stage 2: Looped back: subflow work (pass 1).',
    ]);
  });

  it('resets a mounted subflow counter while preserving visit context and the formatter receiver', () => {
    const seen: StageRenderContext[] = [];
    const renderer: NarrativeFormatter = {
      renderStage(ctx) {
        expect(this).toBe(renderer);
        seen.push(ctx);
        return `${ctx.stageNumber}:${ctx.isFirst}:${ctx.loopIteration ?? 0}`;
      },
    };
    const recorder = new CombinedNarrativeRecorder({ renderer });
    recorder.onStageExecuted(stage(context(0, 'sf/work', 'sf')));
    recorder.onStageExecuted(stage(context(1, 'sf/work', 'sf')));
    recorder.onSubflowEntry({ name: 'Child', subflowId: 'sf', traversalContext: context(2, 'mount') });
    recorder.onStageExecuted(stage(context(3, 'sf/work', 'sf')));
    expect(seen.map(({ stageNumber, isFirst, loopIteration }) => ({ stageNumber, isFirst, loopIteration }))).toEqual([
      { stageNumber: 1, isFirst: true, loopIteration: undefined },
      { stageNumber: 2, isFirst: false, loopIteration: 1 },
      { stageNumber: 1, isFirst: true, loopIteration: 2 },
    ]);
    expect(recorder.getEntries().map((entry) => entry.text)).toEqual([
      '1:true:0',
      '2:false:1',
      'Entering the Child subflow.',
      '1:true:2',
    ]);
  });

  it('preserves prefix, order, index metadata and raw-value omission at snapshot export', () => {
    const traversalContext = context(5, 'sf/work', 'sf');
    const rawValue = { answer: 42 };
    const recorder = new CombinedNarrativeRecorder();
    recorder.onRead({
      stageName: 'Work',
      stageId: 'sf/work',
      runtimeStageId: 'sf/work#5',
      pipelineId: 'preservation',
      timestamp: 1,
      key: 'value',
      value: rawValue,
    });
    recorder.onDecision({ decider: 'Work', chosen: 'Accept', rationale: 'good score', traversalContext });
    recorder.onFork({ parent: 'Work', children: ['A', 'B'], traversalContext });
    const entries = recorder.getEntries();
    expect(entries.map((entry) => entry.text)).toEqual([
      'Stage 1: The process began with Work.',
      'Step 1: Read value = {answer}',
      '[Condition]: A decision was made: good score, so the path taken was Accept.',
      '[Parallel]: Forking into 2 parallel paths: A, B.',
    ]);
    expect(
      entries.map((entry) => [entry.type, entry.depth, entry.stageId, entry.runtimeStageId, entry.subflowId]),
    ).toEqual([
      ['stage', 0, 'sf/work', 'sf/work#5', 'sf'],
      ['step', 1, 'sf/work', 'sf/work#5', 'sf'],
      ['condition', 1, 'sf/work', 'sf/work#5', 'sf'],
      ['fork', 0, 'sf/work', 'sf/work#5', 'sf'],
    ]);
    expect(entries[1].rawValue).toBe(rawValue);
    expect(recorder.getEntriesForStep('sf/work#5')).toEqual(entries);
    expect([...recorder.getEntryRanges()]).toEqual([['sf/work#5', { firstIdx: 0, endIdx: 4 }]]);
    expect(recorder.getEntriesBySubflow()).toEqual({ '': [], sf: entries });
    expect(recorder.toSnapshot().data).toEqual(entries.map(({ rawValue: _rawValue, ...entry }) => entry));
    expect(structuredClone(recorder.toSnapshot())).toEqual(recorder.toSnapshot());
  });

  it('clear drops pending operations and restarts stage/visit counters without dropping callbacks', () => {
    const renderStage = vi.fn((ctx: StageRenderContext) => `${ctx.stageNumber}:${ctx.loopIteration ?? 0}`);
    const recorder = new CombinedNarrativeRecorder({ renderer: { renderStage } });
    const eventContext = context(0);
    recorder.onStageExecuted(stage(eventContext));
    recorder.onRead({
      stageName: 'Work',
      stageId: 'work',
      runtimeStageId: 'work#0',
      pipelineId: 'preservation',
      timestamp: 1,
      key: 'discarded',
      value: 42,
    });
    recorder.clear();
    expect(recorder.getEntries()).toEqual([]);
    expect([...recorder.getEntryRanges()]).toEqual([]);
    expect(recorder.stepCount).toBe(0);
    recorder.onStageExecuted(stage(eventContext));
    expect(recorder.getEntries().map((entry) => entry.text)).toEqual(['1:0']);
    expect(renderStage).toHaveBeenCalledTimes(2);
    expect(recorder.getEntries().some((entry) => entry.key === 'discarded')).toBe(false);
  });
});

describe('shared sentence preservation: error and lifecycle guards', () => {
  it('preserves the distinct empty-detail policies for a sparse validation issue array', () => {
    const issues: FlowErrorEvent['structuredError']['issues'] = new Array(1);
    const event: FlowErrorEvent = {
      stageName: 'Validate',
      message: 'invalid',
      structuredError: { message: 'invalid', raw: undefined, issues },
    };
    const combined = new CombinedNarrativeRecorder();
    const flow = new NarrativeFlowRecorder();
    combined.onError(event);
    flow.onError(event);
    expect(combined.getEntries().map((entry) => entry.text)).toEqual([
      '[Error]: An error occurred at Validate: invalid.',
    ]);
    expect(flow.getSentences()).toEqual(['An error occurred at Validate: invalid. Validation issues: .']);
  });

  it('coerces flow error text before a malformed structured error throws', () => {
    const calls: string[] = [];
    // JavaScript can bypass the string/StructuredErrorInfo types. Preserve the
    // existing evaluation order as well as the throw and absence of a sentence.
    const event = {
      stageName: {
        toString: () => {
          calls.push('stageName');
          return 'Work';
        },
      },
      message: {
        toString: () => {
          calls.push('message');
          return 'invalid';
        },
      },
      get structuredError() {
        calls.push('structuredError');
        return undefined;
      },
    } as unknown as FlowErrorEvent;
    const flow = new NarrativeFlowRecorder();
    expect(() => flow.onError(event)).toThrow(TypeError);
    expect(calls).toEqual(['stageName', 'message', 'structuredError']);
    expect(flow.getSentences()).toEqual([]);
  });

  it('retains the two recorders’ distinct malformed-error behavior', () => {
    const combined = new CombinedNarrativeRecorder();
    const flow = new NarrativeFlowRecorder();
    // Fabricated JavaScript input: the structured error is required by the TS interface.
    const event = { stageName: 'Work', message: 'missing details' } as FlowErrorEvent;
    combined.onError(event);
    expect(combined.getEntries().map((entry) => entry.text)).toEqual([
      '[Error]: An error occurred at Work: missing details.',
    ]);
    expect(() => flow.onError(event)).toThrow(TypeError);
    expect(flow.getSentences()).toEqual([]);
  });

  it('preserves validation path formatting and Combined’s error prefix', () => {
    const event: FlowErrorEvent = {
      stageName: 'Validate',
      message: 'invalid',
      structuredError: {
        message: 'invalid',
        raw: undefined,
        issues: [
          { path: [], message: 'root problem' },
          { path: ['orders', 2, 'price'], message: 'too small' },
        ],
      },
    };
    const combined = new CombinedNarrativeRecorder();
    const flow = new NarrativeFlowRecorder();
    combined.onError(event);
    flow.onError(event);
    const sentence =
      'An error occurred at Validate: invalid. Validation issues: (root): root problem; orders.2.price: too small.';
    expect(flow.getSentences()).toEqual([sentence]);
    expect(combined.getEntries().map((entry) => entry.text)).toEqual([`[Error]: ${sentence}`]);
  });

  it('ignores scope lifecycle events in Combined and preserves flow pause/resume suffixes', () => {
    const recorder = new CombinedNarrativeRecorder();
    const scopeContext = {
      stageName: 'Work',
      stageId: 'work',
      runtimeStageId: 'work#0',
      pipelineId: 'preservation',
      timestamp: 1,
    };
    recorder.onPause(scopeContext);
    recorder.onResume({ ...scopeContext, hasInput: true });
    expect(recorder.getEntries()).toEqual([]);
    recorder.onPause({ stageName: 'Work', stageId: 'work', subflowPath: [] });
    recorder.onResume({ stageName: 'Work', stageId: 'work', hasInput: false });
    recorder.onResume({ stageName: 'Work', stageId: 'work', hasInput: true });
    expect(recorder.getEntries().map((entry) => entry.text)).toEqual([
      'Execution paused at Work.',
      'Execution resumed at Work.',
      'Execution resumed at Work with input.',
    ]);
  });
});
