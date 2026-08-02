/**
 * The generated-segment grammar — `<parentStageId>~<branchIndex>`.
 *
 * Design: docs/design/execution-control.md (D1). This is the ONE module that
 * knows the marker, so this is where the marker's properties get pinned:
 * the round trip is exact, the marker is refused where it could collide, and
 * a segment stays opaque to every parser in the library.
 *
 * Test types: Unit (build/parse/round-trip) · Functional (marker choice
 * properties) · Property (round-trip over random ids + indices) ·
 * Security (no id can forge a segment that parses as another stage's) ·
 * Performance (parsing is not a hot-path cost).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  BRANCH_SEGMENT_MARKER,
  branchSegmentReservationMessage,
  buildBranchSegment,
  hasBranchSegmentMarker,
  isBranchSegment,
  parseBranchSegment,
} from '../../../src/lib/engine/branchSegment.js';
import { parseRuntimeStageId, splitStageId } from '../../../src/lib/engine/runtimeStageId.js';

describe('branchSegment — the generated-segment grammar', () => {
  // ── Unit ────────────────────────────────────────────────────
  describe('build + parse', () => {
    it('builds `<parentStageId>~<index>`', () => {
      expect(buildBranchSegment('review-chunks', 0)).toBe('review-chunks~0');
      expect(buildBranchSegment('review-chunks', 12)).toBe('review-chunks~12');
    });

    it('composes with a subflow prefix, so a nested chart needs no special case', () => {
      expect(buildBranchSegment('outer/review-chunks', 3)).toBe('outer/review-chunks~3');
    });

    it('round-trips exactly', () => {
      expect(parseBranchSegment(buildBranchSegment('review-chunks', 7))).toEqual({
        parentStageId: 'review-chunks',
        index: 7,
      });
    });

    it('rejects anything that is not a generated segment', () => {
      for (const notASegment of ['sf-tools', '', '~', '~3', 'stage~', 'stage~x', 'stage~-1', 'stage~1.5']) {
        expect(parseBranchSegment(notASegment)).toBeUndefined();
        expect(isBranchSegment(notASegment)).toBe(false);
      }
    });

    it('splits at the LAST marker — unambiguous because parent ids may not carry one', () => {
      // The builder refuses `~` in a parallelForEach id, so this input cannot
      // be produced by the library. The rule is still pinned: last marker wins.
      expect(parseBranchSegment('a~b~4')).toEqual({ parentStageId: 'a~b', index: 4 });
    });

    it('detects the marker anywhere in a string (what the build-time refusals use)', () => {
      expect(hasBranchSegmentMarker('plain-id')).toBe(false);
      expect(hasBranchSegmentMarker('sneaky~id')).toBe(true);
      expect(hasBranchSegmentMarker('~')).toBe(true);
    });
  });

  // ── Functional — why THIS byte ──────────────────────────────
  describe('marker choice', () => {
    it('is the tilde, and is neither of the two grammar delimiters', () => {
      expect(BRANCH_SEGMENT_MARKER).toBe('~');
      expect(BRANCH_SEGMENT_MARKER).not.toBe('/');
      expect(BRANCH_SEGMENT_MARKER).not.toBe('#');
    });

    it('is URL-safe (RFC 3986 unreserved) — trace viewers put segments in links', () => {
      expect(encodeURIComponent(BRANCH_SEGMENT_MARKER)).toBe(BRANCH_SEGMENT_MARKER);
    });

    it('is not a regex metacharacter — a consumer building a RegExp from a segment is safe', () => {
      // If the marker were `^ ! * + ? [ ] |`, this pattern would either throw
      // or match something other than the literal segment.
      const literal = new RegExp(`^${buildBranchSegment('fanout', 2)}$`);
      expect(literal.test('fanout~2')).toBe(true);
      expect(literal.test('fanoutX2')).toBe(false);
    });
  });

  // ── Integration — opacity to the shipped parsers ────────────
  describe('the shipped parsers read a generated segment as an ordinary path segment', () => {
    it('parseRuntimeStageId splits a branch stage id correctly, unmodified', () => {
      const parsed = parseRuntimeStageId(`${buildBranchSegment('review-chunks', 2)}/score#14`);
      expect(parsed).toEqual({ stageId: 'score', executionIndex: 14, subflowPath: 'review-chunks~2' });
    });

    it('splitStageId decomposes the prefixed id the same way', () => {
      expect(splitStageId(`${buildBranchSegment('review-chunks', 2)}/score`)).toEqual({
        localStageId: 'score',
        subflowPath: 'review-chunks~2',
      });
    });

    it('nested inside a hand-authored subflow, the path keeps BOTH segments', () => {
      const parsed = parseRuntimeStageId(`sf-outer/${buildBranchSegment('fanout', 1)}/inner#9`);
      expect(parsed.subflowPath).toBe('sf-outer/fanout~1');
      expect(parsed.stageId).toBe('inner');
    });
  });

  // ── Security — forging ──────────────────────────────────────
  describe('collision safety', () => {
    it('a generated segment never contains a grammar delimiter of its own making', () => {
      const seg = buildBranchSegment('stage', 3);
      expect(seg.includes('#')).toBe(false);
      // The only '/' in a segment comes from the parent id's own subflow prefix.
      expect(buildBranchSegment('plain', 0).includes('/')).toBe(false);
    });

    it('the reservation message names the character, the reason and the design doc', () => {
      const msg = branchSegmentReservationMessage('subflow id', 'bad~id');
      expect(msg).toContain("'~'");
      expect(msg).toContain('bad~id');
      expect(msg).toContain('addParallelForEach');
      expect(msg).toContain('docs/design/execution-control.md');
    });
  });

  // ── Property ────────────────────────────────────────────────
  describe('property: round-trip', () => {
    it('parse(build(id, i)) === { id, i } for any marker-free id and any index', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 40 }).filter((s) => !s.includes('~')),
          fc.nat({ max: 100000 }),
          (parentStageId, index) => {
            const parsed = parseBranchSegment(buildBranchSegment(parentStageId, index));
            expect(parsed).toEqual({ parentStageId, index });
          },
        ),
        { numRuns: 300 },
      );
    });

    it('a marker-free string is never mistaken for a segment', () => {
      fc.assert(
        fc.property(
          fc.string({ maxLength: 40 }).filter((s) => !s.includes('~')),
          (id) => {
            expect(isBranchSegment(id)).toBe(false);
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  // ── Public surface ──────────────────────────────────────────
  describe('the grammar is reachable from footprintjs/trace', () => {
    it('exports the marker and the helpers next to parseRuntimeStageId', async () => {
      const trace = await import('../../../src/trace.js');
      expect(trace.BRANCH_SEGMENT_MARKER).toBe('~');
      expect(trace.buildBranchSegment('fanout', 1)).toBe('fanout~1');
      expect(trace.parseBranchSegment('fanout~1')).toEqual({ parentStageId: 'fanout', index: 1 });
      expect(trace.isBranchSegment('sf-tools')).toBe(false);
      expect(trace.hasBranchSegmentMarker('sf-tools')).toBe(false);
    });

    it('lets a consumer label a branch without the engine telling it', async () => {
      const { parseBranchSegment, parseRuntimeStageId } = await import('../../../src/trace.js');
      const { subflowPath } = parseRuntimeStageId('review-chunks~2/score#14');
      const branch = parseBranchSegment(subflowPath!)!;
      expect(`branch ${branch.index} of ${branch.parentStageId}`).toBe('branch 2 of review-chunks');
    });
  });

  // ── Performance ─────────────────────────────────────────────
  describe('performance', () => {
    it('100k build+parse round trips stay well under a frame', () => {
      const start = performance.now();
      for (let i = 0; i < 100_000; i++) parseBranchSegment(buildBranchSegment('review-chunks', i));
      expect(performance.now() - start).toBeLessThan(500);
    });
  });
});
