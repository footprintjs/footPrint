import { extractErrorInfo } from '../../../../src/lib/engine/errors/errorInfo';
import { NarrativeFlowRecorder } from '../../../../src/lib/engine/narrative/NarrativeFlowRecorder';

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

  // ── onStageExecuted ────────────────────────────────────────────────────

  it('onStageExecuted with description emits a sentence', () => {
    recorder.onStageExecuted({ stageName: 'Fetch', description: 'Retrieves data' });
    const s = recorder.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('Retrieves data');
  });

  it('onStageExecuted without description uses stage name', () => {
    recorder.onStageExecuted({ stageName: 'Fetch' });
    const s = recorder.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('Fetch');
  });

  it('onStageExecuted fires for every stage', () => {
    recorder.onStageExecuted({ stageName: 'A' });
    recorder.onStageExecuted({ stageName: 'B' });
    expect(recorder.getSentences()).toHaveLength(2);
  });

  // ── onNext ─────────────────────────────────────────────────────────────

  it('onNext with description', () => {
    recorder.onNext({ from: 'A', to: 'B', description: 'Fetches external data' });
    const s = recorder.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('Fetches external data');
  });

  it('onNext without description uses target stage name', () => {
    recorder.onNext({ from: 'A', to: 'B' });
    const s = recorder.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('B');
  });

  // ── onDecision ─────────────────────────────────────────────────────────

  it('onDecision with description and rationale', () => {
    recorder.onDecision({
      decider: 'check',
      chosen: 'Approve',
      rationale: 'age is 21',
      description: 'checked eligibility',
    });
    const s = recorder.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('checked eligibility');
    expect(s[0]).toContain('age is 21');
    expect(s[0]).toContain('Approve');
  });

  it('onDecision with description only', () => {
    recorder.onDecision({ decider: 'check', chosen: 'Approve', description: 'checked eligibility' });
    const s = recorder.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('checked eligibility');
    expect(s[0]).toContain('Approve');
  });

  it('onDecision with rationale only', () => {
    recorder.onDecision({ decider: 'check', chosen: 'Approve', rationale: 'age >= 18' });
    const s = recorder.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('Approve');
    expect(s[0]).toContain('age >= 18');
  });

  it('onDecision with neither description nor rationale', () => {
    recorder.onDecision({ decider: 'check', chosen: 'Approve' });
    const s = recorder.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('Approve');
  });

  // ── onFork ─────────────────────────────────────────────────────────────

  it('onFork records parallel fan-out', () => {
    recorder.onFork({ parent: 'dispatch', children: ['taskA', 'taskB', 'taskC'] });
    const s = recorder.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('taskA');
    expect(s[0]).toContain('taskB');
  });

  // ── onSelected ─────────────────────────────────────────────────────────

  it('onSelected records selection', () => {
    recorder.onSelected({ parent: 'selector', selected: ['taskA', 'taskC'], total: 3 });
    const s = recorder.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('taskA');
    expect(s[0]).toContain('2');
    expect(s[0]).toContain('3');
  });

  // ── onSubflowEntry / onSubflowExit ─────────────────────────────────────

  it('onSubflowEntry and onSubflowExit', () => {
    recorder.onSubflowEntry({ name: 'LLM Core' });
    recorder.onSubflowExit({ name: 'LLM Core' });
    const s = recorder.getSentences();
    expect(s).toHaveLength(2);
    expect(s[0]).toContain('LLM Core');
    expect(s[1]).toContain('LLM Core');
  });

  // ── onLoop ─────────────────────────────────────────────────────────────

  it('onLoop without description', () => {
    recorder.onLoop({ target: 'Ask LLM', iteration: 2 });
    const s = recorder.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('Ask LLM');
    expect(s[0]).toContain('2');
  });

  it('onLoop with description', () => {
    recorder.onLoop({ target: 'Ask LLM', iteration: 3, description: 'retries the LLM call' });
    const s = recorder.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('retries the LLM call');
    expect(s[0]).toContain('3');
  });

  // ── onBreak ────────────────────────────────────────────────────────────

  it('onBreak records early stop', () => {
    recorder.onBreak({ stageName: 'Validate' });
    const s = recorder.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('Validate');
  });

  // ── onError ────────────────────────────────────────────────────────────

  it('onError records error', () => {
    const err = new Error('timeout');
    recorder.onError({ stageName: 'Process', message: 'timeout', structuredError: extractErrorInfo(err) });
    const s = recorder.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('timeout');
  });

  // ── full flow sequence ─────────────────────────────────────────────────

  it('accumulates sentences in execution order', () => {
    recorder.onStageExecuted({ stageName: 'Init' });
    recorder.onNext({ from: 'Init', to: 'Process' });
    recorder.onDecision({ decider: 'Process', chosen: 'Approve' });
    recorder.onLoop({ target: 'Init', iteration: 2 });
    recorder.onBreak({ stageName: 'Final' });
    // onStageExecuted(Init) + onNext + onDecision + onLoop + onBreak = 5
    expect(recorder.getSentences()).toHaveLength(5);
  });

  // ── Clear ──────────────────────────────────────────────────────────────

  it('clear resets sentences', () => {
    recorder.onStageExecuted({ stageName: 'A' });
    expect(recorder.getSentences()).toHaveLength(1);
    recorder.clear();
    expect(recorder.getSentences()).toEqual([]);

    // Should emit again after clear
    recorder.onStageExecuted({ stageName: 'B' });
    expect(recorder.getSentences()).toHaveLength(1);
    expect(recorder.getSentences()[0]).toContain('B');
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
