import { admitOutsideInputNames } from '../attempt/outsideInputNames.js';
import { BRANCH_SEGMENT_MARKER, hasBranchSegmentMarker } from '../ids/branchSegment.js';
import type { SerializedPipelineStructure, StageNode } from './types.js';

const fail = (msg: string): never => {
  throw new Error(`[FlowChartBuilder] ${msg}`);
};

/**
 * Attach declared tags to a stage node + its spec node.
 *
 * The ONE place tags land on a node — the twin of {@link applyRetryPolicy} —
 * shared by the `.tag()` cursor modifier and every `options.tags` declaration
 * site, so the refusals and the spec's mirror can never drift between them.
 *
 * A tag is a NAME declared at build time, never a value, so every refusal is
 * about the name's shape: an empty string names nothing; a non-string is a
 * value, and a value on a stage would ride the commit log past every
 * redaction point; the branch-segment marker is the runtimeStageId grammar's
 * one reserved byte, and a consumer that puts a tag into a path (a URL, a
 * store key) would inherit exactly the ambiguity the reservation exists to
 * prevent; a name declared twice is the typo it usually is. Refused at BUILD
 * time, like `retry.attempts`, so the mistake fails while the chart is being
 * written. An EMPTY list lands nothing: "absent when empty" is the law the
 * commit bundle keeps, and the spec keeps it too.
 */
export function applyTags(
  node: StageNode<any, any>,
  spec: SerializedPipelineStructure,
  tags: readonly string[] | undefined,
  where: string,
): void {
  if (tags === undefined) return;
  if (!Array.isArray(tags)) fail(`${where}: tags must be an array of names (got ${typeof tags})`);
  if (tags.length === 0) return;
  const seen = new Set<string>();
  for (const tag of tags) {
    if (typeof tag !== 'string') {
      fail(
        `${where}: a tag must be a string name (got ${tag === null ? 'null' : typeof tag}). A tag is a NAME ` +
          'declared at build time — a value belongs in state or in $emit, never on the stage.',
      );
    }
    if (tag.trim().length === 0) fail(`${where}: a tag cannot be an empty string`);
    if (hasBranchSegmentMarker(tag)) {
      fail(
        `${where}: tag '${tag}' contains the reserved character '${BRANCH_SEGMENT_MARKER}'. ` +
          `'${BRANCH_SEGMENT_MARKER}' is reserved for the subflow path segments addParallelForEach() generates, ` +
          'and a tag that a consumer puts into a path or a key would inherit that ambiguity. Rename the tag ' +
          '(a dash or a colon reads the same). See docs/design/2026-09-declared-tags.md.',
      );
    }
    if (seen.has(tag)) fail(`${where}: tag '${tag}' is declared twice`);
    seen.add(tag);
  }
  if (node.tags) {
    fail(
      `${where}: tags already declared at '${node.name}' (${node.tags.join(', ')}) — declare every tag for a ` +
        'stage in ONE place, so the Map advertises the whole vocabulary from a single site.',
    );
  }
  // The node's copy is frozen: commit bundles share it by reference and the
  // library's reads are borrowed, never mutated. The spec's copy is its own
  // plain array, JSON-safe like the rest of the spec.
  node.tags = Object.freeze([...tags]);
  spec.tags = [...tags];
}

/** Keep the stage and its spec on the same validated, public source names. */
export function applyOutsideInputs(
  node: StageNode,
  spec: SerializedPipelineStructure,
  names: readonly string[] | undefined,
  where: string,
): void {
  const admitted = admitOutsideInputNames(names, `[FlowChartBuilder] ${where}`);
  if (admitted === undefined) return;
  if (node.outsideInputs !== undefined) fail(`${where}: outside inputs are already declared on this stage`);

  node.outsideInputs = admitted;
  spec.outsideInputs = [...admitted];
}
