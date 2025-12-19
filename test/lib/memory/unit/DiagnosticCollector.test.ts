import { DiagnosticCollector } from '../../../../src/lib/memory/DiagnosticCollector';

describe('DiagnosticCollector', () => {
  it('addLog appends using merge semantics', () => {
    const dc = new DiagnosticCollector();
    dc.addLog('messages', ['hello']);
    dc.addLog('messages', ['world']);
    expect(dc.logContext.messages).toEqual(['hello', 'world']);
  });

  it('setLog overwrites', () => {
    const dc = new DiagnosticCollector();
    dc.setLog('key', 'first');
    dc.setLog('key', 'second');
    expect(dc.logContext.key).toBe('second');
  });

  it('addError records errors', () => {
    const dc = new DiagnosticCollector();
    dc.addError('fetch', { msg: 'timeout' });
    expect(dc.errorContext.fetch).toEqual({ msg: 'timeout' });
  });

  it('addMetric and setMetric', () => {
    const dc = new DiagnosticCollector();
    dc.addMetric('durations', [100]);
    dc.addMetric('durations', [200]);
    expect(dc.metricContext.durations).toEqual([100, 200]);

    dc.setMetric('total', 300);
    expect(dc.metricContext.total).toBe(300);
  });

  it('addEval and setEval', () => {
    const dc = new DiagnosticCollector();
    dc.addEval('scores', [0.9]);
    dc.addEval('scores', [0.8]);
    expect(dc.evalContext.scores).toEqual([0.9, 0.8]);

    dc.setEval('final', 0.85);
    expect(dc.evalContext.final).toBe(0.85);
  });

  it('addFlowMessage pushes to flowMessages array', () => {
    const dc = new DiagnosticCollector();
    dc.addFlowMessage({ type: 'branch', description: 'took left', timestamp: 1000 });
    dc.addFlowMessage({ type: 'loop', description: 'iteration 2', timestamp: 2000 });
    expect(dc.flowMessages).toHaveLength(2);
    expect(dc.flowMessages[0].type).toBe('branch');
    expect(dc.flowMessages[1].type).toBe('loop');
  });

  it('supports nested paths for logs', () => {
    const dc = new DiagnosticCollector();
    dc.addLog('msg', 'hello', ['subsystem']);
    expect(dc.logContext.subsystem.msg).toBe('hello');
  });
});
