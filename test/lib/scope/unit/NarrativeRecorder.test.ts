import { NarrativeRecorder } from '../../../../src/lib/scope/recorders/NarrativeRecorder';

describe('NarrativeRecorder', () => {
  it('records reads and writes per stage', () => {
    const rec = new NarrativeRecorder();
    rec.onRead({ stageName: 'a', pipelineId: 'p', timestamp: 1, key: 'input', value: 'hello' });
    rec.onWrite({ stageName: 'a', pipelineId: 'p', timestamp: 2, key: 'output', value: 42, operation: 'set' });

    const data = rec.getStageData();
    expect(data.size).toBe(1);
    const stage = data.get('a')!;
    expect(stage.reads).toHaveLength(1);
    expect(stage.writes).toHaveLength(1);
    expect(stage.operations).toHaveLength(2);
  });

  it('tracks operations in execution order', () => {
    const rec = new NarrativeRecorder();
    rec.onRead({ stageName: 'a', pipelineId: 'p', timestamp: 1, key: 'x', value: 1 });
    rec.onWrite({ stageName: 'a', pipelineId: 'p', timestamp: 2, key: 'y', value: 2, operation: 'set' });
    rec.onRead({ stageName: 'a', pipelineId: 'p', timestamp: 3, key: 'z', value: 3 });

    const ops = rec.getStageData().get('a')!.operations;
    expect(ops[0].type).toBe('read');
    expect(ops[1].type).toBe('write');
    expect(ops[2].type).toBe('read');
    expect(ops[0].stepNumber).toBe(1);
    expect(ops[2].stepNumber).toBe(3);
  });

  it('toSentences produces full detail by default', () => {
    const rec = new NarrativeRecorder();
    rec.onRead({ stageName: 'a', pipelineId: 'p', timestamp: 1, key: 'x', value: 42 });
    rec.onWrite({ stageName: 'a', pipelineId: 'p', timestamp: 2, key: 'y', value: 'hi', operation: 'set' });

    const sentences = rec.toSentences();
    expect(sentences.get('a')).toBeDefined();
    const lines = sentences.get('a')!;
    expect(lines.some((l) => l.includes('Read'))).toBe(true);
    expect(lines.some((l) => l.includes('Write'))).toBe(true);
  });

  it('toSentences summary mode shows counts', () => {
    const rec = new NarrativeRecorder({ detail: 'summary' });
    rec.onRead({ stageName: 'a', pipelineId: 'p', timestamp: 1, key: 'x', value: 1 });
    rec.onRead({ stageName: 'a', pipelineId: 'p', timestamp: 2, key: 'y', value: 2 });
    rec.onWrite({ stageName: 'a', pipelineId: 'p', timestamp: 3, key: 'z', value: 3, operation: 'set' });

    const lines = rec.toSentences().get('a')!;
    expect(lines).toHaveLength(1);
    expect(lines[0].toLowerCase()).toContain('read 2 values');
    expect(lines[0].toLowerCase()).toContain('wrote 1 value');
  });

  it('toFlatSentences prefixes stage name', () => {
    const rec = new NarrativeRecorder();
    rec.onRead({ stageName: 'CallLLM', pipelineId: 'p', timestamp: 1, key: 'messages', value: [1, 2, 3] });

    const flat = rec.toFlatSentences();
    expect(flat).toHaveLength(1);
    expect(flat[0]).toMatch(/^CallLLM:/);
  });

  it('getStageDataFor returns copy or undefined', () => {
    const rec = new NarrativeRecorder();
    expect(rec.getStageDataFor('none')).toBeUndefined();

    rec.onRead({ stageName: 'a', pipelineId: 'p', timestamp: 1, key: 'x', value: 1 });
    const data = rec.getStageDataFor('a')!;
    data.reads.push({ type: 'read', key: 'fake', valueSummary: '' });
    expect(rec.getStageDataFor('a')!.reads).toHaveLength(1);
  });

  it('clear resets all data', () => {
    const rec = new NarrativeRecorder();
    rec.onRead({ stageName: 'a', pipelineId: 'p', timestamp: 1, key: 'x', value: 1 });
    rec.clear();
    expect(rec.getStageData().size).toBe(0);
    expect(rec.toSentences().size).toBe(0);
  });

  it('setDetail/getDetail', () => {
    const rec = new NarrativeRecorder();
    expect(rec.getDetail()).toBe('full');
    rec.setDetail('summary');
    expect(rec.getDetail()).toBe('summary');
  });

  it('summarizes values: arrays, objects, strings, null/undefined', () => {
    const rec = new NarrativeRecorder();
    rec.onRead({ stageName: 'a', pipelineId: 'p', timestamp: 1, key: 'arr', value: [1, 2, 3] });
    rec.onRead({ stageName: 'a', pipelineId: 'p', timestamp: 2, key: 'obj', value: { a: 1, b: 2 } });
    rec.onRead({ stageName: 'a', pipelineId: 'p', timestamp: 3, key: 'str', value: 'hello' });
    rec.onRead({ stageName: 'a', pipelineId: 'p', timestamp: 4, key: 'nil', value: null });
    rec.onRead({ stageName: 'a', pipelineId: 'p', timestamp: 5, key: 'undef', value: undefined });

    const ops = rec.getStageData().get('a')!.operations;
    expect(ops[0].valueSummary).toContain('3 items');
    expect(ops[1].valueSummary).toContain('a');
    expect(ops[2].valueSummary).toBe('"hello"');
    expect(ops[3].valueSummary).toBe('null');
    expect(ops[4].valueSummary).toBe('undefined');
  });

  it('handles delete operations in full detail mode', () => {
    const rec = new NarrativeRecorder();
    rec.onWrite({ stageName: 'a', pipelineId: 'p', timestamp: 1, key: 'tmp', value: undefined, operation: 'delete' });
    const lines = rec.toSentences().get('a')!;
    expect(lines.some((l) => l.includes('Delete'))).toBe(true);
  });

  it('handles update operations in full detail mode (line 126)', () => {
    const rec = new NarrativeRecorder();
    rec.onWrite({ stageName: 'a', pipelineId: 'p', timestamp: 1, key: 'counter', value: 5, operation: 'update' });
    const lines = rec.toSentences().get('a')!;
    expect(lines.some((l) => l.includes('Update'))).toBe(true);
    expect(lines.some((l) => l.includes('counter'))).toBe(true);
  });

  it('summarizeValue falls back to String() for non-standard types (line 197)', () => {
    const rec = new NarrativeRecorder();
    // Symbol is not string, number, boolean, array, null, undefined, or plain object
    const sym = Symbol('test');
    rec.onRead({ stageName: 'a', pipelineId: 'p', timestamp: 1, key: 'sym', value: sym });
    const ops = rec.getStageData().get('a')!.operations;
    expect(ops[0].valueSummary).toBe(String(sym));
  });
});
