import { EventLog } from '../../../../src/lib/memory/EventLog';
import { SharedMemory } from '../../../../src/lib/memory/SharedMemory';
import { StageContext } from '../../../../src/lib/memory/StageContext';

describe('Scenario: time-travel replay via EventLog', () => {
  function runExecution() {
    const mem = new SharedMemory({ counter: 0 });
    const log = new EventLog(mem.getState());

    const s1 = new StageContext('p1', 'init', 'init', mem, '', log);
    s1.setObject([], 'counter', 10);
    s1.setObject([], 'name', 'Alice');
    s1.commit();

    const s2 = s1.createNext('p1', 'process', 'process');
    s2.setObject([], 'counter', 20);
    s2.setObject([], 'status', 'processing');
    s2.commit();

    const s3 = s2.createNext('p1', 'finalize', 'finalize');
    s3.setObject([], 'counter', 30);
    s3.setObject([], 'status', 'done');
    s3.commit();

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
