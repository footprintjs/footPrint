import { describe, expect, it } from 'vitest';

import { declareRetryLoopBudget, retryLoopBudget } from '../../../../src/lib/attempt/retryLoopContext.js';
import { detachStageTopology } from '../../../../src/lib/engine/graph/detachTopology.js';
import type { StageNode } from '../../../../src/lib/engine/graph/StageNode.js';
import { declaredRunComponentRoot, declareRunComponentRoot } from '../../../../src/lib/memory/RunComponent.js';

const node = (id: string): StageNode => ({ id, name: id });

describe('private runtime topology for a skipped-path capture', () => {
  it('pins the graph, preserves shared placements and keeps native component and retry identity', () => {
    const join = node('join');
    const left = { ...node('left'), next: join };
    const right = { ...node('right'), next: join };
    const root = { ...node('root'), children: [left, right] };
    const component = declareRunComponentRoot(left);
    declareRetryLoopBudget(right, { role: 'control', passes: 3 });

    const detached = detachStageTopology(root);
    if (!detached) throw new Error('Expected a detached chart');
    const [copiedLeft, copiedRight] = detached.root.children ?? [];
    expect(copiedLeft?.next).toBe(copiedRight?.next);
    expect(copiedLeft?.next).not.toBe(join);
    expect(detached.detachedOf(root)).toBe(detached.root);
    expect(detached.detachedOf(join)).toBe(copiedLeft?.next);
    expect(detached.authoredOf(copiedLeft)).toBe(left);
    expect(detached.authoredOf(copiedRight.next!)).toBe(join);
    expect(detached.detachedOf(node('join'))).toBeUndefined();
    expect(detached.authoredOf(join)).toBeUndefined();
    expect(declaredRunComponentRoot(copiedLeft)).toBe(component);
    expect(retryLoopBudget(copiedRight)).toEqual({ role: 'control', passes: 3 });
    expect(Object.isFrozen(detached.root.children)).toBe(true);
    expect(Object.isFrozen(detached.root)).toBe(true);
    expect(Object.isFrozen(root)).toBe(false);

    join.id = 'changed-elsewhere';
    root.children.push(node('later'));
    expect(copiedLeft?.next?.id).toBe('join');
    expect(detached.root.children).toHaveLength(2);
  });

  it('declines accessor-backed or over-budget topology without invoking the accessor', () => {
    let getterCalled = false;
    const root = node('root');
    Object.defineProperty(root, 'next', {
      enumerable: true,
      get: () => {
        getterCalled = true;
        return node('next');
      },
    });
    expect(detachStageTopology(root)).toBeUndefined();
    expect(getterCalled).toBe(false);
    expect(detachStageTopology(node('root'), 1)).toBeUndefined();
  });
});
