import { EventLog } from '../../../../src/lib/memory/EventLog';
import { SharedMemory } from '../../../../src/lib/memory/SharedMemory';
import { StageContext } from '../../../../src/lib/memory/StageContext';

describe('Boundary: many commits', () => {
  it('handles 200 sequential commits', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());
    let ctx = new StageContext('p1', 's0', 's0', mem, '', log);

    for (let i = 0; i < 200; i++) {
      const stage = i === 0 ? ctx : ctx.createNext('p1', `s${i}`, `s${i}`);
      if (i > 0) ctx = stage;
      stage.setObject([], 'counter', i);
      stage.commit();
    }

    expect(log.list()).toHaveLength(200);
    expect(mem.getValue('p1', [], 'counter')).toBe(199);
  });

  it('materialise at any step within 200 commits', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());
    let ctx = new StageContext('p1', 's0', 's0', mem, '', log);

    for (let i = 0; i < 200; i++) {
      const stage = i === 0 ? ctx : ctx.createNext('p1', `s${i}`, `s${i}`);
      if (i > 0) ctx = stage;
      stage.setObject([], 'step', i);
      stage.commit();
    }

    // Check a few points
    const at50 = log.materialise(50);
    expect(at50.runs.p1.step).toBe(49);

    const at100 = log.materialise(100);
    expect(at100.runs.p1.step).toBe(99);

    const at200 = log.materialise(200);
    expect(at200.runs.p1.step).toBe(199);
  });

  it('accumulative merges across many commits', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());
    let ctx = new StageContext('p1', 's0', 's0', mem, '', log);

    for (let i = 0; i < 100; i++) {
      const stage = i === 0 ? ctx : ctx.createNext('p1', `s${i}`, `s${i}`);
      if (i > 0) ctx = stage;
      stage.updateObject([], 'items', [`item${i}`]);
      stage.commit();
    }

    const items = mem.getValue('p1', [], 'items') as string[];
    expect(items).toHaveLength(100);
    expect(items[0]).toBe('item0');
    expect(items[99]).toBe('item99');
  });
});
