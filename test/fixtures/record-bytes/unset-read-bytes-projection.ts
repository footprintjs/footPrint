import { expect } from 'vitest';

/** The one historical fixture with an unset read keeps its original pin. Check this addition before projecting it. */
export function projectUnsetReadNames(name: string, text: string): string {
  if (name !== 'readTiers') return text;
  const value = JSON.parse(text) as {
    snapshot: {
      executionTree: {
        next: { id: string; runtimeStageId: string; stageReads: Record<string, unknown>; undefinedReadKeys?: string[] };
      };
    };
  };
  const stage = value.snapshot.executionTree.next;
  expect(stage.runtimeStageId).toBe('after-first-write#1');
  expect(stage.id).toBe('after-first-write');
  expect(stage.stageReads).toEqual({ x: '«undefined»' });
  expect(stage.undefinedReadKeys).toEqual(['x']);
  delete stage.undefinedReadKeys;
  return JSON.stringify(value, null, 2) + '\n';
}
