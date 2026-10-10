/**
 * The grammar's one owner (F7) — the readers every parser now calls instead of
 * splitting on `#` / `/` itself — and the one refusal the engine's id doors ask
 * (`reservedIds.ts` since C6: the grammar is the record's and imports nothing).
 */
import fc from 'fast-check';
import { buildRuntimeStageId, isExecutionKey, parseRuntimeStageId, stageIdOf } from 'foottrace';
import { describe, expect, it } from 'vitest';

import { branchSegmentReservationMessage, buildBranchSegment } from '../../../src/lib/ids/branchSegment.js';
import { refuseReservedId } from '../../../src/lib/ids/reservedIds.js';

it('the record grammar reads a generated engine branch segment as an ordinary path', () => {
  const rid = buildRuntimeStageId('count', 19, buildBranchSegment('review', 0));
  expect(rid).toBe('review~0/count#19');
  expect(parseRuntimeStageId(rid).subflowPath).toBe('review~0');
  expect(stageIdOf(rid)).toBe('review~0/count');
});

describe('refuseReservedId — the one refusal', () => {
  it('admits a plain id in both positions', () => {
    expect(refuseReservedId('stage id', 'call-llm', 'stage')).toBeUndefined();
    expect(refuseReservedId('subflow id', 'sf-tools', 'segment')).toBeUndefined();
  });

  it('refuses `#` and `/` in both positions, naming the character', () => {
    for (const position of ['stage', 'segment'] as const) {
      expect(refuseReservedId('stage id', 'ns/a', position)).toMatch(/'ns\/a' contains the reserved character '\/'/);
      expect(refuseReservedId('stage id', 'sf#1', position)).toMatch(/'sf#1' contains the reserved character '#'/);
    }
  });

  it('refuses `~` only in a segment, with the 9.14.0 sentence', () => {
    expect(refuseReservedId('stage id', 'a~1', 'stage')).toBeUndefined();
    expect(refuseReservedId('subflow id', 'a~1', 'segment')).toBe(branchSegmentReservationMessage('subflow id', 'a~1'));
  });

  it('leaves a missing id to the door (non-string → no verdict)', () => {
    expect(refuseReservedId('stage id', undefined as unknown as string, 'stage')).toBeUndefined();
  });

  it('probe3 is refused at build: no admitted id can fake a subflow or an execution', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 8 }), (id) => {
        if (refuseReservedId('stage id', id, 'stage') !== undefined) return;
        // Admitted ⇒ the grammar reads it back as exactly one top-level stage.
        const rid = buildRuntimeStageId(id, 3);
        expect(parseRuntimeStageId(rid).subflowPath).toBeUndefined();
        expect(stageIdOf(rid)).toBe(id);
        expect(isExecutionKey(id)).toBe(false);
      }),
    );
  });
});
