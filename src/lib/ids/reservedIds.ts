/**
 * reservedIds — the ONE refusal the engine's id doors ask (9.37.0, R5; its own file since C6).
 *
 * A user-authored id may not carry the grammar's delimiters (`#`, `/`), and a path segment may not
 * carry the generated-segment marker (`~`). This is the engine's rule about which ids it admits,
 * not part of the grammar: the grammar (`runtimeStageId.ts`, the record's) builds, parses and
 * reads ids and imports nothing; this file reads its delimiters and the `~` grammar
 * (`branchSegment.ts`), so the record no longer imports the engine's segment rule.
 *
 * Asked at the builder's id doors and at the run-time dynamic-StageNode door ONLY — never by the
 * prefixer (which writes `/` on purpose) and never by a store (which holds runtimeStageIds).
 */

import { branchSegmentReservationMessage, hasBranchSegmentMarker } from './branchSegment.js';
import { EXECUTION_DELIMITER, PATH_DELIMITER } from './runtimeStageId.js';

/**
 * Where a user-authored id sits in the grammar — what the builder admits it as.
 *
 * - `'stage'`   — a stage id (`stageId` position): `#` and `/` are refused.
 * - `'segment'` — a subflow id or a `parallelForEach` id (a PATH SEGMENT, or
 *   the parent of a generated one): `~` is refused too (see `branchSegment.ts`).
 */
export type IdPosition = 'stage' | 'segment';

/**
 * The builder's ONE refusal for user-authored ids (RFC 3986 §2.2 — the
 * grammar's delimiters are reserved, so a user id can never fake a subflow
 * path or an execution suffix). Returns the refusal sentence, or `undefined`
 * when the id is admissible; the builder turns a sentence into its own error.
 *
 * The `~` sentence is `branchSegmentReservationMessage`'s, byte-for-byte, so a
 * pre-9.37.0 refusal reads the same.
 *
 * @param what     How the error names the id (`"subflow id"`, `"addFunction id"`).
 * @param id       The id as the user wrote it.
 * @param position Where the id sits in the grammar.
 */
export function refuseReservedId(what: string, id: string, position: IdPosition): string | undefined {
  // A missing / non-string id is not this rule's business — the door's own checks own it.
  if (typeof id !== 'string') return undefined;
  if (position === 'segment' && hasBranchSegmentMarker(id)) return branchSegmentReservationMessage(what, id);
  for (const delimiter of [PATH_DELIMITER, EXECUTION_DELIMITER]) {
    if (!id.includes(delimiter)) continue;
    return (
      `${what} '${id}' contains the reserved character '${delimiter}'. ` +
      `From 9.37.0 '${PATH_DELIMITER}' and '${EXECUTION_DELIMITER}' are reserved for the runtimeStageId grammar ` +
      `([subflowPath${PATH_DELIMITER}]stageId${EXECUTION_DELIMITER}executionIndex) — allowing one here would let a ` +
      'hand-authored id read as a subflow path or an execution suffix and silently mis-attribute its trace. ' +
      'Rename the id (a dash reads the same).'
    );
  }
  return undefined;
}
