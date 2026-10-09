import { SharedMemory } from '../../../../src/lib/memory/SharedMemory';

describe('SharedMemory', () => {
  it('stores and retrieves values by run namespace', () => {
    const mem = new SharedMemory();
    mem.setValue(['runs', 'p1'], [], 'name', 'Alice');
    expect(mem.getValue(['runs', 'p1'], [], 'name')).toBe('Alice');
  });

  it('isolates values between runs', () => {
    const mem = new SharedMemory();
    mem.setValue(['runs', 'p1'], [], 'x', 1);
    mem.setValue(['runs', 'p2'], [], 'x', 2);
    expect(mem.getValue(['runs', 'p1'], [], 'x')).toBe(1);
    expect(mem.getValue(['runs', 'p2'], [], 'x')).toBe(2);
  });

  it('falls back to global when run value is missing', () => {
    const mem = new SharedMemory({ greeting: 'hello' });
    expect(mem.getValue(['runs', 'p1'], [], 'greeting')).toBe('hello');
  });

  it('returns run value over global when both exist', () => {
    const mem = new SharedMemory({ greeting: 'hello' });
    mem.setValue(['runs', 'p1'], [], 'greeting', 'hi');
    expect(mem.getValue(['runs', 'p1'], [], 'greeting')).toBe('hi');
  });

  it('supports nested paths', () => {
    const mem = new SharedMemory();
    mem.setValue(['runs', 'p1'], ['user', 'profile'], 'age', 30);
    expect(mem.getValue(['runs', 'p1'], ['user', 'profile'], 'age')).toBe(30);
  });

  it('merges values with updateValue', () => {
    const mem = new SharedMemory();
    mem.setValue(['runs', 'p1'], [], 'tags', ['a']);
    mem.updateValue(['runs', 'p1'], [], 'tags', ['b']);
    expect(mem.getValue(['runs', 'p1'], [], 'tags')).toEqual(['a', 'b']);
  });

  it('deep-merges objects with updateValue', () => {
    const mem = new SharedMemory();
    mem.setValue(['runs', 'p1'], [], 'config', { a: 1 });
    mem.updateValue(['runs', 'p1'], [], 'config', { b: 2 });
    expect(mem.getValue(['runs', 'p1'], [], 'config')).toEqual({ a: 1, b: 2 });
  });

  it('applies patches from commit bundles', () => {
    const mem = new SharedMemory();
    mem.applyPatch({ runs: { p1: { name: 'Bob' } } }, {}, [
      { path: ['runs', 'p1', 'name'].join('\u001F'), verb: 'set' },
    ]);
    expect(mem.getValue(['runs', 'p1'], [], 'name')).toBe('Bob');
  });

  it('returns default values via getDefaultValues', () => {
    const defaults = { x: 1 };
    const mem = new SharedMemory(defaults);
    const d = mem.getDefaultValues();
    expect(d).toEqual({ x: 1 });
    // Ensure it's a clone
    (d as any).x = 99;
    expect(mem.getDefaultValues()).toEqual({ x: 1 });
  });

  it('returns undefined for getDefaultValues when no defaults', () => {
    const mem = new SharedMemory();
    expect(mem.getDefaultValues()).toBeUndefined();
  });

  it('exposes full state via getState', () => {
    const mem = new SharedMemory({ a: 1 });
    const state = mem.getState();
    expect(state.a).toBe(1);
  });

  it('writes at the address it is handed — the store names no namespace of its own (C2)', () => {
    const mem = new SharedMemory();
    mem.setValue(['runs', 'p1'], [], 'x', 1);
    mem.setValue(['tenants', 't1'], ['cfg'], 'y', 2);
    mem.setValue([], [], 'z', 3);
    expect(mem.getState()).toEqual({ runs: { p1: { x: 1 } }, tenants: { t1: { cfg: { y: 2 } } }, z: 3 });
  });

  it('the default values seed the container AT the address when a write creates it, and no other', () => {
    const mem = new SharedMemory({ theme: 'light' });
    // A path segment that repeats the address's last one is an ordinary container.
    mem.setValue(['runs', 'p1'], ['p1'], 'x', 1);
    expect(mem.getState()).toEqual({ theme: 'light', runs: { p1: { theme: 'light', p1: { x: 1 } } } });
  });

  it('merges initial context with defaults (initial wins)', () => {
    const mem = new SharedMemory({ a: 1, b: 2 }, { a: 10 });
    const state = mem.getState();
    expect(state.a).toBe(10); // initial wins
    expect(state.b).toBe(2); // default fills gap
  });
});
