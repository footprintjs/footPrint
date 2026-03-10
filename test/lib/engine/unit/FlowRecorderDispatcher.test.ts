import { FlowRecorderDispatcher } from '../../../../src/lib/engine/narrative/FlowRecorderDispatcher';
import { NarrativeFlowRecorder } from '../../../../src/lib/engine/narrative/NarrativeFlowRecorder';
import type { FlowRecorder } from '../../../../src/lib/engine/narrative/types';

describe('FlowRecorderDispatcher', () => {
  let dispatcher: FlowRecorderDispatcher;

  beforeEach(() => {
    dispatcher = new FlowRecorderDispatcher();
  });

  // ── Attach / Detach ────────────────────────────────────────────────────

  it('starts with no recorders', () => {
    expect(dispatcher.getRecorders()).toEqual([]);
  });

  it('attaches recorders', () => {
    const recorder: FlowRecorder = { id: 'test' };
    dispatcher.attach(recorder);
    expect(dispatcher.getRecorders()).toHaveLength(1);
    expect(dispatcher.getRecorders()[0].id).toBe('test');
  });

  it('detaches recorders by id', () => {
    dispatcher.attach({ id: 'a' });
    dispatcher.attach({ id: 'b' });
    dispatcher.detach('a');
    expect(dispatcher.getRecorders()).toHaveLength(1);
    expect(dispatcher.getRecorders()[0].id).toBe('b');
  });

  it('getRecorderById returns the correct recorder', () => {
    const recorder = new NarrativeFlowRecorder('my-narrator');
    dispatcher.attach(recorder);
    const found = dispatcher.getRecorderById<NarrativeFlowRecorder>('my-narrator');
    expect(found).toBe(recorder);
  });

  it('getRecorderById returns undefined for missing id', () => {
    expect(dispatcher.getRecorderById('nope')).toBeUndefined();
  });

  // ── Fan-out to all hooks ───────────────────────────────────────────────

  it('fans out onStageExecuted to all recorders', () => {
    const calls: string[] = [];
    dispatcher.attach({ id: 'a', onStageExecuted: (e) => calls.push(`a:${e.stageName}`) });
    dispatcher.attach({ id: 'b', onStageExecuted: (e) => calls.push(`b:${e.stageName}`) });
    dispatcher.onStageExecuted('Init', 'starts the process');
    expect(calls).toEqual(['a:Init', 'b:Init']);
  });

  it('fans out onNext', () => {
    const calls: string[] = [];
    dispatcher.attach({ id: 'a', onNext: (e) => calls.push(`${e.from}->${e.to}`) });
    dispatcher.onNext('A', 'B', 'desc');
    expect(calls).toEqual(['A->B']);
  });

  it('fans out onDecision', () => {
    const calls: string[] = [];
    dispatcher.attach({ id: 'a', onDecision: (e) => calls.push(`${e.decider}:${e.chosen}`) });
    dispatcher.onDecision('check', 'approve', 'good score', 'evaluates risk');
    expect(calls).toEqual(['check:approve']);
  });

  it('fans out onFork', () => {
    const calls: string[][] = [];
    dispatcher.attach({ id: 'a', onFork: (e) => calls.push(e.children) });
    dispatcher.onFork('parent', ['c1', 'c2']);
    expect(calls).toEqual([['c1', 'c2']]);
  });

  it('fans out onSelected', () => {
    const calls: number[] = [];
    dispatcher.attach({ id: 'a', onSelected: (e) => calls.push(e.total) });
    dispatcher.onSelected('sel', ['a', 'b'], 5);
    expect(calls).toEqual([5]);
  });

  it('fans out onSubflowEntry and onSubflowExit', () => {
    const calls: string[] = [];
    dispatcher.attach({
      id: 'a',
      onSubflowEntry: (e) => calls.push(`enter:${e.name}`),
      onSubflowExit: (e) => calls.push(`exit:${e.name}`),
    });
    dispatcher.onSubflowEntry('LLM');
    dispatcher.onSubflowExit('LLM');
    expect(calls).toEqual(['enter:LLM', 'exit:LLM']);
  });

  it('fans out onLoop', () => {
    const calls: number[] = [];
    dispatcher.attach({ id: 'a', onLoop: (e) => calls.push(e.iteration) });
    dispatcher.onLoop('target', 3);
    expect(calls).toEqual([3]);
  });

  it('fans out onBreak', () => {
    const calls: string[] = [];
    dispatcher.attach({ id: 'a', onBreak: (e) => calls.push(e.stageName) });
    dispatcher.onBreak('Validate');
    expect(calls).toEqual(['Validate']);
  });

  it('fans out onError', () => {
    const calls: string[] = [];
    dispatcher.attach({ id: 'a', onError: (e) => calls.push(e.message) });
    dispatcher.onError('Process', 'timeout', new Error('timeout'));
    expect(calls).toEqual(['timeout']);
  });

  // ── Error isolation ────────────────────────────────────────────────────

  it('swallows errors from recorders and continues to next', () => {
    const calls: string[] = [];
    dispatcher.attach({
      id: 'thrower',
      onLoop: () => {
        throw new Error('boom');
      },
    });
    dispatcher.attach({
      id: 'good',
      onLoop: (e) => calls.push(`${e.iteration}`),
    });
    dispatcher.onLoop('target', 5);
    expect(calls).toEqual(['5']);
  });

  it('swallows errors from all hook types', () => {
    dispatcher.attach({
      id: 'thrower',
      onStageExecuted: () => {
        throw new Error('1');
      },
      onNext: () => {
        throw new Error('2');
      },
      onDecision: () => {
        throw new Error('3');
      },
      onFork: () => {
        throw new Error('4');
      },
      onSelected: () => {
        throw new Error('5');
      },
      onSubflowEntry: () => {
        throw new Error('6');
      },
      onSubflowExit: () => {
        throw new Error('7');
      },
      onLoop: () => {
        throw new Error('8');
      },
      onBreak: () => {
        throw new Error('9');
      },
      onError: () => {
        throw new Error('10');
      },
    });

    // None of these should throw
    expect(() => dispatcher.onStageExecuted('a')).not.toThrow();
    expect(() => dispatcher.onNext('a', 'b')).not.toThrow();
    expect(() => dispatcher.onDecision('a', 'b')).not.toThrow();
    expect(() => dispatcher.onFork('a', ['b'])).not.toThrow();
    expect(() => dispatcher.onSelected('a', ['b'], 1)).not.toThrow();
    expect(() => dispatcher.onSubflowEntry('a')).not.toThrow();
    expect(() => dispatcher.onSubflowExit('a')).not.toThrow();
    expect(() => dispatcher.onLoop('a', 1)).not.toThrow();
    expect(() => dispatcher.onBreak('a')).not.toThrow();
    expect(() => dispatcher.onError('a', 'msg', new Error('msg'))).not.toThrow();
  });

  // ── Fast path with no recorders ────────────────────────────────────────

  it('all methods are no-ops when no recorders attached', () => {
    expect(() => {
      dispatcher.onStageExecuted('a');
      dispatcher.onNext('a', 'b');
      dispatcher.onDecision('a', 'b');
      dispatcher.onFork('a', ['b']);
      dispatcher.onSelected('a', ['b'], 1);
      dispatcher.onSubflowEntry('a');
      dispatcher.onSubflowExit('a');
      dispatcher.onLoop('a', 1);
      dispatcher.onBreak('a');
      dispatcher.onError('a', 'msg', new Error('msg'));
    }).not.toThrow();
    expect(dispatcher.getSentences()).toEqual([]);
  });

  // ── getSentences delegation ────────────────────────────────────────────

  it('getSentences returns empty when no recorder has getSentences', () => {
    dispatcher.attach({ id: 'plain' });
    expect(dispatcher.getSentences()).toEqual([]);
  });

  it('getSentences delegates to first recorder with getSentences', () => {
    const narrator = new NarrativeFlowRecorder();
    dispatcher.attach(narrator);
    dispatcher.onStageExecuted('Init');
    const sentences = dispatcher.getSentences();
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toContain('Init');
  });

  // ── Recorders with optional hooks ──────────────────────────────────────

  it('recorders with missing hooks are silently skipped', () => {
    dispatcher.attach({ id: 'minimal' }); // no hooks at all
    expect(() => {
      dispatcher.onStageExecuted('a');
      dispatcher.onLoop('a', 1);
    }).not.toThrow();
  });

  // ── Per-hook error isolation ────────────────────────────────────────

  it('isolates errors in onNext and continues to next recorder', () => {
    const calls: string[] = [];
    dispatcher.attach({
      id: 'bad',
      onNext: () => {
        throw new Error('fail');
      },
    });
    dispatcher.attach({ id: 'good', onNext: (e) => calls.push(`${e.from}->${e.to}`) });
    dispatcher.onNext('A', 'B');
    expect(calls).toEqual(['A->B']);
  });

  it('isolates errors in onDecision', () => {
    const calls: string[] = [];
    dispatcher.attach({
      id: 'bad',
      onDecision: () => {
        throw new Error('fail');
      },
    });
    dispatcher.attach({ id: 'good', onDecision: (e) => calls.push(e.chosen) });
    dispatcher.onDecision('check', 'approve');
    expect(calls).toEqual(['approve']);
  });

  it('isolates errors in onFork', () => {
    const calls: string[][] = [];
    dispatcher.attach({
      id: 'bad',
      onFork: () => {
        throw new Error('fail');
      },
    });
    dispatcher.attach({ id: 'good', onFork: (e) => calls.push(e.children) });
    dispatcher.onFork('parent', ['c1']);
    expect(calls).toEqual([['c1']]);
  });

  it('isolates errors in onSelected', () => {
    const calls: number[] = [];
    dispatcher.attach({
      id: 'bad',
      onSelected: () => {
        throw new Error('fail');
      },
    });
    dispatcher.attach({ id: 'good', onSelected: (e) => calls.push(e.total) });
    dispatcher.onSelected('sel', ['a'], 3);
    expect(calls).toEqual([3]);
  });

  it('isolates errors in onSubflowEntry', () => {
    const calls: string[] = [];
    dispatcher.attach({
      id: 'bad',
      onSubflowEntry: () => {
        throw new Error('fail');
      },
    });
    dispatcher.attach({ id: 'good', onSubflowEntry: (e) => calls.push(e.name) });
    dispatcher.onSubflowEntry('LLM');
    expect(calls).toEqual(['LLM']);
  });

  it('isolates errors in onSubflowExit', () => {
    const calls: string[] = [];
    dispatcher.attach({
      id: 'bad',
      onSubflowExit: () => {
        throw new Error('fail');
      },
    });
    dispatcher.attach({ id: 'good', onSubflowExit: (e) => calls.push(e.name) });
    dispatcher.onSubflowExit('LLM');
    expect(calls).toEqual(['LLM']);
  });

  it('isolates errors in onBreak', () => {
    const calls: string[] = [];
    dispatcher.attach({
      id: 'bad',
      onBreak: () => {
        throw new Error('fail');
      },
    });
    dispatcher.attach({ id: 'good', onBreak: (e) => calls.push(e.stageName) });
    dispatcher.onBreak('Validate');
    expect(calls).toEqual(['Validate']);
  });

  it('isolates errors in onError', () => {
    const calls: string[] = [];
    dispatcher.attach({
      id: 'bad',
      onError: () => {
        throw new Error('fail');
      },
    });
    dispatcher.attach({ id: 'good', onError: (e) => calls.push(e.message) });
    dispatcher.onError('Process', 'timeout', new Error('timeout'));
    expect(calls).toEqual(['timeout']);
  });
});
