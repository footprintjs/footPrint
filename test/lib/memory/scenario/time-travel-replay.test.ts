/**
 * Scenario: time-travel replay via EventLog — three stages written through their frames (`RecordFrame`,
 * footprintjs/write) at a run's address, folded back at every step by `EventLog · materialise`.
 */
import { EventLog, RecordFrame, SharedMemory } from '../../../../src/write';

describe('Scenario: time-travel replay via EventLog', () => {
  function runExecution() {
    const mem = new SharedMemory({ counter: 0 });
    const log = new EventLog(mem.getState());

    // One stage of run `p1`: its frame, its writes, its commit (then released, as the engine's frame does).
    const stage = (name: string, i: number, writes: Record<string, unknown>) => {
      const frame = new RecordFrame(mem, log, ['runs', 'p1']);
      for (const [key, value] of Object.entries(writes)) frame.write(frame.at([], key), value, 'set');
      frame.commit(() => ({ stage: name, stageId: name, runtimeStageId: `${name}#${i}` }));
      frame.release();
    };

    stage('init', 0, { counter: 10, name: 'Alice' });
    stage('process', 1, { counter: 20, status: 'processing' });
    stage('finalize', 2, { counter: 30, status: 'done' });

    return { mem, log };
  }

  it('materialise(0) returns initial state', () => {
    const { log } = runExecution();
    const state = log.materialise(0);
    expect(state.counter).toBe(0);
    expect(state.runs).toBeUndefined();
  });

  it('materialise(1) returns state after first commit', () => {
    const { log } = runExecution();
    const state = log.materialise(1);
    expect(state.runs.p1.counter).toBe(10);
    expect(state.runs.p1.name).toBe('Alice');
    expect(state.runs.p1.status).toBeUndefined();
  });

  it('materialise(2) returns state after second commit', () => {
    const { log } = runExecution();
    const state = log.materialise(2);
    expect(state.runs.p1.counter).toBe(20);
    expect(state.runs.p1.name).toBe('Alice');
    expect(state.runs.p1.status).toBe('processing');
  });

  it('materialise() returns final state', () => {
    const { log } = runExecution();
    const state = log.materialise();
    expect(state.runs.p1.counter).toBe(30);
    expect(state.runs.p1.status).toBe('done');
  });

  it('replay is deterministic — same result on repeated calls', () => {
    const { log } = runExecution();
    const first = log.materialise(2);
    const second = log.materialise(2);
    expect(first).toEqual(second);
  });

  it('materialise returns isolated copies', () => {
    const { log } = runExecution();
    const a = log.materialise(2);
    const b = log.materialise(2);
    a.runs.p1.counter = 999;
    expect(b.runs.p1.counter).toBe(20);
  });

  it('history records stage names in order', () => {
    const { log } = runExecution();
    const stages = log.list().map((b) => b.stage);
    expect(stages).toEqual(['init', 'process', 'finalize']);
  });
});
