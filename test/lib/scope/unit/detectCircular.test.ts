/**
 * Tests for dev-mode circular reference detection.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  disableDevMode,
  enableDevMode,
  hasCircularReference,
  isDevMode,
} from '../../../../src/lib/scope/detectCircular';

// -- hasCircularReference unit tests -----------------------------------------

describe('hasCircularReference', () => {
  it('returns false for primitives', () => {
    expect(hasCircularReference(null)).toBe(false);
    expect(hasCircularReference(undefined)).toBe(false);
    expect(hasCircularReference(42)).toBe(false);
    expect(hasCircularReference('hello')).toBe(false);
    expect(hasCircularReference(true)).toBe(false);
  });

  it('returns false for plain non-circular objects', () => {
    expect(hasCircularReference({})).toBe(false);
    expect(hasCircularReference({ a: 1, b: { c: 2 } })).toBe(false);
  });

  it('returns false for non-circular arrays', () => {
    expect(hasCircularReference([])).toBe(false);
    expect(hasCircularReference([1, 2, [3, 4]])).toBe(false);
  });

  it('detects self-referencing object', () => {
    const obj: any = { name: 'Self' };
    obj.self = obj;
    expect(hasCircularReference(obj)).toBe(true);
  });

  it('detects two-node cycle', () => {
    const a: any = { name: 'A' };
    const b: any = { name: 'B' };
    a.friend = b;
    b.friend = a;
    expect(hasCircularReference(a)).toBe(true);
  });

  it('detects three-node cycle', () => {
    const a: any = {};
    const b: any = {};
    const c: any = {};
    a.next = b;
    b.next = c;
    c.next = a;
    expect(hasCircularReference(a)).toBe(true);
  });

  it('detects circular array', () => {
    const arr: any[] = [1, 2];
    arr.push(arr);
    expect(hasCircularReference(arr)).toBe(true);
  });

  it('returns false for diamond (shared but not circular)', () => {
    const shared = { value: 42 };
    const parent = { left: shared, right: shared };
    expect(hasCircularReference(parent)).toBe(false);
  });

  it('skips class instances (not plain objects)', () => {
    class Node {
      next: any = null;
    }
    const a = new Node();
    const b = new Node();
    a.next = b;
    b.next = a;
    // Class instances are skipped — no circular detection
    expect(hasCircularReference(a)).toBe(false);
  });

  it('skips Date, Map, Set', () => {
    expect(hasCircularReference(new Date())).toBe(false);
    expect(hasCircularReference(new Map())).toBe(false);
    expect(hasCircularReference(new Set())).toBe(false);
  });

  it('detects deep nested circular', () => {
    const obj: any = { a: { b: { c: { d: {} } } } };
    obj.a.b.c.d.backToRoot = obj;
    expect(hasCircularReference(obj)).toBe(true);
  });
});

// -- enableDevMode / disableDevMode ------------------------------------------

describe('dev mode toggle', () => {
  beforeEach(() => {
    disableDevMode(); // ensure clean state from prior tests
  });
  afterEach(() => {
    disableDevMode();
  });

  it('starts disabled', () => {
    expect(isDevMode()).toBe(false);
  });

  it('enableDevMode turns it on', () => {
    enableDevMode();
    expect(isDevMode()).toBe(true);
  });

  it('disableDevMode turns it off', () => {
    enableDevMode();
    disableDevMode();
    expect(isDevMode()).toBe(false);
  });
});

// -- Integration: setValue warns in dev mode ----------------------------------

describe('dev-mode warning in setValue', () => {
  afterEach(() => {
    disableDevMode();
  });

  it('warns on circular value when dev mode is enabled', async () => {
    enableDevMode();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { ScopeFacade } = await import('../../../../src/lib/scope/ScopeFacade');
    const { SharedMemory } = await import('../../../../src/lib/memory/SharedMemory');
    const { EventLog } = await import('../../../../src/lib/memory/EventLog');
    const { StageContext } = await import('../../../../src/lib/memory/StageContext');

    const mem = new SharedMemory();
    const log = new EventLog();
    const ctx = new StageContext('run-1', 'test-stage', 'test-stage', mem, '', log);
    const scope = new ScopeFacade(ctx, 'test-stage');

    const circular: any = { name: 'Alice' };
    circular.self = circular;

    scope.setValue('user', circular);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Circular reference detected'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("setValue('user')"));

    warnSpy.mockRestore();
  });

  it('does NOT warn when dev mode is disabled', async () => {
    disableDevMode();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { ScopeFacade } = await import('../../../../src/lib/scope/ScopeFacade');
    const { SharedMemory } = await import('../../../../src/lib/memory/SharedMemory');
    const { EventLog } = await import('../../../../src/lib/memory/EventLog');
    const { StageContext } = await import('../../../../src/lib/memory/StageContext');

    const mem = new SharedMemory();
    const log = new EventLog();
    const ctx = new StageContext('run-1', 'test-stage', 'test-stage', mem, '', log);
    const scope = new ScopeFacade(ctx, 'test-stage');

    const circular: any = { name: 'Alice' };
    circular.self = circular;

    scope.setValue('user', circular);

    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('does NOT warn for non-circular values', async () => {
    enableDevMode();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { ScopeFacade } = await import('../../../../src/lib/scope/ScopeFacade');
    const { SharedMemory } = await import('../../../../src/lib/memory/SharedMemory');
    const { EventLog } = await import('../../../../src/lib/memory/EventLog');
    const { StageContext } = await import('../../../../src/lib/memory/StageContext');

    const mem = new SharedMemory();
    const log = new EventLog();
    const ctx = new StageContext('run-1', 'test-stage', 'test-stage', mem, '', log);
    const scope = new ScopeFacade(ctx, 'test-stage');

    scope.setValue('name', 'Alice');
    scope.setValue('data', { nested: { value: 42 } });

    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
