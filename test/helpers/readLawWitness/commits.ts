import type { NativeFact } from '../readWitness.js';
import { type JoinedRun, refuse } from './types.js';

function nativeCommits(run: JoinedRun): readonly NativeFact[] {
  const seen = new Set<number>();
  return run.commits.map((commit) => {
    const event = run.native.events.find((row) => row.id === commit.nativeId);
    const origin = event?.encoder;
    if (
      commit.nativeId === undefined ||
      seen.has(commit.nativeId) ||
      !event ||
      event.tier !== 'buffer-call' ||
      event.method !== 'commit' ||
      event.outcome !== 'returned' ||
      event.leg !== run.native.leg ||
      !origin ||
      origin.start <= event.start ||
      origin.end >= event.end ||
      origin.method !== (origin.mode === 'full' ? 'toChangeOnlyPayload' : 'toDeltaPayload') ||
      origin.bytes !== commit.bytes
    )
      return refuse('identical outer commit lacks its actual inner encoder/receiver join');
    seen.add(commit.nativeId);
    return event;
  });
}

/** Shape1 requires native AND returned commits to match; an outer rewrite cannot supply native truth. */
export function identicalNativeCommits(a: JoinedRun, b: JoinedRun): void {
  const old = nativeCommits(a);
  const now = nativeCommits(b);
  if (
    old.length !== now.length ||
    old.some((row, i) => row.encoder!.bytes !== now[i].encoder!.bytes || row.encoder!.mode !== now[i].encoder!.mode)
  )
    return refuse('native encoders differ despite identical outer commits');
}
