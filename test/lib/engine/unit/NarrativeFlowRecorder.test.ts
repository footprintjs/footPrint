import { ControlFlowNarrativeGenerator } from '../../../../src/lib/engine/narrative/ControlFlowNarrativeGenerator';
import { NarrativeFlowRecorder } from '../../../../src/lib/engine/narrative/NarrativeFlowRecorder';

/**
 * NarrativeFlowRecorder must produce IDENTICAL output to ControlFlowNarrativeGenerator.
 * This ensures the refactor from singleton to FlowRecorder is non-breaking.
 */
describe('NarrativeFlowRecorder', () => {
  let recorder: NarrativeFlowRecorder;

  beforeEach(() => {
    recorder = new NarrativeFlowRecorder();
  });

  it('has default id "narrative"', () => {
    expect(recorder.id).toBe('narrative');
  });

  it('accepts custom id', () => {
    const r = new NarrativeFlowRecorder('custom');
    expect(r.id).toBe('custom');
  });

  it('starts with empty sentences', () => {
    expect(recorder.getSentences()).toEqual([]);
  });

  // ── Parity with ControlFlowNarrativeGenerator ─────────────────────────

  describe('output parity with ControlFlowNarrativeGenerator', () => {
    let legacy: ControlFlowNarrativeGenerator;

    beforeEach(() => {
      legacy = new ControlFlowNarrativeGenerator();
    });

    it('onStageExecuted with description', () => {
      legacy.onStageExecuted('Fetch', 'Retrieves data');
      recorder.onStageExecuted({ stageName: 'Fetch', description: 'Retrieves data' });
      expect(recorder.getSentences()).toEqual(legacy.getSentences());
    });

    it('onStageExecuted without description', () => {
      legacy.onStageExecuted('Fetch');
      recorder.onStageExecuted({ stageName: 'Fetch' });
      expect(recorder.getSentences()).toEqual(legacy.getSentences());
    });

    it('onStageExecuted only fires for first stage', () => {
      legacy.onStageExecuted('A');
      legacy.onStageExecuted('B');
      recorder.onStageExecuted({ stageName: 'A' });
      recorder.onStageExecuted({ stageName: 'B' });
      expect(recorder.getSentences()).toEqual(legacy.getSentences());
      expect(recorder.getSentences()).toHaveLength(1);
    });

    it('onNext with description', () => {
      legacy.onNext('A', 'B', 'Fetches external data');
      recorder.onNext({ from: 'A', to: 'B', description: 'Fetches external data' });
      expect(recorder.getSentences()).toEqual(legacy.getSentences());
    });

    it('onNext without description', () => {
      legacy.onNext('A', 'B');
      recorder.onNext({ from: 'A', to: 'B' });
      expect(recorder.getSentences()).toEqual(legacy.getSentences());
    });

    it('onDecision with description and rationale', () => {
      legacy.onDecision('check', 'Approve', 'age is 21', 'checked eligibility');
      recorder.onDecision({
        decider: 'check',
        chosen: 'Approve',
        rationale: 'age is 21',
        description: 'checked eligibility',
      });
      expect(recorder.getSentences()).toEqual(legacy.getSentences());
    });

    it('onDecision with description only', () => {
      legacy.onDecision('check', 'Approve', undefined, 'checked eligibility');
      recorder.onDecision({ decider: 'check', chosen: 'Approve', description: 'checked eligibility' });
      expect(recorder.getSentences()).toEqual(legacy.getSentences());
    });

    it('onDecision with rationale only', () => {
      legacy.onDecision('check', 'Approve', 'age >= 18');
      recorder.onDecision({ decider: 'check', chosen: 'Approve', rationale: 'age >= 18' });
      expect(recorder.getSentences()).toEqual(legacy.getSentences());
    });

    it('onDecision with neither', () => {
      legacy.onDecision('check', 'Approve');
      recorder.onDecision({ decider: 'check', chosen: 'Approve' });
      expect(recorder.getSentences()).toEqual(legacy.getSentences());
    });

    it('onFork', () => {
      legacy.onFork('dispatch', ['taskA', 'taskB', 'taskC']);
      recorder.onFork({ parent: 'dispatch', children: ['taskA', 'taskB', 'taskC'] });
      expect(recorder.getSentences()).toEqual(legacy.getSentences());
    });

    it('onSelected', () => {
      legacy.onSelected('selector', ['taskA', 'taskC'], 3);
      recorder.onSelected({ parent: 'selector', selected: ['taskA', 'taskC'], total: 3 });
      expect(recorder.getSentences()).toEqual(legacy.getSentences());
    });

    it('onSubflowEntry and onSubflowExit', () => {
      legacy.onSubflowEntry('LLM Core');
      legacy.onSubflowExit('LLM Core');
      recorder.onSubflowEntry({ name: 'LLM Core' });
      recorder.onSubflowExit({ name: 'LLM Core' });
      expect(recorder.getSentences()).toEqual(legacy.getSentences());
    });

    it('onLoop without description', () => {
      legacy.onLoop('Ask LLM', 2);
      recorder.onLoop({ target: 'Ask LLM', iteration: 2 });
      expect(recorder.getSentences()).toEqual(legacy.getSentences());
    });

    it('onLoop with description', () => {
      legacy.onLoop('Ask LLM', 3, 'retries the LLM call');
      recorder.onLoop({ target: 'Ask LLM', iteration: 3, description: 'retries the LLM call' });
      expect(recorder.getSentences()).toEqual(legacy.getSentences());
    });

    it('onBreak', () => {
      legacy.onBreak('Validate');
      recorder.onBreak({ stageName: 'Validate' });
      expect(recorder.getSentences()).toEqual(legacy.getSentences());
    });

    it('onError', () => {
      legacy.onError('Process', 'timeout');
      recorder.onError({ stageName: 'Process', message: 'timeout' });
      expect(recorder.getSentences()).toEqual(legacy.getSentences());
    });

    it('full flow sequence matches', () => {
      legacy.onStageExecuted('Init');
      legacy.onNext('Init', 'Process');
      legacy.onDecision('Process', 'Approve');
      legacy.onLoop('Init', 2);
      legacy.onBreak('Final');

      recorder.onStageExecuted({ stageName: 'Init' });
      recorder.onNext({ from: 'Init', to: 'Process' });
      recorder.onDecision({ decider: 'Process', chosen: 'Approve' });
      recorder.onLoop({ target: 'Init', iteration: 2 });
      recorder.onBreak({ stageName: 'Final' });

      expect(recorder.getSentences()).toEqual(legacy.getSentences());
    });
  });

  // ── Clear ──────────────────────────────────────────────────────────────

  it('clear resets sentences and first-stage flag', () => {
    recorder.onStageExecuted({ stageName: 'A' });
    expect(recorder.getSentences()).toHaveLength(1);
    recorder.clear();
    expect(recorder.getSentences()).toEqual([]);

    // First stage flag should be reset
    recorder.onStageExecuted({ stageName: 'B' });
    expect(recorder.getSentences()[0]).toContain('began');
  });

  // ── Defensive copy ─────────────────────────────────────────────────────

  it('getSentences returns a defensive copy', () => {
    recorder.onStageExecuted({ stageName: 'A' });
    const s1 = recorder.getSentences();
    const s2 = recorder.getSentences();
    expect(s1).toEqual(s2);
    expect(s1).not.toBe(s2);
  });
});
