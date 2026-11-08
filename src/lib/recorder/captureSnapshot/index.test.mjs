import { describe, expect, it } from 'vitest';

import { HistoryDataError, MAX_HISTORY_DATA_DEPTH, MAX_HISTORY_DATA_NODES } from '../../capture/historyData.js';
import { captureRecorderSnapshot, createCaptureSnapshotContext, registerCaptureSnapshot } from './index.js';

describe('bounded automatic recorder snapshot dispatch', () => {
  it('calls an unregistered hook once with its owner, leaving returned data untouched', () => {
    let calls = 0;
    let dataReads = 0;
    const bundle = Object.defineProperty({ name: 'Returned' }, 'data', {
      enumerable: true,
      get() {
        dataReads++;
        return 'not admitted here';
      },
    });
    const owner = {
      toSnapshot() {
        calls++;
        expect(this).toBe(owner);
        return bundle;
      },
    };
    expect(captureRecorderSnapshot(owner, createCaptureSnapshotContext())).toBe(bundle);
    expect(calls).toBe(1);
    expect(dataReads).toBe(0);
  });

  it.each(['getter', 'replacement'])('ignores an unregistered hook own call %s', (kind) => {
    let hookCalls = 0;
    let ownCallUses = 0;
    const bundle = { name: 'Actual hook', data: {} };
    function hook() {
      hookCalls++;
      expect(this).toBe(owner);
      return bundle;
    }
    const replacement = () => {
      ownCallUses++;
      return bundle;
    };
    Object.defineProperty(
      hook,
      'call',
      kind === 'getter'
        ? {
            get() {
              ownCallUses++;
              return replacement;
            },
          }
        : { value: replacement },
    );
    const owner = { toSnapshot: hook };
    expect(captureRecorderSnapshot(owner, createCaptureSnapshotContext())).toBe(bundle);
    expect(hookCalls).toBe(1);
    expect(ownCallUses).toBe(0);
  });

  it('dispatches a registered strategy by the exact hook identity and reads that hook once', () => {
    let hookCalls = 0;
    let hookReads = 0;
    let strategyCalls = 0;
    const context = createCaptureSnapshotContext();
    const expected = { name: 'Capture', data: { kept: 4 } };
    function explicitHook() {
      hookCalls++;
      return { name: 'Explicit', data: {} };
    }
    const owner = Object.defineProperty({}, 'toSnapshot', {
      get() {
        hookReads++;
        return explicitHook;
      },
    });
    registerCaptureSnapshot(explicitHook, (receivedOwner, receivedContext) => {
      strategyCalls++;
      expect(receivedOwner).toBe(owner);
      expect(receivedContext).toBe(context);
      return expected;
    });
    expect(captureRecorderSnapshot(owner, context)).toBe(expected);
    expect(hookReads).toBe(1);
    expect(hookCalls).toBe(0);
    expect(strategyCalls).toBe(1);
  });

  it('respects an override instead of borrowing the registered base hook strategy', () => {
    let strategyCalls = 0;
    let overrideCalls = 0;
    const prototype = {
      toSnapshot() {
        return { name: 'Base', data: {} };
      },
    };
    registerCaptureSnapshot(prototype.toSnapshot, () => {
      strategyCalls++;
      return { name: 'Capture', data: {} };
    });
    const expected = { name: 'Override', data: {} };
    const owner = Object.assign(Object.create(prototype), {
      toSnapshot() {
        overrideCalls++;
        expect(this).toBe(owner);
        return expected;
      },
    });
    expect(captureRecorderSnapshot(owner, createCaptureSnapshotContext())).toBe(expected);
    expect(strategyCalls).toBe(0);
    expect(overrideCalls).toBe(1);
  });

  it.each(['hook', 'strategy'])('preserves a thrown %s identity and releases active ownership', (kind) => {
    const original = Object.freeze({ original: kind });
    const context = createCaptureSnapshotContext();
    let fail = true;
    let calls = 0;
    const expected = { name: 'Recovered collection', data: {} };
    const body = () => {
      calls++;
      if (fail) throw original;
      return expected;
    };
    const owner = { toSnapshot: body };
    if (kind === 'strategy') registerCaptureSnapshot(body, body);
    let rejected;
    try {
      captureRecorderSnapshot(owner, context);
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBe(original);
    fail = false;
    expect(captureRecorderSnapshot(owner, context)).toBe(expected);
    expect(calls).toBe(2);
  });

  function graphStrategy(visited) {
    function explicitHook() {
      throw new Error('registered capture must not call the explicit hook');
    }
    registerCaptureSnapshot(explicitHook, (owner, context) => {
      visited.push(owner.id);
      return {
        name: owner.id,
        data: owner.children.map((child) => captureRecorderSnapshot(child, context)),
      };
    });
    return (id, children = []) => ({ id, children, toSnapshot: explicitHook });
  }

  it.each(['self', 'mutual'])('refuses a %s cycle before entering its owner twice, then releases the path', (kind) => {
    const visited = [];
    const node = graphStrategy(visited);
    const root = node('root');
    const other = kind === 'self' ? root : node('other', [root]);
    root.children = [other];
    const context = createCaptureSnapshotContext();
    expect(() => captureRecorderSnapshot(root, context)).toThrow(HistoryDataError);
    expect(visited).toEqual(kind === 'self' ? ['root'] : ['root', 'other']);
    root.children = [];
    expect(captureRecorderSnapshot(root, context)).toEqual({ name: 'root', data: [] });
    expect(visited.at(-1)).toBe('root');
  });

  it('allows shared DAG children on different paths rather than treating them as a cycle', () => {
    const visited = [];
    const node = graphStrategy(visited);
    const leaf = node('leaf');
    const root = node('root', [node('left', [leaf]), node('right', [leaf])]);
    const result = captureRecorderSnapshot(root, createCaptureSnapshotContext());
    expect(visited).toEqual(['root', 'left', 'leaf', 'right', 'leaf']);
    expect(result.data[0].data[0]).toEqual({ name: 'leaf', data: [] });
    expect(result.data[1].data[0]).toEqual({ name: 'leaf', data: [] });
  });

  it('admits a root at depth zero and refuses the next owner beyond the shared depth limit', () => {
    const visited = [];
    const node = graphStrategy(visited);
    let root = node('leaf');
    for (let depth = 0; depth < MAX_HISTORY_DATA_DEPTH; depth++) root = node(`depth-${depth}`, [root]);
    const context = createCaptureSnapshotContext();
    expect(() => captureRecorderSnapshot(root, context)).not.toThrow();
    expect(visited).toHaveLength(MAX_HISTORY_DATA_DEPTH + 1);
    visited.length = 0;
    const tooDeep = node('extra', [root]);
    expect(() => captureRecorderSnapshot(tooDeep, context)).toThrow(HistoryDataError);
    expect(visited).toHaveLength(MAX_HISTORY_DATA_DEPTH + 1);
    expect(visited).not.toContain('leaf');
    // All owners on the refused path are released, including the root that caught no error itself.
    expect(captureRecorderSnapshot(tooDeep.children[0].children[0], context).name).toBe(
      tooDeep.children[0].children[0].id,
    );
  });

  it('shares one exact row budget across registered and unregistered calls in the same collection', () => {
    const context = createCaptureSnapshotContext();
    let hookCalls = 0;
    let strategyCalls = 0;
    const plain = {
      toSnapshot() {
        hookCalls++;
        return { name: 'Plain', data: {} };
      },
    };
    function registeredHook() {
      throw new Error('explicit hook must not run');
    }
    registerCaptureSnapshot(registeredHook, () => {
      strategyCalls++;
      return { name: 'Registered', data: {} };
    });
    const registered = { toSnapshot: registeredHook };
    for (let row = 0; row < MAX_HISTORY_DATA_NODES - 1; row++) captureRecorderSnapshot(plain, context);
    captureRecorderSnapshot(registered, context);
    expect(() => captureRecorderSnapshot(plain, context)).toThrow(HistoryDataError);
    expect(() => captureRecorderSnapshot(registered, context)).toThrow(HistoryDataError);
    expect(hookCalls).toBe(MAX_HISTORY_DATA_NODES - 1);
    expect(strategyCalls).toBe(1);
    // A fresh collection owns an independent budget.
    captureRecorderSnapshot(plain, createCaptureSnapshotContext());
    expect(hookCalls).toBe(MAX_HISTORY_DATA_NODES);
  });

  it('charges recursive children to the same row budget before a further child hook executes', () => {
    const context = createCaptureSnapshotContext();
    let leafCalls = 0;
    const leaf = {
      toSnapshot() {
        leafCalls++;
        return { name: 'Leaf', data: {} };
      },
    };
    function rootHook() {
      throw new Error('explicit hook must not run');
    }
    registerCaptureSnapshot(rootHook, (_owner, shared) => {
      for (let row = 0; row < MAX_HISTORY_DATA_NODES; row++) captureRecorderSnapshot(leaf, shared);
      return { name: 'Root', data: {} };
    });
    expect(() => captureRecorderSnapshot({ toSnapshot: rootHook }, context)).toThrow(HistoryDataError);
    expect(leafCalls).toBe(MAX_HISTORY_DATA_NODES - 1);
  });
});
