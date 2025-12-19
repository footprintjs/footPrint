import { EventLog } from '../../../../src/lib/memory/EventLog';
import type { CommitBundle } from '../../../../src/lib/memory/types';

function makeBundle(stage: string, overwrite: Record<string, any> = {}, updates: Record<string, any> = {}): CommitBundle {
  const trace: { path: string; verb: 'set' | 'merge' }[] = [];
  for (const key of Object.keys(overwrite)) {
    trace.push({ path: key, verb: 'set' });
  }
  for (const key of Object.keys(updates)) {
    trace.push({ path: key, verb: 'merge' });
  }
  return { stage, trace, redactedPaths: [], overwrite, updates };
}

describe('EventLog', () => {
  it('starts empty', () => {
    const log = new EventLog({});
    expect(log.list()).toHaveLength(0);
    expect(log.length).toBe(0);
  });

  it('records bundles and auto-increments idx', () => {
    const log = new EventLog({});
    const b1 = makeBundle('stage1', { x: 1 });
    const b2 = makeBundle('stage2', { y: 2 });
    log.record(b1);
    log.record(b2);

    expect(log.list()).toHaveLength(2);
    expect(b1.idx).toBe(0);
    expect(b2.idx).toBe(1);
    expect(log.length).toBe(2);
  });

  it('materialise() reconstructs state at step 0 (initial)', () => {
    const log = new EventLog({ base: true });
    log.record(makeBundle('s1', { x: 1 }));

    const state = log.materialise(0);
    expect(state).toEqual({ base: true });
  });

  it('materialise() reconstructs state at latest', () => {
    const log = new EventLog({ count: 0 });
    log.record(makeBundle('s1', { count: 1 }));
    log.record(makeBundle('s2', { count: 2 }));

    const state = log.materialise();
    expect(state.count).toBe(2);
  });

  it('materialise() reconstructs state at intermediate step', () => {
    const log = new EventLog({});
    log.record(makeBundle('s1', { a: 1 }));
    log.record(makeBundle('s2', { b: 2 }));
    log.record(makeBundle('s3', { c: 3 }));

    const at2 = log.materialise(2);
    expect(at2.a).toBe(1);
    expect(at2.b).toBe(2);
    expect(at2.c).toBeUndefined();
  });

  it('materialise() supports merge operations', () => {
    const log = new EventLog({ tags: ['initial'] });
    log.record(makeBundle('s1', {}, { tags: ['added'] }));

    const state = log.materialise();
    expect(state.tags).toEqual(['initial', 'added']);
  });

  it('clear() wipes all history', () => {
    const log = new EventLog({});
    log.record(makeBundle('s1', { x: 1 }));
    log.record(makeBundle('s2', { y: 2 }));
    log.clear();

    expect(log.list()).toHaveLength(0);
    expect(log.length).toBe(0);
  });

  it('initial state is isolated from external mutation', () => {
    const initial = { data: [1, 2, 3] };
    const log = new EventLog(initial);
    initial.data.push(999);

    const state = log.materialise(0);
    expect(state.data).toEqual([1, 2, 3]);
  });
});
