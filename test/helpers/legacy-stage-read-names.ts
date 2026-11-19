import { expect } from 'vitest';

import type { StageSnapshot } from '../../src/lib/memory/frameTypes.js';

/** Remove only the verified addition when comparing a stage tree against pre-field records. */
export function projectLegacyStageReadNames(stage: StageSnapshot): StageSnapshot {
  const { undefinedReadKeys, ...legacy } = stage;
  if (undefinedReadKeys !== undefined) {
    const reads = stage.stageReads ?? {};
    const expected = Object.keys(reads).filter((key) => reads[key] === undefined);
    expect(expected.length).toBeGreaterThan(0);
    expect(undefinedReadKeys).toEqual(expected);
  }
  if (stage.next) legacy.next = projectLegacyStageReadNames(stage.next);
  if (stage.children) legacy.children = stage.children.map(projectLegacyStageReadNames);
  return legacy;
}
