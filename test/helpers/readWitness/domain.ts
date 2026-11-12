import type { DeletedReadInput, HardWrittenReadInput, Receipt } from './observationTypes.js';
import { sameStageDeletedReadInputs, sameStageHardWrittenReadInputs } from './selector.js';

export type OracleDomain =
  | { readonly kind: 'in-domain' }
  | { readonly kind: 'out-of-domain'; readonly violations: readonly DeletedReadInput[] };
/** Only actual defined BASELINE returns after native tombstones exclude a program. */
export function oracleDomain(receipt: Receipt): OracleDomain {
  const violations = sameStageDeletedReadInputs(receipt).filter(({ read }) => read.result!.kind !== 'undefined');
  return violations.length
    ? Object.freeze({ kind: 'out-of-domain', violations: Object.freeze(violations) })
    : Object.freeze({ kind: 'in-domain' });
}
export class BuildTombstoneReadViolation extends Error {
  constructor(readonly violations: readonly DeletedReadInput[]) {
    super('BUILD returned a defined value after an unreestablished same-frame native tombstone.');
  }
}
/** Unconditional BUILD law; baseline classification is deliberately not an argument. */
export function assertBuildDeletedReadsUndefined(receipt: Receipt): void {
  const result = oracleDomain(receipt);
  if (result.kind === 'out-of-domain') throw new BuildTombstoneReadViolation(result.violations);
}

/**
 * The reads an engine answered although its own buffer had nothing there and a hard write of the same
 * stage owned the path: answers that can only have come from live state. On 9.28.0 these are the stale
 * values the #124 law removed (for a `set` as for a `delete`). On the build there are none.
 *
 * WHY NOT part of {@link oracleDomain}: that one excludes a program before it is compared, and its
 * counts are pinned for the fixed seeds. This one is asked only when two runs DIFFER and the witness
 * cannot explain it (`copy-on-write-fixture.ts · oracleVerdict`). A program that has such a read and
 * still matches 9.28.0 byte for byte stays compared, so the fixed seeds lose nothing and their pinned
 * counts do not move.
 */
export function staleReadsUnderHardWrite(receipt: Receipt): readonly HardWrittenReadInput[] {
  return Object.freeze(sameStageHardWrittenReadInputs(receipt).filter(({ read }) => read.result!.kind !== 'undefined'));
}
/**
 * Where, among the commits of a run, the stages that made such a read committed: the position of each
 * one's commit in the order the run's buffers committed (the order a commit witness sees them in).
 *
 * WHY: a stale value does harm in two ways. Read and dropped, it shows only in what the stage read.
 * Written on (read, edited, written back), it is in that stage's own commit. A comparison that finds
 * its FIRST differing commit at one of these positions has found the stage 9.28.0 handed a stale value.
 * A difference that starts at any other commit is not this law's.
 */
export function commitsOfStaleReads(receipt: Receipt): readonly number[] {
  const commits = receipt.events.filter(
    (event) => event.tier === 'buffer-call' && event.method === 'commit' && event.outcome === 'returned',
  );
  const positions = new Set<number>();
  for (const { get } of staleReadsUnderHardWrite(receipt)) {
    const at = commits.findIndex((commit) => commit.buffer === get.buffer && commit.epoch === get.epoch);
    if (at >= 0) positions.add(at);
  }
  return Object.freeze([...positions].sort((x, y) => x - y));
}
export class BuildHardWrittenReadViolation extends Error {
  constructor(readonly violations: readonly HardWrittenReadInput[]) {
    super('BUILD answered a read its own buffer could not, at or below a hard write of the same stage.');
  }
}
/** Unconditional BUILD law, for a `set` as for a `delete`: asked of every build run, whatever the baseline did. */
export function assertBuildHardWrittenReadsUndefined(receipt: Receipt): void {
  const violations = staleReadsUnderHardWrite(receipt);
  if (violations.length) throw new BuildHardWrittenReadViolation(violations);
}
