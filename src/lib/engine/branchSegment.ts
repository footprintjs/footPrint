/**
 * branchSegment — the grammar for GENERATED subflow path segments.
 *
 * Design: docs/design/execution-control.md (D1). This module is the ONE place
 * the generated-segment rule lives; every producer and every validator imports
 * it rather than re-spelling the format.
 *
 * ## The law
 *
 * A `parallelForEach` branch executes as a generated subflow whose path
 * segment is `<parentStageId>~<branchIndex>`. It rides the runtimeStageId
 * grammar that already exists — `[subflowPath/]stageId#executionIndex` — with
 * `#` and `/` keeping ONE meaning each:
 *
 *     review-chunks~2/score#14
 *     └── subflowPath ──┘└stage┘└idx┘
 *
 * There is deliberately NO third delimiter class. Every parser in the library
 * splits on the LAST `#` then the LAST `/`, so a generated segment is opaque
 * to all of them: `parseRuntimeStageId`, `splitStageId`, `ScopeFacade`'s
 * subflow-path derivation, `InOutRecorder`, `getSubtreeSnapshot`,
 * `DeferredObserverTier`, and the structure recorder all read a generated
 * branch exactly the way they read a hand-authored subflow. That is the whole
 * point of D1: branch commits reach `causalChain` / `sliceForKey` /
 * `forwardSliceForKey` with ZERO changes to those readers.
 *
 * ## Why the marker is reserved
 *
 * Stage ids and subflow ids are user-authored free-form strings. A marker that
 * could also appear in a user id would not crash — it would silently
 * mis-attribute, which is worse (the loop-ref precedent proves this codebase
 * tolerates deliberate id-collision classes). So the marker is REFUSED at
 * build time in the two positions that could collide with a generated segment:
 *
 *   1. user-authored SUBFLOW ids (every `addSubFlowChart*` / `addLazySubFlowChart*`
 *      entry point) — a subflow id IS a path segment;
 *   2. the id passed to `addParallelForEach()` — the generated segment embeds
 *      that id verbatim, so a parent id containing the marker would make
 *      `parseBranchSegment` ambiguous. Refusing it keeps the parse rule simple
 *      (split at the LAST marker) instead of clever.
 *
 * Stage ids elsewhere stay unvalidated: they occupy the `stageId` position,
 * never the `subflowPath` position, so they cannot collide with a segment.
 *
 * ## Marker choice (audited 2026-08-02)
 *
 * `~` (U+007E) appears in ZERO id literals across this repo's src, tests,
 * examples, docs and bench (852 distinct ids audited), and in zero ids across
 * the known consumer libraries. It is RFC-3986 *unreserved* (survives a URL
 * without percent-encoding — trace viewers put path segments in links) and is
 * NOT a regex metacharacter (unlike `^ ! * + ? [ ] |`), so a consumer building
 * a `RegExp` from a path segment cannot be silently surprised by it.
 */

/**
 * The reserved marker separating a parent stage id from a branch index in a
 * generated subflow path segment. Reserved from 9.14.0 forward — the builder
 * refuses it in user-authored subflow ids and in `addParallelForEach` ids.
 */
export const BRANCH_SEGMENT_MARKER = '~';

/**
 * Build the generated subflow path segment for one `parallelForEach` branch.
 *
 * @param parentStageId The fan-out stage's id (already subflow-prefixed when
 *                      the chart is mounted inside another chart, so nested
 *                      composition works without special handling).
 * @param index         The branch's position in the items array (0-based).
 *
 * @example
 * buildBranchSegment('review-chunks', 2)        // 'review-chunks~2'
 * buildBranchSegment('outer/review-chunks', 2)  // 'outer/review-chunks~2'
 */
export function buildBranchSegment(parentStageId: string, index: number): string {
  return `${parentStageId}${BRANCH_SEGMENT_MARKER}${index}`;
}

/** True when `value` contains the reserved marker anywhere. */
export function hasBranchSegmentMarker(value: string): boolean {
  return value.includes(BRANCH_SEGMENT_MARKER);
}

/**
 * True when `segment` is a generated branch segment — i.e. it splits at the
 * LAST marker into a non-empty parent id and a non-negative integer index.
 */
export function isBranchSegment(segment: string): boolean {
  return parseBranchSegment(segment) !== undefined;
}

/**
 * Decompose a generated branch segment back into its parts, or `undefined`
 * when `segment` is not one.
 *
 * Splitting at the LAST marker is unambiguous precisely because the builder
 * refuses the marker in the parent id (see the module doc) — no right-most
 * numeric-scanning heuristic is needed, and the round trip
 * `parseBranchSegment(buildBranchSegment(id, i))` is exact.
 *
 * @example
 * parseBranchSegment('review-chunks~2')  // { parentStageId: 'review-chunks', index: 2 }
 * parseBranchSegment('sf-tools')         // undefined
 */
export function parseBranchSegment(segment: string): { parentStageId: string; index: number } | undefined {
  const markerIdx = segment.lastIndexOf(BRANCH_SEGMENT_MARKER);
  if (markerIdx <= 0) return undefined; // absent, or nothing before it
  const indexPart = segment.slice(markerIdx + BRANCH_SEGMENT_MARKER.length);
  if (indexPart === '' || !/^\d+$/.test(indexPart)) return undefined;
  return { parentStageId: segment.slice(0, markerIdx), index: Number(indexPart) };
}

/**
 * The sentence every build-time refusal of the marker shares. Kept here so the
 * reservation is explained identically at all nine refusal sites.
 */
export function branchSegmentReservationMessage(what: string, id: string): string {
  return (
    `${what} '${id}' contains the reserved character '${BRANCH_SEGMENT_MARKER}'. ` +
    `From 9.14.0 '${BRANCH_SEGMENT_MARKER}' is reserved for the subflow path segments that ` +
    'addParallelForEach() generates for its branches — allowing it here would let a hand-authored ' +
    'id collide with a generated branch and silently mis-attribute its trace. Rename the id ' +
    '(a dash reads the same). See docs/design/execution-control.md.'
  );
}
