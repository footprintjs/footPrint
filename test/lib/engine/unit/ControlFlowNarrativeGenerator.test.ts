import { ControlFlowNarrativeGenerator } from '../../../../src/lib/engine/narrative/ControlFlowNarrativeGenerator';
import { NullControlFlowNarrativeGenerator } from '../../../../src/lib/engine/narrative/NullControlFlowNarrativeGenerator';

describe('ControlFlowNarrativeGenerator', () => {
  let gen: ControlFlowNarrativeGenerator;

  beforeEach(() => {
    gen = new ControlFlowNarrativeGenerator();
  });

  it('starts with empty sentences', () => {
    expect(gen.getSentences()).toEqual([]);
  });

  it('onStageExecuted adds a sentence with description', () => {
    gen.onStageExecuted('fetchData', 'Fetch Data', 'Retrieves user data');
    const s = gen.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('Retrieves user data');
  });

  it('onStageExecuted uses displayName when no description', () => {
    gen.onStageExecuted('fetchData', 'Fetch Data');
    const s = gen.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('Fetch Data');
  });

  it('onStageExecuted falls back to name when no displayName', () => {
    gen.onStageExecuted('fetchData');
    const s = gen.getSentences();
    expect(s[0]).toContain('fetchData');
  });

  it('onNext records transition', () => {
    gen.onNext('stage1', 'stage2', 'Stage 2');
    const s = gen.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('Stage 2');
  });

  it('onNext uses description when provided (line 34)', () => {
    gen.onNext('stage1', 'stage2', 'Stage 2', 'Fetches external data');
    const s = gen.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('Fetches external data');
  });

  it('onDecision records branch choice with rationale', () => {
    gen.onDecision('checkAge', 'approve', 'Approve', 'age >= 18');
    const s = gen.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('Approve');
    expect(s[0]).toContain('age >= 18');
  });

  it('onDecision works without rationale', () => {
    gen.onDecision('checkAge', 'approve', 'Approve');
    const s = gen.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('Approve');
  });

  it('onDecision with deciderDescription and rationale (line 44)', () => {
    gen.onDecision('checkAge', 'approve', 'Approve', 'age is 21', 'checked eligibility');
    const s = gen.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('checked eligibility');
    expect(s[0]).toContain('age is 21');
    expect(s[0]).toContain('Approve');
  });

  it('onDecision with deciderDescription but no rationale (line 46)', () => {
    gen.onDecision('checkAge', 'approve', 'Approve', undefined, 'checked eligibility');
    const s = gen.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('checked eligibility');
    expect(s[0]).toContain('Approve');
  });

  it('onFork records parallel fan-out', () => {
    gen.onFork('dispatch', ['taskA', 'taskB', 'taskC']);
    const s = gen.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('taskA');
    expect(s[0]).toContain('taskB');
  });

  it('onSelected records multi-choice selection', () => {
    gen.onSelected('selector', ['taskA', 'taskC'], 3);
    const s = gen.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('taskA');
    expect(s[0]).toContain('2');
    expect(s[0]).toContain('3');
  });

  it('onSelected with empty selection', () => {
    gen.onSelected('selector', [], 3);
    const s = gen.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('0 of 3');
  });

  it('onSubflowEntry and onSubflowExit', () => {
    gen.onSubflowEntry('LLM Core');
    gen.onSubflowExit('LLM Core');
    const s = gen.getSentences();
    expect(s).toHaveLength(2);
    expect(s[0]).toContain('LLM Core');
    expect(s[1]).toContain('LLM Core');
  });

  it('onLoop records iteration', () => {
    gen.onLoop('askLLM', 'Ask LLM', 2);
    const s = gen.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('Ask LLM');
    expect(s[0]).toContain('2');
  });

  it('onLoop uses description when provided (line 74)', () => {
    gen.onLoop('askLLM', 'Ask LLM', 3, 'retries the LLM call');
    const s = gen.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('retries the LLM call');
    expect(s[0]).toContain('3');
  });

  it('onBreak records early stop', () => {
    gen.onBreak('validate', 'Validate');
    const s = gen.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('Validate');
  });

  it('onError records error', () => {
    gen.onError('process', 'timeout');
    const s = gen.getSentences();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('timeout');
  });

  it('accumulates sentences in execution order', () => {
    gen.onStageExecuted('a'); // first stage sentence
    gen.onNext('a', 'b'); // transition sentence
    // second onStageExecuted is a no-op (isFirstStage = false)
    gen.onDecision('b', 'c', 'C'); // decision sentence
    const s = gen.getSentences();
    expect(s).toHaveLength(3);
  });
});

describe('NullControlFlowNarrativeGenerator', () => {
  it('implements all methods as no-ops', () => {
    const gen = new NullControlFlowNarrativeGenerator();
    gen.onStageExecuted('a');
    gen.onNext('a', 'b');
    gen.onDecision('a', 'b', 'B');
    gen.onFork('a', ['b', 'c']);
    gen.onSelected('a', ['b'], 2);
    gen.onSubflowEntry('x');
    gen.onSubflowExit('x');
    gen.onLoop('a', 'A', 1);
    gen.onBreak('a');
    gen.onError('a', 'err');
    expect(gen.getSentences()).toEqual([]);
  });
});
