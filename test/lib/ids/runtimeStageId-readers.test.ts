/**
 * The grammar's one owner (F7) — the readers every parser now calls instead of
 * splitting on `#` / `/` itself, and the one refusal the builder's doors ask.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { branchSegmentReservationMessage, buildBranchSegment } from '../../../src/lib/ids/branchSegment.js';
import {
  buildRuntimeStageId,
  executionIndexOf,
  isExecutionKey,
  isWithinSubflow,
  joinPath,
  lastSegmentOf,
  parseRuntimeStageId,
  pathSegments,
  refuseReservedId,
  splitStageId,
  stageIdOf,
  subflowPathOf,
  subflowSegmentsOf,
} from '../../../src/lib/ids/runtimeStageId.js';

describe('the readers', () => {
  it('read a nested execution key', () => {
    const rid = 'sf-a/sf-b/stage#12';
    expect(isExecutionKey(rid)).toBe(true);
    expect(stageIdOf(rid)).toBe('sf-a/sf-b/stage');
    expect(executionIndexOf(rid)).toBe(12);
    expect(subflowPathOf(rid)).toBe('sf-a/sf-b');
    expect(subflowSegmentsOf(rid)).toEqual(['sf-a', 'sf-b']);
  });

  it('read a top-level execution key and a bare path', () => {
    expect(subflowPathOf('seed#0')).toBeUndefined();
    expect(subflowSegmentsOf('seed#0')).toEqual([]);
    expect(isExecutionKey('sf-a/sf-b')).toBe(false);
    expect(stageIdOf('sf-a/sf-b')).toBe('sf-a/sf-b');
    expect(Number.isNaN(executionIndexOf('sf-a/sf-b'))).toBe(true);
  });

  it('a generated branch segment is opaque to them — `~` is never special-cased', () => {
    const rid = buildRuntimeStageId('count', 19, buildBranchSegment('review', 0));
    expect(rid).toBe('review~0/count#19');
    expect(subflowPathOf(rid)).toBe('review~0');
    expect(stageIdOf(rid)).toBe('review~0/count');
  });

  it('path helpers: segments drop empties, last segment, join, within', () => {
    expect(pathSegments('/a//b/')).toEqual(['a', 'b']);
    expect(lastSegmentOf('a/b/c')).toBe('c');
    expect(lastSegmentOf('solo')).toBe('solo');
    expect(joinPath('a', 'b', 'c')).toBe('a/b/c');
    expect(isWithinSubflow('sf/a/b', 'sf')).toBe(true);
    expect(isWithinSubflow('sf-x/a', 'sf')).toBe(false);
    expect(isWithinSubflow('sf', 'sf')).toBe(false);
  });

  it('property: build → read round-trips for every id the builder admits', () => {
    const segment = fc.stringMatching(/^[a-z][a-z0-9~-]{0,6}$/);
    fc.assert(
      fc.property(
        fc.array(segment, { maxLength: 3 }),
        fc.stringMatching(/^[a-z][a-z0-9-]{0,6}$/),
        fc.nat(),
        (path, id, n) => {
          const subflowPath = path.length > 0 ? joinPath(...path) : undefined;
          const rid = buildRuntimeStageId(id, n, subflowPath);
          expect(isExecutionKey(rid)).toBe(true);
          expect(executionIndexOf(rid)).toBe(n);
          expect(subflowPathOf(rid)).toBe(subflowPath);
          expect(subflowSegmentsOf(rid)).toEqual(path);
          expect(stageIdOf(rid)).toBe(subflowPath ? `${subflowPath}/${id}` : id);
          expect(parseRuntimeStageId(rid)).toEqual({ stageId: id, executionIndex: n, subflowPath });
          expect(splitStageId(stageIdOf(rid)).subflowPath).toBe(subflowPath);
        },
      ),
    );
  });
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
        expect(subflowPathOf(rid)).toBeUndefined();
        expect(stageIdOf(rid)).toBe(id);
        expect(isExecutionKey(id)).toBe(false);
      }),
    );
  });
});
