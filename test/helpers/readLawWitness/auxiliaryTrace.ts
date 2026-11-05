/** Exact original row exclusions for a proved auxiliary-read profile. */
import type { AuxiliaryEvidence, AuxiliaryProfile } from '../auxiliaryFacts.js';
import type { NativeFact } from '../readWitness.js';
import { rootArrayAuxiliaryProfile } from './auxiliaryProfile.js';
import { type JoinedRun, type ReadPair, refuse } from './types.js';

/** No admitted IDs enter this API. All exclusions are recomputed as original receipt ROW REFERENCES. */
export function auxiliaryTrace(
  a: JoinedRun,
  b: JoinedRun,
  pairs: readonly ReadPair[],
): {
  readonly baselineAuxiliaries: ReadonlySet<NativeFact>;
  readonly evidence: AuxiliaryEvidence;
} {
  for (const run of [a, b]) {
    const ids = new Set<number>();
    for (const event of run.native.events) {
      if (!Number.isSafeInteger(event.id) || event.id <= 0 || ids.has(event.id) || event.leg !== run.native.leg)
        return refuse('duplicate/unreadable/foreign original native occurrence');
      ids.add(event.id);
    }
  }
  const excluded = new Set<NativeFact>();
  const profiles: AuxiliaryProfile[] = [];
  const primary = new Set<number>();
  for (const pair of pairs) {
    if (primary.has(pair.baseline.nativeId)) return refuse('primary read claimed twice');
    primary.add(pair.baseline.nativeId);
    const candidate = rootArrayAuxiliaryProfile(a, b, pair);
    if (candidate.kind === 'unproven') continue; // Any unclaimed difference remains in the exact full trace and fails there.
    for (const read of candidate.reads) {
      if (excluded.has(read) || a.native.events.filter((actual) => actual === read).length !== 1)
        return refuse('auxiliary occurrence claimed twice or absent from original receipt');
      excluded.add(read);
    }
    profiles.push(candidate.evidence);
  }
  if (!profiles.length) return refuse('no live-bound closed auxiliary profile');
  return {
    baselineAuxiliaries: excluded,
    evidence: Object.freeze({ auxiliaryReadCount: excluded.size, profiles: Object.freeze(profiles) }),
  };
}
