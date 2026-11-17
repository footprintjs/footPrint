import { describe, it, expect } from 'vitest';
import { flowChart, FlowChartExecutor } from '../../index.ts';

describe('new capture options require native module-instance authority before setup effects', () => {
  it('refuses bare flags and forged authority before touching other options', () => {
    let effects = 0;
    const chart = flowChart(
      'Stage',
      () => {
        effects++;
      },
      'stage',
    ).build();
    for (const forbidden of [
      { captureInputHandoff: true },
      { captureInputHandoff: false },
      { captureFanoutHandoff: true },
      { subflowCapture: {} },
      { captureInputHandoff: true, captureFanoutHandoff: true, subflowCapture: {} },
    ]) {
      const opts = {
        ...forbidden,
        get initialContext() {
          effects++;
          return {};
        },
        get scopeFactory() {
          effects++;
          return () => {};
        },
        get sink() {
          effects++;
          return {};
        },
      };
      expect(() => new FlowChartExecutor(chart, opts)).toThrow(/subflow capture configuration/);
      expect(effects).toBe(0);
    }
  });
  it('refuses inherited and accessor claims without invoking an accessor', () => {
    let called = 0;
    const chart = flowChart('Stage', () => {}, 'stage').build();
    for (const opts of [
      Object.assign(()=>{called++;},{captureInputHandoff:true}),
      Object.create({ captureInputHandoff: true }),
      {
        get captureInputHandoff() {
          called++;
          return true;
        },
      },
    ])
      expect(() => new FlowChartExecutor(chart, opts)).toThrow(/subflow capture configuration/);
    expect(called).toBe(0);
  });
  it('keeps released output capture independent and default field keys unchanged', async () => {
    const chart = flowChart(
      'Stage',
      (s) => {
        s.answer = 1;
      },
      'stage',
    ).build();
    for (const opts of [{}, { captureOutputHandoff: true }]) {
      const executor = new FlowChartExecutor(chart, opts);
      await executor.run();
      const snapshot = executor.getSnapshot();
      expect(snapshot.sharedState.answer).toBe(1);
      expect(Object.hasOwn(snapshot, 'subflowCapture')).toBe(false);
      expect(Object.hasOwn(snapshot, 'fanoutCollections')).toBe(false);
    }
  });
});
