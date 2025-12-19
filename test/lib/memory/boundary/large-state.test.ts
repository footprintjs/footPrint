import { SharedMemory } from '../../../../src/lib/memory/SharedMemory';
import { StageContext } from '../../../../src/lib/memory/StageContext';
import { EventLog } from '../../../../src/lib/memory/EventLog';

describe('Boundary: large state', () => {
  it('handles 1000 keys in a single commit', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());
    const ctx = new StageContext('p1', 's1', mem, '', log);

    for (let i = 0; i < 1000; i++) {
      ctx.setObject([], `key${i}`, `value${i}`);
    }
    ctx.commit();

    for (let i = 0; i < 1000; i++) {
      expect(mem.getValue('p1', [], `key${i}`)).toBe(`value${i}`);
    }
  });

  it('handles a large object value (100KB+ serialised)', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());
    const ctx = new StageContext('p1', 's1', mem, '', log);

    const largeArray = Array.from({ length: 10000 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      data: 'x'.repeat(10),
    }));

    ctx.setObject([], 'bigData', largeArray);
    ctx.commit();

    const retrieved = mem.getValue('p1', [], 'bigData');
    expect(retrieved).toHaveLength(10000);
    expect(retrieved[9999].id).toBe(9999);
  });

  it('EventLog materialise works with large state', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());

    const ctx = new StageContext('p1', 's1', mem, '', log);
    const data: Record<string, number> = {};
    for (let i = 0; i < 500; i++) {
      data[`field${i}`] = i;
    }
    ctx.setObject([], 'bulk', data);
    ctx.commit();

    const state = log.materialise();
    expect(Object.keys(state.runs.p1.bulk)).toHaveLength(500);
  });
});
