import { EventLog } from '../../../../src/lib/memory/EventLog';
import { SharedMemory } from '../../../../src/lib/memory/SharedMemory';
import { StageContext } from '../../../../src/lib/memory/StageContext';

describe('Scenario: namespace isolation between runs', () => {
  it('two runs can write the same key without collision', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());

    const p1 = new StageContext('run-A', 'stage1', 'stage1', mem, '', log);
    const p2 = new StageContext('run-B', 'stage1', 'stage1', mem, '', log);

    p1.setObject([], 'result', 'A-result');
    p1.commit();

    p2.setObject([], 'result', 'B-result');
    p2.commit();

    expect(mem.getValue('run-A', [], 'result')).toBe('A-result');
    expect(mem.getValue('run-B', [], 'result')).toBe('B-result');
  });

  it('run reads do not leak between namespaces', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());

    const p1 = new StageContext('p1', 's1', 's1', mem, '', log);
    p1.setObject([], 'secret', 'p1-only');
    p1.commit();

    const p2 = new StageContext('p2', 's1', 's1', mem, '', log);
    expect(p2.getValue([], 'secret')).toBeUndefined();
  });

  it('global values are shared across runs', () => {
    const mem = new SharedMemory({ sharedConfig: 'enabled' });
    const log = new EventLog(mem.getState());

    const p1 = new StageContext('p1', 's1', 's1', mem, '', log);
    const p2 = new StageContext('p2', 's1', 's1', mem, '', log);

    expect(p1.getGlobal('sharedConfig')).toBe('enabled');
    expect(p2.getGlobal('sharedConfig')).toBe('enabled');
  });

  it('global writes from one run are visible to another', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());

    const p1 = new StageContext('p1', 's1', 's1', mem, '', log);
    p1.setGlobal('announcement', 'hello');
    p1.commit();

    const p2 = new StageContext('p2', 's1', 's1', mem, '', log);
    expect(p2.getGlobal('announcement')).toBe('hello');
  });

  it('run-specific value shadows global default', () => {
    const mem = new SharedMemory({ theme: 'light' });
    const log = new EventLog(mem.getState());

    const ctx = new StageContext('p1', 's1', 's1', mem, '', log);
    ctx.setObject([], 'theme', 'dark');
    ctx.commit();

    // Run-specific value wins
    expect(mem.getValue('p1', [], 'theme')).toBe('dark');
    // Global default still exists
    expect(mem.getValue('', [], 'theme')).toBe('light');
  });
});
