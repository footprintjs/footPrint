import { SharedMemory } from '../../../../src/lib/memory/SharedMemory';
import { StageContext } from '../../../../src/lib/memory/StageContext';
import { EventLog } from '../../../../src/lib/memory/EventLog';

describe('Boundary: concurrent buffers', () => {
  it('100 parallel children all commit without data loss', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());
    const parent = new StageContext('p1', 'fork', mem, '', log);
    parent.setAsFork();

    const children: StageContext[] = [];
    for (let i = 0; i < 100; i++) {
      const child = parent.createChild('p1', `b${i}`, `child${i}`);
      child.setObject(['results'], `child${i}`, i);
      children.push(child);
    }

    // Commit all children
    for (const child of children) {
      child.commit();
    }

    // Verify all results are present
    for (let i = 0; i < 100; i++) {
      expect(mem.getValue('p1', ['results'], `child${i}`)).toBe(i);
    }
  });

  it('parallel children writing the same key — last commit wins', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());
    const parent = new StageContext('p1', 'fork', mem, '', log);

    const c1 = parent.createChild('p1', 'b1', 'child1');
    const c2 = parent.createChild('p1', 'b2', 'child2');
    const c3 = parent.createChild('p1', 'b3', 'child3');

    c1.setObject([], 'winner', 'c1');
    c2.setObject([], 'winner', 'c2');
    c3.setObject([], 'winner', 'c3');

    c1.commit();
    c2.commit();
    c3.commit();

    // Last commit wins
    expect(mem.getValue('p1', [], 'winner')).toBe('c3');
  });

  it('parallel buffers do not see each others uncommitted writes', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());
    const parent = new StageContext('p1', 'fork', mem, '', log);

    const c1 = parent.createChild('p1', 'b1', 'child1');
    const c2 = parent.createChild('p1', 'b2', 'child2');

    c1.setObject([], 'secret1', 'from-c1');
    c2.setObject([], 'secret2', 'from-c2');

    // Neither can see the other's uncommitted writes
    expect(c1.getValue([], 'secret2')).toBeUndefined();
    expect(c2.getValue([], 'secret1')).toBeUndefined();
  });

  it('EventLog captures commits from all children', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());
    const parent = new StageContext('p1', 'fork', mem, '', log);

    for (let i = 0; i < 10; i++) {
      const child = parent.createChild('p1', `b${i}`, `child${i}`);
      child.setObject([], `data${i}`, i);
      child.commit();
    }

    expect(log.list()).toHaveLength(10);
    const stages = log.list().map((b) => b.stage);
    for (let i = 0; i < 10; i++) {
      expect(stages).toContain(`child${i}`);
    }
  });
});
