import { SharedMemory } from '../../../../src/lib/memory/SharedMemory';
import { StageContext } from '../../../../src/lib/memory/StageContext';
import { EventLog } from '../../../../src/lib/memory/EventLog';

describe('Boundary: deep nesting', () => {
  it('handles deeply nested paths (20 levels)', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());
    const ctx = new StageContext('p1', 's1', mem, '', log);

    const path = Array.from({ length: 19 }, (_, i) => `level${i}`);
    ctx.setObject(path, 'leaf', 'deepValue');
    ctx.commit();

    expect(ctx.getValue(path, 'leaf')).toBe('deepValue');
  });

  it('handles 50-level deep stage context tree (next chain)', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());
    let ctx = new StageContext('p1', 's0', mem, '', log);

    for (let i = 1; i <= 50; i++) {
      ctx = ctx.createNext('p1', `s${i}`);
    }

    expect(ctx.stageName).toBe('s50');
    // Walk back to root
    let current: StageContext | undefined = ctx;
    let depth = 0;
    while (current?.parent) {
      current = current.parent;
      depth++;
    }
    expect(depth).toBe(50);
  });

  it('handles nested children (tree depth 10 with branching)', () => {
    const mem = new SharedMemory();
    const log = new EventLog(mem.getState());
    let ctx = new StageContext('p1', 'root', mem, '', log);

    // Create a tree: each node has 2 children, 10 levels deep
    function createTree(parent: StageContext, depth: number) {
      if (depth === 0) return;
      const c1 = parent.createChild('p1', `b${depth}-1`, `child-${depth}-1`);
      const c2 = parent.createChild('p1', `b${depth}-2`, `child-${depth}-2`);
      createTree(c1, depth - 1);
      createTree(c2, depth - 1);
    }

    createTree(ctx, 10);

    const snap = ctx.getSnapshot();
    expect(snap.children).toHaveLength(2);
    // Verify depth
    let node: any = snap;
    let levels = 0;
    while (node.children?.length > 0) {
      node = node.children[0];
      levels++;
    }
    expect(levels).toBe(10);
  });
});
