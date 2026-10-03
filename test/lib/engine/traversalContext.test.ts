/**
 * `engine/traversalContext.ts` — the ONE constructor of the correlation stamp
 * (F7). Key order and key presence are part of the bytes a recorder sees, so
 * they are pinned here as they were written by hand before 9.37.0.
 */
import { describe, expect, it } from 'vitest';

import {
  resumeTraversalContext,
  rootTraversalContext,
  traversalContextFor,
} from '../../../src/lib/engine/traversalContext.js';
import { buildRuntimeStageId } from '../../../src/lib/ids/runtimeStageId.js';

describe('traversalContextFor', () => {
  it('a stage stamp keeps the 9.36.0 key order, and its always-present keys even when undefined', () => {
    const ctx = traversalContextFor({
      runId: 'r',
      stageId: 's',
      runtimeStageId: 's#0',
      stageName: 'S',
      parentStageId: undefined,
      parentRuntimeStageId: undefined,
      loopIteration: undefined,
      subflowId: undefined,
      subflowPath: undefined,
    });
    expect(Object.keys(ctx)).toEqual([
      'runId',
      'stageId',
      'runtimeStageId',
      'stageName',
      'parentStageId',
      'subflowId',
      'subflowPath',
      'depth',
    ]);
  });

  it('depth has one meaning: the subflow nesting of the address', () => {
    const at = (runtimeStageId: string) =>
      traversalContextFor({ runId: 'r', stageId: 's', runtimeStageId, stageName: 'S' }).depth;
    expect(at('s#0')).toBe(0);
    expect(at('sf/s#3')).toBe(1);
    expect(at('review~2/score#14')).toBe(1);
    expect(at('sf-out/sf-in/ask#5')).toBe(2);
  });

  it('writes parentRuntimeStageId / loopIteration only when they hold a value', () => {
    const ctx = traversalContextFor({
      runId: 'r',
      stageId: 's',
      runtimeStageId: 's#4',
      stageName: 'S',
      parentStageId: 'p',
      parentRuntimeStageId: 'p#3',
      loopIteration: 1,
      subflowId: 'sf',
      subflowPath: undefined,
    });
    expect(Object.keys(ctx)).toEqual([
      'runId',
      'stageId',
      'runtimeStageId',
      'stageName',
      'parentStageId',
      'parentRuntimeStageId',
      'loopIteration',
      'subflowId',
      'subflowPath',
      'depth',
    ]);
  });
});

describe('the two named shapes', () => {
  it('root: the run-boundary stamp is the 9.36.0 literal', () => {
    expect(rootTraversalContext('r')).toStrictEqual({
      runId: 'r',
      stageId: '__root__',
      runtimeStageId: '__root__#0',
      stageName: '__root__',
      depth: 0,
    });
  });

  it('resume at the top level: no subflow, depth 0, the link when known', () => {
    const ctx = resumeTraversalContext({
      runId: 'r2',
      stageId: 'gate',
      stageName: 'Gate',
      runtimeStageId: buildRuntimeStageId('gate', 2),
      subflowPath: [],
      resumedFrom: { runId: 'r1', runtimeStageId: 'gate#1' },
    });
    expect(ctx).toStrictEqual({
      runId: 'r2',
      stageId: 'gate',
      runtimeStageId: 'gate#2',
      stageName: 'Gate',
      depth: 0,
      resumedFrom: { runId: 'r1', runtimeStageId: 'gate#1' },
    });
  });

  it('resume inside nested subflows: the innermost subflow and how deep it is', () => {
    const ctx = resumeTraversalContext({
      runId: 'r2',
      stageId: 'sf-out/sf-in/ask',
      stageName: 'Ask',
      runtimeStageId: buildRuntimeStageId('sf-out/sf-in/ask', 8),
      subflowPath: ['sf-out', 'sf-out/sf-in'],
    });
    expect(ctx.subflowId).toBe('sf-out/sf-in');
    expect(ctx.depth).toBe(2);
    expect(ctx).not.toHaveProperty('resumedFrom');
  });
});
