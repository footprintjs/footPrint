/**
 * Scenario: namespace isolation between runs — a stage's frame (`RecordFrame`, footprintjs/write) reads and
 * writes at its run's address (`['runs', <runId>]`, as the engine's frame of that run does), so two runs
 * write one key without collision, and both read the root (the global keys).
 */
import { EventLog, RecordFrame, SharedMemory } from '../../../../src/write';

/** A stage's frame of run `runId`. */
const frameOf = (mem: SharedMemory, log: EventLog, runId: string) => new RecordFrame(mem, log, ['runs', runId]);

/** Commit the frame as `stage1` and release it, as the engine's frame does at the end of a stage. */
function commit(frame: RecordFrame): void {
  frame.commit(() => ({ stage: 'stage1', stageId: 'stage1', runtimeStageId: 'stage1#0' }));
  frame.release();
}

describe('Scenario: namespace isolation between runs', () => {
  it('two runs can write the same key without collision', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());

    const p1 = frameOf(mem, log, 'run-A');
    const p2 = frameOf(mem, log, 'run-B');

    p1.write(p1.at([], 'result'), 'A-result', 'set');
    commit(p1);

    p2.write(p2.at([], 'result'), 'B-result', 'set');
    commit(p2);

    expect(mem.getValue(['runs', 'run-A'], [], 'result')).toBe('A-result');
    expect(mem.getValue(['runs', 'run-B'], [], 'result')).toBe('B-result');
  });

  it('run reads do not leak between namespaces', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());

    const p1 = frameOf(mem, log, 'p1');
    p1.write(p1.at([], 'secret'), 'p1-only', 'set');
    commit(p1);

    const p2 = frameOf(mem, log, 'p2');
    expect(p2.read([], 'secret')).toBeUndefined();
  });

  it('global values are shared across runs', () => {
    const mem = new SharedMemory({ sharedConfig: 'enabled' });
    const log = new EventLog(mem.getState());

    const p1 = frameOf(mem, log, 'p1');
    const p2 = frameOf(mem, log, 'p2');

    expect(p1.readGlobal('sharedConfig')).toBe('enabled');
    expect(p2.readGlobal('sharedConfig')).toBe('enabled');
  });

  it('global writes from one run are visible to another', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());

    // A global write is a write at the root: the absolute path is the key alone.
    const p1 = frameOf(mem, log, 'p1');
    p1.write(['announcement'], 'hello', 'set');
    commit(p1);

    const p2 = frameOf(mem, log, 'p2');
    expect(p2.readGlobal('announcement')).toBe('hello');
  });

  it('run-specific value shadows global default', () => {
    const mem = new SharedMemory({ theme: 'light' });
    const log = new EventLog(mem.getState());

    const frame = frameOf(mem, log, 'p1');
    frame.write(frame.at([], 'theme'), 'dark', 'set');
    commit(frame);

    // Run-specific value wins
    expect(mem.getValue(['runs', 'p1'], [], 'theme')).toBe('dark');
    // Global default still exists
    expect(mem.getValue([], [], 'theme')).toBe('light');
  });
});
